// Budgets are optional. Without them the checker skips only the budget checks (variance, percent, budget totals).
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {parseCSV} from '../lib/csv.js';
import {checkSheet,loadSource,BUDGET} from '../lib/checker.js';
import {REQUIRED,applyMapping} from '../lib/mapping.js';
import {summarize} from '../lib/summary.js';

const read=n=>parseCSV(fs.readFileSync(new URL(`../data/synthetic/${n}`,import.meta.url),'utf8'));
const drop=(rows,cols)=>rows.map(r=>{const o={...r};for(const c of cols)delete o[c];return o;});
const VAR=['revenue_variance_usd','revenue_variance_pct','opex_variance_usd','opex_variance_pct'];
const types=flags=>flags.map(f=>f.type).sort();

test('no budget columns: the clean sheet passes in both modes',()=>{
  const rows=drop(read('analyst-sheet-clean.csv'),[...BUDGET,...VAR]);
  assert.deepEqual(checkSheet(rows,null),[]);
  assert.deepEqual(checkSheet(rows,loadSource()),[]);
});

test('no budget columns: every non-budget error is still found, budget-only checks are skipped',()=>{
  const flags=checkSheet(drop(read('analyst-sheet-errors.csv'),BUDGET),null); // variance columns left in are ignored
  assert.deepEqual(types(flags),['missing_row','rollforward_break','rollforward_formula','total_double_counts','total_skips_row']);
});

test('a blank budget cell skips that row\'s variance and the budget total, other rows are still checked',()=>{
  const rows=read('analyst-sheet-clean.csv').map(r=>({...r}));
  const a=rows.find(r=>r.record_id==='FIN-1-02'),b=rows.find(r=>r.record_id==='FIN-1-03');
  a.budget_revenue_usd='';a.revenue_variance_usd='';a.revenue_variance_pct='';
  b.revenue_variance_usd='1.00';
  const flags=checkSheet(rows,null);
  assert.deepEqual(flags.map(f=>`${f.type}:${f.record_id}`),['wrong_variance:FIN-1-03']);
});

test('summary: budget totals and variances are null (not a partial sum) when a month has no budget',()=>{
  const [co]=summarize(drop(read('analyst-sheet-clean.csv'),BUDGET).filter(r=>r.company_id==='CO-001')).companies;
  assert.equal(co.budget_revenue_usd,null);assert.equal(co.revenue_variance_usd,null);assert.equal(co.opex_variance_usd,null);
  assert.equal(co.revenue_usd,'1156500.00');
});

test('column matching: budgets are not required, and a file without them maps and checks',()=>{
  for(const c of BUDGET)assert.ok(!REQUIRED.includes(c));
  const raw=[{Company:'CO-9',Month:'Jan 2026',Revenue:'1,000',Opex:'800','Opening Cash':'100','Cash Receipts':'1000','Operating Payments':'800',Capex:'0',Financing:'0','Closing Cash':'300'}];
  const cols={Company:'company_id',Month:'period',Revenue:'revenue_usd',Opex:'opex_usd','Opening Cash':'opening_cash_usd','Cash Receipts':'cash_receipts_usd','Operating Payments':'cash_operating_payments_usd',Capex:'capex_usd',Financing:'financing_usd','Closing Cash':'closing_cash_usd'};
  const rows=applyMapping(raw,{columns:cols,assume_usd:true});
  assert.deepEqual(checkSheet(rows,null),[]);
});
