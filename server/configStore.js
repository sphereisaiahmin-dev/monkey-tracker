const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'app-config.json');
const DEFAULT_HOST = process.env.HOST || process.env.LISTEN_HOST || '10.241.211.120';
const DEFAULT_PORT = Number.isFinite(parseInt(process.env.PORT, 10)) ? parseInt(process.env.PORT, 10) : 3000;
const DEFAULT_CONFIG = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  unitLabel: 'Drone',
  sql: {
    filename: path.join(process.cwd(), 'data', 'monkey-tracker.sqlite')
  },
  webhook: {
    enabled: false,
    url: '',
    method: 'POST',
    secret: '',
    headers: []
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
    const {provider: _legacyProvider, ...cleanParsed} = parsed;
    return {
      ...DEFAULT_CONFIG,
      ...cleanParsed,
      sql: {...DEFAULT_CONFIG.sql, ...(cleanParsed.sql || {})},
      webhook: {...DEFAULT_CONFIG.webhook, ...(cleanParsed.webhook || {})},
      host: cleanParsed.host || DEFAULT_CONFIG.host,
      port: Number.isFinite(parseInt(cleanParsed.port, 10)) ? parseInt(cleanParsed.port, 10) : DEFAULT_CONFIG.port
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
    webhook: {...DEFAULT_CONFIG.webhook, ...(config.webhook || {})}
  };
  delete merged.provider;
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
