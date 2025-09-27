# PostgreSQL Storage Operations Guide

## Purpose
This document captures the authoritative storage behavior for Monkey Tracker now that the legacy `sql.js` provider has been fully retired. Every persistence feature is backed by PostgreSQL and this guide records the contracts, logging expectations, and extension points that must be preserved whenever agents touch the data layer.

Follow these instructions whenever you modify storage-related code inside this repository.

---

## 1. Current Storage Model (Baseline)
The server persists show data with `server/storage/postgresProvider.js`. All domain objects are serialized as JSON and stored in PostgreSQL tables. Key behaviors include:

- **Tables**
  - `shows(id UUID PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL)` → holds the full show payload (entries embedded in the JSON).
  - `show_archive(id UUID PRIMARY KEY, data JSONB NOT NULL, show_date TEXT, created_at TIMESTAMPTZ, archived_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ)` → immutable snapshots used for retention analytics.
  - `staff(id UUID PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL)` → combined pilot/crew roster.
  - `monkey_leads(id UUID PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL)` → dedicated monkey lead roster.
- **Record Shapes**
  - **Show**: `{id, date, time, label, crew[], leadPilot, monkeyLead, notes, entries[], createdAt, updatedAt}`.
  - **Entry**: `{id, ts, unitId, planned, launched, status, primaryIssue, subIssue, otherDetail, severity, rootCause, actions[], operator, batteryId, delaySec|null, commandRx, notes}`.
  - **Staff payload**: `{crew[], pilots[], monkeyLeads[]}` sorted alphabetically with duplicates removed.
- **Business Rules**
  - Maximum five active shows per calendar day (`_enforceShowLimit`).
  - Pilot uniqueness per show (`_assertPilotUnique`).
  - Default staff rosters seeded automatically (`_seedDefaultStaff`).
  - Archive refresh invoked on every CRUD action (`_refreshArchive`) to prune snapshots older than two months.

---

## 2. Runtime Interactions to Preserve
### REST API Surface (`server/index.js`)
1. `GET /api/health` → returns storage metadata (label defaults to `PostgreSQL v1`) and webhook status.
2. `GET|PUT /api/config` → persists configuration via `server/configStore.js` and reinitializes the storage provider.
3. Staff endpoints:
   - `GET /api/staff` → aggregated roster.
   - `PUT /api/staff` → replaces roster (sorted, deduped).
4. Show endpoints:
   - `GET /api/shows` → `{storage, storageMeta, webhook, shows[]}` sorted by `updated_at DESC`.
   - `POST /api/shows` → validate & create show; returns 201.
   - `GET /api/shows/:id`, `PUT /api/shows/:id`, `DELETE /api/shows/:id` → fetch/update/delete a show. Deletion archives the snapshot.
   - `POST /api/shows/:id/archive` → manual archive action.
5. Entry endpoints:
   - `POST /api/shows/:id/entries` → create entry + dispatch `entry.created` webhook.
   - `PUT /api/shows/:id/entries/:entryId` → update entry + dispatch `entry.updated` webhook.
   - `DELETE /api/shows/:id/entries/:entryId` → remove entry.
6. Archive dashboards:
   - `GET /api/shows/archive` → returns archived show snapshots.

### Front-End Expectations (`public/app.js`)
- Startup flow: load `/api/config`, `/api/staff`, and `/api/shows`. State initializes with `storageLabel: 'PostgreSQL storage v1'` and metrics defined in `ARCHIVE_METRIC_DEFS`.
- UI states: landing, live show management, archive analytics (calendar/daily grouping), webhook configuration modal.
- Metrics & exports rely on the embedded entry objects; ensure JSON payloads remain lossless (especially `delaySec`, `actions`, notes fields).

Regression tests should continue to cover:
1. **Daily Operations** – show creation, entry CRUD, pilot uniqueness enforcement, webhook delivery, delete + archive verification.
2. **Archive Analytics** – `/api/shows/archive` payload shape, retention pruning (≈60 days), derived metrics.
3. **Roster Maintenance** – staff replacement, alphabetic ordering, deduplication.
4. **Configuration Updates** – `/api/config` mutation triggers provider reinitialization without dropping in-memory references.

---

## 3. Storage Schema & Behaviors
- **Bootstrap** – `init()` automatically creates the database (when permissions allow), schema, tables, and indexes. Successful actions are logged with `[storage] PostgreSQL ...` messages, along with default roster seeding notices.
- **Connection Pooling** – a single `pg.Pool` instance powers all queries. `init()` disposes previous pools before reconnecting. The connection handshake is validated with `SELECT 1` and logs `PostgreSQL connection pool ready...` with host/database context.
- **JSON persistence** – shows are stored as full JSON blobs to maintain API parity with the previous client expectations. Archive snapshots keep JSON history for analytics replay.
- **Archive maintenance** – `_archiveDailyShows` moves shows older than 24 hours into the archive table; `_purgeExpiredArchives` deletes snapshots older than the retention window.
- **Staff seeding** – defaults for pilots, crew, and monkey leads are inserted whenever the related tables are empty. Seeding emits a log so operators know when bootstrapping occurs.

---

## 4. Operational Checklist
Use this checklist whenever touching the storage layer:
1. **Confirm logging** – retain the connection success log and bootstrap summary logs added by `_logConnectionEstablished` and `_logBootstrapSummary`.
2. **Respect transactions** – multi-step mutations (`createShow`, `deleteShow`, `addEntry`, `archiveShowNow`) must remain transactional via `_withClient` to avoid partial JSON updates.
3. **Guardrails** – keep validations (`_assertRequiredShowFields`, `_assertPilotUnique`, `_enforceShowLimit`) aligned with front-end rules.
4. **Schema changes** – when new columns/structures are required, update `_ensureSchema()` to provision them and include them in the bootstrap log summary.
5. **Configuration** – the only supported provider is PostgreSQL. `server/configStore.js` merges config sources and ignores legacy SQL.js keys; do not reintroduce sqlite toggles.

---

## 5. Testing & Observability
- Provide automated coverage (unit/integration) using a disposable PostgreSQL instance for CRUD paths, archive pruning, and roster seeding edge cases.
- Validate that `/api/health` exposes the current storage metadata and that logs emit on startup.
- Monitor connection pool usage (e.g., `PGPOOLSIZE` adjustments, slow queries via `log_min_duration_statement`).
- When adding features, update Playwright/Cypress scenarios that execute end-to-end UI flows against a seeded database.

---

## 6. Reference Commands & Resources
- Launch local Postgres: `docker run --name monkey-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16`.
- Seed dev data as needed: `psql "$DATABASE_URL" -f ./scripts/seed.sql` (author a seed script when required).
- Run the server: `node server/index.js` (uses `DATABASE_URL` or config file for credentials).
- Helpful packages: `pg`, `pg-pool`, `slonik`, `zod`, `drizzle-orm`.

---

## 7. Future Optimization: User Credential System
To introduce a credentialed, role-based access layer on top of the existing storage module:

- **Schema Additions**
  - Create a `users` table with columns such as `id UUID PRIMARY KEY`, `email TEXT UNIQUE NOT NULL`, `display_name TEXT`, `password_hash TEXT NOT NULL`, `created_at TIMESTAMPTZ NOT NULL`, `last_login TIMESTAMPTZ`.
  - Add a `user_roles` table (or enum) that associates users with roles (`admin`, `dispatcher`, `viewer`). Consider a join table for many-to-many flexibility.
  - Store per-user preferences (e.g., default unit label, notification settings) in a `user_settings` JSONB column or dedicated table keyed by `user_id`.
- **Authentication Pipeline**
  - Use modern password hashing (`bcrypt`/`argon2`) and enforce minimum password complexity. Persist password reset tokens in a `user_tokens` table with expiry timestamps.
  - Issue signed JWTs or opaque session tokens stored in Redis/Postgres for stateless API requests. Tie tokens to role claims for easy authorization checks.
- **Authorization Strategy**
  - Gate API routes with middleware that reads the authenticated user and verifies required roles (e.g., only `admin` can mutate roster, `dispatcher` can edit shows, `viewer` has read-only access).
  - Extend `show` and `entry` JSON payloads with `createdBy`/`updatedBy` fields referencing `users.id` to support auditing and user-specific filters.
- **Operational Considerations**
  - Update `_ensureSchema()` to create new tables/indexes and extend bootstrap logging so operators know when credential tables are provisioned.
  - Centralize credential configuration (`PASSWORD_PEPPER`, session lifetimes) in `config/app-config.json` or environment variables.
  - Add integration tests that cover authentication flows, role-based authorization, and per-user data isolation.

Keep this document updated whenever new persistence or authentication features are introduced.
