const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_ROSTER = ['Alex','Nick','John Henery','James','Robert','Nazar'];

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

    let created = false;
    if(await this._fileExists(this.filename)){
      const content = await fs.promises.readFile(this.filename);
      this.db = new this.SQL.Database(content);
    }else{
      this.db = new this.SQL.Database();
      created = true;
    }

    this._createSchema();
    await this._seedDefaultRoster();

    if(created){
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
    await this._enforceDailyShowLimit(show.date, show.id);
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
    await this._enforceDailyShowLimit(updated.date, updated.id);
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
    const operatorName = this._normalizeRosterName(entryInput.operator);
    if(!operatorName){
      throw this._validationError('Pilot is required for an entry');
    }
    const roster = await this.listPilots();
    const known = roster.some(pilot => pilot.name.toLowerCase() === operatorName.toLowerCase());
    if(!known){
      throw this._validationError('Pilot must exist in the roster');
    }
    const duplicate = (show.entries || []).some(entry =>
      entry.operator && entry.operator.toLowerCase() === operatorName.toLowerCase()
    );
    if(duplicate){
      throw this._validationError('Pilot already has an entry for this show');
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
    const operatorName = this._normalizeRosterName(entry.operator);
    if(!operatorName){
      throw this._validationError('Pilot is required for an entry');
    }
    const roster = await this.listPilots();
    const known = roster.some(pilot => pilot.name.toLowerCase() === operatorName.toLowerCase());
    if(!known){
      throw this._validationError('Pilot must exist in the roster');
    }
    const duplicate = show.entries.some(existingEntry =>
      existingEntry.id !== entry.id &&
      existingEntry.operator &&
      existingEntry.operator.toLowerCase() === operatorName.toLowerCase()
    );
    if(duplicate){
      throw this._validationError('Pilot already has an entry for this show');
    }
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
      crew: Array.isArray(raw.crew) ? raw.crew.map(name => this._normalizeRosterName(name)).filter(Boolean) : [],
      leadPilot: this._normalizeRosterName(raw.leadPilot),
      monkeyLead: this._normalizeRosterName(raw.monkeyLead),
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
      operator: this._normalizeRosterName(raw.operator),
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
      );
      CREATE TABLE IF NOT EXISTS pilots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS crew_members (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_at TEXT NOT NULL
      );
    `);
  }

  async listPilots(){
    const rows = this._select('SELECT id, name FROM pilots ORDER BY name COLLATE NOCASE ASC');
    return rows.map(row => ({id: row.id, name: row.name}));
  }

  async createPilot(input){
    const name = this._normalizeRosterName(input?.name || input);
    if(!name){
      throw this._validationError('Pilot name is required');
    }
    const existing = this._selectOne('SELECT id FROM pilots WHERE lower(name) = lower(?)', [name]);
    if(existing){
      throw this._validationError('Pilot already exists');
    }
    const pilot = {id: uuidv4(), name};
    const now = new Date().toISOString();
    this._run('INSERT INTO pilots (id, name, created_at) VALUES (?, ?, ?)', [pilot.id, pilot.name, now]);
    await this._persistDatabase();
    return pilot;
  }

  async deletePilot(id){
    if(!id){
      return false;
    }
    this._run('DELETE FROM pilots WHERE id = ?', [id]);
    await this._persistDatabase();
    return true;
  }

  async listCrew(){
    const rows = this._select('SELECT id, name FROM crew_members ORDER BY name COLLATE NOCASE ASC');
    return rows.map(row => ({id: row.id, name: row.name}));
  }

  async createCrewMember(input){
    const name = this._normalizeRosterName(input?.name || input);
    if(!name){
      throw this._validationError('Crew member name is required');
    }
    const existing = this._selectOne('SELECT id FROM crew_members WHERE lower(name) = lower(?)', [name]);
    if(existing){
      throw this._validationError('Crew member already exists');
    }
    const crew = {id: uuidv4(), name};
    const now = new Date().toISOString();
    this._run('INSERT INTO crew_members (id, name, created_at) VALUES (?, ?, ?)', [crew.id, crew.name, now]);
    await this._persistDatabase();
    return crew;
  }

  async deleteCrewMember(id){
    if(!id){
      return false;
    }
    this._run('DELETE FROM crew_members WHERE id = ?', [id]);
    await this._persistDatabase();
    return true;
  }

  async _seedDefaultRoster(){
    const pilotCount = this._selectOne('SELECT COUNT(1) as count FROM pilots');
    const crewCount = this._selectOne('SELECT COUNT(1) as count FROM crew_members');
    const now = new Date().toISOString();
    if(!pilotCount || pilotCount.count === 0){
      DEFAULT_ROSTER.forEach(name =>{
        const normalized = this._normalizeRosterName(name);
        if(normalized){
          this._run('INSERT INTO pilots (id, name, created_at) VALUES (?, ?, ?)', [uuidv4(), normalized, now]);
        }
      });
    }
    if(!crewCount || crewCount.count === 0){
      DEFAULT_ROSTER.forEach(name =>{
        const normalized = this._normalizeRosterName(name);
        if(normalized){
          this._run('INSERT INTO crew_members (id, name, created_at) VALUES (?, ?, ?)', [uuidv4(), normalized, now]);
        }
      });
    }
    await this._persistDatabase();
  }

  async _enforceDailyShowLimit(date, currentId){
    if(!date){
      return;
    }
    const shows = await this.listShows();
    const count = shows.filter(show => show.date === date && show.id !== currentId).length;
    if(count >= 5){
      throw this._validationError('Daily show limit reached for this date');
    }
  }

  _normalizeRosterName(value){
    if(typeof value !== 'string'){
      return '';
    }
    return value.trim();
  }

  _validationError(message){
    const err = new Error(message);
    err.statusCode = 400;
    return err;
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
