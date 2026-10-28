import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,dirname,extname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Store} from './store.mjs';
import {Service} from './service.mjs';
import {Connections} from './connections.mjs';
import {equal,validateTelegram,session,readSession,roleFor,canPublish} from './auth.mjs';
import {clientAddress,RateLimiter} from './http-support.mjs';
import {queueEvaluation} from './ai-state.mjs';
import {queueTelegramUpdate,analyze} from './integrations.mjs';
import {createWorker} from './worker.mjs';
import {createFixtures} from '../dist/fixtures.mjs';
import {AppError,assert} from '../dist/domain.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const ids=v=>String(v||'').split(',').map(x=>x.trim()).filter(x=>/^\d+$/.test(x));
export function configuration(env=process.env){
 const production=env.NODE_ENV==='production',demo=env.DEMO_MODE===undefined?!production:env.DEMO_MODE==='true',port=Number(env.PORT)||3000;
 const c={production,demo,trustRailwayProxy:env.TRUST_RAILWAY_PROXY==='true'||!!env.RAILWAY_ENVIRONMENT_ID,backupDirectory:env.BACKUP_DIRECTORY?resolve(root,env.BACKUP_DIRECTORY):undefined,pilot:env.PILOT_MODE==='true',canonicalUrl:String(env.CANONICAL_URL||'').replace(/\/$/,''),port,host:env.HOST||'127.0.0.1',publicUrl:(env.PUBLIC_URL||'http://127.0.0.1:'+port).replace(/\/$/,''),databasePath:resolve(root,env.DATABASE_PATH||'data/'+(demo?'demo':'ugc')+'.sqlite'),botToken:env.BOT_TOKEN||'',botUsername:env.BOT_USERNAME||'',webhookSecret:env.TELEGRAM_WEBHOOK_SECRET||'',sessionSecret:env.SESSION_SECRET||'local-demo-only',integrationSecret:env.INTEGRATION_SECRET||env.SESSION_SECRET||'local-demo-only',adminIds:ids(env.ADMIN_IDS),managerIds:ids(env.MANAGER_IDS),aiProvider:env.AI_PROVIDER||'rules',aiModel:env.AI_MODEL||'',ollamaUrl:env.OLLAMA_URL||'http://127.0.0.1:11434',geminiKey:env.GEMINI_API_KEY||'',aiDailyLimit:Math.max(1,Number(env.AI_DAILY_LIMIT)||400),threadsToken:env.THREADS_ACCESS_TOKEN||'',threadsUserId:env.THREADS_USER_ID||'',timezone:env.BUSINESS_TIMEZONE||'Asia/Almaty',workerInterval:Math.max(1000,Number(env.WORKER_INTERVAL_MS)||2000),aiMinInterval:Math.max(5000,Number(env.AI_MIN_INTERVAL_MS)||5000)};
 assert(['rules','ollama','gemini'].includes(c.aiProvider),'AI_PROVIDER: rules, ollama или gemini');if(c.canonicalUrl){let target;try{target=new URL(c.canonicalUrl);}catch{throw new AppError('CANONICAL_URL должен быть HTTPS-адресом кабинета');}assert(target.protocol==='https:'&&!target.username&&!target.password&&target.pathname==='/'&&!target.search&&!target.hash&&target.origin!==new URL(c.publicUrl).origin,'CANONICAL_URL должен вести на другой HTTPS-адрес кабинета');c.canonicalUrl=target.origin;}if(production){assert(!demo,'В production запрещён DEMO_MODE=true');if(!c.canonicalUrl)assert(c.botToken&&c.webhookSecret.length>=24&&c.sessionSecret.length>=32&&c.adminIds.length,'Заполните токен бота, ID владельца и два разных секрета');assert(c.publicUrl.startsWith('https://'),'PUBLIC_URL должен использовать HTTPS');}return c;
}
export function createApp(config,providedStore){
 if(config.canonicalUrl){
  // An old deployment may forward to the active cabinet, without opening its database or running a worker.
  const server=http.createServer((req,res)=>{
   res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
   let url;try{url=new URL(req.url,'https://alias.invalid');}catch{res.writeHead(400);res.end();return;}
   if(url.pathname==='/healthz'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,forwarding:true}));return;}
   if(url.pathname.startsWith('/api/')||!['GET','HEAD'].includes(req.method)){
    res.writeHead(409,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:'Кабинет обновлён. Откройте его через бота ещё раз.',code:'MOVED_TO_CANONICAL',canonicalUrl:config.canonicalUrl}));return;
   }
   res.writeHead(302,{location:config.canonicalUrl+url.pathname+url.search});res.end();
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  return {server,store:null,service:null,worker:{tick:async()=>{}},connections:null};
 }
 const store=providedStore||new Store(config.databasePath),connections=new Connections(store,config),service=new Service(store,config,connections),worker=createWorker(store,config,connections),rate=new RateLimiter();
 if(config.demo&&!store.meta('demo_seeded'))store.tx(()=>{const f=createFixtures();store.saveCampaign(f.campaign);for(const a of f.applications)store.save(a);for(const p of f.posts)store.savePost(p);store.setMeta('sequence','32');store.setMeta('demo_seeded','1');});
 store.db.prepare("UPDATE posts SET status='needs_check',data=json_set(data,'$.status','needs_check','$.version',COALESCE(json_extract(data,'$.version'),1)+1,'$.error','Запуск прервался во время публикации. Проверьте аккаунт перед повтором.') WHERE status='publishing'").run();
 function currentUser(req){if(config.demo)return {id:req.headers['x-demo-role']==='candidate'?'demo-candidate':'demo-manager',name:'Вы',role:req.headers['x-demo-role']==='candidate'?'candidate':'admin'};const cookies=Object.fromEntries(String(req.headers.cookie||'').split(';').map(x=>x.trim().split('='))),token=req.headers['x-ugc-session']===undefined?cookies.ugc_session:req.headers['x-ugc-session'],u=readSession(token,config.sessionSecret);if(!u)rate.check('anonymous:'+clientAddress(req,config),120);assert(u,'Откройте приложение через Telegram',401,'AUTH_REQUIRED');const role=roleFor(u.id,config,store);return {...u,role,permissions:{publish:canPublish({...u,role},store)}};}
 async function body(req){let n=0;const parts=[];for await(const p of req){n+=p.length;assert(n<=65536,'Слишком большой запрос',413);parts.push(p);}try{return JSON.parse(Buffer.concat(parts).toString()||'{}');}catch{throw new AppError('Не удалось прочитать запрос');}}
 function json(res,status,data,headers={}){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});res.end(JSON.stringify(data));}
 const server=http.createServer(async(req,res)=>{
  res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','same-origin');res.setHeader('permissions-policy','camera=(), microphone=(), geolocation=()');const requestId=randomUUID();res.setHeader('x-request-id',requestId);
  try{
   const url=new URL(req.url,config.publicUrl),path=url.pathname;
   if(path==='/healthz'){json(res,200,{ok:true});return;}
   if(path==='/auth/threads/callback'){
    let message,ok=false;try{await connections.callback(url.searchParams);ok=true;message='Threads подключён. Вернитесь в Telegram — аккаунт уже появится в кабинете.';}catch(e){message=e instanceof AppError?e.message:'Не удалось подключить Threads. Начните снова в кабинете.';}
    const safe=message.replace(/[<>&"]/g,'');res.writeHead(ok?200:400,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'"});res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SNEG · Threads</title><body style="background:#f4f0e7;color:#303b34;font:20px Georgia;padding:12vh 8vw"><p>SNEG / THREADS</p><h1>'+safe+'</h1><p>Эту вкладку можно закрыть.</p></body>');return;
   }
   if(path==='/telegram/webhook'&&req.method==='POST'){assert(!config.demo&&config.webhookSecret&&equal(req.headers['x-telegram-bot-api-secret-token']||'',config.webhookSecret),'Webhook недоступен',403);json(res,200,queueTelegramUpdate(store,await body(req),config));return;}
   if(path==='/api/public'&&req.method==='GET'){json(res,200,{campaign:service.publicCampaign(store.campaign()),botUsername:config.botUsername,pilot:!!config.pilot});return;}
   if(path.startsWith('/api/')){
    if(path==='/api/auth')rate.check('login:'+clientAddress(req,config),120);
    if(req.method!=='GET'){assert(!req.headers.origin||req.headers.origin===new URL(config.publicUrl).origin,'Источник запроса не разрешён',403);assert(String(req.headers['content-type']||'').startsWith('application/json'),'Требуется JSON',415);}
    if(path==='/api/auth'&&req.method==='POST'){assert(!config.demo,'В демо вход не требуется');const b=await body(req),u=validateTelegram(b.initData,config.botToken),token=session(u,config.sessionSecret);json(res,200,{user:{...u,role:roleFor(u.id,config,store)},session:token},{'set-cookie':'ugc_session='+token+'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200'});return;}
    const u=currentUser(req),key=String(req.headers['idempotency-key']||'');rate.check('user:'+u.id);
    if(path==='/api/session'&&req.method==='GET'){json(res,200,{user:u,connections:u.role==='candidate'?{demo:config.demo}:service.health(),botUsername:config.botUsername});return;}
    if(path==='/api/campaign'&&req.method==='GET'){json(res,200,{campaign:service.publicCampaign(store.campaign())});return;}
    if(path==='/api/campaign'&&req.method==='PATCH'){json(res,200,service.updateCampaign(u,await body(req)));return;}
    if(path==='/api/me'&&req.method==='GET'){json(res,200,{applications:store.mine(u.id).map(a=>service.sanitize(a,u,true))});return;}
    if(path==='/api/applications'&&req.method==='POST'){assert(u.role==='candidate'||config.demo,'Анкета предназначена для кандидата',403);json(res,201,service.create(u,await body(req),key));return;}
    if(path==='/api/applications'&&req.method==='GET'){json(res,200,service.list(u,Object.fromEntries(url.searchParams)));return;}
    if(path==='/api/overview'&&req.method==='GET'){json(res,200,service.overview(u));return;}
    if(path==='/api/connections'&&req.method==='GET'){service.manager(u);json(res,200,{connections:service.health(),jobs:u.role==='admin'?store.jobs():[]});return;}
    if(path.startsWith('/api/integrations/')){
     assert(req.method==='POST','Метод недоступен',405);assert(u.role==='admin'&&!config.demo,'Подключения настраиваются владельцем в рабочем кабинете',403);const b=await body(req);let result;
     if(path==='/api/integrations/threads/app')result=connections.configureApp(b);
     else if(path==='/api/integrations/threads/token')result=await connections.connectToken(b.token);
     else if(path==='/api/integrations/threads/authorize'){json(res,200,{url:connections.authorize(u.id)});return;}
     else if(path==='/api/integrations/threads/disconnect'){connections.remove('threads');result=service.health();}
     else if(path==='/api/integrations/ai'){
      result=await connections.connectAI(b,analyze);
      for(const row of store.db.prepare("SELECT data FROM applications WHERE status='review' AND json_extract(data,'$.evaluation.ai') IS NULL").all())queueEvaluation(store,JSON.parse(row.data),connections.config());
     }
     else throw new AppError('Подключение не найдено',404);
     json(res,200,{connections:result});return;
    }
    if(path==='/api/team'&&req.method==='GET'){json(res,200,service.team(u));return;}
    if(path==='/api/team'&&req.method==='POST'){json(res,200,service.setMember(u,await body(req)));return;}
    if(path==='/api/operations'&&req.method==='GET'){
     service.owner(u);const jobs=store.jobs(),oldest=store.db.prepare("SELECT min(created_at) at FROM jobs WHERE status='pending'").get().at;
     const phases=['interactive','ai','threads','maintenance'].map(name=>({name,lastAttempt:null,lastSuccess:null,error:'',...JSON.parse(store.meta('worker:phase:'+name)||'{}')}));
     json(res,200,{phases,jobs,oldestPendingAt:oldest||null,backup:JSON.parse(store.meta('backup:last')||'{}'),backupError:store.meta('backup:error')||'',backups:await worker.maintenance.files(),lastMaintenance:store.meta('maintenance:last')||null,lastAi:store.meta('ai:last_ok')||null,lastWorker:phases[0].lastSuccess,team:service.team(u).members,retentionEnabled:!!store.campaign().retentionEnabled,threadsError:connections.status().threadsError,ready:service.ready(store.campaign())});return;
    }
    if(path==='/api/maintenance/backup'&&req.method==='POST'){service.owner(u);json(res,200,await worker.maintenance.createBackup());return;}
    const download=path.match(/^\/api\/backups\/([a-zA-Z0-9.\-]+)$/);
    if(download&&req.method==='GET'){service.owner(u);const file=worker.maintenance.file(download[1]),content=await readFile(file).catch(()=>null);assert(content,'Копия не найдена',404);res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store','content-disposition':'attachment; filename="'+download[1]+'"'});res.end(content);return;}
    const retry=path.match(/^\/api\/jobs\/(\d+)\/retry$/);
    if(retry&&req.method==='POST'){json(res,200,service.retryJob(u,retry[1],await body(req)));return;}
    const aiRetry=path.match(/^\/api\/applications\/([A-Z0-9-]+)\/retry-ai$/);
    if(aiRetry&&req.method==='POST'){json(res,200,service.retryAI(u,aiRetry[1]));return;}
    const resolvePost=path.match(/^\/api\/posts\/([\w-]+)\/resolve$/);
    if(resolvePost&&req.method==='POST'){
     service.publisher(u);const input=await body(req),post=store.posts().find(p=>p.id===resolvePost[1]);assert(post?.status==='needs_check','Пост уже проверен или не требует сверки',409);assert(Number(input.version)===(post.version||1),'Публикация изменилась. Обновите её.',409,'VERSION_CONFLICT');assert(input.confirmed===true,'Подтвердите проверку профиля');
     let result={status:'draft',accountId:null,error:'',scheduledAt:null};
     if(input.outcome==='published'){
      let target;try{target=new URL(String(input.permalink||''));}catch{throw new AppError('Укажите ссылку на пост Threads');}assert(target.protocol==='https:'&&/^(www\.)?threads\.(com|net)$/.test(target.hostname),'Укажите ссылку на пост Threads');target.hash='';target.search='';
      const c=connections.config();assert(c.threadsToken&&c.threadsUserId,'Подключите аккаунт Threads');let after='',found;
      for(let i=0;i<3&&!found;i++){const page=await connections.graph('/v1.0/'+c.threadsUserId+'/threads',c.threadsToken,{fields:'id,permalink',limit:100,...(after?{after}:{})});found=page.data?.find(p=>String(p.permalink).replace(/\/$/,'')===target.href.replace(/\/$/,''));after=page.paging?.cursors?.after;if(!page.paging?.next||!after)break;}
      assert(found,'Ссылка не найдена среди последних публикаций подключённого аккаунта');result={status:'published',remoteId:found.id,permalink:found.permalink,error:'',publishedAt:new Date().toISOString()};
     }else assert(input.outcome==='absent','Выберите результат проверки');
     const latest=store.posts().find(p=>p.id===post.id);assert(latest.status==='needs_check'&&(latest.version||1)===Number(input.version),'Пост уже проверен другим сотрудником',409,'VERSION_CONFLICT');const saved={...latest,...result,resolvedBy:u.id,resolvedAt:new Date().toISOString(),version:(latest.version||1)+1};store.savePost(saved);json(res,200,{post:saved});return;
    }

    if(path==='/api/shortlist'&&req.method==='POST'){service.manager(u);store.setMeta('shortlist_dirty','1');store.setMeta('shortlist_last','0');json(res,200,{queued:true});return;}
    if(path==='/api/posts'&&req.method==='GET'){service.publisher(u);json(res,200,{posts:store.posts()});return;}
    if(path==='/api/posts'&&req.method==='POST'){json(res,200,service.savePost(u,await body(req),key));return;}
    const postRoute=path.match(/^\/api\/posts\/([\w-]+)\/(publish|cancel)$/);
    if(postRoute&&req.method==='POST'){
     service.publisher(u);const input=await body(req);
     const result=service.idem(u,key,{postId:postRoute[1],action:postRoute[2],version:input.version,accountId:input.accountId},()=>{
      const p=store.posts().find(p=>p.id===postRoute[1]);assert(p,'Пост не найден',404);
      assert(Number(input.version)===(p.version||1),'Публикация изменилась. Проверьте актуальный текст.',409,'VERSION_CONFLICT');
      assert(['draft','scheduled','failed'].includes(p.status),'Пост уже публикуется или опубликован',409);
      if(postRoute[2]==='publish'){
       assert(service.health().threads,'Сначала подключите Threads');
       assert(input.accountId===undefined||String(input.accountId)===String(connections.config().threadsUserId),'Аккаунт Threads изменился. Проверьте его перед публикацией.',409,'VERSION_CONFLICT');
       p.status='scheduled';p.scheduledAt=new Date().toISOString();p.accountId=connections.config().threadsUserId;
      }else{p.status='draft';p.accountId=null;p.scheduledAt=null;}
      p.version=(p.version||1)+1;p.updatedAt=new Date().toISOString();store.savePost(p);return {post:p,queued:postRoute[2]==='publish'};
     });json(res,200,result);return;
    }
    const match=path.match(/^\/api\/applications\/([A-Z0-9-]+)(?:\/(actions))?$/);if(match){const a=store.app(match[1]);assert(a,'Заявка не найдена',404);if(req.method==='GET'&&!match[2]){if(u.role==='candidate')assert(a.telegramId===u.id,'Нет доступа',403);else service.manager(u);json(res,200,{application:service.sanitize(a,u,true)});return;}if(req.method==='POST'&&match[2]){json(res,200,service.action(u,a.id,await body(req),key));return;}}
    throw new AppError('Маршрут не найден',404);
   }
   assert(['GET','HEAD'].includes(req.method),'Метод недоступен',405);const requested=decodeURIComponent(path),file=resolve(root,'dist',['/','/apply'].includes(requested)?'index.html':'.'+requested),dist=resolve(root,'dist');assert(file.startsWith(dist+sep),'Нет доступа',403);const info=await stat(file).catch(()=>null);assert(info?.isFile(),'Страница не найдена',404);let content=await readFile(file);if(extname(file)==='.html')content=Buffer.from(content.toString().replace('data-mode="demo"','data-mode="server"'));const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.ttf':'font/ttf','.woff2':'font/woff2'};res.setHeader('content-security-policy',"default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'");res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream','cache-control':extname(file)==='.html'?'no-store':'public,max-age=60'});res.end(req.method==='HEAD'?undefined:content);
  }catch(e){const status=e instanceof AppError?e.status:500;if(status===500)console.error(JSON.stringify({event:'request_error',requestId,code:'INTERNAL_ERROR'}));if(!res.headersSent)json(res,status,{error:status===500?'Не удалось выполнить действие. Попробуйте ещё раз.':e.message,code:e.code||'INTERNAL_ERROR',requestId});else res.end();}
 });
 server.requestTimeout=30000;server.headersTimeout=10000;return {server,store,service,worker,connections};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const c=configuration(),a=createApp(c);a.server.listen(c.port,c.host,()=>console.log('SNEG: http://'+c.host+':'+c.port));const timer=c.canonicalUrl?null:setInterval(()=>a.worker.tick().catch(()=>console.error('WORKER_ERROR')),c.workerInterval);timer?.unref();for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{clearInterval(timer);a.server.close(()=>{a.store?.close();process.exit(0);});});}
