import {telegram,analyze} from './integrations.mjs';
import {Service} from './service.mjs';
import {roleFor} from './auth.mjs';
import {recommended,priority,canonicalStatus,LANGUAGES,text} from '../dist/domain.mjs';
import {THREADS_GRAPH} from './connections.mjs';
export function createWorker(store,base,connections){
 let running=false,aiRunning=false,nextAiAt=0;const service=new Service(store,base,connections),cfg=()=>connections?.config()||base;
 const ranked=()=>store.all().filter(a=>canonicalStatus(a.status)==='review').sort((a,b)=>priority(a)-priority(b)||Date.parse(a.createdAt)-Date.parse(b.createdAt));
 const appButton=(label,view='review')=>({text:label,web_app:{url:base.publicUrl+'/?view='+view}});
 async function editable(c,manager,text,reply_markup,key){
  const saved=store.meta(key),body={chat_id:manager,text,reply_markup,disable_web_page_preview:true};
  if(saved){try{await telegram(c,'editMessageText',{...body,message_id:Number(saved)});return;}catch(e){if(e.message!=='TELEGRAM_MESSAGE_GONE')throw e;}}
  const r=await telegram(c,'sendMessage',body);if(r.result?.message_id)store.setMeta(key,r.result.message_id);
 }
 async function digest(manager){const c=cfg(),list=ranked(),top=list.slice(0,3),all=store.all();const text='SNEG · подборка креаторов\n\nНужен выбор: '+list.length+' · Уточняем: '+all.filter(a=>a.status==='clarification').length+'\n'+(top.length?'\nС чего начать:\n'+top.map((a,i)=>(i+1)+'. '+a.name+' · '+a.id+'\n'+a.city+'\n'+(a.evaluation.ai?.summary||a.evaluation.summary)).join('\n\n'):'\n'+(list.length?'Новые анкеты доступны в кабинете.':'Новых анкет пока нет.'))+'\n\n'+(c.aiProvider==='rules'?'Предварительный отбор по правилам. ИИ ещё не подключён.':'ИИ помогает с приоритетом. Решение остаётся за менеджером.');await editable(c,manager,text,{inline_keyboard:[[appButton('Открыть новые заявки','review&bucket=all_new')],[{text:'Разобрать кандидата',callback_data:'next'}]]},'digest_message:'+manager);}
 async function notifyNewApplications(){
  const c=cfg(),pending=ranked();if(!pending.length)return;
  const sequence=a=>Number(a.id.replace(/^SN-/,''))||0;
  for(const manager of new Set([...base.adminIds,...base.managerIds])){
   const now=Date.now(),last=Number(store.meta('intake_notice_at:'+manager)||0),retry=Number(store.meta('intake_notice_retry:'+manager)||0);
   if(now<retry||last&&now-last<900000)continue;
   const through=Number(store.meta('intake_notice_sequence:'+manager)||0),fresh=pending.filter(a=>sequence(a)>through);if(!fresh.length)continue;
   const title=fresh.length===1?'Новая анкета · '+fresh[0].id:'Новые анкеты: '+fresh.length;
   try{
    await telegram(c,'sendMessage',{chat_id:manager,text:title+'\n\nАнкеты уже в очереди. Откройте новые заявки или разберите кандидата прямо здесь.',reply_markup:{inline_keyboard:[[appButton('Открыть новые заявки','review&bucket=all_new')],[{text:'Разобрать кандидата',callback_data:'next'}]]}});
    store.setMeta('intake_notice_sequence:'+manager,Math.max(...pending.map(sequence)));store.setMeta('intake_notice_at:'+manager,now);store.setMeta('intake_notice_error:'+manager,'');
   }catch(e){store.setMeta('intake_notice_error:'+manager,/^TELEGRAM_/.test(e.message)?e.message:'TELEGRAM_UNAVAILABLE');store.setMeta('intake_notice_retry:'+manager,now+Math.max(60000,(e.retryAfter||0)*1000));}
  }
 }
 async function renderCard(manager,a){
  const ai=a.evaluation.ai,waiting=a.status==='clarification';
  const reason=(ai?.reasons||a.evaluation.reasons||[]).slice(0,2).join('; '),unknown=(ai?.unknowns||a.evaluation.unknowns||[])[0]||'Посмотрите работу перед выбором';
  const reply=waiting?'\n\nЖдём ответ на вопрос: '+text(a.question,650):a.answer?'\n\nВопрос менеджера: '+text(a.question,300)+'\nОтвет кандидата: '+text(a.answer,650):'';
  const message=a.name+' · '+a.id+'\n'+a.city+' · '+LANGUAGES[a.language]+' · '+a.directions.map(x=>x==='ugc'?'UGC':'Охваты').join(' + ')+'\n\n'+(ai?'ИИ: ':'По анкете: ')+(ai?.summary||a.evaluation.summary)+'\n'+reason+'\n\nПроверить: '+unknown+reply+'\n\nРаботы открываются по ссылкам ниже.'+(waiting?' Ответ появится в этой карточке.':' Выбор подтверждает просмотр портфолио.');
  const links=a.portfolio.slice(0,2).map((url,i)=>({text:'Работа '+(i+1),url}));
  const decisions=waiting?[]:[[{text:'Выбрать',callback_data:'pick:'+a.id+':'+a.version},{text:'Уточнить',callback_data:'ask:'+a.id+':'+a.version}],[{text:'Пропустить',callback_data:'skip:'+a.id+':'+a.version}]];
  await editable(cfg(),manager,message,{inline_keyboard:[...(links.length?[links]:[]),...decisions,[{text:'Другой кандидат',callback_data:'next'}],[appButton('Открыть карточку','review&candidate='+a.id)]]},'candidate_message:'+manager);
  store.setMeta('candidate_app:'+manager,a.id);store.setMeta('candidate_version:'+manager,a.version);
 }
 async function card(manager,next=false,preferredId=''){
  const preferred=preferredId&&store.app(preferredId);
  if(preferred&&['review','clarification'].includes(preferred.status)){await renderCard(manager,preferred);return;}
  const list=ranked();
  if(!list.length){
   if(store.meta('candidate_message:'+manager))await editable(cfg(),manager,'Новые анкеты разобраны. Выбранные креаторы и история сохранены в кабинете.',{inline_keyboard:[[appButton('Открыть выбранных','review&bucket=selected')]]},'candidate_message:'+manager);
   store.setMeta('candidate_app:'+manager,'');store.setMeta('candidate_version:'+manager,'');await digest(manager);return;
  }
  const index=next?(Number(store.meta('card_index:'+manager)||-1)+1)%list.length:0;store.setMeta('card_index:'+manager,index);await renderCard(manager,list[index]);
 }
 async function refreshCards(){
  for(const manager of new Set([...base.adminIds,...base.managerIds])){
   const id=store.meta('candidate_app:'+manager);if(!id)continue;
   const a=store.app(id);if(!a||a.version!==Number(store.meta('candidate_version:'+manager)))await card(manager,false,id);
  }
 }
 async function incoming(p){const c=cfg(),u={id:p.from.id,name:p.from.name,username:p.from.username,role:roleFor(p.from.id,base)},team=['admin','manager'].includes(u.role);
  if(p.callback){
   let answer='';
   if(!team)answer='Это действие доступно менеджеру';
   else if(p.callback.data==='next')await card(u.id,true);
   else{
    const m=p.callback.data.match(/^(pick|skip|ask):([A-Z0-9-]+):(\d+)$/);
    if(m){
     if(m[1]==='ask'){
      const a=store.app(m[2]);
      if(!a||a.version!==Number(m[3])){answer='Карточка обновлена. Посмотрите новые данные.';await card(u.id,false,m[2]);}
      else{store.setMeta('question:'+u.id,JSON.stringify({id:a.id,version:a.version,at:Date.now()}));store.enqueue('telegram',{chatId:u.id,text:'Напишите вопрос для '+a.name+' одним сообщением. Чтобы отменить — /cancel.',plain:true});answer='Жду текст вопроса';}
     }else{
      try{
       service.action(u,m[2],{action:m[1]==='pick'?'approve':'reject',version:Number(m[3]),payload:m[1]==='pick'?{portfolioReviewed:true}:{reason:'Не подходит под текущий набор'}},'callback:'+p.callback.id);
       answer=m[1]==='pick'?'Кандидат выбран':'Пропущен';await card(u.id);
      }catch(e){
       answer='Не удалось сохранить решение';
       if(e.status===409){const fresh=store.app(m[2]);answer=fresh&&['review','clarification'].includes(fresh.status)?'Карточка обновлена. Посмотрите ответ и повторите выбор.':'Кандидата уже разобрали. Решение не изменилось.';await card(u.id,false,m[2]);}
      }
     }
    }
   }
   await telegram(c,'answerCallbackQuery',{callback_query_id:p.callback.id,text:answer||'Готово'});return;
  }
  if(team){
   const pending=store.meta('question:'+u.id);
   if(p.text==='/cancel'){store.setMeta('question:'+u.id,'');store.enqueue('telegram',{chatId:u.id,text:'Вопрос отменён.',plain:true});return;}
   if(pending&&!p.text.startsWith('/')){
    const question=JSON.parse(pending);store.setMeta('question:'+u.id,'');
    if(Date.now()-question.at>=900000){store.enqueue('telegram',{chatId:u.id,text:'Время ввода вопроса истекло. Откройте кандидата и нажмите «Уточнить» ещё раз.',plain:true});return;}
    try{service.action(u,question.id,{action:'clarify',version:question.version,payload:{question:p.text}},'update:'+p.updateId);store.enqueue('telegram',{chatId:u.id,text:'Вопрос отправлен кандидату.',plain:true});}
    catch(e){if(!e.status)throw e;store.enqueue('telegram',{chatId:u.id,text:e.status===409?'Карточка изменилась. Вопрос не отправлен: откройте актуальную карточку и нажмите «Уточнить» ещё раз.':e.message,plain:true});}
    return;
   }
   if(p.text==='/id'){store.enqueue('telegram',{chatId:u.id,text:'Ваш Telegram ID: '+u.id,plain:true});return;}await digest(u.id);return;
  }
  if(p.text.startsWith('/start')){const ref=p.text.split(/\s+/)[1],campaign=store.campaign(ref?.startsWith('c_')?ref.slice(2):undefined)||store.campaign();store.subscribe(u.id,campaign.id);store.enqueue('telegram',{chatId:u.id,text:'Привет! Это набор креаторов SNEG. Заполните короткую анкету — результат придёт сюда.',campaignId:campaign.id});return;}
  if(p.text==='/id'){store.enqueue('telegram',{chatId:u.id,text:'Ваш Telegram ID: '+u.id,plain:true});return;}
  const a=store.mine(u.id).find(a=>a.status==='clarification');if(a&&p.text&&!p.text.startsWith('/')){service.action(u,a.id,{action:'answer',version:a.version,payload:{answer:p.text}},'update:'+p.updateId);store.enqueue('telegram',{chatId:u.id,text:'Ответ передан менеджеру. Спасибо!',appId:a.id});return;}
  store.enqueue('telegram',{chatId:u.id,text:store.mine(u.id).length?'Результат и статус заявки — в кабинете.':'Анкета открывается кнопкой ниже.'});
 }
 function failJob(job,e){const code=/^(AI_|TELEGRAM_)/.test(e.message)?e.message:'INTEGRATION_UNAVAILABLE',attempts=job.attempts+1;store.updateJob(job.id,code==='TELEGRAM_BLOCKED'||attempts>=4?'failed':'pending',attempts,code,new Date(Date.now()+(e.retryAfter?e.retryAfter*1000:Math.min(3600000,30000*2**attempts))).toISOString());if(job.kind==='ai'){const a=store.app(job.payload.appId);if(a&&a.status==='review'){a.evaluation.aiStatus='unavailable';store.save(a);store.setMeta('shortlist_dirty','1');}}}
 async function aiTick(){
  if(aiRunning||Date.now()<nextAiAt)return;aiRunning=true;
  try{
   const job=store.dueJobs(new Date().toISOString(),{kind:'ai',limit:1})[0];if(!job)return;
   const c=cfg(),today=new Date().toISOString().slice(0,10),a=store.app(job.payload.appId);
   if(c.aiProvider==='rules'||!a||a.status!=='review'){store.updateJob(job.id,'done',job.attempts);return;}
   const count=Number(store.meta('ai:'+today)||0);
   if(count>=c.aiDailyLimit){store.updateJob(job.id,'pending',job.attempts,'AI_DAILY_LIMIT',new Date(Date.now()+3600000).toISOString());return;}
   try{
    nextAiAt=Date.now()+Math.max(5000,c.aiMinInterval||5000);store.setMeta('ai:'+today,count+1);const result=await analyze(a,c);
    store.tx(()=>{const fresh=store.app(a.id);if(fresh?.status==='review'){fresh.evaluation={...fresh.evaluation,ai:result,aiStatus:'done',source:c.aiProvider,aiAt:new Date().toISOString()};fresh.version++;store.save(fresh);store.setMeta('shortlist_dirty','1');}store.updateJob(job.id,'done',job.attempts+1);});
   }catch(e){failJob(job,e);}
  }finally{aiRunning=false;}
 }
 async function interactiveTick(){if(running)return;running=true;try{let c=cfg();const today=new Date().toISOString().slice(0,10);if(connections&&!c.demo&&store.meta('refresh_day')!==today){store.setMeta('refresh_day',today);await connections.refresh();c=cfg();}
  for(const job of store.dueJobs(new Date().toISOString(),{excludeKind:'ai',limit:4})){try{
   if(job.kind==='telegram_update')await incoming(job.payload);
   else if(job.kind==='telegram'){const p=job.payload;await telegram(c,'sendMessage',{chat_id:p.chatId,text:p.text,...(!p.plain?{reply_markup:{inline_keyboard:[[appButton('Открыть анкету / статус','apply')]]}}:{})});}
   store.updateJob(job.id,'done',job.attempts+1);
  }catch(e){failJob(job,e);}}
  if(!c.demo){await refreshCards();await notifyNewApplications();}
  if(!c.demo&&store.meta('shortlist_dirty')==='1'&&Date.now()-Number(store.meta('shortlist_last')||0)>=300000){for(const manager of new Set([...base.adminIds,...base.managerIds]))await digest(manager);store.setMeta('shortlist_dirty','0');store.setMeta('shortlist_last',Date.now());}
  if(!c.demo&&c.threadsToken&&c.threadsUserId)for(const p of store.posts().filter(p=>p.status==='scheduled'&&Date.parse(p.scheduledAt)<=Date.now()).slice(0,2))await publishThread(p,store,c);
 }finally{running=false;}}
 async function tick(){await Promise.all([interactiveTick(),aiTick()]);}
 return {tick};
}
async function graph(c,path,body){let r,d;try{r=await fetch(THREADS_GRAPH+'/v1.0/'+path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',authorization:'Bearer '+c.threadsToken},body:new URLSearchParams(body),signal:AbortSignal.timeout(20000)});d=await r.json();}catch{throw new Error('THREADS_NETWORK_ERROR');}if(!r.ok||d.error)throw new Error('THREADS_API_ERROR');return d;}
export async function publishThread(post,store,c){
 if(!store.campaign(post.campaignId)?.active){store.savePost({...post,status:'draft',error:'Набор на паузе'});return;}
 if(!post.accountId||String(post.accountId)!==String(c.threadsUserId)){
  store.savePost({...post,status:'draft',error:'Аккаунт изменился. Подтвердите публикацию заново.'});return;
 }
 let stage='create',containerId;
 store.savePost({...post,status:'publishing'});
 try{
  const container=await graph(c,c.threadsUserId+'/threads',{media_type:'TEXT',text:post.text});
  if(!container.id)throw new Error('THREADS_API_ERROR');
  stage='publish';containerId=container.id;
  store.savePost({...post,status:'publishing',containerId});
  const result=await graph(c,c.threadsUserId+'/threads_publish',{creation_id:containerId});
  if(!result.id)throw new Error('THREADS_API_ERROR');
  const published={...post,status:'published',containerId,remoteId:result.id,publishedAt:new Date().toISOString(),error:''};
  store.savePost(published);
  // A missing permalink must never undo a known successful publication.
  try{
   const r=await fetch(THREADS_GRAPH+'/v1.0/'+encodeURIComponent(result.id)+'?fields=permalink',{headers:{authorization:'Bearer '+c.threadsToken},signal:AbortSignal.timeout(10000)}),d=await r.json();
   if(r.ok&&/^https:\/\/(www\.)?threads\.(com|net)\//.test(d.permalink||''))store.savePost({...published,permalink:d.permalink});
  }catch{}
 }catch{
  store.savePost({...post,containerId,status:stage==='publish'?'needs_check':'failed',error:stage==='publish'?'Ответ Threads неизвестен. Проверьте аккаунт перед повтором.':'Threads не принял пост. Проверьте доступ и разрешение публикации.'});
 }
}
