import {createFixtures} from './fixtures.mjs';
import {normalizeApplication,composePostText,applyAction,canonicalStatus,recommended,priority,assert,RESERVED,matchesApplicationQuery} from './domain.mjs';
const STATIC=document.documentElement.dataset.mode==='demo',KEY='sneg-creator-desk-v2';let candidate=false,memory,identitySession='',authenticatedInitData='';try{memory=JSON.parse(localStorage.getItem(KEY))||createFixtures();}catch{memory=createFixtures();}
const persist=()=>localStorage.setItem(KEY,JSON.stringify(memory));
let actorId='anonymous';
async function request(path,method='GET',body){
 const headers={'content-type':'application/json','x-demo-role':candidate?'candidate':'manager'};
 if(identitySession)headers['x-ugc-session']=identitySession;
 let operationKey,storageKey;
 if(method!=='GET'){
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(method+path+JSON.stringify(body)));
  storageKey='sneg:operation:'+actorId+':'+Array.from(new Uint8Array(hash)).map(n=>n.toString(16).padStart(2,'0')).join('');
  try{operationKey=localStorage.getItem(storageKey)||crypto.randomUUID();localStorage.setItem(storageKey,operationKey);}catch{operationKey=crypto.randomUUID();}
  headers['idempotency-key']=operationKey;
 }
 let r,data;
 try{r=await fetch('/api'+path,{method,headers,credentials:'same-origin',signal:AbortSignal.timeout(35000),body:body===undefined?undefined:JSON.stringify(body)});data=await r.json();}
 catch{const e=new Error(method==='GET'?'Связь прервалась. Попробуйте обновить.':'Ответ не получен. Данные сохранены в форме; повторите действие — второй записи не будет.');e.code='NETWORK_UNKNOWN';throw e;}
 if(r.ok||r.status>=400&&r.status<500&&r.status!==429)try{if(storageKey)localStorage.removeItem(storageKey);}catch{}
 if(!r.ok){const e=new Error(data.error||'Не удалось выполнить действие');e.status=r.status;e.code=data.code;e.requestId=data.requestId;throw e;}
 return data;
}

const demoConnections=()=>({demo:true,telegram:false,threads:false,threadsUsername:'',threadsAppReady:false,ai:'rules',aiConnected:false,callbackUrl:''});
export const api={
 demo:STATIC,localDemo:false,setCandidate(v){candidate=v;},
 async public(){return STATIC?{campaign:memory.campaign,botUsername:'',pilot:false}:request('/public');},
 async session(){if(STATIC)return {user:{id:candidate?'demo-candidate':'demo-manager',name:'Вы',role:candidate?'candidate':'admin'},connections:demoConnections()};const initData=window.Telegram?.WebApp?.initData||'';if(initData&&(initData!==authenticatedInitData||!identitySession)){identitySession='';const auth=await request('/auth','POST',{initData});identitySession=auth.session;authenticatedInitData=initData;}const data=await request('/session');api.localDemo=data.connections.demo;actorId=data.user.id;return data;},
 async campaign(){return STATIC?{campaign:memory.campaign}:request('/campaign');},
 async overview(){if(!STATIC)return request('/overview');const rows=memory.applications,count=s=>rows.filter(a=>s.includes(canonicalStatus(a.status))).length;return {total:rows.length,review:count(['review']),clarification:count(['clarification']),recommended:rows.filter(a=>a.status==='review'&&recommended(a)).length,selected:count(['approved','sent']),sent:count(['sent'])};},
 async list(q={}){if(!STATIC)return request('/applications?'+new URLSearchParams(q));let rows=memory.applications.map(a=>({...a,status:canonicalStatus(a.status)}));const groups={review:['review','clarification'],selected:['approved','sent'],archive:['reserve','rejected','withdrawn']};if(!q.q&&groups[q.queue])rows=rows.filter(a=>groups[q.queue].includes(a.status));if(!q.q&&q.bucket==='recommended')rows=rows.filter(a=>a.status==='review'&&recommended(a));if(!q.q&&q.bucket==='waiting')rows=rows.filter(a=>a.status==='clarification');if(!q.q&&q.bucket==='all_new')rows=rows.filter(a=>a.status==='review');if(!q.q&&q.direction)rows=rows.filter(a=>a.directions.includes(q.direction));if(q.q)rows=rows.filter(a=>matchesApplicationQuery(a,q.q));rows.sort((a,b)=>priority(a)-priority(b)||Date.parse(a.createdAt)-Date.parse(b.createdAt));const offset=Number(q.offset)||0;return {applications:rows.slice(offset,offset+Math.min(500,Number(q.limit)||40)),total:rows.length,hasMore:offset+Math.min(500,Number(q.limit)||40)<rows.length};},
 async detail(id){return STATIC?{application:structuredClone(memory.applications.find(a=>a.id===id))}:request('/applications/'+id);},
 async action(id,action,payload={},version){if(!STATIC)return request('/applications/'+id+'/actions','POST',{action,payload,version});const a=memory.applications.find(a=>a.id===id);assert(a.version===version,'Карточка уже изменилась');if(action==='approve')assert(memory.applications.filter(a=>RESERVED.includes(a.status)).length<memory.campaign.limit,'Лимит набора достигнут');const r=applyAction(a,action,payload,{id:candidate?'demo-candidate':'demo-manager',name:candidate?'Кандидат':'Вы'});r.application.history=[r.event,...(a.history||[])];memory.applications=memory.applications.map(x=>x.id===id?r.application:x);persist();return {application:structuredClone(r.application),message:r.event.text};},
 async mine(){return STATIC?{applications:memory.applications.filter(a=>a.telegramId==='demo-candidate')}:request('/me');},
 async submit(data){if(!STATIC)return request('/applications','POST',data);const existing=memory.applications.find(a=>a.telegramId==='demo-candidate');if(existing)return {application:existing,existing:true};const {evaluate}=await import('./domain.mjs'),a={...normalizeApplication(data,memory.campaign),id:'SN-'+String(memory.applications.length+1).padStart(4,'0'),telegramId:'demo-candidate',username:'demo',status:'review',version:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),history:[],campaignId:memory.campaign.id};a.evaluation=evaluate(a,memory.campaign);memory.applications.unshift(a);persist();return {application:a};},
 async updateCampaign(data){if(!STATIC)return request('/campaign','PATCH',data);memory.campaign={...memory.campaign,...data};persist();return {campaign:memory.campaign};},
 async posts(){return STATIC?{posts:memory.posts}:request('/posts');},
 async savePost(data){if(!STATIC)return request('/posts','POST',data);assert(data.status!=='scheduled','В демонстрации нет настоящего подключения Threads');const content=composePostText(data.text,'https://t.me/sneg_ugc_bot?start=c_sneg-october',data.includeForm!==false);assert([...content].length>=10&&[...content].length<=500,'В Threads можно до 500 символов вместе со ссылкой');const post={...data,text:content,id:data.id||crypto.randomUUID(),status:'draft',createdAt:new Date().toISOString()};memory.posts=[post,...memory.posts.filter(p=>p.id!==post.id)];persist();return {post};},
 async postAction(id,action){assert(!STATIC,'Публикация доступна в рабочем кабинете');return request('/posts/'+id+'/'+action,'POST',{});},
 async connections(){return STATIC?{connections:demoConnections(),jobs:[]}:request('/connections');},
 async integrate(kind,data){assert(!STATIC&&!api.localDemo,'Подключите сервис в рабочем кабинете Telegram');return request('/integrations/'+kind,'POST',data);},
 async team(){return request('/team');},
 async saveMember(data){return request('/team','POST',data);},
 async operations(){return request('/operations');},
 async backup(){return request('/maintenance/backup','POST',{});},
 async retryJob(id,confirmed){return request('/jobs/'+id+'/retry','POST',{confirmed});},
 async retryAI(id){return request('/applications/'+id+'/retry-ai','POST',{});},
 async resolvePost(id,data){return request('/posts/'+id+'/resolve','POST',data);},
 async download(name){const headers={};if(identitySession)headers['x-ugc-session']=identitySession;const r=await fetch('/api/backups/'+encodeURIComponent(name),{headers,credentials:'same-origin',signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('Не удалось скачать копию');const url=URL.createObjectURL(await r.blob()),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);},
 async shortlist(){assert(!STATIC&&!api.localDemo,'Подборки отправляются из рабочего кабинета');return request('/shortlist','POST',{});}
};
