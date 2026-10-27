// Historical evidence describes 2cc8ca5. This entry point runs the fixed regression suite.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const result=spawnSync(process.execPath,['--test','--test-isolation=none','test/audit-fixes.test.mjs'],{cwd:fileURLToPath(new URL('../sneg-ugc/',import.meta.url)),stdio:'inherit',windowsHide:true});
process.exit(result.status??1);
