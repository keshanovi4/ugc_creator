import {createInterface} from 'node:readline';
import {createApp,configuration} from '../sneg-ugc/server/index.mjs';
const config=configuration(),app=createApp(config);let timer;
app.server.listen(config.port,config.host);
// Keep notifications paused until the controller verifies HTTPS and configures the bot.
createInterface({input:process.stdin}).on('line',line=>{if(line==='enable-worker'&&!timer){timer=setInterval(()=>app.worker.tick().catch(()=>console.error('PILOT_WORKER_ERROR')),config.workerInterval);timer.unref();}});
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{clearInterval(timer);app.server.close(()=>{app.store.close();process.exit(0);});});
