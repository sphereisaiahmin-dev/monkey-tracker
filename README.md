# Monkey Tracker

Modernised operations dashboard for coordinating drone show crews. The application ships with a React front end, an Express API,
and a PostgreSQL persistence layer that keeps shows, entries, staff rosters, and user accounts in sync.

## Highlights

- **React SPA** served directly from Express using native ES modules – no build step required.
- **Role-aware access control** with JWT-based authentication. Admins can invite additional users straight from the API.
- **PostgreSQL storage** with automatic migrations, daily show limits, per-entry webhook fan-out, and archive retention logic.
- **Real-time feedback** on storage/webhook status, streamlined show creation, and quick entry capture for pilots and crew.

## Getting Started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Provision PostgreSQL (local or remote) and create a database named `monkey_tracker`:

   ```bash
   sudo service postgresql start
   sudo -u postgres createdb monkey_tracker
   ```

   Set `DATABASE_URL` if you are not using the default `postgresql://postgres@localhost:5432/monkey_tracker` connection string.

3. Start the API/server:

   ```bash
   node server/index.js
   ```

   The server binds to `10.241.211.120:3000` by default. Override with `HOST` / `PORT` environment variables if needed.

4. Open the dashboard and sign in using the bootstrapped admin account:

   - **Email:** `admin@monkeytracker.local`
   - **Password:** `changeme123`

   Change the password by creating a new user through `POST /api/auth/register` and disabling the default account.

## Configuration

Runtime configuration is stored in `config/app-config.json` and automatically created on first launch. A reference template lives at
`config/app-config.example.json`.

Key settings:

- **host / port** – binding for the Express server (defaults to `10.241.211.120:3000`).
- **database.connectionString** – PostgreSQL connection string. Falls back to `DATABASE_URL`.
- **webhook** – optional per-entry webhook definition (`enabled`, `url`, `method`, `secret`, `headers`).

Edits made through the API will persist to disk and refresh the storage provider without restarting the server.

## API Overview

All JSON endpoints require authentication unless noted.

| Method & Path | Description | Required Role |
| --- | --- | --- |
| `POST /api/auth/login` | Exchange credentials for a JWT | Public |
| `GET /api/auth/me` | Return the current user profile | Any authenticated user |
| `POST /api/auth/register` | Invite a new user (email, name, password, role) | Admin |
| `GET /api/health` | Health probe with storage + webhook status | Public |
| `GET /api/shows` | List active shows | Viewer / Pilot / Manager / Admin |
| `POST /api/shows` | Create a show | Manager / Admin |
| `GET /api/shows/:id` | Retrieve show detail | Any authenticated user |
| `PUT /api/shows/:id` | Update show metadata | Manager / Admin |
| `DELETE /api/shows/:id` | Remove a show | Admin |
| `POST /api/shows/:id/archive` | Archive a show immediately | Manager / Admin |
| `POST /api/shows/:id/entries` | Create a show entry | Pilot / Manager / Admin |
| `PUT /api/shows/:id/entries/:entryId` | Update an entry | Manager / Admin |
| `DELETE /api/shows/:id/entries/:entryId` | Delete an entry | Manager / Admin |
| `GET /api/staff` | Retrieve crew, pilot, and monkey lead rosters | Any authenticated user |
| `PUT /api/staff` | Replace the roster lists | Manager / Admin |
| `GET /api/shows/archive` | List archived shows | Manager / Admin |

Responses include webhook status metadata to keep operators informed about integrations.

## Authentication & Roles

Tokens are issued as JWTs and must be supplied via the `Authorization: Bearer <token>` header. Three built-in roles:

- **admin** – full control over configuration, roster, shows, entries, and user management.
- **manager** – manage shows/entries/rosters but cannot delete shows or invite users.
- **pilot** – capture entries for assigned shows.
- **viewer** – read-only access to shows.

The default admin user is seeded automatically during the first migration. Use the registration endpoint to provision additional
accounts and rotate credentials.

## Front-end Overview

The React interface emphasises speed and clarity:

- One-click navigation between shows with crew and entry counts.
- Inline editing of show metadata with automatic validation.
- Entry composer that adapts the form when a show aborts/no-launch is selected.
- Real-time toasts for success/failure feedback and live webhook/storage badges in the header.

Static assets reside in `public/` and are served as ES modules – no bundler required.

## Development Notes

- `server/storage/postgresProvider.js` manages migrations, archive retention, and staff seeding.
- Webhook dispatch is unchanged and continues to mirror the CSV export structure.
- Scripts in `scripts/` assume a PostgreSQL backend; ensure `DATABASE_URL` is set before running automation.

## Testing

Run the placeholder test command to verify dependency resolution:

```bash
npm test
```

Manual QA steps (recommended):

1. Log in as the default admin.
2. Create a manager user via `POST /api/auth/register`.
3. Sign in as the manager and create multiple shows and entries.
4. Log in as a pilot to confirm entry-only permissions.
5. Archive a show and confirm it moves to the archived tab.

Enjoy the streamlined monkey tracking experience!
