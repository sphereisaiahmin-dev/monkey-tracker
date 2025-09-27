const PostgresProvider = require('./postgresProvider');

let providerInstance = null;

async function initProvider(config = {}){
  if(providerInstance && typeof providerInstance.dispose === 'function'){
    await providerInstance.dispose();
  }
  const postgresConfig = {
    ...(config.postgres || {}),
    ...(config.storage?.postgres || {})
  };
  providerInstance = new PostgresProvider(postgresConfig);
  await providerInstance.init();
  return providerInstance;
}

function getProvider(){
  if(!providerInstance){
    throw new Error('Storage provider not initialized');
  }
  return providerInstance;
}

function getActiveProviderType(){
  return 'postgres';
}

module.exports = {
  initProvider,
  getProvider,
  getActiveProviderType
};
