import {SCOPES,requireAccess,compareRead,send} from './_lib/access.js';
export default async function handler(req,res){
  if(req.method!=='GET')return send(res,405,{error:'method_not_allowed'});
  const scope=String(req.query?.scope||'sports').toLowerCase();
  if(!SCOPES.has(scope))return send(res,400,{error:'invalid_scope'});
  const auth=await requireAccess(req,res);if(!auth)return;
  try{
    // Compare, not Terminal, owns deterministic contract pairing and rule parity.
    const upstream=await compareRead('/api/desk?scope='+encodeURIComponent(scope),auth.cookie);
    if(upstream.status===401||upstream.status===403)return send(res,503,{error:'shared_access_verification_failed'});
    if(upstream.body===null)return send(res,502,{error:'compare_unavailable'});
    return send(res,upstream.status,upstream.body);
  }catch{return send(res,502,{error:'compare_unavailable'});}
}
