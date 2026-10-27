import {createHash} from 'node:crypto';
import {aiFacts} from './integrations.mjs';
export function evaluationKey(a,campaign){return createHash('sha256').update(JSON.stringify({facts:aiFacts(a),minViews:campaign?.minViews,directions:campaign?.directions,languages:campaign?.languages,cities:campaign?.cities})).digest('hex');}
export function queueEvaluation(store,a,config,{force=false}={}){
 if(config.aiProvider==='rules'){
  a.evaluation.aiStatus='not_configured';
 }else if(a.status!=='review'){
  a.evaluation.aiStatus=a.evaluation.ai?'done':'paused';
 }else if(force||!a.evaluation.ai){
  if(force)delete a.evaluation.ai;
  a.evaluation.aiStatus='pending';
  const key=evaluationKey(a,store.campaign(a.campaignId));
  const pending=store.db.prepare("SELECT id FROM jobs WHERE kind='ai' AND status='pending' AND json_extract(payload,'$.appId')=? AND json_extract(payload,'$.evaluationKey')=?").get(a.id,key);
  if(!pending)store.enqueue('ai',{appId:a.id,evaluationKey:key});
 }
 store.save(a);store.setMeta('shortlist_dirty','1');
}
