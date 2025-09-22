const fs = require('fs');
const path = require('path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { v4: uuidv4 } = require('uuid');

class SqlProvider {
  constructor(config = {}){
    this.config = config;
    this.db = null;
  }

  async init(){
    const filename = this.config.filename || path.join(process.cwd(), 'data', 'monkey-tracker.sqlite');
    await fs.promises.mkdir(path.dirname(filename), {recursive: true});
    this.db = await open({filename, driver: sqlite3.Database});
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS shows (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  async dispose(){
    if(this.db){
      await this.db.close();
      this.db = null;
    }
  }

  async listShows(){
    const rows = await this.db.all('SELECT data FROM shows ORDER BY updated_at DESC');
    return rows.map(r=>JSON.parse(r.data));
  }

  async getShow(id){
    const row = await this.db.get('SELECT data FROM shows WHERE id = ?', id);
    return row ? JSON.parse(row.data) : null;
  }

  async createShow(input){
    const now = Date.now();
    const show = this._normalizeShow({
      ...input,
      id: input.id || uuidv4(),
      createdAt: now,
      updatedAt: now,
      entries: Array.isArray(input.entries) ? input.entries : []
    });
    await this._persist(show);
    return show;
  }

  async updateShow(id, updates){
    const existing = await this.getShow(id);
    if(!existing){
      return null;
    }
    const updated = this._normalizeShow({
      ...existing,
      ...updates,
      updatedAt: Date.now()
    });
    await this._persist(updated);
    return updated;
  }

  async deleteShow(id){
    await this.db.run('DELETE FROM shows WHERE id = ?', id);
  }

  async addEntry(showId, entryInput){
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
    await this._persist(show);
    return entry;
  }

  async updateEntry(showId, entryId, updates){
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
    await this._persist(show);
    return entry;
  }

  async deleteEntry(showId, entryId){
    const show = await this.getShow(showId);
    if(!show){
      return null;
    }
    const idx = show.entries.findIndex(e=>e.id===entryId);
    if(idx < 0){
      return null;
    }
    show.entries.splice(idx, 1);
    show.updatedAt = Date.now();
    await this._persist(show);
    return true;
  }

  async replaceShow(show){
    const normalized = this._normalizeShow(show);
    await this._persist(normalized);
    return normalized;
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

  async _persist(show){
    const payload = JSON.stringify(show);
    const updated = new Date(show.updatedAt || Date.now()).toISOString();
    await this.db.run(
      `INSERT INTO shows (id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      show.id,
      payload,
      updated
    );
  }
}

module.exports = SqlProvider;
