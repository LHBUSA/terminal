import {SCOPES,requireAccess,compareRead,send} from './_lib/access.js';
export default async function handler(req,res){
  if(req.method!=='GET')return send(res,405,{error:'method_not_allowed'});
  const sport=String(req.query?.sport||'').toLowerCase();
  const event=String(req.query?.event||'');
  if(!SCOPES.has(sport)||sport==='sports'||sport==='nonsports'||!/^[a-zA-Z0-9_.:-]{1,80}$/.test(event))
    return send(res,400,{error:'invalid_event'});
  const auth=await requireAccess(req,res);if(!auth)return;
  try{
    const upstream=await compareRead('/api/event?sport='+encodeURIComponent(sport)+'&event='+encodeURIComponent(event),auth.cookie);
    if(upstream.status===401||upstream.status===403)return send(res,503,{error:'shared_access_verification_failed'});
    if(upstream.body===null)return send(res,502,{error:'event_unavailable'});
    return send(res,upstream.status,upstream.body);
  }catch{return send(res,502,{error:'event_unavailable'});}
}
