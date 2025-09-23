const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { v4: uuidv4 } = require('uuid');

class SqlProvider {
  constructor(config = {}){
    this.config = config;
    this.db = null;
    this.SQL = null;
    this.filename = this.config.filename || path.join(process.cwd(), 'data', 'monkey-tracker.sqlite');
  }

  async init(){
    if(!this.SQL){
      const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
      this.SQL = await initSqlJs({
        locateFile: (file) => path.join(wasmDir, file)
      });
    }

    await fs.promises.mkdir(path.dirname(this.filename), {recursive: true});

    if(this.db){
      return;
    }

    if(await this._fileExists(this.filename)){
      const content = await fs.promises.readFile(this.filename);
      this.db = new this.SQL.Database(content);
    }else{
      this.db = new this.SQL.Database();
      this._createSchema();
      await this._persistDatabase();
    }
  }

  async dispose(){
    if(this.db){
      this.db.close();
      this.db = null;
    }
  }

  async listShows(){
    const rows = this._select('SELECT data FROM shows ORDER BY updated_at DESC');
    return rows.map(r => JSON.parse(r.data));
  }

  async getShow(id){
    const row = this._selectOne('SELECT data FROM shows WHERE id = ?', [id]);
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
    this._run('DELETE FROM shows WHERE id = ?', [id]);
    await this._persistDatabase();
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
    const idx = show.entries.findIndex(e => e.id === entry.id);
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
    const idx = show.entries.findIndex(e => e.id === entryId);
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
    const idx = show.entries.findIndex(e => e.id === entryId);
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
      entries: Array.isArray(raw.entries) ? raw.entries.map(e => this._normalizeEntry(e)) : [],
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

  _createSchema(){
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shows (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  async _persist(show){
    const payload = JSON.stringify(show);
    const updated = new Date(show.updatedAt || Date.now()).toISOString();
    this._run(`
      INSERT INTO shows (id, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `, [show.id, payload, updated]);
    await this._persistDatabase();
  }

  _select(query, params = []){
    const stmt = this.db.prepare(query);
    try {
      stmt.bind(params);
      const rows = [];
      while(stmt.step()){
        rows.push(stmt.getAsObject());
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  _selectOne(query, params = []){
    const rows = this._select(query, params);
    return rows.length ? rows[0] : null;
  }

  _run(query, params = []){
    const stmt = this.db.prepare(query);
    try {
      stmt.bind(params);
      while(stmt.step()){
        // Exhaust the statement so sqlite finalizes it
      }
    } finally {
      stmt.free();
    }
  }

  async _persistDatabase(){
    if(!this.db){
      return;
    }
    const data = this.db.export();
    const buffer = Buffer.from(data);
    await fs.promises.writeFile(this.filename, buffer);
  }

  async _fileExists(filePath){
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch (err) {
      return false;
    }
  }
}

module.exports = SqlProvider;
