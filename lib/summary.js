// Pure roll-up of a company dataset and its flags. Exact BigInt cents; no I/O, no AI.
import {minor,amount,variance} from './finance.js';

const COLS=['revenue_usd','budget_revenue_usd','opex_usd','budget_opex_usd'];
const count=(list,key)=>list.reduce((o,x)=>{const k=key(x);o[k]=(o[k]??0)+1;return o;},{});

export function summarize(rows,flags=[]){
  const seen=new Set(),byCo=new Map();
  for(const r of rows){
    if(r.period==='TOTAL'||seen.has(r.record_id))continue;
    seen.add(r.record_id);(byCo.get(r.company_id)??byCo.set(r.company_id,[]).get(r.company_id)).push(r);
  }
  const companies=[...byCo].map(([company_id,list])=>{
    list.sort((a,b)=>a.period.localeCompare(b.period));
    // A budget total (and its variance) only exists when every month has a budget; otherwise it is null, never a partial sum.
    const sum=Object.fromEntries(COLS.map(c=>[c,list.some(r=>r[c]==null||r[c]==='')?null:list.reduce((t,r)=>t+minor(r[c]),0n)]));
    const last=list.at(-1),diff=(a,b)=>sum[a]==null||sum[b]==null?null:variance(amount(sum[a]),amount(sum[b])).difference;
    return {company_id,months:list.length,first_period:list[0].period,latest_period:last.period,
      ...Object.fromEntries(COLS.map(c=>[c,sum[c]==null?null:amount(sum[c])])),
      revenue_variance_usd:diff('revenue_usd','budget_revenue_usd'),
      opex_variance_usd:diff('opex_usd','budget_opex_usd'),
      closing_cash_usd:last.closing_cash_usd};
  }).sort((a,b)=>a.company_id.localeCompare(b.company_id));
  return {companies,latest_period:companies.map(c=>c.latest_period).sort().at(-1)??null,
    flags:{total:flags.length,by_type:count(flags,f=>f.type),by_severity:count(flags,f=>f.severity),by_status:count(flags,f=>f.status??'open')}};
}
