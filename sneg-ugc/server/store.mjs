import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {DEFAULT_CAMPAIGN} from '../dist/domain.mjs';
export class Store{
 constructor(path=':memory:'){
  this.path=path;
  if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
  this.db=new DatabaseSync(path);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  this.db.exec(`
   CREATE TABLE IF NOT EXISTS campaigns(id TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS applications(id TEXT PRIMARY KEY,telegram_id TEXT NOT NULL,campaign_id TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,data TEXT NOT NULL);
   CREATE UNIQUE INDEX IF NOT EXISTS one_application_per_campaign ON applications(telegram_id,campaign_id);
   CREATE INDEX IF NOT EXISTS applications_queue ON applications(status,updated_at);
   CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,app_id TEXT NOT NULL,at TEXT NOT NULL,data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS events_app ON events(app_id,id);
   CREATE TABLE IF NOT EXISTS idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,key));
   CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,available_at TEXT NOT NULL,last_error TEXT,created_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status,available_at);
   CREATE TABLE IF NOT EXISTS updates(id INTEGER PRIMARY KEY);
   CREATE TABLE IF NOT EXISTS subscribers(telegram_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,last_seen TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY,status TEXT NOT NULL,scheduled_at TEXT,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS team_members(id TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS team_events(id INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,data TEXT NOT NULL);
  `);
  for(const table of ['updates','idempotency'])if(!this.db.prepare('PRAGMA table_info('+table+')').all().some(c=>c.name==='created_at')){
   this.db.exec('ALTER TABLE '+table+' ADD COLUMN created_at TEXT');
   this.db.prepare('UPDATE '+table+' SET created_at=? WHERE created_at IS NULL').run(new Date().toISOString());
  }
  this.db.function('ugc_fold',{deterministic:true},v=>String(v??'').toLocaleLowerCase('ru'));
  if(!this.db.prepare('SELECT id FROM campaigns LIMIT 1').get())this.saveCampaign(DEFAULT_CAMPAIGN);
 }
 tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 campaign(id=DEFAULT_CAMPAIGN.id){const r=this.db.prepare('SELECT data FROM campaigns WHERE id=?').get(id);return r?JSON.parse(r.data):null;}
 saveCampaign(c){this.db.prepare('INSERT INTO campaigns(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(c.id,JSON.stringify(c));}
 campaigns(){return this.db.prepare('SELECT data FROM campaigns').all().map(x=>JSON.parse(x.data));}
 app(id){const r=this.db.prepare('SELECT data FROM applications WHERE id=?').get(id);return r?{...JSON.parse(r.data),history:this.events(id)}:null;}
 find(telegramId,campaignId){const r=this.db.prepare('SELECT id FROM applications WHERE telegram_id=? AND campaign_id=?').get(String(telegramId),campaignId);return r?this.app(r.id):null;}
 save(a){
  const {history,...data}=a;
  this.db.prepare('INSERT INTO applications(id,telegram_id,campaign_id,status,version,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,version=excluded.version,updated_at=excluded.updated_at,data=excluded.data').run(a.id,String(a.telegramId),a.campaignId,a.status,a.version,a.createdAt,a.updatedAt,JSON.stringify(data));
 }
 all(){return this.db.prepare('SELECT data FROM applications ORDER BY created_at DESC').all().map(x=>JSON.parse(x.data));}
 mine(tg){return this.db.prepare('SELECT data FROM applications WHERE telegram_id=? ORDER BY created_at DESC').all(String(tg)).map(x=>({...JSON.parse(x.data),history:this.events(JSON.parse(x.data).id)}));}
 events(id){return this.db.prepare('SELECT data FROM events WHERE app_id=? ORDER BY id DESC LIMIT 100').all(id).map(x=>JSON.parse(x.data));}
 event(id,e){this.db.prepare('INSERT INTO events(app_id,at,data) VALUES(?,?,?)').run(id,e.at,JSON.stringify(e));}
 nextId(){const n=this.db.prepare('SELECT value FROM meta WHERE key=?').get('sequence');const num=Number(n?.value||0)+1;this.setMeta('sequence',String(num));return 'SN-'+String(num).padStart(4,'0');}
 setMeta(k,v){this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,String(v));}
 meta(k){return this.db.prepare('SELECT value FROM meta WHERE key=?').get(k)?.value;}
 cached(scope,key){const r=this.db.prepare('SELECT hash,result FROM idempotency WHERE scope=? AND key=?').get(scope,key);return r?{hash:r.hash,result:JSON.parse(r.result)}:null;}
 cache(scope,key,hash,result){this.db.prepare('INSERT INTO idempotency(scope,key,hash,result,created_at) VALUES(?,?,?,?,?)').run(scope,key,hash,JSON.stringify(result),new Date().toISOString());}
 enqueue(kind,payload,when=new Date().toISOString()){this.db.prepare('INSERT INTO jobs(kind,payload,available_at,created_at) VALUES(?,?,?,?)').run(kind,JSON.stringify(payload),when,new Date().toISOString());}
 jobs(){return this.db.prepare("SELECT id,kind,status,attempts,available_at,last_error FROM jobs WHERE status!='done' ORDER BY id DESC LIMIT 100").all();}
 dueJobs(now=new Date().toISOString(),{kind=null,excludeKind=null,limit=8}={}){
  const count=Math.max(1,Math.min(100,Number(limit)||8));
  return this.db.prepare("SELECT * FROM jobs WHERE status='pending' AND available_at<=? AND (? IS NULL OR kind=?) AND (? IS NULL OR kind!=?) ORDER BY CASE WHEN kind='telegram_update' THEN 0 ELSE 1 END,id LIMIT ?")
   .all(now,kind,kind,excludeKind,excludeKind,count).map(x=>({...x,payload:JSON.parse(x.payload)}));
 }
 updateJob(id,status,attempts,error=null,when=new Date().toISOString()){this.db.prepare('UPDATE jobs SET status=?,attempts=?,last_error=?,available_at=? WHERE id=?').run(status,attempts,error,when,id);}
 once(updateId){const r=this.db.prepare('INSERT OR IGNORE INTO updates(id,created_at) VALUES(?,?)').run(updateId,new Date().toISOString());return r.changes>0;}
 subscribe(tg,campaignId){this.db.prepare('INSERT INTO subscribers VALUES(?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET campaign_id=excluded.campaign_id,last_seen=excluded.last_seen').run(String(tg),campaignId,new Date().toISOString());}
 subscriber(tg){return this.db.prepare('SELECT * FROM subscribers WHERE telegram_id=?').get(String(tg));}
 posts(){return this.db.prepare('SELECT data FROM posts ORDER BY scheduled_at DESC').all().map(x=>JSON.parse(x.data));}
 savePost(p){this.db.prepare('INSERT INTO posts VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,scheduled_at=excluded.scheduled_at,data=excluded.data').run(p.id,p.status,p.scheduledAt||null,JSON.stringify(p));}
 member(id){const row=this.db.prepare('SELECT data FROM team_members WHERE id=?').get(String(id));return row?JSON.parse(row.data):null;}
 members(){return this.db.prepare('SELECT data FROM team_members').all().map(r=>JSON.parse(r.data));}
 saveMember(member){this.db.prepare('INSERT INTO team_members VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(String(member.id),JSON.stringify(member));}
 teamEvent(event){this.db.prepare('INSERT INTO team_events(at,data) VALUES(?,?)').run(event.at||new Date().toISOString(),JSON.stringify(event));}
 teamEvents(){return this.db.prepare('SELECT data FROM team_events ORDER BY id DESC LIMIT 50').all().map(r=>JSON.parse(r.data));}
 queryApplications(q={}){
  const canonical="CASE status WHEN 'address' THEN 'approved' WHEN 'ready' THEN 'approved' WHEN 'shipped' THEN 'sent' WHEN 'delivered' THEN 'sent' WHEN 'content_review' THEN 'sent' WHEN 'revision' THEN 'sent' WHEN 'completed' THEN 'sent' ELSE status END";
  const rec="(json_extract(data,'$.evaluation.ai.recommendation')='recommend' OR (json_extract(data,'$.evaluation.ai') IS NULL AND (json_extract(data,'$.evaluation.ugc')='recommended' OR json_extract(data,'$.evaluation.reach')='recommended')))";
  const overdue="(s IN ('review','clarification') AND json_extract(data,'$.dueAt') IS NOT NULL AND json_extract(data,'$.dueAt') < :now)";
  const where=[],v={now:new Date().toISOString()};
  if(q.campaignId){where.push('campaign_id=:campaign');v.campaign=q.campaignId;}
  if(q.q){v.q=String(q.q).trim().toLocaleLowerCase('ru');v.compact=v.q.replace(/[\s\-–—]+/g,'');where.push("(instr(replace(replace(replace(replace(ugc_fold(id),' ',''),'-',''),'–',''),'—',''),:compact)>0 OR instr(ugc_fold(json_extract(data,'$.name')),:q)>0 OR instr(ugc_fold(json_extract(data,'$.username')),:q)>0 OR instr(ugc_fold(json_extract(data,'$.city')),:q)>0)");}
  else{
   const groups={review:['review','clarification'],selected:['approved','sent'],archive:['reserve','rejected','withdrawn']};
   let statuses=q.status?[q.status]:q.bucket==='recommended'||q.bucket==='all_new'?['review']:q.bucket==='waiting'?['clarification']:groups[q.queue];
   if(statuses){where.push('s IN ('+statuses.map((s,i)=>{v['s'+i]=s;return ':s'+i;}).join(',')+')');}
   if(q.bucket==='recommended')where.push('rec=1');
   if(q.direction){where.push("EXISTS(SELECT 1 FROM json_each(json_extract(data,'$.directions')) WHERE value=:direction)");v.direction=q.direction;}
  }
  if(q.owner){where.push("json_extract(data,'$.owner')=:owner");v.owner=String(q.owner);}
  if(q.afterSequence!==undefined){where.push('CAST(substr(id,4) AS INTEGER)>:afterSequence');v.afterSequence=Number(q.afterSequence)||0;}
  const base='WITH a AS (SELECT *, '+canonical+' s, COALESCE('+rec+',0) rec FROM applications) ',filter=where.length?' WHERE '+where.join(' AND '):'';
  const total=this.db.prepare(base+'SELECT count(*) n FROM a'+filter).get(Object.fromEntries(Object.entries(v).filter(([k])=>k!=='now'))).n;
  const offset=Math.max(0,Math.floor(Number(q.offset)||0)),limit=Math.max(1,Math.min(500,Math.floor(Number(q.limit)||40)));
  const rows=this.db.prepare(base+'SELECT data FROM a'+filter+' ORDER BY '+overdue+' DESC, CASE WHEN rec=1 THEN 0 WHEN length(COALESCE(json_extract(data,\'$.answer\'),\'\'))>0 THEN 1 ELSE 2 END,created_at,id LIMIT :limit OFFSET :offset').all({...v,limit,offset}).map(r=>JSON.parse(r.data));
  return {applications:rows,total,hasMore:offset+rows.length<total,offset};
 }
 counts(){
  // Aggregation stays in SQLite; individual application JSON is never materialized in JS.
  const r=this.db.prepare(`SELECT count(*) total,
   sum(status='review') review,sum(status='clarification') clarification,
   sum(status IN ('approved','sent','address','ready','shipped','delivered','content_review','revision','completed')) selected,
   sum(status IN ('sent','shipped','delivered','content_review','revision','completed')) sent,
   sum(status='review' AND (json_extract(data,'$.evaluation.ai.recommendation')='recommend' OR (json_extract(data,'$.evaluation.ai') IS NULL AND (json_extract(data,'$.evaluation.ugc')='recommended' OR json_extract(data,'$.evaluation.reach')='recommended')))) recommended,
   sum(status IN ('review','clarification') AND json_extract(data,'$.dueAt') < ?) overdue FROM applications`).get(new Date().toISOString());
  return Object.fromEntries(Object.entries(r).map(([k,v])=>[k,Number(v)||0]));
 }
 close(){this.db.close();}
}
