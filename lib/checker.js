// Spreadsheet checker: recomputes an analyst's budget-vs-actual sheet in exact BigInt cents and returns
// flags. It only recommends; it never edits the sheet or the source data.
import fs from 'node:fs';
import {parseCSV} from './csv.js';
import {minor,amount,divideRound} from './finance.js';

export const SOURCE_FILE='data/monthly_financials.csv';
export const SHEET_COLUMNS=['record_id','company_id','period','currency','revenue_usd','budget_revenue_usd','revenue_variance_usd','revenue_variance_pct','opex_usd','budget_opex_usd','opex_variance_usd','opex_variance_pct','opening_cash_usd','cash_receipts_usd','cash_operating_payments_usd','capex_usd','financing_usd','closing_cash_usd'];
const VARIANCE=['revenue_variance_usd','opex_variance_usd'],PCT=['revenue_variance_pct','opex_variance_pct'];
const CASH=['opening_cash_usd','cash_receipts_usd','cash_operating_payments_usd','capex_usd','financing_usd','closing_cash_usd'];
const MONEY=['revenue_usd','budget_revenue_usd','opex_usd','budget_opex_usd',...VARIANCE,...CASH];
const INPUTS=['revenue_usd','budget_revenue_usd','opex_usd','budget_opex_usd','cash_receipts_usd','cash_operating_payments_usd','capex_usd','financing_usd'];
const TOTAL_COLS=['revenue_usd','budget_revenue_usd','opex_usd','budget_opex_usd'];
const PAIRS=[['revenue','revenue_usd','budget_revenue_usd'],['opex','opex_usd','budget_opex_usd']];
const SEVERITY={wrong_variance:'medium',wrong_percent:'low',pct_on_zero_budget:'low'};

export class ValidationError extends Error{
  constructor(message,details){super(message);this.name='ValidationError';this.details=details;}
}

export function loadSource(rows=parseCSV(fs.readFileSync(new URL('../data/monthly_financials.csv',import.meta.url),'utf8')),{file=SOURCE_FILE}={}){
  // source_row is the CSV line number (header = 1)
  const byId=new Map(rows.map((row,i)=>[row.record_id,{row,source_row:i+2}]));
  return {rows,byId,file,companies:new Set(rows.map(r=>r.company_id))};
}

const fmt=c=>{const a=amount(c),[w,f]=a.replace('-','').split('.');return (a.startsWith('-')?'-':'')+w.replace(/\B(?=(\d{3})+(?!\d))/g,',')+'.'+f;};
// month index across years: 2026-12 -> 2027-01 is +1
const monthIndex=p=>Number(p.slice(0,4))*12+Number(p.slice(5));
const parsePct=s=>s===''?null:minor(s.replace(/%$/,''),{signed:true});
const letter=i=>i<26?String.fromCharCode(65+i):String.fromCharCode(64+Math.floor(i/26))+String.fromCharCode(65+i%26);

export function validateSheet(rows,source=loadSource()){
  // source === null: internal-only mode (no true copy to compare with)
  const problems=[];
  const add=(row,column,message)=>{if(problems.length<20)problems.push({row,column,message});};
  const fail=()=>{const [p,...rest]=problems;
    const where=p.row?`Row ${p.row}${p.column?`, column ${p.column}`:''}: `:'';
    throw new ValidationError(`${where}${p.message}${rest.length?` (and ${rest.length}${problems.length>=20?'+':''} more problem${rest.length>1?'s':''})`:''}`,problems);};
  if(!Array.isArray(rows)||!rows.length){add(null,null,'The sheet has no rows.');fail();}
  const optional=[...VARIANCE,...PCT],missing=SHEET_COLUMNS.filter(c=>!(c in rows[0])&&!(source===null&&optional.includes(c)));
  if(missing.length){add(1,null,`Missing column${missing.length>1?'s':''}: ${missing.join(', ')}.`);fail();}
  const periods=source?[...new Set(source.rows.map(r=>r.period))].sort():[];
  rows.forEach((r,i)=>{
    const line=i+2,total=r.period==='TOTAL';
    if(r.currency!=='USD')add(line,'currency',`Currency "${r.currency}" is not supported; use USD.`);
    if(source&&!source.companies.has(r.company_id))add(line,'company_id',`Company "${r.company_id}" is not in the source data.`);
    if(!r.record_id)add(line,'record_id','Record id is blank.');
    if(total){if(r.record_id!==`TOTAL-${r.company_id}`)add(line,'record_id',`A totals row must have record_id TOTAL-${r.company_id}.`);}
    else if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(r.period)||(source&&!periods.includes(r.period)))add(line,'period',source?`Period "${r.period}" is not a month from ${periods[0]} to ${periods.at(-1)} (or TOTAL).`:`Period "${r.period}" is not a month like 2026-12 (or TOTAL).`);
    for(const c of MONEY){
      if(total&&CASH.includes(c))continue;
      if(!(c in r))continue; // only optional columns can be absent (checked above)
      const ok=(VARIANCE.includes(c)?/^-?\d+(\.\d{1,2})?$/:/^\d+(\.\d{1,2})?$/).test(r[c]);
      if(!ok)add(line,c,`"${r[c]}" is not a plain amount like 1234.56 (no commas, symbols or spaces).`);
    }
    for(const c of PCT)if(c in r&&r[c]!==''&&!/^-?\d+(\.\d{1,2})?%?$/.test(r[c]))add(line,c,`"${r[c]}" is not a percentage like 3.58.`);
  });
  if(problems.length)fail();
  return true;
}

export function checkSheet(rows,source=loadSource()){
  // source === null: internal-only mode; skips every comparison with a true copy
  validateSheet(rows,source);
  const header=Object.keys(rows[0]),flags=new Map();
  const entries=rows.map((r,i)=>({r,line:i+2}));
  const cellOf=(col,line)=>letter(header.indexOf(col))+line;
  const srcOf=id=>{const s=source?.byId.get(id);return {file:source?source.file:null,record_id:s?id:null,source_row:s?.source_row??null,row:s?.row??null};};
  const rel=(label,e,column)=>({label,cell:cellOf(column,e.line),column,record_id:e.r.record_id,sheet_row:e.line,sheet_value:e.r[column],source_value:source?.byId.get(e.r.record_id)?.row[column]??null});
  const put=f=>{if(!flags.has(f.key))flags.set(f.key,f);};
  const cellFlag=(type,e,column,suggested,calculation,explanation,related=[])=>put({
    key:`${e.r.record_id}:${column}`,type,severity:SEVERITY[type]??'high',cell:cellOf(column,e.line),column,sheet_row:e.line,
    record_id:e.r.record_id,company_id:e.r.company_id,period:e.r.period,sheet_value:e.r[column],suggested_value:suggested,
    calculation,explanation,source:srcOf(e.r.record_id),related});
  const rowFlag=(type,key,e,record_id,sheet_row,explanation,related=[],period=e?.r.period,company=e?.r.company_id)=>put({
    key,type,severity:'high',cell:`row ${sheet_row}`,column:null,sheet_row,record_id,company_id:company,period,sheet_value:null,
    suggested_value:null,calculation:null,explanation,source:srcOf(record_id),related});

  // Row-level: duplicates, extras, kept rows
  const first=new Map(),seenPeriod=new Map(),detail=[],totals=[];
  for(const e of entries){
    const id=e.r.record_id;
    if(first.has(id)){rowFlag('duplicate_row',`${id}:duplicate:${e.line}`,e,id,e.line,`Record ${id} appears more than once; row ${first.get(id).line} is the first.`,[rel('First occurrence',first.get(id),'record_id')]);continue;}
    first.set(id,e);
    if(e.r.period==='TOTAL'){totals.push(e);continue;}
    if(!source){
      const k=`${e.r.company_id}|${e.r.period}`;
      if(seenPeriod.has(k)){rowFlag('duplicate_row',`${id}:duplicate:${e.line}`,e,id,e.line,`${e.r.company_id} ${e.r.period} appears more than once; row ${seenPeriod.get(k).line} is the first.`,[rel('First occurrence',seenPeriod.get(k),'record_id')]);continue;}
      seenPeriod.set(k,e);detail.push(e);continue;
    }
    if(!source.byId.has(id)){rowFlag('extra_row',`${id}:extra`,e,id,e.line,`Record ${id} is not in the source data, so it is not counted in checks.`);continue;}
    detail.push(e);
  }
  const byCo=new Map();for(const e of detail){const co=source?source.byId.get(e.r.record_id).row.company_id:e.r.company_id;(byCo.get(co)??byCo.set(co,[]).get(co)).push(e);}
  for(const [id,s] of source?source.byId:[]){
    if(first.has(id))continue;
    const mates=(byCo.get(s.row.company_id)??[]).slice().sort((a,b)=>source.byId.get(a.r.record_id).row.period.localeCompare(source.byId.get(b.r.record_id).row.period));
    const prev=mates.filter(m=>source.byId.get(m.r.record_id).row.period<s.row.period).at(-1)??mates[0];
    rowFlag('missing_row',`${id}:missing`,undefined,id,prev?.line??2,`The sheet has no row for ${s.row.company_id} ${s.row.period}; the source has it at row ${s.source_row}.`,prev?[rel('Nearest row in sheet',prev,'record_id')]:[],s.row.period,s.row.company_id);
  }

  // Internal mode: a company's months should be consecutive; report each gap between its first and last month
  if(!source)for(const [co,list] of byCo){
    const have=new Map(list.map(e=>[monthIndex(e.r.period),e])),idx=[...have.keys()].sort((a,b)=>a-b);
    for(let m=idx[0];m<=idx.at(-1);m++){
      if(have.has(m))continue;
      let p=m-1;while(!have.has(p))p--;
      const period=`${Math.floor((m-1)/12)}-${String((m-1)%12+1).padStart(2,'0')}`;
      rowFlag('missing_row',`${co}:${period}:missing`,undefined,null,have.get(p).line,`The sheet has no row for ${co} ${period}, between ${have.get(p).r.period} and the next month present.`,[rel('Nearest row before the gap',have.get(p),'record_id')],period,co);
    }
  }

  // Inputs vs source
  for(const e of source?detail:[]){
    const s=source.byId.get(e.r.record_id);
    for(const c of ['company_id','period'])if(e.r[c]!==s.row[c])
      cellFlag(c==='period'?'wrong_period':'typed_over',e,c,s.row[c],`${SOURCE_FILE} row ${s.source_row}, ${c} = ${s.row[c]}`,`${e.r[c]} does not match the source ${c} ${s.row[c]} for record ${e.r.record_id}.`);
    const cols=s.row.period==='2026-01'?[...INPUTS,'opening_cash_usd']:INPUTS;
    for(const c of cols){
      const sv=minor(e.r[c]);if(sv===minor(s.row[c]))continue;
      const other=source.rows.find(x=>x.company_id===s.row.company_id&&x.record_id!==s.row.record_id&&minor(x[c])===sv);
      cellFlag(other?'wrong_period':'typed_over',e,c,s.row[c],`${SOURCE_FILE} row ${s.source_row}, ${c} = ${fmt(minor(s.row[c]))}`,
        other?`${e.r[c]} is the ${c} of ${other.period}, not ${s.row.period}. The source shows ${s.row[c]} for this month.`:`${e.r[c]} does not match the source value ${s.row[c]}.`);
    }
  }

  // Derived cells use the sheet's own inputs
  for(const e of [...detail,...totals])for(const [n,a,b] of PAIRS){
    const av=minor(e.r[a]),bv=minor(e.r[b]),exp=av-bv,vc=`${n}_variance_usd`,pc=`${n}_variance_pct`;
    const inputs=[rel('Actual',e,a),rel('Budget',e,b)];
    const got=vc in e.r?minor(e.r[vc],{signed:true}):exp;
    if(got!==exp){
      const flipped=got===-exp&&exp!==0n;
      cellFlag(flipped?'sign_flipped':'wrong_variance',e,vc,amount(exp),`${fmt(av)} - ${fmt(bv)} = ${fmt(exp)}`,
        flipped?`Shown as ${e.r[vc]}, but the sign is reversed: actual minus budget is ${amount(exp)}.`:`Variance should be actual minus budget = ${amount(exp)}.`,inputs);
    }
    if(!(pc in e.r)){/* optional column absent */}
    else if(bv===0n){
      if(e.r[pc]!=='')cellFlag('pct_on_zero_budget',e,pc,'',`Budget is 0.00, so a percentage is undefined.`,'A percentage is shown but the budget is zero; leave it blank.',inputs);
    }else{
      const pe=divideRound(exp*10000n,bv<0n?-bv:bv),pg=parsePct(e.r[pc]);
      if(pg!==pe)cellFlag('wrong_percent',e,pc,amount(pe),`${fmt(exp)} / |${fmt(bv)}| x 100 = ${amount(pe)}%`,`Percent should be variance divided by the absolute budget, ${amount(pe)}%.`,inputs);
    }
  }

  // Totals = sum of the company's detail rows
  for(const t of totals){
    const rowsOf=byCo.get(t.r.company_id)??[];
    for(const c of TOTAL_COLS){
      const exp=rowsOf.reduce((s,e)=>s+minor(e.r[c]),0n),diff=minor(t.r[c])-exp;
      if(diff===0n)continue;
      const hit=rowsOf.find(e=>minor(e.r[c])===(diff<0n?-diff:diff));
      const type=!hit?'wrong_total':diff<0n?'total_skips_row':'total_double_counts';
      cellFlag(type,t,c,amount(exp),`Sum of ${rowsOf.length} rows = ${fmt(exp)}`,
        type==='wrong_total'?`The total differs from the sum of its rows by ${fmt(diff)}.`:
        type==='total_skips_row'?`The total is short by ${fmt(-diff)}, which equals the ${hit.r.period} row, so that row looks skipped.`:
        `The total is over by ${fmt(diff)}, which equals the ${hit.r.period} row, so that row looks counted twice.`,hit?[rel(`${hit.r.period} row`,hit,c)]:[]);
    }
  }

  // Cash roll-forward
  for(const list of byCo.values()){
    const month=new Map(list.map(e=>[monthIndex(source?source.byId.get(e.r.record_id).row.period:e.r.period),e]));
    for(const m of month.keys()){
      const a=month.get(m),b=month.get(m+1);if(!b)continue;
      if(minor(b.r.opening_cash_usd)!==minor(a.r.closing_cash_usd))
        cellFlag('rollforward_break',b,'opening_cash_usd',a.r.closing_cash_usd,`Opening ${b.r.period} should equal closing ${a.r.period} = ${fmt(minor(a.r.closing_cash_usd))}`,
          `Opening cash ${b.r.opening_cash_usd} does not equal the previous month's closing cash ${a.r.closing_cash_usd}.`,
          [rel(`Prior month closing cash (${a.r.period})`,a,'closing_cash_usd'),rel(`This month closing cash (${b.r.period})`,b,'closing_cash_usd')]);
    }
    for(const e of month.values()){
      if(flags.has(`${e.r.record_id}:opening_cash_usd`))continue;
      const [o,r,p,x,f]=['opening_cash_usd','cash_receipts_usd','cash_operating_payments_usd','capex_usd','financing_usd'].map(c=>minor(e.r[c]));
      const exp=o+r-p-x+f;
      if(minor(e.r.closing_cash_usd)!==exp)
        cellFlag('rollforward_formula',e,'closing_cash_usd',amount(exp),`${fmt(o)} + ${fmt(r)} - ${fmt(p)} - ${fmt(x)} + ${fmt(f)} = ${fmt(exp)}`,
          `Closing cash should be opening + receipts - operating payments - capex + financing = ${amount(exp)}.`,
          [['Opening cash','opening_cash_usd'],['Receipts','cash_receipts_usd'],['Operating payments','cash_operating_payments_usd'],['Capex','capex_usd'],['Financing','financing_usd']].map(([l,c])=>rel(l,e,c)));
    }
  }

  return [...flags.values()].sort((a,b)=>a.sheet_row-b.sheet_row||header.indexOf(a.column)-header.indexOf(b.column));
}
