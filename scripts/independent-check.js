// Independent reconciliation of the synthetic analyst sheets and checkSheet flags (BigInt cents only).
// Uses only parseCSV/minor/amount from starter code; checkSheet is called as a black box.
import fs from 'node:fs';
import { parseCSV } from '../lib/csv.js';
import { minor, amount } from '../lib/finance.js';
import { checkSheet } from '../lib/checker.js';

const rd = (p) => parseCSV(fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8'));
const src = rd('data/monthly_financials.csv');
const clean = rd('data/synthetic/analyst-sheet-clean.csv');
const errs = rd('data/synthetic/analyst-sheet-errors.csv');
const key = JSON.parse(fs.readFileSync(new URL('../data/synthetic/planted-errors.json', import.meta.url), 'utf8')).errors;

const COLS = ['record_id','company_id','period','currency','revenue_usd','budget_revenue_usd','revenue_variance_usd','revenue_variance_pct','opex_usd','budget_opex_usd','opex_variance_usd','opex_variance_pct','opening_cash_usd','cash_receipts_usd','cash_operating_payments_usd','capex_usd','financing_usd','closing_cash_usd'];
const IN = ['revenue_usd','budget_revenue_usd','opex_usd','budget_opex_usd'];
const CASH = ['opening_cash_usd','cash_receipts_usd','cash_operating_payments_usd','capex_usd','financing_usd','closing_cash_usd'];
const C = (v) => minor(v, { signed: true });
const money = (c) => amount(c);
// pct = var / |budget| x 100, 2 dp, half away from zero; blank on zero budget
const pct = (v, b) => {
  if (b === 0n) return '';
  const n = v * 10000n, d = b < 0n ? -b : b, a = n < 0n ? -n : n;
  const q = (2n * a + d) / (2n * d);
  const s = n < 0n ? -q : q;
  const abs = s < 0n ? -s : s;
  return (s < 0n ? '-' : '') + (abs / 100n) + '.' + String(abs % 100n).padStart(2, '0');
};
const norm = (v) => String(v ?? '').trim().replace(/%$/, '');
const fails = [];
const fail = (check, msg) => fails.push(`[${check}] ${msg}`);
const section = (n) => fails.filter((f) => f.startsWith(`[${n}]`)).length;

// ---- Check 1: expected clean sheet
function derived(vals) { // vals: {revenue_usd,budget_revenue_usd,opex_usd,budget_opex_usd} as BigInt
  const rv = vals.revenue_usd - vals.budget_revenue_usd, ov = vals.opex_usd - vals.budget_opex_usd;
  return { revenue_variance_usd: money(rv), revenue_variance_pct: pct(rv, vals.budget_revenue_usd),
           opex_variance_usd: money(ov), opex_variance_pct: pct(ov, vals.budget_opex_usd) };
}
const expected = new Map(), order = [];
const companies = [...new Set(src.map((r) => r.company_id))];
for (const co of companies) {
  const rows = src.filter((r) => r.company_id === co);
  const tot = { revenue_usd: 0n, budget_revenue_usd: 0n, opex_usd: 0n, budget_opex_usd: 0n };
  for (const r of rows) {
    const v = Object.fromEntries(IN.map((c) => [c, C(r[c])]));
    IN.forEach((c) => (tot[c] += v[c]));
    const e = { record_id: r.record_id, company_id: co, period: r.period, currency: r.currency, ...Object.fromEntries(IN.map((c) => [c, r[c]])), ...derived(v), ...Object.fromEntries(CASH.map((c) => [c, r[c]])) };
    expected.set(e.record_id, e); order.push(e.record_id);
  }
  const t = { record_id: 'TOTAL-' + co, company_id: co, period: 'TOTAL', currency: rows[0].currency, ...Object.fromEntries(IN.map((c) => [c, money(tot[c])])), ...derived(tot), ...Object.fromEntries(CASH.map((c) => [c, ''])) };
  expected.set(t.record_id, t); order.push(t.record_id);
}
let cells1 = 0;
const cleanMap = new Map(clean.map((r) => [r.record_id, r]));
if (clean.length !== expected.size) fail(1, `row count ${clean.length} vs expected ${expected.size}`);
clean.forEach((r, i) => { if (r.record_id !== order[i]) fail(1, `row order differs at sheet row ${i + 2}`); });
for (const [id, e] of expected) {
  const r = cleanMap.get(id);
  if (!r) { fail(1, `clean sheet missing ${id}`); continue; }
  for (const c of COLS) { cells1++; if (norm(r[c]) !== norm(e[c])) fail(1, `${id}.${c}: sheet "${r[c]}" expected "${e[c]}"`); }
}
for (const r of clean) if (!expected.has(r.record_id)) fail(1, `clean sheet has extra row ${r.record_id}`);

// ---- Check 2: diff error sheet vs expected clean
const errCount = new Map(); errs.forEach((r) => errCount.set(r.record_id, (errCount.get(r.record_id) || 0) + 1));
const sheetRowOf = new Map(errs.map((r, i) => [r.record_id, i + 2]));
const keyAt = new Set(key.map((k) => `${k.sheet_row}|${k.column}`));
const keyedRows = new Set(key.map((k) => k.sheet_row));
const sumsByCo = {};
for (const r of errs) if (r.period !== 'TOTAL' && expected.has(r.record_id)) {
  const s = (sumsByCo[r.company_id] ||= Object.fromEntries(IN.map((c) => [c, 0n])));
  IN.forEach((c) => (s[c] += C(r[c])));
}
const knock = [], explained = [], diffs = [];
let cells2 = 0;
for (const [id, e] of expected) {
  const r = errs.find((x) => x.record_id === id);
  if (!r) { diffs.push(`MISSING row ${id}`); const miss = key.find((k) => k.column == null && k.type === 'missing_row'); if (!miss) fail(2, `row ${id} missing with no answer-key entry`); else explained.push(`missing ${id}`); continue; }
  const row = sheetRowOf.get(id);
  for (const c of COLS) {
    cells2++;
    if (norm(r[c]) === norm(e[c])) continue;
    diffs.push(`${id}.${c}`);
    if (keyAt.has(`${row}|${c}`)) { explained.push(`${id}.${c}`); continue; }
    // knock-on: derived cell consistent with the sheet's own inputs
    let ok = false;
    const own = (rr) => Object.fromEntries(IN.map((k) => [k, C(rr[k])]));
    if (r.period === 'TOTAL') {
      const s = sumsByCo[r.company_id] || {};
      const base = c.includes('variance') ? derived({ ...own(r) }) : null;
      ok = IN.includes(c) ? norm(r[c]) === money(s[c]) : base && norm(r[c]) === norm(base[c]);
      // total variance cells may follow either the sheet's total inputs (derived) or detail sums
      if (!ok && base === null) ok = false;
    } else if (c.includes('variance')) ok = norm(r[c]) === norm(derived(own(r))[c]);
    if (ok) knock.push(`${id}.${c}`); else fail(2, `unexplained difference ${id}.${c}: sheet "${r[c]}" clean "${e[c]}"`);
  }
}
for (const r of errs) if (!expected.has(r.record_id)) { diffs.push(`EXTRA ${r.record_id}`); fail(2, `extra row ${r.record_id}`); }
for (const [id, n] of errCount) if (n > 1) { fail(2, `duplicate row ${id} x${n}`); }
for (const k of key) { // every key entry should correspond to a real difference
  if (k.column == null) continue;
  const r = errs[k.sheet_row - 2];
  if (!r || norm(r[k.column]) === norm(expected.get(r.record_id)?.[k.column])) fail(2, `answer key entry row ${k.sheet_row} ${k.column} shows no difference`);
}

// ---- Check 3: source roll-forward
let rf = 0;
for (const co of companies) {
  const rows = src.filter((r) => r.company_id === co).sort((a, b) => a.period.localeCompare(b.period));
  rows.forEach((r, i) => {
    rf++;
    if (C(r.opening_cash_usd) + C(r.cash_receipts_usd) - C(r.cash_operating_payments_usd) - C(r.capex_usd) + C(r.financing_usd) !== C(r.closing_cash_usd)) fail(3, `${r.record_id} formula`);
    if (i && C(rows[i - 1].closing_cash_usd) !== C(r.opening_cash_usd)) fail(3, `${rows[i - 1].record_id} closing != ${r.record_id} opening`);
  });
}

// ---- Check 4: flags on both sheets
let flagsClean;
try { flagsClean = checkSheet(clean); } catch (e) { fail(4, 'checkSheet(clean) threw: ' + e.message); flagsClean = []; }
if (flagsClean.length) fail(4, `clean sheet gave ${flagsClean.length} flags`);
let flags;
try { flags = checkSheet(errs); } catch (e) { fail(4, 'checkSheet(errors) threw: ' + e.message); flags = []; }
const srcIdx = new Map(src.map((r, i) => [r.record_id, i + 2]));
const letter = (i) => String.fromCharCode(65 + i);
const prevOf = (r) => src.find((x) => x.company_id === r.company_id && x.period === String(r.period).replace(/\d\d$/, (m) => String(+m - 1).padStart(2, '0')));
let verified = 0;
for (const f of flags) {
  const tag = `${f.type} ${f.record_id}.${f.column}`;
  const sr = errs[f.sheet_row - 2], sc = src.find((x) => x.record_id === f.record_id);
  let want;
  switch (f.type) {
    case 'typed_over': case 'wrong_period': want = sc?.[f.column]; break;
    case 'wrong_variance': case 'sign_flipped': {
      const a = f.column.startsWith('revenue') ? 'revenue_usd' : 'opex_usd', b = 'budget_' + a;
      want = money(C(sr[a]) - C(sr[b])); break; }
    case 'wrong_percent': case 'pct_on_zero_budget': {
      const a = f.column.startsWith('revenue') ? 'revenue_usd' : 'opex_usd', b = 'budget_' + a;
      want = pct(C(sr[a]) - C(sr[b]), C(sr[b])); break; }
    case 'wrong_total': case 'total_skips_row': case 'total_double_counts':
      want = IN.includes(f.column) ? money(sumsByCo[sr.company_id][f.column]) : undefined; break;
    case 'rollforward_break': want = prevOf(sc)?.closing_cash_usd; break;
    case 'rollforward_formula': want = money(C(sr.opening_cash_usd) + C(sr.cash_receipts_usd) - C(sr.cash_operating_payments_usd) - C(sr.capex_usd) + C(sr.financing_usd)); break;
    case 'missing_row': want = null; break;
    default: fail(4, `${tag}: no independent rule for type`); continue;
  }
  if (f.type === 'missing_row') {
    if (!srcIdx.has(f.record_id) || errs.some((r) => r.record_id === f.record_id)) fail(4, `${tag}: record not truly missing`);
  } else if (want === undefined || norm(f.suggested_value) !== norm(want)) fail(4, `${tag}: suggested "${f.suggested_value}" independent "${want}"`);
  if (f.column && f.cell !== letter(COLS.indexOf(f.column)) + f.sheet_row) fail(4, `${tag}: cell ${f.cell} wrong`);
  if (f.type.startsWith('total') || f.type === 'wrong_total') {
    if (f.source && (f.source.record_id != null || f.source.source_row != null)) fail(4, `${tag}: totals flag should have null source record`);
  } else if (!f.source || f.source.record_id !== f.record_id || f.source.source_row !== srcIdx.get(f.record_id) || f.source.row?.record_id !== f.record_id) fail(4, `${tag}: source pointer wrong (${f.source?.record_id} row ${f.source?.source_row}, want row ${srcIdx.get(f.record_id)})`);
  else if (sr && f.type !== 'missing_row' && f.sheet_value != null && f.column && norm(f.sheet_value) !== norm(sr[f.column])) fail(4, `${tag}: sheet_value mismatch`);
  verified++;
}

// ---- Check 5: flags == answer key
const norm5 = (a) => a.map((x) => `${x.sheet_row}|${x.column ?? 'null'}|${x.type}`).sort();
const fk = norm5(flags), kk = norm5(key);
if (fk.length !== kk.length || fk.some((v, i) => v !== kk[i])) {
  fail(5, `flags-only: ${fk.filter((v) => !kk.includes(v)).join('; ') || 'none'}; key-only: ${kk.filter((v) => !fk.includes(v)).join('; ') || 'none'}`);
}

const st = (n) => (section(n) ? 'FAIL' : 'pass');
console.log(`1 clean sheet == recomputed: ${st(1)} (${cells1} cells over ${expected.size} rows)`);
console.log(`2 error sheet diff: ${st(2)} (${diffs.length} diffs: ${explained.length} keyed, ${knock.length} knock-on, ${diffs.length - explained.length - knock.length} unexplained)`);
if (knock.length) console.log('  knock-on cells: ' + knock.join(', '));
console.log(`3 source roll-forward: ${st(3)} (${rf} company-months)`);
console.log(`4 flags: ${st(4)} (clean ${flagsClean.length} flags; error sheet ${flags.length} flags, ${verified} verified)`);
console.log(`5 flags == answer key: ${st(5)} (${flags.length} vs ${key.length})`);
if (fails.length) { console.log('\nFAILURES:\n' + fails.join('\n')); process.exit(1); }
console.log('ALL CHECKS PASS');
