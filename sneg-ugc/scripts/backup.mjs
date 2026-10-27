import {DatabaseSync,backup} from 'node:sqlite';
import {mkdir,chmod,stat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function createBackup({databasePath=process.env.DATABASE_PATH||'data/ugc.sqlite',backupDirectory=process.env.BACKUP_DIRECTORY||'backups'}={}){
 const source=resolve(root,databasePath);await stat(source);
 const dir=resolve(root,backupDirectory);await mkdir(dir,{recursive:true});const path=resolve(dir,'ugc-'+new Date().toISOString().replaceAll(':','-')+'.sqlite');
 const db=new DatabaseSync(source,{readOnly:true});try{await backup(db,path);await chmod(path,0o600);return path;}finally{db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log('Backup saved: '+await createBackup());
