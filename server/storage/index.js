const PostgresProvider = require('./postgresProvider');

let providerInstance = null;

async function initProvider(config){
  if(providerInstance && typeof providerInstance.dispose === 'function'){
    await providerInstance.dispose();
  }
  providerInstance = new PostgresProvider(config.database);
  await providerInstance.init();
  return providerInstance;
}

function getProvider(){
  if(!providerInstance){
    throw new Error('Storage provider not initialized');
  }
  return providerInstance;
}

module.exports = {
  initProvider,
  getProvider
};
