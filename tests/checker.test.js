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

// ---- Internal-only mode (source = null): checks that need no true copy ----
const newMonth=read('new-month-2027-01.csv');
const KEY=JSON.parse(fs.readFileSync(new URL('../data/synthetic/planted-errors.json',import.meta.url),'utf8')).errors;
const INTERNAL=['wrong_variance','sign_flipped','wrong_percent','wrong_total','total_skips_row','total_double_counts','rollforward_break','rollforward_formula','missing_row'];
const idOf=x=>`${x.sheet_row}|${x.column}|${x.type}`;

test('acceptance 4a: internal mode, clean sheet has zero flags',()=>{
  assert.deepEqual(checkSheet(read('analyst-sheet-clean.csv'),null),[]);
});

test('acceptance 4b: internal mode, error sheet = exactly the key entries of internal types',()=>{
  // typed_over and wrong_period need a true copy to compare against, so internal mode cannot see them.
  // Their totals/variances were built from the typed values, so nothing else disagrees internally.
  const flags=checkSheet(read('analyst-sheet-errors.csv'),null);
  assert.deepEqual(flags.map(idOf).sort(),KEY.filter(k=>INTERNAL.includes(k.type)).map(idOf).sort());
  assert.equal(flags.length,8);
  for(const f of flags)assert.equal(f.source.source_row,null);
});

test('internal mode: validation takes any YYYY-MM and optional variance columns, still rejects bad input',()=>{
  const slim=sheet().map(({revenue_variance_usd,revenue_variance_pct,opex_variance_usd,opex_variance_pct,...r})=>r);
  assert.deepEqual(checkSheet(slim,null),[]);
  const p=clone(sheet());p[0].period='2027-13';assert.throws(()=>checkSheet(p,null),/2027-13/);
  assert.throws(()=>checkSheet(sheet().map(({capex_usd,...r})=>r),null),/capex_usd/);
  const c=clone(sheet());c[0].company_id='NEW-CO';assert.ok(Array.isArray(checkSheet(c,null)));
});

test('internal mode: duplicates by record id and by company+period, interior gap by month',()=>{
  const dupId=clone(sheet());dupId.push({...dupId.find(r=>r.record_id==='FIN-1-05')});
  assert.deepEqual(types(checkSheet(dupId,null)),['duplicate_row:null']);
  const dupPeriod=clone(sheet());dupPeriod.push({...dupPeriod.find(r=>r.record_id==='FIN-1-05'),record_id:'FIN-1-99'});
  assert.deepEqual(types(checkSheet(dupPeriod,null)),['duplicate_row:null']);
  const gap=checkSheet(sheet({drop:['FIN-2-10']}),null);
  assert.deepEqual(types(gap),['missing_row:null']);assert.equal(gap[0].period,'2026-10');assert.equal(gap[0].company_id,'CO-002');
  assert.equal(gap[0].sheet_row,checkSheet(sheet({drop:['FIN-2-10']}),src)[0].sheet_row);
});

test('acceptance 5: source data + the 2027-01 month passes internal checks across the year boundary',()=>{
  assert.equal(newMonth.length,3);
  assert.ok(newMonth.every(r=>r.period==='2027-01'&&r.synthetic==='true'));
  const all=[...src.rows,...newMonth];
  assert.deepEqual(checkSheet(all,null),[]);
});

test('acceptance 5: a broken January opening is flagged as a roll-forward break against December',()=>{
  const all=clone([...src.rows,...newMonth]);const bad=all.find(r=>r.record_id===newMonth[0].record_id);bad.opening_cash_usd='1.00';
  const flags=checkSheet(all,null);
  assert.deepEqual(types(flags),['rollforward_break:opening_cash_usd']);
  assert.equal(flags[0].record_id,bad.record_id);
  assert.ok(flags[0].related.some(r=>r.record_id==='FIN-1-12'&&r.column==='closing_cash_usd'));
});

test('a gap across the year boundary is a missing month, not a break',()=>{
  const all=clone([...src.rows,...newMonth]).filter(r=>r.period!=='2026-12'||r.company_id!=='CO-001');
  assert.deepEqual(types(checkSheet(all,null)),['missing_row:null']);
});

test('source mode still names the bundled period range',()=>{
  const p=clone(sheet());p[0].period='2027-01';
  assert.throws(()=>validateSheet(p,src),/2026-01 to 2026-12/);
});

test('loadSource label is used as the flag source file',()=>{
  const s=loadSource(src.rows,{file:'Company data (true copy)'});
  const flags=checkSheet(sheet({cells:{'FIN-1-03':{revenue_variance_usd:'3500.00'}}}),s);
  assert.equal(flags[0].source.file,'Company data (true copy)');
});

test('large synthetic sheet: 2,400 rows, every planted error found exactly once, clean sheet passes',()=>{
  const d=n=>parseCSV(fs.readFileSync(new URL(`../data/synthetic/large/${n}`,import.meta.url),'utf8'));
  const big=loadSource(d('company-data.csv'));
  assert.equal(big.rows.length,2400);
  assert.equal(checkSheet(d('analyst-sheet-clean.csv'),big).length,0);
  assert.equal(checkSheet(d('analyst-sheet-clean.csv'),null).length,0);
  const key=JSON.parse(fs.readFileSync(new URL('../data/synthetic/large/planted-errors.json',import.meta.url),'utf8')).errors;
  const got=checkSheet(d('analyst-sheet-errors.csv'),big).map(f=>`${f.sheet_row}|${f.column}|${f.type}`).sort();
  assert.deepEqual(got,key.map(k=>`${k.sheet_row}|${k.column}|${k.type}`).sort());
});

test('first month opening cash is compared to the source even when data does not start in 2026-01',()=>{
  const rows=src.rows.map(r=>({...r,period:r.period.replace('2026','2025')})),s=loadSource(rows);
  const flags=checkSheet(buildSheetRows(rows,{cells:{'FIN-1-01':{opening_cash_usd:'500100.00',closing_cash_usd:'478987.50'}}}),s);
  assert.ok(flags.some(f=>f.record_id==='FIN-1-01'&&f.column==='opening_cash_usd'),JSON.stringify(flags.map(f=>f.type)));
});
