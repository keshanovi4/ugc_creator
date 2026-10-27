export const CITIES=['Алматы','Астана','Шымкент','Караганда','Актобе','Тараз','Павлодар','Усть-Каменогорск','Семей','Атырау','Костанай','Кызылорда','Уральск','Петропавловск','Актау','Кокшетау','Другой город'];
export const LANGUAGES={ru:'Русский',kk:'Қазақша',both:'Русский и қазақша'};
export const STATUS={review:{label:'Нужен выбор',tone:'olive'},clarification:{label:'Уточняем',tone:'amber'},approved:{label:'Выбран',tone:'olive'},sent:{label:'Товар отправлен',tone:'neutral'},reserve:{label:'На потом',tone:'neutral'},rejected:{label:'Пропущен',tone:'neutral'},withdrawn:{label:'Отозвана',tone:'neutral'}};
export const CLOSED=['sent','rejected','withdrawn','reserve'];
export const RESERVED=['approved','sent'];
export const CANDIDATE_ACTIONS=['answer','withdraw'];
export const DEFAULT_CAMPAIGN={id:'sneg-october',name:'Новая улыбка',subtitle:'Креаторы для СНЕГ*',active:true,limit:50,product:'Набор полосок СНЕГ*',responseHours:48,cities:CITIES.slice(0,-1),languages:['ru','kk'],directions:['ugc','reach'],brief:'Ищем креаторов для сотрудничества по бартеру. Отправим набор полосок СНЕГ*. От вас — два честных вертикальных ролика с применением и результатом. Большой блог для UGC не нужен. Публикация в вашем аккаунте обсуждается отдельно для направления «Охваты».',briefVersion:'2026-10-26-v2',consentVersion:'2026-10-26-v2',privacyText:'Анкета используется для отбора и связи в Telegram. Перед рабочим запуском бренд указывает оператора и политику обработки данных.',privacyUrl:'',operator:'',retentionDays:180,productionApproved:false,minViews:1000};
export class AppError extends Error{constructor(message,status=400,code='VALIDATION'){super(message);this.status=status;this.code=code;}}
export function assert(ok,message,status=400,code){if(!ok)throw new AppError(message,status,code);}
export const text=(v,max=1000)=>String(v??'').trim().slice(0,max);
export function matchesApplicationQuery(a,value){const q=text(value,100).toLowerCase();if(!q)return true;const compact=q.replace(/[\s\-–—]+/g,'');return !!compact&&String(a.id||'').toLowerCase().replace(/[\s\-–—]+/g,'').includes(compact)||[a.name,a.username,a.city].some(v=>String(v||'').toLowerCase().includes(q));}
export function composePostText(value,link,includeForm=true){const content=text(value,1500);return includeForm&&!content.includes(link)?content+'\n\nАнкета → '+link:content;}
export function cleanUrl(value){let u;try{u=new URL(text(value));}catch{throw new AppError('Добавьте полную ссылку с https://');}assert(u.protocol==='https:'&&!u.username&&!u.password&&u.hostname.includes('.'),'Нужна публичная HTTPS-ссылка');assert(!/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[)/i.test(u.hostname),'Добавьте публичную ссылку');u.hash='';return u.href;}
export function normalizeApplication(input,c=DEFAULT_CAMPAIGN){
 const name=text(input.name,80),city=text(input.city,80),language=text(input.language,10);
 assert(name.length>=2,'Как к вам обращаться?');assert(CITIES.includes(city),'Выберите город');assert(Object.hasOwn(LANGUAGES,language),'Выберите язык');
 const directions=[...new Set((Array.isArray(input.directions)?input.directions:[]).filter(x=>['ugc','reach'].includes(x)))];assert(directions.length,'Выберите формат сотрудничества');assert(directions.every(x=>c.directions.includes(x)),'Это направление сейчас закрыто');
 assert(input.adult===true,'Для участия нужно быть старше 18 лет');assert(input.consent===true,'Подтвердите согласие на обработку анкеты');assert(input.terms===true,'Ознакомьтесь с условиями сотрудничества');assert(input.closeup===true,'Для этого набора нужна готовность снимать применение крупным планом');
 const portfolio=(Array.isArray(input.portfolio)?input.portfolio:[]).filter(x=>text(x)).slice(0,3).map(cleanUrl),profile=text(input.profile)?cleanUrl(input.profile):'';
 if(directions.includes('reach'))assert(profile,'Для охватов добавьте профиль');
 const number=v=>v===''||v===null||v===undefined?null:Number(v),views=number(input.views),followers=number(input.followers);
 for(const v of [views,followers])assert(v===null||(Number.isSafeInteger(v)&&v>=0&&v<=1e9),'Проверьте статистику: нужно целое неотрицательное число');
 return {name,city,language,directions,portfolio,profile,views,followers,experience:['brand','blog','beginner'].includes(input.experience)?input.experience:'beginner',closeup:true,adult:true,consent:true,terms:true,note:text(input.note,600),audienceKz:input.audienceKz===true,availabilityDays:Math.min(30,Math.max(1,Number(input.availabilityDays)||7)),briefVersion:c.briefVersion,consentVersion:c.consentVersion};
}
export function evaluate(a,c=DEFAULT_CAMPAIGN){
 const eligible=c.cities.includes(a.city),languageMatch=a.language==='both'||c.languages.includes(a.language),reasons=[],unknowns=['Работы и статистика требуют просмотра менеджером'];
 if(a.portfolio.length)reasons.push('Есть примеры работ');else unknowns.push('Нужен пример ролика');if(a.experience==='brand')reasons.push('Заявлен опыт съёмки для брендов');if(a.closeup)reasons.push('Готов(а) снимать крупные планы');if(!eligible)unknowns.push('Город вне текущего набора');if(!languageMatch)unknowns.push('Нужно уточнить язык');
 const ugc=a.directions.includes('ugc')?(eligible&&languageMatch&&a.portfolio.length?'recommended':'clarify'):null;
 const reach=a.directions.includes('reach')?(eligible&&languageMatch&&a.views!==null&&a.views>=(c.minViews??1000)&&a.audienceKz?'recommended':'clarify'):null;
 return {ugc,reach,eligible,languageMatch,reasons,unknowns,portfolioVerified:false,source:'rules',version:'rules-v2',summary:ugc==='recommended'?'Подходит для просмотра UGC':reach==='recommended'?'Есть основания проверить охваты':'Нужно уточнение',aiStatus:'not_configured'};
}
export function canonicalStatus(status){return ({address:'approved',ready:'approved',shipped:'sent',delivered:'sent',content_review:'sent',revision:'sent',completed:'sent'})[status]||status;}
export function applyAction(original,action,p={},actor={id:'demo',name:'Менеджер'},now=new Date().toISOString()){
 const a=structuredClone(original);a.status=canonicalStatus(a.status);const before=a.status;let message='';const is=(...states)=>assert(states.includes(a.status),'Карточка уже изменилась. Обновите её.',409,'STATE_CONFLICT');
 switch(action){
  case 'claim':a.owner=actor.id;a.ownerName=actor.name;message='Взято в работу';break;
  case 'note':assert(text(p.note),'Введите заметку');message=text(p.note,1500);break;
  case 'verify':a.portfolioReviewed=true;message='Работы просмотрены';break;
  case 'approve':is('review','reserve');assert(!a.portfolio.length||a.portfolioReviewed||p.portfolioReviewed===true,'Подтвердите, что посмотрели работу');a.portfolioReviewed=true;a.status='approved';a.approvedAt=now;a.approvedBy=actor.id;a.dueAt=null;message='Кандидат выбран менеджером';break;
  case 'clarify':is('review','clarification');assert(text(p.question).length>=5,'Напишите конкретный вопрос');a.question=text(p.question,1200);delete a.answer;a.status='clarification';a.dueAt=new Date(Date.parse(now)+48*3600000).toISOString();message='Кандидату отправлен вопрос';break;
  case 'answer':is('clarification');assert(text(p.answer).length>=2,'Добавьте ответ');a.answer=text(p.answer,1500);a.status='review';a.dueAt=new Date(Date.parse(now)+24*3600000).toISOString();message='Кандидат ответил';break;
  case 'reject':is('review','clarification','reserve');a.status='rejected';a.reason=text(p.reason,500)||'Не подходит под текущий набор';a.dueAt=null;message='Кандидат пропущен';break;
  case 'reserve':is('review','clarification');a.status='reserve';a.dueAt=null;message='Сохранено на потом';break;
  case 'reopen':is('reserve','rejected');a.status='review';a.dueAt=new Date(Date.parse(now)+24*3600000).toISOString();message='Возвращено в очередь';break;
  case 'mark_sent':is('approved');assert(p.confirmed===true,'Подтвердите, что товар уже отправлен');a.status='sent';a.sentAt=now;a.sentBy=actor.id;a.dueAt=null;message='Менеджер отметил отправку товара';break;
  case 'withdraw':is('review','clarification','approved','reserve');a.status='withdrawn';a.dueAt=null;message='Кандидат отозвал заявку';break;
  default:throw new AppError('Такого действия в отборе нет');
 }
 a.version++;a.updatedAt=now;return {application:a,event:{at:now,actor:actor.name,actorId:actor.id,type:action,text:message,from:before,to:a.status}};
}
export function isOverdue(a){return ['review','clarification'].includes(canonicalStatus(a.status))&&a.dueAt&&Date.parse(a.dueAt)<Date.now();}
export function recommended(a){return a.evaluation?.ai?.recommendation==='recommend'||(!a.evaluation?.ai&&[a.evaluation?.ugc,a.evaluation?.reach].includes('recommended'));}
export function priority(a){return recommended(a)?0:a.answer?1:2;}
export const initials=name=>String(name||'К').trim().split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase();
export const csvCell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';
