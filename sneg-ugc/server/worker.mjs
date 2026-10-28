import {telegram,analyze} from './integrations.mjs';
import {Service} from './service.mjs';
import {roleFor,teamIds} from './auth.mjs';
import {evaluationKey,queueEvaluation} from './ai-state.mjs';
import {Maintenance} from './maintenance.mjs';
import {recommended,priority,canonicalStatus,LANGUAGES,text} from '../dist/domain.mjs';
import {THREADS_GRAPH} from './connections.mjs';
export function createWorker(store,base,connections){
 let running=false,aiRunning=false,threadsRunning=false,nextAiAt=0,nextRepair=0;const maintenance=new Maintenance(store,base);const service=new Service(store,base,connections),cfg=()=>connections?.config()||base;
 const ranked=(manager,extra={})=>store.queryApplications({status:'review',...(manager?{availableTo:String(manager)}:{}),limit:3,...extra});
 const phaseRunning=new Set();
 async function phase(name,fn){
  if(phaseRunning.has(name))return;phaseRunning.add(name);
  const key='worker:phase:'+name,previous=JSON.parse(store.meta(key)||'{}'),at=new Date().toISOString();
  store.setMeta(key,JSON.stringify({...previous,name,lastAttempt:at,running:true}));
  try{await fn();const current=JSON.parse(store.meta(key));store.setMeta(key,JSON.stringify({...current,lastSuccess:new Date().toISOString(),error:'',errorAt:null,running:false}));store.setMeta('worker:error:'+name,'');}
  catch(e){const current=JSON.parse(store.meta(key)),code=/^(AI_|TELEGRAM_|THREADS_|BACKUP_)[A-Z_]+$/.test(e.message)?e.message:'WORKER_ERROR',errorAt=new Date().toISOString(),history=[{at:errorAt,code},...(current.errorHistory||[])].slice(0,20);store.setMeta(key,JSON.stringify({...current,error:code,errorAt,lastError:code,errorHistory:history,running:false}));store.setMeta('worker:error:'+name,errorAt+':'+code);}
  finally{phaseRunning.delete(name);}
 }
 const managers=()=>teamIds(base,store);
 async function recipient(id,fn){if(Date.now()<Number(store.meta('delivery_retry:'+id)||0))return false;try{await fn();store.setMeta('delivery_ok:'+id,new Date().toISOString());store.setMeta('delivery_error:'+id,'');store.setMeta('delivery_retry:'+id,'0');return true;}catch(e){store.setMeta('delivery_error:'+id,/^TELEGRAM_/.test(e.message)?e.message:'TELEGRAM_UNAVAILABLE');store.setMeta('delivery_retry:'+id,Date.now()+Math.max(60000,(e.retryAfter||0)*1000));return false;}}
 const appButton=(label,view='review')=>({text:label,web_app:{url:base.publicUrl+'/?view='+view}});
 async function editable(c,manager,text,reply_markup,key){
  const saved=store.meta(key),body={chat_id:manager,text,reply_markup,disable_web_page_preview:true};
  if(saved){try{await telegram(c,'editMessageText',{...body,message_id:Number(saved)});return;}catch(e){if(e.message!=='TELEGRAM_MESSAGE_GONE')throw e;}}
  const r=await telegram(c,'sendMessage',body);if(r.result?.message_id)store.setMeta(key,r.result.message_id);
 }
 async function digest(manager){const c=cfg(),top=ranked(manager).applications,counts=store.counts();const text='SNEG · подборка креаторов\n\nНужен выбор: '+counts.review+' · Уточняем: '+counts.clarification+'\n'+(top.length?'\nДоступны вам:\n'+top.map((a,i)=>(i+1)+'. '+a.name+' · '+a.id+'\n'+a.city+'\n'+(a.evaluation.ai?.summary||a.evaluation.summary)).join('\n\n'):'\nДоступных вам новых анкет пока нет.')+'\n\n'+(c.aiProvider==='rules'?'Предварительный отбор по правилам.':'ИИ помогает с приоритетом. Решение остаётся за менеджером.');await editable(c,manager,text,{inline_keyboard:[[appButton('Открыть новые заявки','review&bucket=all_new')],[{text:'Разобрать кандидата',callback_data:'next'}]]},'digest_message:'+manager);}
 async function notifyNewApplications(){
  const c=cfg();if(!ranked(null,{limit:1}).total)return;
  const sequence=a=>Number(a.id.replace(/^SN-/,''))||0;
  for(const manager of managers()){
   const now=Date.now(),last=Number(store.meta('intake_notice_at:'+manager)||0),retry=Number(store.meta('intake_notice_retry:'+manager)||0);
   if(now<retry||last&&now-last<900000)continue;
   const through=Number(store.meta('intake_notice_sequence:'+manager)||0),freshPage=ranked(manager,{afterSequence:through,limit:1}),fresh=freshPage.applications,total=freshPage.total,latest=Number(store.meta('sequence')||0);if(!total)continue;
   const title=total===1?'Новая анкета · '+fresh[0].id:'Новые анкеты: '+total;
   try{
    await telegram(c,'sendMessage',{chat_id:manager,text:title+'\n\nАнкеты уже в очереди. Откройте новые заявки или разберите кандидата прямо здесь.',reply_markup:{inline_keyboard:[[appButton('Открыть новые заявки','review&bucket=all_new')],[{text:'Разобрать кандидата',callback_data:'next'}]]}});
    store.setMeta('intake_notice_sequence:'+manager,latest);store.setMeta('intake_notice_at:'+manager,now);store.setMeta('intake_notice_error:'+manager,'');
   }catch(e){store.setMeta('intake_notice_error:'+manager,/^TELEGRAM_/.test(e.message)?e.message:'TELEGRAM_UNAVAILABLE');store.setMeta('intake_notice_retry:'+manager,now+Math.max(60000,(e.retryAfter||0)*1000));}
  }
 }
 async function renderCard(manager,a){
  const ai=cfg().aiProvider==='rules'?null:a.evaluation.ai,waiting=a.status==='clarification',other=a.owner&&String(a.owner)!==String(manager);
  const reason=(ai?.reasons||a.evaluation.reasons||[]).slice(0,2).join('; '),unknown=(ai?.unknowns||a.evaluation.unknowns||[])[0]||'Посмотрите работу перед выбором';
  const reply=waiting?'\n\nЖдём ответ на вопрос: '+text(a.question,650):a.answer?'\n\nВопрос менеджера: '+text(a.question,300)+'\nОтвет кандидата: '+text(a.answer,650):'';
  const assignment=a.owner?'\nВ работе: '+(other?(a.ownerName||'другой менеджер'):'вы'):'\nПока без менеджера';
  const message=a.name+' · '+a.id+'\n'+a.city+' · '+LANGUAGES[a.language]+' · '+a.directions.map(x=>x==='ugc'?'UGC':'Охваты').join(' + ')+assignment+'\n\n'+(ai?'ИИ: ':'По анкете: ')+(ai?.summary||a.evaluation.summary)+'\n'+reason+'\n\nПроверить: '+unknown+reply+'\n\nРаботы открываются по ссылкам ниже.'+(other?' Решение доступно ответственному менеджеру.':waiting?' Ответ появится в этой карточке.':' Выбор подтверждает просмотр портфолио.');
  const links=a.portfolio.slice(0,2).map((url,i)=>({text:'Работа '+(i+1),url}));
  const decisions=waiting||other?[]:[[{text:'Выбрать',callback_data:'pick:'+a.id+':'+a.version},{text:'Уточнить',callback_data:'ask:'+a.id+':'+a.version}],[{text:'Пропустить',callback_data:'skip:'+a.id+':'+a.version}]];
  await editable(cfg(),manager,message,{inline_keyboard:[...(links.length?[links]:[]),...decisions,[{text:'Другой кандидат',callback_data:'next'}],[appButton('Открыть карточку','review&candidate='+a.id)]]},'candidate_message:'+manager);
  store.setMeta('candidate_app:'+manager,a.id);store.setMeta('candidate_version:'+manager,a.version);
 }
 async function card(manager,next=false,preferredId=''){
  const preferred=preferredId&&store.app(preferredId);
  if(preferred&&['review','clarification'].includes(preferred.status)){await renderCard(manager,preferred);return;}
  if(next){const previous=store.meta('card_claimed:'+manager),a=previous&&store.app(previous);if(a&&a.owner===String(manager)&&a.status==='review')service.action({id:String(manager),role:roleFor(manager,base,store)},a.id,{action:'release',version:a.version},'release-card:'+a.id+':'+a.version);store.setMeta('card_claimed:'+manager,'');}
  const count=ranked(manager,{limit:1}).total;
  if(!count){
   if(store.meta('candidate_message:'+manager))await editable(cfg(),manager,'Новые анкеты разобраны. Выбранные креаторы и история сохранены в кабинете.',{inline_keyboard:[[appButton('Открыть выбранных','review&bucket=selected')]]},'candidate_message:'+manager);
   store.setMeta('candidate_app:'+manager,'');store.setMeta('candidate_version:'+manager,'');await digest(manager);return;
  }
  const index=next?(Number(store.meta('card_index:'+manager)??'-1')+1)%count:0;
  const selected=store.tx(()=>{const a=ranked(manager,{offset:index,limit:1}).applications[0];if(!a)return null;if(!a.owner){const at=new Date().toISOString(),profile=JSON.parse(store.meta('profile:'+manager)||'{}');a.owner=String(manager);a.ownerName=profile.name||store.member(manager)?.name||'Менеджер';a.version++;a.updatedAt=at;store.save(a);store.event(a.id,{at,actor:a.ownerName,actorId:String(manager),type:'claim',text:'Взято в работу в Telegram'});store.setMeta('card_claimed:'+manager,a.id);}return a;});
  if(selected){store.setMeta('card_index:'+manager,index);await renderCard(manager,selected);}
 }
 async function refreshCards(){
  for(const manager of managers()){
   const id=store.meta('candidate_app:'+manager);if(!id)continue;
   const a=store.app(id);if(!a||a.version!==Number(store.meta('candidate_version:'+manager)))await recipient(manager,()=>card(manager,false,id));
  }
 }
 async function incoming(p){const c=cfg(),u={id:p.from.id,name:p.from.name,username:p.from.username,role:roleFor(p.from.id,base,store)},team=['admin','manager'].includes(u.role);
  store.setMeta('profile:'+u.id,JSON.stringify({name:u.name,username:u.username,lastSeen:new Date().toISOString()}));store.setMeta('delivery_retry:'+u.id,'0');
  if(p.callback){
   let answer='',after=()=>{};
   if(!team)answer='Это действие доступно менеджеру';
   else if(p.callback.data==='next'){store.setMeta('question:'+u.id,'');answer='Открываю кандидата';after=()=>card(u.id,true);}
   else{
    const m=p.callback.data.match(/^(pick|skip|ask):([A-Z0-9-]+):(\d+)$/);
    if(m){
     if(m[1]==='ask'){
      let a=store.app(m[2]);
      if(a?.owner&&a.owner!==u.id){answer='Кандидат в работе у '+(a.ownerName||'другого менеджера');after=()=>card(u.id,false,m[2]);}
      else if(!a||a.version!==Number(m[3])){answer='Карточка обновлена. Посмотрите новые данные.';after=()=>card(u.id,false,m[2]);}
      else{
       if(!a.owner)a=service.action(u,a.id,{action:'claim',version:a.version},'claim-question:'+p.callback.id).application;
       const saved=JSON.parse(store.meta('question:'+u.id)||'null'),savedText=saved?.id===a.id?saved.savedText:'';
       store.setMeta('question:'+u.id,JSON.stringify({id:a.id,version:a.version,at:Date.now(),savedText}));store.enqueue('telegram',{chatId:u.id,text:'Напишите вопрос для '+a.name+' одним сообщением. Чтобы отменить — /cancel.'+(savedText?'\n\nСохранённый вопрос:\n'+savedText+'\n\nОтправить этот текст — /send.':''),plain:true});answer='Жду текст вопроса';
      }
     }else{
      try{
       service.action(u,m[2],{action:m[1]==='pick'?'approve':'reject',version:Number(m[3]),payload:m[1]==='pick'?{portfolioReviewed:true}:{reason:'Не подходит под текущий набор'}},'callback:'+p.callback.id);
       answer=m[1]==='pick'?'Кандидат выбран':'Пропущен';after=()=>card(u.id);
      }catch(e){
       answer='Не удалось сохранить решение';
       if(e.status===409){const fresh=store.app(m[2]);answer=e.code==='OWNER_CONFLICT'?'Кандидат в работе у '+(fresh?.ownerName||'другого менеджера'):fresh&&['review','clarification'].includes(fresh.status)?'Карточка обновлена. Посмотрите ответ и повторите выбор.':'Кандидата уже разобрали. Решение не изменилось.';after=()=>card(u.id,false,m[2]);}
      }
     }
    }
   }
   // Acknowledge before any message edit/send. A slow card must not keep the button spinning.
   try{await telegram(c,'answerCallbackQuery',{callback_query_id:p.callback.id,text:answer||'Готово'});}catch{store.setMeta('callback:last_error','TELEGRAM_ACK_UNAVAILABLE');}
   await after();return;
  }
  if(team){
   const pending=store.meta('question:'+u.id);
   if(p.text==='/cancel'){store.setMeta('question:'+u.id,'');store.enqueue('telegram',{chatId:u.id,text:'Вопрос отменён.',plain:true});return;}
   if(pending&&(!p.text.startsWith('/')||p.text==='/send')){
    const question=JSON.parse(pending),questionText=p.text==='/send'?question.savedText:p.text;
    if(Date.now()-question.at>=900000){store.setMeta('question:'+u.id,'');store.enqueue('telegram',{chatId:u.id,text:'Время ввода вопроса истекло. Откройте кандидата и нажмите «Уточнить» ещё раз.',plain:true});return;}
    try{service.action(u,question.id,{action:'clarify',version:question.version,payload:{question:questionText}},'update:'+p.updateId);store.setMeta('question:'+u.id,'');store.enqueue('telegram',{chatId:u.id,text:'Вопрос отправлен кандидату.',plain:true});}
    catch(e){
     if(!e.status)throw e;const fresh=store.app(question.id);question.savedText=text(questionText,1200);
     if(e.status===409&&fresh)question.version=fresh.version;
     store.setMeta('question:'+u.id,JSON.stringify(question));
     store.enqueue('telegram',{chatId:u.id,text:e.status===409?'Вопрос не отправлен. '+(e.code==='OWNER_CONFLICT'?'Кандидат теперь в работе у другого менеджера. Текст сохранён.':'Карточка изменилась. Текст сохранён:\n'+question.savedText+'\n\nПосмотрите актуальную карточку. Отправить сохранённый вопрос — /send, изменить — напишите новый текст, отменить — /cancel.'):e.message+' Поправьте вопрос и отправьте ещё раз. Для отмены — /cancel.',plain:true});
     if(e.status===409&&fresh)await card(u.id,false,question.id);
    }
    return;
   }
   if(p.text==='/id'){store.enqueue('telegram',{chatId:u.id,text:'Ваш Telegram ID: '+u.id,plain:true});return;}if(p.text.startsWith('/start'))store.setMeta('question:'+u.id,'');await digest(u.id);return;
  }
  if(p.text.startsWith('/start')){const ref=p.text.split(/\s+/)[1],campaign=store.campaign(ref?.startsWith('c_')?ref.slice(2):undefined)||store.campaign();store.subscribe(u.id,campaign.id);store.enqueue('telegram',{chatId:u.id,text:'Привет! Это набор креаторов SNEG. Заполните короткую анкету — результат придёт сюда.',campaignId:campaign.id});return;}
  if(p.text==='/id'){store.enqueue('telegram',{chatId:u.id,text:'Ваш Telegram ID: '+u.id,plain:true});return;}
  const a=store.mine(u.id).find(a=>a.status==='clarification');if(a&&p.text&&!p.text.startsWith('/')){service.action(u,a.id,{action:'answer',version:a.version,payload:{answer:p.text}},'update:'+p.updateId);store.enqueue('telegram',{chatId:u.id,text:'Ответ передан менеджеру. Спасибо!',appId:a.id});return;}
  store.enqueue('telegram',{chatId:u.id,text:store.mine(u.id).length?'Результат и статус заявки — в кабинете.':'Анкета открывается кнопкой ниже.'});
 }
 function failJob(job,e){const code=/^(AI_|TELEGRAM_)/.test(e.message)?e.message:'INTEGRATION_UNAVAILABLE',attempts=job.attempts+1;store.updateJob(job.id,code==='TELEGRAM_BLOCKED'||attempts>=4?'failed':'pending',attempts,code,new Date(Date.now()+(e.retryAfter?e.retryAfter*1000:Math.min(3600000,30000*2**attempts))).toISOString());if(job.kind==='ai'){const a=store.app(job.payload.appId);if(a&&a.status==='review'){a.evaluation.aiStatus=code==='AI_RATE_LIMIT'?'quota':'unavailable';a.evaluation.aiNextAt=new Date(Date.now()+Math.min(3600000,30000*2**attempts)).toISOString();a.version++;store.save(a);store.setMeta('shortlist_dirty','1');}}}
 async function aiTick(){
  if(aiRunning||Date.now()<nextAiAt)return;aiRunning=true;
  try{
   const job=store.dueJobs(new Date().toISOString(),{kind:'ai',limit:1})[0];if(!job)return;
   const c=cfg(),today=new Date().toISOString().slice(0,10),a=store.app(job.payload.appId);
   if(c.aiProvider==='rules'||!a||a.status!=='review'){store.updateJob(job.id,'done',job.attempts);if(a){a.evaluation.aiStatus=c.aiProvider==='rules'?'not_configured':a.evaluation.ai?'done':'paused';store.save(a);}return;}
    const snapshot=evaluationKey(a,store.campaign(a.campaignId),c);if(job.payload.evaluationKey&&job.payload.evaluationKey!==snapshot){store.updateJob(job.id,'done',job.attempts);queueEvaluation(store,a,c,{force:true});return;}
   const count=Number(store.meta('ai:'+today)||0);
   if(count>=c.aiDailyLimit){const next=new Date(Date.now()+3600000).toISOString();store.updateJob(job.id,'pending',job.attempts,'AI_DAILY_LIMIT',next);if(a.evaluation.aiStatus!=='quota'){a.evaluation.aiStatus='quota';a.evaluation.aiNextAt=next;a.version++;store.save(a);}return;}
   try{
    nextAiAt=Date.now()+Math.max(5000,c.aiMinInterval||5000);store.setMeta('ai:'+today,count+1);a.evaluation.aiStatus='running';a.version++;store.save(a);const result=await analyze(a,c);
    store.tx(()=>{const fresh=store.app(a.id),current=cfg();if(current.aiProvider!=='rules'&&fresh?.status==='review'&&evaluationKey(fresh,store.campaign(fresh.campaignId),current)===snapshot){fresh.evaluation={...fresh.evaluation,ai:result,aiStatus:'done',source:c.aiProvider,aiAt:new Date().toISOString()};fresh.version++;store.save(fresh);store.setMeta('shortlist_dirty','1');}store.updateJob(job.id,'done',job.attempts+1);if(fresh?.status==='review'&&evaluationKey(fresh,store.campaign(fresh.campaignId),current)!==snapshot)queueEvaluation(store,fresh,current,{force:true});store.setMeta('ai:last_ok',new Date().toISOString());});
   }catch(e){const fresh=store.app(a.id);if(fresh&&evaluationKey(fresh,store.campaign(fresh.campaignId),cfg())===snapshot)failJob(job,e);else store.updateJob(job.id,'done',job.attempts);}
  }finally{aiRunning=false;}
 }
 async function interactiveTick(){if(running)return;running=true;try{let c=cfg();store.setMeta('worker:interactive',new Date().toISOString());
  for(const job of store.dueJobs(new Date().toISOString(),{excludeKind:'ai',limit:4})){try{
   if(job.kind==='telegram_update')await incoming(job.payload);
   else if(job.kind==='telegram'){const p=job.payload;await telegram(c,'sendMessage',{chat_id:p.chatId,text:p.text,...(!p.plain?{reply_markup:{inline_keyboard:[[appButton('Открыть анкету / статус','apply')]]}}:{})});}
   store.updateJob(job.id,'done',job.attempts+1);
  }catch(e){failJob(job,e);}}
  if(!c.demo){await refreshCards();await notifyNewApplications();}
  if(!c.demo&&store.meta('shortlist_dirty')==='1'&&Date.now()-Number(store.meta('shortlist_last')||0)>=300000){for(const manager of managers()){const delivered=await recipient(manager,()=>digest(manager));store.setMeta('digest_pending:'+manager,delivered?'0':'1');}store.setMeta('shortlist_dirty','0');store.setMeta('shortlist_last',Date.now());}
  if(!c.demo)for(const manager of managers())if(store.meta('digest_pending:'+manager)==='1'){if(await recipient(manager,()=>digest(manager)))store.setMeta('digest_pending:'+manager,'0');}
 }finally{running=false;}}
 async function threadsTick(){if(threadsRunning)return;threadsRunning=true;try{let c=cfg();if(c.demo)return;const today=new Date().toISOString().slice(0,10);if(connections&&store.meta('refresh_day')!==today){await connections.refresh();store.setMeta('refresh_day',today);c=cfg();}if(c.threadsToken&&c.threadsUserId)for(const p of store.posts().filter(p=>p.status==='scheduled'&&Date.parse(p.scheduledAt)<=Date.now()).slice(0,2))await publishThread(p,store,c);store.setMeta('worker:threads',new Date().toISOString());}finally{threadsRunning=false;}}
 async function tick(){
  await Promise.all([phase('interactive',interactiveTick),phase('ai',async()=>{
   if(Date.now()>nextRepair){nextRepair=Date.now()+60000;const rows=store.db.prepare("SELECT data FROM applications WHERE status='review' AND json_extract(data,'$.evaluation.aiStatus') IN ('pending','paused','running') AND NOT EXISTS(SELECT 1 FROM jobs WHERE kind='ai' AND status='pending' AND json_extract(payload,'$.appId')=applications.id) LIMIT 100").all();for(const row of rows)queueEvaluation(store,JSON.parse(row.data),cfg());}
   await aiTick();
  }),phase('threads',threadsTick),phase('maintenance',()=>maintenance.tick())]);
 }
 return {tick,maintenance};
}
async function graph(c,path,body){let r,d;try{r=await fetch(THREADS_GRAPH+'/v1.0/'+path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',authorization:'Bearer '+c.threadsToken},body:new URLSearchParams(body),signal:AbortSignal.timeout(20000)});d=await r.json();}catch{throw new Error('THREADS_NETWORK_ERROR');}if(!r.ok||d.error)throw new Error('THREADS_API_ERROR');return d;}
export async function publishThread(post,store,c){
 const save=changes=>{const current=store.posts().find(p=>p.id===post.id)||post;const next={...current,...changes,version:(current.version||1)+1,updatedAt:new Date().toISOString()};store.savePost(next);return next;};
 if(!store.campaign(post.campaignId)?.active){save({status:'draft',error:'Набор на паузе'});return;}
 if(!post.accountId||String(post.accountId)!==String(c.threadsUserId)){
  save({status:'draft',error:'Аккаунт изменился. Подтвердите публикацию заново.'});return;
 }
 let stage='create',containerId;
 save({status:'publishing'});
 try{
  const container=await graph(c,c.threadsUserId+'/threads',{media_type:'TEXT',text:post.text});
  if(!container.id)throw new Error('THREADS_API_ERROR');
  stage='publish';containerId=container.id;
  save({status:'publishing',containerId});
  const result=await graph(c,c.threadsUserId+'/threads_publish',{creation_id:containerId});
  if(!result.id)throw new Error('THREADS_API_ERROR');
  const published={...post,status:'published',containerId,remoteId:result.id,publishedAt:new Date().toISOString(),error:''};
  save(published);
  // A missing permalink must never undo a known successful publication.
  try{
   const r=await fetch(THREADS_GRAPH+'/v1.0/'+encodeURIComponent(result.id)+'?fields=permalink',{headers:{authorization:'Bearer '+c.threadsToken},signal:AbortSignal.timeout(10000)}),d=await r.json();
   if(r.ok&&/^https:\/\/(www\.)?threads\.(com|net)\//.test(d.permalink||''))save({permalink:d.permalink});
  }catch{}
 }catch{
  save({containerId,status:stage==='publish'?'needs_check':'failed',error:stage==='publish'?'Ответ Threads неизвестен. Проверьте аккаунт перед повтором.':'Threads не принял пост. Проверьте доступ и разрешение публикации.'});
 }
}
