const ISSUE_MAP = {
  'Tracking lost': ['occlusion','calibration','marker loss','software','unknown'],
  'Failed to launch': ['mechanical','arming','safety','unknown'],
  'Command delay': ['network latency','controller queue','unknown'],
  'RF link': ['TX fault','RX fault','interference','antenna','unknown'],
  'Battery': ['low voltage','BMS fault','poor contact','swelling','unknown'],
  'Motor or prop': ['no spin','desync','damage','unknown'],
  'Sensor or IMU': ['bias','calibration','saturation','unknown'],
  'Software or show control': ['cue timing','state desync','crash','unknown'],
  'Pilot input': ['incorrect mode','early abort','missed cue','unknown'],
  Other: []
};
const PRIMARY_ISSUES = Object.keys(ISSUE_MAP);
const ACTIONS = ['Reboot','Swap battery','Swap drone','Retry launch','Abort segment','Logged only'];
const STATUS = ['Completed','No-launch','Abort'];
const EXPORT_COLUMNS = [
  'showId','showDate','showTime','showLabel','crew','leadPilot','monkeyLead','showNotes',
  'entryId','unitId','planned','launched','status','primaryIssue','subIssue','otherDetail',
  'severity','rootCause','actions','operator','batteryId','delaySec','commandRx','notes'
];

function createEmptyShowDraft(){
  return {
    date: '',
    time: '',
    label: '',
    crew: [],
    leadPilot: '',
    monkeyLead: '',
    notes: ''
  };
}

const state = {
  config: null,
  unitLabel: 'Drone',
  shows: [],
  currentShowId: null,
  currentView: 'landing',
  editingEntryRef: null,
  serverHost: '10.241.211.120',
  serverPort: 3000,
  storageLabel: 'SQL.js storage v2',
  newShowDraft: createEmptyShowDraft(),
  isCreatingShow: false,
  webhookConfig: {
    enabled: false,
    url: '',
    method: 'POST',
    secret: '',
    headersText: ''
  },
  webhookStatus: {
    enabled: false,
    method: 'POST',
    hasSecret: false,
    headerCount: 0
  },
  staff: {
    crew: [],
    pilots: [],
    monkeyLeads: []
  }
};

const syncState = {
  channel: null,
  id: (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : `sync-${Date.now()}-${Math.random().toString(16).slice(2)}`
};

const SYNC_CHANNEL_NAME = 'monkey-tracker-sync';

const appTitle = el('appTitle');
const unitLabelEl = el('unitLabel');
const showDate = el('showDate');
const showTime = el('showTime');
const showLabel = el('showLabel');
const showNotes = el('showNotes');
const showCrewSelect = el('showCrew');
const leadPilotSelect = el('leadPilot');
const monkeyLeadSelect = el('monkeyLead');
const newShowBtn = el('newShow');
const unitId = el('unitId');
const planned = el('planned');
const launched = el('launched');
const stCompleted = el('stCompleted');
const stNoLaunch = el('stNoLaunch');
const stAbort = el('stAbort');
const primaryIssue = el('primaryIssue');
const subIssue = el('subIssue');
const otherDetail = el('otherDetail');
const otherDetailWrap = el('otherDetailWrap');
const severity = el('severity');
const rootCause = el('rootCause');
const actionsChips = el('actionsChips');
const operator = el('operator');
const batteryId = el('batteryId');
const delaySec = el('delaySec');
const commandRx = el('commandRx');
const entryNotes = el('entryNotes');
const groupsContainer = el('groups');
const issueBlocks = qsa('.issue-block');
const toastEl = el('toast');
const editModal = el('editModal');
const editForm = el('editForm');
const configBtn = el('configBtn');
const configPanel = el('configPanel');
const closeConfigBtn = el('closeConfig');
const cancelConfigBtn = el('cancelConfig');
const configForm = el('configForm');
const configMessage = el('configMessage');
const unitLabelSelect = el('unitLabelSelect');
const webhookEnabled = el('webhookEnabled');
const webhookUrl = el('webhookUrl');
const webhookMethod = el('webhookMethod');
const webhookSecret = el('webhookSecret');
const webhookHeaders = el('webhookHeaders');
const webhookPreview = el('webhookPreview');
const roleHomeBtn = el('roleHome');
const viewBadge = el('viewBadge');
const chooseLeadBtn = el('chooseLead');
const choosePilotBtn = el('choosePilot');
const entryShowSelect = el('entryShowSelect');
const pilotShowSummary = el('pilotShowSummary');
const leadExportCsvBtn = el('leadExportCsv');
const leadExportJsonBtn = el('leadExportJson');
const connectionStatusEl = el('connectionStatus');
const providerBadge = el('providerBadge');
const webhookBadge = el('webhookBadge');
const refreshShowsBtn = el('refreshShows');
const lanAddressEl = el('lanAddress');
const pilotListInput = el('pilotList');
const crewListInput = el('crewList');
const monkeyLeadListInput = el('monkeyLeadList');

init().catch(err=>{
  console.error(err);
  toast('Failed to initialise application', true);
});

async function init(){
  await loadConfig();
  updateConnectionIndicator('loading');
  await loadStaff();
  await loadShows();
  initUI();
  setupSyncChannel();
  populateUnitOptions();
  populateIssues();
  renderActionsChips(actionsChips, []);
  setCurrentShow(state.currentShowId || null);
  setView('landing');
}

function initUI(){
  [stCompleted, stNoLaunch, stAbort].forEach(btn=>{
    btn.addEventListener('click', ()=>{
      setStatus(btn.dataset.status);
      updateIssueVisibility();
    });
  });
  planned.addEventListener('change', onPlanLaunchChange);
  launched.addEventListener('change', onPlanLaunchChange);
  primaryIssue.addEventListener('change', ()=>{
    populateSubIssues(primaryIssue.value);
    updateIssueVisibility();
  });

  showDate.addEventListener('change', ()=> updateNewShowDraft('date', showDate.value));
  showTime.addEventListener('change', ()=> updateNewShowDraft('time', showTime.value));
  showLabel.addEventListener('input', ()=> updateNewShowDraft('label', showLabel.value));
  showNotes.addEventListener('input', ()=> updateNewShowDraft('notes', showNotes.value));
  if(showCrewSelect){
    showCrewSelect.addEventListener('change', ()=>{
      const selected = Array.from(showCrewSelect.selectedOptions).map(opt=> opt.value).filter(Boolean);
      updateNewShowDraft('crew', selected);
    });
  }
  if(leadPilotSelect){
    leadPilotSelect.addEventListener('change', ()=> updateNewShowDraft('leadPilot', leadPilotSelect.value));
  }
  if(monkeyLeadSelect){
    monkeyLeadSelect.addEventListener('change', ()=> updateNewShowDraft('monkeyLead', monkeyLeadSelect.value));
  }

  const addLineBtn = el('addLine');
  if(newShowBtn){ newShowBtn.addEventListener('click', onNewShow); }
  if(addLineBtn){ addLineBtn.addEventListener('click', onAddLine); }
  if(leadExportCsvBtn){ leadExportCsvBtn.addEventListener('click', onExportCsv); }
  if(leadExportJsonBtn){ leadExportJsonBtn.addEventListener('click', onExportJson); }

  if(entryShowSelect){
    entryShowSelect.addEventListener('change', ()=>{
      setCurrentShow(entryShowSelect.value || null);
    });
  }
  if(chooseLeadBtn){
    chooseLeadBtn.addEventListener('click', ()=>{
      setView('lead');
      setCurrentShow(state.currentShowId || (state.shows[0]?.id ?? null));
    });
  }
  if(choosePilotBtn){
    choosePilotBtn.addEventListener('click', ()=> setView('pilot'));
  }
  if(roleHomeBtn){
    roleHomeBtn.addEventListener('click', ()=> setView('landing'));
  }

  el('closeEdit').addEventListener('click', closeEditModal);
  el('saveEdit').addEventListener('click', saveEditEntry);

  configBtn.addEventListener('click', ()=> toggleConfig(true));
  closeConfigBtn.addEventListener('click', ()=> toggleConfig(false));
  cancelConfigBtn.addEventListener('click', ()=> toggleConfig(false));
  document.addEventListener('keydown', e=>{
    if(e.key === 'Escape'){
      closeAllShowMenus();
      toggleConfig(false);
      closeEditModal();
    }
  });

  configForm.addEventListener('submit', onConfigSubmit);
  if(webhookEnabled){
    webhookEnabled.addEventListener('change', ()=>{
      syncWebhookFields();
      updateWebhookPreview();
    });
  }
  if(webhookUrl){
    webhookUrl.addEventListener('input', ()=>{
      updateWebhookPreview();
    });
  }
  if(webhookMethod){
    webhookMethod.addEventListener('change', ()=>{
      updateWebhookPreview();
    });
  }
  if(webhookSecret){
    webhookSecret.addEventListener('input', ()=>{
      updateWebhookPreview();
    });
  }
  if(webhookHeaders){
    webhookHeaders.addEventListener('input', ()=>{
      updateWebhookPreview();
    });
  }
  if(refreshShowsBtn){
    refreshShowsBtn.dataset.label = refreshShowsBtn.textContent;
    refreshShowsBtn.addEventListener('click', onRefreshShows);
  }

  document.addEventListener('click', event=>{
    if(!event.target.closest('.show-menu-wrap')){
      closeAllShowMenus();
    }
  });

  renderShowHeaderDraft();
}

async function loadConfig(){
  const data = await apiRequest('/api/config');
  state.config = data;
  state.serverHost = data.host || state.serverHost;
  const portFromConfig = Number.parseInt(data.port, 10);
  state.serverPort = Number.isFinite(portFromConfig) ? portFromConfig : state.serverPort;
  state.unitLabel = data.unitLabel || 'Drone';
  state.storageLabel = 'SQL.js storage v2';
  state.webhookConfig = {
    enabled: Boolean(data.webhook?.enabled),
    url: data.webhook?.url || '',
    method: (data.webhook?.method || 'POST').toUpperCase(),
    secret: data.webhook?.secret || '',
    headersText: formatHeadersText(data.webhook?.headers)
  };
  state.webhookStatus = {
    enabled: Boolean(data.webhook?.enabled && data.webhook?.url),
    method: (data.webhook?.method || 'POST').toUpperCase(),
    hasSecret: Boolean(data.webhook?.secret),
    headerCount: Array.isArray(data.webhook?.headers) ? data.webhook.headers.length : 0
  };
  appTitle.textContent = state.unitLabel;
  unitLabelEl.textContent = state.unitLabel;
  unitLabelSelect.value = state.unitLabel;
  if(webhookEnabled){ webhookEnabled.checked = state.webhookConfig.enabled; }
  if(webhookUrl){ webhookUrl.value = state.webhookConfig.url; }
  if(webhookMethod){ webhookMethod.value = state.webhookConfig.method; }
  if(webhookSecret){ webhookSecret.value = state.webhookConfig.secret; }
  if(webhookHeaders){ webhookHeaders.value = state.webhookConfig.headersText; }
  setLanAddress();
  setProviderBadge(state.storageLabel);
  setWebhookBadge(state.webhookStatus);
  syncWebhookFields();
  updateWebhookPreview();
}

async function loadStaff(){
  try{
    const data = await apiRequest('/api/staff');
    const crew = normalizeNameList(Array.isArray(data.crew) ? data.crew : [], {sort: true});
    const pilots = normalizeNameList(Array.isArray(data.pilots) ? data.pilots : [], {sort: true});
    const monkeyLeads = normalizeNameList(Array.isArray(data.monkeyLeads) ? data.monkeyLeads : [], {sort: true});
    state.staff = {crew, pilots, monkeyLeads};
  }catch(err){
    console.error('Failed to load staff', err);
    if(!state.staff){
      state.staff = {crew: [], pilots: [], monkeyLeads: []};
    }else{
      state.staff.crew = [];
      state.staff.pilots = [];
      state.staff.monkeyLeads = [];
    }
    toast('Failed to load staff directory', true);
  }
  populateStaffSettings();
  renderOperatorOptions();
  renderShowHeaderDraft();
}

async function loadShows(){
  try{
    const previousId = state.currentShowId;
    const data = await apiRequest('/api/shows');
    state.storageLabel = 'SQL.js storage v2';
    state.webhookStatus = {
      enabled: Boolean(data.webhook?.enabled),
      method: (data.webhook?.method || state.webhookStatus.method || 'POST').toUpperCase(),
      hasSecret: Boolean(data.webhook?.hasSecret),
      headerCount: Number.isFinite(data.webhook?.headerCount) ? data.webhook.headerCount : state.webhookStatus.headerCount || 0
    };
    state.shows = Array.isArray(data.shows) ? data.shows : [];
    sortShows();
    const fallbackId = state.shows[0]?.id || null;
    state.currentShowId = previousId && state.shows.some(show=>show.id===previousId) ? previousId : fallbackId;
    updateConnectionIndicator();
    updateWebhookPreview();
  }catch(err){
    console.error('Failed to load shows', err);
    state.shows = [];
    state.currentShowId = null;
    toast('Failed to load shows', true);
    updateConnectionIndicator('error');
  }
}

async function onRefreshShows(){
  let originalLabel = '';
  if(refreshShowsBtn){
    originalLabel = refreshShowsBtn.dataset.label || refreshShowsBtn.textContent;
    refreshShowsBtn.disabled = true;
    refreshShowsBtn.textContent = 'Refreshing…';
  }
  updateConnectionIndicator('loading');
  try{
    await loadShows();
    setCurrentShow(state.currentShowId || null);
    toast('Data refreshed');
  }catch(err){
    console.error('Failed to refresh shows', err);
    toast('Failed to refresh data', true);
  }finally{
    if(refreshShowsBtn){
      refreshShowsBtn.disabled = false;
      refreshShowsBtn.textContent = originalLabel || 'Refresh data';
    }
  }
}

function setupSyncChannel(){
  if(typeof BroadcastChannel !== 'function'){
    return;
  }
  if(syncState.channel){
    return;
  }
  try{
    syncState.channel = new BroadcastChannel(SYNC_CHANNEL_NAME);
    syncState.channel.addEventListener('message', handleSyncMessage);
    window.addEventListener('beforeunload', closeSyncChannel, {once: true});
    window.addEventListener('pagehide', closeSyncChannel, {once: true});
  }catch(err){
    console.warn('Failed to initialize sync channel', err);
    syncState.channel = null;
  }
}

function closeSyncChannel(){
  if(!syncState.channel){
    return;
  }
  try{
    syncState.channel.close();
  }catch(err){
    console.warn('Failed to close sync channel', err);
  }finally{
    syncState.channel = null;
  }
}

function broadcastMessage(type, detail = {}){
  if(!syncState.channel){
    return;
  }
  try{
    syncState.channel.postMessage({
      source: syncState.id,
      type,
      detail: detail || {}
    });
  }catch(err){
    console.warn('Failed to broadcast sync message', err);
  }
}

function notifyShowsChanged(detail = {}){
  broadcastMessage('shows:changed', detail);
}

function notifyStaffChanged(){
  broadcastMessage('staff:changed');
}

function notifyConfigChanged(detail = {}){
  broadcastMessage('config:changed', detail);
}

async function handleSyncMessage(event){
  const data = event?.data;
  if(!data || typeof data !== 'object' || data.source === syncState.id){
    return;
  }
  try{
    switch(data.type){
      case 'shows:changed':
        await refreshShowsFromSync(data.detail);
        break;
      case 'staff:changed':
        await refreshStaffFromSync();
        break;
      case 'config:changed':
        await refreshConfigFromSync(data.detail);
        break;
      default:
        break;
    }
  }catch(err){
    console.error('Sync message handling failed', err);
  }
}

async function refreshShowsFromSync(detail = {}){
  const previousId = state.currentShowId;
  try{
    await loadShows();
  }catch(err){
    console.error('Failed to sync shows', err);
    return;
  }
  let targetId = null;
  const preferredId = detail && typeof detail === 'object' ? detail.showId : null;
  const hasPrevious = previousId && state.shows.some(show => show.id === previousId);
  const hasPreferred = preferredId && state.shows.some(show => show.id === preferredId);
  if(hasPrevious){
    targetId = previousId;
  }else if(hasPreferred){
    targetId = preferredId;
  }else{
    targetId = state.shows[0]?.id || null;
  }
  setCurrentShow(targetId, {skipPilotSync: false});
}

async function refreshStaffFromSync(){
  try{
    await loadStaff();
  }catch(err){
    console.error('Failed to sync staff roster', err);
  }
}

async function refreshConfigFromSync(){
  try{
    await loadConfig();
    populateUnitOptions();
    updateConnectionIndicator('loading');
    await loadShows();
    setCurrentShow(state.currentShowId || null);
  }catch(err){
    console.error('Failed to sync configuration', err);
  }
}

function getCurrentShow(){
  if(!state.currentShowId){
    return null;
  }
  return state.shows.find(s=>s.id===state.currentShowId) || null;
}

function setCurrentShow(showId, options = {}){
  const {skipPilotSync = false, skipRender = false} = options;
  state.currentShowId = showId || null;
  renderOperatorOptions();
  updateIssueVisibility();
  if(!skipRender){
    renderGroups();
  }
  updateWebhookPreview();
  if(!skipPilotSync){
    syncPilotShowSelect();
  }else{
    updatePilotSummary();
  }
}

function syncPilotShowSelect(){
  if(!entryShowSelect){
    updatePilotSummary();
    return;
  }
  const shows = state.shows.slice();
  if(!shows.length){
    entryShowSelect.innerHTML = '<option value="">No shows available</option>';
    entryShowSelect.disabled = true;
    entryShowSelect.value = '';
    updatePilotSummary();
    return;
  }
  entryShowSelect.disabled = false;
  entryShowSelect.innerHTML = shows.map(show=>{
    const date = formatDateUS(show.date) || 'MM-DD-YYYY';
    const time = formatTime12Hour(show.time) || 'HH:mm';
    const label = show.label ? ` • ${show.label}` : '';
    return `<option value="${show.id}">${escapeHtml(`${date} • ${time}${label}`)}</option>`;
  }).join('');
  const hasCurrent = state.currentShowId && shows.some(show=>show.id===state.currentShowId);
  const selectedId = hasCurrent ? state.currentShowId : shows[0].id;
  entryShowSelect.value = selectedId;
  if(!hasCurrent){
    setCurrentShow(selectedId, {skipPilotSync: true});
  }else{
    updatePilotSummary();
  }
}

function updatePilotSummary(){
  if(!pilotShowSummary){
    return;
  }
  const show = getCurrentShow();
  if(!show){
    pilotShowSummary.textContent = 'Lead must create a show before logging entries.';
    return;
  }
  const date = formatDateUS(show.date) || 'Date TBD';
  const time = formatTime12Hour(show.time) || 'Time TBD';
  const parts = [`Logging to ${date} • ${time}`];
  if(show.label){ parts.push(show.label); }
  if(show.leadPilot){ parts.push(`Lead: ${show.leadPilot}`); }
  if(show.monkeyLead){ parts.push(`Monkey lead: ${show.monkeyLead}`); }
  pilotShowSummary.textContent = parts.join(' • ');
}

function upsertShow(show){
  const idx = state.shows.findIndex(s=>s.id===show.id);
  if(idx >= 0){
    state.shows[idx] = show;
  }else{
    state.shows.unshift(show);
  }
  sortShows();
}

function sortShows(){
  state.shows.sort((a,b)=>{
    const au = a.updatedAt || a.createdAt || 0;
    const bu = b.updatedAt || b.createdAt || 0;
    return bu - au;
  });
}

function populateUnitOptions(){
  const units = getDefaultUnits();
  const currentValue = unitId.value;
  unitId.innerHTML = '<option value="">Select</option>' + units.map(u=>`<option ${currentValue===u?'selected':''}>${u}</option>`).join('');
  unitLabelEl.textContent = state.unitLabel;
  appTitle.textContent = state.unitLabel;
}

function populateIssues(){
  primaryIssue.innerHTML = '<option value="">Select</option>' + PRIMARY_ISSUES.map(issue=>`<option value="${issue}">${issue}</option>`).join('');
  populateSubIssues(primaryIssue.value);
}

function populateSubIssues(primary){
  const options = ISSUE_MAP[primary] || [];
  subIssue.innerHTML = '<option value="">N/A</option>' + options.map(opt=>`<option value="${opt}">${opt}</option>`).join('');
}

function renderActionsChips(container, selected){
  container.innerHTML = '';
  ACTIONS.forEach(action=>{
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'action-chip';
    chip.textContent = action;
    const isSelected = selected.includes(action);
    chip.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    chip.addEventListener('click', ()=>{
      const pressed = chip.getAttribute('aria-pressed') === 'true';
      chip.setAttribute('aria-pressed', pressed ? 'false' : 'true');
    });
    container.appendChild(chip);
  });
}

function getSelectedActions(container){
  return qsa('.action-chip', container).filter(chip=>chip.getAttribute('aria-pressed') === 'true').map(chip=>chip.textContent);
}

function updateIssueVisibility(){
  const st = getStatus();
  const showIssues = st && st !== 'Completed';
  issueBlocks.forEach(block=> block.classList.toggle('hidden', !showIssues));
  const isOther = primaryIssue.value === 'Other';
  otherDetailWrap.classList.toggle('hidden', !showIssues || !isOther);
}

function getStatus(){
  const selected = [stCompleted, stNoLaunch, stAbort].find(btn=>btn.getAttribute('aria-pressed') === 'true');
  return selected ? selected.dataset.status : '';
}

function setStatus(status){
  [stCompleted, stNoLaunch, stAbort].forEach(btn=>{
    btn.setAttribute('aria-pressed', btn.dataset.status === status ? 'true' : 'false');
  });
}

function onPlanLaunchChange(){
  const st = getStatus();
  if(planned.value === 'No' && st && st !== 'No-launch'){
    setStatus('No-launch');
  }
  if(launched.value === 'No' && st && st !== 'No-launch'){
    setStatus('No-launch');
  }
  if(launched.value === 'Yes' && st === 'No-launch'){
    setStatus('Completed');
  }
  updateIssueVisibility();
}

function collectShowHeaderValues(){
  const crewSelected = showCrewSelect
    ? Array.from(showCrewSelect.selectedOptions).map(opt => opt.value).filter(Boolean)
    : [];
  return {
    date: showDate?.value || '',
    time: showTime?.value || '',
    label: showLabel?.value.trim() || '',
    crew: normalizeNameList(crewSelected),
    leadPilot: leadPilotSelect?.value?.trim() || '',
    monkeyLead: monkeyLeadSelect?.value?.trim() || '',
    notes: showNotes?.value.trim() || ''
  };
}

function getNewShowDraft(){
  if(!state.newShowDraft){
    state.newShowDraft = createEmptyShowDraft();
  }
  return state.newShowDraft;
}

function renderShowHeaderDraft(){
  const draft = getNewShowDraft();
  if(showDate){ showDate.value = draft.date || ''; }
  if(showTime){ showTime.value = draft.time || ''; }
  if(showLabel){ showLabel.value = draft.label || ''; }
  if(showNotes){ showNotes.value = draft.notes || ''; }
  renderCrewOptions(draft.crew || []);
  renderPilotAssignments(draft);
}

function resetShowHeaderDraft(){
  state.newShowDraft = createEmptyShowDraft();
  renderShowHeaderDraft();
}

function updateNewShowDraft(field, value){
  const draft = getNewShowDraft();
  if(field === 'crew'){
    draft.crew = normalizeNameList(Array.isArray(value) ? value : [value]);
    return;
  }
  draft[field] = value;
}

function setShowHeaderDisabled(disabled){
  const controls = [showDate, showTime, showLabel, showNotes, showCrewSelect, leadPilotSelect, monkeyLeadSelect];
  controls.forEach(control =>{
    if(!control){
      return;
    }
    if(disabled){
      control.dataset.prevDisabled = control.disabled ? 'true' : 'false';
      control.disabled = true;
    }else{
      if(control.dataset.prevDisabled === 'true'){
        control.disabled = true;
      }else{
        control.disabled = false;
      }
      delete control.dataset.prevDisabled;
    }
  });
  if(!disabled){
    renderShowHeaderDraft();
  }
}

function setNewShowButtonBusy(busy){
  if(!newShowBtn){
    return;
  }
  if(!newShowBtn.dataset.originalLabel){
    newShowBtn.dataset.originalLabel = newShowBtn.textContent || 'Add show';
  }
  newShowBtn.disabled = busy;
  newShowBtn.textContent = busy ? 'Adding…' : newShowBtn.dataset.originalLabel;
}

async function onNewShow(){
  closeAllShowMenus();
  if(state.isCreatingShow){
    return;
  }
  const previousId = state.currentShowId;
  const headerValues = collectShowHeaderValues();
  state.isCreatingShow = true;
  setShowHeaderDisabled(true);
  setNewShowButtonBusy(true);
  try{
    const payload = await apiRequest('/api/shows', {method:'POST', body: JSON.stringify(headerValues)});
    upsertShow(payload);
    setCurrentShow(payload.id);
    notifyShowsChanged({showId: payload.id});
    clearEntryForm();
    toast('New show created');
    resetShowHeaderDraft();
  }catch(err){
    console.error(err);
    toast('Failed to create show', true);
    const fallbackId = previousId && state.shows.some(show => show.id === previousId)
      ? previousId
      : (state.shows[0]?.id || null);
    setCurrentShow(fallbackId);
  }finally{
    state.isCreatingShow = false;
    setShowHeaderDisabled(false);
    setNewShowButtonBusy(false);
  }
}

async function duplicateShow(showId){
  closeAllShowMenus();
  if(state.isCreatingShow){
    return;
  }
  const source = state.shows.find(show => show.id === showId);
  if(!source){
    toast('Show not found', true);
    return;
  }
  const previousId = state.currentShowId;
  state.isCreatingShow = true;
  setShowHeaderDisabled(true);
  setNewShowButtonBusy(true);
  try{
    const dupPayload = {
      date: source.date,
      time: source.time,
      label: source.label,
      crew: [...(source.crew||[])],
      leadPilot: source.leadPilot || '',
      monkeyLead: source.monkeyLead || '',
      notes: source.notes || ''
    };
    const payload = await apiRequest('/api/shows', {method:'POST', body: JSON.stringify(dupPayload)});
    upsertShow(payload);
    setCurrentShow(payload.id);
    notifyShowsChanged({showId: payload.id});
    clearEntryForm();
    toast('Show duplicated');
  }catch(err){
    console.error(err);
    toast(err.message || 'Failed to duplicate show', true);
    const fallbackId = previousId && state.shows.some(show => show.id === previousId)
      ? previousId
      : (state.shows[0]?.id || null);
    setCurrentShow(fallbackId);
  }finally{
    state.isCreatingShow = false;
    setShowHeaderDisabled(false);
    setNewShowButtonBusy(false);
  }
}

async function onAddLine(){
  if(state.currentView !== 'pilot'){
    toast('Switch to the Pilot workspace to log entries', true);
    return;
  }
  const show = getCurrentShow();
  if(!show){
    toast('Select or create a show first', true);
    return;
  }
  clearErrors();
  let ok = true;
  if(!show.date){ showError('errDate'); ok=false; }
  if(!show.time){ showError('errTime'); ok=false; }
  if(!unitId.value){ showError('errUnit'); ok=false; }
  if(!planned.value){ showError('errPlanned'); ok=false; }
  if(!launched.value){ showError('errLaunched'); ok=false; }
  const st = getStatus();
  if(!st){ showError('errStatus'); ok=false; }
  if(planned.value === 'No' && st !== 'No-launch'){ showError('errStatus'); toast('If Planned is No, Status must be No-launch', true); ok=false; }
  if(launched.value === 'No' && st !== 'No-launch'){ showError('errStatus'); toast('If Launched is No, Status must be No-launch', true); ok=false; }
  if(launched.value === 'Yes' && st === 'No-launch'){ showError('errStatus'); toast('If Launched is Yes, Status cannot be No-launch', true); ok=false; }
  if(st !== 'Completed'){
    if(!primaryIssue.value){ showError('errPrimary'); ok=false; }
    if(!severity.value){ showError('errSeverity'); ok=false; }
    if(primaryIssue.value === 'Other' && !otherDetail.value.trim()){ showError('errOther'); ok=false; }
  }
  if(!operator.value){ showError('errOperator'); ok=false; }
  if(delaySec.value){
    const v = Number(delaySec.value);
    if(!Number.isFinite(v) || v < 0){ showError('errDelay'); ok=false; }
  }
  if(!ok){ return; }

  const entry = {
    unitId: unitId.value,
    planned: planned.value,
    launched: launched.value,
    status: st,
    primaryIssue: st === 'Completed' ? '' : primaryIssue.value,
    subIssue: st === 'Completed' ? '' : (subIssue.value || ''),
    otherDetail: st === 'Completed' ? '' : (primaryIssue.value === 'Other' ? otherDetail.value.trim() : ''),
    severity: st === 'Completed' ? '' : (severity.value || ''),
    rootCause: st === 'Completed' ? '' : (rootCause.value || ''),
    actions: st === 'Completed' ? [] : getSelectedActions(actionsChips),
    operator: operator.value || '',
    batteryId: batteryId.value.trim(),
    delaySec: delaySec.value ? Number(delaySec.value) : null,
    commandRx: commandRx.value || '',
    notes: entryNotes.value.trim()
  };

  try{
    await apiRequest(`/api/shows/${show.id}/entries`, {method:'POST', body: JSON.stringify(entry)});
    const updatedShow = await apiRequest(`/api/shows/${show.id}`, {method:'GET'});
    upsertShow(updatedShow);
    setCurrentShow(updatedShow.id);
    notifyShowsChanged({showId: updatedShow.id});
    clearEntryForm();
    toast('Line added');
  }catch(err){
    console.error(err);
    toast(err.message || 'Failed to add entry', true);
  }
}

function clearEntryForm(){
  unitId.value = '';
  planned.value = '';
  launched.value = '';
  setStatus('');
  primaryIssue.value = '';
  subIssue.innerHTML = '<option value="">N/A</option>';
  otherDetail.value = '';
  severity.value = '';
  rootCause.value = '';
  renderActionsChips(actionsChips, []);
  operator.value = '';
  batteryId.value = '';
  delaySec.value = '';
  commandRx.value = '';
  entryNotes.value = '';
  updateIssueVisibility();
}

function renderGroups(){
  sortShows();
  closeAllShowMenus();
  groupsContainer.innerHTML = '';
  state.shows.forEach(show=>{
    const isOpen = show.id === state.currentShowId;
    const group = document.createElement('details');
    group.className = 'group';
    group.open = isOpen;
    const summary = document.createElement('summary');
    const summaryContent = document.createElement('div');
    summaryContent.className = 'group-summary';
    const titleEl = document.createElement('div');
    titleEl.className = 'group-title';
    titleEl.textContent = groupTitle(show);
    const meta = document.createElement('div');
    meta.className = 'group-summary-meta';
    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = `${show.entries?.length || 0} entries`;
    meta.appendChild(badge);
    meta.appendChild(createShowMenu(show));
    summaryContent.appendChild(titleEl);
    summaryContent.appendChild(meta);
    summary.appendChild(summaryContent);
    summary.addEventListener('click', ()=>{
      setTimeout(()=>{
        if(group.open){
          setCurrentShow(show.id, {skipRender: true});
        }
      }, 0);
    });
    summary.addEventListener('click', closeAllShowMenus);
    const metricsDiv = document.createElement('div');
    const metrics = computeMetrics(show);
    metricsDiv.className = 'metrics';
    metricsDiv.innerHTML = `
      <div class="metric">Launch success: <b>${metrics.successRate}%</b></div>
      <div class="metric">Completed: <b>${metrics.countCompleted}</b></div>
      <div class="metric">No-launch: <b>${metrics.countNoLaunch}</b></div>
      <div class="metric">Abort: <b>${metrics.countAbort}</b></div>
      <div class="metric">Avg delay: <b>${metrics.avgDelay}</b> s</div>
      <div class="metric">Top issues: <b>${metrics.topIssues.join(', ') || 'n/a'}</b></div>
    `;
    const rows = document.createElement('div');
    rows.className = 'rows';
    const header = document.createElement('div');
    header.className = 'rowcard';
    header.style.background = '#1a1d26';
    header.style.fontWeight = '700';
    header.style.color = 'var(--text-dim)';
    header.style.borderBottom = '2px solid var(--border)';
    const idHeader = state.unitLabel === 'Monkey' ? 'M#' : 'D#';
    header.innerHTML = `
      <div><b>${idHeader}</b></div>
      <div><b>Planned</b></div>
      <div><b>Launched</b></div>
      <div><b>Status</b></div>
      <div><b>Issue</b></div>
      <div><b>Operator</b></div>
      <div><b>Notes</b></div>
      <div></div>
    `;
    rows.appendChild(header);
    (show.entries || []).slice().sort((a,b)=> (b.ts||0) - (a.ts||0)).forEach(entry=>{
      rows.appendChild(renderRow(show, entry));
    });
    group.appendChild(summary);
    group.appendChild(metricsDiv);
    group.appendChild(rows);
    groupsContainer.appendChild(group);
  });
  updateWebhookPreview();
}

function groupTitle(show){
  const d = formatDateUS(show.date) || 'MM-DD-YYYY';
  const t = formatTime12Hour(show.time) || 'HH:mm';
  const label = show.label ? ` • ${show.label}` : '';
  return `${d} • ${t}${label}`;
}

function createShowMenu(show){
  const wrap = document.createElement('div');
  wrap.className = 'show-menu-wrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn icon-btn show-menu-btn';
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');
  btn.title = 'Show options';
  btn.setAttribute('aria-label', 'Show options');
  btn.innerHTML = '⋮';
  btn.addEventListener('click', event=>{
    event.preventDefault();
    event.stopPropagation();
    const isOpen = wrap.classList.contains('open');
    closeAllShowMenus();
    if(!isOpen){
      wrap.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }
  });
  const menu = document.createElement('div');
  menu.className = 'show-menu';
  const duplicateBtn = document.createElement('button');
  duplicateBtn.type = 'button';
  duplicateBtn.className = 'menu-item';
  duplicateBtn.textContent = 'Duplicate show';
  duplicateBtn.addEventListener('click', async event=>{
    event.preventDefault();
    event.stopPropagation();
    closeAllShowMenus();
    await duplicateShow(show.id);
  });
  menu.appendChild(duplicateBtn);
  wrap.appendChild(btn);
  wrap.appendChild(menu);
  return wrap;
}

function closeAllShowMenus(){
  qsa('.show-menu-wrap.open').forEach(wrap=>{
    wrap.classList.remove('open');
    const toggle = qs('.show-menu-btn', wrap);
    if(toggle){
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}

function renderRow(show, entry){
  const row = document.createElement('div');
  row.className = 'rowcard';
  const colorDot = entry.status === 'Completed' ? 'dot-success' : entry.status === 'Abort' ? 'dot-warn' : 'dot-danger';
  const issueTxt = entry.status === 'Completed' ? '' : [entry.primaryIssue, entry.subIssue || entry.otherDetail].filter(Boolean).join(' / ');
  row.innerHTML = `
    <div><b>${escapeHtml(entry.unitId || '')}</b></div>
    <div>${escapeHtml(entry.planned || '')}</div>
    <div>${escapeHtml(entry.launched || '')}</div>
    <div><span class="status-dot ${colorDot}"></span>${escapeHtml(entry.status || '')}</div>
    <div>${escapeHtml(issueTxt)}</div>
    <div>${escapeHtml(entry.operator || '')}</div>
    <div>${escapeHtml(entry.notes || '')}</div>
    <div class="menu" data-menu>
      <button class="menu-btn" title="Row menu" aria-haspopup="true" aria-expanded="false">⋯</button>
      <div class="menu-list" role="menu">
        <button class="menu-item" role="menuitem" data-edit>Edit</button>
        <button class="menu-item" role="menuitem" data-delete>Delete</button>
      </div>
    </div>
  `;
  const menu = qs('[data-menu]', row);
  const btn = qs('.menu-btn', menu);
  btn.addEventListener('click', e=>{
    e.stopPropagation();
    const open = menu.hasAttribute('open');
    closeAllMenus();
    if(!open){
      menu.setAttribute('open', '');
    }
    btn.setAttribute('aria-expanded', String(!open));
    document.addEventListener('click', closeAllMenus, {once:true});
  });
  qs('[data-edit]', row).addEventListener('click', ()=>{
    menu.removeAttribute('open');
    openEditModal(show.id, entry.id);
  });
  qs('[data-delete]', row).addEventListener('click', async ()=>{
    menu.removeAttribute('open');
    if(confirm('Delete this entry?')){
      await deleteEntry(show.id, entry.id);
    }
  });
  return row;
}

async function deleteEntry(showId, entryId){
  try{
    await apiRequest(`/api/shows/${showId}/entries/${entryId}`, {method:'DELETE'});
    const updatedShow = await apiRequest(`/api/shows/${showId}`, {method:'GET'});
    upsertShow(updatedShow);
    setCurrentShow(updatedShow.id);
    notifyShowsChanged({showId: updatedShow.id});
    toast('Entry deleted');
  }catch(err){
    console.error(err);
    toast('Failed to delete entry', true);
  }
}

function closeAllMenus(){
  qsa('[data-menu]').forEach(m=>m.removeAttribute('open'));
}

function computeMetrics(show){
  const plannedYes = (show.entries||[]).filter(e=>e.planned==='Yes').length;
  const completed = (show.entries||[]).filter(e=>e.status==='Completed').length;
  const noLaunch = (show.entries||[]).filter(e=>e.status==='No-launch').length;
  const abort = (show.entries||[]).filter(e=>e.status==='Abort').length;
  const delays = (show.entries||[]).map(e=>e.delaySec).filter(v=>typeof v === 'number');
  const avgDelay = delays.length ? (delays.reduce((a,b)=>a+b,0)/delays.length).toFixed(2) : '0.00';
  const issues = {};
  (show.entries||[]).forEach(e=>{
    if(e.status !== 'Completed' && e.primaryIssue){
      issues[e.primaryIssue] = (issues[e.primaryIssue] || 0) + 1;
    }
  });
  const topIssues = Object.entries(issues).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([key])=>key);
  const successRate = plannedYes ? Math.round((completed/plannedYes)*100) : 0;
  return {
    successRate,
    countCompleted: completed,
    countNoLaunch: noLaunch,
    countAbort: abort,
    avgDelay,
    topIssues
  };
}

function openEditModal(showId, entryId){
  const show = state.shows.find(s=>s.id===showId);
  const entry = show?.entries.find(e=>e.id===entryId);
  if(!entry){
    return;
  }
  state.editingEntryRef = {showId, entryId};
  editForm.innerHTML = '';
  const fields = buildEntryFieldsClone(entry, show);
  fields.forEach(f=> editForm.appendChild(f));
  editModal.classList.add('open');
}

function closeEditModal(){
  editModal.classList.remove('open');
  state.editingEntryRef = null;
}

async function saveEditEntry(){
  if(!state.editingEntryRef){
    return;
  }
  const show = state.shows.find(s=>s.id===state.editingEntryRef.showId);
  if(!show){
    toast('Show not found', true);
    return;
  }
  const form = editForm;
  const get = id => qs(`#${id}`, form);
  const status = pillGet(form);
  if(!get('edit_unitId').value || !get('edit_planned').value || !get('edit_launched').value || !status){
    toast('Missing required fields', true);
    return;
  }
  if(get('edit_planned').value === 'No' && status !== 'No-launch'){ toast('If Planned is No, Status must be No-launch', true); return; }
  if(get('edit_launched').value === 'No' && status !== 'No-launch'){ toast('If Launched is No, Status must be No-launch', true); return; }
  if(get('edit_launched').value === 'Yes' && status === 'No-launch'){ toast('If Launched is Yes, Status cannot be No-launch', true); return; }
  const prim = get('edit_primaryIssue').value;
  const sev = get('edit_severity').value;
  const other = get('edit_otherDetail').value.trim();
  if(status !== 'Completed'){
    if(!prim || !sev){ toast('Issue and Severity required when not Completed', true); return; }
    if(prim === 'Other' && !other){ toast('Other detail required', true); return; }
  }
  const operatorValue = get('edit_operator').value.trim();
  if(!operatorValue){ toast('Operator required', true); return; }
  const entryUpdate = {
    unitId: get('edit_unitId').value,
    planned: get('edit_planned').value,
    launched: get('edit_launched').value,
    status,
    primaryIssue: status === 'Completed' ? '' : prim,
    subIssue: status === 'Completed' ? '' : (get('edit_subIssue').value || ''),
    otherDetail: status === 'Completed' ? '' : (prim === 'Other' ? other : ''),
    severity: status === 'Completed' ? '' : sev,
    rootCause: status === 'Completed' ? '' : get('edit_rootCause').value,
    actions: status === 'Completed' ? [] : getSelectedActions(qs('#edit_actionsChips', form)),
    operator: operatorValue,
    batteryId: get('edit_batteryId').value.trim(),
    delaySec: get('edit_delaySec').value ? Number(get('edit_delaySec').value) : null,
    commandRx: get('edit_commandRx').value || '',
    notes: get('edit_entryNotes').value.trim()
  };
  try{
    await apiRequest(`/api/shows/${show.id}/entries/${state.editingEntryRef.entryId}`, {method:'PUT', body: JSON.stringify(entryUpdate)});
    const updatedShow = await apiRequest(`/api/shows/${show.id}`, {method:'GET'});
    upsertShow(updatedShow);
    setCurrentShow(updatedShow.id);
    notifyShowsChanged({showId: updatedShow.id});
    closeEditModal();
    toast('Entry updated');
  }catch(err){
    console.error(err);
    toast(err.message || 'Failed to update entry', true);
  }
}

function buildEntryFieldsClone(entry, show){
  const fields = [];
  const wrap = (node, cls='col-3')=>{
    const div = document.createElement('div');
    div.className = cls;
    div.appendChild(node);
    return div;
  };
  const createLabelWrap = (id, labelText, node)=>{
    const label = document.createElement('label');
    label.setAttribute('for', id);
    label.textContent = labelText;
    const wrapper = document.createElement('div');
    wrapper.appendChild(label);
    node.id = id;
    node.style.width = '100%';
    node.style.minHeight = 'var(--tap-min)';
    wrapper.appendChild(node);
    return wrapper;
  };
  const unit = document.createElement('select');
  const units = getDefaultUnits();
  if(entry.unitId && !units.includes(entry.unitId)){
    units.push(entry.unitId);
  }
  unit.innerHTML = '<option value="">Select</option>' + units.map(u=>`<option ${entry.unitId===u?'selected':''}>${u}</option>`).join('');
  fields.push(wrap(createLabelWrap('edit_unitId', `${state.unitLabel} ID`, unit)));

  const plannedSelect = document.createElement('select');
  plannedSelect.innerHTML = optionsForYesNo(entry.planned);
  fields.push(wrap(createLabelWrap('edit_planned', 'Planned to fly', plannedSelect)));

  const launchedSelect = document.createElement('select');
  launchedSelect.innerHTML = optionsForYesNo(entry.launched);
  fields.push(wrap(createLabelWrap('edit_launched', 'Launched', launchedSelect)));

  const pills = pillBuild(entry.status);
  fields.push(wrap(pills, 'col-4'));

  const prim = document.createElement('select');
  prim.innerHTML = '<option value="">Select</option>' + PRIMARY_ISSUES.map(issue=>`<option ${entry.primaryIssue===issue?'selected':''}>${issue}</option>`).join('');
  fields.push(wrap(createLabelWrap('edit_primaryIssue', 'Primary issue', prim), 'col-4'));

  const sub = document.createElement('select');
  const options = ISSUE_MAP[entry.primaryIssue] || [];
  sub.innerHTML = '<option value="">N/A</option>' + options.map(opt=>`<option ${entry.subIssue===opt?'selected':''}>${opt}</option>`).join('');
  fields.push(wrap(createLabelWrap('edit_subIssue', 'Sub-issue', sub), 'col-4'));

  const other = document.createElement('input');
  other.type = 'text';
  other.value = entry.otherDetail || '';
  fields.push(wrap(createLabelWrap('edit_otherDetail', 'Other detail', other), 'col-4'));

  const sev = document.createElement('select');
  sev.innerHTML = '<option value="">Select</option>' + ['Critical show stop','Major visible','Minor contained'].map(opt=>`<option ${entry.severity===opt?'selected':''}>${opt}</option>`).join('');
  fields.push(wrap(createLabelWrap('edit_severity', 'Severity', sev), 'col-4'));

  const root = document.createElement('select');
  root.innerHTML = '<option value="">Select</option>' + ['Hardware','Software','Ops','Environment','Unknown'].map(opt=>`<option ${entry.rootCause===opt?'selected':''}>${opt}</option>`).join('');
  fields.push(wrap(createLabelWrap('edit_rootCause', 'Root cause draft', root), 'col-4'));

  const actionsWrap = document.createElement('div');
  actionsWrap.className = 'actions-chips';
  actionsWrap.id = 'edit_actionsChips';
  renderActionsChips(actionsWrap, entry.actions || []);
  const actionsContainer = document.createElement('div');
  actionsContainer.className = 'col-12';
  const actionsLabel = document.createElement('label');
  actionsLabel.textContent = 'Actions taken';
  actionsContainer.appendChild(actionsLabel);
  actionsContainer.appendChild(actionsWrap);
  fields.push(actionsContainer);

  const operatorSelect = document.createElement('select');
  const pilots = getPilotNames([entry.operator, show?.leadPilot]);
  if(pilots.length){
    operatorSelect.innerHTML = '<option value="">Select</option>' + pilots.map(name=>`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    operatorSelect.disabled = false;
    const match = pilots.find(name => name.toLowerCase() === (entry.operator || '').toLowerCase());
    operatorSelect.value = match || '';
  }else{
    operatorSelect.innerHTML = '<option value="">Add pilots in settings</option>';
    operatorSelect.disabled = true;
  }
  fields.push(wrap(createLabelWrap('edit_operator', 'Operator', operatorSelect)));

  const battery = document.createElement('input');
  battery.type = 'text';
  battery.value = entry.batteryId || '';
  fields.push(wrap(createLabelWrap('edit_batteryId', 'Battery ID', battery)));

  const delay = document.createElement('input');
  delay.type = 'number';
  delay.step = '0.1';
  delay.min = '0';
  delay.value = entry.delaySec ?? '';
  fields.push(wrap(createLabelWrap('edit_delaySec', 'Launch delay seconds', delay)));

  const cmdRx = document.createElement('select');
  cmdRx.innerHTML = '<option value="">Select</option>' + ['Yes','No'].map(opt=>`<option ${entry.commandRx===opt?'selected':''}>${opt}</option>`).join('');
  fields.push(wrap(createLabelWrap('edit_commandRx', 'Command received', cmdRx)));

  const notes = document.createElement('input');
  notes.type = 'text';
  notes.value = entry.notes || '';
  fields.push(wrap(createLabelWrap('edit_entryNotes', 'Notes', notes), 'col-9'));

  return fields;
}

function optionsForYesNo(selected){
  return ['','Yes','No'].map(opt=> opt ? `<option ${selected===opt?'selected':''}>${opt}</option>` : '<option value="">Select</option>').join('');
}

function pillBuild(current){
  const wrapper = document.createElement('div');
  wrapper.className = 'pills';
  STATUS.forEach(status=>{
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pill';
    btn.dataset.status = status;
    btn.textContent = status;
    btn.setAttribute('aria-pressed', status === current ? 'true' : 'false');
    btn.addEventListener('click', ()=>{
      qsa('.pill', wrapper).forEach(b=> b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
    });
    if(status === 'Completed'){ btn.classList.add('completed'); }
    if(status === 'No-launch'){ btn.classList.add('nolaunch'); }
    if(status === 'Abort'){ btn.classList.add('abort'); }
    wrapper.appendChild(btn);
  });
  return wrapper;
}

function pillGet(formRoot){
  const btn = qsa('.pill', formRoot).find(b=>b.getAttribute('aria-pressed')==='true');
  return btn ? btn.dataset.status : '';
}

function renderOperatorOptions(){
  if(!operator){
    return;
  }
  const current = operator.value;
  const names = getPilotNames([current]);
  if(!names.length){
    operator.innerHTML = '<option value="">Add pilots in settings</option>';
    operator.value = '';
    operator.disabled = true;
    return;
  }
  operator.disabled = false;
  const options = [''].concat(names).map(name=>{
    if(!name){
      return '<option value="">Select</option>';
    }
    return `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
  }).join('');
  operator.innerHTML = options;
  const currentLower = current ? current.toLowerCase() : '';
  const match = names.find(name => name.toLowerCase() === currentLower);
  operator.value = match || '';
}

function setView(view){
  state.currentView = view;
  document.body.classList.remove('view-landing','view-lead','view-pilot');
  document.body.classList.add(`view-${view}`);
  if(viewBadge){
    if(view === 'landing'){
      viewBadge.hidden = true;
      viewBadge.classList.remove('view-badge-pilot');
    }else{
      viewBadge.hidden = false;
      viewBadge.textContent = view === 'pilot' ? 'Pilot workspace' : 'Lead workspace';
      viewBadge.classList.toggle('view-badge-pilot', view === 'pilot');
    }
  }
  if(roleHomeBtn){
    roleHomeBtn.hidden = view === 'landing';
  }
  if(view === 'landing'){
    toggleConfig(false);
  }
  if(view === 'pilot'){
    syncPilotShowSelect();
  }else{
    updatePilotSummary();
  }
}

function toggleConfig(open){
  configBtn.setAttribute('aria-expanded', String(open));
  configBtn.classList.toggle('is-active', open);
  configPanel.classList.toggle('open', open);
  if(open){
    configMessage.textContent = '';
  }
}

async function onConfigSubmit(event){
  event.preventDefault();
  const staffPayload = {
    pilots: parseStaffTextarea(pilotListInput ? pilotListInput.value : ''),
    monkeyLeads: parseStaffTextarea(monkeyLeadListInput ? monkeyLeadListInput.value : ''),
    crew: parseStaffTextarea(crewListInput ? crewListInput.value : '')
  };
  const payload = {
    unitLabel: unitLabelSelect.value,
    webhook: {
      enabled: webhookEnabled ? webhookEnabled.checked : false,
      url: webhookUrl ? webhookUrl.value.trim() : '',
      method: webhookMethod ? webhookMethod.value.toUpperCase() : 'POST',
      secret: webhookSecret ? webhookSecret.value.trim() : '',
      headers: parseHeadersText(webhookHeaders ? webhookHeaders.value : '')
    }
  };
  try{
    const savedStaff = await apiRequest('/api/staff', {method: 'PUT', body: JSON.stringify(staffPayload)});
    state.staff = {
      pilots: normalizeNameList(savedStaff?.pilots || [], {sort: true}),
      monkeyLeads: normalizeNameList(savedStaff?.monkeyLeads || [], {sort: true}),
      crew: normalizeNameList(savedStaff?.crew || [], {sort: true})
    };
    populateStaffSettings();
    renderCrewOptions(getCurrentShow()?.crew || []);
    renderPilotAssignments(getCurrentShow());
    renderOperatorOptions();
    notifyStaffChanged();
  }catch(err){
    console.error(err);
    configMessage.textContent = err.message || 'Failed to save staff';
    toast(err.message || 'Failed to save staff', true);
    return;
  }
  try{
    const updated = await apiRequest('/api/config', {method:'PUT', body: JSON.stringify(payload)});
    state.config = updated;
    state.unitLabel = updated.unitLabel || 'Drone';
    state.serverHost = updated.host || state.serverHost;
    const nextPort = Number.parseInt(updated.port, 10);
    state.serverPort = Number.isFinite(nextPort) ? nextPort : state.serverPort;
    state.storageLabel = 'SQL.js storage v2';
    state.webhookConfig = {
      enabled: Boolean(updated.webhook?.enabled),
      url: updated.webhook?.url || '',
      method: (updated.webhook?.method || 'POST').toUpperCase(),
      secret: updated.webhook?.secret || '',
      headersText: formatHeadersText(updated.webhook?.headers)
    };
    state.webhookStatus = {
      enabled: Boolean(updated.webhook?.enabled && updated.webhook?.url),
      method: state.webhookConfig.method,
      hasSecret: Boolean(updated.webhook?.secret),
      headerCount: Array.isArray(updated.webhook?.headers) ? updated.webhook.headers.length : 0
    };
    unitLabelSelect.value = state.unitLabel;
    appTitle.textContent = state.unitLabel;
    unitLabelEl.textContent = state.unitLabel;
    setLanAddress();
    setProviderBadge(state.storageLabel);
    setWebhookBadge(state.webhookStatus);
    populateUnitOptions();
    syncWebhookFields();
    updateWebhookPreview();
    updateConnectionIndicator('loading');
    await loadShows();
    setCurrentShow(state.currentShowId || null);
    notifyConfigChanged({unitLabel: state.unitLabel});
    configMessage.textContent = 'Settings saved. Storage restarted.';
    toggleConfig(false);
    toast('Settings updated');
  }catch(err){
    console.error(err);
    configMessage.textContent = err.message || 'Failed to save settings';
    toast('Failed to save settings', true);
  }
}

function onExportCsv(){
  const show = getCurrentShow();
  if(!show){
    toast('No current show', true);
    return;
  }
  const rows = (show.entries||[]).map(entry=>{
    const row = buildWebhookRow(show, entry);
    return EXPORT_COLUMNS.map(column => row[column] ?? '');
  });
  const csv = [EXPORT_COLUMNS.map(csvEscape).join(','), ...rows.map(row=>row.map(csvEscape).join(','))].join('\n');
  downloadFile(csv, `${show.id}.csv`, 'text/csv');
  toast('CSV exported');
}

function onExportJson(){
  const show = getCurrentShow();
  if(!show){
    toast('No current show', true);
    return;
  }
  const json = JSON.stringify(show, null, 2);
  downloadFile(json, `${show.id}.json`, 'application/json');
  toast('JSON exported');
}

function buildWebhookRow(show = {}, entry = {}){
  const status = entry.status || '';
  const crewList = Array.isArray(show.crew) ? show.crew : [];
  const actions = Array.isArray(entry.actions) ? entry.actions : [];
  return {
    showId: show.id || '',
    showDate: show.date || '',
    showTime: show.time || '',
    showLabel: show.label || '',
    crew: crewList.join('|'),
    leadPilot: show.leadPilot || '',
    monkeyLead: show.monkeyLead || '',
    showNotes: show.notes || '',
    entryId: entry.id || '',
    unitId: entry.unitId || '',
    planned: entry.planned || '',
    launched: entry.launched || '',
    status,
    primaryIssue: status === 'Completed' ? '' : (entry.primaryIssue || ''),
    subIssue: status === 'Completed' ? '' : (entry.subIssue || ''),
    otherDetail: status === 'Completed' ? '' : (entry.otherDetail || ''),
    severity: status === 'Completed' ? '' : (entry.severity || ''),
    rootCause: status === 'Completed' ? '' : (entry.rootCause || ''),
    actions: actions.join('|'),
    operator: entry.operator || '',
    batteryId: entry.batteryId || '',
    delaySec: entry.delaySec === null || entry.delaySec === undefined ? '' : entry.delaySec,
    commandRx: entry.commandRx || '',
    notes: entry.notes || ''
  };
}

function buildSampleWebhookRow(){
  return {
    showId: 'sample-show',
    showDate: '2024-07-01',
    showTime: '19:00',
    showLabel: 'Evening Showcase',
    crew: 'Alex|Nazar',
    leadPilot: 'Alex',
    monkeyLead: 'Nazar',
    showNotes: 'Preview row for webhook payload',
    entryId: 'sample-entry',
    unitId: 'Drone-01',
    planned: 'Yes',
    launched: 'Yes',
    status: 'Completed',
    primaryIssue: '',
    subIssue: '',
    otherDetail: '',
    severity: '',
    rootCause: '',
    actions: 'Logged only',
    operator: 'Alex',
    batteryId: 'B-12',
    delaySec: '0',
    commandRx: 'Yes',
    notes: 'Nominal flight'
  };
}

function clearErrors(){
  qsa('.error').forEach(e=> e.hidden = true);
}

function showError(id){
  const el = document.getElementById(id);
  if(el){
    el.hidden = false;
  }
}

function setLanAddress(){
  if(!lanAddressEl){ return; }
  const host = state.serverHost || '10.241.211.120';
  const port = state.serverPort || 3000;
  lanAddressEl.textContent = `http://${host}:${port}`;
}

function setProviderBadge(label){
  if(!providerBadge){ return; }
  Array.from(providerBadge.classList)
    .filter(cls => cls.startsWith('provider-'))
    .forEach(cls => providerBadge.classList.remove(cls));
  providerBadge.classList.add('provider-sql');
  const text = label || 'SQL.js storage v2';
  providerBadge.textContent = text;
  providerBadge.setAttribute('aria-label', `Active storage provider: ${text}`);
}

function setWebhookBadge(status){
  if(!webhookBadge){ return; }
  const enabled = Boolean(status?.enabled);
  webhookBadge.classList.toggle('badge-webhook-on', enabled);
  webhookBadge.classList.toggle('badge-webhook-off', !enabled);
  const method = (status?.method || 'POST').toUpperCase();
  const text = enabled ? `Webhook ${method}` : 'Webhook disabled';
  webhookBadge.textContent = text;
  webhookBadge.setAttribute('aria-label', `Webhook status: ${text}`);
}

function updateConnectionIndicator(status){
  if(!connectionStatusEl){ return; }
  const host = state.serverHost || '10.241.211.120';
  const port = state.serverPort || 3000;
  const storageLabel = state.storageLabel || 'SQL.js storage v2';
  const webhookLabel = state.webhookStatus?.enabled
    ? `Webhook ${state.webhookStatus.method || 'POST'}`
    : 'Webhook disabled';
  setLanAddress();
  setProviderBadge(storageLabel);
  setWebhookBadge(state.webhookStatus);
  connectionStatusEl.classList.remove('is-error', 'is-pending');
  let message = '';
  if(status === 'loading'){
    message = `Refreshing data from ${host}:${port}…`;
    connectionStatusEl.classList.add('is-pending');
  }else if(status === 'error'){
    message = `Unable to reach ${host}:${port}`;
    connectionStatusEl.classList.add('is-error');
  }else if(status === 'ready'){
    message = `Listening on ${host}:${port}`;
    connectionStatusEl.classList.add('is-pending');
  }else{
    message = `Connected to ${host}:${port}`;
  }
  connectionStatusEl.textContent = `${message} • ${storageLabel} • ${webhookLabel}`;
}

function formatHeadersText(headers){
  if(!headers){
    return '';
  }
  if(Array.isArray(headers)){
    return headers
      .map(header => {
        if(typeof header === 'string'){ return header.trim(); }
        if(header && (header.name || header.key)){
          const name = String(header.name || header.key).trim();
          const value = header.value !== undefined ? String(header.value) : '';
          return name ? `${name}: ${value}`.trim() : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if(typeof headers === 'object'){
    return Object.entries(headers)
      .map(([name, value])=>`${name}: ${value}`)
      .join('\n');
  }
  return '';
}

function parseHeadersText(value){
  if(!value){
    return [];
  }
  return value.split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const idx = line.indexOf(':');
      if(idx === -1){
        return null;
      }
      const name = line.slice(0, idx).trim();
      const headerValue = line.slice(idx + 1).trim();
      return name ? {name, value: headerValue} : null;
    })
    .filter(Boolean);
}

function syncWebhookFields(){
  if(!webhookEnabled){ return; }
  const enabled = webhookEnabled.checked;
  [webhookUrl, webhookMethod, webhookSecret, webhookHeaders].forEach(input=>{
    if(input){
      input.disabled = !enabled;
      if(!enabled){
        input.classList.add('is-disabled');
      }else{
        input.classList.remove('is-disabled');
      }
    }
  });
  if(webhookPreview){
    webhookPreview.classList.toggle('is-disabled', !enabled || !(webhookUrl?.value.trim()));
  }
}

function updateWebhookPreview(){
  if(!webhookPreview){
    return;
  }
  state.webhookConfig.enabled = webhookEnabled ? webhookEnabled.checked : false;
  state.webhookConfig.url = webhookUrl ? webhookUrl.value.trim() : '';
  state.webhookConfig.method = webhookMethod ? webhookMethod.value.toUpperCase() : 'POST';
  state.webhookConfig.secret = webhookSecret ? webhookSecret.value.trim() : '';
  state.webhookConfig.headersText = webhookHeaders ? webhookHeaders.value : '';

  const enabled = state.webhookConfig.enabled;
  const url = state.webhookConfig.url;
  const method = state.webhookConfig.method;
  const show = getCurrentShow();
  const entry = show?.entries?.[0];
  let row = buildWebhookRow(show || {}, entry || {});
  const emptyRow = EXPORT_COLUMNS.every(col => row[col] === '' || row[col] === null || row[col] === undefined);
  if(emptyRow){
    row = buildSampleWebhookRow();
  }
  const headerCells = EXPORT_COLUMNS.map(column=>`<th>${escapeHtml(column)}</th>`).join('');
  const rowCells = EXPORT_COLUMNS.map(column=>`<td>${escapeHtml(row[column] ?? '')}</td>`).join('');
  const statusMessage = !enabled
    ? 'Webhook disabled. Enable the toggle to deliver entries automatically.'
    : (url ? `Entries will ${escapeHtml(method)} to ${escapeHtml(url)}.` : 'Provide a webhook URL to activate delivery.');
  webhookPreview.innerHTML = `
    <div class="webhook-status ${enabled && url ? 'is-on' : 'is-off'}">${statusMessage}</div>
    <div class="webhook-table-wrap">
      <table class="webhook-table">
        <thead><tr>${headerCells}</tr></thead>
        <tbody><tr>${rowCells}</tr></tbody>
      </table>
    </div>
  `;
  webhookPreview.classList.toggle('is-disabled', !enabled || !url);
}

function toast(message, isError){
  if(!toastEl){ return; }
  toastEl.textContent = message;
  toastEl.classList.add('show');
  toastEl.style.borderColor = isError ? 'var(--danger)' : 'var(--border)';
  setTimeout(()=> toastEl.classList.remove('show'), 2200);
}

function downloadFile(content, filename, type){
  const blob = new Blob([content], {type: type || 'application/octet-stream'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=> URL.revokeObjectURL(url), 500);
}

function csvEscape(value){
  if(value == null){
    return '';
  }
  const str = String(value);
  if(/[",\r\n]/.test(str)){
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function getDefaultUnits(){
  if(state.unitLabel === 'Monkey'){
    return Array.from({length: 12}, (_, i)=> String(i+1));
  }
  return Array.from({length: 12}, (_, i)=> `D${i+1}`);
}

function formatDateUS(dateStr){
  if(!dateStr || !dateStr.includes('-')){
    return dateStr || '';
  }
  const [y,m,d] = dateStr.split('-');
  return `${m}-${d}-${y}`;
}

function formatTime12Hour(timeStr){
  if(!timeStr || !timeStr.includes(':')){
    return timeStr || '';
  }
  const [h, m] = timeStr.split(':');
  let hour = parseInt(h, 10);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  if(hour === 0){ hour = 12; }
  if(hour > 12){ hour -= 12; }
  return `${hour}:${m} ${suffix}`;
}

function escapeHtml(str){
  return String(str || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

async function apiRequest(url, options){
  const opts = options || {};
  if(opts.body && typeof opts.body !== 'string'){
    opts.body = JSON.stringify(opts.body);
  }
  opts.headers = Object.assign({'Content-Type': 'application/json'}, opts.headers || {});
  const res = await fetch(url, opts);
  if(res.status === 204){
    return null;
  }
  let data = null;
  try{
    data = await res.json();
  }catch(err){
    data = null;
  }
  if(!res.ok){
    const message = data && data.error ? data.error : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

function populateStaffSettings(){
  if(pilotListInput){
    pilotListInput.value = (state.staff?.pilots || []).join('\n');
  }
  if(monkeyLeadListInput){
    monkeyLeadListInput.value = (state.staff?.monkeyLeads || []).join('\n');
  }
  if(crewListInput){
    crewListInput.value = (state.staff?.crew || []).join('\n');
  }
}

function parseStaffTextarea(value){
  if(typeof value !== 'string'){
    return [];
  }
  const lines = value.split(/\r?\n/);
  return normalizeNameList(lines, {sort: true});
}

function getPilotNames(additional = []){
  return normalizeNameList([state.staff?.pilots || [], additional], {sort: true});
}

function getCrewNames(additional = []){
  return normalizeNameList([state.staff?.crew || [], additional], {sort: true});
}

function getMonkeyLeadNames(additional = []){
  return normalizeNameList([state.staff?.monkeyLeads || [], additional], {sort: true});
}

function renderCrewOptions(selected = []){
  if(!showCrewSelect){
    return;
  }
  const selectedList = normalizeNameList(selected);
  const crewNames = getCrewNames([selectedList]);
  if(!crewNames.length){
    showCrewSelect.innerHTML = '<option value="">Add crew in settings</option>';
    showCrewSelect.disabled = true;
    return;
  }
  showCrewSelect.disabled = false;
  showCrewSelect.innerHTML = crewNames.map(name=>`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  const selectedSet = new Set(selectedList.map(name => name.toLowerCase()));
  Array.from(showCrewSelect.options).forEach(option =>{
    option.selected = selectedSet.has(option.value.toLowerCase());
  });
}

function renderPilotAssignments(show){
  if(leadPilotSelect){
    const pilotNames = getPilotNames([show?.leadPilot]);
    if(!pilotNames.length){
      leadPilotSelect.innerHTML = '<option value="">Add pilots in settings</option>';
      leadPilotSelect.disabled = true;
    }else{
      const pilotOptions = [''].concat(pilotNames).map(name=>{
        if(!name){
          return '<option value="">Select</option>';
        }
        return `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
      }).join('');
      leadPilotSelect.innerHTML = pilotOptions;
      leadPilotSelect.disabled = false;
      const leadValue = show?.leadPilot || '';
      const leadMatch = pilotNames.find(name => name.toLowerCase() === leadValue.toLowerCase());
      leadPilotSelect.value = leadMatch || '';
    }
  }
  if(monkeyLeadSelect){
    const monkeyNames = getMonkeyLeadNames([show?.monkeyLead]);
    if(!monkeyNames.length){
      monkeyLeadSelect.innerHTML = '<option value="">Add monkey leads in settings</option>';
      monkeyLeadSelect.disabled = true;
    }else{
      const monkeyOptions = [''].concat(monkeyNames).map(name=>{
        if(!name){
          return '<option value="">Select</option>';
        }
        return `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
      }).join('');
      monkeyLeadSelect.innerHTML = monkeyOptions;
      monkeyLeadSelect.disabled = false;
      const monkeyValue = show?.monkeyLead || '';
      const monkeyMatch = monkeyNames.find(name => name.toLowerCase() === monkeyValue.toLowerCase());
      monkeyLeadSelect.value = monkeyMatch || '';
    }
  }
}

function normalizeNameList(list = [], options = {}){
  const {sort = false} = options;
  const seen = new Set();
  const result = [];
  const queue = Array.isArray(list) ? list.slice() : [list];
  while(queue.length){
    const value = queue.shift();
    if(Array.isArray(value)){
      queue.push(...value);
      continue;
    }
    const name = typeof value === 'string' ? value.trim() : '';
    if(!name){
      continue;
    }
    const key = name.toLowerCase();
    if(seen.has(key)){
      continue;
    }
    seen.add(key);
    result.push(name);
  }
  if(sort){
    result.sort((a,b)=> a.localeCompare(b, undefined, {sensitivity: 'base'}));
  }
  return result;
}

function getShowById(id){
  return state.shows.find(s=>s.id===id) || null;
}

function el(id){
  return document.getElementById(id);
}

function qs(selector, root=document){
  return root.querySelector(selector);
}

function qsa(selector, root=document){
  return Array.from(root.querySelectorAll(selector));
}
