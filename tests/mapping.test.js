import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseCSV} from '../lib/csv.js';
import {suggestMapping,applyMapping,parseAmount,parsePeriod} from '../lib/mapping.js';
import {checkSheet,loadSource} from '../lib/checker.js';

const read=f=>parseCSV(fs.readFileSync(new URL(`../data/${f}`,import.meta.url),'utf8'));

test('suggestMapping matches synonyms and leaves repeats unmatched',()=>{
  const {mapping,unmatched}=suggestMapping(['Entity','Month','Net sales','Revenue','Operating expenses','Beginning cash','Ending Cash','Notes']);
  assert.deepEqual(mapping,{Entity:'company_id',Month:'period','Net sales':'revenue_usd',Revenue:null,'Operating expenses':'opex_usd','Beginning cash':'opening_cash_usd','Ending Cash':'closing_cash_usd',Notes:null});
  assert.ok(unmatched.includes('capex_usd')&&!unmatched.includes('opex_usd'));
  assert.equal(suggestMapping(['Revenue Variance %']).mapping['Revenue Variance %'],'revenue_variance_pct');
});
test('amounts: $, commas and parentheses are read; k, ambiguous and long decimals are rejected',()=>{
  assert.equal(parseAmount('$12,000.50'),'12000.50');
  assert.equal(parseAmount('(500)'),'-500.00');
  assert.equal(parseAmount('12000'),'12000.00');
  assert.equal(parseAmount(' -$3.5 '),'-3.50');
  for(const bad of ['1.2k','1.234,56','12,34','1,2345.00','1.234','abc','(-5)'])assert.ok(parseAmount(bad).error,bad);
});
test('periods: every supported format becomes yyyy-mm; day/month order is not guessed',()=>{
  for(const p of ['2026-03','03/2026','Mar 2026','March 2026','2026-03-01','2026/3'])assert.equal(parsePeriod(p),'2026-03',p);
  assert.equal(parsePeriod('3/1/2026'),null);assert.equal(parsePeriod('2026-13'),null);assert.equal(parsePeriod('total'),'TOTAL');
});
const cols={Entity:'company_id',Month:'period',Sales:'revenue_usd','Sales Budget':'budget_revenue_usd',Opex:'opex_usd','Opex Budget':'budget_opex_usd','Beginning cash':'opening_cash_usd',Receipts:'cash_receipts_usd',Payments:'cash_operating_payments_usd',Capex:'capex_usd',Financing:'financing_usd','Ending cash':'closing_cash_usd'};
const row={Entity:'CO-001',Month:'Mar 2026',Sales:'$1,000.00','Sales Budget':'900','Opex':'(5)','Opex Budget':'1','Beginning cash':'1','Receipts':'1','Payments':'1','Capex':'0','Financing':'0','Ending cash':'1'};
test('applyMapping generates record_id, needs the USD confirmation, and reports row and column',()=>{
  const [o]=applyMapping([row],{columns:cols,assume_usd:true});
  assert.equal(o.record_id,'CO-001-2026-03');assert.equal(o.currency,'USD');assert.equal(o.revenue_usd,'1000.00');assert.equal(o.opex_usd,'-5.00');
  assert.throws(()=>applyMapping([row],{columns:cols}),/US dollars/);
  assert.throws(()=>applyMapping([{...row,Sales:'1.2k'}],{columns:cols,assume_usd:true}),e=>e.details[0].row===2&&e.details[0].column==='revenue_usd');
  assert.throws(()=>applyMapping([row],{columns:{...cols,Capex:'opex_usd'},assume_usd:true}),/both matched/);
  const {Capex,...partial}=cols;assert.throws(()=>applyMapping([row],{columns:partial,assume_usd:true}),/capex_usd/);
});
test('a differently formatted company file maps to exactly the clean sheet and gives 0 flags',()=>{
  // data/synthetic/company-format-b.csv is synthetic: other headers, $ and commas, % signs, mixed month formats.
  const b=read('synthetic/company-format-b.csv'),clean=read('synthetic/analyst-sheet-clean.csv');
  const {mapping}=suggestMapping(Object.keys(b[0]));
  const out=applyMapping(b,{columns:mapping,assume_usd:true});
  assert.deepEqual(out,clean.map(r=>Object.fromEntries(Object.entries(r).filter(([k,v])=>!(v===''&&['opening_cash_usd','cash_receipts_usd','cash_operating_payments_usd','capex_usd','financing_usd','closing_cash_usd'].includes(k)&&r.period==='TOTAL')||true))));
  assert.equal(checkSheet(out,loadSource()).length,0);
});
