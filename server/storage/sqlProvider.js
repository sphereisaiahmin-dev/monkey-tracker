const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_PILOTS = ['Alex','Nick','John Henery','James','Robert','Nazar'];
const DEFAULT_CREW = ['Alex','Nick','John Henery','James','Robert','Nazar'];

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

    let shouldPersist = false;
    if(await this._fileExists(this.filename)){
      const content = await fs.promises.readFile(this.filename);
      this.db = new this.SQL.Database(content);
      shouldPersist = this._ensureSchema();
    }else{
      this.db = new this.SQL.Database();
      this._ensureSchema();
      shouldPersist = true;
    }

    if(this._seedDefaultStaff()){
      shouldPersist = true;
    }

    if(shouldPersist){
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
    await this._enforceShowLimit(show.date, show.id);
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
    await this._enforceShowLimit(updated.date, updated.id);
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
    this._assertPilotUnique(show, entry);
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
    this._assertPilotUnique(show, entry);
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

  async getStaff(){
    return {
      crew: this._listStaffByRole('crew'),
      pilots: this._listStaffByRole('pilot')
    };
  }

  async replaceStaff(staff = {}){
    const crew = this._normalizeNameList(staff.crew || [], {sort: true});
    const pilots = this._normalizeNameList(staff.pilots || [], {sort: true});
    this._replaceStaffRole('crew', crew);
    this._replaceStaffRole('pilot', pilots);
    await this._persistDatabase();
    return {crew, pilots};
  }

  _normalizeShow(raw){
    const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : Number(raw.createdAt);
    const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : Number(raw.updatedAt);
    return {
      id: raw.id,
      date: typeof raw.date === 'string' ? raw.date.trim() : '',
      time: typeof raw.time === 'string' ? raw.time.trim() : '',
      label: typeof raw.label === 'string' ? raw.label.trim() : '',
      crew: Array.isArray(raw.crew) ? this._normalizeNameList(raw.crew, {sort: true}) : [],
      leadPilot: typeof raw.leadPilot === 'string' ? raw.leadPilot.trim() : '',
      monkeyLead: typeof raw.monkeyLead === 'string' ? raw.monkeyLead.trim() : '',
      notes: typeof raw.notes === 'string' ? raw.notes.trim() : '',
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
      unitId: typeof raw.unitId === 'string' ? raw.unitId.trim() : '',
      planned: typeof raw.planned === 'string' ? raw.planned.trim() : '',
      launched: typeof raw.launched === 'string' ? raw.launched.trim() : '',
      status: typeof raw.status === 'string' ? raw.status.trim() : '',
      primaryIssue: typeof raw.primaryIssue === 'string' ? raw.primaryIssue.trim() : '',
      subIssue: typeof raw.subIssue === 'string' ? raw.subIssue.trim() : '',
      otherDetail: typeof raw.otherDetail === 'string' ? raw.otherDetail.trim() : '',
      severity: typeof raw.severity === 'string' ? raw.severity.trim() : '',
      rootCause: typeof raw.rootCause === 'string' ? raw.rootCause.trim() : '',
      actions: Array.isArray(raw.actions) ? this._normalizeNameList(raw.actions) : [],
      operator: typeof raw.operator === 'string' ? raw.operator.trim() : '',
      batteryId: typeof raw.batteryId === 'string' ? raw.batteryId.trim() : '',
      delaySec: raw.delaySec === null || raw.delaySec === undefined || raw.delaySec === ''
        ? null
        : Number(raw.delaySec),
      commandRx: typeof raw.commandRx === 'string' ? raw.commandRx.trim() : '',
      notes: typeof raw.notes === 'string' ? raw.notes.trim() : ''
    };
  }

  async _enforceShowLimit(date, excludeId){
    const trimmedDate = typeof date === 'string' ? date.trim() : '';
    if(!trimmedDate){
      return;
    }
    const shows = await this.listShows();
    const matching = shows.filter(show => {
      if(!show || typeof show !== 'object'){
        return false;
      }
      const showDate = typeof show.date === 'string' ? show.date.trim() : '';
      if(showDate !== trimmedDate){
        return false;
      }
      return show.id !== excludeId;
    });
    if(matching.length >= 5){
      const err = new Error('Daily show limit reached. Maximum of 5 shows per date.');
      err.status = 400;
      throw err;
    }
  }

  _assertPilotUnique(show, entry){
    if(!show){
      return;
    }
    const normalized = (entry.operator || '').trim().toLowerCase();
    if(!normalized){
      return;
    }
    const hasDuplicate = (show.entries || []).some(existing => {
      if(!existing){
        return false;
      }
      if(existing.id === entry.id){
        return false;
      }
      const existingPilot = (existing.operator || '').trim().toLowerCase();
      return existingPilot === normalized;
    });
    if(hasDuplicate){
      const err = new Error('Pilot already has an entry for this show.');
      err.status = 400;
      throw err;
    }
  }

  _ensureSchema(){
    let mutated = false;
    if(!this._tableExists('shows')){
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS shows (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      mutated = true;
    }else{
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS shows (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
    }

    if(!this._tableExists('staff')){
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS staff (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          role TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      mutated = true;
    }else{
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS staff (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          role TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
    }

    return mutated;
  }

  _seedDefaultStaff(){
    let mutated = false;
    if(this._listStaffByRole('pilot').length === 0){
      this._replaceStaffRole('pilot', this._normalizeNameList(DEFAULT_PILOTS, {sort: true}));
      mutated = true;
    }
    if(this._listStaffByRole('crew').length === 0){
      this._replaceStaffRole('crew', this._normalizeNameList(DEFAULT_CREW, {sort: true}));
      mutated = true;
    }
    return mutated;
  }

  _listStaffByRole(role){
    const rows = this._select('SELECT name FROM staff WHERE role = ? ORDER BY name COLLATE NOCASE', [role]);
    return rows.map(row => row.name);
  }

  _replaceStaffRole(role, names){
    this._run('DELETE FROM staff WHERE role = ?', [role]);
    if(!Array.isArray(names) || names.length === 0){
      return;
    }
    const timestamp = new Date().toISOString();
    names.forEach(name =>{
      this._run('INSERT INTO staff (id, name, role, created_at) VALUES (?, ?, ?, ?)', [uuidv4(), name, role, timestamp]);
    });
  }

  _normalizeNameList(list = [], options = {}){
    const {sort = false} = options;
    const seen = new Set();
    const result = [];
    list.forEach(name =>{
      const value = typeof name === 'string' ? name.trim() : '';
      if(!value){
        return;
      }
      const key = value.toLowerCase();
      if(seen.has(key)){
        return;
      }
      seen.add(key);
      result.push(value);
    });
    if(sort){
      result.sort((a,b)=> a.localeCompare(b, undefined, {sensitivity: 'base'}));
    }
    return result;
  }

  _tableExists(name){
    const row = this._selectOne("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [name]);
    return Boolean(row);
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
