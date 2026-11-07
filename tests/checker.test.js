import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {parseCSV} from '../lib/csv.js';import {minor} from '../lib/finance.js';
import {loadSource,validateSheet,checkSheet,ValidationError} from '../lib/checker.js';
import {buildSheetRows} from '../scripts/make-fixtures.js';

const read=n=>parseCSV(fs.readFileSync(new URL(`../data/synthetic/${n}`,import.meta.url),'utf8'));
const src=loadSource();
const sheet=(opts,source=src)=>buildSheetRows(source.rows,opts);
const types=flags=>flags.map(f=>`${f.type}:${f.column}`);
const only=(rows,expected)=>assert.deepEqual(types(checkSheet(rows,src)),expected);
const rev=id=>src.rows.find(r=>r.record_id===id).revenue_usd;
const clone=rows=>rows.map(r=>({...r}));

test('acceptance 1: the clean sheet has zero flags (built and committed)',()=>{
  assert.deepEqual(checkSheet(sheet(),src),[]);
  assert.deepEqual(checkSheet(read('analyst-sheet-clean.csv'),src),[]);
});

test('acceptance 2: bad input gives a readable ValidationError, not a crash',()=>{
  const bad=(rows,pattern)=>{
    assert.throws(()=>checkSheet(rows,src),e=>{
      assert.ok(e instanceof ValidationError);assert.equal(e.name,'ValidationError');
      assert.match(e.message,pattern);assert.ok(Array.isArray(e.details)&&e.details.length>0);assert.ok(e.details[0].message);return true;});
    assert.throws(()=>validateSheet(rows,src),ValidationError);
  };
  bad(sheet().map(({capex_usd,...r})=>r),/missing column.*capex_usd/i);
  const money=clone(sheet());money[2].revenue_usd='12,000';bad(money,/12,000/);
  const period=clone(sheet());period[3].period='2027-01';bad(period,/2027-01/);
  const cur=clone(sheet());cur[4].currency='EUR';bad(cur,/EUR/);
  bad([],/no rows/i);
  const company=clone(sheet());company[1].company_id='CO-999';bad(company,/CO-999/);
});

test('validation collects at most 20 problems',()=>{
  const rows=clone(sheet());rows.forEach(r=>{r.currency='EUR';});
  try{checkSheet(rows,src);assert.fail('should throw');}catch(e){assert.ok(e instanceof ValidationError);assert.equal(e.details.length,20);}
});

test('typed_over: input differs from the source; suggested value and source row are given',()=>{
  const flags=checkSheet(sheet({inputs:{'FIN-1-09':{revenue_usd:'91234.56'}}}),src);
  assert.deepEqual(types(flags),['typed_over:revenue_usd']);
  const f=flags[0];assert.equal(f.severity,'high');assert.equal(f.suggested_value,rev('FIN-1-09'));assert.equal(f.sheet_value,'91234.56');
  assert.equal(f.source.file,'data/monthly_financials.csv');assert.equal(f.source.record_id,'FIN-1-09');assert.equal(f.source.source_row,10);
  assert.equal(f.record_id,'FIN-1-09');assert.equal(f.sheet_row,10);assert.match(f.cell,/^[A-Z]+10$/);assert.ok(f.calculation&&f.explanation);
});

test('typed_over: January opening cash differs from the source',()=>{
  only(sheet({cells:{'FIN-1-01':{opening_cash_usd:'500001.00'}}}),['typed_over:opening_cash_usd']);
});

test('wrong_period: value equals the same column in another month',()=>{
  const flags=checkSheet(sheet({inputs:{'FIN-3-02':{revenue_usd:rev('FIN-3-08')}}}),src);
  assert.deepEqual(types(flags),['wrong_period:revenue_usd']);assert.equal(flags[0].suggested_value,rev('FIN-3-02'));
});

test('missing_row: a source record absent from the sheet',()=>{
  const flags=checkSheet(sheet({drop:['FIN-2-10']}),src);
  assert.deepEqual(types(flags),['missing_row:null']);assert.equal(flags[0].record_id,'FIN-2-10');assert.match(flags[0].cell,/^row \d+$/);
});

test('extra_row: a record id the source does not have',()=>{
  const rows=clone(sheet());rows.push({...rows.find(r=>r.record_id==='FIN-1-05'),record_id:'FIN-9-99'});
  const flags=checkSheet(rows,src);assert.deepEqual(types(flags),['extra_row:null']);assert.equal(flags[0].sheet_row,rows.length+1);
});

test('duplicate_row: the same record id twice',()=>{
  const rows=clone(sheet());rows.push({...rows.find(r=>r.record_id==='FIN-1-05')});
  const flags=checkSheet(rows,src);assert.deepEqual(types(flags),['duplicate_row:null']);assert.equal(flags[0].sheet_row,rows.length+1);
});

test('sign_flipped: variance shown with the opposite sign',()=>{
  const flags=checkSheet(sheet({cells:{'FIN-2-04':{revenue_variance_usd:'-3000.00'}}}),src);
  assert.deepEqual(types(flags),['sign_flipped:revenue_variance_usd']);assert.equal(flags[0].suggested_value,'3000.00');
  assert.match(flags[0].calculation,/-/);
});

test('wrong_variance: variance not equal to actual minus budget',()=>{
  const flags=checkSheet(sheet({cells:{'FIN-1-03':{opex_variance_usd:'2500.00'}}}),src);
  assert.deepEqual(types(flags),['wrong_variance:opex_variance_usd']);assert.equal(flags[0].severity,'medium');assert.equal(flags[0].suggested_value,'2000.00');
});

test('wrong_percent: percent not variance / |budget| x 100',()=>{
  const flags=checkSheet(sheet({cells:{'FIN-3-05':{opex_variance_pct:'9.99'}}}),src);
  assert.deepEqual(types(flags),['wrong_percent:opex_variance_pct']);assert.equal(flags[0].severity,'low');assert.equal(flags[0].suggested_value,'2.33');
});

test('percent accepts a trailing % and does not flag it',()=>{
  const rows=clone(sheet());const r=rows.find(x=>x.record_id==='FIN-3-05');r.opex_variance_pct+='%';only(rows,[]);
});

test('pct_on_zero_budget: a percentage shown when the budget is zero',()=>{
  const rowsSrc=src.rows.map(r=>r.record_id==='FIN-1-01'?{...r,budget_revenue_usd:'0.00'}:r);const zsrc=loadSource(rowsSrc);
  assert.deepEqual(checkSheet(sheet({},zsrc),zsrc),[]);
  const flags=checkSheet(sheet({cells:{'FIN-1-01':{revenue_variance_pct:'5.00'}}},zsrc),zsrc);
  assert.deepEqual(types(flags),['pct_on_zero_budget:revenue_variance_pct']);assert.equal(flags[0].suggested_value,'');
});

test('wrong_total: total differs and no single row explains it',()=>{
  const flags=checkSheet(sheet({totalAdjust:{'TOTAL-CO-003':{revenue_usd:12345n}}}),src);
  assert.deepEqual(types(flags),['wrong_total:revenue_usd']);assert.equal(flags[0].record_id,'TOTAL-CO-003');
});

test('total_skips_row: total is short by exactly one row',()=>{
  const flags=checkSheet(sheet({totalAdjust:{'TOTAL-CO-001':{revenue_usd:-minor(rev('FIN-1-07'))}}}),src);
  assert.deepEqual(types(flags),['total_skips_row:revenue_usd']);assert.equal(flags[0].related[0].record_id,'FIN-1-07');
});

test('total_double_counts: total is over by exactly one row',()=>{
  const flags=checkSheet(sheet({totalAdjust:{'TOTAL-CO-002':{revenue_usd:minor(rev('FIN-2-02'))}}}),src);
  assert.deepEqual(types(flags),['total_double_counts:revenue_usd']);assert.equal(flags[0].related[0].record_id,'FIN-2-02');
});

test('rollforward_break: opening does not equal last month closing; related cells shown',()=>{
  const flags=checkSheet(sheet({cells:{'FIN-2-06':{opening_cash_usd:'123456.00'}}}),src);
  assert.deepEqual(types(flags),['rollforward_break:opening_cash_usd']);
  assert.ok(flags[0].related.some(r=>r.record_id==='FIN-2-05'&&r.column==='closing_cash_usd'));
  assert.ok(flags[0].related.every(r=>r.cell&&r.label));
});

test('rollforward_formula: closing is not opening + receipts - payments - capex + financing',()=>{
  const flags=checkSheet(sheet({cells:{'FIN-3-12':{closing_cash_usd:'1000000.00'}}}),src);
  assert.deepEqual(types(flags),['rollforward_formula:closing_cash_usd']);assert.equal(flags[0].related.length,5);
});

test('every flag has the full shape and at most one flag per cell',()=>{
  const flags=checkSheet(read('analyst-sheet-errors.csv'),src);const cells=new Set();
  for(const f of flags){
    for(const k of ['key','type','severity','cell','sheet_row','record_id','source','related','explanation'])assert.ok(k in f,k);
    assert.ok(['high','medium','low'].includes(f.severity));assert.equal(f.source.file,'data/monthly_financials.csv');
    assert.ok(!cells.has(f.key));cells.add(f.key);
  }
});

test('acceptance 3: error sheet flags equal the answer key exactly',()=>{
  const key=JSON.parse(fs.readFileSync(new URL('../data/synthetic/planted-errors.json',import.meta.url),'utf8')).errors;
  const id=x=>`${x.sheet_row}|${x.column}|${x.type}`;
  const flags=checkSheet(read('analyst-sheet-errors.csv'),src);
  assert.equal(key.length,10);
  assert.deepEqual(flags.map(id).sort(),key.map(id).sort());
});

test('committed fixtures match the generator output',async()=>{
  const {planFixtures}=await import('../scripts/make-fixtures.js');const out=planFixtures(src.rows);
  for(const [name,text] of Object.entries(out))assert.equal(fs.readFileSync(new URL(`../data/synthetic/${name}`,import.meta.url),'utf8'),text,name);
});

test('wrong_period: period typed over on an existing record gives one flag',()=>{
  const rows=clone(sheet());rows.find(r=>r.record_id==='FIN-1-05').period='2026-06';
  const flags=checkSheet(rows,src);assert.deepEqual(types(flags),['wrong_period:period']);assert.equal(flags[0].suggested_value,'2026-05');
});

test('typed_over: company_id typed over on an existing record gives one flag',()=>{
  const rows=clone(sheet());rows.find(r=>r.record_id==='FIN-1-05').company_id='CO-002';
  const flags=checkSheet(rows,src);assert.deepEqual(types(flags),['typed_over:company_id']);assert.equal(flags[0].suggested_value,'CO-001');
});
