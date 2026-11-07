import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import aiReport from '../api/ai-report.js';
import chatApi from '../api/chat.js';
import config from '../api/config.js';
import {deps} from '../api/_lib.js';
import {deps as aiDeps,unverifiedNumbers,runTool,buildReportInput,guardReport,secondsToMidnightET,UNVERIFIED_ANSWER} from '../lib/ai.js';
import {parseCSV} from '../lib/csv.js';
import {checkSheet} from '../lib/checker.js';
import {summarize} from '../lib/summary.js';
import {minor,amount} from '../lib/finance.js';

const csv=f=>parseCSV(fs.readFileSync(new URL(`../data/${f}`,import.meta.url),'utf8'));
const TRUE=csv('monthly_financials.csv');
const rows=TRUE.map((r,i)=>({...r,source_row:i+2}));
const ID='123e4567-e89b-42d3-a456-426614174000',TEAM='223e4567-e89b-42d3-a456-426614174000';
const co=TRUE[0].company_id;

// ---- tiny fakes: query builder, Anthropic client, request/response ----
function fakeDb(tables,{take=true}={}){
  const taken=[];
  return {taken,
    rpc:async(name,args)=>{taken.push([name,args]);return {data:take,error:null};},
    from(name){
      const t=tables[name]??=[];let op='select',val,f=[],one=false;
      const b={select(){return b;},update(v){op='update';val=v;return b;},eq(c,v){f.push(r=>r[c]===v);return b;},order(){return b;},limit(){return b;},maybeSingle(){one=true;return b;},
        then(ok,no){return Promise.resolve().then(()=>{const hit=t.filter(r=>f.every(g=>g(r)));if(op==='update')hit.forEach(r=>Object.assign(r,val));return {data:one?hit[0]??null:hit,error:null};}).then(ok,no);}};
      return b;
    }};
}
const fakeClient=replies=>{const calls=[];return {calls,beta:{messages:{create:async req=>{calls.push(structuredClone(req));const r=replies.shift();if(r instanceof Error)throw r;return r;}}}};};
const text=(t,extra={})=>({stop_reason:'end_turn',content:[{type:'text',text:t}],...extra});
const call=async(handler,{method='POST',body}={})=>{
  const out={headers:{}};
  await handler({method,url:'/',headers:{authorization:'Bearer t'},body},{setHeader(k,v){out.headers[k]=v;},status(c){out.status=c;return this;},json(b){out.body=b;return this;}});
  return out;
};
let DB;deps.authenticate=async()=>DB;
const KEY=process.env.ANTHROPIC_API_KEY;
test.afterEach(()=>{aiDeps.client=null;if(KEY)process.env.ANTHROPIC_API_KEY=KEY;else delete process.env.ANTHROPIC_API_KEY;});

// ---- number guard ----
test('unverifiedNumbers allows real numbers in any format and catches invented ones',()=>{
  const src={a:'1234.50',b:'3.58',c:'2026-03'};
  assert.deepEqual(unverifiedNumbers('Revenue was $1,234.5 (3.580%) in 2026-03 and March 2026.',src),[]);
  assert.deepEqual(unverifiedNumbers('Revenue was $1,234.50, not $9,999.',src),['9999']);
  assert.deepEqual(unverifiedNumbers('Up 7% overall.',['3.58']),['7']);
});

// ---- tools: exact cents ----
test('compute returns exact sums, variances and changes from lib code',()=>{
  const mine=rows.filter(r=>r.company_id===co);
  const cents=c=>mine.reduce((t,r)=>t+minor(r[c]),0n);
  const sum=runTool('compute',{operation:'sum',metric:'revenue_usd',company_id:co,period_from:null,period_to:null},{rows,flags:[]});
  assert.equal(sum.result.value,amount(cents('revenue_usd')));
  assert.equal(sum.citations.length,mine.length);
  assert.equal(sum.citations[0].source_row,mine[0].source_row);
  const v=runTool('compute',{operation:'variance',metric:'revenue_usd',company_id:co,period_from:null,period_to:null},{rows,flags:[]}).result;
  assert.equal(v.difference,amount(cents('revenue_usd')-cents('budget_revenue_usd')));
  const ch=runTool('compute',{operation:'change',metric:'closing_cash_usd',company_id:co,period_from:'2026-01',period_to:'2026-02'},{rows,flags:[]}).result;
  const [a,b]=['2026-01','2026-02'].map(p=>minor(mine.find(r=>r.period===p).closing_cash_usd));
  assert.equal(ch.difference,amount(b-a));
});
test('tools reject bad input and run_checks finds no mismatch in the true copy',()=>{
  assert.throws(()=>runTool('compute',{operation:'sum',metric:'ssn',company_id:null,period_from:null,period_to:null},{rows,flags:[]}),/Unknown metric/);
  assert.throws(()=>runTool('get_rows',{company_id:null,period_from:'March',period_to:null},{rows,flags:[]}),/invalid/);
  assert.throws(()=>runTool('nope',{},{rows,flags:[]}),/Unknown tool/);
  assert.equal(runTool('run_checks',{company_id:null},{rows,flags:[]}).result.flag_count,0);
  assert.equal(runTool('get_rows',{company_id:null,period_from:null,period_to:null},{rows,flags:[]}).result.rows.length,36);
});

// ---- prompt contents ----
test('report input holds only code-computed flag fields; ai.js never touches the answer key',()=>{
  const flags=checkSheet(csv('synthetic/analyst-sheet-errors.csv'));
  assert.ok(flags.length>0);
  const input=buildReportInput({company:'Acme',mode:'source',summary:summarize(csv('synthetic/analyst-sheet-errors.csv'),flags),flags});
  const s=JSON.stringify(input);
  assert.ok(!/planted|expected|answer|source_row|related/i.test(s));
  assert.ok(input.flags.length<=60&&input.flags_total===flags.length);
  const src=fs.readFileSync(new URL('../lib/ai.js',import.meta.url),'utf8');
  assert.ok(!src.includes('planted-errors')&&!/from 'node:fs'|from 'fs'/.test(src));
});
test('guardReport drops priorities with invented numbers or unknown flag keys',()=>{
  const input={flags:[{key:'A:1',cell:'E2',sheet_value:'100.00'}],n:'100.00'};
  const out=guardReport({headline:'One flag, value 100.',caveats:['Read checker output only.','Total 5,000 lost.'],priorities:[
    {flag_keys:['A:1'],title:'Check E2',why:'Shows 100 here.',action:'Compare.'},
    {flag_keys:['A:1'],title:'Bad number',why:'Off by $777.',action:''},
    {flag_keys:['ZZ'],title:'Ghost',why:'x',action:''}]},input,'m');
  assert.deepEqual(out.priorities.map(p=>p.title),['Check E2']);
  assert.equal(out.caveats.length,1);
  assert.equal(out.removed.length,3);
  assert.deepEqual(out.removed.find(r=>r.what==='Bad number').numbers,['777']);
});
test('secondsToMidnightET is within a day',()=>{const s=secondsToMidnightET();assert.ok(s>0&&s<=86400);});

// ---- endpoints ----
const tables=()=>({rhb_datasets:[{id:ID,team_id:TEAM,name:'f.csv'}],rhb_teams:[{id:TEAM,name:'Acme'}],
  rhb_findings:[{team_id:TEAM,dataset_id:ID,method:'deterministic',review_status:'open',flag:{key:'R1:revenue_usd',type:'wrong_variance',severity:'medium',cell:'E5',record_id:'R1',company_id:co,period:'2026-01',sheet_value:'123.00',suggested_value:'124.00',calculation:'x',explanation:'e',source:{file:'f'}}}],
  rhb_records:[{dataset_id:ID,source_row:2,payload:TRUE[0]}]});

test('config exposes aiEnabled and never the key',async()=>{
  process.env.ANTHROPIC_API_KEY='sk-ant-test-secret';
  const out=await call(config,{method:'GET'});
  assert.equal(out.body.aiEnabled,true);
  assert.ok(!JSON.stringify(out.body).includes('sk-ant'));
});
test('missing key -> 503 for both endpoints',async()=>{
  delete process.env.ANTHROPIC_API_KEY;DB=fakeDb(tables());
  assert.equal((await call(aiReport,{body:{dataset_id:ID}})).status,503);
  assert.equal((await call(chatApi,{body:{team_id:TEAM,messages:[{role:'user',content:'hi'}]}})).status,503);
});
test('limit reached -> 429 with Retry-After and no model call',async()=>{
  const client=fakeClient([]);aiDeps.client=client;DB=fakeDb(tables(),{take:false});
  const out=await call(aiReport,{body:{dataset_id:ID}});
  assert.equal(out.status,429);assert.ok(Number(out.headers['Retry-After'])>0);assert.equal(client.calls.length,0);
  assert.deepEqual(DB.taken[0],['rhb_ai_take',{kind:'report',daily_max:10}]);
});
test('report is saved in the planned shape; invented numbers are removed',async()=>{
  const json=JSON.stringify({headline:'One flag needs review.',caveats:['I only read the checker output.'],priorities:[
    {flag_keys:['R1:revenue_usd'],title:'Check E5',why:'Sheet shows 123.00 but the checker expects 124.00.',action:'Open row R1.'},
    {flag_keys:['R1:revenue_usd'],title:'Invented',why:'Off by 999.',action:''}]});
  const client=fakeClient([text(json)]);aiDeps.client=client;const t=tables();DB=fakeDb(t);
  const out=await call(aiReport,{body:{dataset_id:ID}});
  assert.equal(out.status,201);
  const r=out.body.data.ai_report;
  assert.deepEqual(Object.keys(r).sort(),['at','caveats','headline','model','priorities','removed']);
  assert.equal(r.model,'claude-opus-5-5');assert.equal(r.priorities.length,1);assert.equal(r.removed[0].what,'Invented');
  assert.deepEqual(t.rhb_datasets[0].ai_report,r);
  const req=client.calls[0];
  assert.equal(req.max_tokens,6000);assert.equal(req.fallbacks,'default');assert.equal(req.output_config.format.type,'json_schema');
  assert.ok(!('temperature' in req)&&!('tool_choice' in req));
});
test('Anthropic failure -> 502 generic, refusal -> 502, nothing saved',async()=>{
  const t=tables();DB=fakeDb(t);
  aiDeps.client=fakeClient([new Error('boom sk-ant-secret')]);
  const a=await call(aiReport,{body:{dataset_id:ID}});
  assert.equal(a.status,502);assert.ok(!JSON.stringify(a.body).includes('boom'));
  aiDeps.client=fakeClient([{stop_reason:'refusal',content:[]}]);
  assert.equal((await call(aiReport,{body:{dataset_id:ID}})).status,502);
  assert.equal(t.rhb_datasets[0].ai_report,undefined);
});

const chatTables=()=>({rhb_teams:[{id:TEAM}],rhb_datasets:[{id:'d1',team_id:TEAM,source:'company data'}],
  rhb_records:TRUE.map((p,i)=>({dataset_id:'d1',record_key:p.record_id,source_row:i+2,payload:p})),rhb_findings:[]});
const q=content=>({team_id:TEAM,messages:[{role:'user',content}]});

test('chat runs a tool round, returns exact answer, citations and tools',async()=>{
  const total=amount(rows.filter(r=>r.company_id===co).reduce((t,r)=>t+minor(r.revenue_usd),0n));
  const use={type:'tool_use',id:'tu1',name:'compute',input:{operation:'sum',metric:'revenue_usd',company_id:co,period_from:null,period_to:null}};
  const client=fakeClient([{stop_reason:'tool_use',content:[use]},text(`Total revenue for ${co} is $${total}.`)]);
  aiDeps.client=client;DB=fakeDb(chatTables());
  const out=await call(chatApi,{body:q('What is total revenue?')});
  assert.equal(out.status,200);
  const d=out.body.data;
  assert.ok(d.answer.includes(total));assert.equal(d.ai,true);assert.equal(d.model,'claude-sonnet-5-5');
  assert.equal(d.tools[0].name,'compute');
  assert.equal(d.citations.length,12);assert.ok(d.citations.every(c=>c.record_id&&c.source_row>=2));
  const second=client.calls[1].messages.at(-1).content[0];
  assert.equal(second.type,'tool_result');assert.ok(second.content.includes(total));
  assert.equal(client.calls[0].max_tokens,1500);assert.ok(client.calls[0].tools.every(t=>t.strict));
  assert.deepEqual(DB.taken[0],['rhb_ai_take',{kind:'chat',daily_max:40}]);
});
test('chat replaces an answer with an unverified number and sends bad tool input back as an error',async()=>{
  const bad={type:'tool_use',id:'tu1',name:'compute',input:{operation:'sum',metric:'ssn',company_id:null,period_from:null,period_to:null}};
  const client=fakeClient([{stop_reason:'tool_use',content:[bad]},text('Revenue was $424,242.42.')]);
  aiDeps.client=client;DB=fakeDb(chatTables());
  const d=(await call(chatApi,{body:q('Revenue?')})).body.data;
  assert.equal(d.answer,UNVERIFIED_ANSWER);assert.deepEqual(d.citations,[]);
  assert.equal(client.calls[1].messages.at(-1).content[0].is_error,true);
});
test('chat validates input: 500 char question, last turn must be user, member check',async()=>{
  aiDeps.client=fakeClient([]);DB=fakeDb(chatTables());
  assert.equal((await call(chatApi,{body:q('x'.repeat(501))})).status,422);
  assert.equal((await call(chatApi,{body:{team_id:TEAM,messages:[{role:'assistant',content:'hi'}]}})).status,422);
  DB=fakeDb({...chatTables(),rhb_teams:[]});
  assert.equal((await call(chatApi,{body:q('hi')})).status,403);
});
