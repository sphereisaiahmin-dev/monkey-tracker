const path = require('path');
const express = require('express');
const morgan = require('morgan');
const { loadConfig, saveConfig } = require('./configStore');
const { initProvider, getProvider, getProviderName } = require('./storage');

const PORT = process.env.PORT || 3000;

async function bootstrap(){
  const app = express();
  let config = loadConfig();
  await initProvider(config);

  app.use(express.json({limit: '2mb'}));
  app.use(morgan('dev'));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  function asyncHandler(fn){
    return (req, res, next)=>{
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }

  app.get('/api/health', (req, res)=>{
    res.json({status: 'ok', provider: getProviderName()});
  });

  app.get('/api/config', (req, res)=>{
    res.json(config);
  });

  app.put('/api/config', asyncHandler(async (req, res)=>{
    const nextConfig = saveConfig(req.body || {});
    await initProvider(nextConfig);
    config = nextConfig;
    res.json(config);
  }));

  app.get('/api/shows', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const shows = await provider.listShows();
    res.json({provider: getProviderName(), shows});
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
    res.status(201).json(entry);
  }));

  app.put('/api/shows/:id/entries/:entryId', asyncHandler(async (req, res)=>{
    const provider = getProvider();
    const entry = await provider.updateEntry(req.params.id, req.params.entryId, req.body || {});
    if(!entry){
      res.status(404).json({error: 'Entry not found'});
      return;
    }
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
    if(err.message && err.message.includes('Coda provider is not fully configured')){
      res.status(400).json({error: err.message});
      return;
    }
    res.status(500).json({error: 'Internal server error', detail: err.message});
  });

  app.listen(PORT, ()=>{
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

bootstrap().catch(err=>{
  console.error('Failed to start server', err);
  process.exit(1);
});
