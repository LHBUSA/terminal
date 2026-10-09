import {compareProxy,send} from './_lib/access.js';
// Stored prediction-market series (non-sports) from Compare's /api/series. Points are stored observations only.
const ID=/^[A-Za-z0-9_.:|-]{1,160}$/;
export default async function handler(req,res){
  if(req.method!=='GET')return send(res,405,{error:'method_not_allowed'});
  const event=String(req.query?.event||''),market=String(req.query?.market||'');
  const hours=Math.max(1,Math.min(168,Math.round(Number(req.query?.hours)||24)));
  if(!ID.test(event)||!ID.test(market))return send(res,400,{error:'invalid_series'});
  return compareProxy(req,res,'/api/series?event='+encodeURIComponent(event)+'&market='+encodeURIComponent(market)+'&hours='+hours,'series_unavailable');
}
