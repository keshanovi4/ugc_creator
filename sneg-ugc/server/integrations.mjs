import {text} from '../dist/domain.mjs';
export async function telegram(c,method,body,fetcher=fetch){if(c.demo||!c.botToken)return {ok:true,skipped:true};let r,d;try{r=await fetcher('https://api.telegram.org/bot'+c.botToken+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});d=await r.json();}catch{throw new Error('TELEGRAM_UNAVAILABLE');}if(!r.ok||!d.ok){if(d.error_code===400&&d.description?.includes('message is not modified'))return {ok:true,unchanged:true};const gone=d.error_code===400&&/message to edit not found|message can't be edited/.test(d.description||'');const e=new Error(gone?'TELEGRAM_MESSAGE_GONE':d.error_code===403?'TELEGRAM_BLOCKED':d.error_code===429?'TELEGRAM_RATE_LIMIT':'TELEGRAM_ERROR');e.retryAfter=d.parameters?.retry_after;throw e;}return d;}
export function aiFacts(a){
 const facts={directions:a.directions,language:a.language,experienceDeclared:a.experience,portfolioCount:a.portfolio.length,closeupDeclared:a.closeup,availabilityDaysDeclared:a.availabilityDays,geographyEligible:a.evaluation.eligible,criteriaMatch:{ugc:a.evaluation.ugc,reach:a.evaluation.reach}};
 if(a.directions.includes('reach'))Object.assign(facts,{views:a.views,followers:a.followers,audienceKzDeclared:a.audienceKz});
 return facts;
}
const directionSchema={type:'object',properties:{recommendation:{type:'string',enum:['recommend','clarify','pass','not_selected']},summary:{type:'string'}},required:['recommendation','summary'],additionalProperties:false};
export const AI_RESPONSE_SCHEMA={type:'object',properties:{recommendation:{type:'string',enum:['recommend','clarify','pass']},summary:{type:'string'},directions:{type:'object',properties:{ugc:directionSchema,reach:directionSchema},required:['ugc','reach'],additionalProperties:false},reasons:{type:'array',items:{type:'string'},maxItems:2},unknowns:{type:'array',items:{type:'string'},maxItems:3},question:{type:'string'}},required:['recommendation','summary','directions','reasons','unknowns','question'],additionalProperties:false};
export async function analyze(a,c,fetcher=fetch){
 if(c.aiProvider==='rules')return null;
 const prompt='Помоги менеджеру предварительно разобрать анкету креатора. Ответь по-русски. UGC означает производство видео ДЛЯ БРЕНДА: просмотры, подписчики и размер собственной аудитории не нужны, не считай их отсутствие риском и не запрашивай статистику. Для UGC достаточно одного примера: его качество позже проверит менеджер. Если portfolioCount больше нуля, не проси прислать пример заново только для первичного отбора. Только направление reach означает публикацию у себя: здесь важны заявленные просмотры и аудитория Казахстана. Если выбраны оба направления, оцени их независимо: слабые охваты не отменяют совпадение UGC. Русский и казахский равноценны. Все сведения об опыте и возможностях — слова кандидата, их никто не проверял. Используй слова «указан», «заявлен», «по анкете»; не называй опыт подтверждённым. criteriaMatch — результат правил, его не нужно цитировать техническим языком. Ты не видел видео и не проверял статистику. Не выдумывай качества работ, бренды, вовлечённость или подтверждённость данных. При совпадении правил рекомендуй менеджеру посмотреть работу; сама невозможность просмотра не требует отказа. Не принимай окончательное решение. Верни строго JSON по схеме: recommendation (recommend, clarify или pass), summary (до 220 символов), directions (объект ugc и reach: для каждого recommendation и summary; невыбранное направление — not_selected с пустым summary; выбранные направления оцени отдельно; общий recommend, если хотя бы одно подходит), reasons (до 2 коротких причин), unknowns (до 3 коротких строк), question (до 240 символов, пустая строка если вопрос не нужен). Данные анкеты: '+JSON.stringify(aiFacts(a));
 let data;
 try{
  if(c.aiProvider==='ollama'){
   const r=await fetcher(c.ollamaUrl+'/api/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:c.aiModel,prompt,stream:false,format:AI_RESPONSE_SCHEMA}),signal:AbortSignal.timeout(25000)});
   if(!r.ok)throw new Error('AI_UNAVAILABLE');data=JSON.parse((await r.json()).response);
  }else{
   if(!c.geminiKey||!c.aiModel)throw new Error('AI_NOT_CONFIGURED');
   const r=await fetcher('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(c.aiModel)+':generateContent',{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':c.geminiKey},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.1,responseMimeType:'application/json',responseJsonSchema:AI_RESPONSE_SCHEMA}}),signal:AbortSignal.timeout(25000)});
   if(!r.ok)throw new Error(r.status===429?'AI_RATE_LIMIT':'AI_UNAVAILABLE');
   const d=await r.json();data=JSON.parse(d.candidates?.[0]?.content?.parts?.filter(p=>!p.thought).map(p=>p.text||'').join('')||'{}');
  }
 }catch(e){throw new Error(/^AI_/.test(e.message)?e.message:e instanceof SyntaxError?'AI_INVALID_RESPONSE':'AI_UNAVAILABLE');}
 if(!['recommend','clarify','pass'].includes(data?.recommendation)||typeof data.summary!=='string'||!data.summary.trim()||!Array.isArray(data.reasons)||!Array.isArray(data.unknowns)||typeof data.question!=='string')throw new Error('AI_INVALID_RESPONSE');
 const directions={};
 // Older compatible providers may omit the new breakdown. Never invent a per-direction AI verdict.
 if(data.directions!==undefined){
  if(!data.directions||typeof data.directions!=='object'||Array.isArray(data.directions))throw new Error('AI_INVALID_RESPONSE');
  for(const direction of a.directions){const result=data.directions[direction];if(!['recommend','clarify','pass'].includes(result?.recommendation)||typeof result.summary!=='string'||!result.summary.trim())throw new Error('AI_INVALID_RESPONSE');directions[direction]={recommendation:result.recommendation,summary:text(result.summary,180)};}
 }
 const outcomes=Object.values(directions).map(d=>d.recommendation),recommendation=outcomes.length?(outcomes.includes('recommend')?'recommend':outcomes.includes('clarify')?'clarify':'pass'):data.recommendation;
 const question=recommendation==='recommend'&&!a.directions.includes('reach')&&a.evaluation.ugc==='recommended'?'':text(data.question,240);
 return {recommendation,summary:text(data.summary,220),...(outcomes.length?{directions}:{}),reasons:data.reasons.filter(x=>typeof x==='string').slice(0,2).map(x=>text(x,160)),unknowns:data.unknowns.filter(x=>typeof x==='string').slice(0,3).map(x=>text(x,180)),question};
}
export function queueTelegramUpdate(store,update){return store.tx(()=>{if(!Number.isSafeInteger(update.update_id)||!store.once(update.update_id))return {duplicate:true};const m=update.message,cb=update.callback_query,from=m?.from||cb?.from;if(!from?.id||(m?.chat?.type||cb?.message?.chat?.type)!=='private')return {ignored:true};store.enqueue('telegram_update',{updateId:update.update_id,from:{id:String(from.id),name:text([from.first_name,from.last_name].filter(Boolean).join(' '),100),username:text(from.username,80)},text:text(m?.text,3000),callback:cb?{id:cb.id,data:text(cb.data,64)}:null});return {accepted:true};});}
