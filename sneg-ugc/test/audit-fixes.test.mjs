import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {date} from '../dist/ui.mjs';
import {Store} from '../server/store.mjs';
import {Service} from '../server/service.mjs';
import {Connections} from '../server/connections.mjs';
import {createWorker} from '../server/worker.mjs';
import {configuration,createApp} from '../server/index.mjs';
import {roleFor,canPublish,session} from '../server/auth.mjs';
import {clientAddress,RateLimiter} from '../server/http-support.mjs';
import {Maintenance} from '../server/maintenance.mjs';
import {DEFAULT_CAMPAIGN} from '../dist/domain.mjs';
import {blankDraft,loadDraft,saveDraft,clearDraft,mergeRows,loadWindow} from '../dist/state-storage.mjs';
const actor={id:'1001',role:'candidate',name:'Кандидат'},owner={id:'2001',role:'admin',name:'Владелец'};
const input=(extra={})=>({name:'Проверка',city:'Алматы',language:'kk',directions:['ugc'],experience:'brand',portfolio:['https://example.com/work'],adult:true,terms:true,consent:true,closeup:true,briefVersion:DEFAULT_CAMPAIGN.briefVersion,consentVersion:DEFAULT_CAMPAIGN.consentVersion,...extra});
function setup(extra={}){const store=new Store(),config={...configuration({DEMO_MODE:'true'}),adminIds:['2001'],managerIds:[],sessionSecret:'test-session-secret-more-than-thirty-two-characters',botToken:'fake-audit-token',aiDailyLimit:400,...extra},connections=new Connections(store,config),service=new Service(store,config,connections);return {store,config,connections,service};}
const add=(s,data=input())=>s.store.app(s.create(actor,data,randomUUID()).application.id);
const act=(s,u,a,action,payload={})=>s.store.app(s.action(u,a.id,{action,version:a.version,payload},randomUUID()).application.id);
const response=(data,ok=true)=>({ok,json:async()=>data});
async function mock(fn,run){const original=globalThis.fetch;globalThis.fetch=fn;try{return await run();}finally{globalThis.fetch=original;}}
test('черновик восстанавливается только своему аккаунту; новые условия снимают согласия',()=>{
 const map=new Map(),storage={getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)},c={...DEFAULT_CAMPAIGN};
 assert.equal(blankDraft().city,'');assert.equal(blankDraft().experience,'');saveDraft(storage,'1001',c,{...input(),portfolio:'https://example.com/work'},2);
 assert.equal(loadDraft(storage,'1001',c).draft.portfolio,'https://example.com/work');assert.equal(loadDraft(storage,'1002',c).draft.name,undefined);
 const fresh=loadDraft(storage,'1001',{...c,consentVersion:'changed'});assert.equal(fresh.draft.terms,false);assert.equal(fresh.draft.consent,false);assert.equal(fresh.draft.name,'Проверка');clearDraft(storage,'1001',c);assert.equal(loadDraft(storage,'1001',c).step,1);
});
test('обновление сохраняет все 80 строк; ошибка следующей страницы не сдвигает окно',async()=>{
 const data=Array.from({length:124},(_,i)=>({id:String(i+1)}));let fail=false;
 const list=async q=>{if(fail&&q.offset>=100)throw Error('offline');return {applications:data.slice(q.offset,q.offset+q.limit),total:data.length,hasMore:q.offset+q.limit<data.length};};
 const a=await loadWindow(list,{},80),b=await loadWindow(list,{},80);assert.equal(a.applications.length,80);assert.deepEqual(a.applications,b.applications);assert.equal(mergeRows(a.applications,a.applications).length,80);fail=true;await assert.rejects(loadWindow(list,{},120));assert.equal(a.applications[0].id,'1');
});
test('кандидат не получает внутреннюю историю, авторов, оценку или назначение',()=>{const {store,service:s}=setup();try{let a=add(s);a=act(s,owner,a,'note',{note:'Внутреннее'});a=act(s,owner,a,'claim');const result=s.sanitize(a,actor,true);for(const key of ['history','evaluation','owner','ownerName','approvedBy','reason'])assert.equal(result[key],undefined);assert.equal(result.name,'Проверка');}finally{store.close();}});
test('production игнорирует PILOT_MODE; старое согласие отклоняется с отдельным кодом',()=>{
 const {store,service:s}=setup({demo:false,production:true,pilot:true});try{assert.equal(s.publicCampaign(store.campaign()).ready,false);assert.throws(()=>add(s),{status:409});s.updateCampaign(owner,{operator:'Тестовый оператор',privacyUrl:'https://example.com/privacy',productionApproved:true});assert.equal(s.publicCampaign(store.campaign()).ready,true);assert.throws(()=>add(s),{code:'CONDITIONS_CHANGED'});const c=store.campaign();assert.equal(add(s,input({briefVersion:c.briefVersion,consentVersion:c.consentVersion})).status,'review');s.updateCampaign(owner,{privacyUrl:'https://example.com/new-policy'});assert.notEqual(store.campaign().consentVersion,c.consentVersion);}finally{store.close();}
});
test('сотрудник выдаётся и отзывается без env; Threads требует отдельного права',()=>{
 const {store,service:s,config}=setup();try{s.setMember(owner,{id:'3001',name:'Менеджер',confirmed:true});assert.equal(roleFor('3001',config,store),'manager');const manager={id:'3001',role:'manager'};assert.equal(canPublish(manager,store),false);assert.throws(()=>s.savePost(manager,{text:'Тестовый черновик'},randomUUID()),{status:403});s.setMember(owner,{id:'3001',publish:true,confirmed:true});assert.equal(canPublish(manager,store),true);s.setMember(owner,{id:'3001',active:false,confirmed:true});assert.equal(roleFor('3001',config,store),'candidate');assert.throws(()=>s.setMember(owner,{id:'2001',active:false,confirmed:true}));assert.throws(()=>s.setMember(manager,{id:'3002',confirmed:true}),{status:403});assert.equal(store.teamEvents().length,3);}finally{store.close();}
});
test('назначение не позволяет двум менеджерам одновременно принимать решения',()=>{const {store,service:s}=setup();try{let a=add(s);a=act(s,{id:'3001',role:'manager',name:'Первый'},a,'claim');s.setMember(owner,{id:'3001',confirmed:true});assert.throws(()=>act(s,{id:'3002',role:'manager'},a,'approve',{portfolioReviewed:true}),{code:'OWNER_CONFLICT'});a=act(s,owner,a,'release');assert.equal(a.owner,undefined);}finally{store.close();}});
test('редактирование анкеты переоценивает факты; отозванная анкета не редактируется',()=>{const {store,service:s}=setup();try{let a=add(s);a=act(s,actor,a,'edit',input({name:'Новое имя',portfolio:[]}));assert.equal(a.name,'Новое имя');assert.equal(a.evaluation.ugc,'clarify');a=act(s,actor,a,'withdraw');assert.throws(()=>act(s,actor,a,'edit',input()),{status:409});}finally{store.close();}});
test('уточнение до оценки не оставляет pending без задания после ответа',async()=>{const {store,config,connections,service:s}=setup({aiProvider:'gemini',aiModel:'fake',geminiKey:'fake'});try{let a=add(s);a=act(s,owner,a,'clarify',{question:'Пришлите пример?'});await createWorker(store,config,connections).tick();assert.equal(store.app(a.id).evaluation.aiStatus,'paused');a=act(s,actor,store.app(a.id),'answer',{answer:'Да, это пример'});assert.equal(a.evaluation.aiStatus,'pending');assert.ok(store.db.prepare("SELECT id FROM jobs WHERE kind='ai' AND status='pending'").get());}finally{store.close();}});
test('поздняя оценка старых критериев не применяется; актуальная остаётся в очереди',async()=>{
 const {store,config,connections,service:s}=setup({aiProvider:'gemini',aiModel:'fake',geminiKey:'fake'});try{const a=add(s,input({directions:['reach'],profile:'https://example.com/profile',views:1500,audienceKz:true}));let ready,release;const started=new Promise(r=>ready=r),pending=new Promise(r=>release=r);await mock(async()=>{ready();await pending;return response({candidates:[{content:{parts:[{text:JSON.stringify({recommendation:'recommend',summary:'OLD',reasons:[],unknowns:[],question:''})}]}}]});},async()=>{const tick=createWorker(store,config,connections).tick();await started;s.updateCampaign(owner,{minViews:100000});release();await tick;});const fresh=store.app(a.id);assert.equal(fresh.evaluation.reach,'clarify');assert.equal(fresh.evaluation.ai,undefined);assert.equal(fresh.evaluation.aiStatus,'pending');assert.ok(store.db.prepare("SELECT id FROM jobs WHERE kind='ai' AND status='pending'").get());}finally{store.close();}
});
test('заблокированный менеджер не задерживает Threads и получает backoff',async()=>{
 const {store,config,connections,service:s}=setup({demo:false,pilot:true,managerIds:['3001'],threadsToken:'fake',threadsUserId:'account'});try{add(s);store.savePost({id:'post',campaignId:DEFAULT_CAMPAIGN.id,status:'scheduled',scheduledAt:new Date(Date.now()-1000).toISOString(),accountId:'account',text:'Тест'});let calls=0;await mock(async(url,o)=>{if(String(url).includes('api.telegram.org'))return String(JSON.parse(o.body).chat_id)==='3001'?response({ok:false,error_code:403},false):response({ok:true,result:{message_id:1}});calls++;return response({id:'remote'});},()=>createWorker(store,config,connections).tick());assert.equal(store.posts()[0].status,'published');assert.ok(calls>=2);assert.equal(store.meta('delivery_error:3001'),'TELEGRAM_BLOCKED');assert.ok(Number(store.meta('delivery_retry:3001'))>Date.now());}finally{store.close();}
});
test('повтор операции сохранения с новым transport key не дублирует scheduled пост',()=>{const {store,service:s}=setup({threadsToken:'fake',threadsUserId:'account'});try{const payload={text:'Тест расписания публикаций',status:'scheduled',scheduledAt:new Date(Date.now()+3600000).toISOString(),operationId:randomUUID()};const a=s.savePost(owner,payload,randomUUID()),b=s.savePost(owner,payload,randomUUID());assert.equal(a.post.id,b.post.id);assert.equal(store.posts().length,1);}finally{store.close();}});
test('IP клиента берётся только из доверенной границы; лимиты пользователей независимы',()=>{
 const req={headers:{'x-real-ip':'198.51.100.1'},socket:{remoteAddress:'127.0.0.1'}};assert.equal(clientAddress(req,{trustRailwayProxy:false}),'127.0.0.1');assert.equal(clientAddress(req,{trustRailwayProxy:true}),'198.51.100.1');const limiter=new RateLimiter();for(let i=0;i<600;i++)limiter.check('user:1');assert.throws(()=>limiter.check('user:1'),{status:429});assert.doesNotThrow(()=>limiter.check('user:2'));
});
test('SQL-пагинация и глобальный поиск сохраняют семантику на накопленных данных',()=>{
 const {store,service:s}=setup();try{const a=add(s);store.tx(()=>{for(let i=2;i<=2400;i++)store.save({...a,id:'SN-'+String(i).padStart(4,'0'),telegramId:String(i+10000),name:i===1500?'Сложное Имя':'Кандидат '+i});});store.all=()=>{throw Error('Unbounded JS scan forbidden');};const page=s.list(owner,{bucket:'all_new',limit:80});assert.equal(page.applications.length,80);assert.equal(page.total,2400);assert.equal(s.overview(owner).total,2400);assert.equal(s.list(owner,{q:'сложное имя',queue:'selected'}).applications[0].id,'SN-1500');assert.equal(s.list(owner,{q:'sn 1500'}).total,1);}finally{store.close();}
});
test('ежедневная копия проверяется; очистка закрытых анкет требует утверждения владельца',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sneg-maintenance-'));const store=new Store(join(dir,'db.sqlite')),config={...configuration({DEMO_MODE:'true'}),databasePath:join(dir,'db.sqlite'),backupDirectory:join(dir,'backups')},m=new Maintenance(store,config);
 try{const copy=await m.createBackup();assert.ok(copy.name.endsWith('.sqlite'));assert.equal((await m.files()).length,1);const c=store.campaign(),service=new Service(store,{...config,demo:true});let a=add(service);a.status='rejected';a.updatedAt='2020-01-01T00:00:00Z';store.save(a);m.clean();assert.ok(store.app(a.id));store.saveCampaign({...c,productionApproved:true,operator:'Тест',privacyUrl:'https://example.com/privacy',retentionEnabled:true});m.clean();assert.equal(store.app(a.id),null);}finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('ручная сверка needs_check возвращает черновик, повтор не публикует его',async()=>{
 const {store,config}=setup();store.savePost({id:'post',status:'needs_check',campaignId:DEFAULT_CAMPAIGN.id,text:'Тест'});const app=createApp(config,store);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 try{let r=await fetch(base+'/api/posts/post/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({outcome:'absent',confirmed:true,version:1})});assert.equal(r.status,200);assert.equal(store.posts()[0].status,'draft');r=await fetch(base+'/api/posts/post/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({outcome:'absent',confirmed:true,version:1})});assert.equal(r.status,409);}finally{await new Promise(r=>app.server.close(r));store.close();}
});

test('SNEG открывает набор с коротким объяснением без внешней политики',()=>{
 const {store,service:s}=setup({demo:false,production:true,pilot:true});try{s.updateCampaign(owner,{operator:'SNEG',privacyUrl:'',privacyText:'SNEG использует ответы для отбора креаторов и связи в Telegram.',productionApproved:true});const c=store.campaign();assert.equal(s.publicCampaign(c).ready,true);assert.equal(s.publicCampaign(c).pilot,false);assert.equal(add(s,input({briefVersion:c.briefVersion,consentVersion:c.consentVersion})).status,'review');}finally{store.close();}
});

test('смена критериев пересчитывает каждую анкету, даже когда сортировка меняется',()=>{
 const {store,service:s}=setup();try{const a=add(s,input({directions:['reach'],profile:'https://example.com/profile',views:1500,audienceKz:true}));store.tx(()=>{for(let i=2;i<=240;i++)store.save({...a,id:'SN-'+String(i).padStart(4,'0'),telegramId:String(10000+i),views:i%2?1000:100000});});s.updateCampaign(owner,{minViews:90000});const rows=store.queryApplications({status:'review',limit:500}).applications;assert.equal(rows.length,240);assert.ok(rows.every(a=>a.version===2));assert.equal(rows.filter(a=>a.evaluation.reach==='recommended').length,120);}finally{store.close();}
});

test('сохранённая операция защищена от другого текста и повторов после редактирования',()=>{
 const {store,service:s}=setup();try{const payload={text:'Первая версия публикации',operationId:randomUUID()},first=s.savePost(owner,payload,randomUUID());assert.throws(()=>s.savePost(owner,{...payload,text:'Другой текст'},randomUUID()),{code:'OPERATION_CONFLICT'});s.savePost(owner,{...payload,id:first.post.id,version:first.post.version,text:'Вторая версия публикации',operationId:randomUUID()},randomUUID());const retry=s.savePost(owner,payload,randomUUID());assert.ok(retry.post.text.startsWith('Вторая версия публикации'));assert.equal(store.posts().length,1);}finally{store.close();}
});

test('список публикаций использует часовой пояс устройства во всех проверенных зонах',()=>{
 const original=process.env.TZ;try{for(const [zone,time]of [['Asia/Bishkek','18:30'],['Europe/London','12:30'],['America/New_York','08:30']]){process.env.TZ=zone;assert.ok(date('2026-10-28T12:30:00Z').includes(time),zone);}assert.equal(date('not-a-date'),'');}finally{if(original===undefined)delete process.env.TZ;else process.env.TZ=original;}
});

test('выдача и отзыв прав применяются к уже открытой HTTP-сессии без рестарта',async()=>{
 const {store,config,service:s}=setup({demo:false,pilot:true}),app=createApp(config,store);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port,headers={'x-ugc-session':session({id:'3001'},config.sessionSecret)};
 try{assert.equal((await fetch(base+'/api/overview',{headers})).status,403);s.setMember(owner,{id:'3001',confirmed:true});assert.equal((await fetch(base+'/api/overview',{headers})).status,200);assert.equal((await fetch(base+'/api/posts',{headers})).status,403);s.setMember(owner,{id:'3001',publish:true,confirmed:true});assert.equal((await fetch(base+'/api/posts',{headers})).status,200);s.setMember(owner,{id:'3001',active:false,confirmed:true});assert.equal((await fetch(base+'/api/overview',{headers})).status,403);}finally{await new Promise(r=>app.server.close(r));store.close();}
});

test('сверка опубликованного поста проверяет ссылку среди публикаций подключённого профиля',async()=>{
 const {store,config}=setup({threadsToken:'fake',threadsUserId:'own-account'}),app=createApp(config,store);store.savePost({id:'post',status:'needs_check',text:'Тест'});app.connections.graph=async(path)=>{assert.ok(path.includes('/own-account/threads'));return {data:[{id:'own-post',permalink:'https://www.threads.com/@test/post/own'}]};};await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port,send=permalink=>fetch(base+'/api/posts/post/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({outcome:'published',permalink,confirmed:true,version:1})});
 try{assert.equal((await send('invalid')).status,400);assert.equal((await send('https://www.threads.com/@other/post/foreign')).status,400);assert.equal(store.posts().find(p=>p.id==='post').status,'needs_check');assert.equal((await send('https://www.threads.com/@test/post/own')).status,200);assert.equal(store.posts().find(p=>p.id==='post').remoteId,'own-post');}finally{await new Promise(r=>app.server.close(r));store.close();}
});

test('миграция старых технических таблиц сохраняет уже записанные операции',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sneg-migration-')),path=join(dir,'legacy.sqlite');let store;try{const db=new DatabaseSync(path);db.exec("CREATE TABLE idempotency(scope TEXT,key TEXT,hash TEXT,result TEXT,PRIMARY KEY(scope,key)); CREATE TABLE updates(id INTEGER PRIMARY KEY); INSERT INTO updates VALUES(123); INSERT INTO idempotency VALUES('1001','original','hash','{\"ok\":true}')");db.close();store=new Store(path);assert.equal(store.db.prepare('SELECT id FROM updates').get().id,123);assert.equal(store.cached('1001','original').result.ok,true);assert.ok(store.db.prepare('SELECT created_at FROM updates').get().created_at);assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('потерянный сетевой ответ сохраняет transport key до подтверждённого повтора',async()=>{
 const original={document:globalThis.document,window:globalThis.window,localStorage:globalThis.localStorage},map=new Map(),keys=[];globalThis.document={documentElement:{dataset:{mode:'server'}}};globalThis.window={};globalThis.localStorage={getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
 try{await mock(async(path,options)=>{if(path==='/api/session')return response({user:{id:'1001',role:'candidate'},connections:{demo:false}});keys.push(options.headers['idempotency-key']);if(keys.length===1)throw Error('connection lost after commit');return response({post:{id:'once'}});},async()=>{const {api}=await import('../dist/api.mjs?network-test='+randomUUID());await api.session();const payload={text:'Черновик для проверки'};await assert.rejects(()=>api.savePost(payload),{code:'NETWORK_UNKNOWN'});await api.savePost(payload);assert.equal(keys[0],keys[1]);assert.equal(map.size,0);});}finally{for(const [k,v]of Object.entries(original))if(v===undefined)delete globalThis[k];else globalThis[k]=v;}
});

test('повтор задания требует владельца и подтверждения и не ставится дважды',()=>{
 const {store,service:s}=setup();try{store.enqueue('telegram',{chatId:'1001',text:'Вымышленное сообщение'});const job=store.jobs()[0];store.updateJob(job.id,'failed',5,'TELEGRAM_UNAVAILABLE');assert.throws(()=>s.retryJob({id:'3001',role:'manager'},job.id,{confirmed:true}),{status:403});assert.throws(()=>s.retryJob(owner,job.id),{status:400});assert.equal(s.retryJob(owner,job.id,{confirmed:true}).queued,true);assert.throws(()=>s.retryJob(owner,job.id,{confirmed:true}),{status:409});assert.equal(store.jobs()[0].attempts,0);}finally{store.close();}
});
