import {spawn} from 'node:child_process';
import {readFile,writeFile,unlink,open} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {toolsDir,appDir,readState,checkBot,botCall,runtimePath,verifyPublic,configureBot,extractTunnelUrl} from './pilot-common.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const children=[];let lock,locked=false;
const lockPath=resolve(appDir,'data/pilot.lock');
const provider=process.argv.includes('--cloudflare')?'cloudflare':'microsoft';
async function ensureMicrosoftLogin(){
 const exe=resolve(toolsDir,'devtunnel.exe');
 const status=await new Promise((done,reject)=>{const child=spawn(exe,['user','show'],{windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);let output='';const timer=setTimeout(()=>{child.kill();reject(new Error('DEVTUNNEL_LOGIN_CHECK_FAILED'));},15000);child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.once('error',()=>{clearTimeout(timer);reject(new Error('DEVTUNNEL_NOT_AVAILABLE'));});child.once('close',code=>{clearTimeout(timer);done({code,output});});});
 if(status.code===0&&!status.output.includes('Not logged in'))return;
 console.log('Нужен вход GitHub. Откройте указанную ниже страницу и введите код. Пароль вводится только на GitHub.');
 await new Promise((done,reject)=>{const child=spawn(exe,['user','login','-g','-d'],{stdio:'inherit',windowsHide:true});children.push(child);child.once('error',()=>reject(new Error('DEVTUNNEL_LOGIN_FAILED')));child.once('exit',code=>code===0?done():reject(new Error('DEVTUNNEL_LOGIN_FAILED')));});
}
async function cleanup(){for(const child of children)if(child.exitCode===null)child.kill();if(lock)await lock.close().catch(()=>{});if(locked)await unlink(lockPath).catch(()=>{});}
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>cleanup().finally(()=>process.exit(0)));
try{
 const s=await readState();await checkBot(s);const webhook=await botCall(s,'getWebhookInfo');
 const previous=JSON.parse(await readFile(runtimePath,'utf8').catch(()=>'{}'));
 if(webhook.url&&webhook.url!==previous.url+'/telegram/webhook')throw new Error('BOT_ALREADY_CONNECTED_ELSEWHERE');
 if(process.argv.includes('--check')){console.log('Бот @'+s.botUsername+' проверен. Администратор подтверждён. Webhook: '+(webhook.url?'это приложение':'не установлен')+'.');process.exit(0);}
 if(provider==='microsoft')await ensureMicrosoftLogin();
 try{lock=await open(lockPath,'wx',0o600);locked=true;await lock.writeFile(String(process.pid));}catch{throw new Error('PILOT_LOCK_EXISTS');}
 await new Promise((done,reject)=>{const probe=createServer();probe.once('error',()=>reject(new Error('PORT_3100_BUSY')));probe.listen(3100,'127.0.0.1',()=>probe.close(done));});
 console.log('Подключаю '+(provider==='microsoft'?'Microsoft Dev Tunnels':'Cloudflare')+'. Это может занять до минуты...');
 const microsoftArgs=s.tunnelId?['host',s.tunnelId,'--host-header','unchanged','--origin-header','unchanged']:['host','-p','3100','--protocol','http','--allow-anonymous','--host-header','unchanged','--origin-header','unchanged','--expiration','2h'];
 const tunnel=provider==='microsoft'?spawn(resolve(toolsDir,'devtunnel.exe'),microsoftArgs,{windowsHide:true,stdio:['ignore','pipe','pipe']}):spawn(resolve(toolsDir,'cloudflared.exe'),['tunnel','--url','http://127.0.0.1:3100','--protocol','http2','--no-autoupdate','--loglevel','info'],{windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(tunnel);
 let log='',url='',tunnelError=false;
 const capture=b=>{log=(log+b.toString()).slice(-20000);url=extractTunnelUrl(log,provider)||url;};
 tunnel.stderr.on('data',capture);tunnel.stdout.on('data',capture);tunnel.on('error',()=>{tunnelError=true;});
 const started=Date.now();while(!url&&Date.now()-started<40000&&!tunnelError&&tunnel.exitCode===null)await sleep(250);
 if(!url)throw new Error('TUNNEL_ADDRESS_UNAVAILABLE');
 console.log('Адрес получен. Проверяю доступность кабинета и защиту входа...');
 const env={...process.env,NODE_ENV:'production',DEMO_MODE:'false',PILOT_MODE:'true',HOST:'127.0.0.1',PORT:'3100',PUBLIC_URL:url,DATABASE_PATH:resolve(appDir,'data/pilot.sqlite'),BACKUP_DIRECTORY:resolve(appDir,'data/pilot-backups'),BOT_TOKEN:s.botToken,BOT_USERNAME:s.botUsername,ADMIN_IDS:s.ownerId,MANAGER_IDS:'',SESSION_SECRET:s.sessionSecret,TELEGRAM_WEBHOOK_SECRET:s.webhookSecret,AI_PROVIDER:'rules',AI_MODEL:'',GEMINI_API_KEY:'',THREADS_ACCESS_TOKEN:'',THREADS_USER_ID:'',BUSINESS_TIMEZONE:'Asia/Almaty'};
 const server=spawn(process.execPath,[resolve(toolsDir,'pilot-server.mjs')],{cwd:appDir,env,windowsHide:true,stdio:['pipe','pipe','pipe']});children.push(server);server.on('error',()=>{});server.stdout.on('data',()=>{});server.stderr.on('data',()=>{});
 let ready=false;const deadline=Date.now()+40000;
 while(Date.now()<deadline&&server.exitCode===null&&tunnel.exitCode===null){try{await verifyPublic(url);ready=true;break;}catch{await sleep(1000);}}
 if(!ready)throw new Error('PUBLIC_HTTPS_UNREACHABLE');
 const current=await botCall(s,'getWebhookInfo');if(current.url&&current.url!==webhook.url)throw new Error('WEBHOOK_CHANGED_DURING_SETUP');
 await writeFile(runtimePath,JSON.stringify({url,provider,startedAt:new Date().toISOString(),pid:process.pid,ready:false},null,2),{mode:0o600});
 await configureBot(s,url);
 server.stdin.write('enable-worker\n');
 await writeFile(runtimePath,JSON.stringify({url,provider,startedAt:new Date().toISOString(),pid:process.pid,ready:true},null,2),{mode:0o600});
 console.log('\nПриложение запущено: '+url+'\nОткройте https://t.me/'+s.botUsername+' и отправьте /start.\nКабинет менеджера и анкета кандидата открываются кнопкой бота.\nКомпьютер должен оставаться включённым. Для остановки — Ctrl+C.');
 await Promise.race(children.filter(child=>child.exitCode===null).map(child=>new Promise(done=>{child.once('exit',done);child.once('error',done);})));throw new Error('PILOT_PROCESS_STOPPED');
}catch(e){
 const messages={PUBLIC_HTTPS_UNREACHABLE:'Адрес '+(provider==='microsoft'?'Microsoft Dev Tunnels':'Cloudflare')+' пока недоступен извне. Настройки бота не менялись.',TUNNEL_ADDRESS_UNAVAILABLE:'Не удалось получить адрес '+(provider==='microsoft'?'Microsoft Dev Tunnels':'Cloudflare')+'. Настройки бота не менялись.',BOT_TOKEN_REVOKED:'Токен больше не действует. Запустите UGC-update-token.cmd и сохраните новый токен локально.',PILOT_LOCK_EXISTS:'Уже есть файл блокировки приложения. Не запускайте второй экземпляр. Если предыдущий процесс точно остановлен, удалите только sneg-ugc/data/pilot.lock.',BOT_ALREADY_CONNECTED_ELSEWHERE:'У бота уже есть другое подключение. Оно не изменено.',PORT_3100_BUSY:'Порт 3100 занят. Остановите предыдущий запуск.',TELEGRAM_NETWORK_ERROR:'Нет соединения с Telegram. Токен в ошибку не выводится.',DEVTUNNEL_LOGIN_FAILED:'Вход GitHub не завершён. Запустите файл ещё раз и подтвердите код на GitHub.',DEVTUNNEL_NOT_AVAILABLE:'Не найден официальный клиент tools/devtunnel.exe.'};
 const code=/^[A-Z0-9_]+$/.test(e.code||'')?e.code:(/^[A-Z0-9_]+$/.test(e.message)?e.message:'PILOT_SETUP_ERROR');
 console.error(messages[e.message]||'Запуск остановлен: '+code);process.exitCode=1;
}finally{await cleanup();}
