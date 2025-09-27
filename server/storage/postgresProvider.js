const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const ARCHIVE_RETENTION_MONTHS = 2;
const DEFAULT_USERS = [
  {email: 'Nazar.Vasylyk@thesphere.com', role: 'pilot', password: 'admin'},
  {email: 'Alexander.Brodnik@thesphere.com', role: 'pilot', password: 'admin'},
  {email: 'Robert.Ontell@thesphere.com', role: 'pilot', password: 'admin'},
  {email: 'Cleo.Kelley@thesphere.com', role: 'stagehand', password: 'admin'},
  {email: 'Bret.Tuttle@thesphere.com', role: 'stagehand', password: 'admin'}
];

const PASSWORD_ITERATIONS = 120_000;
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_DIGEST = 'sha512';
const DEFAULT_TOKEN_TTL_MS = 7 * DAY_IN_MS;

const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

class PostgresProvider {
  constructor(config = {}){
    this.config = config || {};
    this.pool = null;
    this.schema = this._sanitizeIdentifier(this.config.schema);
  }

  async init(){
    if(this.pool){
      await this.dispose();
    }
    const poolConfig = this._buildPoolConfig();
    const {databaseCreated} = await this._ensureDatabaseExists(poolConfig);
    this.pool = this._createPool(poolConfig);
    // sanity check connection
    await this.pool.query('SELECT 1');
    this._logConnectionEstablished();

    const schemaSummary = await this._ensureSchema();
    const seededDefaults = await this._seedDefaultUsers();
    await this._refreshArchive();
    this._logBootstrapSummary({databaseCreated, ...schemaSummary, seededDefaults});
  }

  async dispose(){
    if(this.pool){
      const pool = this.pool;
      this.pool = null;
      await pool.end();
    }
  }

  getStorageLabel(){
    return 'PostgreSQL v1';
  }

  getStorageMetadata(){
    const params = this.pool?.options || this.pool?.connectionParameters || {};
    return {
      label: this.getStorageLabel(),
      driver: 'postgres',
      host: params.host,
      port: params.port,
      database: params.database,
      user: params.user,
      schema: this.schema || 'public'
    };
  }

  async listShows(){
    await this._refreshArchive();
    const rows = await this._select(`SELECT data FROM ${this._table('shows')} ORDER BY updated_at DESC`);
    return rows.map(row => this._normalizeShow(this._parseRowData(row?.data) || {}));
  }

  async getShow(id){
    if(!id){
      return null;
    }
    await this._refreshArchive();
    const row = await this._selectOne(`SELECT data FROM ${this._table('shows')} WHERE id = $1`, [id]);
    return row ? this._normalizeShow(this._parseRowData(row.data) || {}) : null;
  }

  async createShow(input){
    const payload = input || {};
    this._assertRequiredShowFields(payload);
    const now = Date.now();
    const createdAtCandidate = Number(payload.createdAt);
    const updatedAtCandidate = Number(payload.updatedAt);
    const createdAt = Number.isFinite(createdAtCandidate) ? createdAtCandidate : now;
    let updatedAt = Number.isFinite(updatedAtCandidate) ? updatedAtCandidate : now;
    if(updatedAt < createdAt){
      updatedAt = createdAt;
    }
    const show = this._normalizeShow({
      ...payload,
      id: payload.id || uuidv4(),
      createdAt,
      updatedAt,
      entries: Array.isArray(payload.entries) ? payload.entries : []
    });
    await this._enforceShowLimit(show.date, show.id);
    await this._persist(show);
    await this._refreshArchive();
    return show;
  }

  async updateShow(id, updates){
    const existing = await this.getShow(id);
    if(!existing){
      return null;
    }
    this._assertRequiredShowFields({...existing, ...updates});
    const updated = this._normalizeShow({
      ...existing,
      ...updates,
      updatedAt: Date.now()
    });
    await this._enforceShowLimit(updated.date, updated.id);
    await this._persist(updated);
    await this._refreshArchive();
    return updated;
  }

  async deleteShow(id){
    if(!id){
      return null;
    }
    const showsTable = this._table('shows');
    const archiveTable = this._table('show_archive');
    let archivedShow = null;
    const deleted = await this._withClient(async client =>{
      const res = await client.query(`SELECT data FROM ${showsTable} WHERE id = $1`, [id]);
      if(res.rows.length === 0){
        return false;
      }
      const row = res.rows[0];
      const show = this._parseRowData(row.data);
      if(!show || typeof show !== 'object'){
        await client.query(`DELETE FROM ${showsTable} WHERE id = $1`, [id]);
        return false;
      }
      const normalized = this._normalizeShow(show);
      const archiveTime = Date.now();
      normalized.archivedAt = archiveTime;
      normalized.deletedAt = archiveTime;
      await this._saveArchiveRow(normalized, archiveTime, archiveTime, client);
      await client.query(`DELETE FROM ${showsTable} WHERE id = $1`, [normalized.id]);
      archivedShow = normalized;
      return true;
    });
    if(!deleted){
      return null;
    }
    await this._refreshArchive();
    if(!archivedShow){
      const row = await this._selectOne(`SELECT data, archived_at, created_at FROM ${archiveTable} WHERE id = $1`, [id]);
      return row ? this._mapArchiveRow(row) : null;
    }
    return archivedShow;
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
    await this._refreshArchive();
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
    await this._refreshArchive();
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
    await this._refreshArchive();
    return true;
  }

  async replaceShow(show){
    const normalized = this._normalizeShow(show);
    await this._persist(normalized);
    await this._refreshArchive();
    return normalized;
  }

  async listArchivedShows(){
    await this._refreshArchive();
    const rows = await this._select(`SELECT data, archived_at, created_at, deleted_at FROM ${this._table('show_archive')} ORDER BY archived_at DESC, id ASC`);
    return rows.map(row => this._mapArchiveRow(row)).filter(Boolean);
  }

  async getArchivedShow(id){
    if(!id){
      return null;
    }
    await this._refreshArchive();
    const row = await this._selectOne(`SELECT data, archived_at, created_at, deleted_at FROM ${this._table('show_archive')} WHERE id = $1`, [id]);
    return row ? this._mapArchiveRow(row) : null;
  }

  async archiveShowNow(id){
    if(!id){
      return null;
    }
    const showsTable = this._table('shows');
    const row = await this._selectOne(`SELECT data FROM ${showsTable} WHERE id = $1`, [id]);
    if(!row){
      return this.getArchivedShow(id);
    }
    const show = this._parseRowData(row.data);
    if(!show || typeof show !== 'object'){
      return null;
    }
    const normalized = this._normalizeShow(show);
    const archiveTime = Date.now();
    await this._withClient(async client =>{
      await this._saveArchiveRow(normalized, archiveTime, null, client);
      await client.query(`DELETE FROM ${showsTable} WHERE id = $1`, [normalized.id]);
    });
    await this._refreshArchive();
    return this.getArchivedShow(id);
  }

  async runArchiveMaintenance(){
    await this._refreshArchive();
  }

  async getStaff(){
    const pilotUsers = await this._listUsersByRole('pilot');
    const stagehands = await this._listUsersByRole('stagehand');
    if(pilotUsers.length === 0 && stagehands.length === 0){
      return {
        crew: await this._listStaffByRole('crew'),
        pilots: await this._listStaffByRole('pilot'),
        monkeyLeads: await this._listMonkeyLeads()
      };
    }
    return {
      crew: stagehands.map(user => user.displayName),
      pilots: pilotUsers.map(user => user.displayName),
      monkeyLeads: stagehands.map(user => user.displayName)
    };
  }

  async replaceStaff(staff = {}){
    void staff;
    return this.getStaff();
  }

  async listUsers(){
    const usersTable = this._table('users');
    const rows = await this._select(
      `SELECT id, email, first_name, last_name, display_name, role, created_at, updated_at, last_login FROM ${usersTable} ORDER BY lower(display_name), lower(email)`
    );
    return rows.map(row => this._mapUserRow(row));
  }

  async createUser(input = {}){
    const normalized = this._prepareUserProfile(input);
    if(typeof input.password !== 'string' || !input.password){
      const err = new Error('Password is required');
      err.status = 400;
      throw err;
    }
    const usersTable = this._table('users');
    const existing = await this._getUserRowByEmail(normalized.email);
    if(existing){
      const err = new Error('Email already registered');
      err.status = 409;
      throw err;
    }
    const now = new Date();
    const id = uuidv4();
    const hash = this._hashPassword(input.password);
    await this._run(
      `INSERT INTO ${usersTable} (id, email, first_name, last_name, display_name, role, password_hash, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [id, normalized.email, normalized.firstName, normalized.lastName, normalized.displayName, normalized.role, hash, now]
    );
    const row = await this._getUserRowById(id);
    return this._mapUserRow(row);
  }

  async updateUser(id, updates = {}){
    if(!id){
      throw new Error('User id is required');
    }
    const existing = await this._getUserRowById(id);
    if(!existing){
      return null;
    }
    const profile = this._prepareUserProfile({
      email: existing.email,
      firstName: updates.firstName !== undefined ? updates.firstName : existing.first_name,
      lastName: updates.lastName !== undefined ? updates.lastName : existing.last_name,
      role: updates.role !== undefined ? updates.role : existing.role
    });
    const usersTable = this._table('users');
    const now = new Date();
    const values = [profile.firstName, profile.lastName, profile.displayName, profile.role, now, id];
    await this._run(
      `UPDATE ${usersTable} SET first_name = $1, last_name = $2, display_name = $3, role = $4, updated_at = $5 WHERE id = $6`,
      values
    );
    if(typeof updates.password === 'string' && updates.password){
      const hash = this._hashPassword(updates.password);
      await this._run(
        `UPDATE ${usersTable} SET password_hash = $1, updated_at = $2 WHERE id = $3`,
        [hash, now, id]
      );
      await this._revokeTokensForUser(id);
    }
    const row = await this._getUserRowById(id);
    return this._mapUserRow(row);
  }

  async deleteUser(id){
    if(!id){
      return false;
    }
    const usersTable = this._table('users');
    const result = await this.pool.query(`DELETE FROM ${usersTable} WHERE id = $1`, [id]);
    return result.rowCount > 0;
  }

  async authenticateUser(email, password){
    const normalizedEmail = this._normalizeEmail(email);
    if(!normalizedEmail || typeof password !== 'string' || !password){
      return null;
    }
    const row = await this._getUserRowByEmail(normalizedEmail);
    if(!row){
      return null;
    }
    if(!this._verifyPassword(password, row.password_hash)){
      return null;
    }
    const now = new Date();
    await this._run(`UPDATE ${this._table('users')} SET last_login = $1 WHERE id = $2`, [now, row.id]);
    return this._mapUserRow({...row, last_login: now});
  }

  async createAuthToken(userId, options = {}){
    if(!userId){
      throw new Error('User id is required');
    }
    const userTokensTable = this._table('user_tokens');
    const id = uuidv4();
    const token = this._generateTokenValue();
    const now = new Date();
    const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TOKEN_TTL_MS;
    const expiresAt = ttlMs ? new Date(now.getTime() + ttlMs) : null;
    await this._run(
      `INSERT INTO ${userTokensTable} (id, user_id, token, created_at, expires_at) VALUES ($1,$2,$3,$4,$5)`,
      [id, userId, token, now, expiresAt]
    );
    return {token, expiresAt: expiresAt ? expiresAt.getTime() : null};
  }

  async getUserByToken(token){
    if(!token){
      return null;
    }
    const userTokensTable = this._table('user_tokens');
    const usersTable = this._table('users');
    const row = await this._selectOne(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.display_name, u.role, u.created_at, u.updated_at, u.last_login, t.expires_at FROM ${userTokensTable} t JOIN ${usersTable} u ON u.id = t.user_id WHERE t.token = $1`,
      [token]
    );
    if(!row){
      return null;
    }
    const expiresAt = this._getTimestamp(row.expires_at);
    if(Number.isFinite(expiresAt) && Date.now() > expiresAt){
      await this._run(`DELETE FROM ${userTokensTable} WHERE token = $1`, [token]);
      return null;
    }
    const user = this._mapUserRow(row);
    user.expiresAt = expiresAt ?? null;
    return user;
  }

  async revokeToken(token){
    if(!token){
      return false;
    }
    await this._run(`DELETE FROM ${this._table('user_tokens')} WHERE token = $1`, [token]);
    return true;
  }

  _assertRequiredShowFields(raw = {}){
    const required = [
      {key: 'date', label: 'Date'},
      {key: 'time', label: 'Show start time'},
      {key: 'label', label: 'Show label'},
      {key: 'leadPilot', label: 'Lead pilot'},
      {key: 'monkeyLead', label: 'Monkey lead'}
    ];
    required.forEach(field =>{
      const value = typeof raw[field.key] === 'string' ? raw[field.key].trim() : '';
      if(!value){
        const err = new Error(`${field.label} is required`);
        err.status = 400;
        throw err;
      }
    });
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

  async _ensureSchema(){
    const summary = {
      schemaCreated: false,
      tablesCreated: [],
      indexesCreated: []
    };
    const schemaName = this.schema || 'public';
    if(this.schema){
      const existingSchema = await this._selectOne(
        'SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1',
        [this.schema]
      );
      if(!existingSchema){
        await this._run(`CREATE SCHEMA IF NOT EXISTS ${this._formatIdentifier(this.schema)}`);
        summary.schemaCreated = true;
      }
    }

    const showsTable = this._table('shows');
    const staffTable = this._table('staff');
    const monkeyTable = this._table('monkey_leads');
    const archiveTable = this._table('show_archive');
    const usersTable = this._table('users');
    const userTokensTable = this._table('user_tokens');

    const tableDefinitions = [
      {
        name: 'shows',
        ddl: `
          CREATE TABLE IF NOT EXISTS ${showsTable} (
            id UUID PRIMARY KEY,
            data JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
          )
        `
      },
      { 
        name: 'staff',
        ddl: `
          CREATE TABLE IF NOT EXISTS ${staffTable} (
            id UUID PRIMARY KEY,
            name TEXT NOT NULL,
            role TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL
          )
        `
      },
      {
        name: 'monkey_leads',
        ddl: `
          CREATE TABLE IF NOT EXISTS ${monkeyTable} (
            id UUID PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL
          )
        `
      },
      {
        name: 'show_archive',
        ddl: `
          CREATE TABLE IF NOT EXISTS ${archiveTable} (
            id UUID PRIMARY KEY,
            data JSONB NOT NULL,
            show_date TEXT,
            created_at TIMESTAMPTZ,
            archived_at TIMESTAMPTZ NOT NULL,
            deleted_at TIMESTAMPTZ
          )
        `
      },
      {
        name: 'users',
        ddl: `
          CREATE TABLE IF NOT EXISTS ${usersTable} (
            id UUID PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            first_name TEXT,
            last_name TEXT,
            display_name TEXT NOT NULL,
            role TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            last_login TIMESTAMPTZ
          )
        `
      },
      {
        name: 'user_tokens',
        ddl: `
          CREATE TABLE IF NOT EXISTS ${userTokensTable} (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES ${usersTable}(id) ON DELETE CASCADE,
            token TEXT UNIQUE NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            expires_at TIMESTAMPTZ
          )
        `
      }
    ];

    for(const definition of tableDefinitions){
      const exists = await this._selectOne(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
        [schemaName, definition.name]
      );
      if(!exists){
        await this._run(definition.ddl);
        summary.tablesCreated.push(definition.name);
      }
    }

    const indexDefinitions = [
      {
        name: 'show_archive_archived_at_idx',
        ddl: `CREATE INDEX IF NOT EXISTS ${this._indexName('show_archive_archived_at_idx')} ON ${archiveTable} (archived_at DESC)`
      },
      {
        name: 'staff_role_name_idx',
        ddl: `CREATE INDEX IF NOT EXISTS ${this._indexName('staff_role_name_idx')} ON ${staffTable} (role, name)`
      },
      {
        name: 'users_email_lower_idx',
        ddl: `CREATE UNIQUE INDEX IF NOT EXISTS ${this._indexName('users_email_lower_idx')} ON ${usersTable} (lower(email))`
      },
      {
        name: 'users_role_name_idx',
        ddl: `CREATE INDEX IF NOT EXISTS ${this._indexName('users_role_name_idx')} ON ${usersTable} (role, lower(display_name))`
      },
      {
        name: 'user_tokens_token_idx',
        ddl: `CREATE UNIQUE INDEX IF NOT EXISTS ${this._indexName('user_tokens_token_idx')} ON ${userTokensTable} (token)`
      }
    ];

    for(const definition of indexDefinitions){
      const exists = await this._selectOne(
        `SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
        [schemaName, this._indexKey(definition.name)]
      );
      if(!exists){
        await this._run(definition.ddl);
        summary.indexesCreated.push(definition.name);
      }
    }

    return summary;
  }

  async _listStaffByRole(role){
    const rows = await this._select(`SELECT name FROM ${this._table('staff')} WHERE role = $1 ORDER BY lower(name), name`, [role]);
    return rows.map(row => row.name);
  }

  async _listMonkeyLeads(){
    const rows = await this._select(`SELECT name FROM ${this._table('monkey_leads')} ORDER BY lower(name), name`);
    return rows.map(row => row.name);
  }

  async _replaceStaffRole(role, names, client = null){
    const executor = client || this.pool;
    await executor.query(`DELETE FROM ${this._table('staff')} WHERE role = $1`, [role]);
    if(!Array.isArray(names) || names.length === 0){
      return;
    }
    const timestamp = new Date();
    for(const name of names){
      await executor.query(`INSERT INTO ${this._table('staff')} (id, name, role, created_at) VALUES ($1, $2, $3, $4)`, [uuidv4(), name, role, timestamp]);
    }
  }

  async _replaceMonkeyLeads(names, client = null){
    const executor = client || this.pool;
    await executor.query(`DELETE FROM ${this._table('monkey_leads')}`);
    if(!Array.isArray(names) || names.length === 0){
      return;
    }
    const timestamp = new Date();
    for(const name of names){
      await executor.query(`INSERT INTO ${this._table('monkey_leads')} (id, name, created_at) VALUES ($1, $2, $3)`, [uuidv4(), name, timestamp]);
    }
  }

  async _listUsersByRole(role){
    const normalizedRole = this._normalizeUserRole(role);
    const usersTable = this._table('users');
    const rows = await this._select(
      `SELECT id, email, first_name, last_name, display_name, role, created_at, updated_at, last_login FROM ${usersTable} WHERE role = $1 ORDER BY lower(display_name), lower(email)`,
      [normalizedRole]
    );
    return rows.map(row => this._mapUserRow(row));
  }

  async _persist(show, client = null){
    const normalized = this._normalizeShow(show);
    const query = `
      INSERT INTO ${this._table('shows')} (id, data, updated_at)
      VALUES ($1, $2::jsonb, $3)
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
    `;
    const params = [normalized.id, JSON.stringify(normalized), this._toDate(normalized.updatedAt)];
    if(client){
      await client.query(query, params);
    }else{
      await this.pool.query(query, params);
    }
    return normalized;
  }

  async _refreshArchive(){
    if(!this.pool){
      return;
    }
    await this._archiveDailyShows();
    await this._purgeExpiredArchives();
  }

  async _archiveDailyShows(){
    const showsTable = this._table('shows');
    const rows = await this._select(`SELECT id, data FROM ${showsTable}`);
    if(!rows.length){
      return false;
    }
    const groups = new Map();
    rows.forEach(row => {
      const show = this._parseRowData(row.data);
      if(!show || typeof show !== 'object'){
        return;
      }
      const key = typeof show.date === 'string' && show.date.trim() ? show.date.trim() : '__undated__';
      const createdAt = this._getTimestamp(show.createdAt) ?? this._getTimestamp(show.updatedAt);
      if(!groups.has(key)){
        groups.set(key, []);
      }
      groups.get(key).push({show, createdAt});
    });
    const now = Date.now();
    const showsToArchive = [];
    for(const [, list] of groups.entries()){
      const earliest = list.reduce((min, item)=>{
        const value = this._getTimestamp(item.createdAt);
        if(value === null){
          return min;
        }
        if(min === null || value < min){
          return value;
        }
        return min;
      }, null);
      if(earliest === null){
        continue;
      }
      if(now - earliest >= DAY_IN_MS){
        list.forEach(item => showsToArchive.push(item.show));
      }
    }
    if(!showsToArchive.length){
      return false;
    }
    await this._withClient(async client =>{
      for(const show of showsToArchive){
        const normalized = this._normalizeShow(show);
        const archiveTime = Date.now();
        await this._saveArchiveRow(normalized, archiveTime, null, client);
        await client.query(`DELETE FROM ${showsTable} WHERE id = $1`, [normalized.id]);
      }
    });
    return true;
  }

  async _purgeExpiredArchives(){
    const archiveTable = this._table('show_archive');
    const rows = await this._select(`SELECT id, data, created_at FROM ${archiveTable}`);
    if(!rows.length){
      return false;
    }
    const now = Date.now();
    const expiredIds = [];
    rows.forEach(row =>{
      const show = this._parseRowData(row.data);
      const createdAt = this._getTimestamp(show?.createdAt) ?? this._getTimestamp(row.created_at);
      if(createdAt === null){
        return;
      }
      if(this._isArchiveExpired(createdAt, now)){
        expiredIds.push(row.id);
      }
    });
    if(!expiredIds.length){
      return false;
    }
    await this._run(`DELETE FROM ${archiveTable} WHERE id = ANY($1::uuid[])`, [expiredIds]);
    return true;
  }

  async _saveArchiveRow(show, archivedAt, deletedAt, client = null){
    const archiveTimestamp = this._getTimestamp(archivedAt) ?? Date.now();
    const createdTimestamp = this._getTimestamp(show.createdAt);
    const deletedTimestamp = this._getTimestamp(deletedAt ?? show.deletedAt);
    show.archivedAt = archiveTimestamp;
    if(createdTimestamp !== null){
      show.createdAt = createdTimestamp;
    }
    if(deletedTimestamp !== null){
      show.deletedAt = deletedTimestamp;
    }else{
      delete show.deletedAt;
    }
    const query = `
      INSERT INTO ${this._table('show_archive')} (id, data, show_date, created_at, archived_at, deleted_at)
      VALUES ($1, $2::jsonb, $3, $4, $5, $6)
      ON CONFLICT(id) DO UPDATE SET data = EXCLUDED.data, show_date = EXCLUDED.show_date, created_at = EXCLUDED.created_at, archived_at = EXCLUDED.archived_at, deleted_at = EXCLUDED.deleted_at
    `;
    const params = [
      show.id,
      JSON.stringify(show),
      typeof show.date === 'string' && show.date.trim() ? show.date.trim() : null,
      this._toDate(createdTimestamp),
      this._toDate(archiveTimestamp),
      this._toDate(deletedTimestamp)
    ];
    if(client){
      await client.query(query, params);
    }else{
      await this.pool.query(query, params);
    }
  }

  _mapArchiveRow(row){
    if(!row){
      return null;
    }
    const show = this._parseRowData(row.data);
    if(!show || typeof show !== 'object'){
      return null;
    }
    const archivedAt = this._getTimestamp(row.archived_at) ?? this._getTimestamp(show.archivedAt);
    const createdAt = this._getTimestamp(row.created_at) ?? this._getTimestamp(show.createdAt);
    const deletedAt = this._getTimestamp(row.deleted_at) ?? this._getTimestamp(show.deletedAt);
    if(archivedAt !== null){
      show.archivedAt = archivedAt;
    }
    if(createdAt !== null){
      show.createdAt = createdAt;
    }
    if(deletedAt !== null){
      show.deletedAt = deletedAt;
    }else{
      delete show.deletedAt;
    }
    if(!Array.isArray(show.entries)){
      show.entries = [];
    }
    if(!Array.isArray(show.crew)){
      show.crew = [];
    }
    return show;
  }

  _normalizeNameList(list, options = {}){
    if(!Array.isArray(list)){
      return [];
    }
    const trimmed = list
      .map(item => typeof item === 'string' ? item.trim() : '')
      .filter(Boolean);
    if(options.sort){
      trimmed.sort((a, b) => a.localeCompare(b));
    }
    return Array.from(new Set(trimmed));
  }

  _parseRowData(value){
    if(value === null || value === undefined){
      return null;
    }
    if(typeof value === 'object'){
      return value;
    }
    try{
      return JSON.parse(value);
    }catch(err){
      return null;
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
    if(value instanceof Date){
      const time = value.getTime();
      return Number.isFinite(time) ? time : null;
    }
    if(typeof value === 'string'){
      const parsed = Date.parse(value);
      if(Number.isFinite(parsed)){
        return parsed;
      }
    }
    return null;
  }

  _toDate(value){
    const ts = this._getTimestamp(value);
    return ts === null ? null : new Date(ts);
  }

  _isArchiveExpired(createdAt, now = Date.now()){
    if(!Number.isFinite(createdAt)){
      return false;
    }
    const expiry = this._addMonths(createdAt, ARCHIVE_RETENTION_MONTHS);
    return now >= expiry;
  }

  _addMonths(timestamp, months){
    if(!Number.isFinite(timestamp)){
      return timestamp;
    }
    const date = new Date(timestamp);
    if(Number.isNaN(date.getTime())){
      return timestamp;
    }
    date.setMonth(date.getMonth() + months);
    return date.getTime();
  }

  async _select(query, params = []){
    const result = await this.pool.query(query, params);
    return result.rows;
  }

  async _selectOne(query, params = []){
    const rows = await this._select(query, params);
    return rows.length ? rows[0] : null;
  }

  async _run(query, params = []){
    await this.pool.query(query, params);
  }

  async _getUserRowByEmail(email){
    const normalized = this._normalizeEmail(email);
    if(!normalized){
      return null;
    }
    const usersTable = this._table('users');
    return this._selectOne(
      `SELECT id, email, first_name, last_name, display_name, role, password_hash, created_at, updated_at, last_login FROM ${usersTable} WHERE lower(email) = lower($1)` ,
      [normalized]
    );
  }

  async _getUserRowById(id){
    if(!id){
      return null;
    }
    const usersTable = this._table('users');
    return this._selectOne(
      `SELECT id, email, first_name, last_name, display_name, role, password_hash, created_at, updated_at, last_login FROM ${usersTable} WHERE id = $1` ,
      [id]
    );
  }

  _prepareUserProfile(input = {}){
    const email = this._normalizeEmail(input.email);
    if(!email){
      const err = new Error('Email is required');
      err.status = 400;
      throw err;
    }
    this._assertSphereEmail(email);
    const role = this._normalizeUserRole(input.role);
    const names = this._resolveUserNames({
      email,
      firstName: input.firstName,
      lastName: input.lastName
    });
    return {
      email,
      role,
      ...names
    };
  }

  _resolveUserNames({email, firstName, lastName} = {}){
    const fallback = this._inferNamesFromEmail(email);
    const normalizedFirst = this._normalizeNamePart(firstName) || fallback.firstName;
    const normalizedLast = this._normalizeNamePart(lastName) || fallback.lastName;
    return {
      firstName: normalizedFirst,
      lastName: normalizedLast,
      displayName: this._buildDisplayName(normalizedFirst, normalizedLast, email)
    };
  }

  _normalizeEmail(value){
    if(typeof value !== 'string'){
      return '';
    }
    const trimmed = value.trim();
    return trimmed ? trimmed.toLowerCase() : '';
  }

  _normalizeNamePart(value){
    if(typeof value !== 'string'){
      return '';
    }
    const trimmed = value.trim();
    if(!trimmed){
      return '';
    }
    return trimmed
      .split(/\s+/)
      .map(segment => segment
        .split('-')
        .map(piece => piece ? piece.charAt(0).toUpperCase() + piece.slice(1).toLowerCase() : '')
        .join('-'))
      .join(' ');
  }

  _inferNamesFromEmail(email){
    if(typeof email !== 'string'){
      return {firstName: '', lastName: ''};
    }
    const localPart = email.split('@')[0] || '';
    const segments = localPart.split('.').filter(Boolean);
    if(segments.length === 0){
      return {firstName: '', lastName: ''};
    }
    const firstName = this._normalizeNamePart(segments[0]);
    const lastName = this._normalizeNamePart(segments.slice(1).join(' '));
    return {firstName, lastName};
  }

  _buildDisplayName(firstName, lastName, email){
    const parts = [];
    if(firstName){ parts.push(firstName); }
    if(lastName){ parts.push(lastName); }
    if(parts.length){
      return parts.join(' ');
    }
    return email;
  }

  _normalizeUserRole(role){
    const value = typeof role === 'string' ? role.trim().toLowerCase() : '';
    return value === 'pilot' ? 'pilot' : 'stagehand';
  }

  _assertSphereEmail(email){
    if(typeof email !== 'string' || !email.toLowerCase().endsWith('@thesphere.com')){
      const err = new Error('Email must use thesphere.com domain');
      err.status = 400;
      throw err;
    }
  }

  _mapUserRow(row){
    if(!row){
      return null;
    }
    const createdAt = this._getTimestamp(row.created_at);
    const updatedAt = this._getTimestamp(row.updated_at);
    const lastLogin = this._getTimestamp(row.last_login);
    return {
      id: row.id,
      email: row.email,
      firstName: row.first_name || '',
      lastName: row.last_name || '',
      displayName: row.display_name || row.email,
      role: row.role || 'stagehand',
      createdAt,
      updatedAt,
      lastLogin
    };
  }

  _hashPassword(password){
    if(typeof password !== 'string' || !password){
      const err = new Error('Password is required');
      err.status = 400;
      throw err;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, PASSWORD_KEY_LENGTH, PASSWORD_DIGEST);
    return `${PASSWORD_ITERATIONS}:${salt}:${derived.toString('hex')}`;
  }

  _verifyPassword(password, stored){
    if(typeof password !== 'string' || !password || typeof stored !== 'string' || !stored){
      return false;
    }
    const parts = stored.split(':');
    if(parts.length !== 3){
      return false;
    }
    const iterations = Number.parseInt(parts[0], 10);
    const salt = parts[1];
    const hashHex = parts[2];
    if(!salt || !hashHex){
      return false;
    }
    const keyBuffer = Buffer.from(hashHex, 'hex');
    if(!keyBuffer.length){
      return false;
    }
    const derived = crypto.pbkdf2Sync(
      password,
      salt,
      Number.isFinite(iterations) && iterations > 0 ? iterations : PASSWORD_ITERATIONS,
      keyBuffer.length,
      PASSWORD_DIGEST
    );
    return crypto.timingSafeEqual(keyBuffer, derived);
  }

  _generateTokenValue(){
    return crypto.randomBytes(32).toString('hex');
  }

  async _revokeTokensForUser(userId){
    if(!userId){
      return;
    }
    await this._run(`DELETE FROM ${this._table('user_tokens')} WHERE user_id = $1`, [userId]);
  }

  async _seedDefaultUsers(){
    let mutated = false;
    for(const user of DEFAULT_USERS){
      try{
        const normalizedEmail = this._normalizeEmail(user.email);
        if(!normalizedEmail){
          continue;
        }
        const existing = await this._getUserRowByEmail(normalizedEmail);
        if(existing){
          continue;
        }
        await this.createUser({
          email: normalizedEmail,
          role: user.role,
          password: user.password
        });
        mutated = true;
      }catch(err){
        console.warn('[storage] Failed to seed default user', user.email, err.message);
      }
    }
    return mutated;
  }

  async _withClient(handler, {transaction = true} = {}){
    const client = await this.pool.connect();
    try{
      if(transaction){
        await client.query('BEGIN');
      }
      const result = await handler(client);
      if(transaction){
        await client.query('COMMIT');
      }
      return result;
    }catch(err){
      if(transaction){
        try{
          await client.query('ROLLBACK');
        }catch(rollbackErr){
          console.error('Failed to rollback transaction', rollbackErr);
        }
      }
      throw err;
    }finally{
      client.release();
    }
  }

  _createPool(config){
    return new Pool(config);
  }

  _buildPoolConfig(){
    const cfg = this.config || {};
    const poolConfig = {...(cfg.pool || {})};
    const envConnectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PGURL;
    if(cfg.connectionString){
      poolConfig.connectionString = cfg.connectionString;
    }else if(envConnectionString){
      poolConfig.connectionString = envConnectionString;
    }
    const envHost = process.env.PGHOST || process.env.POSTGRES_HOST;
    const envPort = Number.parseInt(process.env.PGPORT || process.env.POSTGRES_PORT, 10);
    const envDatabase = process.env.PGDATABASE || process.env.POSTGRES_DB;
    const envUser = process.env.PGUSER || process.env.POSTGRES_USER;
    const envPassword = process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD;
    ['host','port','database','user','password'].forEach(key =>{
      if(cfg[key] !== undefined && cfg[key] !== null && cfg[key] !== ''){
        poolConfig[key] = cfg[key];
      }
    });
    if(!poolConfig.host && envHost){
      poolConfig.host = envHost;
    }
    if(!poolConfig.port && Number.isFinite(envPort)){
      poolConfig.port = envPort;
    }
    if(!poolConfig.database && envDatabase){
      poolConfig.database = envDatabase;
    }
    if(!poolConfig.user && envUser){
      poolConfig.user = envUser;
    }
    if(!poolConfig.password && envPassword){
      poolConfig.password = envPassword;
    }
    const envSslMode = (process.env.PGSSLMODE || process.env.POSTGRES_SSLMODE || '').toLowerCase();
    if(cfg.ssl){
      if(typeof cfg.ssl === 'object'){
        poolConfig.ssl = cfg.ssl;
      }else if(cfg.ssl === true){
        poolConfig.ssl = {rejectUnauthorized: false};
      }
    }else if(envSslMode){
      if(envSslMode === 'disable'){
        poolConfig.ssl = false;
      }else if(['require','prefer'].includes(envSslMode)){
        poolConfig.ssl = {rejectUnauthorized: false};
      }
    }
    if(Number.isFinite(cfg.max)){
      poolConfig.max = cfg.max;
    }
    if(Number.isFinite(cfg.idleTimeoutMillis)){
      poolConfig.idleTimeoutMillis = cfg.idleTimeoutMillis;
    }
    if(Number.isFinite(cfg.connectionTimeoutMillis)){
      poolConfig.connectionTimeoutMillis = cfg.connectionTimeoutMillis;
    }
    if(Number.isFinite(cfg.statement_timeout)){
      poolConfig.statement_timeout = cfg.statement_timeout;
    }
    if(!poolConfig.connectionString && !poolConfig.host){
      poolConfig.host = '127.0.0.1';
      poolConfig.port = 5432;
      poolConfig.database = 'monkey_tracker';
      poolConfig.user = 'postgres';
      poolConfig.password = cfg.password || 'postgres';
    }
    return poolConfig;
  }

  async _ensureDatabaseExists(poolConfig){
    const result = {databaseCreated: false};
    const databaseName = this._getDatabaseNameFromConfig(poolConfig);
    if(!databaseName){
      return result;
    }
    let probePool = null;
    try{
      probePool = this._createPool(poolConfig);
      await probePool.query('SELECT 1');
    }catch(err){
      if(err?.code !== '3D000'){
        throw err;
      }
      result.databaseCreated = await this._createDatabaseIfMissing(poolConfig, databaseName);
    }finally{
      if(probePool){
        try{
          await probePool.end();
        }catch(poolErr){
          console.error('Failed to dispose probe pool', poolErr);
        }
      }
    }
    return result;
  }

  async _createDatabaseIfMissing(poolConfig, databaseName){
    const adminConfig = this._buildAdminPoolConfig(poolConfig);
    let adminPool = null;
    try{
      adminPool = this._createPool(adminConfig);
      await adminPool.query(`CREATE DATABASE ${this._quoteIdentifier(databaseName)}`);
      return true;
    }catch(err){
      if(err?.code === '42P04'){
        return false;
      }
      throw err;
    }finally{
      if(adminPool){
        try{
          await adminPool.end();
        }catch(poolErr){
          console.error('Failed to dispose admin pool', poolErr);
        }
      }
    }
    return false;
  }

  _buildAdminPoolConfig(poolConfig){
    const adminDatabase = this.config?.adminDatabase
      || process.env.PGADMIN_DB
      || process.env.PGDEFAULT_DB
      || 'postgres';
    if(poolConfig.connectionString){
      try{
        const url = new URL(poolConfig.connectionString);
        url.pathname = `/${encodeURIComponent(adminDatabase)}`;
        const adminConfig = {...poolConfig, connectionString: url.toString()};
        if(poolConfig.ssl !== undefined){
          adminConfig.ssl = poolConfig.ssl;
        }
        return adminConfig;
      }catch(err){
        console.error('Failed to parse connection string for admin pool', err);
      }
    }
    return {
      ...poolConfig,
      database: adminDatabase
    };
  }

  _getDatabaseNameFromConfig(poolConfig){
    if(poolConfig.database){
      return poolConfig.database;
    }
    if(poolConfig.connectionString){
      try{
        const url = new URL(poolConfig.connectionString);
        const pathname = url.pathname || '';
        const dbName = decodeURIComponent(pathname.replace(/^\//, ''));
        return dbName || null;
      }catch(err){
        console.error('Failed to parse connection string for database name', err);
      }
    }
    return null;
  }

  _sanitizeIdentifier(value){
    if(typeof value !== 'string'){
      return null;
    }
    const trimmed = value.trim();
    if(!trimmed){
      return null;
    }
    if(!IDENTIFIER_REGEX.test(trimmed)){
      throw new Error(`Invalid identifier: ${trimmed}`);
    }
    return trimmed;
  }

  _formatIdentifier(identifier){
    if(!IDENTIFIER_REGEX.test(identifier)){
      throw new Error(`Invalid identifier: ${identifier}`);
    }
    return `"${identifier}"`;
  }

  _quoteIdentifier(identifier){
    if(typeof identifier !== 'string' || !identifier){
      throw new Error(`Invalid identifier: ${identifier}`);
    }
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  _table(name){
    if(!IDENTIFIER_REGEX.test(name)){
      throw new Error(`Invalid table name: ${name}`);
    }
    if(this.schema){
      return `${this._formatIdentifier(this.schema)}.${this._formatIdentifier(name)}`;
    }
    return this._formatIdentifier(name);
  }

  _indexKey(name){
    if(!IDENTIFIER_REGEX.test(name)){
      throw new Error(`Invalid index key: ${name}`);
    }
    const schemaPrefix = (this.schema || 'public').toLowerCase();
    const base = `${schemaPrefix}_${name.toLowerCase()}`;
    if(!IDENTIFIER_REGEX.test(base)){
      throw new Error(`Invalid index name: ${base}`);
    }
    return base;
  }

  _indexName(name){
    return this._formatIdentifier(this._indexKey(name));
  }

  _logConnectionEstablished(){
    try{
      const meta = this.getStorageMetadata();
      const host = meta.host || 'localhost';
      const port = meta.port || 5432;
      const database = meta.database || '(unknown)';
      const schema = meta.schema || (this.schema || 'public');
      console.info(`[storage] PostgreSQL connection pool ready for ${database}@${host}:${port} (schema ${schema})`);
    }catch(err){
      console.info('[storage] PostgreSQL connection pool ready');
    }
  }

  _logBootstrapSummary({databaseCreated = false, schemaCreated = false, tablesCreated = [], indexesCreated = [], seededDefaults = false} = {}){
    const actions = [];
    let meta = null;
    try{
      meta = this.getStorageMetadata();
    }catch(err){
      meta = null;
    }
    const databaseLabel = meta?.database || '(unknown)';
    const schemaLabel = meta?.schema || (this.schema || 'public');
    if(databaseCreated){
      actions.push(`database "${databaseLabel}"`);
    }
    if(schemaCreated){
      actions.push(`schema "${schemaLabel}"`);
    }
    if(tablesCreated.length){
      actions.push(`tables [${tablesCreated.join(', ')}]`);
    }
    if(indexesCreated.length){
      actions.push(`indexes [${indexesCreated.join(', ')}]`);
    }
    if(actions.length){
      const context = meta ? {
        database: meta.database,
        schema: meta.schema,
        host: meta.host,
        port: meta.port
      } : {};
      console.info(`[storage] PostgreSQL bootstrap automation created ${actions.join(', ')}`, context);
    }
    if(seededDefaults){
      console.info('[storage] PostgreSQL default user directory seeded');
    }
  }
}

module.exports = PostgresProvider;
