// PBE Terminal's separate, fail-closed membership boundary. Never trust a browser entitlement.
export const AUTHORITY = 'https://pbe-predictions.sales-fd3.workers.dev/v1/membership';
export const COMPARE = 'https://compare.propbetedge.ai';
export const SCOPES = new Set(['sports','nonsports','nfl','nba','nhl','mlb','wnba','tennis','ufc','soccer','golf','f1']);

export function sessionCookie(header = '') {
  const match = String(header).match(/(?:^|;\s*)pbe_session=([^;]{1,3000})(?:;|$)/);
  return match ? 'pbe_session=' + match[1] : '';
}

export function accessVerdict(result) {
  if (result.unavailable) return { status:503, state:'unverified', entitled:false };
  const membership = result.body?.membership || {};
  if (membership.entitled === true && (membership.state === 'all_access' || membership.state === 'owner'))
    return { status:200, state:membership.state, entitled:true };
  if (membership.state === 'unverified') return { status:503, state:'unverified', entitled:false };
  if (membership.state === 'anonymous' || result.body?.authenticated === false)
    return { status:401, state:'anonymous', entitled:false };
  return { status:403, state:'upgrade_required', entitled:false };
}

export async function checkMembership(req, fetchImpl = fetch) {
  const cookie = sessionCookie(req.headers?.cookie || '');
  if (!cookie) return { status:401, state:'anonymous', entitled:false, cookie:'' };
  try {
    const response = await fetchImpl(AUTHORITY, {
      headers:{accept:'application/json',cookie}, cache:'no-store', signal:AbortSignal.timeout(4500)
    });
    const body = await response.json();
    if (!response.ok || typeof body?.membership?.state !== 'string')
      return { status:503, state:'unverified', entitled:false, cookie };
    return { ...accessVerdict({body}), cookie };
  } catch {
    return { status:503, state:'unverified', entitled:false, cookie };
  }
}

export function send(res,status,body) {
  res.setHeader('Cache-Control','private, no-store, max-age=0');
  res.setHeader('Vary','Cookie');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(status===503)res.setHeader('Retry-After','30');
  return res.status(status).send(JSON.stringify(body));
}

export async function requireAccess(req,res){
  const verdict=await checkMembership(req);
  if(!verdict.entitled){send(res,verdict.status,{error:verdict.state,entitled:false});return null;}
  return verdict;
}

export async function compareRead(route,cookie,fetchImpl=fetch){
  const response=await fetchImpl(COMPARE+route,{
    headers:{accept:'application/json',cookie},
    cache:'no-store',signal:AbortSignal.timeout(12500)
  });
  const body=await response.json().catch(()=>null);
  return {status:response.status,body};
}
