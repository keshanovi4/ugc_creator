import {createHash,randomUUID} from 'node:crypto';
import {assert,composePostText,normalizeApplication,applyAction,evaluate,CANDIDATE_ACTIONS,DEFAULT_CAMPAIGN,text,cleanUrl,canonicalStatus} from '../dist/domain.mjs';
import {canPublish,roleFor,teamIds} from './auth.mjs';
import {queueEvaluation} from './ai-state.mjs';

export class Service{
 constructor(store,config={},connections){this.store=store;this.config=config;this.connections=connections;}
 currentConfig(){return this.connections?.config()||this.config;}
 actor(u){return {id:u.id,name:u.name||'Менеджер'};}
 manager(u){assert(['admin','manager'].includes(u.role),'Доступ только для менеджера',403);}
 publisher(u){assert(canPublish(u,this.store),'Публикации доступны владельцу или сотруднику с правом Threads',403);}
 owner(u){assert(u.role==='admin','Действие доступно владельцу',403);}
 sanitize(a,u,detail=false){
  if(u.role==='candidate'){
   const keys=['id','name','city','language','directions','portfolio','profile','views','followers','experience','availabilityDays','closeup','adult','consent','terms','note','audienceKz','campaignId','briefText','briefVersion','consentVersion','version','createdAt','updatedAt','question','answer'];
   return {...Object.fromEntries(keys.filter(k=>a[k]!==undefined).map(k=>[k,structuredClone(a[k])])),status:canonicalStatus(a.status)};
  }
  const r=structuredClone(a);r.status=canonicalStatus(r.status);
  for(const key of ['shippingAddress','shipment','content','acceptedAt','contentDays','receivedAt'])delete r[key];
  if(!detail)delete r.history;return r;
 }
 ready(c){return !!(this.config.demo||!this.config.production&&this.config.pilot||c.productionApproved&&c.operator&&c.privacyText&&c.brief?.length>20);}
 publicCampaign(c){return {...c,ready:this.ready(c),pilot:!this.config.production&&!!this.config.pilot};}
 consent(input,c){if(!this.config.demo)assert(input.briefVersion===c.briefVersion&&input.consentVersion===c.consentVersion,'Условия обновились. Прочитайте их и подтвердите согласие ещё раз.',409,'CONDITIONS_CHANGED');}
 idem(u,key,body,fn){
  assert(typeof key==='string'&&key.length>=8&&key.length<=100,'Необходим идентификатор операции');
  const hash=createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return this.store.tx(()=>{const cached=this.store.cached(u.id,key);if(cached){assert(cached.hash===hash,'Идентификатор уже использован для другой операции',409);return cached.result;}const result=fn();this.store.cache(u.id,key,hash,result);return result;});
 }
 create(u,input,key){
  assert(input&&typeof input==='object'&&!Array.isArray(input),'Проверьте поля анкеты');
  return this.idem(u,key,input,()=>{
   const c=this.store.campaign(input.campaignId||DEFAULT_CAMPAIGN.id);assert(c,'Кампания не найдена',404);
   const existing=this.store.find(u.id,c.id);if(existing)return {application:this.sanitize(existing,u,true),existing:true};
   assert(c.active,'Набор на паузе',409);assert(this.ready(c),'Бренд ещё готовит условия набора',409);this.consent(input,c);
   const normalized=normalizeApplication(input,c),now=new Date().toISOString();
   const a={...normalized,id:this.store.nextId(),telegramId:u.id,username:u.username||'',campaignId:c.id,briefText:c.brief,status:'review',version:1,createdAt:now,updatedAt:now,dueAt:new Date(Date.now()+c.responseHours*3600000).toISOString(),evaluation:evaluate(normalized,c)};
   queueEvaluation(this.store,a,this.currentConfig());
   this.store.event(a.id,{at:now,actor:'Кандидат',type:'created',text:'Анкета получена'});
   this.store.enqueue('telegram',{chatId:u.id,text:'Анкета '+a.id+' получена. Напишем сюда после решения менеджера.',appId:a.id});
   return {application:this.sanitize(this.store.app(a.id),u,true),existing:false};
  });
 }
 action(u,id,input,key){return this.idem(u,key,{id,...input},()=>{
  const a=this.store.app(id);assert(a,'Заявка не найдена',404);
  if(u.role==='candidate'){assert(a.telegramId===u.id,'Это чужая заявка',403);assert(CANDIDATE_ACTIONS.includes(input.action),'Действие доступно менеджеру',403);}
  else{this.manager(u);assert(!CANDIDATE_ACTIONS.includes(input.action),'Ответ должен отправить кандидат',403);}
  assert(Number(input.version)===a.version,'Карточка уже изменилась. Обновите её.',409,'VERSION_CONFLICT');
  if(a.owner&&roleFor(a.owner,this.config,this.store)==='candidate'){delete a.owner;delete a.ownerName;}
  if(u.role==='manager'&&a.owner&&a.owner!==u.id)assert(false,'Кандидат уже в работе у '+(a.ownerName||'другого менеджера'),409,'OWNER_CONFLICT');
  if(input.action==='approve'){
   const c=this.store.campaign(a.campaignId);assert(c.active,'Набор на паузе',409);
   assert(this.store.queryApplications({campaignId:c.id,queue:'selected',limit:1}).total<c.limit,'Лимит набора достигнут. Можно сохранить на потом.',409);
  }
  let r;
  if(input.action==='edit'){
   assert(['review','clarification','reserve'].includes(a.status),'Эту анкету уже нельзя изменить',409);
   const c=this.store.campaign(a.campaignId);this.consent(input.payload||{},c);const normalized=normalizeApplication(input.payload||{},c),now=new Date().toISOString();
   const application={...a,...normalized,briefText:c.brief,status:'review',version:a.version+1,updatedAt:now,evaluation:evaluate(normalized,c)};delete application.question;delete application.answer;
   r={application,event:{at:now,actor:'Кандидат',actorId:u.id,type:'edit',text:'Кандидат обновил анкету',from:a.status,to:'review'}};
  }else{
   let actor=this.actor(u);
   if(input.action==='claim'&&input.payload?.ownerId&&input.payload.ownerId!==u.id){this.owner(u);const target=String(input.payload.ownerId);assert(roleFor(target,this.config,this.store)!=='candidate','Сначала добавьте сотрудника в команду');actor={id:target,name:this.store.member(target)?.name||target};}
   r=applyAction(a,input.action,input.payload||{},actor);
  }
  this.store.save(r.application);this.store.event(id,r.event);
  if(['answer','reopen','edit','clarify'].includes(input.action))queueEvaluation(this.store,r.application,this.currentConfig(),{force:input.action==='edit'});
  const messages={clarify:'По анкете '+id+' есть вопрос:\n'+r.application.question,approve:'Ваша заявка '+id+' выбрана! Менеджер свяжется с вами в Telegram, чтобы согласовать передачу товара.',mark_sent:'Менеджер отметил отправку товара по заявке '+id+'. Детали можно уточнить в личной переписке.'};
  if(messages[input.action])this.store.enqueue('telegram',{chatId:a.telegramId,text:messages[input.action],appId:id});
  if(input.action==='withdraw'&&canonicalStatus(a.status)==='approved'){
   let recipients=[...new Set([a.owner,a.approvedBy].filter(id=>id&&roleFor(id,this.config,this.store)!=='candidate'))];
   if(!recipients.length)recipients=this.config.adminIds||[];
   for(const chatId of recipients)this.store.enqueue('telegram',{chatId,text:'Кандидат '+a.name+' · '+id+' отозвал выбранную анкету. Не передавайте товар по этой заявке; статус обновлён в кабинете.',appId:id,plain:true});
  }
  this.store.setMeta('shortlist_dirty','1');this.store.setMeta('shortlist_last','0');
  return {application:this.sanitize(this.store.app(id),u,true),message:r.event.text};
 });}
 list(u,q={}){this.manager(u);const r=this.store.queryApplications({...q,owner:q.owner==='mine'?u.id:q.owner});return {...r,applications:r.applications.map(a=>this.sanitize(a,u))};}
 overview(u){this.manager(u);return this.store.counts();}
 updateCampaign(u,input){
  this.owner(u);return this.store.tx(()=>{
   const c=this.store.campaign(),limit=Number(input.limit??c.limit),minViews=Number(input.minViews??c.minViews??1000),retentionDays=Number(input.retentionDays??c.retentionDays??180);
   assert(Number.isInteger(limit)&&limit>=1&&limit>=this.store.counts().selected&&limit<=100000,'Проверьте лимит набора');
   assert(Number.isSafeInteger(minViews)&&minViews>=0&&minViews<=1e9,'Проверьте ориентир просмотров');
   assert(Number.isInteger(retentionDays)&&retentionDays>=30&&retentionDays<=3650,'Срок хранения: от 30 до 3650 дней');
   const next={...c,limit,minViews,retentionDays,name:text(input.name??c.name,100),brief:text(input.brief??c.brief,5000),operator:text(input.operator??c.operator,300),privacyUrl:input.privacyUrl===undefined?c.privacyUrl:input.privacyUrl?cleanUrl(input.privacyUrl):'',privacyText:text(input.privacyText??c.privacyText,5000),active:input.active===undefined?c.active:input.active===true,productionApproved:input.productionApproved===undefined?c.productionApproved:input.productionApproved===true,retentionEnabled:input.retentionEnabled===undefined?!!c.retentionEnabled:input.retentionEnabled===true};
   if(minViews!==c.minViews)next.criteriaRevision=(c.criteriaRevision||1)+1;
   if(next.productionApproved||next.retentionEnabled)assert(next.operator&&next.privacyText&&next.brief.length>20,'Добавьте название компании, объяснение обработки анкеты и условия');
   if(['brief','privacyText','privacyUrl','operator','retentionDays'].some(k=>next[k]!==c[k]))next.briefVersion=next.consentVersion=new Date().toISOString()+'-'+randomUUID().slice(0,8);
   this.store.saveCampaign(next);
   if(minViews!==c.minViews){
    // Capture IDs before updating scores: changing rank must not move rows between pages.
    const ids=this.store.db.prepare("SELECT id FROM applications WHERE campaign_id=? AND status='review'").all(c.id);
    for(const {id} of ids){const a=this.store.app(id);a.version++;a.updatedAt=new Date().toISOString();queueEvaluation(this.store,a,this.currentConfig(),{force:true});}
   }
   return {campaign:this.publicCampaign(next)};
  });
 }
 savePost(u,input,key){
  this.publisher(u);return this.idem(u,key,input,()=>{
   const operationHash=createHash('sha256').update(JSON.stringify({id:input.id||null,version:input.version??null,accountId:input.accountId??null,text:input.text,includeForm:input.includeForm!==false,status:input.status==='scheduled'?'scheduled':'draft',scheduledAt:input.scheduledAt||null})).digest('hex');
   const operationId=text(input.operationId,100),scope='post:'+u.id,cached=operationId&&this.store.cached(scope,operationId);
   if(cached){assert(cached.hash===operationHash,'Операция уже сохранена с другим содержимым. Начните новое сохранение.',409,'OPERATION_CONFLICT');const current=this.store.posts().find(p=>p.id===cached.result.post.id);return {post:current||cached.result.post};}
   if(input.operationId){const prior=this.store.db.prepare("SELECT data FROM posts WHERE json_extract(data,'$.operationId')=? AND json_extract(data,'$.operationActor')=?").get(String(input.operationId),u.id);if(prior){const post=JSON.parse(prior.data);assert(post.operationHash===operationHash,'Операция уже сохранена с другим содержимым. Начните новое сохранение.',409,'OPERATION_CONFLICT');return {post};}}
   const link=this.config.botUsername?'https://t.me/'+this.config.botUsername+'?start=c_'+DEFAULT_CAMPAIGN.id:this.config.publicUrl+'/?view=apply';
   const content=composePostText(text(input.text,1500),link,input.includeForm!==false);assert([...content].length>=10&&[...content].length<=500,'В Threads можно до 500 символов вместе со ссылкой');
   const old=input.id?this.store.posts().find(p=>p.id===input.id):null;if(input.id)assert(old,'Пост не найден',404);
   if(old){assert(['draft','scheduled','failed'].includes(old.status),'Этот пост уже публикуется или опубликован',409);assert(Number.isInteger(Number(input.version))&&Number(input.version)===(old.version||1),'Публикация изменена или версия не указана. Откройте актуальный черновик.',409,'VERSION_CONFLICT');}
   const time=input.scheduledAt?Date.parse(input.scheduledAt):null;assert(time===null||Number.isFinite(time),'Проверьте дату публикации');
   const scheduledAt=time===null?null:new Date(time).toISOString(),status=input.status==='scheduled'?'scheduled':'draft';
   if(status==='scheduled'){assert(input.accountId===undefined||String(input.accountId)===String(this.currentConfig().threadsUserId),'Аккаунт Threads изменился. Проверьте его перед публикацией.',409,'VERSION_CONFLICT');assert(this.health().threads,'Сначала подключите Threads');assert(scheduledAt&&time>Date.now(),'Выберите время в будущем');}
   const post={id:old?.id||randomUUID(),text:content,campaignId:DEFAULT_CAMPAIGN.id,status,scheduledAt,accountId:status==='scheduled'?this.currentConfig().threadsUserId:null,createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),createdBy:old?.createdBy||u.id,version:(old?.version||0)+1,operationId:text(input.operationId,100)};
   post.operationActor=u.id;post.operationHash=operationHash;this.store.savePost(post);if(operationId)this.store.cache(scope,operationId,operationHash,{post});return {post};
  });
 }
 team(u){
  this.owner(u);return {members:teamIds(this.config,this.store).map(id=>{const m=this.store.member(id)||{id,name:id,publish:false};const owner=this.config.adminIds.includes(id),profile=JSON.parse(this.store.meta('profile:'+id)||'{}');return {...m,name:profile.name||m.name||id,role:owner?'admin':'manager',active:true,publish:owner||m.publish===true,lastSeen:profile.lastSeen||null,error:this.store.meta('delivery_error:'+id)||'',lastDelivered:this.store.meta('delivery_ok:'+id)||null};}),events:this.store.teamEvents()};
 }
 setMember(u,input){this.owner(u);const id=text(input.id,20);assert(/^\d{1,16}$/.test(id)&&Number.isSafeInteger(Number(id))&&Number(id)>0,'Укажите числовой Telegram ID');assert(!this.config.adminIds.includes(id),'Доступ владельца задаётся отдельно');assert(input.confirmed===true,'Подтвердите изменение доступа');const member={id,name:text(input.name,80)||id,active:input.active!==false,publish:input.publish===true,updatedAt:new Date().toISOString()};this.store.tx(()=>{
  this.store.saveMember(member);let released=0;
  if(!member.active){
   for(const row of this.store.db.prepare("SELECT id FROM applications WHERE json_extract(data,'$.owner')=?").all(id)){
    const a=this.store.app(row.id);delete a.owner;delete a.ownerName;a.version++;this.store.save(a);released++;
    this.store.event(a.id,{at:member.updatedAt,actor:u.name||'Владелец',actorId:u.id,type:'release',text:'Назначение снято: доступ сотрудника отозван',from:a.status,to:a.status});
   }
   this.store.setMeta('question:'+id,'');
  }
  this.store.teamEvent({at:member.updatedAt,actorId:u.id,actor:u.name||'Владелец',id,active:member.active,publish:member.publish,released});this.store.setMeta('shortlist_dirty','1');this.store.setMeta('shortlist_last','0');
 });return this.team(u);}
 retryJob(u,id,input={}){this.owner(u);const job=this.store.db.prepare('SELECT * FROM jobs WHERE id=?').get(Number(id));assert(job&&job.status==='failed','Задание не найдено или уже обрабатывается',409);assert(['ai','telegram','telegram_update'].includes(job.kind),'Нельзя повторить это задание');assert(input.confirmed===true,'Подтвердите повтор задания');this.store.updateJob(job.id,'pending',0);if(job.kind==='ai'){const a=this.store.app(JSON.parse(job.payload).appId);if(a){a.evaluation.aiStatus='pending';this.store.save(a);}}return {queued:true};}
 retryAI(u,id){this.manager(u);const a=this.store.app(id);assert(a?.status==='review','Верните анкету в новые перед оценкой',409);assert(this.currentConfig().aiProvider!=='rules','Сначала подключите ИИ');queueEvaluation(this.store,a,this.currentConfig(),{force:true});return {application:this.sanitize(this.store.app(id),u,true)};}
 health(){return this.connections?.status()||{telegram:!!this.config.botToken,ai:this.config.aiProvider||'rules',aiConnected:this.config.aiProvider!=='rules'&&!!this.config.aiModel,threads:!!(this.config.threadsToken&&this.config.threadsUserId),demo:!!this.config.demo,pilot:!!this.config.pilot};}
}
