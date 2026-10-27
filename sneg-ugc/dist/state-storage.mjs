export const blankDraft=()=>({directions:['ugc'],city:'',language:'ru',experience:'',availabilityDays:7});
const key=(kind,user,campaign)=>'sneg:'+kind+':'+user+':'+campaign;
export function loadDraft(storage,user,campaign){
 try{const value=JSON.parse(storage.getItem(key('draft',user,campaign.id))||'null');if(!value||Date.now()-value.at>86400000)return {draft:blankDraft(),step:1};const draft={...blankDraft(),...value.draft};if(value.briefVersion!==campaign.briefVersion||value.consentVersion!==campaign.consentVersion){draft.terms=false;draft.consent=false;}return {draft,step:value.step===2?2:1};}catch{return {draft:blankDraft(),step:1};}
}
export function saveDraft(storage,user,campaign,draft,step){try{storage.setItem(key('draft',user,campaign.id),JSON.stringify({draft,step,briefVersion:campaign.briefVersion,consentVersion:campaign.consentVersion,at:Date.now()}));}catch{}}
export function clearDraft(storage,user,campaign){try{storage.removeItem(key('draft',user,campaign.id));}catch{}}
export function loadPost(storage,user){try{const item=JSON.parse(storage.getItem(key('post',user,''))||'null');return item&&Date.now()-item.at<86400000?item.draft:null;}catch{return null;}}
export function savePostDraft(storage,user,draft){try{storage.setItem(key('post',user,''),JSON.stringify({draft,at:Date.now()}));}catch{}}
export function mergeRows(previous,next){return [...new Map([...previous,...next].map(row=>[row.id,row])).values()];}
export async function loadWindow(list,query,count){let rows=[],result;do{const previous=rows.length;result=await list({...query,offset:rows.length,limit:Math.min(100,Math.max(1,count-rows.length))});rows=mergeRows(rows,result.applications);if(rows.length===previous)break;}while(result.hasMore&&rows.length<count);return {...result,applications:rows};}
