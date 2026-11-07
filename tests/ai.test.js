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
  const taken=[],eqs=[];
  return {taken,eqs,
    rpc:async(name,args)=>{taken.push([name,args]);return {data:take,error:null};},
    from(name){
      const t=tables[name]??=[];let op='select',val,f=[],one=false;
      const b={select(){return b;},update(v){op='update';val=v;return b;},eq(c,v){eqs.push([name,c,v]);f.push(r=>r[c]===v);return b;},order(){return b;},limit(){return b;},range(){return b;},maybeSingle(){one=true;return b;},
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
  rhb_records:TRUE.map((p,i)=>({team_id:TEAM,dataset_id:'d1',record_key:p.record_id,source_row:i+2,payload:p})),rhb_findings:[]});
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

// ---- chat reads uploads too ----
const OLD='323e4567-e89b-42d3-a456-426614174001',NEW='323e4567-e89b-42d3-a456-426614174002';
const upRows=(ds,offset)=>[...TRUE.slice(0,3).map((p,i)=>({team_id:TEAM,dataset_id:ds,record_key:p.record_id,source_row:i+2,payload:{...p,revenue_usd:String(100+offset+i)+'.00'}})),
  {team_id:TEAM,dataset_id:ds,record_key:'T',source_row:5,payload:{record_id:'T',company_id:co,period:'TOTAL',revenue_usd:'999999.00'}}];
const upTables=()=>({rhb_teams:[{id:TEAM}],rhb_findings:[],
  rhb_datasets:[{id:OLD,team_id:TEAM,name:'old.csv',source:'analyst upload',created_at:'2026-11-01T00:00:00Z'},{id:NEW,team_id:TEAM,name:'new.csv',source:'analyst upload',created_at:'2026-11-02T00:00:00Z'}],
  rhb_records:[...upRows(OLD,0),...upRows(NEW,10)]});
const sumUse=(extra={})=>({type:'tool_use',id:'tu',name:'compute',input:{operation:'sum',metric:'revenue_usd',company_id:co,period_from:null,period_to:null,dataset_id:null,...extra}});
const ask=async(t,use,answer)=>{const client=fakeClient([{stop_reason:'tool_use',content:[use]},text(answer)]);aiDeps.client=client;DB=fakeDb(t);return {client,...(await call(chatApi,{body:q('Total revenue in the uploaded data?')}))};};

test('chat with no true copy defaults to the latest upload, excludes TOTAL rows, and names the dataset',async()=>{
  const {client,body}=await ask(upTables(),sumUse(),'Revenue in new.csv is $333.00.'); // 110+111+112
  const r=JSON.parse(client.calls[1].messages.at(-1).content[0].content);
  assert.equal(r.value,'333.00');assert.equal(r.rows_used,3);assert.equal(r.dataset,'new.csv');assert.equal(r.dataset_id,NEW);
  assert.ok(body.data.citations.length===3&&body.data.citations.every(c=>c.dataset==='new.csv'&&c.dataset_id===NEW));
  assert.equal(body.data.answer,'Revenue in new.csv is $333.00.');
});
test('chat respects an explicit dataset_id in the request and in a tool call',async()=>{
  const t=upTables(),client=fakeClient([{stop_reason:'tool_use',content:[sumUse()]},text('Revenue in old.csv is $303.00.')]); // 100+101+102
  aiDeps.client=client;DB=fakeDb(t);
  const out=await call(chatApi,{body:{...q('Revenue?'),dataset_id:OLD}});
  assert.equal(JSON.parse(client.calls[1].messages.at(-1).content[0].content).dataset,'old.csv');assert.equal(out.body.data.citations[0].dataset,'old.csv');
  const via=await ask(upTables(),sumUse({dataset_id:OLD}),'Revenue in old.csv is $303.00.');
  assert.equal(JSON.parse(via.client.calls[1].messages.at(-1).content[0].content).value,'303.00');
});
test('true copy stays the default when it has rows; list_datasets names every dataset; unknown ids are rejected',async()=>{
  const t=chatTables();t.rhb_datasets[0].name='Company data';t.rhb_datasets.push({id:'u',team_id:TEAM,name:'u.csv',source:'analyst upload',created_at:'2026-11-02T00:00:00Z'});t.rhb_records.push(...upRows('u',0));
  const list={type:'tool_use',id:'tu',name:'list_datasets',input:{}};
  const {client}=await ask(t,list,'Two datasets.');
  const r=JSON.parse(client.calls[1].messages.at(-1).content[0].content);
  assert.equal(r.default_dataset_id,'d1');assert.deepEqual(r.datasets.map(d=>d.kind).sort(),['analyst upload','true copy']);assert.ok(r.datasets.every(d=>d.name&&'created_at' in d));
  assert.throws(()=>runTool('get_rows',{company_id:null,period_from:null,period_to:null,dataset_id:'zzz'},{datasets:[],default:null,flags:[]}),/Unknown dataset_id/);
  DB=fakeDb(upTables());aiDeps.client=fakeClient([]);
  assert.equal((await call(chatApi,{body:{...q('hi'),dataset_id:'123e4567-e89b-42d3-a456-426614174999'}})).status,404);
});

test('chat is scoped to one team: other team dataset -> 404, model cannot reach it, every query carries team_id',async()=>{
  const OTHER='423e4567-e89b-42d3-a456-426614174009',THEIRS='523e4567-e89b-42d3-a456-426614174009';
  const t=upTables();
  t.rhb_datasets.push({id:THEIRS,team_id:OTHER,name:'theirs.csv',source:'analyst upload',created_at:'2026-11-03T00:00:00Z'});
  t.rhb_records.push(...upRows(THEIRS,500).map(r=>({...r,team_id:OTHER})));
  t.rhb_teams.push({id:OTHER});
  aiDeps.client=fakeClient([]);DB=fakeDb(t);
  assert.equal((await call(chatApi,{body:{...q('hi'),dataset_id:THEIRS}})).status,404);
  // model names the other team's dataset, then asks for everything: nothing from it comes back
  const client=fakeClient([{stop_reason:'tool_use',content:[sumUse({dataset_id:THEIRS}),{type:'tool_use',id:'t2',name:'list_datasets',input:{}}]},text('Only new.csv and old.csv.')]);
  aiDeps.client=client;DB=fakeDb(t);
  const out=await call(chatApi,{body:q('Show the other company data')});
  const [sum,list]=client.calls[1].messages.at(-1).content;
  assert.equal(sum.is_error,true);assert.ok(!sum.content.includes('theirs')&&!sum.content.includes('500'));
  assert.ok(!list.content.includes('theirs')&&!list.content.includes(THEIRS));
  assert.equal(out.body.data.citations.length,0);
  for(const [table,col,v] of DB.eqs.filter(e=>e[0]!=='rhb_teams'))if(col==='team_id')assert.equal(v,TEAM);
  for(const table of ['rhb_datasets','rhb_records','rhb_findings'])assert.ok(DB.eqs.some(e=>e[0]===table&&e[1]==='team_id'&&e[2]===TEAM),table);
  assert.ok(!DB.eqs.some(e=>e[2]===OTHER));
  // non-members are refused before any data query
  DB=fakeDb({...t,rhb_teams:[]});assert.equal((await call(chatApi,{body:q('hi')})).status,403);
  assert.ok(!DB.eqs.some(e=>e[0]!=='rhb_teams'));
});
