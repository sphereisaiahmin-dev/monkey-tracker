const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

class CodaProvider {
  constructor(config = {}){
    this.config = config;
    this.http = null;
    this.rowCache = new Map();
  }

  async init(){
    this.http = axios.create({
      baseURL: 'https://coda.io/apis/v1',
      headers: this.config.apiToken ? {
        Authorization: `Bearer ${this.config.apiToken}`,
        'Content-Type': 'application/json'
      } : {}
    });
    this.rowCache.clear();
  }

  async dispose(){
    this.rowCache.clear();
  }

  _assertConfigured(){
    const { apiToken, docId, tableId, showIdColumn, payloadColumn } = this.config || {};
    if(!apiToken || !docId || !tableId || !showIdColumn || !payloadColumn){
      throw new Error('Coda provider is not fully configured. Please supply API token, doc ID, table ID, show ID column, and payload column.');
    }
  }

  async listShows(){
    this._assertConfigured();
    const rows = await this._fetchRows();
    return rows.map(row=>this._rowToShow(row)).filter(Boolean);
  }

  async getShow(id){
    this._assertConfigured();
    if(this.rowCache.has(id)){
      const rowId = this.rowCache.get(id);
      const row = await this._getRowById(rowId);
      return row ? this._rowToShow(row) : null;
    }
    const rows = await this._fetchRows();
    const match = rows.find(r => this._getValue(r, this.config.showIdColumn) === id);
    return match ? this._rowToShow(match) : null;
  }

  async createShow(input){
    this._assertConfigured();
    const now = Date.now();
    const show = this._normalizeShow({
      ...input,
      id: input.id || uuidv4(),
      createdAt: now,
      updatedAt: now,
      entries: Array.isArray(input.entries) ? input.entries : []
    });
    await this._upsertRow(show);
    return show;
  }

  async updateShow(id, updates){
    this._assertConfigured();
    const existing = await this.getShow(id);
    if(!existing){
      return null;
    }
    const updated = this._normalizeShow({
      ...existing,
      ...updates,
      updatedAt: Date.now()
    });
    await this._upsertRow(updated);
    return updated;
  }

  async deleteShow(id){
    this._assertConfigured();
    if(!this.rowCache.has(id)){
      await this.listShows();
    }
    const rowId = this.rowCache.get(id);
    if(!rowId){
      return;
    }
    await this.http.delete(`/docs/${this.config.docId}/tables/${this.config.tableId}/rows/${encodeURIComponent(rowId)}`);
    this.rowCache.delete(id);
  }

  async addEntry(showId, entryInput){
    this._assertConfigured();
    const show = await this.getShow(showId);
    if(!show){
      return null;
    }
    const entry = this._normalizeEntry({
      ...entryInput,
      id: entryInput.id || uuidv4(),
      ts: entryInput.ts || Date.now()
    });
    const idx = show.entries.findIndex(e=>e.id===entry.id);
    if(idx >= 0){
      show.entries[idx] = entry;
    }else{
      show.entries.push(entry);
    }
    show.updatedAt = Date.now();
    await this._upsertRow(show);
    return entry;
  }

  async updateEntry(showId, entryId, updates){
    this._assertConfigured();
    const show = await this.getShow(showId);
    if(!show){
      return null;
    }
    const idx = show.entries.findIndex(e=>e.id===entryId);
    if(idx < 0){
      return null;
    }
    const entry = this._normalizeEntry({
      ...show.entries[idx],
      ...updates
    });
    show.entries[idx] = entry;
    show.updatedAt = Date.now();
    await this._upsertRow(show);
    return entry;
  }

  async deleteEntry(showId, entryId){
    this._assertConfigured();
    const show = await this.getShow(showId);
    if(!show){
      return null;
    }
    const idx = show.entries.findIndex(e=>e.id===entryId);
    if(idx < 0){
      return null;
    }
    show.entries.splice(idx,1);
    show.updatedAt = Date.now();
    await this._upsertRow(show);
    return true;
  }

  async replaceShow(show){
    this._assertConfigured();
    const normalized = this._normalizeShow(show);
    await this._upsertRow(normalized);
    return normalized;
  }

  async _fetchRows(){
    const rows = [];
    let pageToken;
    do {
      const res = await this.http.get(`/docs/${this.config.docId}/tables/${this.config.tableId}/rows`, {
        params: {
          useColumnNames: true,
          pageToken
        }
      });
      const items = res.data?.items || [];
      rows.push(...items);
      pageToken = res.data?.nextPageToken;
    } while(pageToken);
    this.rowCache.clear();
    rows.forEach(row => {
      const showId = this._getValue(row, this.config.showIdColumn);
      if(showId){
        this.rowCache.set(showId, row.id);
      }
    });
    return rows;
  }

  async _getRowById(rowId){
    const res = await this.http.get(`/docs/${this.config.docId}/tables/${this.config.tableId}/rows/${encodeURIComponent(rowId)}`, {
      params: { useColumnNames: true }
    });
    return res.data;
  }

  async _upsertRow(show){
    const rowId = this.rowCache.get(show.id);
    const payload = JSON.stringify(show);
    if(rowId){
      await this.http.put(`/docs/${this.config.docId}/tables/${this.config.tableId}/rows/${encodeURIComponent(rowId)}`, {
        row: {
          cells: [
            { column: this.config.showIdColumn, value: show.id },
            { column: this.config.payloadColumn, value: payload }
          ]
        }
      });
    }else{
      await this.http.post(`/docs/${this.config.docId}/tables/${this.config.tableId}/rows`, {
        rows: [
          {
            cells: [
              { column: this.config.showIdColumn, value: show.id },
              { column: this.config.payloadColumn, value: payload }
            ]
          }
        ],
        keyColumns: [this.config.showIdColumn]
      });
    }
    await this._fetchRows();
  }

  _rowToShow(row){
    try{
      const rawPayload = this._getValue(row, this.config.payloadColumn);
      const show = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
      if(!show.id){
        show.id = this._getValue(row, this.config.showIdColumn) || row.id;
      }
      show.entries = Array.isArray(show.entries) ? show.entries.map(e=>this._normalizeEntry(e)) : [];
      show.createdAt = show.createdAt || Date.now();
      show.updatedAt = show.updatedAt || Date.now();
      if(show.id){
        this.rowCache.set(show.id, row.id);
      }
      return show;
    }catch(err){
      console.error('Failed to parse Coda row', err);
      return null;
    }
  }

  _getValue(row, column){
    if(!row || !row.values){
      return undefined;
    }
    return row.values[column];
  }

  _normalizeShow(raw){
    const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : Number(raw.createdAt);
    const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : Number(raw.updatedAt);
    return {
      id: raw.id,
      date: raw.date || '',
      time: raw.time || '',
      label: raw.label || '',
      crew: Array.isArray(raw.crew) ? raw.crew : [],
      leadPilot: raw.leadPilot || '',
      monkeyLead: raw.monkeyLead || '',
      notes: raw.notes || '',
      entries: Array.isArray(raw.entries) ? raw.entries.map(e=>this._normalizeEntry(e)) : [],
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now()
    };
  }

  _normalizeEntry(raw){
    const ts = typeof raw.ts === 'number' ? raw.ts : Number(raw.ts);
    return {
      id: raw.id || uuidv4(),
      ts: Number.isFinite(ts) ? ts : Date.now(),
      unitId: raw.unitId || '',
      planned: raw.planned || '',
      launched: raw.launched || '',
      status: raw.status || '',
      primaryIssue: raw.primaryIssue || '',
      subIssue: raw.subIssue || '',
      otherDetail: raw.otherDetail || '',
      severity: raw.severity || '',
      rootCause: raw.rootCause || '',
      actions: Array.isArray(raw.actions) ? raw.actions : [],
      operator: raw.operator || '',
      batteryId: raw.batteryId || '',
      delaySec: raw.delaySec === null || raw.delaySec === undefined || raw.delaySec === ''
        ? null
        : Number(raw.delaySec),
      commandRx: raw.commandRx || '',
      notes: raw.notes || ''
    };
  }
}

module.exports = CodaProvider;
