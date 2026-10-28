import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Store} from '../server/store.mjs';
import {Service} from '../server/service.mjs';
import {Connections} from '../server/connections.mjs';
import {createWorker} from '../server/worker.mjs';
import {configuration,createApp} from '../server/index.mjs';
import {queueTelegramUpdate,analyze} from '../server/integrations.mjs';
import {session} from '../server/auth.mjs';
import {Maintenance} from '../server/maintenance.mjs';
import {DEFAULT_CAMPAIGN} from '../dist/domain.mjs';
import {queueQuery,beginCandidateEdit,rebaseCandidateEdit,blankPost,editPost,assessmentLabels} from '../dist/interaction-state.mjs';
const owner={id:'2001',name:'Owner',role:'admin'},candidate={id:'1001',name:'Candidate',role:'candidate'};
const input=extra=>({name:'Проверка',city:'Алматы',language:'kk',directions:['ugc'],portfolio:['https://example.com/work'],experience:'brand',adult:true,consent:true,terms:true,closeup:true,briefVersion:DEFAULT_CAMPAIGN.briefVersion,consentVersion:DEFAULT_CAMPAIGN.consentVersion,...extra});
function setup(extra={}){const store=new Store(),config={...configuration({DEMO_MODE:'true'}),adminIds:['2001'],managerIds:[],botToken:'fake',sessionSecret:'synthetic-audit-secret-more-than-thirty-two-characters',...extra},connections=new Connections(store,config),service=new Service(store,config,connections);return {store,config,connections,service};}
const add=(s,data={},u=candidate)=>s.store.app(s.create(u,input(data),randomUUID()).application.id);
const act=(s,u,a,action,payload={})=>s.store.app(s.action(u,a.id,{action,payload,version:a.version},randomUUID()).application.id);
const response=d=>({ok:true,json:async()=>d});
async function mocked(fn,run){const original=globalThis.fetch;globalThis.fetch=fn;try{return await run();}finally{globalThis.fetch=original;}}
async function http(env,fn){const app=createApp(env.config,env.store);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+app.server.address().port;try{return await fn(app,url);}finally{await new Promise(r=>app.server.close(r));}}
const post=(url,path,data)=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify(data)});

test('REV01: publishing stale or missing versions fails; cancellation invalidates existing editor',async()=>{
 const e=setup({threadsToken:'fake',threadsUserId:'account'}),{store,service:s}=e;
 try{await http(e,async(_,url)=>{const p=s.savePost(owner,{text:'First reviewed text',includeForm:false},randomUUID()).post;
  assert.throws(()=>s.savePost(owner,{id:p.id,text:'No version supplied',includeForm:false},randomUUID()),{code:'VERSION_CONFLICT'});
  const changed=s.savePost(owner,{id:p.id,version:p.version,text:'Second unreviewed text',includeForm:false},randomUUID()).post;
  for(const version of [p.version,undefined])assert.equal((await post(url,'/api/posts/'+p.id+'/publish',{version})).status,409);
  assert.equal((await post(url,'/api/posts/'+p.id+'/publish',{version:changed.version,accountId:'different-account'})).status,409);
  assert.equal(store.posts()[0].status,'draft');
  const r=await post(url,'/api/posts/'+p.id+'/publish',{version:changed.version}),scheduled=(await r.json()).post;assert.equal(r.status,200);assert.equal(scheduled.version,changed.version+1);
  const canceled=await post(url,'/api/posts/'+p.id+'/cancel',{version:scheduled.version}),draft=(await canceled.json()).post;assert.equal(draft.version,scheduled.version+1);assert.equal(draft.scheduledAt,null);
  assert.throws(()=>s.savePost(owner,{id:p.id,version:scheduled.version,text:'Stale rescheduling text',status:'scheduled',scheduledAt:new Date(Date.now()+3600000).toISOString()},randomUUID()),{code:'VERSION_CONFLICT'});
 });}finally{store.close();}
});
test('REV02: answer and reopen recalculate changed criteria and discard old AI',()=>{
 const {store,service:s}=setup({aiProvider:'gemini',aiModel:'fake',geminiKey:'fake'});
 try{for(const path of ['answer','reopen']){let a=add(s,{directions:['reach'],profile:'https://example.com/profile',views:1500,audienceKz:true},{...candidate,id:path});a.evaluation.ai={recommendation:'recommend',summary:'Old criteria'};store.save(a);a=act(s,owner,a,path==='answer'?'clarify':'reserve',{question:'Уточните формат ролика?'});s.updateCampaign(owner,{minViews:100000});a=act(s,path==='answer'?candidate.id===a.telegramId?candidate:{...candidate,id:path}:owner,store.app(a.id),path,{answer:'Готов снять ролик'});assert.equal(a.evaluation.reach,'clarify');assert.equal(a.evaluation.ai,undefined);assert.equal(a.evaluation.aiStatus,'pending');assert.equal(a.evaluation.criteriaRevision,store.campaign().criteriaRevision);s.updateCampaign(owner,{minViews:1000});}}finally{store.close();}
});
test('REV03: candidate editor retains original version; explicit rebase preserves other windows changes',()=>{
 const original={id:'SN-1',version:1,name:'Первое имя',city:'Алматы',portfolio:[]},state=beginCandidateEdit(original);state.draft.name='Моя правка';state.mine=[{...original,version:2,city:'Астана'}];assert.equal(state.editingVersion,1);
 const rebased=rebaseCandidateEdit(state.editingBase,state.draft,state.mine[0]);assert.equal(rebased.editingVersion,2);assert.equal(rebased.draft.name,'Моя правка');assert.equal(rebased.draft.city,'Астана');
});
test('REV04: rules overrides env provider, archives existing verdict and ignores in-flight AI',async()=>{
 const {store,config,service:s,connections}=setup({aiProvider:'gemini',aiModel:'fake',geminiKey:'fake'});
 try{const a=add(s);let started,release;const ready=new Promise(r=>started=r),pending=new Promise(r=>release=r);
  await mocked(async()=>{started();await pending;return response({candidates:[{content:{parts:[{text:JSON.stringify({recommendation:'pass',summary:'Late AI result',reasons:[],unknowns:[],question:''})}]}}]});},async()=>{const tick=createWorker(store,config,connections).tick();await ready;await connections.connectAI({provider:'rules'});release();await tick;});
  assert.equal(connections.config().aiProvider,'rules');assert.equal(store.app(a.id).evaluation.ai,undefined);assert.equal(s.list(owner,{bucket:'recommended'}).total,1);
  const b=store.app(a.id);b.evaluation.ai={recommendation:'pass',summary:'Previously stored'};store.save(b);await connections.connectAI({provider:'rules'});assert.equal(store.app(a.id).evaluation.aiArchived.summary,'Previously stored');assert.equal(store.app(a.id).evaluation.ai,undefined);
 }finally{store.close();}
});
test('REV05: manager card excludes foreign owner, claims atomically, acknowledges before rendering',async()=>{
 const {store,config,service:s,connections}=setup({demo:false,pilot:true,managerIds:['3001','3002']});
 try{const a=act(s,{id:'3001',role:'manager',name:'First'},add(s),'claim'),b=add(s,{}, {...candidate,id:'1002'}),calls=[];
  queueTelegramUpdate(store,{update_id:1,callback_query:{id:'next',data:'next',from:{id:3002,first_name:'Second'},message:{chat:{type:'private'}}}});
  await mocked(async(url,opts)=>{calls.push({method:String(url).split('/').at(-1),body:JSON.parse(opts.body)});return response({ok:true,result:{message_id:1}});},()=>createWorker(store,config,connections).tick());
  assert.equal(store.meta('candidate_app:3002'),b.id);assert.equal(store.app(b.id).owner,'3002');assert.equal(store.app(a.id).owner,'3001');assert.equal(calls[0].method,'answerCallbackQuery');assert.ok(calls.find(x=>x.body.chat_id==='3002'&&x.body.text?.includes('В работе: вы')));
  assert.throws(()=>act(s,{id:'3001',role:'manager'},store.app(b.id),'approve',{portfolioReviewed:true}),{code:'OWNER_CONFLICT'});
  s.setMember(owner,{id:'3002',active:false,confirmed:true});assert.equal(store.app(b.id).owner,undefined);
 }finally{store.close();}
});
test('REV05 edge: Telegram can reach entries beyond 500',async()=>{
 const {store,config,service:s}=setup();try{for(let i=0;i<502;i++)add(s,{}, {...candidate,id:String(i+10000)});store.setMeta('card_index:2001','499');queueTelegramUpdate(store,{update_id:55,callback_query:{id:'beyond500',data:'next',from:{id:2001},message:{chat:{type:'private'}}}});const expected=store.queryApplications({status:'review',offset:500,limit:1}).applications[0];await createWorker(store,config).tick();assert.equal(store.meta('candidate_app:2001'),expected.id);}finally{store.close();}
});
test('REV06: invalid question keeps composition; corrected question delivered once',async()=>{
 const {store,config,service:s}=setup();try{const a=add(s),w=createWorker(store,config);store.setMeta('question:2001',JSON.stringify({id:a.id,version:a.version,at:Date.now()}));const send=(n,text)=>queueTelegramUpdate(store,{update_id:n,message:{from:{id:2001},chat:{type:'private'},text}});send(1,'ок');await w.tick();assert.ok(store.meta('question:2001'));send(2,'Пришлите разговорный ролик, пожалуйста');await w.tick();assert.equal(store.app(a.id).status,'clarification');assert.equal(store.meta('question:2001'),'');assert.equal(store.events(a.id).filter(e=>e.type==='clarify').length,1);}finally{store.close();}
});
test('REV07: withdrawal of selected applicant notifies decision author once',()=>{
 const {store,service:s}=setup();try{let a=act(s,owner,add(s),'approve',{portfolioReviewed:true}),key=randomUUID(),request={action:'withdraw',version:a.version};s.action(candidate,a.id,request,key);s.action(candidate,a.id,request,key);const messages=store.db.prepare("SELECT payload FROM jobs WHERE kind='telegram' AND json_extract(payload,'$.chatId')='2001'").all().map(r=>JSON.parse(r.payload));assert.equal(messages.length,1);assert.match(messages[0].text,/отозвал/);assert.equal(messages[0].appId,a.id);}finally{store.close();}
});
test('REV08: search retains Mine owner in common query and SQL',()=>{
 const {store,service:s}=setup();try{const a=add(s),b=add(s,{name:'Дарья'},{...candidate,id:'1002'});act(s,owner,a,'claim');const q=queueQuery({bucket:'recommended',direction:'ugc',search:'Дарья',ownerFilter:'mine'});assert.equal(q.owner,'mine');assert.equal(s.list(owner,q).total,0);assert.equal(s.list(owner,{...q,owner:''}).applications[0].id,b.id);}finally{store.close();}
});
test('REV10: edit and new post state cannot share an id/version',()=>{const editor=editPost({id:'saved',version:3,text:'Сохранённый текст'});assert.equal(editor.id,'saved');assert.equal(editor.version,3);assert.equal(editor.dirty,false);assert.equal(blankPost().id,undefined);});
test('REV11: operations exposes failed phase and later clears active error while preserving history',async()=>{
 const e=setup({demo:false,pilot:true}),{store}=e;try{await http(e,async(app,url)=>{const original=store.queryApplications.bind(store);store.queryApplications=()=>{throw Error('Synthetic failure');};await mocked(async()=>response({ok:true,result:{message_id:1}}),()=>app.worker.tick());const headers={'x-ugc-session':session(owner,e.config.sessionSecret)},read=async()=>await (await fetch(url+'/api/operations',{headers})).json();let p=(await read()).phases.find(p=>p.name==='interactive');assert.equal(p.error,'WORKER_ERROR');assert.equal(p.lastSuccess,null);store.queryApplications=original;await mocked(async()=>response({ok:true,result:{message_id:1}}),()=>app.worker.tick());p=(await read()).phases.find(p=>p.name==='interactive');assert.equal(p.error,'');assert.ok(p.lastSuccess);assert.equal(p.errorHistory[0].code,'WORKER_ERROR');});}finally{store.close();}
});
test('AI quota has explicit status and retry time without making model request',async()=>{const {store,config,service:s}=setup({aiProvider:'gemini',aiModel:'fake',geminiKey:'fake',aiDailyLimit:0});try{const a=add(s);await mocked(()=>{throw Error('Must not call provider');},()=>createWorker(store,config).tick());const e=store.app(a.id).evaluation;assert.equal(e.aiStatus,'quota');assert.ok(Date.parse(e.aiNextAt)>Date.now());assert.equal(store.app(a.id).status,'review');}finally{store.close();}});
test('Retention only removes messages/idempotency for expired application, preserves other campaign',()=>{
 const {store,config,service:s}=setup();try{let old=act(s,owner,add(s),'reject');old.updatedAt='2020-01-01T00:00:00.000Z';store.save(old);const c=store.campaign();store.saveCampaign({...c,retentionEnabled:true,productionApproved:true,operator:'SNEG',retentionDays:30});store.saveCampaign({...c,id:'second'});const active=add(s,{campaignId:'second'});store.enqueue('telegram',{chatId:candidate.id,appId:active.id,text:'Active campaign'});store.enqueue('telegram_update',{from:{id:candidate.id},text:'Active reply'});new Maintenance(store,config).clean();assert.equal(store.app(old.id),null);assert.ok(store.app(active.id));assert.ok(store.db.prepare("SELECT id FROM jobs WHERE json_extract(payload,'$.appId')=?").get(active.id));assert.ok(store.db.prepare("SELECT id FROM jobs WHERE kind='telegram_update'").get());}finally{store.close();}
});
test('UGC and reach AI outcomes remain independent even when global response disagrees',async()=>{const a={...input({directions:['ugc','reach']}),evaluation:{ugc:'recommended',reach:'clarify',eligible:true}},data={recommendation:'pass',summary:'Охваты не подходят',directions:{ugc:{recommendation:'recommend',summary:'Есть работа'},reach:{recommendation:'pass',summary:'Мало просмотров'}},reasons:[],unknowns:[],question:''};const ai=await analyze(a,{aiProvider:'ollama',aiModel:'fake',ollamaUrl:'http://local'},async()=>response({response:JSON.stringify(data)}));assert.equal(ai.recommendation,'recommend');assert.deepEqual(assessmentLabels({...a,evaluation:{...a.evaluation,ai}}).map(v=>v.outcome),['recommend','pass']);});
test('REV12: muted text contrast is at least 4.5 on paper, surface and tint',async()=>{
 const css=await readFile(new URL('../dist/style.css',import.meta.url),'utf8'),color=k=>css.match(new RegExp('--'+k+':(#[a-f0-9]{6})'))[1],luma=hex=>{const v=hex.match(/[a-f0-9]{2}/gi).map(v=>parseInt(v,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return v[0]*.2126+v[1]*.7152+v[2]*.0722;};for(const k of ['paper','surface','tint'])assert.ok((luma(color(k))+.05)/(luma(color('muted'))+.05)>=4.5,k);
});
