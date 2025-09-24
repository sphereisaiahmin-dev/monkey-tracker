import React, {useEffect, useMemo, useState} from 'https://esm.sh/react@18.3.1';
import {createRoot} from 'https://esm.sh/react-dom@18.3.1/client';
import htm from 'https://esm.sh/htm@3.1.1';

const html = htm.bind(React.createElement);

const ISSUE_MAP = {
  'Tracking lost': ['Occlusion','Calibration','Marker loss','Software','Unknown'],
  'Failed to launch': ['Mechanical','Arming','Safety','Unknown'],
  'Command delay': ['Network latency','Controller queue','Unknown'],
  'RF link': ['TX fault','RX fault','Interference','Antenna','Unknown'],
  'Battery': ['Low voltage','BMS fault','Poor contact','Swelling','Unknown'],
  'Motor or prop': ['No spin','Desync','Damage','Unknown'],
  'Sensor or IMU': ['Bias','Calibration','Saturation','Unknown'],
  'Software or show control': ['Cue timing','State desync','Crash','Unknown'],
  'Pilot input': ['Incorrect mode','Early abort','Missed cue','Unknown'],
  Other: []
};

const ACTIONS = ['Reboot','Swap battery','Swap drone','Retry launch','Abort segment','Logged only'];
const STATUS_OPTIONS = ['Completed','No-launch','Abort'];

const initialShowForm = {
  date: '',
  time: '',
  label: '',
  crew: [],
  leadPilot: '',
  monkeyLead: '',
  notes: ''
};

const initialEntryForm = {
  unitId: '',
  planned: '',
  launched: '',
  status: 'Completed',
  primaryIssue: '',
  subIssue: '',
  otherDetail: '',
  severity: '',
  rootCause: '',
  actions: [],
  operator: '',
  batteryId: '',
  delaySec: '',
  commandRx: '',
  notes: ''
};

function useToast(){
  const [toast, setToast] = useState(null);
  useEffect(()=>{
    if(!toast){
      return undefined;
    }
    const timer = setTimeout(()=> setToast(null), toast.duration || 4000);
    return ()=> clearTimeout(timer);
  }, [toast]);
  const showToast = (message, variant = 'info', duration = 4000)=>{
    setToast({message, variant, duration});
  };
  return {toast, showToast};
}

async function fetchJson(path, token, options = {}){
  const headers = {'Content-Type': 'application/json', ...(options.headers || {})};
  if(token){
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(path, {...options, headers});
  if(response.status === 204){
    return null;
  }
  let payload = null;
  try{
    payload = await response.json();
  }catch(err){
    payload = null;
  }
  if(!response.ok){
    const message = payload?.error || 'Request failed';
    throw new Error(message);
  }
  return payload;
}

function Login({onLogin, loading}){
  const [email, setEmail] = useState('admin@monkeytracker.local');
  const [password, setPassword] = useState('changeme123');
  const [error, setError] = useState('');

  const handleSubmit = async event =>{
    event.preventDefault();
    setError('');
    try{
      const res = await fetchJson('/api/auth/login', null, {
        method: 'POST',
        body: JSON.stringify({email, password})
      });
      onLogin(res);
    }catch(err){
      setError(err.message || 'Login failed');
    }
  };

  return html`
    <div className="auth-card">
      <h1>Monkey Tracker</h1>
      <p className="subtitle">Log in to continue</p>
      <form className="form-grid" onSubmit=${handleSubmit}>
        <label>
          Email
          <input type="email" value=${email} onChange=${event => setEmail(event.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" value=${password} onChange=${event => setPassword(event.target.value)} required />
        </label>
        ${error && html`<div className="form-error">${error}</div>`}
        <button type="submit" className="primary" disabled=${loading}>
          ${loading ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="helper-text">Default admin credentials are prefilled.</p>
      </form>
    </div>
  `;
}

function Badge({children, variant = 'neutral'}){
  return html`<span className=${`badge badge-${variant}`}>${children}</span>`;
}

function ActionsChipSelect({selected, onChange}){
  const toggleValue = value =>{
    const next = selected.includes(value)
      ? selected.filter(item => item !== value)
      : [...selected, value];
    onChange(next);
  };
  return html`
    <div className="chip-row">
      ${ACTIONS.map(action => html`
        <button
          type="button"
          key=${action}
          className=${`chip ${selected.includes(action) ? 'chip-active' : ''}`}
          onClick=${() => toggleValue(action)}
        >
          ${action}
        </button>
      `)}
    </div>
  `;
}

function MultiSelect({label, options, value, onChange, disabled}){
  return html`
    <label className="stack">
      ${label}
      <select
        multiple
        value=${value}
        disabled=${disabled}
        onChange=${event => {
          const next = Array.from(event.target.selectedOptions).map(option => option.value);
          onChange(next);
        }}
      >
        ${options.map(option => html`<option key=${option} value=${option}>${option}</option>`)}
      </select>
    </label>
  `;
}

function CreateShowForm({staff, onSubmit, disabled}){
  const [form, setForm] = useState(initialShowForm);

  const updateField = (field, value)=>{
    setForm(prev => ({...prev, [field]: value}));
  };

  const handleSubmit = event =>{
    event.preventDefault();
    onSubmit(form).then(()=> setForm(initialShowForm));
  };

  return html`
    <form className="panel" onSubmit=${handleSubmit}>
      <h2>Create show</h2>
      <div className="form-grid">
        <label>
          Date
          <input type="date" value=${form.date} onChange=${event => updateField('date', event.target.value)} required disabled=${disabled} />
        </label>
        <label>
          Time
          <input type="time" value=${form.time} onChange=${event => updateField('time', event.target.value)} required disabled=${disabled} />
        </label>
        <label>
          Label
          <input type="text" value=${form.label} onChange=${event => updateField('label', event.target.value)} required disabled=${disabled} />
        </label>
        <${MultiSelect}
          label="Crew"
          options=${staff.crew}
          value=${form.crew}
          onChange=${value => updateField('crew', value)}
          disabled=${disabled}
        />
        <label>
          Lead pilot
          <select value=${form.leadPilot} onChange=${event => updateField('leadPilot', event.target.value)} disabled=${disabled}>
            <option value="">Select lead</option>
            ${staff.pilots.map(pilot => html`<option key=${pilot} value=${pilot}>${pilot}</option>`)}
          </select>
        </label>
        <label>
          Monkey lead
          <select value=${form.monkeyLead} onChange=${event => updateField('monkeyLead', event.target.value)} disabled=${disabled}>
            <option value="">Select lead</option>
            ${staff.monkeyLeads.map(lead => html`<option key=${lead} value=${lead}>${lead}</option>`)}
          </select>
        </label>
        <label className="stack">
          Notes
          <textarea value=${form.notes} onChange=${event => updateField('notes', event.target.value)} disabled=${disabled} rows=${3} />
        </label>
      </div>
      <button type="submit" className="primary" disabled=${disabled}>Create show</button>
    </form>
  `;
}

function EntryForm({staff, onSubmit, disabled}){
  const [form, setForm] = useState(initialEntryForm);

  useEffect(()=>{
    if(form.status === 'Completed'){
      setForm(prev =>{
        if(!prev.primaryIssue && !prev.subIssue && !prev.otherDetail && !prev.severity && !prev.rootCause){
          return prev;
        }
        return {...prev, primaryIssue: '', subIssue: '', otherDetail: '', severity: '', rootCause: ''};
      });
    }
  }, [form.status]);

  const updateField = (field, value)=>{
    setForm(prev => ({...prev, [field]: value}));
  };

  const handleSubmit = event =>{
    event.preventDefault();
    const payload = {
      ...form,
      delaySec: form.delaySec === '' ? null : Number(form.delaySec)
    };
    onSubmit(payload).then(()=> setForm(initialEntryForm));
  };

  const subIssues = ISSUE_MAP[form.primaryIssue] || [];

  return html`
    <form className="panel" onSubmit=${handleSubmit}>
      <h3>Add entry</h3>
      <div className="form-grid">
        <label>
          Unit ID
          <input type="text" value=${form.unitId} onChange=${event => updateField('unitId', event.target.value)} required disabled=${disabled} />
        </label>
        <label>
          Planned
          <input type="text" value=${form.planned} onChange=${event => updateField('planned', event.target.value)} disabled=${disabled} />
        </label>
        <label>
          Launched
          <input type="text" value=${form.launched} onChange=${event => updateField('launched', event.target.value)} disabled=${disabled} />
        </label>
        <label>
          Status
          <select value=${form.status} onChange=${event => updateField('status', event.target.value)} disabled=${disabled}>
            ${STATUS_OPTIONS.map(status => html`<option key=${status} value=${status}>${status}</option>`)}
          </select>
        </label>
        ${form.status !== 'Completed' && html`
          <label>
            Primary issue
            <select value=${form.primaryIssue} onChange=${event => updateField('primaryIssue', event.target.value)} disabled=${disabled}>
              <option value="">Select issue</option>
              ${Object.keys(ISSUE_MAP).map(issue => html`<option key=${issue} value=${issue}>${issue}</option>`)}
            </select>
          </label>
        `}
        ${form.status !== 'Completed' && html`
          <label>
            Sub issue
            <select value=${form.subIssue} onChange=${event => updateField('subIssue', event.target.value)} disabled=${disabled}>
              <option value="">Select sub issue</option>
              ${subIssues.map(issue => html`<option key=${issue} value=${issue}>${issue}</option>`)}
            </select>
          </label>
        `}
        ${form.status !== 'Completed' && html`
          <label>
            Other detail
            <input type="text" value=${form.otherDetail} onChange=${event => updateField('otherDetail', event.target.value)} disabled=${disabled} />
          </label>
        `}
        ${form.status !== 'Completed' && html`
          <label>
            Severity
            <input type="text" value=${form.severity} onChange=${event => updateField('severity', event.target.value)} disabled=${disabled} />
          </label>
        `}
        ${form.status !== 'Completed' && html`
          <label>
            Root cause
            <input type="text" value=${form.rootCause} onChange=${event => updateField('rootCause', event.target.value)} disabled=${disabled} />
          </label>
        `}
        <label>
          Operator
          <select value=${form.operator} onChange=${event => updateField('operator', event.target.value)} disabled=${disabled}>
            <option value="">Select operator</option>
            ${staff.pilots.map(pilot => html`<option key=${pilot} value=${pilot}>${pilot}</option>`)}
          </select>
        </label>
        <label>
          Battery ID
          <input type="text" value=${form.batteryId} onChange=${event => updateField('batteryId', event.target.value)} disabled=${disabled} />
        </label>
        <label>
          Delay (seconds)
          <input type="number" min="0" value=${form.delaySec} onChange=${event => updateField('delaySec', event.target.value)} disabled=${disabled} />
        </label>
        <label>
          Command Rx
          <input type="text" value=${form.commandRx} onChange=${event => updateField('commandRx', event.target.value)} disabled=${disabled} />
        </label>
        <label className="stack">
          Notes
          <textarea value=${form.notes} onChange=${event => updateField('notes', event.target.value)} disabled=${disabled} rows=${3} />
        </label>
      </div>
      <div className="form-grid">
        <${ActionsChipSelect} selected=${form.actions} onChange=${value => updateField('actions', value)} />
      </div>
      <button type="submit" className="primary" disabled=${disabled}>Add entry</button>
    </form>
  `;
}

function EntriesTable({entries, canDelete, onDelete}){
  if(!entries.length){
    return html`<p className="empty">No entries yet.</p>`;
  }
  return html`
    <div className="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>Unit</th>
            <th>Status</th>
            <th>Operator</th>
            <th>Primary issue</th>
            <th>Actions</th>
            <th>Timestamp</th>
            ${canDelete && html`<th></th>`}
          </tr>
        </thead>
        <tbody>
          ${entries.map(entry => html`
            <tr key=${entry.id}>
              <td>${entry.unitId || '—'}</td>
              <td>${entry.status || '—'}</td>
              <td>${entry.operator || '—'}</td>
              <td>${entry.status === 'Completed' ? '—' : (entry.primaryIssue || '—')}</td>
              <td>${entry.actions?.length ? entry.actions.join(', ') : '—'}</td>
              <td>${new Date(entry.ts).toLocaleString()}</td>
              ${canDelete && html`
                <td>
                  <button className="link" type="button" onClick=${() => onDelete(entry.id)}>Remove</button>
                </td>
              `}
            </tr>
          `)}
        </tbody>
      </table>
    </div>
  `;
}

function ShowMeta({show, onUpdate, disabled}){
  const [draft, setDraft] = useState(show);

  useEffect(()=>{
    setDraft(show);
  }, [show]);

  if(!show){
    return null;
  }

  const updateField = (field, value)=>{
    setDraft(prev => ({...prev, [field]: value}));
  };

  const handleSubmit = event =>{
    event.preventDefault();
    const payload = {
      date: draft.date,
      time: draft.time,
      label: draft.label,
      crew: draft.crew,
      leadPilot: draft.leadPilot,
      monkeyLead: draft.monkeyLead,
      notes: draft.notes
    };
    onUpdate(payload);
  };

  return html`
    <form className="panel" onSubmit=${handleSubmit}>
      <h3>Show details</h3>
      <div className="form-grid">
        <label>
          Date
          <input type="date" value=${draft.date} onChange=${event => updateField('date', event.target.value)} disabled=${disabled} required />
        </label>
        <label>
          Time
          <input type="time" value=${draft.time} onChange=${event => updateField('time', event.target.value)} disabled=${disabled} required />
        </label>
        <label>
          Label
          <input type="text" value=${draft.label} onChange=${event => updateField('label', event.target.value)} disabled=${disabled} required />
        </label>
        <label className="stack">
          Crew
          <input
            type="text"
            value=${draft.crew?.join(', ') || ''}
            onChange=${event => updateField('crew', event.target.value.split(',').map(item => item.trim()).filter(Boolean))}
            disabled=${disabled}
          />
          <span className="helper-text">Comma separated</span>
        </label>
        <label>
          Lead pilot
          <input type="text" value=${draft.leadPilot || ''} onChange=${event => updateField('leadPilot', event.target.value)} disabled=${disabled} />
        </label>
        <label>
          Monkey lead
          <input type="text" value=${draft.monkeyLead || ''} onChange=${event => updateField('monkeyLead', event.target.value)} disabled=${disabled} />
        </label>
        <label className="stack">
          Notes
          <textarea value=${draft.notes || ''} onChange=${event => updateField('notes', event.target.value)} disabled=${disabled} rows=${3} />
        </label>
      </div>
      <button type="submit" className="primary" disabled=${disabled}>Update show</button>
    </form>
  `;
}

function ArchivedShows({items}){
  if(!items.length){
    return html`<p className="empty">No archived shows.</p>`;
  }
  return html`
    <div className="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>Label</th>
            <th>Date</th>
            <th>Archived</th>
            <th>Entries</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(show => html`
            <tr key=${show.id}>
              <td>${show.label}</td>
              <td>${show.date}</td>
              <td>${show.archivedAt ? new Date(show.archivedAt).toLocaleString() : '—'}</td>
              <td>${Array.isArray(show.entries) ? show.entries.length : 0}</td>
            </tr>
          `)}
        </tbody>
      </table>
    </div>
  `;
}

function Dashboard({token, user, onLogout}){
  const {toast, showToast} = useToast();
  const [loading, setLoading] = useState(true);
  const [shows, setShows] = useState([]);
  const [archived, setArchived] = useState([]);
  const [staff, setStaff] = useState({crew: [], pilots: [], monkeyLeads: []});
  const [selectedShowId, setSelectedShowId] = useState(null);
  const [meta, setMeta] = useState({storage: '', webhook: {}});
  const [view, setView] = useState('active');

  const canManageShows = ['admin', 'manager'].includes(user.role);
  const canManageStaff = ['admin', 'manager'].includes(user.role);
  const canDeleteShows = user.role === 'admin';
  const canAddEntries = ['admin', 'manager', 'pilot'].includes(user.role);

  const selectedShow = useMemo(()=>{
    return shows.find(show => show.id === selectedShowId) || shows[0] || null;
  }, [shows, selectedShowId]);

  useEffect(()=>{
    loadData();
  }, [token]);

  async function loadData(){
    setLoading(true);
    try{
      const [showPayload, staffPayload] = await Promise.all([
        fetchJson('/api/shows', token),
        fetchJson('/api/staff', token)
      ]);
      setShows(showPayload.shows || []);
      setMeta({storage: showPayload.storage, webhook: showPayload.webhook});
      setStaff(staffPayload);
      if(canManageShows){
        try{
          const archivePayload = await fetchJson('/api/shows/archive', token);
          setArchived(archivePayload.shows || []);
        }catch(err){
          console.warn('Failed to load archived shows', err);
        }
      }
      if(showPayload.shows?.length){
        setSelectedShowId(showPayload.shows[0].id);
      }
      showToast('Synced with server', 'success');
    }catch(err){
      console.error(err);
      showToast(err.message || 'Failed to load data', 'error', 6000);
    }finally{
      setLoading(false);
    }
  }

  async function handleCreateShow(form){
    const payload = await fetchJson('/api/shows', token, {
      method: 'POST',
      body: JSON.stringify(form)
    });
    setShows(prev => [payload, ...prev]);
    setSelectedShowId(payload.id);
    showToast('Show created', 'success');
    return payload;
  }

  async function handleUpdateShow(id, updates){
    const payload = await fetchJson(`/api/shows/${id}`, token, {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
    setShows(prev => prev.map(show => show.id === id ? payload : show));
    showToast('Show updated', 'success');
    return payload;
  }

  async function handleDeleteShow(id){
    await fetchJson(`/api/shows/${id}`, token, {method: 'DELETE'});
    setShows(prev => prev.filter(show => show.id !== id));
    setSelectedShowId(null);
    showToast('Show deleted', 'success');
  }

  async function handleArchiveShow(id){
    const archivedShow = await fetchJson(`/api/shows/${id}/archive`, token, {method: 'POST'});
    setShows(prev => prev.filter(show => show.id !== id));
    setArchived(prev => [archivedShow, ...prev]);
    setSelectedShowId(null);
    showToast('Show archived', 'info');
    return archivedShow;
  }

  async function handleAddEntry(showId, form){
    const entry = await fetchJson(`/api/shows/${showId}/entries`, token, {
      method: 'POST',
      body: JSON.stringify(form)
    });
    setShows(prev => prev.map(show => show.id === showId ? {...show, entries: [...show.entries, entry]} : show));
    showToast('Entry added', 'success');
    return entry;
  }

  async function handleDeleteEntry(showId, entryId){
    await fetchJson(`/api/shows/${showId}/entries/${entryId}`, token, {method: 'DELETE'});
    setShows(prev => prev.map(show => show.id === showId ? {...show, entries: show.entries.filter(entry => entry.id !== entryId)} : show));
    showToast('Entry removed', 'info');
  }

  async function handleLogout(){
    try{
      await fetchJson('/api/auth/logout', token, {method: 'POST'});
    }catch(err){
      console.warn('Logout warning', err);
    }
    onLogout();
  }

  return html`
    <div className="layout">
      <header className="topbar">
        <div>
          <h1>Monkey Tracker</h1>
          <div className="meta-row">
            <${Badge} variant="accent">${meta.storage || 'Storage unknown'}</${Badge}>
            <${Badge} variant=${meta.webhook?.enabled ? 'success' : 'neutral'}>
              Webhook ${meta.webhook?.enabled ? 'enabled' : 'disabled'}
            </${Badge}>
          </div>
        </div>
        <div className="user-block">
          <div className="user-info">
            <span>${user.name}</span>
            <${Badge} variant="outline">${user.role}</${Badge}>
          </div>
          <button type="button" className="link" onClick=${handleLogout}>Sign out</button>
        </div>
      </header>
      <main className="content">
        <section className="sidebar">
          <div className="panel">
            <h2>Active shows</h2>
            ${loading && html`<p>Loading…</p>`}
            ${!loading && shows.length === 0 && html`<p className="empty">No shows scheduled.</p>`}
            <ul className="show-list">
              ${shows.map(show => html`
                <li key=${show.id} className=${show.id === selectedShowId ? 'active' : ''}>
                  <button type="button" onClick=${() => setSelectedShowId(show.id)}>
                    <span className="label">${show.label || 'Untitled show'}</span>
                    <span className="meta">${show.date || 'Date TBC'} · ${show.entries?.length || 0} entries</span>
                  </button>
                </li>
              `)}
            </ul>
          </div>
          ${canManageShows && html`<${CreateShowForm} staff=${staff} onSubmit=${handleCreateShow} disabled=${loading} />`}
          ${canManageStaff && html`
            <div className="panel">
              <h2>Staff roster</h2>
              <p className="helper-text">Manage crew lists via the API. Current counts:</p>
              <ul className="roster">
                <li><strong>${staff.pilots.length}</strong> pilots</li>
                <li><strong>${staff.crew.length}</strong> crew</li>
                <li><strong>${staff.monkeyLeads.length}</strong> monkey leads</li>
              </ul>
            </div>
          `}
          ${canManageShows && html`
            <div className="panel">
              <div className="tab-row">
                <button type="button" className=${view === 'active' ? 'tab active' : 'tab'} onClick=${() => setView('active')}>Active</button>
                <button type="button" className=${view === 'archived' ? 'tab active' : 'tab'} onClick=${() => setView('archived')}>Archived</button>
              </div>
              ${view === 'archived' && html`<${ArchivedShows} items=${archived} />`}
            </div>
          `}
        </section>
        <section className="workspace">
          ${selectedShow ? html`
            <${React.Fragment}>
              <${ShowMeta}
                show=${selectedShow}
                onUpdate=${updates => handleUpdateShow(selectedShow.id, updates)}
                disabled=${!canManageShows}
              />
              <div className="panel">
                <div className="panel-header">
                  <h3>Operations</h3>
                  <div className="actions">
                    ${canManageShows && html`<button type="button" className="secondary" onClick=${() => handleArchiveShow(selectedShow.id)}>Archive</button>`}
                    ${canDeleteShows && html`<button type="button" className="danger" onClick=${() => handleDeleteShow(selectedShow.id)}>Delete</button>`}
                  </div>
                </div>
                <p>Lead pilot: ${selectedShow.leadPilot || '—'} · Monkey lead: ${selectedShow.monkeyLead || '—'}</p>
                <p>Crew: ${selectedShow.crew?.length ? selectedShow.crew.join(', ') : '—'}</p>
                <p>${selectedShow.notes || 'No additional notes.'}</p>
              </div>
              <div className="panel">
                <h3>Entries</h3>
                <${EntriesTable}
                  entries=${selectedShow.entries || []}
                  canDelete=${canManageShows}
                  onDelete=${entryId => handleDeleteEntry(selectedShow.id, entryId)}
                />
              </div>
              ${canAddEntries && html`
                <${EntryForm}
                  staff=${staff}
                  onSubmit=${form => handleAddEntry(selectedShow.id, form)}
                  disabled=${loading}
                />
              `}
            </${React.Fragment}>
          ` : html`
            <div className="panel">
              <h2>Select a show</h2>
              <p className="empty">Choose a show on the left to view its detail.</p>
            </div>
          `}
        </section>
      </main>
      ${toast && html`<div className=${`toast toast-${toast.variant}`}>${toast.message}</div>`}
    </div>
  `;
}

function App(){
  const [token, setToken] = useState(() => localStorage.getItem('monkeyTrackerToken'));
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(()=>{
    async function bootstrap(){
      if(!token){
        setLoading(false);
        return;
      }
      try{
        const payload = await fetchJson('/api/auth/me', token);
        setUser(payload.user);
      }catch(err){
        console.warn('Session invalid', err);
        setToken(null);
        localStorage.removeItem('monkeyTrackerToken');
      }finally{
        setLoading(false);
      }
    }
    bootstrap();
  }, [token]);

  const handleLogin = result =>{
    setToken(result.token);
    localStorage.setItem('monkeyTrackerToken', result.token);
    setUser(result.user);
  };

  const handleLogout = () =>{
    setToken(null);
    setUser(null);
    localStorage.removeItem('monkeyTrackerToken');
  };

  if(!token || !user){
    return html`<${Login} onLogin=${handleLogin} loading=${loading} />`;
  }

  return html`<${Dashboard} token=${token} user=${user} onLogout=${handleLogout} />`;
}

const root = createRoot(document.getElementById('root'));
root.render(html`<${App} />`);
