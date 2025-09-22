const SqlProvider = require('./sqlProvider');
const CodaProvider = require('./codaProvider');

let providerInstance = null;
let providerName = null;

async function initProvider(config){
  if(providerInstance && typeof providerInstance.dispose === 'function'){
    await providerInstance.dispose();
  }
  providerName = config.provider === 'coda' ? 'coda' : 'sql';
  const providerConfig = providerName === 'coda' ? config.coda : config.sql;
  providerInstance = providerName === 'coda'
    ? new CodaProvider(providerConfig)
    : new SqlProvider(providerConfig);
  await providerInstance.init();
  return providerInstance;
}

function getProvider(){
  if(!providerInstance){
    throw new Error('Storage provider not initialized');
  }
  return providerInstance;
}

function getProviderName(){
  return providerName;
}

module.exports = {
  initProvider,
  getProvider,
  getProviderName
};
