// AI layer: the model only reads numbers that code computed. It never does math and never sees an answer key.
// Everything here is testable offline: deps.client can be replaced with a fake Anthropic client.
import Anthropic from '@anthropic-ai/sdk';
import {minor,amount,variance} from './finance.js';
import {checkSheet} from './checker.js';

export const deps={client:null};
export const aiEnabled=()=>Boolean(deps.client||process.env.ANTHROPIC_API_KEY);
const client=()=>deps.client??=new Anthropic(); // reads ANTHROPIC_API_KEY itself; the key never appears in our code or logs
export const MODELS=()=>({report:process.env.AI_REPORT_MODEL||'claude-opus-5-5',chat:process.env.AI_CHAT_MODEL||'claude-sonnet-5-5'});
const FALLBACK={betas:['server-side-fallback-2026-07-01'],fallbacks:'default'};

export class AiError extends Error{} // any failure the caller should turn into a generic 502

// ---------- number guard ----------
const norm=s=>{s=s.replace(/,/g,'').replace(/^0+(?=\d)/,'');if(s.includes('.'))s=s.replace(/0+$/,'').replace(/\.$/,'');return s;};
const nums=s=>(String(s).match(/\d[\d,]*(?:\.\d+)?/g)??[]).map(x=>norm(x.replace(/,$/,'')));
// Returns the numbers in text that appear in none of the allowed sources (strings or JSON-able values).
// Dates like 2026-03 are skipped in the text; commas, $, % and trailing zeros do not matter.
export function unverifiedNumbers(text,allowedSources){
  const ok=new Set((Array.isArray(allowedSources)?allowedSources:[allowedSources]).flatMap(s=>nums(typeof s==='string'?s:JSON.stringify(s))));
  const bad=nums(String(text).replace(/\b\d{4}-\d{2}(?:-\d{2})?\b/g,' ')).filter(n=>!ok.has(n));
  return [...new Set(bad)];
}

// ---------- report ----------
const RANK={high:0,medium:1,low:2};
// Only code-computed fields go to the model. The flag's source row and related cells are left out on purpose.
export function buildReportInput({company,mode,summary,flags}){
  const sorted=[...flags].sort((a,b)=>(RANK[a.severity]??3)-(RANK[b.severity]??3)).slice(0,60);
  return {company,mode,summary,flags_included:sorted.length,flags_total:flags.length,
    flags:sorted.map(f=>({key:f.key,type:f.type,severity:f.severity,cell:f.cell,record_id:f.record_id,company_id:f.company_id,period:f.period,
      sheet_value:f.sheet_value,suggested_value:f.suggested_value,calculation:f.calculation,explanation:f.explanation,review_status:f.review_status??'open'}))};
}
const REPORT_SYSTEM=`You help a finance analyst decide what to review first in a budget-versus-actual spreadsheet.
You receive JSON computed by code: a summary and a list of flags the checker raised. Rank what an analyst should look at first, in plain English.
Rules: use only numbers that appear in the JSON, copied exactly; never calculate, round, convert or estimate. Cite flag keys exactly as given in flag_keys.
If flags is empty, say no mismatches were found and return no priorities. Never accuse anyone of fraud or intent; describe only what the checker found.
Say in caveats that you only read the checker's output. Keep each field short.`;
const REPORT_SCHEMA={type:'object',additionalProperties:false,required:['headline','priorities','caveats'],properties:{
  headline:{type:'string'},caveats:{type:'array',items:{type:'string'}},
  priorities:{type:'array',items:{type:'object',additionalProperties:false,required:['flag_keys','title','why','action'],properties:{
    flag_keys:{type:'array',items:{type:'string'}},title:{type:'string'},why:{type:'string'},action:{type:'string'}}}}}};

const textOf=r=>(r.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('');
function ensureDone(r){if(r.stop_reason==='refusal'||r.stop_reason==='max_tokens')throw new AiError(`Model stopped: ${r.stop_reason}`);}

export async function writeReport(input){
  const model=MODELS().report;
  let r;
  try{
    r=await client().beta.messages.create({model,max_tokens:6000,...FALLBACK,output_config:{effort:'medium',format:{type:'json_schema',schema:REPORT_SCHEMA}},
      system:REPORT_SYSTEM,messages:[{role:'user',content:JSON.stringify(input)}]});
  }catch(e){throw new AiError(e?.message||'request failed');}
  ensureDone(r);
  let raw;try{raw=JSON.parse(textOf(r));}catch{throw new AiError('Model did not return JSON');}
  return guardReport(raw,input,model);
}

// Drops any statement with a number the checker did not produce, and any cited flag key that does not exist.
export function guardReport(raw,input,model){
  if(!raw||typeof raw.headline!=='string'||!Array.isArray(raw.priorities)||!Array.isArray(raw.caveats))throw new AiError('Model JSON had the wrong shape');
  const keys=new Set(input.flags.map(f=>f.key)),removed=[];
  const clean=(label,text)=>{const bad=unverifiedNumbers(text,input);if(bad.length)removed.push({what:label,numbers:bad});return !bad.length;};
  const priorities=[];
  for(const p of raw.priorities){
    if(!p||typeof p.title!=='string'||typeof p.why!=='string')continue;
    const flag_keys=(Array.isArray(p.flag_keys)?p.flag_keys:[]).filter(k=>keys.has(k));
    if(!flag_keys.length){removed.push({what:p.title,numbers:[]});continue;}
    const action=typeof p.action==='string'?p.action:'';
    if(clean(p.title,`${p.title} ${p.why} ${action}`))priorities.push({flag_keys,title:p.title,why:p.why,action});
  }
  const headline=clean('headline',raw.headline)?raw.headline:'Review the flagged items listed below.';
  const caveats=raw.caveats.filter(c=>typeof c==='string'&&clean('caveat',c));
  return {headline,priorities,caveats,removed,model,at:new Date().toISOString()};
}

// ---------- chat tools (all run lib/ code on the signed-in user's rows) ----------
const METRICS=['revenue_usd','budget_revenue_usd','opex_usd','budget_opex_usd','revenue_variance_usd','opex_variance_usd','opening_cash_usd','cash_receipts_usd','cash_operating_payments_usd','capex_usd','financing_usd','closing_cash_usd'];
const BUDGET_OF={revenue_usd:'budget_revenue_usd',budget_revenue_usd:'budget_revenue_usd',opex_usd:'budget_opex_usd',budget_opex_usd:'budget_opex_usd'};
const ACTUAL_OF={budget_revenue_usd:'revenue_usd',revenue_usd:'revenue_usd',budget_opex_usd:'opex_usd',opex_usd:'opex_usd'};
const opt=t=>({type:[t,'null']});
const range={company_id:opt('string'),period_from:opt('string'),period_to:opt('string'),dataset_id:opt('string')};
const tool=(name,description,properties)=>({name,description,strict:true,input_schema:{type:'object',additionalProperties:false,required:Object.keys(properties),properties}});
export const TOOLS=[
  tool('list_datasets','List the team\'s datasets you can read: the company true copy and analyst uploads (dataset_id, name, kind, created_at, row_count). Call this first when the question mentions uploaded data.',{}),
  tool('get_rows','List rows (max 36) of one dataset with record_id and source_row. dataset_id null means the default dataset. Use null for no filter. Periods look like 2026-03.',range),
  tool('compute','Exact arithmetic on one dataset (dataset_id null = default); totals rows are excluded. sum: total of metric over the range. variance: actual minus budget for revenue_usd or opex_usd over the range, with percent. change: metric in period_to minus metric in period_from (single months).',
    {operation:{type:'string',enum:['sum','variance','change']},metric:{type:'string',enum:METRICS},...range}),
  tool('get_flags','List checker flags raised across uploads (max 30); dataset_id null = all uploads. status is open, confirmed or dismissed; null for any.',
    {status:opt('string'),type:opt('string'),company_id:opt('string'),dataset_id:opt('string')}),
  tool('run_checks','Run the internal checks (math, totals, cash roll-forward, duplicates, missing months) on one dataset now (dataset_id null = default). Returns up to 30 flags.',{company_id:opt('string'),dataset_id:opt('string')}),
];
const CHAT_SYSTEM=`You answer questions about one company's financial data for a finance analyst. You only know this one company; you cannot see or look up any other company, team or dataset, and you must say so if asked. The team has a company true copy and may have analyst uploads; the default dataset is named in each tool result. If the question mentions uploaded data or another file, call list_datasets and pass its dataset_id. Always say which dataset (by name) a number came from.
Use the tools for every fact and every calculation: call compute for any arithmetic. Answer only from tool results; copy numbers exactly as the tools return them.
Cite record_ids from tool results. If the tools cannot answer, say "I can't tell from this company's data." Be brief. You only recommend; you cannot change any data.`;

class ToolError extends Error{}
const PERIOD=/^\d{4}-(0[1-9]|1[0-2])$/;
const str=(v,name,re)=>{if(v==null)return null;if(typeof v!=='string'||v.length>60||(re&&!re.test(v)))throw new ToolError(`${name} is invalid.`);return v;};
const inRange=(rows,{company_id,period_from,period_to})=>{
  const c=str(company_id,'company_id'),a=str(period_from,'period_from',PERIOD),b=str(period_to,'period_to',PERIOD);
  return rows.filter(r=>r.period!=='TOTAL'&&(!c||r.company_id===c)&&(!a||r.period>=a)&&(!b||r.period<=b));
};
const cite=(rs,ds)=>rs.map(r=>({record_id:r.record_id,source_row:r.source_row??null,dataset_id:ds.id,dataset:ds.name}));
const pct=(num,den)=>den===0n?null:(Number(num*10000n/(den<0n?-den:den))/100).toFixed(2);
const label=d=>({dataset_id:d.id,dataset:d.name,kind:d.kind});

// ctx = {datasets:[{id,name,kind,created_at,rows}], default: id, flags:[{key,..., review_status, dataset_id}]}.
// Old shape {rows,flags} still works (one unnamed true copy). Returns {result, citations}; every result names its dataset.
export function runTool(name,input,ctx){
  if(!input||typeof input!=='object')throw new ToolError('Input must be an object.');
  if(!ctx.datasets)ctx={datasets:[{id:null,name:'company data',kind:'true copy',rows:ctx.rows}],default:null,flags:ctx.flags};
  const {datasets,flags}=ctx;
  if(name==='list_datasets')return {result:{default_dataset_id:ctx.default,datasets:datasets.map(d=>({dataset_id:d.id,name:d.name,kind:d.kind,created_at:d.created_at??null,row_count:d.rows.length}))},citations:[]};
  const sid=str(input.dataset_id,'dataset_id');
  const ds=datasets.find(d=>d.id===(sid??ctx.default));
  if(name!=='get_flags'&&!ds)throw new ToolError('Unknown dataset_id. Call list_datasets.');
  const rows=ds?.rows;
  if(name==='get_rows'){
    const hit=inRange(rows,input).slice(0,36);
    return {result:{...label(ds),rows:hit},citations:cite(hit,ds)};
  }
  if(name==='compute'){
    const {operation,metric}=input;
    if(!['sum','variance','change'].includes(operation))throw new ToolError('Unknown operation.');
    if(!METRICS.includes(metric))throw new ToolError('Unknown metric.');
    const hit=inRange(rows,input);
    if(!hit.length)throw new ToolError('No rows match that company and period range.');
    const base={...label(ds),operation,metric,company_id:input.company_id??null,rows_used:hit.length};
    const need=operation==='variance'?BUDGET_OF[metric]:metric;
    if(need&&hit.some(r=>r[need]==null||r[need]===''))throw new ToolError(`${need} is blank on some of these rows (budgets are optional), so this cannot be calculated. Say so to the analyst.`);
    try{
      if(operation==='sum')return {result:{...base,value:amount(hit.reduce((t,r)=>t+minor(r[metric],{signed:true}),0n))},citations:cite(hit,ds)};
      if(operation==='variance'){
        if(!BUDGET_OF[metric])throw new ToolError('variance works for revenue_usd or opex_usd.');
        const act=ACTUAL_OF[metric],bud=BUDGET_OF[metric],sum=c=>amount(hit.reduce((t,r)=>t+minor(r[c]),0n));
        const actual=sum(act),budget=sum(bud),v=variance(actual,budget);
        return {result:{...base,metric:act,actual,budget,difference:v.difference,percent:pct(minor(actual,{signed:true})-minor(budget,{signed:true}),minor(budget,{signed:true}))},citations:cite(hit,ds)};
      }
      const from=hit.filter(r=>r.period===input.period_from),to=hit.filter(r=>r.period===input.period_to);
      if(!input.period_from||!input.period_to||from.length!==1||to.length!==1)throw new ToolError('change needs one company and both period_from and period_to, each matching exactly one row.');
      const a=minor(from[0][metric],{signed:true}),b=minor(to[0][metric],{signed:true});
      return {result:{...base,from_value:amount(a),to_value:amount(b),difference:amount(b-a),percent:pct(b-a,a)},citations:cite([from[0],to[0]],ds)};
    }catch(e){
      if(e instanceof ToolError)throw e;
      throw new ToolError('Some rows in this dataset have values that are not valid numbers, so it cannot be calculated.'); // uploads can hold bad cells
    }
  }
  if(name==='get_flags'){
    const s=str(input.status,'status'),t=str(input.type,'type'),c=str(input.company_id,'company_id');
    if(sid&&!ds)throw new ToolError('Unknown dataset_id. Call list_datasets.');
    const nameOf=id=>datasets.find(d=>d.id===id)?.name??null;
    const hit=flags.filter(f=>(!s||f.review_status===s)&&(!t||f.type===t)&&(!c||f.company_id===c)&&(!sid||f.dataset_id===sid)).slice(0,30);
    return {result:{dataset:sid?ds.name:'all uploads',flags:hit.map(f=>({...slimFlag(f),dataset_id:f.dataset_id??null,dataset:nameOf(f.dataset_id)}))},
      citations:hit.filter(f=>f.record_id).map(f=>({record_id:f.record_id,source_row:f.source?.source_row??null,dataset_id:f.dataset_id??null,dataset:nameOf(f.dataset_id)}))};
  }
  if(name==='run_checks'){
    const c=str(input.company_id,'company_id');
    const mine=rows.filter(r=>!c||r.company_id===c).map(({source_row,...r})=>r);
    if(!mine.length)throw new ToolError('No rows for that company.');
    let found;try{found=checkSheet(mine,null);}catch(e){throw new ToolError(`Could not check: ${e.message}`);}
    return {result:{...label(ds),flag_count:found.length,flags:found.slice(0,30).map(slimFlag)},citations:found.filter(f=>f.record_id).slice(0,30).map(f=>({record_id:f.record_id,source_row:rows.find(r=>r.record_id===f.record_id)?.source_row??null,dataset_id:ds.id,dataset:ds.name}))};
  }
  throw new ToolError('Unknown tool.');
}
const slimFlag=f=>({key:f.key,type:f.type,severity:f.severity,cell:f.cell,record_id:f.record_id,company_id:f.company_id,period:f.period,sheet_value:f.sheet_value,suggested_value:f.suggested_value,calculation:f.calculation,explanation:f.explanation,review_status:f.review_status??'open'});

export const UNVERIFIED_ANSWER="I couldn't verify every number in my answer against the data. Try a narrower question.";
export const MAX_ROUNDS=4;

// messages: [{role,content:string}] already validated. Returns {answer, citations, tools, model, ai:true}.
export async function chat(messages,data){
  const model=MODELS().chat,convo=messages.map(m=>({role:m.role,content:m.content})),used=[],cites=new Map(),outputs=[];
  for(let round=0;round<MAX_ROUNDS;round++){
    let r;
    try{r=await client().beta.messages.create({model,max_tokens:1500,...FALLBACK,output_config:{effort:'low'},system:CHAT_SYSTEM,tools:TOOLS,messages:convo});}
    catch(e){throw new AiError(e?.message||'request failed');}
    ensureDone(r);
    if(r.stop_reason!=='tool_use'){
      const answer=textOf(r).trim();
      if(!answer)throw new AiError('Empty answer');
      const bad=unverifiedNumbers(answer,[...outputs,...messages.map(m=>m.content)]);
      return {answer:bad.length?UNVERIFIED_ANSWER:answer,citations:bad.length?[]:[...cites.values()],tools:used,model,ai:true};
    }
    convo.push({role:'assistant',content:r.content}); // unchanged, thinking blocks included
    const results=[];
    for(const b of r.content.filter(b=>b.type==='tool_use')){
      used.push({name:b.name,input:b.input});
      try{
        const out=runTool(b.name,b.input,data);
        outputs.push(out.result);out.citations.forEach(c=>c.record_id&&cites.set(`${c.dataset_id}:${c.record_id}`,c));
        results.push({type:'tool_result',tool_use_id:b.id,content:JSON.stringify(out.result)});
      }catch(e){
        if(!(e instanceof ToolError))throw e;
        results.push({type:'tool_result',tool_use_id:b.id,content:e.message,is_error:true});
      }
    }
    convo.push({role:'user',content:results});
  }
  throw new AiError('Too many tool rounds');
}

// ---------- rate limit ----------
// Seconds until midnight Eastern, for the Retry-After header (the limit counts per ET day).
export function secondsToMidnightET(now=new Date()){
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'numeric',second:'numeric',hourCycle:'h23'}).formatToParts(now).map(x=>[x.type,x.value]));
  return 86400-(+p.hour*3600+ +p.minute*60+ +p.second);
}
export const LIMITS={report:10,chat:40};
