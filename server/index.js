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

  function getStorageMetadata(){
    try{
      const provider = getProvider();
      if(provider && typeof provider.getStorageMetadata === 'function'){
        const meta = provider.getStorageMetadata();
        if(meta && typeof meta === 'object'){
          return {
            label: typeof meta.label === 'string' && meta.label ? meta.label : (provider.getStorageLabel?.() || 'PostgreSQL v1'),
            ...meta
          };
        }
      }
      const label = provider?.getStorageLabel?.() || 'PostgreSQL v1';
      return {label};
    }catch(err){
      return {label: 'PostgreSQL v1'};
    }
  }

  function sanitizeUser(user){
    if(!user){
      return null;
    }
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      displayName: user.displayName || user.email,
      role: user.role || 'stagehand',
      createdAt: user.createdAt ?? null,
      updatedAt: user.updatedAt ?? null,
      lastLogin: user.lastLogin ?? null,
      expiresAt: user.expiresAt ?? undefined
    };
  }

  function extractToken(req){
    const authHeader = req.get('authorization') || req.get('Authorization');
    if(authHeader && authHeader.toLowerCase().startsWith('bearer ')){
      return authHeader.slice(7).trim();
    }
    const headerToken = req.get('x-auth-token');
    if(typeof headerToken === 'string' && headerToken.trim()){
      return headerToken.trim();
    }
    return null;
  }

  app.get('/api/health', (req, res)=>{
    const storageMeta = getStorageMetadata();
    res.json({
      status: 'ok',
      storage: storageMeta.label,
      storageMeta,
      webhook: getWebhookStatus(),
      host: configuredHost,
      port: configuredPort,
      boundHost,
      boundPort
    });
  });

  app.post('/api/auth/login', asyncHandler(async (req, res)=>{
    const {email, password} = req.body || {};
    const provider = getProvider();
    const user = await provider.authenticateUser(email, password);
    if(!user){
      res.status(401).json({error: 'Invalid email or password'});
      return;
    }
    const token = await provider.createAuthToken(user.id);
    res.json({token: token.token, expiresAt: token.expiresAt, user: sanitizeUser(user)});
  }));

  app.post('/api/auth/register', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const user = await provider.createUser(req.body || {});
    const token = await provider.createAuthToken(user.id);
    res.status(201).json({token: token.token, expiresAt: token.expiresAt, user: sanitizeUser(user)});
  }));

  app.use('/api', async (req, res, next)=>{
    if(req.method === 'OPTIONS'){
      next();
      return;
    }
    if(req.path === '/health' || req.path === '/auth/login' || req.path === '/auth/register'){
      next();
      return;
    }
    try{
      const token = extractToken(req);
      if(!token){
        res.status(401).json({error: 'Authentication required'});
        return;
      }
      const provider = getProvider();
      const user = await provider.getUserByToken(token);
      if(!user){
        res.status(401).json({error: 'Invalid or expired token'});
        return;
      }
      req.user = user;
      req.authToken = token;
      next();
    }catch(err){
      next(err);
    }
  });

  app.get('/api/me', (req, res)=>{
    res.json(sanitizeUser(req.user));
  });

  app.post('/api/auth/logout', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    if(req.authToken){
      await provider.revokeToken(req.authToken);
    }
    res.status(204).end();
  }));

  app.get('/api/users', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const users = await provider.listUsers();
    res.json({users: users.map(user => sanitizeUser(user))});
  }));

  app.post('/api/users', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const user = await provider.createUser(req.body || {});
    res.status(201).json(sanitizeUser(user));
  }));

  app.put('/api/users/:id', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const user = await provider.updateUser(req.params.id, req.body || {});
    if(!user){
      res.status(404).json({error: 'User not found'});
      return;
    }
    res.json(sanitizeUser(user));
  }));

  app.delete('/api/users/:id', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const deleted = await provider.deleteUser(req.params.id);
    if(!deleted){
      res.status(404).json({error: 'User not found'});
      return;
    }
    res.status(204).end();
  }));

  app.get('/api/config', (req, res)=>{
    const storageMeta = getStorageMetadata();
    res.json({...config, storageMeta});
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
    const storageMeta = getStorageMetadata();
    res.json({...config, storageMeta});
  }));

  app.get('/api/staff', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const staff = await provider.getStaff();
    res.json(staff);
  }));

  app.put('/api/staff', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const staff = await provider.replaceStaff(req.body || {});
    res.json(staff);
  }));

  app.get('/api/shows', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const shows = await provider.listShows();
    const storageMeta = getStorageMetadata();
    res.json({storage: storageMeta.label, storageMeta, webhook: getWebhookStatus(), shows});
  }));

  app.get('/api/shows/archive', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const shows = await provider.listArchivedShows();
    res.json({shows});
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
    const archived = await provider.deleteShow(req.params.id);
    if(!archived){
      res.status(404).json({error: 'Show not found'});
      return;
    }
    res.json(archived);
  }));

  app.post('/api/shows/:id/archive', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const archived = await provider.archiveShowNow(req.params.id);
    if(!archived){
      res.status(404).json({error: 'Show not found'});
      return;
    }
    res.json(archived);
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
