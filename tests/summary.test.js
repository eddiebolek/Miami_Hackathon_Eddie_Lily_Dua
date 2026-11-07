import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {parseCSV} from '../lib/csv.js';import {checkSheet,loadSource} from '../lib/checker.js';
import {summarize} from '../lib/summary.js';

const src=loadSource();
const errors=parseCSV(fs.readFileSync(new URL('../data/synthetic/analyst-sheet-errors.csv',import.meta.url),'utf8'));

test('summarize: per-company exact totals and variances in cents',()=>{
  const s=summarize(src.rows,[]);
  assert.equal(s.companies.length,3);
  const c=s.companies[0];
  assert.equal(c.company_id,'CO-001');assert.equal(c.months,12);assert.equal(c.latest_period,'2026-12');
  assert.equal(c.revenue_variance_usd,'36000.00');assert.equal(c.opex_variance_usd,'24000.00');
  assert.equal(c.closing_cash_usd,'521725.00');
  assert.equal(s.latest_period,'2026-12');
});

test('summarize: totals equal the sum of the rows, to the cent',()=>{
  const s=summarize(src.rows,[]);
  const sum=(co,col)=>src.rows.filter(r=>r.company_id===co).reduce((t,r)=>t+BigInt(r[col].replace('.','')),0n);
  for(const c of s.companies)assert.equal(c.revenue_usd.replace('.',''),String(sum(c.company_id,'revenue_usd')));
});

test('summarize: counts flags by type, severity and status; TOTAL rows and duplicates are not months',()=>{
  const flags=checkSheet(errors,src).map((f,i)=>i===0?{...f,status:'confirmed'}:f);
  const s=summarize(errors,flags);
  assert.equal(s.flags.total,10);
  assert.equal(Object.values(s.flags.by_type).reduce((a,b)=>a+b,0),10);
  assert.equal(Object.values(s.flags.by_severity).reduce((a,b)=>a+b,0),10);
  assert.equal(s.flags.by_status.confirmed,1);assert.equal(s.flags.by_status.open,9);
  assert.equal(s.companies.reduce((n,c)=>n+c.months,0),35);
});

test('summarize: pure (does not change its inputs) and latest month crosses years',()=>{
  const rows=[...src.rows,{...src.rows.at(-1),record_id:'FIN-3-13',period:'2027-01'}],before=JSON.stringify(rows);
  const s=summarize(rows,[]);assert.equal(JSON.stringify(rows),before);
  assert.equal(s.latest_period,'2027-01');assert.equal(s.companies.find(c=>c.company_id==='CO-003').latest_period,'2027-01');
});

test('summarize: empty input gives empty summary',()=>{
  assert.deepEqual(summarize([],[]),{companies:[],latest_period:null,flags:{total:0,by_type:{},by_severity:{},by_status:{}}});
});
