import {backup,DatabaseSync} from 'node:sqlite';
import {mkdir,chmod,readdir,stat,unlink} from 'node:fs/promises';
import {dirname,resolve,basename} from 'node:path';
export class Maintenance{
 constructor(store,config){this.store=store;this.config=config;this.running=false;this.next=0;}
 directory(){return resolve(this.config.backupDirectory||resolve(dirname(this.config.databasePath),'backups'));}
 async createBackup(){
  if(this.backingUp)return this.backingUp;
  this.backingUp=(async()=>{
   const dir=this.directory();await mkdir(dir,{recursive:true});
   const name='ugc-'+new Date().toISOString().replaceAll(':','-')+'.sqlite',path=resolve(dir,name);
   await backup(this.store.db,path);await chmod(path,0o600);
   const check=new DatabaseSync(path,{readOnly:true});try{if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('BACKUP_INTEGRITY_FAILED');}finally{check.close();}
   this.store.setMeta('backup:last',JSON.stringify({at:new Date().toISOString(),name}));this.store.setMeta('backup:error','');
   const files=await this.files();for(const file of files.slice(14))await unlink(resolve(dir,file.name));
   return {name,at:new Date().toISOString()};
  })();try{return await this.backingUp;}finally{this.backingUp=null;}
 }
 async files(){const dir=this.directory(),names=await readdir(dir).catch(()=>[]),rows=[];for(const name of names.filter(n=>/^ugc-[\dTZ.\-]+\.sqlite$/.test(n))){const info=await stat(resolve(dir,name));if(info.isFile())rows.push({name,bytes:info.size,at:info.mtime.toISOString()});}return rows.sort((a,b)=>b.at.localeCompare(a.at));}
 file(name){if(basename(name)!==name||!/^ugc-[\dTZ.\-]+\.sqlite$/.test(name))throw Error('INVALID_BACKUP_NAME');return resolve(this.directory(),name);}
 clean(){
  const now=Date.now(),technical=new Date(now-30*86400000).toISOString();
  this.store.tx(()=>{
   this.store.db.prepare("DELETE FROM jobs WHERE status='done' AND created_at<?").run(technical);
   this.store.db.prepare('DELETE FROM updates WHERE created_at<?').run(technical);
   this.store.db.prepare('DELETE FROM idempotency WHERE created_at<?').run(technical);
   for(const c of this.store.campaigns())if(c.retentionEnabled&&c.productionApproved&&c.operator&&c.privacyText){
    const until=new Date(now-Math.max(30,c.retentionDays||180)*86400000).toISOString();
    const ids=this.store.db.prepare("SELECT id,telegram_id FROM applications WHERE campaign_id=? AND status IN ('rejected','withdrawn','sent') AND updated_at<?").all(c.id,until);
    for(const {id,telegram_id} of ids){
     this.store.db.prepare('DELETE FROM events WHERE app_id=?').run(id);
     this.store.db.prepare("DELETE FROM jobs WHERE json_extract(payload,'$.appId')=? OR (json_extract(payload,'$.chatId')=? AND json_extract(payload,'$.campaignId')=?)").run(id,telegram_id,c.id);
     this.store.db.prepare("DELETE FROM idempotency WHERE scope=? AND json_extract(result,'$.application.id')=?").run(telegram_id,id);
     this.store.db.prepare('DELETE FROM applications WHERE id=?').run(id);
     if(!this.store.db.prepare('SELECT 1 FROM applications WHERE telegram_id=?').get(telegram_id)){this.store.db.prepare('DELETE FROM subscribers WHERE telegram_id=?').run(telegram_id);this.store.db.prepare('DELETE FROM meta WHERE key=?').run('profile:'+telegram_id);}
    }
   }
   this.store.setMeta('maintenance:last',new Date(now).toISOString());
  });
 }
 async tick(){
  if(this.running||!this.config.production||this.store.path===':memory:'||Date.now()<this.next)return;
  this.running=true;this.next=Date.now()+60000;
  try{const last=JSON.parse(this.store.meta('backup:last')||'{}');if(!last.at||Date.now()-Date.parse(last.at)>86400000)await this.createBackup();const clean=this.store.meta('maintenance:last');if(!clean||Date.now()-Date.parse(clean)>86400000)this.clean();}
  catch{this.store.setMeta('backup:error','BACKUP_OR_MAINTENANCE_FAILED');throw Error('BACKUP_OR_MAINTENANCE_FAILED');}finally{this.running=false;}
 }
}
