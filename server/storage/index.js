const SqlProvider = require('./sqlProvider');

let providerInstance = null;

async function initProvider(config){
  if(providerInstance && typeof providerInstance.dispose === 'function'){
    await providerInstance.dispose();
  }
  providerInstance = new SqlProvider(config.sql);
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
