import { checkMembership,send } from './_lib/access.js';
export default async function handler(req,res){
  if(req.method!=='GET')return send(res,405,{error:'method_not_allowed'});
  const v=await checkMembership(req);
  return send(res,v.status,{entitled:v.entitled,role:v.entitled?v.state:null,state:v.state,preview_mode:!v.entitled});
}
