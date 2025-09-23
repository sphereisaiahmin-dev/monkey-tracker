const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'app-config.json');
const DEFAULT_HOST = process.env.HOST || process.env.LISTEN_HOST || '10.241.211.120';
const DEFAULT_PORT = Number.isFinite(parseInt(process.env.PORT, 10)) ? parseInt(process.env.PORT, 10) : 3000;
const DEFAULT_CONFIG = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  unitLabel: 'Drone',
  provider: 'sql',
  sql: {
    filename: path.join(process.cwd(), 'data', 'monkey-tracker.sqlite')
  },
  coda: {
    apiToken: '',
    docId: '',
    tableId: '',
    showIdColumn: 'Show ID',
    payloadColumn: 'Payload'
  }
};

function ensureConfigFile(){
  const dir = path.dirname(CONFIG_FILE);
  if(!fs.existsSync(dir)){
    fs.mkdirSync(dir, {recursive: true});
  }
  if(!fs.existsSync(CONFIG_FILE)){
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
}

function loadConfig(){
  ensureConfigFile();
  try{
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      sql: {...DEFAULT_CONFIG.sql, ...(parsed.sql || {})},
      coda: {...DEFAULT_CONFIG.coda, ...(parsed.coda || {})},
      host: parsed.host || DEFAULT_CONFIG.host,
      port: Number.isFinite(parseInt(parsed.port, 10)) ? parseInt(parsed.port, 10) : DEFAULT_CONFIG.port
    };
  }catch(err){
    console.error('Failed to load config. Falling back to defaults.', err);
    return {...DEFAULT_CONFIG};
  }
}

function saveConfig(config){
  ensureConfigFile();
  const merged = {
    ...DEFAULT_CONFIG,
    ...config,
    sql: {...DEFAULT_CONFIG.sql, ...(config.sql || {})},
    coda: {...DEFAULT_CONFIG.coda, ...(config.coda || {})}
  };
  merged.host = merged.host || DEFAULT_CONFIG.host;
  merged.port = Number.isFinite(parseInt(merged.port, 10)) ? parseInt(merged.port, 10) : DEFAULT_CONFIG.port;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

module.exports = {
  loadConfig,
  saveConfig,
  defaultConfig: DEFAULT_CONFIG
};
