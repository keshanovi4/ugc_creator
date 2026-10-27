import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {Service} from '../server/service.mjs';
import {Connections,THREADS_AUTH} from '../server/connections.mjs';
import {createApp,configuration} from '../server/index.mjs';
import {validateTelegram,session,readSession,roleFor} from '../server/auth.mjs';
import {normalizeApplication,evaluate,DEFAULT_CAMPAIGN} from '../dist/domain.mjs';
import {aiFacts,analyze,queueTelegramUpdate} from '../server/integrations.mjs';
import {createWorker,publishThread} from '../server/worker.mjs';
import {createBackup} from '../scripts/backup.mjs';

const user={id:'1001',role:'candidate',name:'Тестовый кандидат'};
const manager={id:'2001',role:'admin',name:'Менеджер'};
const input=(overrides={})=>({name:'Тестовый кандидат',city:'Алматы',language:'kk',directions:['ugc'],portfolio:['https://example.com/video'],experience:'brand',closeup:true,adult:true,terms:true,consent:true,availabilityDays:7,...overrides});
const config=(overrides={})=>({...configuration({DEMO_MODE:'true'}),...overrides});
function setup(overrides={}){const store=new Store(),c=config(overrides),connections=new Connections(store,c);return {store,c,connections,service:new Service(store,c,connections)};}
const add=(s,u=user,p=input())=>s.create(u,p,randomUUID()).application;
const act=(s,u,a,action,payload={})=>s.action(u,a.id,{action,payload,version:a.version},randomUUID()).application;
const response=(data,ok=true)=>({ok,json:async()=>data});
async function mockedFetch(mock,fn){const original=globalThis.fetch;globalThis.fetch=mock;try{return await fn();}finally{globalThis.fetch=original;}}

test('UGC: подписчики и казахский язык не снижают приоритет',()=>{
 const a=evaluate(normalizeApplication(input({followers:0}))),b=evaluate(normalizeApplication(input({followers:1000000})));
 assert.equal(a.ugc,'recommended');assert.equal(a.ugc,b.ugc);assert.equal(a.languageMatch,true);assert.equal(a.portfolioVerified,false);
});
test('UGC и охваты независимы; для охватов нужна статистика и аудитория',()=>{
 const a=normalizeApplication(input({directions:['ugc','reach'],profile:'https://example.com/profile'}));
 assert.equal(evaluate(a).ugc,'recommended');assert.equal(evaluate(a).reach,'clarify');
 assert.equal(evaluate({...a,views:1500,audienceKz:true}).reach,'recommended');
});
test('неполные анкеты, чужие протоколы и отрицательная статистика отклоняются',()=>{
 for(const p of [{consent:false},{adult:false},{closeup:false},{directions:[]},{portfolio:['javascript:alert(1)']},{portfolio:['https://127.0.0.1/v']},{views:-1},{directions:['reach'],profile:''}])assert.throws(()=>normalizeApplication(input(p)));
});
test('одна анкета на человека и кампанию; повтор запроса не создаёт события',()=>{
 const {store,service:s}=setup();try{const key=randomUUID(),a=s.create(user,input(),key),again=s.create(user,input(),key);assert.deepEqual(again,a);assert.equal(add(s).id,a.application.id);assert.equal(store.all().length,1);assert.equal(store.events(a.application.id).length,1);assert.throws(()=>s.create(user,input({name:'Другое имя'}),key),{status:409});}finally{store.close();}
});
test('цепочка уточнение → ответ → выбор → ручная отметка отправки',()=>{
 const {store,service:s}=setup();try{let a=add(s);a=act(s,manager,a,'clarify',{question:'Есть разговорный ролик?'});assert.equal(a.status,'clarification');a=act(s,user,a,'answer',{answer:'Да, добавлю ссылку'});assert.equal(a.status,'review');a=act(s,manager,a,'approve',{portfolioReviewed:true});assert.equal(a.status,'approved');a=act(s,manager,a,'mark_sent',{confirmed:true});assert.equal(a.status,'sent');assert.equal(a.shipment,undefined);assert.equal(a.shippingAddress,undefined);}finally{store.close();}
});
test('просмотр портфолио и ручное подтверждение отправки обязательны',()=>{
 const {store,service:s}=setup();try{let a=add(s);assert.throws(()=>act(s,manager,a,'approve'),{status:400});assert.throws(()=>act(s,manager,a,'mark_sent',{confirmed:true}),{status:409});a=act(s,manager,a,'approve',{portfolioReviewed:true});assert.throws(()=>act(s,manager,a,'mark_sent'),{status:400});}finally{store.close();}
});
test('старые операции логистики отсутствуют; старые адреса не выдаются',()=>{
 const {store,service:s}=setup();try{const a=add(s);for(const action of ['address','ship','receive','submit_content'])assert.throws(()=>act(s,manager,a,action));a.shippingAddress={phone:'private'};a.shipment={track:'private'};a.content={url:'private'};const safe=s.sanitize(a,manager,true);for(const key of ['shippingAddress','shipment','content'])assert.equal(safe[key],undefined);}finally{store.close();}
});
test('конфликт двух менеджеров возвращает 409 и не меняет решение',()=>{
 const {store,service:s}=setup();try{const a=add(s);act(s,manager,a,'approve',{portfolioReviewed:true});assert.throws(()=>act(s,{...manager,id:'2002'},a,'reject'),{status:409});assert.equal(store.app(a.id).status,'approved');}finally{store.close();}
});
test('кандидат не может одобрить себя, изменить чужую заявку или открыть очередь',()=>{
 const {store,service:s}=setup();try{const a=add(s);assert.throws(()=>act(s,user,a,'approve',{portfolioReviewed:true}),{status:403});assert.throws(()=>act(s,{...user,id:'999'},a,'answer',{answer:'Чужой ответ'}),{status:403});assert.throws(()=>s.list(user),{status:403});}finally{store.close();}
});
test('лимит кампании не допускает лишнее одобрение',()=>{
 const {store,service:s}=setup();try{store.saveCampaign({...store.campaign(),limit:1});const a=add(s),b=add(s,{...user,id:'1002'});act(s,manager,a,'approve',{portfolioReviewed:true});assert.throws(()=>act(s,manager,b,'approve',{portfolioReviewed:true}),{status:409});assert.equal(store.app(b.id).status,'review');}finally{store.close();}
});
test('отказ не отправляет кандидату лишнее уведомление, анкету можно вернуть',()=>{
 const {store,service:s}=setup();try{let a=add(s),before=store.jobs().length;a=act(s,manager,a,'reject');assert.equal(store.jobs().length,before);a=act(s,manager,a,'reopen');assert.equal(a.status,'review');}finally{store.close();}
});
test('пилот принимает тестовые анкеты, рабочий запуск требует условий',()=>{
 const a=setup({demo:false,pilot:false});try{assert.throws(()=>add(a.service),{status:409});}finally{a.store.close();}
 const b=setup({demo:false,pilot:true});try{assert.equal(add(b.service).status,'review');}finally{b.store.close();}
});
test('ориентир охватов сохраняется и пересчитывает очередь',()=>{
 const {store,service:s}=setup();try{const a=add(s,user,input({directions:['reach'],profile:'https://example.com',views:1500,audienceKz:true}));assert.equal(a.evaluation.reach,'recommended');s.updateCampaign(manager,{minViews:2000});assert.equal(store.campaign().minViews,2000);assert.equal(store.app(a.id).evaluation.reach,'clarify');assert.throws(()=>s.updateCampaign(manager,{limit:0}));}finally{store.close();}
});
function signedData(token,overrides={},extra={}){
 const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),query_id:'test-query',user:JSON.stringify({id:1001,first_name:'Тест'}),...overrides,...extra});
 const check=[...p].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>k+'='+v).join('\n'),key=createHmac('sha256','WebAppData').update(token).digest();
 p.set('hash',createHmac('sha256',key).update(check).digest('hex'));return p.toString();
}
test('Telegram HMAC включает signature; подмена, повтор поля и старый вход запрещены',()=>{
 assert.equal(validateTelegram(signedData('test-token',{}, {signature:'third-party-signature'}),'test-token').id,'1001');
 const data=signedData('test-token');for(const fn of [()=>validateTelegram(data,'wrong'),()=>validateTelegram(data+'&user=bad','test-token'),()=>validateTelegram(signedData('test-token',{auth_date:'1'}),'test-token'),()=>validateTelegram(data.replace('test-query','changed'),'test-token')])assert.throws(fn);
});
test('сессии подписаны, истекают; роли берутся из серверной конфигурации',()=>{
 const t=session(user,'secret');assert.equal(readSession(t,'secret').id,user.id);assert.equal(readSession(t,'wrong'),null);assert.equal(readSession(t,'secret',Date.now()+86400000),null);assert.equal(roleFor('2',{adminIds:['1'],managerIds:['2']}),'manager');assert.throws(()=>configuration({NODE_ENV:'production',DEMO_MODE:'true'}));
});
test('webhook сохраняет один update, callback менеджера тоже попадает в очередь',()=>{
 const {store}=setup();try{const update={update_id:991,message:{from:{id:1001},chat:{type:'private'},text:'/start'}};assert.equal(queueTelegramUpdate(store,update).accepted,true);assert.equal(queueTelegramUpdate(store,update).duplicate,true);assert.equal(queueTelegramUpdate(store,{update_id:992,callback_query:{id:'cb1',from:{id:2001},message:{chat:{type:'private'}},data:'next'}}).accepted,true);assert.equal(store.jobs().length,2);}finally{store.close();}
});
test('бот не доверяет callback кандидата, менеджер выбирает ровно один раз',async()=>{
 const {store,service:s,c}=setup({demo:false,pilot:true,adminIds:[manager.id],botToken:'test-token'});const a=add(s),calls=[];
 try{for(const [n,id]of [[1,user.id],[2,manager.id],[3,manager.id]])queueTelegramUpdate(store,{update_id:n,callback_query:{id:'cb'+n,from:{id:Number(id)},message:{chat:{type:'private'}},data:'pick:'+a.id+':1'}});
  await mockedFetch(async(url,opts)=>{calls.push({url:String(url),body:JSON.parse(opts.body)});return response({ok:true,result:{message_id:9}});},()=>createWorker(store,c).tick());
  assert.equal(store.app(a.id).status,'approved');assert.equal(store.events(a.id).filter(e=>e.type==='approve').length,1);assert.ok(calls.some(x=>x.body.text?.includes('доступно менеджеру')));
 }finally{store.close();}
});
test('400 анкет дают одно уведомление и одну обновляемую подборку',async()=>{
 const {store,service:s,c}=setup({demo:false,pilot:true,adminIds:[manager.id],botToken:'test-token'}),calls=[];
 try{for(let i=0;i<400;i++)add(s,{...user,id:String(10000+i)});
  // Candidate confirmations are individual; the manager gets one notice for the batch and one editable digest.
  store.db.prepare("UPDATE jobs SET status='done'").run();const worker=createWorker(store,c);
  await mockedFetch(async(url,opts)=>{calls.push({url:String(url),body:JSON.parse(opts.body)});return response({ok:true,result:{message_id:55}});},async()=>{await worker.tick();await worker.tick();store.setMeta('shortlist_dirty','1');store.setMeta('shortlist_last','0');await worker.tick();});
  assert.equal(calls.filter(x=>x.url.endsWith('/sendMessage')).length,2);assert.equal(calls.filter(x=>x.body.text.startsWith('Новые анкеты:')).length,1);assert.equal(calls.filter(x=>x.url.endsWith('/editMessageText')).length,1);assert.equal(calls.at(-1).body.message_id,55);assert.equal(s.list(manager,{offset:360,limit:60}).applications.length,40);assert.equal(s.overview(manager).total,400);
 }finally{store.close();}
});

test('поиск SN 0002 находит анкету с уточнением, даже из выбранных и рекомендаций',()=>{
 const {store,service:s}=setup();try{
  let first=add(s);act(s,manager,first,'approve',{portfolioReviewed:true});
  const second=add(s,{...user,id:'1002'});second.evaluation.ai={recommendation:'clarify',summary:'Попросить другой пример'};store.save(second);
  assert.equal(s.list(manager,{bucket:'recommended'}).total,0);
  for(const q of ['SN 0002','sn0002','SN-0002']){
   const found=s.list(manager,{q,bucket:'selected',queue:'approved',direction:'reach'});assert.equal(found.total,1);assert.equal(found.applications[0].id,second.id);
  }
  assert.equal(s.list(manager,{bucket:'all_new'}).applications[0].id,second.id);
 }finally{store.close();}
});

test('новые анкеты уведомляют сразу, затем собираются в одно сообщение за 15 минут',async()=>{
 const {store,service:s,c}=setup({demo:false,pilot:true,adminIds:[manager.id],botToken:'test-token'}),calls=[],clock=Date.now;let now=clock();Date.now=()=>now;
 try{
  add(s);store.db.prepare("UPDATE jobs SET status='done'").run();const worker=createWorker(store,c);
  await mockedFetch(async(url,opts)=>{calls.push(JSON.parse(opts.body));return response({ok:true,result:{message_id:56}});},async()=>{
   await worker.tick();assert.equal(calls.filter(x=>x.text.startsWith('Новая анкета')).length,1);
   add(s,{...user,id:'1002'});add(s,{...user,id:'1003'});store.db.prepare("UPDATE jobs SET status='done'").run();
   now+=899999;await worker.tick();assert.equal(calls.filter(x=>x.text.startsWith('Новые анкеты')).length,0);
   now+=1;await worker.tick();await worker.tick();assert.equal(calls.filter(x=>x.text.startsWith('Новые анкеты: 2')).length,1);
  });
  assert.equal(store.meta('intake_notice_sequence:'+manager.id),'3');
 }finally{Date.now=clock;store.close();}
});

test('ошибка уведомления повторяется с паузой и не блокирует выбор менеджера',async()=>{
 const {store,service:s,c}=setup({demo:false,pilot:true,adminIds:[manager.id],botToken:'test-token'}),clock=Date.now;let now=clock(),attempts=0;Date.now=()=>now;
 try{
  const a=add(s),b=add(s,{...user,id:'1002'});store.db.prepare("UPDATE jobs SET status='done'").run();const worker=createWorker(store,c);
  await mockedFetch(async(url,opts)=>{
   const body=JSON.parse(opts.body);if(body.text?.startsWith('Новые анкеты')||body.text?.startsWith('Новая анкета')){attempts++;if(attempts===1)return response({ok:false,error_code:429,parameters:{retry_after:60}},false);}return response({ok:true,result:{message_id:57}});
  },async()=>{
   await worker.tick();assert.equal(attempts,1);
   queueTelegramUpdate(store,{update_id:100006,callback_query:{id:'notice-failed',from:{id:Number(manager.id)},message:{chat:{type:'private'}},data:'pick:'+a.id+':'+a.version}});
   await worker.tick();assert.equal(store.app(a.id).status,'approved');assert.equal(store.app(b.id).status,'review');assert.equal(attempts,1);assert.equal(store.meta('intake_notice_sequence:'+manager.id),undefined);
   now+=60000;await worker.tick();
  });
  assert.equal(attempts,2);assert.equal(store.meta('intake_notice_sequence:'+manager.id),'2');
 }finally{Date.now=clock;store.close();}
});

test('старый адрес только перенаправляет: база не открывается, POST и старый API отклоняются',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ugc-alias-')),databasePath=join(dir,'should-not-exist.sqlite');
 const c=configuration({NODE_ENV:'production',PUBLIC_URL:'https://old.example',CANONICAL_URL:'https://current.example',DATABASE_PATH:databasePath}),app=createApp(c);
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 try{
  const r=await fetch(base+'/?view=review&candidate=SN-0002',{redirect:'manual'});assert.equal(r.status,302);assert.equal(r.headers.get('location'),'https://current.example/?view=review&candidate=SN-0002');
  assert.equal((await fetch(base+'/api/applications')).status,409);
  assert.equal((await fetch(base+'/telegram/webhook',{method:'POST',body:'{}'})).status,409);
  assert.deepEqual(await(await fetch(base+'/healthz')).json(),{ok:true,forwarding:true});await app.worker.tick();assert.equal(app.store,null);assert.equal(existsSync(databasePath),false);
  for(const target of ['http://current.example','https://old.example','https://name:secret@current.example','https://current.example/path'])assert.throws(()=>configuration({NODE_ENV:'production',PUBLIC_URL:'https://old.example',CANONICAL_URL:target}));
 }finally{await new Promise(r=>app.server.close(r));rmSync(dir,{recursive:true,force:true});}
});
test('в модель не передаются имя, контакты, ссылки, заметка и подписчики UGC',()=>{
 const a={...normalizeApplication(input({note:'Секретная информация',followers:500})),telegramId:'12345',username:'private',evaluation:{eligible:true}},facts=JSON.stringify(aiFacts(a));
 for(const forbidden of ['Тестовый','example.com','12345','Секретная','private'])assert.ok(!facts.includes(forbidden));for(const field of ['followers','views','audienceKzDeclared'])assert.equal(field in aiFacts(a),false);
});
test('ИИ возвращает только резюме и рекомендацию, не статус заявки',async()=>{
 const a={...normalizeApplication(input()),evaluation:{eligible:true}},output=await analyze(a,{aiProvider:'ollama',aiModel:'local',ollamaUrl:'http://local'},async()=>response({response:JSON.stringify({recommendation:'recommend',summary:'Нужно посмотреть работу',reasons:['Есть примеры'],unknowns:['Видео не просмотрено'],question:'Есть другой пример?',status:'approved'})}));
 assert.equal(output.recommendation,'recommend');assert.equal(output.status,undefined);
 await assert.rejects(()=>analyze(a,{aiProvider:'ollama',aiModel:'local',ollamaUrl:'http://local'},async()=>response({response:'{}'})));
});
test('ошибка ИИ оставляет анкету доступной менеджеру',async()=>{
 const {store,service:s,c}=setup({aiProvider:'ollama',aiModel:'test'});try{const a=add(s);await mockedFetch(async()=>response({},false),()=>createWorker(store,c).tick());assert.equal(store.app(a.id).status,'review');assert.equal(store.app(a.id).evaluation.aiStatus,'unavailable');assert.equal(s.list(manager,{queue:'review'}).total,1);}finally{store.close();}
});
test('ключи зашифрованы в SQLite и не выходят через status',async()=>{
 const {store,connections:c}=setup();try{c.configureApp({appId:'123456',appSecret:'secret-app-value-123456'});await c.connectToken('access-token-test-value-long',async(url)=>response(String(url).includes('debug_token')?{data:{is_valid:true,user_id:'42',scopes:['threads_basic','threads_content_publish']}}:{id:'42',username:'brand'}));const row=store.db.prepare("SELECT * FROM connections WHERE name='threads'").get();assert.ok(!JSON.stringify(row).includes('access-token-test'));assert.ok(!JSON.stringify(row).includes('secret-app-value'));assert.ok(!JSON.stringify(c.status()).includes('access-token-test'));assert.equal(c.config().threadsUserId,'42');assert.equal(c.status().threads,true);}finally{store.close();}
});
test('OAuth использует актуальный домен, минимальные scopes и одноразовый state',async()=>{
 const {store,connections:c}=setup();try{c.configureApp({appId:'123456',appSecret:'secret-app-value-123456'});const url=new URL(c.authorize(manager.id));assert.equal(url.origin+url.pathname,THREADS_AUTH);assert.equal(url.searchParams.get('scope'),'threads_basic,threads_content_publish');const params=new URLSearchParams({state:url.searchParams.get('state'),code:'code'}),calls=[];await c.callback(params,async(url)=>{calls.push(String(url));return response(calls.length===1?{access_token:'short-token'}:calls.length===2?{access_token:'long-lived-token-1234567890',expires_in:5184000}:calls.length===3?{id:'42',username:'brand'}:{data:{is_valid:true,user_id:'42',scopes:['threads_basic','threads_content_publish']}});});assert.equal(c.status().threads,true);await assert.rejects(()=>c.callback(params),{status:400});assert.ok(calls.every(u=>u.startsWith('https://graph.threads.com/')));}finally{store.close();}
});
test('OAuth отклоняет чужой и истёкший state до обращения к Meta',async()=>{
 const {store,connections:c}=setup();try{await assert.rejects(()=>c.callback(new URLSearchParams({state:'unknown',code:'x'})));store.db.prepare('INSERT INTO oauth_states VALUES(?,?,?)').run('expired','1',Date.now()-1);await assert.rejects(()=>c.callback(new URLSearchParams({state:'expired',code:'x'})));}finally{store.close();}
});
test('ключ ИИ сохраняется только после успешного ответа модели',async()=>{
 const {store,connections:c}=setup();try{await assert.rejects(()=>c.connectAI({provider:'gemini',key:'key-1234567890123456',model:'test'},async()=>{throw new Error('unavailable');}));assert.equal(c.status().aiConnected,false);await c.connectAI({provider:'gemini',key:'key-1234567890123456',model:'test'},async()=>({summary:'OK'}));assert.equal(c.status().aiConnected,true);assert.ok(!JSON.stringify(c.status()).includes('key-123'));}finally{store.close();}
});
test('пост включает ссылку на анкету, считает Unicode и требует подключения',()=>{
 const {store,service:s}=setup({botUsername:'test_bot'});try{const p=s.savePost(manager,{text:'Ищем новых креаторов',includeForm:true},randomUUID()).post;assert.ok(p.text.includes('https://t.me/test_bot?start=c_'));assert.throws(()=>s.savePost(manager,{text:'😀'.repeat(501),includeForm:false},randomUUID()));assert.throws(()=>s.savePost(manager,{text:'Прекрасные креаторы',status:'scheduled',scheduledAt:new Date(Date.now()+100000).toISOString()},randomUUID()));assert.throws(()=>s.savePost(manager,{text:'Новый пост для креаторов',scheduledAt:'wrong'},randomUUID()),{status:400});}finally{store.close();}
});
const threadPost=()=>({id:randomUUID(),text:'Тестовая публикация',campaignId:DEFAULT_CAMPAIGN.id,status:'scheduled',accountId:'42',scheduledAt:new Date().toISOString()});
const threadConfig={threadsToken:'test-token',threadsUserId:'42'};
test('Threads: create → publish, permalink не влияет на успех, повтор не запускается worker',async()=>{
 const {store,c}=setup({demo:false,...threadConfig});try{const p=threadPost();store.savePost(p);let count=0;await mockedFetch(async()=>{count++;if(count===3)throw new Error('permalink unavailable');return response({id:count===1?'container':'post'});},async()=>{const w=createWorker(store,c);await w.tick();await w.tick();});assert.equal(count,3);assert.equal(store.posts()[0].status,'published');assert.equal(store.posts()[0].remoteId,'post');}finally{store.close();}
});
test('Threads: неизвестный ответ publish требует проверки и не повторяется автоматически',async()=>{
 const {store,c}=setup({demo:false,...threadConfig});try{store.savePost(threadPost());let n=0;await mockedFetch(async()=>{if(++n===1)return response({id:'container'});throw new Error('lost response');},async()=>{const w=createWorker(store,c);await w.tick();await w.tick();});assert.equal(n,2);assert.equal(store.posts()[0].status,'needs_check');assert.equal(store.posts()[0].containerId,'container');}finally{store.close();}
});
test('смена аккаунта и пауза набора останавливают старое расписание',async()=>{
 const {store}=setup();try{let n=0;await mockedFetch(async()=>{n++;throw new Error('must not publish');},()=>publishThread({...threadPost(),accountId:'another'},store,threadConfig));assert.equal(n,0);assert.equal(store.posts()[0].status,'draft');store.saveCampaign({...store.campaign(),active:false});await publishThread(threadPost(),store,threadConfig);assert.equal(store.posts().at(-1).status,'draft');}finally{store.close();}
});
test('перезапуск не повторяет публикацию, которая была в процессе',()=>{
 const store=new Store();try{store.savePost({...threadPost(),status:'publishing'});createApp(config(),store);assert.equal(store.posts().find(p=>p.accountId==='42').status,'needs_check');}finally{store.close();}
});
test('HTTP: приватность, Origin, webhook, запрет демо-обхода в production',async()=>{
 const {store,c}=setup({demo:false,pilot:true,botToken:'test-token',adminIds:[manager.id],webhookSecret:'test-webhook-secret-123456789',sessionSecret:'test-session-secret-1234567890123456'}),app=createApp(c,store);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 try{assert.equal((await fetch(base+'/')).status,200);assert.equal((await fetch(base+'/api/overview',{headers:{'x-demo-role':'manager'}})).status,401);assert.equal((await fetch(base+'/telegram/webhook',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);const cookie='ugc_session='+session(manager,c.sessionSecret);const wrong=await fetch(base+'/api/campaign',{method:'PATCH',headers:{cookie,origin:'https://attacker.example','content-type':'application/json'},body:'{}'});assert.equal(wrong.status,403);const login=await fetch(base+'/api/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({initData:signedData(c.botToken)})});assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Lax/);const noAccess=await fetch(base+'/api/connections',{headers:{cookie:'ugc_session='+session(user,c.sessionSecret)}});assert.equal(noAccess.status,403);const safe=await(await fetch(base+'/api/connections',{headers:{cookie}})).text();assert.ok(!safe.includes(c.botToken));}finally{await new Promise(r=>app.server.close(r));store.close();}
});
test('два Telegram-аккаунта в одном браузере сохраняют разные роли и свои анкеты',async()=>{
 const {store,c,service:s}=setup({demo:false,pilot:true,botToken:'test-token',adminIds:[manager.id],sessionSecret:'test-session-secret-1234567890123456'}),app=createApp(c,store);
 const own=add(s),other=add(s,{...user,id:'1002'});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 try{
  const login=async(id,cookie)=>{const r=await fetch(base+'/api/auth',{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({initData:signedData(c.botToken,{user:JSON.stringify({id:Number(id),first_name:'Аккаунт'})})})});assert.equal(r.status,200);return (await r.json()).session;};
  const candidateCookie='ugc_session='+session(user,c.sessionSecret),managerCookie='ugc_session='+session(manager,c.sessionSecret);
  const managerTab=await login(manager.id,candidateCookie),candidateTab=await login(user.id,managerCookie);
  const hManager={cookie:candidateCookie,'x-ugc-session':managerTab},hCandidate={cookie:managerCookie,'x-ugc-session':candidateTab};
  const ownerSession=await(await fetch(base+'/api/session',{headers:hManager})).json();assert.equal(ownerSession.user.id,manager.id);assert.equal(ownerSession.user.role,'admin');
  const candidateSession=await(await fetch(base+'/api/session',{headers:hCandidate})).json();assert.equal(candidateSession.user.id,user.id);assert.equal(candidateSession.user.role,'candidate');
  const mine=await(await fetch(base+'/api/me',{headers:hCandidate})).json();assert.deepEqual(mine.applications.map(a=>a.id),[own.id]);assert.ok(!mine.applications.some(a=>a.id===other.id));
  assert.equal((await fetch(base+'/api/overview',{headers:hManager})).status,200);assert.equal((await fetch(base+'/api/overview',{headers:hCandidate})).status,403);
  assert.equal((await fetch(base+'/api/session',{headers:{cookie:managerCookie,'x-ugc-session':'invalid'}})).status,401);
  assert.equal((await fetch(base+'/api/session',{headers:{cookie:managerCookie,'x-ugc-session':session(manager,c.sessionSecret,Date.now()-86400000)}})).status,401);
 }finally{await new Promise(r=>app.server.close(r));store.close();}
});

test('frontend проверяет текущий вход Telegram до использования общей cookie',async()=>{
 const original={document:globalThis.document,window:globalThis.window,localStorage:globalThis.localStorage};const calls=[];
 globalThis.document={documentElement:{dataset:{mode:'server'}}};globalThis.window={Telegram:{WebApp:{initData:'manager-launch'}}};globalThis.localStorage={getItem:()=>null};
 try{await mockedFetch(async(path,options)=>{
  calls.push({path,options});if(path==='/api/auth'){const data=JSON.parse(options.body);if(data.initData==='invalid-launch')return {...response({error:'Подпись не подтверждена'},false),status:401};return response({session:data.initData==='manager-launch'?'manager-session':'candidate-session'});}
  return response({user:{role:options.headers['x-ugc-session']==='manager-session'?'admin':'candidate'},connections:{demo:false}});
 },async()=>{
  const {api:client}=await import('../dist/api.mjs?auth-test='+randomUUID());
  assert.equal((await client.session()).user.role,'admin');assert.deepEqual(calls.map(c=>c.path),['/api/auth','/api/session']);
  await client.mine();assert.equal(calls.at(-1).options.headers['x-ugc-session'],'manager-session');
  globalThis.window.Telegram.WebApp.initData='candidate-launch';assert.equal((await client.session()).user.role,'candidate');assert.equal(calls.at(-1).options.headers['x-ugc-session'],'candidate-session');
  globalThis.window.Telegram.WebApp.initData='invalid-launch';const before=calls.length;await assert.rejects(()=>client.session(),{status:401});assert.equal(calls.length,before+1);assert.equal(calls.at(-1).path,'/api/auth');
  globalThis.window.Telegram.WebApp.initData='candidate-launch';const recover=calls.length;await client.session();assert.equal(calls[recover].path,'/api/auth');assert.equal(calls.at(-1).options.headers['x-ugc-session'],'candidate-session');
 });}finally{for(const [key,value] of Object.entries(original)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
test('живая WAL-база копируется и восстанавливается с целостными событиями',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ugc-backup-test-'));let store,restored;
 try{store=new Store(join(dir,'ugc.sqlite'));const s=new Service(store,{demo:true,aiProvider:'rules'}),a=add(s),path=await createBackup({databasePath:join(dir,'ugc.sqlite'),backupDirectory:join(dir,'backups')});act(s,manager,a,'claim');restored=new Store(path);assert.equal(restored.app(a.id).version,a.version);assert.equal(store.app(a.id).version,a.version+1);assert.equal(restored.events(a.id).length,1);assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{restored?.close();store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('Gemini получает схему с recommendation; ответ с другим ключом не принимается',async()=>{
 const a={...normalizeApplication(input()),evaluation:{eligible:true,ugc:'recommended'}},valid={recommendation:'recommend',summary:'Посмотреть работу',reasons:['Есть пример'],unknowns:['Видео не просмотрено'],question:''};let request;
 const c={aiProvider:'gemini',aiModel:'test',geminiKey:'private-test-key'};
 const result=await analyze(a,c,async(url,opts)=>{request=JSON.parse(opts.body);return response({candidates:[{content:{parts:[{thought:true,text:'не выводить'},{text:JSON.stringify(valid)}]}}]});});
 assert.equal(result.recommendation,'recommend');assert.ok(request.generationConfig.responseJsonSchema.required.includes('recommendation'));
 const wrong={...valid,recommend:valid.recommendation};delete wrong.recommendation;
 await assert.rejects(()=>analyze(a,c,async()=>response({candidates:[{content:{parts:[{text:JSON.stringify(wrong)}]}}]})),{message:'AI_INVALID_RESPONSE'});
});

test('ошибка проверки Gemini объясняется владельцу, ключ и ложный статус не сохраняются',async()=>{
 const {store,connections:c}=setup();try{
  for(const [message,status]of [['AI_RATE_LIMIT',429],['AI_INVALID_RESPONSE',502],['AI_UNAVAILABLE',502]]){
   await assert.rejects(()=>c.connectAI({provider:'gemini',key:'private-test-key-12345',model:'test'},async()=>{throw new Error(message);}),e=>e.status===status&&e.code===message&&!e.message.includes('private-test-key'));
   assert.equal(c.status().aiConnected,false);
  }
 }finally{store.close();}
});

test('400 ожидающих ИИ не задерживают кнопку менеджера; поздний ИИ не меняет принятое решение',async()=>{
 const {store,service:s,c}=setup({demo:false,pilot:true,adminIds:[manager.id],botToken:'test-token',aiProvider:'ollama',aiModel:'test',ollamaUrl:'http://local'}),calls=[];
 let releaseModel,modelStarted;const started=new Promise(r=>modelStarted=r);let firstTick,modelCalls=0;
 try{
  let target;for(let i=0;i<400;i++){const a=add(s,{...user,id:String(10000+i)});if(!target)target=a;}
  const worker=createWorker(store,c);
  await mockedFetch(async(url,opts)=>{
   if(String(url).includes('/api/generate')){modelCalls++;modelStarted();return new Promise(r=>releaseModel=r);}
   calls.push({url:String(url),body:JSON.parse(opts.body)});return response({ok:true,result:{message_id:51}});
  },async()=>{
   firstTick=worker.tick();await started;await new Promise(r=>setImmediate(r));
   queueTelegramUpdate(store,{update_id:100001,callback_query:{id:'responsive-button',from:{id:Number(manager.id)},message:{chat:{type:'private'}},data:'pick:'+target.id+':'+target.version}});
   await worker.tick();assert.equal(store.app(target.id).status,'approved');const version=store.app(target.id).version;
   assert.ok(calls.some(x=>x.url.endsWith('/answerCallbackQuery')&&x.body.callback_query_id==='responsive-button'));assert.equal(modelCalls,1);
   releaseModel(response({response:JSON.stringify({recommendation:'clarify',summary:'Поздняя оценка',reasons:[],unknowns:[],question:''})}));await firstTick;
   assert.equal(store.app(target.id).status,'approved');assert.equal(store.app(target.id).version,version);assert.equal(store.app(target.id).evaluation.ai,undefined);
  });
 }finally{if(releaseModel)releaseModel(response({response:'{}'}));if(firstTick)await firstTick;store.close();}
});

test('ответ на уточнение виден прямо в обновляемой карточке Telegram',async()=>{
 const {store,service:s,c}=setup({demo:false,pilot:true,adminIds:[manager.id],botToken:'test-token'}),calls=[];
 try{let a=add(s);a=act(s,manager,a,'clarify',{question:'Есть разговорный пример?'});a=act(s,user,a,'answer',{answer:'Да, пример с диалогом приложу сегодня.'});
  queueTelegramUpdate(store,{update_id:100002,callback_query:{id:'answered-card',from:{id:Number(manager.id)},message:{chat:{type:'private'}},data:'next'}});
  await mockedFetch(async(url,opts)=>{calls.push(JSON.parse(opts.body));return response({ok:true,result:{message_id:52}});},()=>createWorker(store,c).tick());
  assert.ok(calls.some(x=>x.text?.includes('Ответ кандидата: Да, пример с диалогом приложу сегодня.')&&x.text.includes('Вопрос менеджера: Есть разговорный пример?')));
 }finally{store.close();}
});

test('устаревший вопрос менеджера не уходит другому кандидату и не зацикливается',async()=>{
 const {store,service:s,c}=setup({adminIds:[manager.id]});try{
  const a=add(s);store.setMeta('question:'+manager.id,JSON.stringify({id:a.id,version:a.version,at:Date.now()}));act(s,manager,a,'claim');
  queueTelegramUpdate(store,{update_id:100003,message:{from:{id:Number(manager.id)},chat:{type:'private'},text:'Есть ли ещё пример ролика?'}});
  await createWorker(store,c).tick();assert.equal(store.app(a.id).status,'review');assert.equal(store.meta('question:'+manager.id),'');
  const jobs=store.db.prepare('SELECT kind,status,payload FROM jobs').all();assert.ok(jobs.some(x=>x.kind==='telegram'&&JSON.parse(x.payload).text.includes('Вопрос не отправлен')));assert.ok(jobs.filter(x=>x.kind==='telegram_update').every(x=>x.status==='done'));
 }finally{store.close();}
});

test('повторное уточнение не показывает старый ответ как ответ на новый вопрос',()=>{
 const {store,service:s}=setup();try{let a=add(s);a=act(s,manager,a,'clarify',{question:'Первый вопрос?'});a=act(s,user,a,'answer',{answer:'Ответ на первый вопрос'});a=act(s,manager,a,'clarify',{question:'Теперь второй вопрос?'});assert.equal(a.status,'clarification');assert.equal(a.answer,undefined);assert.equal(a.question,'Теперь второй вопрос?');}finally{store.close();}
});

test('решение в кабинете обновляет ту же Telegram-подборку',()=>{
 const {store,service:s}=setup();try{const a=add(s);store.setMeta('shortlist_dirty','0');act(s,manager,a,'approve',{portfolioReviewed:true});assert.equal(store.meta('shortlist_dirty'),'1');}finally{store.close();}
});

test('последний разобранный кандидат заменяется пустым состоянием без старых кнопок',async()=>{
 const {store,service:s,c}=setup({demo:false,pilot:true,adminIds:[manager.id],botToken:'test-token'}),calls=[];
 try{const a=add(s);store.setMeta('candidate_message:'+manager.id,'53');
  queueTelegramUpdate(store,{update_id:100004,callback_query:{id:'last-candidate',from:{id:Number(manager.id)},message:{chat:{type:'private'}},data:'pick:'+a.id+':'+a.version}});
  await mockedFetch(async(url,opts)=>{calls.push({url:String(url),body:JSON.parse(opts.body)});return response({ok:true,result:{message_id:54}});},()=>createWorker(store,c).tick());
  const empty=calls.find(x=>x.url.endsWith('/editMessageText')&&x.body.message_id===53);assert.ok(empty.body.text.includes('Новые анкеты разобраны'));assert.ok(!JSON.stringify(empty.body.reply_markup).includes('pick:'));assert.equal(store.app(a.id).status,'approved');
 }finally{store.close();}
});

test('быстрая очередь Telegram не превышает темп ИИ бесплатного пилота',async()=>{
 const {store,service:s,c}=setup({aiProvider:'ollama',aiModel:'test',ollamaUrl:'http://local'});const realNow=Date.now;let now=realNow(),calls=0;
 try{Date.now=()=>now;add(s);add(s,{...user,id:'1002'});const worker=createWorker(store,c);
  await mockedFetch(async()=>{calls++;return response({response:JSON.stringify({recommendation:'recommend',summary:'Есть пример',reasons:[],unknowns:[],question:''})});},async()=>{await worker.tick();await worker.tick();assert.equal(calls,1);now+=5000;await worker.tick();assert.equal(calls,2);});
  assert.equal(configuration({DEMO_MODE:'true'}).workerInterval,2000);
 }finally{Date.now=realNow;store.close();}
});

test('открытая карточка сама обновляет ожидание, ответ и версию кнопки',async()=>{
 const {store,service:s,c}=setup({demo:false,pilot:true,adminIds:[manager.id],botToken:'test-token'}),calls=[];
 try{let a=add(s);store.setMeta('candidate_message:'+manager.id,'61');const worker=createWorker(store,c);
  queueTelegramUpdate(store,{update_id:100005,callback_query:{id:'open-live-card',from:{id:Number(manager.id)},message:{chat:{type:'private'}},data:'next'}});
  await mockedFetch(async(url,opts)=>{calls.push({url:String(url),body:JSON.parse(opts.body)});return response({ok:true,result:{message_id:62}});},async()=>{
   await worker.tick();calls.length=0;a=act(s,manager,a,'clarify',{question:'Готовы снять разговорный ролик?'});await worker.tick();
   const waiting=calls.find(x=>x.body.message_id===61);assert.ok(waiting.body.text.includes('Ждём ответ на вопрос'));assert.ok(!JSON.stringify(waiting.body.reply_markup).includes('pick:'));
   calls.length=0;a=act(s,user,a,'answer',{answer:'Да, готов(а).'});await worker.tick();
   const answered=calls.find(x=>x.body.message_id===61);assert.ok(answered.body.text.includes('Ответ кандидата: Да, готов(а).'));assert.ok(JSON.stringify(answered.body.reply_markup).includes('pick:'+a.id+':'+a.version));
  });
 }finally{store.close();}
});

test('старая кнопка после ответа обновляет карточку без ложного отказа и без автоматического выбора',async()=>{
 const {store,service:s,c}=setup({demo:false,pilot:true,adminIds:[manager.id],botToken:'test-token'}),calls=[];
 try{let a=add(s);const oldVersion=a.version;a=act(s,manager,a,'clarify',{question:'Есть разговорный пример?'});a=act(s,user,a,'answer',{answer:'Да, пример есть.'});store.setMeta('candidate_message:'+manager.id,'63');const worker=createWorker(store,c);
  const press=(id,version,update)=>queueTelegramUpdate(store,{update_id:update,callback_query:{id,from:{id:Number(manager.id)},message:{chat:{type:'private'}},data:'pick:'+a.id+':'+version}});
  await mockedFetch(async(url,opts)=>{calls.push({url:String(url),body:JSON.parse(opts.body)});return response({ok:true,result:{message_id:64}});},async()=>{
   press('old-pick',oldVersion,100006);await worker.tick();assert.equal(store.app(a.id).status,'review');
   assert.ok(calls.some(x=>x.url.endsWith('/answerCallbackQuery')&&x.body.text.includes('Карточка обновлена')));assert.ok(calls.some(x=>x.body.message_id===63&&JSON.stringify(x.body.reply_markup).includes('pick:'+a.id+':'+a.version)));
   press('fresh-pick',a.version,100007);await worker.tick();assert.equal(store.app(a.id).status,'approved');assert.equal(store.events(a.id).filter(e=>e.type==='approve').length,1);
  });
 }finally{store.close();}
});
