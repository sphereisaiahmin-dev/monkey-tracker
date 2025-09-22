# Drone Tracker Web Application

This project exposes the **Drone Tracker** interface as a full web application built with Express.js and a modular data layer. The UI is re-engineered from the original `Drone_Tracker_v0.8.5.html` file and now persists show data using either a local SQL database (SQLite) or a remote Coda table.

## Features

- Full-featured front-end built with HTML and CSS that retains the original look-and-feel and now surfaces a LAN connection dashboard for quick status checks.
- Express.js backend API that manages shows, entries, and configuration.
- Modular storage providers:
  - **SQL (SQLite)** – default provider. The server creates the database file if it does not exist.
  - **Coda** – push and pull show payloads to a Coda table using the Coda REST API.
- Configurable application settings from the in-app settings panel (unit label, provider selection, connection parameters).
- CSV and JSON export for the active show.
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

3. Open the settings panel (gear icon) to choose the storage provider and supply the required connection parameters. By default the app uses SQLite and stores data in `data/monkey-tracker.sqlite`.

## Configuration

The runtime configuration is stored in `config/app-config.json` (created automatically on first run). A template is provided at `config/app-config.example.json` for reference. When settings are saved through the UI the server reloads the storage provider with the new configuration.

### Server binding

- **host** – interface/IP address the Express server should listen on. Defaults to `10.241.211.120` so the dashboard is reachable across the LAN.
- **port** – TCP port used by the server. Defaults to `3000`.

> Update these values in `config/app-config.json` (or via environment variables) and restart `node server/index.js` for changes to take effect.

### SQL Provider

- **filename** – path to the SQLite database file. The directory is created if it does not exist. Shows are stored as JSON documents inside the `shows` table.

### Coda Provider

Provide the following values in the settings panel:

- **API token** – personal API token from Coda.
- **Doc ID** – the identifier of the Coda doc (e.g. `doc_XXXX`).
- **Table ID** – the target table ID (e.g. `table_YYYY`).
- **Show ID column name** – text column that stores the unique show ID.
- **Payload column name** – text column that stores the JSON payload returned by the app.

> **Note:** The Coda provider requires a table with text columns capable of storing the show ID and JSON payload. The provider fetches and replaces complete show documents, including their entries.

## API Overview

The Express backend exposes the following endpoints (all JSON):

- `GET /api/config` / `PUT /api/config` – read or update application configuration.
- `GET /api/shows` – list shows for the active provider.
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
