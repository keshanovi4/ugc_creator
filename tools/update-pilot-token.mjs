import {readState,saveState,checkBot} from './pilot-common.mjs';
async function hiddenInput(){
 if(!process.stdin.isTTY)throw new Error('Откройте файл запуска в обычном терминале.');
 process.stdout.write('Вставьте новый токен и нажмите Enter (ввод скрыт): ');
 return new Promise((done,reject)=>{let value='';const finish=()=>{process.stdin.off('data',onData);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');};const onData=chunk=>{for(const char of chunk.toString()){if(char==='\u0003'){finish();reject(new Error('Ввод отменён.'));return;}if(char==='\r'||char==='\n'){finish();done(value.trim().replace(/&#x20;/g,''));return;}if(char==='\u007f'||char==='\b')value=value.slice(0,-1);else if(char>=' ')value+=char;}};process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',onData);});
}
try{const state=await readState();state.botToken=await hiddenInput();await checkBot(state);await saveState(state);console.log('Новый токен проверен и сохранён локально. Теперь запустите UGC-start.cmd.');}catch(e){console.error(/^[A-Z0-9_]+$/.test(e.message)?e.message:'Токен не сохранён. Проверьте бота и соединение.');process.exitCode=1;}
