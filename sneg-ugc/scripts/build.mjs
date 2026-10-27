import {readdirSync,readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(Number(process.versions.node.split('.')[0])<24)throw new Error('Use Node.js 24 or newer');
let count=0;for(const folder of ['dist','server','scripts','test'])for(const file of readdirSync(resolve(root,folder))){if(!file.endsWith('.mjs'))continue;const r=spawnSync(process.execPath,['--check',resolve(root,folder,file)],{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);count++;}
for(const file of ['index.html','style.css','app.mjs','api.mjs','domain.mjs','fixtures.mjs','favicon.svg'])if(!readFileSync(resolve(root,'dist',file)).length)throw new Error('Empty asset: '+file);
const manifest=JSON.parse(readFileSync(resolve(root,'.openai/hosting.json'),'utf8'));if(manifest.static.directory!=='dist')throw new Error('Unexpected static directory');
console.log('Buildless application validated: '+count+' JS modules, static assets ready.');
