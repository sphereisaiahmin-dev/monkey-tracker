# Drone Tracker Web Application

This project exposes the **Drone Tracker** interface as a full web application built with Express.js and a modular data layer. The UI is re-engineered from the original `Drone_Tracker_v0.8.5.html` file and now persists show data in PostgreSQL while optionally forwarding each entry to a configurable webhook.

## Features

- Full-featured front-end built with HTML and CSS that retains the original look-and-feel and now surfaces a LAN connection dashboard for quick status checks.
- Express.js backend API that manages shows, entries, and configuration.
- PostgreSQL storage provider with automatic schema provisioning, archive retention, and JSON-backed snapshots for show history.
- Authenticated access with thesphere.com email enforcement, per-user roles (pilot or stagehand), and a self-service directory for managing credentials.
- Configurable application settings from the in-app settings panel (unit label, webhook delivery settings, and roster management).
- Optional per-entry webhook export that mirrors the CSV column structure so downstream tables align perfectly with local exports.
- Archive workspace that retains shows for two months and supports CSV/JSON exports.
- Entry editor modal with validation consistent with the original workflow.

## Getting Started

1. Install dependencies at the repository root:

   ```bash
   npm install
   ```

2. Start the server directly with Node (Express binds to `10.241.211.120` by default so the app is reachable across the LAN):

   ```bash
   node server/index.js
   ```

   > Avoid using `npm start` – the project is configured to be launched directly via Node without npm-run scripts.

   The app runs on [http://10.241.211.120:3000](http://10.241.211.120:3000) out of the box. Set the `HOST` and `PORT` environment variables before launching if you need a different binding (for example `HOST=0.0.0.0 node server/index.js`).

3. Visit the app in your browser and sign in with a thesphere.com account. The login screen enforces the `first.last@thesphere.com` email pattern and exposes a Create Account flow so new pilots or stagehands can onboard themselves. Out of the box the system seeds the following accounts (password `admin`):

   - Pilots – `Nazar.Vasylyk@thesphere.com`, `Alexander.Brodnik@thesphere.com`, `Robert.Ontell@thesphere.com`
   - Stagehands – `Cleo.Kelley@thesphere.com`, `Bret.Tuttle@thesphere.com`

   After signing in, open the settings panel (hamburger button) to adjust the unit label, manage the user directory, or enable the webhook exporter. By default the app connects to PostgreSQL using the connection information in `config/app-config.json` (or the `DATABASE_URL` environment variable) and automatically provisions any missing schema objects.

## Configuration

The runtime configuration is stored in `config/app-config.json` (created automatically on first run). A template is provided at `config/app-config.example.json` for reference. When settings are saved through the UI the server reloads the storage provider with the new configuration.

### Server binding

- **host** – interface/IP address the Express server should listen on. Defaults to `10.241.211.120` so the dashboard is reachable across the LAN.
- **port** – TCP port used by the server. Defaults to `3000`.

> Update these values in `config/app-config.json` (or via environment variables) and restart `node server/index.js` for changes to take effect.

### PostgreSQL storage

The server always uses PostgreSQL for persistence. Connection details come from the `postgres` section of `config/app-config.json` and any relevant environment variables. Supported keys include:

- `connectionString` – standard PostgreSQL connection URI. Defaults to `postgres://postgres:postgres@localhost:5432/monkey_tracker` when not provided.
- `host`, `port`, `database`, `user`, `password` – override individual connection parameters when `connectionString` is not used.
- `ssl` – set to `true` or provide a Node.js TLS object to enable SSL.
- `schema` – optional schema name where the Monkey Tracker tables should be created.

Environment variables using the standard PostgreSQL naming scheme (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE`) and common alternatives (`POSTGRES_HOST`, `POSTGRES_PORT`, etc.) are also honored. These settings fill in missing values from the config file so the server can connect even when only environment variables are provided. On startup the storage provider creates the database (if permitted), schema, tables, and indexes that power the application and logs the bootstrap actions.

### Roster & user management

The settings panel now exposes a dedicated **User settings** tab for creating, editing, or removing thesphere.com accounts. Each user selects a role (pilot or stagehand) and those assignments automatically power the read-only pilot, monkey lead, and crew rosters shown elsewhere in the menu. Updating the directory immediately refreshes dropdowns throughout the UI.

### Webhook exporter

Enable this option from the settings dialog to stream each saved entry to an external system. The payload mirrors the CSV export columns so the receiving table matches local downloads exactly.

- **Enabled** – toggle to activate per-entry delivery.
- **Webhook URL** – target endpoint that will receive JSON payloads.
- **HTTP method** – verb used when sending the webhook (POST or PUT).
- **Shared secret** – optional secret inserted into the `X-Drone-Webhook-Secret` header.
- **Additional headers** – newline-delimited list of `Header: value` pairs that will be attached to every request.

## API Overview

The Express backend exposes the following endpoints (all JSON):

- `GET /api/config` / `PUT /api/config` – read or update application configuration (storage settings + webhook configuration). Responses include `storageMeta` to describe the active driver.
- `POST /api/auth/login` / `POST /api/auth/register` / `POST /api/auth/logout` – email + password authentication flow using thesphere.com addresses. Successful logins return a bearer token that is required for all other endpoints.
- `GET /api/me` – fetch the currently authenticated user's profile (used to resume sessions).
- `GET /api/users` / `POST /api/users` / `PUT /api/users/:id` / `DELETE /api/users/:id` – manage the user directory and role assignments that power roster selections.
- `GET /api/shows` – list shows along with the active storage metadata and webhook status.
- `POST /api/shows` – create a new show.
- `GET /api/shows/:id` – retrieve a single show.
- `PUT /api/shows/:id` – update show metadata.
- `DELETE /api/shows/:id` – remove a show.
- `POST /api/shows/:id/entries` – add an entry to a show.
- `PUT /api/shows/:id/entries/:entryId` – update an entry.
- `DELETE /api/shows/:id/entries/:entryId` – delete an entry.

## Development Notes

- The project uses ES modules in the front-end (`public/app.js`) and CommonJS on the server.
- Static assets are served from the `public/` directory.
- `config/app-config.json` is ignored by Git so that environment-specific configuration stays local.

## Original Asset

The original standalone HTML file is kept at `Drone_Tracker_v0.8.5.html` for reference.
