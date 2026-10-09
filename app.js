const $=s=>document.querySelector(s);
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const scope=$('#scope'),filter=$('#filter'),search=$('#search');
const state={auth:false,role:null,desk:null,rows:[],selected:null,watchlist:new Set(),watchOnly:false,lastOk:null,controller:null};
try{const v=JSON.parse(localStorage.getItem('pbe_terminal_watchlist_v1')||'[]');if(Array.isArray(v))state.watchlist=new Set(v.filter(x=>typeof x==='string').slice(0,200));}catch{}
function store(){try{localStorage.setItem('pbe_terminal_watchlist_v1',JSON.stringify([...state.watchlist].slice(0,200)));}catch{}}
function fmt(v){return typeof v==='number'&&Number.isFinite(v)?(v/100).toFixed(1)+'¢':'—'}
function seen(v){if(!v)return '—';const n=Date.parse(v);if(!Number.isFinite(n))return '—';const secs=Math.floor((Date.now()-n)/1000);if(secs<0)return 'timestamp future';if(secs<60)return secs+'s ago';if(secs<3600)return Math.floor(secs/60)+'m ago';return Math.floor(secs/3600)+'h ago';}
function quote(v){return v&&typeof v==='object'&&v.mid_bp!=null&&Number.isFinite(Number(v.mid_bp))?Number(v.mid_bp):null}
function normal(e){
  if(!e||typeof e!=='object'||!Array.isArray(e.contracts))return [];
  return e.contracts.map(c=>{
    if(!c||typeof c!=='object')return null;
    const venue=c.venues||[],k=venue.find(v=>v.venue==='kalshi'),p=venue.find(v=>v.venue==='polymarket');
    const cmp=c.comparison||null;
    const kbp=quote(k),pbp=quote(p);
    const aligned=!!cmp&&kbp!==null&&pbp!==null;
    const model=c.pbe?.probability;
    const modelVal=typeof model==='number'&&Number.isFinite(model)&&model>=0&&model<=1?model:null;
    const id=String(c.canonical_contract_id||c.label||'');
    if(!id)return null;
    const eventId=String(e.canonical_event_id||'');
    const sport=String(e.sport||e.lane||'');
    return {key:sport+':'+eventId+':'+id,sport,eventId,id,title:String(e.title||e.question||'Market'),label:String(c.label||'Outcome'),k:kbp,p:pbp,aligned,gap:aligned&&Number.isFinite(Number(cmp.venue_gap_pts))?Number(cmp.venue_gap_pts):null,model:modelVal,age:[k?.observed_at,p?.observed_at].filter(Boolean).sort().at(-1)||null,rules:aligned?'ALIGNED':c.related?.some(x=>x.match==='RULE_MISMATCH'||x.match==='COMPARABLE_EXCEPT_EXCEPTIONS')?'RULES DIFFER':'NOT VERIFIED',compared:cmp,source:c,sourceEvent:e};
  }).filter(Boolean);
}
function setNotice(msg,type=''){const n=$('#notice');n.className='notice'+(type?' '+type:'');n.textContent=msg;}
function tally(rows){$('#contracts').textContent=rows.length.toLocaleString();$('#quoted').textContent=rows.filter(x=>x.k!==null||x.p!==null).length.toLocaleString();$('#aligned').textContent=rows.filter(x=>x.aligned).length.toLocaleString();$('#modeled').textContent=rows.filter(x=>x.model!==null).length.toLocaleString();}
function render(){
  $('#savedCount').textContent=state.watchlist.size;
  const q=search.value.trim().toLowerCase(),mode=filter.value;
  let rows=state.rows.filter(r=>(!q||(r.title+' '+r.label+' '+r.sport).toLowerCase().includes(q))&&(mode==='all'||(mode==='quoted'&&(r.k!==null||r.p!==null))||(mode==='comparable'&&r.aligned)||(mode==='model'&&r.model!==null))&&(!state.watchOnly||state.watchlist.has(r.key)));
  $('#count').textContent=rows.length+' outcomes shown';
  $('#rows').innerHTML=rows.length?rows.slice(0,400).map(r=>{
    const id=state.rows.indexOf(r);
    return '<tr><td><div class="marketname">'+esc(r.title)+'</div><small>'+esc(r.sport.toUpperCase()+' / '+r.label)+'</small></td><td><span class="pill '+(r.aligned?'ok':r.rules==='RULES DIFFER'?'risk':'')+'">'+esc(r.rules)+'</span></td><td class="yes">'+fmt(r.k)+'</td><td class="poly">'+fmt(r.p)+'</td><td class="gap">'+(r.gap!==null?r.gap.toFixed(1)+' pts':'—')+'</td><td>'+(r.model!==null?(r.model*100).toFixed(1)+'%':'—')+'</td><td><small>'+esc(seen(r.age))+'</small></td><td><button class="watch '+(state.watchlist.has(r.key)?'on':'')+'" data-save="'+id+'" aria-label="Watch contract">'+(state.watchlist.has(r.key)?'★':'☆')+'</button><button data-open="'+id+'" aria-label="Inspect market">↗</button></td></tr>';
  }).join(''):'<tr><td class="empty" colspan="8">'+(state.auth?'No outcomes match these filters. Widen your search or try another lane.':'Sign in through the Platinum Command Center to view live member data.')+'</td></tr>';
}
function detail(r){
 $('#detailTitle').textContent=r.title+' — '+r.label;
 const grid=(label,value)=>'<div><small>'+esc(label)+'</small><strong>'+esc(value)+'</strong></div>';
 $('#detailBody').innerHTML='<p>'+esc(r.sport.toUpperCase())+' · '+esc(r.rules)+'</p><div class="detailgrid">'+grid('KALSHI YES',fmt(r.k))+grid('POLYMARKET YES',fmt(r.p))+grid('VERIFIED GAP',r.gap!==null?r.gap.toFixed(1)+' points':'Not comparable')+grid('PBE MODEL',r.model!==null?(r.model*100).toFixed(1)+'%':'Not published')+'</div><p>Last observation: '+esc(r.age||'Unavailable')+'. A price difference is only calculated when the source confirms aligned contract rules and quotes. No inference from missing data.</p><a href="https://compare.propbetedge.ai/?scope='+encodeURIComponent(r.sport||'sports')+'" target="_blank" rel="noopener noreferrer">Investigate in Compare ↗</a>';
 $('#detail').hidden=false;
}
async function membership(){
 try{
  const resp=await fetch('/api/membership',{credentials:'include',cache:'no-store'});
  const data=await resp.json().catch(()=>({}));
  state.auth=resp.ok&&data.entitled===true;state.role=state.auth?data.role:null;
  $('#member').textContent=state.auth?(state.role==='owner'?'◆ VERIFIED OWNER':'◆ PLATINUM MEMBER'):'PREVIEW · SIGN IN';
  if(!state.auth){
    $('#feedState').textContent=resp.status===503?'Membership service unavailable':'Member sign-in required';
    setNotice(resp.status===503?'Membership authority unavailable. Prices withheld until access is verified.':'Sign in at members.propbetedge.ai to view the All Access terminal. This preview does not show made-up prices.',resp.status===503?'error':'warn');
    $('#rows').innerHTML='<tr><td colspan="8" class="empty">Protected market data requires active All Access membership. <a style="color:#e6bd73" href="https://members.propbetedge.ai/">Open Member Login ↗</a></td></tr>';
    return false;
  }
  return true;
 }catch{state.auth=false;setNotice('Membership check failed. Prices are protected.','error');$('#feedState').textContent='Authentication unavailable';return false;}
}
async function load(){
 if(state.controller)state.controller.abort();
 if(!state.auth)return;
 const abort=new AbortController();state.controller=abort;
 $('#refresh').disabled=true;$('#feedState').textContent='Reading '+scope.value+' market lane…';
 try{
  const resp=await fetch('/api/desk?scope='+encodeURIComponent(scope.value),{credentials:'include',cache:'no-store',signal:abort.signal});
  const data=await resp.json().catch(()=>({}));
  if(abort.signal.aborted)return;
  if(!resp.ok){
   $('#feedState').textContent='Market feed delayed';
   setNotice(resp.status===503?'Access authority unavailable. Keeping the last verified board.':'Market feed unavailable ('+resp.status+'). Retaining prior observations where available.','error');
   return;
  }
  const valid=Array.isArray(data.events)&&Array.isArray(data.lanes);
  if(!valid)throw Error('Unexpected feed schema');
  state.desk=data;state.lastOk=new Date();state.rows=data.events.flatMap(normal);
  const down=data.lanes.filter(x=>x.state!=='ok');
  const cap=data.lanes.some(x=>x.capped);
  tally(state.rows);render();
  $('#feedState').textContent=down.length?'PARTIAL DATA':'MARKET DESK ONLINE';
  setNotice((down.length?down.length+' market lanes unavailable or not connected · ':'')+'Quote observations from market desk · '+state.lastOk.toLocaleTimeString()+(cap?' · One or more lanes reached the 50-event upstream limit.':''));
  $('#coverage').textContent='Source: '+data.lanes.length+' lanes · '+(cap?'CAPPED — NOT FULL MARKET COVERAGE':'source coverage unverified')+' · 60s refresh';
 }catch(e){
  if(e.name!=='AbortError'){setNotice('Data feed error. No market prices have been fabricated.','error');$('#feedState').textContent='MARKET DATA DELAYED';}
 }finally{if(state.controller===abort){state.controller=null;$('#refresh').disabled=false;}}
}
$('#refresh').addEventListener('click',load);
scope.addEventListener('change',()=>{state.rows=[];tally([]);render();load();});
filter.addEventListener('change',render);search.addEventListener('input',render);
$('#savedToggle').addEventListener('click',()=>{state.watchOnly=!state.watchOnly;$('#savedToggle').style.color=state.watchOnly?'#e6bd73':'';render();});
$('#rows').addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;
 const id=Number(b.dataset.save??b.dataset.open),row=state.rows[id];if(!row)return;
 if(b.dataset.save!==undefined){state.watchlist.has(row.key)?state.watchlist.delete(row.key):state.watchlist.add(row.key);store();render();}
 else if(b.dataset.open!==undefined)detail(row);
});
const close=()=>{$('#detail').hidden=true};$('#close').addEventListener('click',close);$('#closeBackdrop').addEventListener('click',close);window.addEventListener('keydown',e=>{if(e.key==='Escape')close();});
function clock(){ $('#clock').textContent=new Date().toISOString().slice(11,19)+' UTC'; }clock();setInterval(clock,1000);
(async()=>{if(await membership())await load();})();
setInterval(()=>{if(!document.hidden&&state.auth)void load()},60000);
