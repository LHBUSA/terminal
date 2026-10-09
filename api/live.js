import {compareProxy,send} from './_lib/access.js';
// Score board for the sports on screen, from Compare's /api/live (Compare owns the score adapters and their memo).
const SPORTS=new Set(['nfl','nba','nhl','mlb','wnba','tennis','ufc','soccer','golf','f1']);
export default async function handler(req,res){
  if(req.method!=='GET')return send(res,405,{error:'method_not_allowed'});
  const list=[...new Set(String(req.query?.sports||'').toLowerCase().split(',').filter(Boolean))].sort();
  if(!list.length||list.length>SPORTS.size||list.some(s=>!SPORTS.has(s)))return send(res,400,{error:'invalid_sports'});
  return compareProxy(req,res,'/api/live?sports='+list.join(','),'score_feed_unavailable');
}
