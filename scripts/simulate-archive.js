const { initProvider } = require('../server/storage');

const DAY_IN_MS = 24 * 60 * 60 * 1000;

async function main(){
  const connectionString = process.env.DATABASE_URL || 'postgresql://postgres@localhost:5432/monkey_tracker';
  const provider = await initProvider({database: {connectionString}});

  const totalDays = 70;
  const showsPerDay = 2;
  const now = Date.now();
  const start = now - ((totalDays + 2) * DAY_IN_MS);

  for(let day = 0; day < totalDays; day += 1){
    const dayTimestamp = start + (day * DAY_IN_MS);
    const dateStr = new Date(dayTimestamp).toISOString().slice(0, 10);
    for(let index = 0; index < showsPerDay; index += 1){
      const showTimestamp = dayTimestamp + (index * 60 * 60 * 1000);
      await provider.createShow({
        date: dateStr,
        time: `${String(9 + index).padStart(2, '0')}:00`,
        label: `Simulated show ${day + 1}-${index + 1}`,
        crew: ['Sim Crew'],
        leadPilot: 'Sim Lead',
        monkeyLead: 'Sim Monkey',
        notes: 'Archive simulation record',
        createdAt: showTimestamp,
        updatedAt: showTimestamp
      });
    }
  }

  await provider.runArchiveMaintenance();

  const activeShows = await provider.listShows();
  const archivedShows = await provider.listArchivedShows();

  const expiredArchived = archivedShows.filter(show => {
    const createdAt = Number(show.createdAt);
    if(!Number.isFinite(createdAt)){
      return false;
    }
    const expiry = new Date(createdAt);
    expiry.setMonth(expiry.getMonth() + 2);
    return Date.now() >= expiry.getTime();
  });

  console.log(`Active shows remaining: ${activeShows.length}`);
  console.log(`Archived shows stored: ${archivedShows.length}`);
  console.log(`Expired archived shows detected (should be 0): ${expiredArchived.length}`);

  await provider.dispose();
}

main().catch(err =>{
  console.error('Archive simulation failed', err);
  process.exit(1);
});
