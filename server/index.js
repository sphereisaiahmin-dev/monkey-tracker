const path = require('path');
const express = require('express');
const morgan = require('morgan');
const { loadConfig, saveConfig } = require('./configStore');
const { initProvider, getProvider } = require('./storage');
const { setWebhookConfig, getWebhookStatus, dispatchEntryEvent } = require('./webhookDispatcher');

async function bootstrap(){
  const app = express();
  let config = loadConfig();
  let configuredHost = config.host || '10.241.211.120';
  let configuredPort = config.port || 3000;
  const envPort = Number.parseInt(process.env.PORT, 10);
  const envHost = process.env.HOST || process.env.LISTEN_HOST;
  let boundPort = Number.isFinite(envPort) ? envPort : configuredPort;
  let boundHost = envHost || configuredHost;
  let serverInstance = null;
  await initProvider(config);
  setWebhookConfig(config.webhook);

  app.use(express.json({limit: '2mb'}));
  app.use(morgan('dev'));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  function asyncHandler(fn){
    return (req, res, next)=>{
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }

  app.get('/api/health', (req, res)=>{
    res.json({
      status: 'ok',
      storage: 'sql.js v2',
      webhook: getWebhookStatus(),
      host: configuredHost,
      port: configuredPort,
      boundHost,
      boundPort
    });
  });

  app.get('/api/config', (req, res)=>{
    res.json(config);
  });

  app.put('/api/config', asyncHandler(async (req, res)=>{
    const nextConfig = saveConfig(req.body || {});
    await initProvider(nextConfig);
    setWebhookConfig(nextConfig.webhook);
    config = nextConfig;
    configuredHost = config.host || configuredHost;
    configuredPort = config.port || configuredPort;
    if(!envHost && configuredHost !== boundHost){
      console.warn(`Configured host updated to ${configuredHost}. Restart the server to bind to the new address.`);
    }
    if(!Number.isFinite(envPort) && configuredPort !== boundPort){
      console.warn(`Configured port updated to ${configuredPort}. Restart the server to bind to the new port.`);
    }
    res.json(config);
  }));

  app.get('/api/roster', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const [pilots, crew] = await Promise.all([
      provider.listPilots(),
      provider.listCrew()
    ]);
    res.json({pilots, crew});
  }));

  app.post('/api/pilots', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const pilot = await provider.createPilot(req.body || {});
    res.status(201).json(pilot);
  }));

  app.delete('/api/pilots/:id', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    await provider.deletePilot(req.params.id);
    res.status(204).end();
  }));

  app.post('/api/crew', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const crew = await provider.createCrewMember(req.body || {});
    res.status(201).json(crew);
  }));

  app.delete('/api/crew/:id', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    await provider.deleteCrewMember(req.params.id);
    res.status(204).end();
  }));

  app.get('/api/shows', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const shows = await provider.listShows();
    res.json({storage: 'sql.js v2', webhook: getWebhookStatus(), shows});
  }));

  app.post('/api/shows', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const show = await provider.createShow(req.body || {});
    res.status(201).json(show);
  }));

  app.get('/api/shows/:id', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const show = await provider.getShow(req.params.id);
    if(!show){
      res.status(404).json({error: 'Show not found'});
      return;
    }
    res.json(show);
  }));

  app.put('/api/shows/:id', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const show = await provider.updateShow(req.params.id, req.body || {});
    if(!show){
      res.status(404).json({error: 'Show not found'});
      return;
    }
    res.json(show);
  }));

  app.delete('/api/shows/:id', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const existing = await provider.getShow(req.params.id);
    if(!existing){
      res.status(404).json({error: 'Show not found'});
      return;
    }
    await provider.deleteShow(req.params.id);
    res.status(204).end();
  }));

  app.post('/api/shows/:id/entries', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const entry = await provider.addEntry(req.params.id, req.body || {});
    if(!entry){
      res.status(404).json({error: 'Show not found'});
      return;
    }
    const show = await provider.getShow(req.params.id);
    await dispatchEntryEvent('entry.created', show, entry);
    res.status(201).json(entry);
  }));

  app.put('/api/shows/:id/entries/:entryId', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const entry = await provider.updateEntry(req.params.id, req.params.entryId, req.body || {});
    if(!entry){
      res.status(404).json({error: 'Entry not found'});
      return;
    }
    const show = await provider.getShow(req.params.id);
    await dispatchEntryEvent('entry.updated', show, entry);
    res.json(entry);
  }));

  app.delete('/api/shows/:id/entries/:entryId', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const result = await provider.deleteEntry(req.params.id, req.params.entryId);
    if(!result){
      res.status(404).json({error: 'Entry not found'});
      return;
    }
    res.status(204).end();
  }));

  // Serve index.html for any non-API request (client-side routing support)
  app.get(/^(?!\/api\/).*/, (req, res)=>{
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.use((err, req, res, next)=>{ // eslint-disable-line no-unused-vars
    console.error(err);
    const status = Number.isInteger(err.statusCode) ? err.statusCode : 500;
    if(status === 500){
      res.status(500).json({error: 'Internal server error', detail: err.message});
    }else{
      res.status(status).json({error: err.message || 'Request failed'});
    }
  });

  function handleListenError(err){
    if(err.code === 'EADDRNOTAVAIL' && !envHost && boundHost !== '0.0.0.0'){
      console.warn(`Address ${boundHost} is not available on this machine. Falling back to 0.0.0.0.`);
      serverInstance?.off('error', handleListenError);
      boundHost = '0.0.0.0';
      startListening(boundHost);
      return;
    }
    console.error('Failed to bind server', err);
    process.exit(1);
  }

  function startListening(targetHost){
    serverInstance = app.listen(boundPort, targetHost, ()=>{
      console.log(`Server listening on http://${targetHost}:${boundPort}`);
      if(targetHost !== configuredHost){
        console.log(`Configured LAN URL: http://${configuredHost}:${configuredPort}`);
      }
      console.log('Press Ctrl+C to stop the server.');
    });
    serverInstance.on('error', handleListenError);
  }

  startListening(boundHost);
}

bootstrap().catch(err=>{
  console.error('Failed to start server', err);
  process.exit(1);
});
