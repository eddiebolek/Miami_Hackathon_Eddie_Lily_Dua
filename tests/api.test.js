import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../api/config.js';
import checks from '../api/checks.js';
import findings from '../api/findings.js';
import companyData from '../api/company-data.js';
import members from '../api/members.js';
import {deps} from '../api/_lib.js';
import {parseCSV} from '../lib/csv.js';
import fs from 'node:fs';

const call=async(handler,{method='GET',url='/',headers={},body}={})=>{
  const out={headers:{}};
  const res={setHeader(k,v){out.headers[k]=v;},status(c){out.status=c;return this;},json(b){out.body=b;return this;}};
  await handler({method,url,headers,body},res);
  return out;
};
const ID='123e4567-e89b-42d3-a456-426614174000';
const authed={authorization:'Bearer t'};
let DB; // each test installs a fake db; no network
deps.authenticate=async t=>{if(t!=='t')throw Error('bad');return DB;};

// Tiny in-memory stand-in for the Supabase query builder: eq/neq/in filters, order, limit, insert/update + select.
function fakeDb(tables,{rpc={},user={id:'u1',email:'a@x.test'}}={}){
  let n=0;
  return {
    auth:{getUser:async()=>({data:{user}})},
    rpc:async(name,args)=>rpc[name]?rpc[name](args):{data:null,error:{message:'no rpc'}},
    from(name){
      const t=tables[name]??=[];let op='select',val,f=[],ord,lim,one=false;
      const b={
        select(){return b;},insert(v){op='insert';val=v;return b;},upsert(v){op='insert';val=v;return b;},update(v){op='update';val=v;return b;},
        eq(c,v){f.push(r=>r[c]===v);return b;},neq(c,v){f.push(r=>r[c]!==v);return b;},in(c,v){f.push(r=>v.includes(r[c]));return b;},
        order(c,{ascending=true}={}){ord=[c,ascending];return b;},limit(k){lim=k;return b;},
        maybeSingle(){one=true;return b;},single(){one=true;return b;},
        then(ok,no){return Promise.resolve().then(()=>{
          let hit=t.filter(r=>f.every(g=>g(r)));
          if(op==='insert'){hit=[].concat(val).map(r=>({id:`id-${++n}`,review_status:'open',created_at:new Date(2026,10,7,12,0,n).toISOString(),note:null,...r}));t.push(...hit);}
          if(op==='update')hit.forEach(r=>Object.assign(r,val));
          if(ord)hit=[...hit].sort((x,y)=>(x[ord[0]]>y[ord[0]]?1:-1)*(ord[1]?1:-1));
          if(lim)hit=hit.slice(0,lim);
          return {data:one?hit[0]??null:hit,error:null};
        }).then(ok,no);}
      };
      return b;
    }
  };
}
const csvOf=f=>fs.readFileSync(new URL(`../data/${f}`,import.meta.url),'utf8');
// A company with its true copy saved: the 36 rows of data/monthly_financials.csv.
const withCopy=()=>{
  const rows=parseCSV(csvOf('monthly_financials.csv'));
  return fakeDb({rhb_teams:[{id:ID}],rhb_datasets:[{id:'ds-copy',team_id:ID,source:'company data',name:'Company data'}],
    rhb_records:rows.map((p,i)=>({dataset_id:'ds-copy',team_id:ID,record_key:p.record_id,source_row:i+2,payload:p}))});
};
const empty=()=>fakeDb({rhb_teams:[{id:ID}]});

test('config returns only the URL and publishable key',async()=>{
  process.env.SUPABASE_URL='https://x.supabase.co';process.env.SUPABASE_PUBLISHABLE_KEY='pk';
  const r=await call(config);
  assert.equal(r.status,200);assert.deepEqual(r.body,{supabaseUrl:'https://x.supabase.co',publishableKey:'pk',aiEnabled:false});
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
  DB=empty();
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

test('checks: no true copy runs internal checks; clean sheet has no flags',async()=>{
  DB=empty();
  const r=await call(checks,{method:'POST',headers:authed,body:{team_id:ID,filename:'clean.csv',csv:csvOf('synthetic/analyst-sheet-clean.csv')}});
  assert.equal(r.status,201);assert.equal(r.body.data.mode,'internal');assert.equal(r.body.data.flag_count,0);
  assert.ok(r.body.data.summary.companies.length>0);
});
test('checks: with a true copy the upload is compared with it',async()=>{
  DB=withCopy();
  const r=await call(checks,{method:'POST',headers:authed,body:{team_id:ID,filename:'bad.csv',csv:csvOf('synthetic/analyst-sheet-errors.csv')}});
  assert.equal(r.status,201);assert.equal(r.body.data.mode,'source');
  assert.ok(r.body.data.flag_count>0);assert.equal(r.body.data.flags[0].source.file,'Company data (true copy)');
});
test('checks: a non-member gets 403',async()=>{
  DB=fakeDb({});
  const r=await call(checks,{method:'POST',headers:authed,body:{team_id:ID,filename:'a.csv',csv:csvOf('synthetic/analyst-sheet-clean.csv')}});
  assert.equal(r.status,403);
});
test('new routes: no token gives 401',async()=>{
  for(const [h,method] of [[companyData,'GET'],[companyData,'POST'],[members,'GET'],[members,'POST'],[findings,'GET'],[findings,'POST']])
    assert.equal((await call(h,{method,body:{}})).status,401);
});
test('company-data: bad body gives 422',async()=>{
  DB=empty();
  assert.equal((await call(companyData,{method:'POST',headers:authed,body:{team_id:'x',filename:'',csv:1}})).status,422);
  assert.equal((await call(companyData,{method:'GET',headers:authed,url:'/api/company-data'})).status,422);
  const r=await call(companyData,{method:'POST',headers:authed,body:{team_id:ID,filename:'a.csv',csv:'record_id,period\nX,2026-01\n'}});
  assert.equal(r.status,422);assert.ok(r.body.error.details.length>0);
});
test('company-data: GET returns rows with code-computed variance and roll-forward',async()=>{
  DB=withCopy();
  const r=await call(companyData,{url:`/api/company-data?team_id=${ID}`,headers:authed});
  assert.equal(r.status,200);assert.equal(r.body.data.rows.length,36);
  const c=r.body.data.rows[0].computed;
  assert.equal(c.revenue_variance_usd,'3000.00');assert.equal(c.opex_variance_usd,'2000.00');assert.equal(c.rollforward_ok,true);
  DB=empty();
  assert.equal((await call(companyData,{url:`/api/company-data?team_id=${ID}`,headers:authed})).body.data.dataset_id,null);
});
test('company-data: preview writes nothing, confirm appends, a repeat is 409',async()=>{
  DB=withCopy();
  const body={team_id:ID,filename:'jan.csv',csv:csvOf('synthetic/new-month-2027-01.csv')};
  const p=await call(companyData,{method:'POST',headers:authed,body});
  assert.equal(p.status,200);assert.equal(p.body.data.count,3);assert.deepEqual(p.body.data.warnings,[]);
  assert.equal(p.body.data.new_rows[0].source_row,38);
  const recs=()=>DB.from('rhb_records');
  assert.equal((await recs()).data.length,36);
  const c=await call(companyData,{method:'POST',headers:authed,body:{...body,confirm:true}});
  assert.equal(c.status,201);assert.equal(c.body.data.added,3);
  assert.equal((await recs()).data.length,39);
  const again=await call(companyData,{method:'POST',headers:authed,body:{...body,confirm:true}});
  assert.equal(again.status,409);assert.equal(again.body.error.code,'already_exists');
  assert.equal((await recs()).data.length,39);
  // same company+period under a new record_id is also a clash
  const other=body.csv.replace(/FIN-1-13/,'FIN-1-99');
  assert.equal((await call(companyData,{method:'POST',headers:authed,body:{...body,csv:other}})).status,409);
});
test('company-data: first add creates the Company data dataset; broken opening cash is a warning',async()=>{
  DB=empty();
  const jan=csvOf('synthetic/new-month-2027-01.csv');
  const r=await call(companyData,{method:'POST',headers:authed,body:{team_id:ID,filename:'jan.csv',csv:jan,confirm:true}});
  assert.equal(r.status,201);
  const ds=(await DB.from('rhb_datasets')).data;
  assert.equal(ds.length,1);assert.equal(ds[0].source,'company data');
  DB=withCopy();
  const broken=jan.replace('"521725.00"','"1.00"');
  const w=await call(companyData,{method:'POST',headers:authed,body:{team_id:ID,filename:'jan.csv',csv:broken}});
  assert.equal(w.status,200);assert.ok(w.body.data.warnings.some(f=>f.type==='rollforward_break'));
});
test('members: bad body 422, non-owner 403, unknown email 404, owner adds 201, list',async()=>{
  const rpc={
    rhb_add_member:async({member_email})=>member_email==='nobody@x.test'?{data:null,error:{code:'P0002',message:'No login with that email. Create it in Supabase first.'}}:member_email==='eve@x.test'?{data:null,error:{code:'42501',message:'Only the company owner can add members'}}:{data:'uid-9',error:null},
    rhb_team_members:async()=>({data:[{user_id:'u1',email:'a@x.test',is_owner:true}],error:null})
  };
  DB=fakeDb({},{rpc});
  assert.equal((await call(members,{method:'POST',headers:authed,body:{team_id:ID,email:'nope'}})).status,422);
  const forbidden=await call(members,{method:'POST',headers:authed,body:{team_id:ID,email:'eve@x.test'}});
  assert.equal(forbidden.status,403);assert.match(forbidden.body.error.message,/owner/);
  const missing=await call(members,{method:'POST',headers:authed,body:{team_id:ID,email:'nobody@x.test'}});
  assert.equal(missing.status,404);assert.match(missing.body.error.message,/No login/);
  const ok=await call(members,{method:'POST',headers:authed,body:{team_id:ID,email:'b@x.test'}});
  assert.equal(ok.status,201);assert.equal(ok.body.data.user_id,'uid-9');
  const l=await call(members,{url:`/api/members?team_id=${ID}`,headers:authed});
  assert.equal(l.status,200);assert.equal(l.body.data[0].is_owner,true);
});
test('findings: suggested edit is created and listed, never changes the data',async()=>{
  DB=withCopy();
  const bad=await call(findings,{method:'POST',headers:authed,body:{team_id:ID,record_id:'FIN-1-01',column:'record_id',proposed_value:'1,000',reason:''}});
  assert.equal(bad.status,422);assert.equal(bad.body.error.details.length,3);
  const missing=await call(findings,{method:'POST',headers:authed,body:{team_id:ID,record_id:'NOPE',column:'revenue_usd',proposed_value:'1.00',reason:'x'}});
  assert.equal(missing.status,404);
  const before=JSON.stringify((await DB.from('rhb_records')).data);
  const c=await call(findings,{method:'POST',headers:authed,body:{team_id:ID,record_id:'FIN-1-01',column:'revenue_usd',proposed_value:'1234.56',reason:'Invoice 77 was booked late'}});
  assert.equal(c.status,201);assert.equal(c.body.data.kind,'suggested_edit');assert.equal(c.body.data.by_email,'a@x.test');assert.ok(c.body.data.current_value);
  assert.equal(JSON.stringify((await DB.from('rhb_records')).data),before);
  const s=await call(findings,{url:`/api/findings?team_id=${ID}&kind=suggestion`,headers:authed});
  assert.equal(s.body.data.length,1);assert.equal(s.body.data[0].proposed_value,'1234.56');
  assert.equal((await call(findings,{url:`/api/findings?team_id=${ID}&kind=flag`,headers:authed})).body.data.length,0);
  assert.equal((await call(findings,{url:`/api/findings?team_id=${ID}&status=bogus`,headers:authed})).status,422);
  const p=await call(findings,{method:'PATCH',url:`/api/findings?id=${ID}`,headers:authed,body:{decision:'no_change_needed',note:'ok'}});
  assert.equal(p.status,404); // fake has no row with that uuid; RLS-style "not yours"
});
