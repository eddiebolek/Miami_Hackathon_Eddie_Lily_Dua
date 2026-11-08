// Demo login (username demo, password demo): a stand-in for the /api endpoints that keeps everything in this tab's memory.
// It starts from public/demo/seed.json; uploads, added rows, decisions and sign-offs live only here, so signing out
// or refreshing the page throws them away. Exact math still runs in code on the server (api/demo.js), which saves nothing.
// Each handler mirrors the real one in api/ (same inputs, outputs and error codes), minus the database.
let S = null;

export class DemoError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
const fail = (status, code, message, details) => { throw new DemoError(status, code, message, details); };
const bad422 = bad => { if (bad.length) fail(422, 'invalid_request', bad.join(' '), bad.map(message => ({message}))); };

export async function startDemo() {
  const res = await fetch('/demo/seed.json', {cache: 'no-store'});
  if (!res.ok) throw Error('The demo data could not load.');
  S = await res.json();
}
export function endDemo() { S = null; }

async function compute(body) {
  const res = await fetch('/api/demo', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const json = await res.json().catch(() => ({}));
  if (!res.ok) fail(res.status, json.error?.code, json.error?.message || 'Request failed', json.error?.details);
  return json.data;
}

const now = () => new Date().toISOString();
const newest = (a, b) => String(b.created_at).localeCompare(String(a.created_at));
const flagRow = r => ({id: r.id, review_status: r.review_status, decision: r.review_status === 'confirmed' ? 'corrected' : r.review_status === 'dismissed' ? 'no_change_needed' : null, note: r.note, ...r.flag});
const team = id => S.teams.find(t => t.id === id) || fail(403, 'forbidden', 'You are not a member of that team.');
const copyOf = teamId => S.datasets.find(d => d.team_id === teamId && d.source === 'company data');
const upload = id => S.datasets.find(d => d.id === id && d.source === 'analyst upload');
const count = (list, key) => list.reduce((o, x) => { const k = key(x); o[k] = (o[k] ?? 0) + 1; return o; }, {});
const flagCounts = list => ({total: list.length, by_type: count(list, f => f.flag.type), by_severity: count(list, f => f.flag.severity), by_status: count(list, f => f.review_status)});
const fileOk = (bad, {filename, csv, mapping}) => {
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 200) bad.push('filename must be 1 to 200 characters.');
  if (typeof csv !== 'string' || !csv.trim() || new Blob([csv]).size > 1_000_000) bad.push('csv must be text, 1 MB or less.');
  if (mapping !== undefined && (!mapping || typeof mapping !== 'object' || Array.isArray(mapping))) bad.push('mapping must be an object.');
};
const AI_OFF = () => fail(503, 'demo_ai_off', 'AI is turned off for the demo login. Sign in with a team account to use it.');

const routes = {
  'GET /api/companies': () => ({is_dev: false, companies: S.teams.map(t => ({id: t.id, name: t.name, my_role: 'demo', sample: t.sample || null}))}),

  'GET /api/checks': q => {
    if (q.dataset_id) {
      const d = upload(q.dataset_id) || fail(404, 'not_found', 'Check not found.');
      const list = S.findings.filter(f => f.dataset_id === d.id);
      return {dataset: {id: d.id, name: d.name, created_at: d.created_at, signoff: d.signoff, ai_report: d.ai_report}, flags: list.map(flagRow), summary: {...d.summary, flags: flagCounts(list)}};
    }
    team(q.team_id);
    return S.datasets.filter(d => d.team_id === q.team_id && d.source === 'analyst upload').sort(newest).slice(0, 50).map(d => {
      const mine = S.findings.filter(f => f.dataset_id === d.id);
      return {dataset_id: d.id, name: d.name, created_at: d.created_at, flag_count: mine.length, open_count: mine.filter(f => f.review_status === 'open').length, signoff: d.signoff};
    });
  },
  'POST /api/checks': async (q, b) => {
    const bad = []; fileOk(bad, b); bad422(bad);
    team(b.team_id);
    const copy = copyOf(b.team_id)?.rows.map(r => r.payload) || [];
    const out = await compute({action: 'check', csv: b.csv, mapping: b.mapping, copy});
    const at = now(), {flags: _, ...summary} = out.summary;
    const d = {id: crypto.randomUUID(), team_id: b.team_id, name: `${b.filename.trim()} ${at}`, source: 'analyst upload', created_at: at, signoff: null, ai_report: null, mode: out.mode, summary};
    const saved = out.flags.map(f => ({id: crypto.randomUUID(), team_id: b.team_id, dataset_id: d.id, review_status: 'open', note: null, flag: f, method: 'deterministic', rule: f.type, created_at: at}));
    S.datasets.push(d); S.findings.push(...saved);
    return {dataset_id: d.id, mode: out.mode, flag_count: saved.length, flags: saved.map(flagRow), summary: out.summary};
  },

  'GET /api/findings': q => {
    team(q.team_id);
    return S.findings.filter(f => f.team_id === q.team_id && (!q.status || f.review_status === q.status) && (!q.dataset_id || f.dataset_id === q.dataset_id)
      && (!q.kind || (q.kind === 'flag' ? f.method === 'deterministic' : f.rule === 'suggested_edit')))
      .sort(newest).slice(0, 500).map(f => ({...flagRow(f), dataset_id: f.dataset_id, created_at: f.created_at}));
  },
  'PATCH /api/findings': (q, {decision, note}) => {
    const STATUS = {corrected: 'confirmed', no_change_needed: 'dismissed'}, bad = [];
    if (!STATUS[decision]) bad.push('decision must be "corrected" or "no_change_needed".');
    if (note != null && typeof note !== 'string') bad.push('note must be text.');
    if (typeof note === 'string' && note.length > 1000) bad.push('note must be 1000 characters or fewer.');
    if (decision === 'no_change_needed' && !(typeof note === 'string' && note.trim())) bad.push('A note is required when no change is needed.');
    bad422(bad);
    const f = S.findings.find(x => x.id === q.id) || fail(404, 'not_found', 'Flag not found, or you are not a member of its team.');
    f.review_status = STATUS[decision]; f.note = note?.trim() || null;
    return flagRow(f);
  },
  'POST /api/findings': (q, {team_id, record_id, column, proposed_value, reason}) => {
    const bad = [];
    if (typeof record_id !== 'string' || !record_id.trim() || record_id.length > 100) bad.push('record_id must be 1 to 100 characters.');
    if (!S.editable.includes(column)) bad.push(`column must be one of ${S.editable.join(', ')}.`);
    if (typeof proposed_value !== 'string' || !(String(column).includes('variance') ? /^-?\d+(\.\d{1,2})?$/ : /^\d+(\.\d{1,2})?$/).test(proposed_value)) bad.push('proposed_value must be a plain amount like 1234.56 (no commas or symbols).');
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) bad.push('reason must be 1 to 500 characters.');
    bad422(bad);
    team(team_id);
    const copy = copyOf(team_id), rec = copy?.rows.find(r => r.record_key === record_id) || fail(404, 'not_found', `Record ${record_id} is not in this company's data.`);
    const f = {id: crypto.randomUUID(), team_id, dataset_id: copy.id, review_status: 'open', note: null, method: 'human', rule: 'suggested_edit', created_at: now(),
      flag: {kind: 'suggested_edit', record_id, source_row: rec.source_row, column, current_value: rec.payload[column] ?? null, proposed_value, reason: reason.trim(), by_email: 'demo'}};
    S.findings.push(f);
    return {...flagRow(f), dataset_id: f.dataset_id, created_at: f.created_at};
  },

  'GET /api/company-data': q => {
    team(q.team_id);
    const copy = copyOf(q.team_id);
    return {dataset_id: copy?.id ?? null, rows: (copy?.rows || []).map(r => ({...r.payload, record_id: r.record_key, source_row: r.source_row, computed: r.computed})), updated_at: now()};
  },
  'POST /api/company-data': async (q, b) => {
    const bad = []; fileOk(bad, b);
    if (b.confirm !== undefined && typeof b.confirm !== 'boolean') bad.push('confirm must be true or false.');
    bad422(bad);
    team(b.team_id);
    let copy = copyOf(b.team_id);
    const out = await compute({action: 'add', csv: b.csv, mapping: b.mapping, records: (copy?.rows || []).map(({record_key, source_row, payload}) => ({record_key, source_row, payload}))});
    if (b.confirm !== true) return {count: out.count, new_rows: out.new_rows, warnings: out.warnings};
    if (!copy) S.datasets.push(copy = {id: crypto.randomUUID(), team_id: b.team_id, name: 'Company data', source: 'company data', created_at: now(), rows: []});
    copy.rows.push(...out.new_rows.map(({source_row, ...payload}, i) => ({record_key: payload.record_id, source_row, payload, computed: out.computed[i]})));
    return {added: out.count, dataset_id: copy.id};
  },

  'POST /api/map-columns': async (q, b) => { team(b.team_id); return compute({action: 'map', headers: b.headers}); },

  'POST /api/sign-off': (q, {dataset_id, recheck_dataset_id, note}) => {
    if (note != null && (typeof note !== 'string' || note.length > 1000)) bad422(['note must be text, 1000 characters or fewer.']);
    const d = upload(dataset_id) || fail(404, 'not_found', 'Check not found, or you are not a member of its team.');
    const open = S.findings.filter(f => f.dataset_id === d.id && f.review_status === 'open').length;
    if (open) fail(409, 'flags_open', `${open} flag${open > 1 ? 's are' : ' is'} still open. Mark each one corrected or no change needed first.`);
    if (recheck_dataset_id && !upload(recheck_dataset_id)) fail(404, 'not_found', 'Re-check not found.');
    d.signoff = {by: 'demo', email: 'demo', at: now(), note: note?.trim() || null, recheck_dataset_id: recheck_dataset_id || null,
      recheck_flag_count: recheck_dataset_id ? S.findings.filter(f => f.dataset_id === recheck_dataset_id).length : null};
    return {dataset_id: d.id, signoff: d.signoff};
  },

  'POST /api/ai-report': AI_OFF,
  'POST /api/chat': AI_OFF,
  'GET /api/members': () => [],
};
for (const k of ['POST /api/companies', 'POST /api/members', 'PATCH /api/members', 'DELETE /api/members'])
  routes[k] = () => fail(403, 'forbidden', 'The demo login cannot change companies or who has access.');

// Same contract as util.js api(): resolves with the response's data, or throws an error with status, code, message and details.
export async function demoApi(path, {method = 'GET', body} = {}) {
  if (!S) fail(401, 'unauthorized', 'The demo has ended. Sign in again.');
  const u = new URL(path, 'http://demo'), fn = routes[`${method} ${u.pathname}`];
  if (!fn) fail(404, 'not_found', 'No such endpoint.');
  // copies in and out, so a screen can never change the demo data without going through a handler
  return structuredClone(await fn(Object.fromEntries(u.searchParams), structuredClone(body ?? {})));
}
