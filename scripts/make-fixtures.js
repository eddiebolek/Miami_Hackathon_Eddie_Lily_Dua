// SYNTHETIC test data. Builds the fictional analyst sheets and the planted-error answer key from
// data/monthly_financials.csv. Run: node scripts/make-fixtures.js (output is deterministic).
// The answer key is compared only by tests/checker.test.js; it is never given to any AI.
import fs from 'node:fs';import {pathToFileURL,fileURLToPath} from 'node:url';
import {parseCSV,toCSV} from '../lib/csv.js';import {minor,amount,divideRound} from '../lib/finance.js';
import {SHEET_COLUMNS} from '../lib/checker.js';

const pct=(v,b)=>b===0n?'':amount(divideRound(v*10000n,b<0n?-b:b));
const CASH=['opening_cash_usd','cash_receipts_usd','cash_operating_payments_usd','capex_usd','financing_usd','closing_cash_usd'];
const PAIRS=[['revenue','revenue_usd','budget_revenue_usd'],['opex','opex_usd','budget_opex_usd']];

// opts: inputs = overrides applied before variance/% are computed (like a cell the formulas read);
// cells = overrides applied after (typed over a formula or a cash cell); drop = record ids left out;
// totalAdjust = cents added to a totals-row cell before its variance/% are computed.
export function buildSheetRows(sourceRows,{inputs={},cells={},drop=[],totalAdjust={}}={}){
  const out=[];const companies=[...new Set(sourceRows.map(r=>r.company_id))];
  const derive=(row,vals)=>{for(const [n,a,b] of PAIRS){const v=vals[a]-vals[b];row[`${n}_variance_usd`]=amount(v);row[`${n}_variance_pct`]=pct(v,vals[b]);}};
  for(const co of companies){
    const sums={};
    for(const r of sourceRows.filter(x=>x.company_id===co&&!drop.includes(x.record_id))){
      const row={record_id:r.record_id,company_id:co,period:r.period,currency:'USD'};
      const vals={};
      for(const c of ['revenue_usd','budget_revenue_usd','opex_usd','budget_opex_usd']){row[c]=inputs[r.record_id]?.[c]??r[c];vals[c]=minor(row[c]);sums[c]=(sums[c]??0n)+vals[c];}
      derive(row,vals);for(const c of CASH)row[c]=r[c];
      Object.assign(row,cells[r.record_id]);out.push(Object.fromEntries(SHEET_COLUMNS.map(c=>[c,row[c]])));
    }
    const id=`TOTAL-${co}`,tot={record_id:id,company_id:co,period:'TOTAL',currency:'USD'},vals={};
    for(const c of Object.keys(sums)){vals[c]=sums[c]+(totalAdjust[id]?.[c]??0n);tot[c]=amount(vals[c]);}
    derive(tot,vals);for(const c of CASH)tot[c]='';Object.assign(tot,cells[id]);
    out.push(Object.fromEntries(SHEET_COLUMNS.map(c=>[c,tot[c]])));
  }
  return out;
}

const merge=(a,b)=>{for(const [k,v] of Object.entries(b))a[k]=(v&&typeof v==='object'&&!Array.isArray(v)&&typeof v!=='bigint')?merge(a[k]??{},v):v;return a;};

// Ten planted errors; each yields exactly one flag. Row-level plants first so totals follow the kept rows.
export function plants(S){
  const v=(id,c)=>S.find(r=>r.record_id===id)[c];
  return [
    {type:'missing_row',id:'FIN-2-10',column:null,opts:{drop:['FIN-2-10']}},
    {type:'typed_over',id:'FIN-1-09',column:'revenue_usd',opts:{inputs:{'FIN-1-09':{revenue_usd:'91234.56'}}}},
    {type:'wrong_period',id:'FIN-3-02',column:'revenue_usd',opts:{inputs:{'FIN-3-02':{revenue_usd:v('FIN-3-08','revenue_usd')}}}},
    {type:'wrong_variance',id:'FIN-1-03',column:'revenue_variance_usd',opts:{cells:{'FIN-1-03':{revenue_variance_usd:'3500.00'}}}},
    {type:'sign_flipped',id:'FIN-2-04',column:'opex_variance_usd',opts:{cells:{'FIN-2-04':{opex_variance_usd:'-2000.00'}}}},
    {type:'wrong_percent',id:'FIN-3-05',column:'opex_variance_pct',opts:{cells:{'FIN-3-05':{opex_variance_pct:'3.00'}}}},
    {type:'total_skips_row',id:'TOTAL-CO-001',column:'revenue_usd',opts:{totalAdjust:{'TOTAL-CO-001':{revenue_usd:-minor(v('FIN-1-07','revenue_usd'))}}}},
    {type:'total_double_counts',id:'TOTAL-CO-002',column:'revenue_usd',opts:{totalAdjust:{'TOTAL-CO-002':{revenue_usd:minor(v('FIN-2-02','revenue_usd'))}}}},
    {type:'rollforward_break',id:'FIN-2-06',column:'opening_cash_usd',opts:{cells:{'FIN-2-06':{opening_cash_usd:'1234567.00'}}}},
    {type:'rollforward_formula',id:'FIN-3-12',column:'closing_cash_usd',opts:{cells:{'FIN-3-12':{closing_cash_usd:'1000000.00'}}}},
  ];
}

export function planFixtures(sourceRows){
  const list=plants(sourceRows),opts={};for(const p of list)merge(opts,p.opts);
  const errors=buildSheetRows(sourceRows,opts);
  const line=id=>errors.findIndex(r=>r.record_id===id)+2;
  const key=list.map(p=>{
    let sheet_row;
    if(p.type==='missing_row'){ // same rule as the checker: the row just before the gap in that company, else just after
      const m=sourceRows.find(r=>r.record_id===p.id),prev=errors.filter(r=>r.company_id===m.company_id&&r.period<m.period&&r.period!=='TOTAL').at(-1);
      sheet_row=prev?line(prev.record_id):line(errors.find(r=>r.company_id===m.company_id).record_id);
    }else sheet_row=line(p.id);
    return {sheet_row,column:p.column,type:p.type};
  }).sort((a,b)=>a.sheet_row-b.sheet_row||String(a.column).localeCompare(String(b.column)));
  return {
    'analyst-sheet-clean.csv':toCSV(buildSheetRows(sourceRows)),
    'analyst-sheet-errors.csv':toCSV(errors),
    'planted-errors.json':JSON.stringify({synthetic:true,note:'SYNTHETIC answer key for analyst-sheet-errors.csv. sheet_row is the CSV line number (header = 1). A missing_row has column null and points at the row just before the gap. Used only by tests.',errors:key},null,2)+'\n',
  };
}

// One synthetic 2027-01 row per company, in the source file's columns, continuing each company's 2026 trend.
// opening cash = December closing, so it passes internal checks together with data/monthly_financials.csv.
export function newMonthRows(sourceRows){
  return [...new Set(sourceRows.map(r=>r.company_id))].map((co,i)=>{
    const mine=sourceRows.filter(r=>r.company_id===co),dec=mine.at(-1),nov=mine.at(-2),step=c=>amount(minor(dec[c])+minor(dec[c])-minor(nov[c]));
    const revenue=step('revenue_usd'),cogs=amount(divideRound(minor(revenue)*35n,100n)),opex=dec.opex_usd;
    const closing=minor(dec.closing_cash_usd)+minor(revenue)-(minor(cogs)+minor(opex))-minor(dec.capex_usd)+minor(dec.financing_usd);
    return {...dec,record_id:`FIN-${i+1}-13`,period:'2027-01',revenue_usd:revenue,cogs_usd:cogs,opex_usd:opex,budget_revenue_usd:step('budget_revenue_usd'),
      budget_opex_usd:dec.budget_opex_usd,opening_cash_usd:dec.closing_cash_usd,cash_receipts_usd:revenue,cash_operating_payments_usd:amount(minor(cogs)+minor(opex)),
      closing_cash_usd:amount(closing)};
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const rows=parseCSV(fs.readFileSync(new URL('../data/monthly_financials.csv',import.meta.url),'utf8'));
  const dir=fileURLToPath(new URL('../data/synthetic/',import.meta.url));fs.mkdirSync(dir,{recursive:true});
  for(const [name,text] of Object.entries(planFixtures(rows)))fs.writeFileSync(dir+name,text);
  fs.writeFileSync(dir+'new-month-2027-01.csv',toCSV(newMonthRows(rows)));
}
