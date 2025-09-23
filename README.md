# Drone Tracker Web Application

This project exposes the **Drone Tracker** interface as a full web application built with Express.js and a modular data layer. The UI is re-engineered from the original `Drone_Tracker_v0.8.5.html` file and now persists show data using a local SQL.js (WebAssembly) database while optionally forwarding each entry to a configurable webhook.

## Features

- Full-featured front-end built with HTML and CSS that retains the original look-and-feel and now surfaces a LAN connection dashboard for quick status checks.
- Express.js backend API that manages shows, entries, and configuration.
- SQL.js storage provider (v2) implemented with `sql.js` so no native builds are required. The server creates the database file if it does not exist.
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

3. Open the settings panel (hamburger button) to adjust the unit label, manage pilot/monkey lead/crew rosters, or to enable the webhook exporter. By default the app uses SQLite-on-WASM and stores data in `data/monkey-tracker.sqlite`.

## Configuration

The runtime configuration is stored in `config/app-config.json` (created automatically on first run). A template is provided at `config/app-config.example.json` for reference. When settings are saved through the UI the server reloads the storage provider with the new configuration.

### Server binding

- **host** – interface/IP address the Express server should listen on. Defaults to `10.241.211.120` so the dashboard is reachable across the LAN.
- **port** – TCP port used by the server. Defaults to `3000`.

> Update these values in `config/app-config.json` (or via environment variables) and restart `node server/index.js` for changes to take effect.

### SQL.js storage

The SQLite database file is stored at `data/monkey-tracker.sqlite`. The directory is created if it does not exist and the file is managed automatically by the server.

### Roster management

The settings panel maintains individual lists for pilots, IATSE monkey leads, and crew. Monkey leads start with Cleo, Bret, Leslie, and Dallas by default and can be customized to match the day's roster.

### Webhook exporter

Enable this option from the settings dialog to stream each saved entry to an external system. The payload mirrors the CSV export columns so the receiving table matches local downloads exactly.

- **Enabled** – toggle to activate per-entry delivery.
- **Webhook URL** – target endpoint that will receive JSON payloads.
- **HTTP method** – verb used when sending the webhook (POST or PUT).
- **Shared secret** – optional secret inserted into the `X-Drone-Webhook-Secret` header.
- **Additional headers** – newline-delimited list of `Header: value` pairs that will be attached to every request.

## API Overview

The Express backend exposes the following endpoints (all JSON):

- `GET /api/config` / `PUT /api/config` – read or update application configuration (SQL.js settings + webhook configuration).
- `GET /api/shows` – list shows along with the active storage label and webhook status.
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
- `config/app-config.json` and `data/` are ignored by Git so that environment-specific configuration and data files stay local.

## Original Asset

The original standalone HTML file is kept at `Drone_Tracker_v0.8.5.html` for reference.
