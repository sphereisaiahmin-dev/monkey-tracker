const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'app-config.json');
const DEFAULT_CONFIG = {
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
      coda: {...DEFAULT_CONFIG.coda, ...(parsed.coda || {})}
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
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

module.exports = {
  loadConfig,
  saveConfig,
  defaultConfig: DEFAULT_CONFIG
};
