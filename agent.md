# Migration Playbook: sql.js to PostgreSQL

## Purpose
This document is an operations manual for agents implementing the database migration from the existing `sql.js` (file-backed SQLite) storage to a production-ready PostgreSQL deployment while preserving every workflow surfaced by the Monkey Tracker web UI and REST API.

Follow these instructions whenever you touch persistence-related code inside this repository.

---

## 1. Current Storage Model (Baseline)
The current server persists a single-file SQLite database through `sql.js` (`server/storage/sqlProvider.js`). Shows and staff records are serialized as JSON strings and stored in wide tables. Key behaviors include:

- **Tables**
  - `shows(id TEXT PK, data TEXT, updated_at TEXT)` → holds JSON blobs for the entire show payload, including entries array.
  - `show_archive(id TEXT PK, data TEXT, show_date TEXT, created_at TEXT, archived_at TEXT, deleted_at TEXT)` → frozen snapshots for deleted or manually archived shows. Retention policy trims records older than two months (`ARCHIVE_RETENTION_MONTHS`).
  - `staff(id TEXT PK, name TEXT, role TEXT, created_at TEXT)` → crew and pilot rosters.
  - `monkey_leads(id TEXT PK, name TEXT, created_at TEXT)` → specialized staff list.
- **Record Shapes**
  - **Show** (`_normalizeShow`): `{id, date, time, label, crew[], leadPilot, monkeyLead, notes, entries[], createdAt, updatedAt}`.
  - **Entry** (`_normalizeEntry`): `{id, ts, unitId, planned, launched, status, primaryIssue, subIssue, otherDetail, severity, rootCause, actions[], operator, batteryId, delaySec|null, commandRx, notes}`.
  - **Staff payload** (`getStaff`): `{crew[], pilots[], monkeyLeads[]}`.
- **Business Rules**
  - Max five active shows per calendar day (`_enforceShowLimit`).
  - Pilot uniqueness per show entry (`_assertPilotUnique`).
  - Default seed lists for crew/pilots/monkey leads inserted when tables are empty (`_seedDefaultStaff`).
  - Archiving refresh triggered on every CRUD call to maintain retention and statistics caches (`_refreshArchive`).

---

## 2. Runtime Interactions to Preserve
### REST API Surface (`server/index.js`)
1. `GET /api/health` → returns storage label (`sql.js v2`) and webhook status for monitoring.
2. `GET|PUT /api/config` → updates persisted config (`server/configStore.js`) and reinitializes storage provider.
3. Staff endpoints:
   - `GET /api/staff` → aggregated staff lists.
   - `PUT /api/staff` → bulk replace staff roster.
4. Show endpoints:
   - `GET /api/shows` → returns `{storage, webhook, shows[]}` (active shows sorted by `updated_at DESC`).
   - `POST /api/shows` → validate & create show; returns 201.
   - `GET /api/shows/:id`, `PUT /api/shows/:id`, `DELETE /api/shows/:id` → fetch/update/delete single show. Deletion archives the show snapshot.
   - `POST /api/shows/:id/archive` → manual archive.
5. Entry endpoints:
   - `POST /api/shows/:id/entries` → create entry, dispatch webhook `entry.created`.
   - `PUT /api/shows/:id/entries/:entryId` → update entry, dispatch webhook `entry.updated`.
   - `DELETE /api/shows/:id/entries/:entryId` → remove entry.
6. Archive dashboards:
   - `GET /api/shows/archive` → returns `shows[]` (archived snapshots).

### Front-End Expectations (`public/app.js`)
- Startup flow: load config (`/api/config`), staff lists (`/api/staff`), and shows (`/api/shows`). State stores `storageLabel: 'SQL.js storage v2'` and the dashboard metrics defined in `ARCHIVE_METRIC_DEFS` (e.g., `entriesCount`, `completionRate`, `avgDelaySec`).
- UI states: landing view, active show management, archive analytics (calendar/daily grouping), webhook configuration modal. All rely on the API payload shapes above.
- Export & metrics rely on entry-level data fidelity: ensure Postgres schema continues to provide `delaySec`, `actions[]`, and textual fields without truncation.

Simulate user journeys when regression-testing the migration:
1. **Daily Operations**: create a show, add/update/delete entries, enforce pilot uniqueness, confirm webhook calls fire on entry mutations, delete show and verify archive view populates.
2. **Archive Analytics**: browse `/api/shows/archive`, compute metrics (counts, rates, min/max), filter by date range. Confirm retention pruning keeps only last ~60 days.
3. **Roster Maintenance**: replace crew/pilots/monkey leads, reload UI, confirm sorted, deduplicated names.
4. **Configuration Update**: modify webhook or host via `/api/config`; ensure provider reinitialization uses Postgres connection pool.

---

## 3. Target PostgreSQL Design
### Recommended Schema (Normalized but JSONB-friendly)
- `shows`
  - Columns: `id UUID PRIMARY KEY`, `date DATE`, `time TEXT`, `label TEXT`, `crew TEXT[]`, `lead_pilot TEXT`, `monkey_lead TEXT`, `notes TEXT`, `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ`.
  - Keep `crew` array and `notes` free-form. Maintain `CHECK (cardinality(crew) <= 10)` if needed.
- `show_entries`
  - Columns: `id UUID PRIMARY KEY`, `show_id UUID REFERENCES shows(id) ON DELETE CASCADE`, `ts TIMESTAMPTZ`, `unit_id TEXT`, `planned TEXT`, `launched TEXT`, `status TEXT`, `primary_issue TEXT`, `sub_issue TEXT`, `other_detail TEXT`, `severity TEXT`, `root_cause TEXT`, `actions TEXT[]`, `operator TEXT`, `battery_id TEXT`, `delay_sec NUMERIC`, `command_rx TEXT`, `notes TEXT`.
  - Unique index enforcing single entry per operator: `UNIQUE(show_id, lower(operator)) WHERE operator IS NOT NULL AND operator <> ''`.
- `show_archive`
  - Preserve JSON payload as `JSONB` for immutable snapshots: `id UUID PRIMARY KEY`, `data JSONB NOT NULL`, `show_date DATE`, `created_at TIMESTAMPTZ`, `archived_at TIMESTAMPTZ NOT NULL`, `deleted_at TIMESTAMPTZ`.
  - Index on `(archived_at DESC)` for fast retention pruning.
- `staff`
  - `id UUID PRIMARY KEY`, `name TEXT NOT NULL`, `role TEXT NOT NULL CHECK (role IN ('pilot','crew'))`, `created_at TIMESTAMPTZ NOT NULL`.
- `monkey_leads`
  - `id UUID PRIMARY KEY`, `name TEXT NOT NULL`, `created_at TIMESTAMPTZ NOT NULL`.

Consider storing derived metadata (counts, statuses) via views/materialized views if performance requires.

### Data Type Mapping Notes
- `TEXT` columns map 1:1. Use `TIMESTAMPTZ` for ISO timestamps currently stored as strings.
- `delaySec` currently `null|number`; use `NUMERIC` or `INTEGER` with `NULL` semantics.
- JSON payloads can move to normalized columns; however, keep JSONB copy for quick replay or maintain computed API parity by reconstructing JSON objects server-side.

---

## 4. Migration Strategy & Tooling
1. **Schema Diffing**
   - Use tools like `pgModeler`, `Atlas`, or `dbmate` for repeatable migrations. Define migration scripts under a new `migrations/` directory (SQL files) and hook into deployment pipeline.
   - For ad-hoc validation, `pg_dump --schema-only` versus generated SQL ensures reproducibility.
2. **Data Transfer**
   - Extract sqlite file via `sql.js` export (already available) → convert to standard SQLite `.db` file. Use `sqlite3` CLI or `pgloader` to load into Postgres (supports JSON/text columns). Alternatively, write a Node.js script that iterates through provider methods and inserts via `pg` client.
3. **Verification**
   - After migration, run diff scripts comparing counts (`SELECT COUNT(*)`) and hashed payloads (e.g., `md5(data::text)`) between SQLite export and Postgres tables.
   - Replay API regression suite (unit or integration tests) to confirm identical responses. Add contract tests capturing sample payloads.
4. **Performance Instrumentation**
   - Log query timings via `pg` client events or Postgres `log_min_duration_statement` to detect slow queries while replicating UI flows.
   - Monitor connection pool usage; set pool size relative to expected concurrency (UI is light but webhook dispatch may overlap).
5. **Rollback Plan**
   - Retain a read-only copy of the sqlite file for fallback. Provide script to re-import from Postgres to sqlite in emergencies.

---

## 5. Implementation Checklist
- [ ] Introduce a PostgreSQL provider module (e.g., `server/storage/postgresProvider.js`) implementing the same async API as `SqlProvider` (`init`, CRUD methods, `runArchiveMaintenance`, etc.).
- [ ] Update `server/storage/index.js` to select provider based on configuration flag/environment variable to support phased rollout.
- [ ] Mirror validations in Postgres layer (show limit, pilot uniqueness, seeding defaults) at both application and database levels.
- [ ] Replace `storage` labels in API responses and UI state when Postgres is active (e.g., `storage: 'PostgreSQL v1'`). Ensure UI gracefully handles either string.
- [ ] Reimplement `_refreshArchive` logic using SQL queries (e.g., `DELETE FROM show_archive WHERE archived_at < NOW() - INTERVAL '2 months'`).
- [ ] Ensure transactional safety: wrap multi-step mutations (`createShow`, `deleteShow`, `addEntry`) in Postgres transactions to keep JSON responses consistent.
- [ ] Recreate archive statistics queries directly in SQL for efficiency (e.g., aggregate entries per show).
- [ ] Instrument health check to verify Postgres connectivity (ping `SELECT 1`).
- [ ] Update deployment/config documentation to include `DATABASE_URL`, migration commands, and required extensions (consider `uuid-ossp` or rely on application UUIDs).

---

## 6. Testing & Metrics
- Automate end-to-end UI simulations using Playwright or Cypress against a seeded Postgres instance. Scenarios must cover all API interactions enumerated in Section 2.
- Implement Jest (or Vitest) integration tests hitting an ephemeral Postgres container (via `docker-compose`) to validate provider behavior, including edge cases (max shows per day, duplicate pilots, archive pruning).
- Record baseline metrics pre-migration:
  - Average response time for `GET /api/shows` with 50 shows and 300 entries.
  - Time to archive 100 shows.
  - Connection pool saturation under 20 concurrent entry creations.
- Re-run after migration to ensure deltas remain within ±10%.

---

## 7. Reference Commands & Resources
- Launch local Postgres: `docker run --name monkey-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16`.
- Apply migrations: `npm run migrate:up` (define this script when adding migration tooling).
- Generate ERD: use `dbdocs` or `SchemaSpy` to visualize table relationships; store diagrams in `docs/`.
- Helpful packages: `pg`, `pg-pool`, `slonik` (typed query builder), `zod` (runtime validation), `drizzle-orm` (lightweight schema DSL).

Keep this document updated whenever new persistence features are introduced.
