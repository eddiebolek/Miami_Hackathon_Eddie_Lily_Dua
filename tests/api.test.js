import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../api/config.js';
import checks from '../api/checks.js';
import findings from '../api/findings.js';
import {deps} from '../api/_lib.js';

const call=async(handler,{method='GET',url='/',headers={},body}={})=>{
  const out={headers:{}};
  const res={setHeader(k,v){out.headers[k]=v;},status(c){out.status=c;return this;},json(b){out.body=b;return this;}};
  await handler({method,url,headers,body},res);
  return out;
};
const ID='123e4567-e89b-42d3-a456-426614174000';
const authed={authorization:'Bearer t'};
deps.authenticate=async t=>{if(t!=='t')throw Error('bad');return {};}; // no network: the stub db is never reached on these paths

test('config returns only the URL and publishable key',async()=>{
  process.env.SUPABASE_URL='https://x.supabase.co';process.env.SUPABASE_PUBLISHABLE_KEY='pk';
  const r=await call(config);
  assert.equal(r.status,200);assert.deepEqual(r.body,{supabaseUrl:'https://x.supabase.co',publishableKey:'pk'});
});
test('wrong method gives 405',async()=>{
  const r=await call(config,{method:'POST'});
  assert.equal(r.status,405);assert.equal(r.body.error.code,'method_not_allowed');
});
test('checks: no token or bad token gives 401',async()=>{
  assert.equal((await call(checks,{method:'POST',body:{}})).status,401);
  assert.equal((await call(checks,{method:'POST',headers:{authorization:'Bearer nope'},body:{}})).status,401);
});
test('checks: bad sheet gives 422 with details',async()=>{
  const r=await call(checks,{method:'POST',headers:authed,body:{team_id:ID,filename:'a.csv',csv:'record_id,period\nX,2026-01\n'}});
  assert.equal(r.status,422);assert.ok(r.body.error.message.includes('Missing column'));assert.ok(r.body.error.details.length>0);
});
test('checks: bad body gives 422',async()=>{
  const r=await call(checks,{method:'POST',headers:authed,body:{team_id:'x',filename:'',csv:1}});
  assert.equal(r.status,422);assert.equal(r.body.error.details.length,3);
});
test('findings: no_change_needed without a note gives 422',async()=>{
  const r=await call(findings,{method:'PATCH',url:`/api/findings?id=${ID}`,headers:authed,body:{decision:'no_change_needed'}});
  assert.equal(r.status,422);assert.match(r.body.error.message,/note is required/);
});
