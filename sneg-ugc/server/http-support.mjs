import {isIP} from 'node:net';
import {assert} from '../dist/domain.mjs';
export function clientAddress(req,config){const forwarded=String(req.headers['x-real-ip']||'').trim();return config.trustRailwayProxy&&isIP(forwarded)?forwarded:req.socket.remoteAddress||'unknown';}
export class RateLimiter{
 constructor(){this.entries=new Map();this.cleanAt=0;}
 check(key,limit=600,now=Date.now()){
  if(now>this.cleanAt){this.cleanAt=now+60000;for(const[k,v]of this.entries)if(now-v.time>60000)this.entries.delete(k);}
  let entry=this.entries.get(key);if(!entry||now-entry.time>60000){entry={time:now,n:0};this.entries.set(key,entry);}
  assert(++entry.n<=limit,'Слишком много запросов. Подождите минуту.',429,'RATE_LIMIT');
 }
}
