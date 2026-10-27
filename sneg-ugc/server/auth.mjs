import {createHmac,timingSafeEqual,randomBytes} from 'node:crypto';
import {AppError,assert} from '../dist/domain.mjs';
export function equal(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);}
export function validateTelegram(initData,token,now=Date.now()){
 assert(typeof initData==='string'&&initData.length<20000,'Не удалось проверить вход Telegram',401);
 const params=new URLSearchParams(initData),hash=params.get('hash');
 assert(hash&&/^[a-f0-9]{64}$/i.test(hash),'Откройте кабинет через Telegram',401);
 assert([...params.keys()].length===new Set(params.keys()).size,'Некорректные данные входа',401);
 const auth=Number(params.get('auth_date'));
 assert(Number.isFinite(auth)&&now/1000-auth<=900&&auth<=now/1000+30,'Вход устарел. Откройте приложение заново.',401);
 params.delete('hash');
 const check=[...params.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>k+'='+v).join('\n');
 const secret=createHmac('sha256','WebAppData').update(token).digest();
 const expected=createHmac('sha256',secret).update(check).digest('hex');
 assert(equal(hash,expected),'Подпись Telegram не подтверждена',401);
 let user;try{user=JSON.parse(params.get('user'));}catch{throw new AppError('Некорректный пользователь Telegram',401);}
 assert(Number.isSafeInteger(user?.id)&&user.id>0,'Не удалось определить пользователя',401);
 return {id:String(user.id),name:[user.first_name,user.last_name].filter(Boolean).join(' ').slice(0,100),username:String(user.username||'').slice(0,80)};
}
export function roleFor(id,config,store){id=String(id);if(config.adminIds.includes(id))return 'admin';const member=store?.member(id);if(member)return member.active?'manager':'candidate';if(config.managerIds.includes(id))return 'manager';return 'candidate';}
export function canPublish(user,store){return user.role==='admin'||user.role==='manager'&&store?.member(user.id)?.active===true&&store.member(user.id).publish===true;}
export function teamIds(config,store){return [...new Set([...config.adminIds,...config.managerIds,...(store?.members()||[]).filter(m=>m.active).map(m=>m.id)])].filter(id=>roleFor(id,config,store)!=='candidate');}
export function session(user,secret,now=Date.now()){
 const payload=Buffer.from(JSON.stringify({...user,exp:Math.floor(now/1000)+43200,nonce:randomBytes(12).toString('hex')})).toString('base64url');
 return payload+'.'+createHmac('sha256',secret).update(payload).digest('base64url');
}
export function readSession(value,secret,now=Date.now()){
 if(!value)return null;const [payload,sig,...extra]=value.split('.');if(extra.length||!sig||!equal(sig,createHmac('sha256',secret).update(payload).digest('base64url')))return null;
 try{const user=JSON.parse(Buffer.from(payload,'base64url').toString());return user.exp>now/1000?user:null;}catch{return null;}
}
