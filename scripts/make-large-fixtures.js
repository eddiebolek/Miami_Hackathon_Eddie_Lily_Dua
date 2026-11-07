// SYNTHETIC large demo: 100 fictional business units x 24 months (2,400 source rows) plus an analyst
// sheet with 25 planted errors and its answer key. Run: node scripts/make-large-fixtures.js (deterministic).
// The answer key is only compared by tests; it is never given to any AI.
import fs from 'node:fs';import {pathToFileURL,fileURLToPath} from 'node:url';
import {toCSV} from '../lib/csv.js';import {minor,amount,divideRound} from '../lib/finance.js';
import {planFixtures} from './make-fixtures.js';

const UNITS=100,MONTHS=24,START=2025;
const id=(u,m)=>`R-${String(u).padStart(3,'0')}-${String(m).padStart(2,'0')}`;
const co=u=>`BU-${String(u).padStart(3,'0')}`;
const period=m=>`${START+Math.floor((m-1)/12)}-${String((m-1)%12+1).padStart(2,'0')}`;

// Seeded random numbers so the files come out identical on every run.
function rng(seed){return()=>{seed=(seed+0x6D2B79F5)|0;let t=Math.imul(seed^(seed>>>15),1|seed);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}

export function largeSource(){
  const r=rng(2026),rows=[],cents=x=>BigInt(Math.round(x*100)),pick=(a,b)=>a+(b-a)*r();
  for(let u=1;u<=UNITS;u++){
    let rev=pick(40_000,400_000),cash=cents(pick(300_000,3_000_000));const grow=pick(-0.01,0.03),opexShare=pick(0.4,0.52);
    for(let m=1;m<=MONTHS;m++){
      rev*=1+grow+pick(-0.04,0.04);
      const revenue=cents(rev),cogs=divideRound(revenue*35n,100n),opex=cents(rev*opexShare*pick(0.95,1.05));
      const budgetRev=cents(rev*pick(0.92,1.08)),budgetOpex=cents(rev*opexShare*pick(0.95,1.05));
      const capex=r()<0.15?cents(pick(5_000,60_000)):0n,financing=r()<0.05?cents(pick(50_000,250_000)):0n;
      const payments=cogs+opex,closing=cash+revenue-payments-capex+financing;
      rows.push({record_id:id(u,m),company_id:co(u),period:period(m),scenario:'actual_synthetic',currency:'USD',
        revenue_usd:amount(revenue),cogs_usd:amount(cogs),opex_usd:amount(opex),budget_revenue_usd:amount(budgetRev),budget_opex_usd:amount(budgetOpex),
        opening_cash_usd:amount(cash),cash_receipts_usd:amount(revenue),cash_operating_payments_usd:amount(payments),capex_usd:amount(capex),
        financing_usd:amount(financing),closing_cash_usd:amount(closing),headcount:String(5+Math.floor(rev/20_000)),synthetic:'true'});
      cash=closing;
    }
  }
  return rows;
}

// 25 planted errors, each in its own business unit so every plant produces exactly one flag.
export function largePlants(S){
  const row=i=>S.find(x=>x.record_id===i),v=(i,c)=>row(i)[c],varOf=(i,a,b)=>minor(v(i,a))-minor(v(i,b));
  const pct=(i,a,b)=>{const b0=minor(v(i,b)),d=varOf(i,a,b);return divideRound(d*10000n,b0<0n?-b0:b0);};
  const P={
    missing_row:u=>({id:id(u,10),column:null,opts:{drop:[id(u,10)]}}),
    typed_over:u=>({id:id(u,9),column:'revenue_usd',opts:{inputs:{[id(u,9)]:{revenue_usd:amount(minor(v(id(u,9),'revenue_usd'))+123456n)}}}}),
    wrong_period:u=>({id:id(u,2),column:'revenue_usd',opts:{inputs:{[id(u,2)]:{revenue_usd:v(id(u,8),'revenue_usd')}}}}),
    wrong_variance:u=>({id:id(u,3),column:'revenue_variance_usd',opts:{cells:{[id(u,3)]:{revenue_variance_usd:amount(varOf(id(u,3),'revenue_usd','budget_revenue_usd')+50000n)}}}}),
    sign_flipped:u=>({id:id(u,4),column:'opex_variance_usd',opts:{cells:{[id(u,4)]:{opex_variance_usd:amount(-varOf(id(u,4),'opex_usd','budget_opex_usd'))}}}}),
    wrong_percent:u=>({id:id(u,5),column:'opex_variance_pct',opts:{cells:{[id(u,5)]:{opex_variance_pct:amount(pct(id(u,5),'opex_usd','budget_opex_usd')+300n)}}}}),
    total_skips_row:u=>({id:`TOTAL-${co(u)}`,column:'revenue_usd',opts:{totalAdjust:{[`TOTAL-${co(u)}`]:{revenue_usd:-minor(v(id(u,7),'revenue_usd'))}}}}),
    total_double_counts:u=>({id:`TOTAL-${co(u)}`,column:'revenue_usd',opts:{totalAdjust:{[`TOTAL-${co(u)}`]:{revenue_usd:minor(v(id(u,2),'revenue_usd'))}}}}),
    rollforward_break:u=>({id:id(u,6),column:'opening_cash_usd',opts:{cells:{[id(u,6)]:{opening_cash_usd:amount(minor(v(id(u,6),'opening_cash_usd'))+1000000n)}}}}),
    // last month, so the wrong closing does not also break the next month's opening
    rollforward_formula:u=>({id:id(u,MONTHS),column:'closing_cash_usd',opts:{cells:{[id(u,MONTHS)]:{closing_cash_usd:amount(minor(v(id(u,MONTHS),'closing_cash_usd'))+250000n)}}}}),
  };
  // Units spread through the file; types with a third instance are the ones analysts hit most.
  const plan=[['missing_row',[7,48,91]],['typed_over',[12,55,83]],['wrong_period',[19,66]],['wrong_variance',[23,61,97]],['sign_flipped',[4,38,74]],
    ['wrong_percent',[29,70]],['total_skips_row',[33,79]],['total_double_counts',[15,58]],['rollforward_break',[41,87,2]],['rollforward_formula',[26,64]]];
  return plan.flatMap(([type,units])=>units.map(u=>({type,...P[type](u)})));
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const src=largeSource(),dir=fileURLToPath(new URL('../data/synthetic/large/',import.meta.url));fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(dir+'company-data.csv',toCSV(src));
  for(const [name,text] of Object.entries(planFixtures(src,largePlants(src))))fs.writeFileSync(dir+name,text.replace('analyst-sheet-errors.csv','large/analyst-sheet-errors.csv'));
}
