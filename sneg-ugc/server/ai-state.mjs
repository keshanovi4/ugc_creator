import {createHash} from 'node:crypto';
import {evaluate} from '../dist/domain.mjs';
import {aiFacts} from './integrations.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Keys contain only digests. A provider/key replacement must invalidate an in-flight result.
export function configurationKey(config={}){return hash({schema:'directions-v2',provider:config.aiProvider||'rules',model:config.aiModel||'',generation:config.aiGeneration||0,credential:hash(config.geminiKey||config.ollamaUrl||'')});}
export function criteriaKey(a,campaign){return hash({facts:aiFacts({...a,evaluation:evaluate(a,campaign)}),minViews:campaign?.minViews,directions:campaign?.directions,languages:campaign?.languages,cities:campaign?.cities,revision:campaign?.criteriaRevision||1});}
export function evaluationKey(a,campaign,config={}){return hash({criteria:criteriaKey(a,campaign),configuration:configurationKey(config)});}
export function queueEvaluation(store,a,config,{force=false}={}){
 const campaign=store.campaign(a.campaignId),previous=a.evaluation||{},rulesKey=criteriaKey(a,campaign),configKey=configurationKey(config);
 const criteriaChanged=previous.criteriaKey!==rulesKey,configurationChanged=previous.configurationKey!==configKey;
 const archive=previous.ai&&(force||criteriaChanged||configurationChanged||config.aiProvider==='rules')?{...previous.ai,at:previous.aiAt||null,source:previous.source||'ai',reason:config.aiProvider==='rules'?'disabled':criteriaChanged?'criteria_changed':configurationChanged?'configuration_changed':'recheck'}:previous.aiArchived;
 a.evaluation={...previous,...(criteriaChanged?evaluate(a,campaign):{}),criteriaKey:rulesKey,criteriaRevision:campaign?.criteriaRevision||1,configurationKey:configKey};
 if(archive)a.evaluation.aiArchived=archive;
 if(force||criteriaChanged||configurationChanged||config.aiProvider==='rules'){
  delete a.evaluation.ai;delete a.evaluation.aiAt;delete a.evaluation.aiNextAt;a.evaluation.source='rules';
 }
 const key=evaluationKey(a,campaign,config);
 // Pending work for a previous state cannot block the current assessment or exhaust quota.
 store.db.prepare("UPDATE jobs SET status='done',last_error='AI_SUPERSEDED' WHERE kind='ai' AND status='pending' AND json_extract(payload,'$.appId')=? AND (COALESCE(json_extract(payload,'$.evaluationKey'),'')!=? OR ?=1)").run(a.id,key,config.aiProvider==='rules'?1:0);
 if(config.aiProvider==='rules')a.evaluation.aiStatus='not_configured';
 else if(a.status!=='review')a.evaluation.aiStatus=a.evaluation.ai?'done':'paused';
 else if(!a.evaluation.ai){
  a.evaluation.aiStatus='pending';
  const pending=store.db.prepare("SELECT id FROM jobs WHERE kind='ai' AND status='pending' AND json_extract(payload,'$.appId')=? AND json_extract(payload,'$.evaluationKey')=?").get(a.id,key);
  if(!pending)store.enqueue('ai',{appId:a.id,evaluationKey:key});
 }else a.evaluation.aiStatus='done';
 store.save(a);store.setMeta('shortlist_dirty','1');
 return a;
}

// Migrate legacy evaluations and reconcile environment changes once, before serving the queue.
export function reconcileEvaluations(store,config,{force=false}={}){
 const marker='v3:'+configurationKey(config);
 if(!force&&store.meta('evaluation:configuration')===marker)return;
 for(const {id} of store.db.prepare('SELECT id FROM applications').all()){
  const a=store.app(id);queueEvaluation(store,a,config,{force});a.version++;a.updatedAt=new Date().toISOString();store.save(a);
 }
 store.setMeta('evaluation:configuration',marker);
}
