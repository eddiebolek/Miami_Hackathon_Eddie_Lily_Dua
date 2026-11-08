// Demo login: the save-nothing endpoint (api/demo.js), the seed file, and a whole demo session through public/demo.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import demo from '../api/demo.js';
import {buildSeed,SEED_FILE} from '../scripts/make-demo-seed.js';
import {startDemo,endDemo,demoApi} from '../public/demo.js';

const USPS = fs.readFileSync(new URL('../public/demo/usps_monthly_financials.csv', import.meta.url), 'utf8');
const call = async body => {
  const out = {};
  await demo({method: 'POST', url: '/api/demo', headers: {}, body}, {setHeader() {}, status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; }});
  return out;
};

test('demo endpoint: the USPS file gives exactly the $205M cash roll-forward flag, with no company data', async () => {
  const r = await call({action: 'check', csv: USPS});
  assert.equal(r.status, 200);
  assert.equal(r.body.data.mode, 'internal');
  assert.equal(r.body.data.flags.length, 1);
  const [f] = r.body.data.flags;
  assert.equal(f.period, '2006-09');
  assert.equal(BigInt(f.suggested_value.replace('.', '')) - BigInt(f.sheet_value.replace('.', '')), 20500000000n); // $205,000,000.00 in cents
});

test('demo endpoint: rejects bad input and existing rows the same way the real endpoints do', async () => {
  assert.equal((await call({action: 'nope'})).status, 422);
  assert.equal((await call({action: 'check', csv: ''})).status, 422);
  assert.equal((await call({action: 'add', csv: USPS, records: 'x'})).status, 422);
  const records = (await import('../lib/csv.js')).parseCSV(USPS).map((payload, i) => ({record_key: payload.record_id, source_row: i + 2, payload}));
  const again = await call({action: 'add', csv: USPS, records});
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'already_exists');
  const map = await call({action: 'map', headers: ['record_id', 'Revenue']});
  assert.equal(map.status, 200);
  assert.deepEqual(map.body.data.ai, []); // the demo never calls the AI
});

test('demo seed file matches what the checker produces today (run npm run demo:seed if this fails)', () => {
  assert.deepEqual(JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')), buildSeed());
});

test('demo session: upload, mark, sign off and add rows, then sign out resets everything', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (url.startsWith('/demo/seed.json')) return new Response(fs.readFileSync(SEED_FILE));
    if (url === '/api/demo') { const r = await call(JSON.parse(opts.body)); return new Response(JSON.stringify(r.body), {status: r.status}); }
    throw Error(`unexpected fetch ${url}`);
  };
  try {
    await startDemo();
    const {companies} = await demoApi('/api/companies');
    assert.deepEqual(companies.map(c => c.my_role), ['demo', 'demo', 'demo']);
    const usps = companies[0].id, nw = companies[1].id;
    assert.equal(companies[0].sample, 'usps');

    const up = await demoApi('/api/checks', {method: 'POST', body: {team_id: usps, filename: 'usps.csv', csv: USPS}});
    assert.equal(up.flag_count, 1);
    assert.equal((await demoApi(`/api/checks?team_id=${usps}`))[0].open_count, 1);
    await assert.rejects(demoApi('/api/sign-off', {method: 'POST', body: {dataset_id: up.dataset_id}}), {status: 409});
    await assert.rejects(demoApi(`/api/findings?id=${up.flags[0].id}`, {method: 'PATCH', body: {decision: 'no_change_needed'}}), {status: 422}); // a note is required
    await demoApi(`/api/findings?id=${up.flags[0].id}`, {method: 'PATCH', body: {decision: 'corrected'}});
    assert.equal((await demoApi(`/api/checks?dataset_id=${up.dataset_id}`)).summary.flags.by_status.confirmed, 1);
    assert.equal((await demoApi('/api/sign-off', {method: 'POST', body: {dataset_id: up.dataset_id}})).signoff.email, 'demo');

    // Northwind: the seeded error sheet has the 10 planted flags; adding January 2027 previews, then appends
    assert.equal((await demoApi(`/api/findings?team_id=${nw}&kind=flag`)).length, 10);
    const jan = fs.readFileSync(new URL('../data/synthetic/new-month-2027-01.csv', import.meta.url), 'utf8');
    const before = (await demoApi(`/api/company-data?team_id=${nw}`)).rows.length;
    const prev = await demoApi('/api/company-data', {method: 'POST', body: {team_id: nw, filename: 'jan.csv', csv: jan, confirm: false}});
    assert.equal((await demoApi(`/api/company-data?team_id=${nw}`)).rows.length, before); // a preview adds nothing
    await demoApi('/api/company-data', {method: 'POST', body: {team_id: nw, filename: 'jan.csv', csv: jan, confirm: true}});
    const after = (await demoApi(`/api/company-data?team_id=${nw}`)).rows;
    assert.equal(after.length, before + prev.count);
    assert.equal(typeof after.at(-1).computed.rollforward_ok, 'boolean');
    const s = await demoApi('/api/findings', {method: 'POST', body: {team_id: nw, record_id: after[0].record_id, column: 'revenue_usd', proposed_value: '1.00', reason: 'demo'}});
    assert.equal(s.kind, 'suggested_edit');
    await assert.rejects(demoApi('/api/ai-report', {method: 'POST', body: {dataset_id: up.dataset_id}}), {status: 503, code: 'demo_ai_off'});

    endDemo();
    await assert.rejects(demoApi('/api/companies'), {status: 401});
    await startDemo(); // like signing in again: nothing from the last session is left
    assert.equal((await demoApi(`/api/checks?team_id=${usps}`)).length, 0);
    assert.equal((await demoApi(`/api/company-data?team_id=${nw}`)).rows.length, before);
  } finally { endDemo(); globalThis.fetch = realFetch; }
});
