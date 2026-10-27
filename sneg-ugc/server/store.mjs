import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {DEFAULT_CAMPAIGN} from '../dist/domain.mjs';
export class Store{
 constructor(path=':memory:'){
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
  `);
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
 cache(scope,key,hash,result){this.db.prepare('INSERT INTO idempotency(scope,key,hash,result) VALUES(?,?,?,?)').run(scope,key,hash,JSON.stringify(result));}
 enqueue(kind,payload,when=new Date().toISOString()){this.db.prepare('INSERT INTO jobs(kind,payload,available_at,created_at) VALUES(?,?,?,?)').run(kind,JSON.stringify(payload),when,new Date().toISOString());}
 jobs(){return this.db.prepare("SELECT id,kind,status,attempts,available_at,last_error FROM jobs WHERE status!='done' ORDER BY id DESC LIMIT 100").all();}
 dueJobs(now=new Date().toISOString(),{kind=null,excludeKind=null,limit=8}={}){
  const count=Math.max(1,Math.min(100,Number(limit)||8));
  return this.db.prepare("SELECT * FROM jobs WHERE status='pending' AND available_at<=? AND (? IS NULL OR kind=?) AND (? IS NULL OR kind!=?) ORDER BY CASE WHEN kind='telegram_update' THEN 0 ELSE 1 END,id LIMIT ?")
   .all(now,kind,kind,excludeKind,excludeKind,count).map(x=>({...x,payload:JSON.parse(x.payload)}));
 }
 updateJob(id,status,attempts,error=null,when=new Date().toISOString()){this.db.prepare('UPDATE jobs SET status=?,attempts=?,last_error=?,available_at=? WHERE id=?').run(status,attempts,error,when,id);}
 once(updateId){const r=this.db.prepare('INSERT OR IGNORE INTO updates(id) VALUES(?)').run(updateId);return r.changes>0;}
 subscribe(tg,campaignId){this.db.prepare('INSERT INTO subscribers VALUES(?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET campaign_id=excluded.campaign_id,last_seen=excluded.last_seen').run(String(tg),campaignId,new Date().toISOString());}
 subscriber(tg){return this.db.prepare('SELECT * FROM subscribers WHERE telegram_id=?').get(String(tg));}
 posts(){return this.db.prepare('SELECT data FROM posts ORDER BY scheduled_at DESC').all().map(x=>JSON.parse(x.data));}
 savePost(p){this.db.prepare('INSERT INTO posts VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,scheduled_at=excluded.scheduled_at,data=excluded.data').run(p.id,p.status,p.scheduledAt||null,JSON.stringify(p));}
 close(){this.db.close();}
}
