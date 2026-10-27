import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
export const toolsDir=dirname(fileURLToPath(import.meta.url));
export const appDir=resolve(toolsDir,'../sneg-ugc');
export const statePath=resolve(appDir,'data/pilot-setup.json');
export const runtimePath=resolve(appDir,'data/pilot-runtime.json');
export async function readState(){
 const s=JSON.parse(await readFile(statePath,'utf8'));
 if(!/^\d+:[A-Za-z0-9_-]{20,}$/.test(s.botToken||''))throw new Error('BOT_TOKEN_INVALID');
 if(!/^\d+$/.test(s.ownerId||''))throw new Error('OWNER_NOT_CONFIRMED');
 return s;
}
export async function saveState(s){await writeFile(statePath,JSON.stringify(s,null,2),{mode:0o600});}
export async function botCall(s,method,body={},fetcher=fetch){
 let r,d;try{r=await fetcher('https://api.telegram.org/bot'+s.botToken+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});d=await r.json();}catch{throw new Error('TELEGRAM_NETWORK_ERROR');}
 if(!r.ok||!d.ok)throw new Error(d.error_code===401?'BOT_TOKEN_REVOKED':'TELEGRAM_API_ERROR_'+(d.error_code||r.status));
 return d.result;
}
export async function checkBot(s){const me=await botCall(s,'getMe');if(me.username!==s.botUsername)throw new Error('BOT_USERNAME_MISMATCH');return me;}
export function isAllowedTunnelUrl(url){return /^https:\/\/(?:[a-z0-9-]+\.trycloudflare\.com|[a-z0-9-]+-3100\.[a-z0-9-]+\.devtunnels\.ms)$/.test(url);}
export function extractTunnelUrl(log,provider='microsoft'){
 return [...log.matchAll(/https:\/\/[a-z0-9.-]+/g)].map(m=>m[0]).find(url=>isAllowedTunnelUrl(url)&&(provider==='cloudflare'?url.endsWith('.trycloudflare.com'):url.endsWith('.devtunnels.ms')))||'';
}
export async function verifyPublic(url,fetcher=fetch){
 if(!isAllowedTunnelUrl(url))throw new Error('UNEXPECTED_TUNNEL_DOMAIN');
 const health=await fetcher(url+'/healthz',{signal:AbortSignal.timeout(5000),redirect:'error'});
 if(!health.ok||(await health.json()).ok!==true)throw new Error('PUBLIC_HEALTH_FAILED');
 const auth=await fetcher(url+'/api/session',{signal:AbortSignal.timeout(5000),redirect:'error',headers:{'x-demo-role':'manager'}});
 if(auth.status!==401)throw new Error('PUBLIC_AUTH_GUARD_FAILED');
}
export async function configureBot(s,url,fetcher=fetch){
 await verifyPublic(url,fetcher);
 await botCall(s,'setMyCommands',{commands:[{command:'start',description:'Открыть SNEG'},{command:'status',description:'Моя заявка'},{command:'id',description:'Мой Telegram ID'},{command:'help',description:'Помощь'}]},fetcher);
 await botCall(s,'setChatMenuButton',{menu_button:{type:'web_app',text:'SNEG',web_app:{url}}},fetcher);
 await botCall(s,'setWebhook',{url:url+'/telegram/webhook',secret_token:s.webhookSecret,allowed_updates:['message','callback_query'],drop_pending_updates:false},fetcher);
}
