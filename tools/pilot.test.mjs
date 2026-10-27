import test from 'node:test';
import assert from 'node:assert/strict';
import {configureBot,verifyPublic,botCall,extractTunnelUrl,isAllowedTunnelUrl} from './pilot-common.mjs';
const url='https://test-only.trycloudflare.com',s={botToken:'fake-test-token',webhookSecret:'fake-secret'};
const json=(status,data)=>({ok:status>=200&&status<300,status,json:async()=>data});
test('при недоступном HTTPS настройки Telegram не меняются',async()=>{const calls=[];await assert.rejects(configureBot(s,url,async u=>{calls.push(u);throw new Error('offline');}));assert.deepEqual(calls,[url+'/healthz']);});
test('публичное демо без авторизации не подключается к боту',async()=>{const calls=[];await assert.rejects(configureBot(s,url,async u=>{calls.push(u);return json(200,{ok:true});}),/PUBLIC_AUTH_GUARD_FAILED/);assert.equal(calls.length,2);assert.ok(calls.every(u=>u.startsWith(url)));});
test('после проверки HTTPS и входа webhook сохраняет ожидающие сообщения',async()=>{const methods=[];await configureBot(s,url,async(u,o)=>{if(u.endsWith('/healthz'))return json(200,{ok:true});if(u.endsWith('/api/session'))return json(401,{});methods.push({method:u.split('/').pop(),body:JSON.parse(o.body)});return json(200,{ok:true,result:true});});assert.deepEqual(methods.map(x=>x.method),['setMyCommands','setChatMenuButton','setWebhook']);assert.equal(methods.at(-1).body.drop_pending_updates,false);assert.equal(methods.at(-1).body.url,url+'/telegram/webhook');});
test('ошибки Telegram не раскрывают токен',async()=>{await assert.rejects(botCall(s,'getMe',{},async()=>{throw new Error('https://api.telegram.org/bot'+s.botToken);}),e=>e.message==='TELEGRAM_NETWORK_ERROR'&&!e.message.includes(s.botToken));});
test('неожиданный публичный домен не используется',async()=>{await assert.rejects(verifyPublic('http://127.0.0.1:3000'),/UNEXPECTED_TUNNEL_DOMAIN/);});
test('Microsoft URL выбирается без inspect-адреса и без соседнего порта',()=>{
 const u='https://4dg4nbvz-3100.inc1.devtunnels.ms';
 assert.equal(extractTunnelUrl('Inspect https://4dg4nbvz-3100-inspect.inc1.devtunnels.ms\nConnect '+u),u);
 assert.equal(extractTunnelUrl('https://other-3000.inc1.devtunnels.ms'),'');
 assert.equal(isAllowedTunnelUrl(u+'.evil.example'),false);
 assert.equal(isAllowedTunnelUrl('https://'+new URL(u).host+'@evil.example'),false);
 assert.equal(extractTunnelUrl(url,'microsoft'),'');
});
test('Microsoft HTTPS сохраняет проверку входа до настройки Telegram',async()=>{
 const u='https://sample-3100.euw2.devtunnels.ms',calls=[];
 await configureBot(s,u,async(target,options)=>{calls.push(target);if(target.endsWith('/healthz'))return json(200,{ok:true});if(target.endsWith('/api/session'))return json(401,{});return json(200,{ok:true,result:true});});
 assert.deepEqual(calls.slice(0,2),[u+'/healthz',u+'/api/session']);assert.equal(calls.length,5);
});
