const path = require('path');
const express = require('express');
const morgan = require('morgan');
const { loadConfig, saveConfig } = require('./configStore');
const { initProvider, getProvider } = require('./storage');
const { setWebhookConfig, getWebhookStatus, dispatchEntryEvent } = require('./webhookDispatcher');
const { authenticate, requireRole, loginHandler, registerUserHandler, meHandler } = require('./auth');

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
      storage: 'PostgreSQL',
      webhook: getWebhookStatus(),
      host: configuredHost,
      port: configuredPort,
      boundHost,
      boundPort
    });
  });

  app.post('/api/auth/login', asyncHandler(loginHandler));
  app.post('/api/auth/register', authenticate, requireRole(['admin']), asyncHandler(registerUserHandler));
  app.get('/api/auth/me', authenticate, asyncHandler(meHandler));
  app.post('/api/auth/logout', authenticate, (req, res)=>{
    res.status(204).end();
  });

  app.get('/api/config', authenticate, requireRole(['admin','manager']), (req, res)=>{
    res.json(config);
  });

  app.put('/api/config', authenticate, requireRole(['admin']), asyncHandler(async (req, res)=>{
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

  app.get('/api/staff', authenticate, asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const staff = await provider.getStaff();
    res.json(staff);
  }));

  app.put('/api/staff', authenticate, requireRole(['admin','manager']), asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const staff = await provider.replaceStaff(req.body || {});
    res.json(staff);
  }));

  app.get('/api/shows', authenticate, asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const shows = await provider.listShows();
    res.json({storage: 'PostgreSQL', webhook: getWebhookStatus(), shows});
  }));

  app.get('/api/shows/archive', authenticate, requireRole(['admin','manager']), asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const shows = await provider.listArchivedShows();
    res.json({shows});
  }));

  app.post('/api/shows', authenticate, requireRole(['admin','manager']), asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const show = await provider.createShow(req.body || {});
    res.status(201).json(show);
  }));

  app.get('/api/shows/:id', authenticate, asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const show = await provider.getShow(req.params.id);
    if(!show){
      res.status(404).json({error: 'Show not found'});
      return;
    }
    res.json(show);
  }));

  app.put('/api/shows/:id', authenticate, requireRole(['admin','manager']), asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const show = await provider.updateShow(req.params.id, req.body || {});
    if(!show){
      res.status(404).json({error: 'Show not found'});
      return;
    }
    res.json(show);
  }));

  app.delete('/api/shows/:id', authenticate, requireRole(['admin']), asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const existing = await provider.getShow(req.params.id);
    if(!existing){
      res.status(404).json({error: 'Show not found'});
      return;
    }
    await provider.deleteShow(req.params.id);
    res.status(204).end();
  }));

  app.post('/api/shows/:id/archive', authenticate, requireRole(['admin','manager']), asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const archived = await provider.archiveShowNow(req.params.id);
    if(!archived){
      res.status(404).json({error: 'Show not found'});
      return;
    }
    res.json(archived);
  }));

  app.post('/api/shows/:id/entries', authenticate, requireRole(['admin','manager','pilot']), asyncHandler(async (req, res)=>{
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

  app.put('/api/shows/:id/entries/:entryId', authenticate, requireRole(['admin','manager']), asyncHandler(async (req, res)=>{
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

  app.delete('/api/shows/:id/entries/:entryId', authenticate, requireRole(['admin','manager']), asyncHandler(async (req, res)=>{
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
    const status = Number.isInteger(err.status) ? err.status : 500;
    const payload = {
      error: status === 500 ? 'Internal server error' : (err.message || 'Request failed')
    };
    if(status === 500 && err.message){
      payload.detail = err.message;
    }
    res.status(status).json(payload);
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
