const {Pool} = require('pg');
const {v4: uuidv4} = require('uuid');
const bcrypt = require('bcryptjs');

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const ARCHIVE_RETENTION_MONTHS = 2;
const DEFAULT_PILOTS = ['Alex','Nick','John Henery','James','Robert','Nazar'];
const DEFAULT_CREW = ['Alex','Nick','John Henery','James','Robert','Nazar'];
const DEFAULT_MONKEY_LEADS = ['Cleo','Bret','Leslie','Dallas'];
const DEFAULT_ADMIN = {
  email: 'admin@monkeytracker.local',
  name: 'Default Admin',
  role: 'admin',
  password: 'changeme123'
};

class PostgresProvider {
  constructor(config = {}){
    this.config = config;
    this.pool = null;
  }

  async init(){
    if(this.pool){
      return;
    }
    const connectionString = this.config.connectionString || process.env.DATABASE_URL || 'postgresql://postgres@localhost:5432/monkey_tracker';
    this.pool = new Pool({connectionString});
    await this._runMigrations();
    await this._seedDefaultStaff();
    await this._seedDefaultAdmin();
    await this._runArchiveMaintenance();
  }

  async dispose(){
    if(this.pool){
      await this.pool.end();
      this.pool = null;
    }
  }

  async listShows(){
    const shows = await this._query(`
      SELECT * FROM shows
      WHERE archived_at IS NULL
      ORDER BY updated_at DESC
    `);
    if(shows.length === 0){
      return [];
    }
    const idList = shows.map(show => show.id);
    const entries = await this._query(`
      SELECT * FROM entries
      WHERE show_id = ANY($1::uuid[])
      ORDER BY ts ASC
    `, [idList]);
    const entryMap = new Map();
    entries.forEach(entry =>{
      if(!entryMap.has(entry.show_id)){
        entryMap.set(entry.show_id, []);
      }
      entryMap.get(entry.show_id).push(this._mapEntryRow(entry));
    });
    return shows.map(row => this._mapShowRow(row, entryMap.get(row.id) || []));
  }

  async getShow(id){
    if(!id){
      return null;
    }
    const rows = await this._query(`SELECT * FROM shows WHERE id = $1`, [id]);
    if(rows.length === 0){
      return null;
    }
    const entries = await this._query(`SELECT * FROM entries WHERE show_id = $1 ORDER BY ts ASC`, [id]);
    return this._mapShowRow(rows[0], entries.map(row => this._mapEntryRow(row)));
  }

  async createShow(input = {}){
    const payload = this._normalizeShow({
      ...input,
      id: input.id || uuidv4(),
      createdAt: this._getTimestamp(input.createdAt) ?? Date.now(),
      updatedAt: this._getTimestamp(input.updatedAt) ?? Date.now()
    });
    await this._enforceShowLimit(payload.date, payload.id);
    await this._query(`
      INSERT INTO shows (
        id, date, time, label, crew, lead_pilot, monkey_lead, notes,
        created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
      )
      ON CONFLICT (id) DO UPDATE SET
        date = EXCLUDED.date,
        time = EXCLUDED.time,
        label = EXCLUDED.label,
        crew = EXCLUDED.crew,
        lead_pilot = EXCLUDED.lead_pilot,
        monkey_lead = EXCLUDED.monkey_lead,
        notes = EXCLUDED.notes,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        archived_at = NULL
    `, [
      payload.id,
      payload.date,
      payload.time,
      payload.label,
      payload.crew,
      payload.leadPilot,
      payload.monkeyLead,
      payload.notes,
      payload.createdAt,
      payload.updatedAt
    ]);
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    await this._replaceEntries(payload.id, entries);
    return this.getShow(payload.id);
  }

  async updateShow(id, updates = {}){
    const existing = await this.getShow(id);
    if(!existing){
      return null;
    }
    const payload = this._normalizeShow({
      ...existing,
      ...updates,
      id,
      updatedAt: Date.now()
    });
    await this._enforceShowLimit(payload.date, payload.id);
    await this._query(`
      UPDATE shows SET
        date = $2,
        time = $3,
        label = $4,
        crew = $5,
        lead_pilot = $6,
        monkey_lead = $7,
        notes = $8,
        updated_at = $9
      WHERE id = $1
    `, [
      payload.id,
      payload.date,
      payload.time,
      payload.label,
      payload.crew,
      payload.leadPilot,
      payload.monkeyLead,
      payload.notes,
      payload.updatedAt
    ]);
    return this.getShow(id);
  }

  async deleteShow(id){
    if(!id){
      return;
    }
    await this._query('DELETE FROM entries WHERE show_id = $1', [id]);
    await this._query('DELETE FROM shows WHERE id = $1', [id]);
  }

  async addEntry(showId, entryInput = {}){
    const show = await this.getShow(showId);
    if(!show){
      return null;
    }
    const entry = this._normalizeEntry({
      ...entryInput,
      id: entryInput.id || uuidv4(),
      ts: this._getTimestamp(entryInput.ts) ?? Date.now()
    });
    this._assertPilotUnique(show, entry);
    await this._query(`
      INSERT INTO entries (
        id, show_id, ts, unit_id, planned, launched, status,
        primary_issue, sub_issue, other_detail, severity, root_cause,
        actions, operator, battery_id, delay_sec, command_rx, notes,
        created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
      )
      ON CONFLICT (id) DO UPDATE SET
        show_id = EXCLUDED.show_id,
        ts = EXCLUDED.ts,
        unit_id = EXCLUDED.unit_id,
        planned = EXCLUDED.planned,
        launched = EXCLUDED.launched,
        status = EXCLUDED.status,
        primary_issue = EXCLUDED.primary_issue,
        sub_issue = EXCLUDED.sub_issue,
        other_detail = EXCLUDED.other_detail,
        severity = EXCLUDED.severity,
        root_cause = EXCLUDED.root_cause,
        actions = EXCLUDED.actions,
        operator = EXCLUDED.operator,
        battery_id = EXCLUDED.battery_id,
        delay_sec = EXCLUDED.delay_sec,
        command_rx = EXCLUDED.command_rx,
        notes = EXCLUDED.notes,
        updated_at = EXCLUDED.updated_at
    `, [
      entry.id,
      showId,
      entry.ts,
      entry.unitId,
      entry.planned,
      entry.launched,
      entry.status,
      entry.primaryIssue,
      entry.subIssue,
      entry.otherDetail,
      entry.severity,
      entry.rootCause,
      entry.actions,
      entry.operator,
      entry.batteryId,
      entry.delaySec,
      entry.commandRx,
      entry.notes,
      Date.now(),
      Date.now()
    ]);
    await this._touchShow(showId);
    return this.getEntry(entry.id);
  }

  async updateEntry(showId, entryId, updates = {}){
    const show = await this.getShow(showId);
    if(!show){
      return null;
    }
    const existing = show.entries.find(e => e.id === entryId);
    if(!existing){
      return null;
    }
    const entry = this._normalizeEntry({
      ...existing,
      ...updates,
      id: entryId
    });
    this._assertPilotUnique(show, entry);
    await this._query(`
      UPDATE entries SET
        ts = $2,
        unit_id = $3,
        planned = $4,
        launched = $5,
        status = $6,
        primary_issue = $7,
        sub_issue = $8,
        other_detail = $9,
        severity = $10,
        root_cause = $11,
        actions = $12,
        operator = $13,
        battery_id = $14,
        delay_sec = $15,
        command_rx = $16,
        notes = $17,
        updated_at = $18
      WHERE id = $1 AND show_id = $19
    `, [
      entryId,
      entry.ts,
      entry.unitId,
      entry.planned,
      entry.launched,
      entry.status,
      entry.primaryIssue,
      entry.subIssue,
      entry.otherDetail,
      entry.severity,
      entry.rootCause,
      entry.actions,
      entry.operator,
      entry.batteryId,
      entry.delaySec,
      entry.commandRx,
      entry.notes,
      Date.now(),
      showId
    ]);
    await this._touchShow(showId);
    return this.getEntry(entryId);
  }

  async deleteEntry(showId, entryId){
    await this._query('DELETE FROM entries WHERE id = $1 AND show_id = $2', [entryId, showId]);
    await this._touchShow(showId);
    return true;
  }

  async replaceShow(show){
    const normalized = this._normalizeShow(show);
    await this._query(`
      INSERT INTO shows (
        id, date, time, label, crew, lead_pilot, monkey_lead, notes,
        created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
      )
      ON CONFLICT (id) DO UPDATE SET
        date = EXCLUDED.date,
        time = EXCLUDED.time,
        label = EXCLUDED.label,
        crew = EXCLUDED.crew,
        lead_pilot = EXCLUDED.lead_pilot,
        monkey_lead = EXCLUDED.monkey_lead,
        notes = EXCLUDED.notes,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        archived_at = NULL
    `, [
      normalized.id,
      normalized.date,
      normalized.time,
      normalized.label,
      normalized.crew,
      normalized.leadPilot,
      normalized.monkeyLead,
      normalized.notes,
      normalized.createdAt,
      normalized.updatedAt
    ]);
    await this._replaceEntries(normalized.id, normalized.entries || []);
    return this.getShow(normalized.id);
  }

  async listArchivedShows(){
    const rows = await this._query('SELECT id, data, archived_at, created_at FROM show_archive ORDER BY archived_at DESC');
    return rows.map(row => this._mapArchivedRow(row)).filter(Boolean);
  }

  async getArchivedShow(id){
    if(!id){
      return null;
    }
    const rows = await this._query('SELECT id, data, archived_at, created_at FROM show_archive WHERE id = $1', [id]);
    if(!rows.length){
      return null;
    }
    return this._mapArchivedRow(rows[0]);
  }

  async archiveShowNow(id){
    const show = await this.getShow(id);
    if(!show){
      return this.getArchivedShow(id);
    }
    const archivedAt = Date.now();
    const payload = {...show, archivedAt};
    await this._query(`
      INSERT INTO show_archive (id, data, show_date, created_at, archived_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET
        data = EXCLUDED.data,
        show_date = EXCLUDED.show_date,
        created_at = EXCLUDED.created_at,
        archived_at = EXCLUDED.archived_at
    `, [
      show.id,
      payload,
      show.date || null,
      show.createdAt || null,
      archivedAt
    ]);
    await this._query('DELETE FROM entries WHERE show_id = $1', [id]);
    await this._query('DELETE FROM shows WHERE id = $1', [id]);
    return this.getArchivedShow(id);
  }

  async getStaff(){
    const staff = await this._query('SELECT name, role FROM staff ORDER BY name ASC');
    const crew = [];
    const pilots = [];
    const monkeyLeads = [];
    staff.forEach(member =>{
      if(member.role === 'crew'){
        crew.push(member.name);
      }else if(member.role === 'pilot'){
        pilots.push(member.name);
      }else if(member.role === 'monkeyLead'){
        monkeyLeads.push(member.name);
      }
    });
    return {crew, pilots, monkeyLeads};
  }

  async replaceStaff(staff = {}){
    const crew = this._normalizeNameList(staff.crew || [], {sort: true});
    const pilots = this._normalizeNameList(staff.pilots || [], {sort: true});
    const monkeyLeads = this._normalizeNameList(staff.monkeyLeads || [], {sort: true});
    const client = await this.pool.connect();
    try{
      await client.query('BEGIN');
      await client.query('DELETE FROM staff WHERE role = $1', ['crew']);
      await client.query('DELETE FROM staff WHERE role = $1', ['pilot']);
      await client.query('DELETE FROM staff WHERE role = $1', ['monkeyLead']);
      const now = Date.now();
      for(const name of crew){
        await client.query('INSERT INTO staff (id, name, role, created_at) VALUES ($1,$2,$3,$4)', [uuidv4(), name, 'crew', now]);
      }
      for(const name of pilots){
        await client.query('INSERT INTO staff (id, name, role, created_at) VALUES ($1,$2,$3,$4)', [uuidv4(), name, 'pilot', now]);
      }
      for(const name of monkeyLeads){
        await client.query('INSERT INTO staff (id, name, role, created_at) VALUES ($1,$2,$3,$4)', [uuidv4(), name, 'monkeyLead', now]);
      }
      await client.query('COMMIT');
    }catch(err){
      await client.query('ROLLBACK');
      throw err;
    }finally{
      client.release();
    }
    return {crew, pilots, monkeyLeads};
  }

  async getUserByEmail(email){
    if(!email){
      return null;
    }
    const rows = await this._query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if(!rows.length){
      return null;
    }
    return this._mapUserRow(rows[0]);
  }

  async getUserById(id){
    if(!id){
      return null;
    }
    const rows = await this._query('SELECT * FROM users WHERE id = $1', [id]);
    if(!rows.length){
      return null;
    }
    return this._mapUserRow(rows[0]);
  }

  async createUser(input){
    const payload = this._normalizeUser(input);
    await this._query(`
      INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [
      payload.id,
      payload.email,
      payload.name,
      payload.role,
      payload.passwordHash,
      payload.createdAt,
      payload.updatedAt
    ]);
    return this.getUserById(payload.id);
  }

  async listUsers(){
    const rows = await this._query('SELECT * FROM users ORDER BY created_at ASC');
    return rows.map(row => this._mapUserRow(row));
  }

  async updateUserRole(id, role){
    await this._query('UPDATE users SET role = $2, updated_at = $3 WHERE id = $1', [id, role, Date.now()]);
    return this.getUserById(id);
  }

  async _query(sql, params = []){
    const pool = this.pool;
    if(!pool){
      throw new Error('Storage provider not initialised');
    }
    const result = await pool.query(sql, params);
    return result.rows;
  }

  async _runMigrations(){
    await this._query(`
      CREATE TABLE IF NOT EXISTS shows (
        id UUID PRIMARY KEY,
        date TEXT NOT NULL,
        time TEXT,
        label TEXT,
        crew TEXT[] NOT NULL DEFAULT '{}',
        lead_pilot TEXT,
        monkey_lead TEXT,
        notes TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        archived_at BIGINT
      )
    `);
    await this._query(`
      CREATE TABLE IF NOT EXISTS entries (
        id UUID PRIMARY KEY,
        show_id UUID NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
        ts BIGINT NOT NULL,
        unit_id TEXT,
        planned TEXT,
        launched TEXT,
        status TEXT,
        primary_issue TEXT,
        sub_issue TEXT,
        other_detail TEXT,
        severity TEXT,
        root_cause TEXT,
        actions TEXT[] NOT NULL DEFAULT '{}',
        operator TEXT,
        battery_id TEXT,
        delay_sec INTEGER,
        command_rx TEXT,
        notes TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `);
    await this._query(`
      CREATE TABLE IF NOT EXISTS staff (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at BIGINT NOT NULL
      )
    `);
    await this._query(`
      CREATE TABLE IF NOT EXISTS show_archive (
        id UUID PRIMARY KEY,
        data JSONB NOT NULL,
        show_date TEXT,
        created_at BIGINT,
        archived_at BIGINT NOT NULL
      )
    `);
    await this._query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `);
  }

  async _seedDefaultStaff(){
    const staff = await this.getStaff();
    const operations = [];
    if(staff.pilots.length === 0){
      operations.push({role: 'pilot', names: this._normalizeNameList(DEFAULT_PILOTS, {sort: true})});
    }
    if(staff.crew.length === 0){
      operations.push({role: 'crew', names: this._normalizeNameList(DEFAULT_CREW, {sort: true})});
    }
    if(staff.monkeyLeads.length === 0){
      operations.push({role: 'monkeyLead', names: this._normalizeNameList(DEFAULT_MONKEY_LEADS, {sort: true})});
    }
    if(!operations.length){
      return;
    }
    const client = await this.pool.connect();
    try{
      await client.query('BEGIN');
      const now = Date.now();
      for(const op of operations){
        const role = op.role;
        await client.query('DELETE FROM staff WHERE role = $1', [role]);
        for(const name of op.names){
          await client.query('INSERT INTO staff (id, name, role, created_at) VALUES ($1,$2,$3,$4)', [uuidv4(), name, role, now]);
        }
      }
      await client.query('COMMIT');
    }catch(err){
      await client.query('ROLLBACK');
      throw err;
    }finally{
      client.release();
    }
  }

  async _seedDefaultAdmin(){
    const rows = await this._query('SELECT COUNT(*)::int AS count FROM users');
    if(rows[0]?.count > 0){
      return;
    }
    const hash = await bcrypt.hash(DEFAULT_ADMIN.password, 10);
    await this._query(`
      INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [
      uuidv4(),
      DEFAULT_ADMIN.email.toLowerCase(),
      DEFAULT_ADMIN.name,
      DEFAULT_ADMIN.role,
      hash,
      Date.now(),
      Date.now()
    ]);
  }

  async _runArchiveMaintenance(){
    const now = Date.now();
    const cutoff = now - (ARCHIVE_RETENTION_MONTHS * 30 * DAY_IN_MS);
    const rows = await this._query('SELECT * FROM shows WHERE archived_at IS NULL AND created_at <= $1', [cutoff]);
    for(const row of rows){
      await this.archiveShowNow(row.id);
    }
  }

  async _replaceEntries(showId, entries){
    const client = await this.pool.connect();
    try{
      await client.query('BEGIN');
      await client.query('DELETE FROM entries WHERE show_id = $1', [showId]);
      const now = Date.now();
      for(const entry of entries){
        const normalized = this._normalizeEntry(entry);
        await client.query(`
          INSERT INTO entries (
            id, show_id, ts, unit_id, planned, launched, status,
            primary_issue, sub_issue, other_detail, severity, root_cause,
            actions, operator, battery_id, delay_sec, command_rx, notes,
            created_at, updated_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
          )
        `, [
          normalized.id || uuidv4(),
          showId,
          normalized.ts,
          normalized.unitId,
          normalized.planned,
          normalized.launched,
          normalized.status,
          normalized.primaryIssue,
          normalized.subIssue,
          normalized.otherDetail,
          normalized.severity,
          normalized.rootCause,
          normalized.actions,
          normalized.operator,
          normalized.batteryId,
          normalized.delaySec,
          normalized.commandRx,
          normalized.notes,
          now,
          now
        ]);
      }
      await client.query('COMMIT');
    }catch(err){
      await client.query('ROLLBACK');
      throw err;
    }finally{
      client.release();
    }
    await this._touchShow(showId);
  }

  async _touchShow(id){
    if(!id){
      return;
    }
    await this._query('UPDATE shows SET updated_at = $2 WHERE id = $1', [id, Date.now()]);
  }

  async _touchArchive(id){
    if(!id){
      return;
    }
    await this._query('UPDATE show_archive SET archived_at = $2 WHERE id = $1', [id, Date.now()]);
  }

  async getEntry(id){
    if(!id){
      return null;
    }
    const rows = await this._query('SELECT * FROM entries WHERE id = $1', [id]);
    if(!rows.length){
      return null;
    }
    return this._mapEntryRow(rows[0]);
  }

  _normalizeShow(raw){
    const createdAt = this._getTimestamp(raw.createdAt) ?? Date.now();
    const updatedAt = this._getTimestamp(raw.updatedAt) ?? Date.now();
    return {
      id: raw.id || uuidv4(),
      date: typeof raw.date === 'string' ? raw.date.trim() : '',
      time: typeof raw.time === 'string' ? raw.time.trim() : '',
      label: typeof raw.label === 'string' ? raw.label.trim() : '',
      crew: Array.isArray(raw.crew) ? this._normalizeNameList(raw.crew, {sort: true}) : [],
      leadPilot: typeof raw.leadPilot === 'string' ? raw.leadPilot.trim() : '',
      monkeyLead: typeof raw.monkeyLead === 'string' ? raw.monkeyLead.trim() : '',
      notes: typeof raw.notes === 'string' ? raw.notes.trim() : '',
      entries: Array.isArray(raw.entries) ? raw.entries.map(entry => this._normalizeEntry(entry)) : [],
      createdAt,
      updatedAt
    };
  }

  _normalizeEntry(raw = {}){
    const ts = this._getTimestamp(raw.ts) ?? Date.now();
    return {
      id: raw.id || uuidv4(),
      ts,
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
      delaySec: raw.delaySec === null || raw.delaySec === undefined || raw.delaySec === '' ? null : Number(raw.delaySec),
      commandRx: typeof raw.commandRx === 'string' ? raw.commandRx.trim() : '',
      notes: typeof raw.notes === 'string' ? raw.notes.trim() : ''
    };
  }

  _normalizeUser(raw = {}){
    if(!raw.passwordHash){
      throw new Error('passwordHash is required');
    }
    const now = Date.now();
    return {
      id: raw.id || uuidv4(),
      email: typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '',
      name: typeof raw.name === 'string' ? raw.name.trim() : 'Unnamed',
      role: typeof raw.role === 'string' ? raw.role.trim() : 'viewer',
      passwordHash: raw.passwordHash,
      createdAt: raw.createdAt || now,
      updatedAt: raw.updatedAt || now
    };
  }

  _normalizeNameList(list = [], options = {}){
    const {sort = false} = options;
    const seen = new Set();
    const result = [];
    list.forEach(item =>{
      const value = typeof item === 'string' ? item.trim() : '';
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
      result.sort((a, b) => a.localeCompare(b, undefined, {sensitivity: 'base'}));
    }
    return result;
  }

  _mapShowRow(row, entries = []){
    return {
      id: row.id,
      date: row.date || '',
      time: row.time || '',
      label: row.label || '',
      crew: Array.isArray(row.crew) ? row.crew : [],
      leadPilot: row.lead_pilot || '',
      monkeyLead: row.monkey_lead || '',
      notes: row.notes || '',
      entries,
      createdAt: Number(row.created_at) || Date.now(),
      updatedAt: Number(row.updated_at) || Date.now()
    };
  }

  _mapEntryRow(row){
    return {
      id: row.id,
      ts: Number(row.ts) || Date.now(),
      unitId: row.unit_id || '',
      planned: row.planned || '',
      launched: row.launched || '',
      status: row.status || '',
      primaryIssue: row.primary_issue || '',
      subIssue: row.sub_issue || '',
      otherDetail: row.other_detail || '',
      severity: row.severity || '',
      rootCause: row.root_cause || '',
      actions: Array.isArray(row.actions) ? row.actions : [],
      operator: row.operator || '',
      batteryId: row.battery_id || '',
      delaySec: row.delay_sec === null || row.delay_sec === undefined ? null : Number(row.delay_sec),
      commandRx: row.command_rx || '',
      notes: row.notes || ''
    };
  }

  _mapArchivedRow(row){
    const data = row.data;
    if(!data || typeof data !== 'object'){
      return null;
    }
    const archivedAt = this._getTimestamp(data.archivedAt) ?? this._getTimestamp(row.archived_at) ?? Date.now();
    const createdAt = this._getTimestamp(data.createdAt) ?? this._getTimestamp(row.created_at) ?? Date.now();
    return {
      ...data,
      id: data.id || row.id,
      entries: Array.isArray(data.entries) ? data.entries : [],
      crew: Array.isArray(data.crew) ? data.crew : [],
      archivedAt,
      createdAt
    };
  }

  _mapUserRow(row){
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      passwordHash: row.password_hash,
      createdAt: Number(row.created_at) || Date.now(),
      updatedAt: Number(row.updated_at) || Date.now()
    };
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

  async _enforceShowLimit(date, excludeId){
    const trimmedDate = typeof date === 'string' ? date.trim() : '';
    if(!trimmedDate){
      return;
    }
    const rows = await this._query('SELECT id FROM shows WHERE date = $1 AND archived_at IS NULL', [trimmedDate]);
    const count = rows.filter(row => row.id !== excludeId).length;
    if(count >= 5){
      const err = new Error('Daily show limit reached. Maximum of 5 shows per date.');
      err.status = 400;
      throw err;
    }
  }

  _getTimestamp(value){
    if(typeof value === 'number' && Number.isFinite(value)){
      return value;
    }
    const numeric = Number(value);
    if(Number.isFinite(numeric)){
      return numeric;
    }
    if(typeof value === 'string'){
      const parsed = Date.parse(value);
      if(Number.isFinite(parsed)){
        return parsed;
      }
    }
    return null;
  }
}

module.exports = PostgresProvider;
