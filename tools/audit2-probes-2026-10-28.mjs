// Regression entry point. Original findings are preserved in UGC-audit2-evidence-2026-10-28.json.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const app=fileURLToPath(new URL('../sneg-ugc/',import.meta.url));
const r=spawnSync(process.execPath,['--test','--test-isolation=none','test/audit2-regressions.test.mjs'],{cwd:app,stdio:'inherit',windowsHide:true});
process.exitCode=r.status??1;
