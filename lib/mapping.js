// Column matching for uploads with their own headers and number formats. Code parses every value; nothing here guesses a number.
import {SHEET_COLUMNS,ValidationError} from './checker.js';

const SYN={
  record_id:'id recordid rowid recordnumber',
  company_id:'company companyid entity entityid entityname companycode client',
  period:'period month date reportingperiod monthending periodending fiscalperiod',
  currency:'currency ccy currencycode',
  revenue_usd:'revenue sales netsales actualrevenue actualsales revenueactual salesactual totalrevenue',
  budget_revenue_usd:'budgetrevenue revenuebudget budgetedrevenue budgetsales salesbudget plannedrevenue',
  revenue_variance_usd:'revenuevariance salesvariance revenuevar revenuevariancedollar',
  revenue_variance_pct:'revenuevariancepct revenuevariancepercent revenuevarpct salesvariancepct salesvarpct',
  opex_usd:'opex operatingexpenses operatingexpense actualopex opexactual operatingexpensesactual',
  budget_opex_usd:'budgetopex opexbudget budgetedopex budgetoperatingexpenses operatingexpensesbudget',
  opex_variance_usd:'opexvariance operatingexpensesvariance opexvar opexvariancedollar',
  opex_variance_pct:'opexvariancepct opexvariancepercent opexvarpct operatingexpensesvariancepct',
  opening_cash_usd:'openingcash beginningcash cashbeginning cashopening startingcash openingbalance beginningbalance',
  cash_receipts_usd:'cashreceipts receipts cashin cashcollected collections',
  cash_operating_payments_usd:'cashoperatingpayments operatingpayments cashpayments payments cashout',
  capex_usd:'capex capitalexpenditures capitalexpenditure capitalspend',
  financing_usd:'financing financingcashflow financingactivities netfinancing',
  closing_cash_usd:'closingcash endingcash cashending cashclosing endingbalance closingbalance endcash'
};
const LOOKUP=new Map(Object.entries(SYN).flatMap(([col,s])=>s.split(' ').map(k=>[k,col])).concat(SHEET_COLUMNS.map(c=>[norm(c),c])));
function norm(s){return String(s).toLowerCase().replace(/%/g,'pct').replace(/[^a-z0-9]/g,'');}

const PCT=['revenue_variance_pct','opex_variance_pct'],VAR=['revenue_variance_usd','opex_variance_usd'];
const CASH=['opening_cash_usd','cash_receipts_usd','cash_operating_payments_usd','capex_usd','financing_usd','closing_cash_usd'];
const MONEY=SHEET_COLUMNS.filter(c=>c.endsWith('_usd')&&c!=='currency');
// The person must match these; currency and record_id can be filled in, variance columns are optional (needed only to compare with saved data).
export const REQUIRED=SHEET_COLUMNS.filter(c=>!['currency','record_id',...VAR,...PCT].includes(c));

export function suggestMapping(headers){
  const mapping={},used=new Set();
  for(const h of headers){
    let n=norm(h),col=LOOKUP.get(n)??(n.endsWith('usd')?LOOKUP.get(n.slice(0,-3)):undefined);
    if(col&&!used.has(col)){mapping[h]=col;used.add(col);}else mapping[h]=null; // a second header for the same column stays unmatched
  }
  return {mapping,unmatched:SHEET_COLUMNS.filter(c=>!used.has(c))};
}

const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const ym=(y,m)=>m>=1&&m<=12?`${y}-${String(m).padStart(2,'0')}`:null;
export function parsePeriod(v){
  const s=String(v).trim();let m;
  if(s.toUpperCase()==='TOTAL')return 'TOTAL';
  if((m=/^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?$/.exec(s)))return ym(m[1],+m[2]);
  if((m=/^(\d{1,2})[-/](\d{4})$/.exec(s)))return ym(m[2],+m[1]);
  if((m=/^([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s))){const i=MONTHS.indexOf(m[1].slice(0,3).toLowerCase());return i<0?null:ym(m[2],i+1);}
  return null; // includes 3/1/2026: day-first or month-first cannot be told apart
}

// Returns the plain amount string ("12000.50", "-500.00") or {error}. Never rounds and never guesses.
export function parseAmount(v){
  let s=String(v).trim();
  if(s==='')return '';
  const neg=/^\(.*\)$/.test(s);if(neg)s=s.slice(1,-1).trim();
  s=s.replace(/^\$\s*|\s*\$$/g,'').replace(/^-\s*\$/,'-').replace(/\s*USD$/i,'');
  let sign=neg?'-':'';
  if(s.startsWith('-')){if(neg)return {error:`"${v}" has two minus signs.`};sign='-';s=s.slice(1);}
  if(/[a-z]/i.test(s))return {error:`"${v}" is not a full number. Write out the whole amount (for example 1200 instead of 1.2k).`};
  const m=/^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/.exec(s);
  if(!m)return {error:`"${v}" is not a number the checker can read (use digits, optional commas and a decimal point).`};
  if((m[2]??'').length>2)return {error:`"${v}" has more than 2 decimal places.`};
  const out=m[1].replace(/,/g,'')+'.'+(m[2]??'').padEnd(2,'0');
  return sign&&+out!==0?'-'+out:out;
}

// mapping: {columns:{theirHeader: ourColumn}, assume_usd?: boolean}. Returns rows with our column names and plain values.
// Throws ValidationError (details: [{row,column,message}]) for anything it cannot read exactly.
export function applyMapping(rows,mapping){
  const problems=[];
  const add=(row,column,message)=>{if(problems.length<20)problems.push({row,column,message});};
  const finish=()=>{const [p]=problems;throw new ValidationError(`${p.row?`Row ${p.row}${p.column?`, column ${p.column}`:''}: `:''}${p.message}${problems.length>1?` (and ${problems.length-1}${problems.length>=20?'+':''} more)`:''}`,problems);};
  const cols=mapping&&typeof mapping==='object'&&mapping.columns&&typeof mapping.columns==='object'?mapping.columns:null;
  if(!cols){add(null,null,'The column matching is missing.');finish();}
  if(!Array.isArray(rows)||!rows.length){add(null,null,'The sheet has no rows.');finish();}
  const targets=new Map(); // our column -> their header
  for(const [theirs,ours] of Object.entries(cols)){
    if(ours==null||ours==='')continue;
    if(!SHEET_COLUMNS.includes(ours))add(1,theirs,`"${ours}" is not one of our columns.`);
    else if(!(theirs in rows[0]))add(1,theirs,`The file has no column "${theirs}".`);
    else if(targets.has(ours))add(1,theirs,`"${targets.get(ours)}" and "${theirs}" are both matched to ${ours}. Match each of our columns once.`);
    else targets.set(ours,theirs);
  }
  const lacking=REQUIRED.filter(c=>!targets.has(c));
  if(lacking.length)add(1,null,`Match these columns first: ${lacking.join(', ')}.`);
  if(!targets.has('currency')&&mapping.assume_usd!==true)add(1,null,'The file has no currency column. Confirm that the file is in US dollars.');
  if(problems.length)finish();
  const out=rows.map((r,i)=>{
    const line=i+2,o={};
    for(const c of SHEET_COLUMNS){
      if(!targets.has(c))continue;
      const raw=r[targets.get(c)]??'';let v=raw.trim?raw.trim():raw;
      if(c==='period'){const p=parsePeriod(v);if(p===null)add(line,c,`"${raw}" is not a month the checker can read. Use 2026-03, 03/2026, Mar 2026 or March 2026.`);v=p??v;}
      else if(c==='currency')v=v.toUpperCase();
      else if(MONEY.includes(c)||PCT.includes(c)){
        const total=r[targets.get('period')]?.trim().toUpperCase()==='TOTAL';
        const a=parseAmount(PCT.includes(c)?v.replace(/%$/,''):v);
        if(a.error){if(!(total&&CASH.includes(c)))add(line,c,a.error);}else v=a;
      }
      o[c]=v;
    }
    if(!targets.has('currency'))o.currency='USD';
    if(!targets.has('record_id')||o.record_id==='')o.record_id=o.period==='TOTAL'?`TOTAL-${o.company_id}`:`${o.company_id}-${o.period}`;
    return {record_id:o.record_id,...Object.fromEntries(SHEET_COLUMNS.filter(c=>c in o&&c!=='record_id').map(c=>[c,o[c]]))};
  });
  if(problems.length)finish();
  return out;
}
