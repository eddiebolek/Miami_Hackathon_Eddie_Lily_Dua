// Shared helpers for every view. All text goes into the page through textContent / text nodes, never innerHTML.
export const $ = id => document.getElementById(id);
export const reduce = matchMedia('(prefers-reduced-motion: reduce)');
export const ctx = {sb: null, team: null, teams: [], isOwner: false, isDev: false, role: null, reloadTeams: async () => {}, aiEnabled: true, uploads: null, modes: {}, chats: {}, onAuthLost: () => {}};

export function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
export const announce = msg => { const l = $('live'); l.textContent = ''; setTimeout(() => { l.textContent = msg; }, 50); };
export function banner(msg, retry) {
  const b = $('banner'); b.replaceChildren();
  if (!msg) { b.hidden = true; return; }
  b.append(h('span', {}, h('strong', {}, 'Problem: '), msg));
  if (retry) b.append(h('button', {type: 'button', class: 'btn', onclick: () => { banner(null); retry(); }}, 'Try again'));
  b.hidden = false;
}
// Replace the page content. Pass {focus:false} for background repaints so keyboard focus is not stolen.
export function setView(title, ...nodes) {
  banner(null);
  const main = $('main');
  main.replaceChildren(...nodes);
  document.title = `${title} · Tally`;
  const h1 = main.querySelector('h1');
  h1?.setAttribute('tabindex', '-1');
  h1?.focus({preventScroll: true});
  scrollTo(0, 0);
}

// ---------- formatting ----------
export const when = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('en-US', {timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) + ' ET'; };
export const clock = (d = new Date()) => d.toLocaleTimeString('en-GB', {hour12: false});
export const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
export const cleanName = n => String(n || '').replace(/ \d{4}-\d\d-\d\dT[\d:.]+Z$/, '');
// Money arrives as strings; BigInt cents so nothing is rounded by floating point.
export const toCents = s => { const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(s ?? '').trim()); return m ? (m[1] ? -1n : 1n) * (BigInt(m[2]) * 100n + BigInt((m[3] || '').padEnd(2, '0'))) : null; };
const commas = s => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export function fmt(value, column, whole) {
  if (value == null || value === '') return {text: '(blank)', sr: 'blank'};
  const c = toCents(value);
  if (c == null) return {text: String(value), sr: String(value)};
  const neg = c < 0n, abs = neg ? -c : c;
  if (/pct|percent/.test(column || '')) { const t = `${neg ? '-' : ''}${commas(String(abs / 100n))}.${String(abs % 100n).padStart(2, '0')}%`; return {text: t, sr: t.replace('-', 'minus ').replace('%', ' percent')}; }
  const body = whole ? commas(String((abs + 50n) / 100n)) : `${commas(String(abs / 100n))}.${String(abs % 100n).padStart(2, '0')}`;
  return {text: `${neg ? '-' : ''}$${body}`, sr: `${neg ? 'minus ' : ''}${body} dollars`};
}
export const money = (v, col, whole) => { const f = fmt(v, col, whole); return h('span', {class: 'num'}, h('span', {'aria-hidden': 'true'}, f.text), h('span', {class: 'sr-only'}, f.sr)); };
export const label = s => String(s || '').replace(/_usd$/, '').replace(/_/g, ' ');
export const sentence = s => { const t = label(s); return t.charAt(0).toUpperCase() + t.slice(1); };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const period = p => { const m = /^(\d{4})-(\d\d)$/.exec(p || ''); return m && MONTHS[+m[2] - 1] ? `${MONTHS[+m[2] - 1]} ${m[1]}` : (p || ''); };
export const sev = f => f.severity === 'high' ? {cls: 'high', text: 'Mismatch'} : {cls: 'review', text: 'Needs review'};
export const isMarked = f => f.review_status !== 'open';
export function statusBadge(f) {
  if (f.decision === 'corrected') return h('span', {class: 'badge ok'}, 'Corrected');
  if (f.decision === 'no_change_needed') return h('span', {class: 'badge neutral'}, 'No change needed', f.note ? h('span', {class: 'sr-only'}, ' (has a note)') : null);
  return h('span', {class: 'badge open'}, 'Open');
}
export const decisionText = f => f.decision === 'corrected' ? 'Corrected' : f.decision === 'no_change_needed' ? 'No change needed' : 'Open';
export function modeBadge(mode) {
  return mode === 'source' ? h('span', {class: 'badge ok'}, 'Compared with true copy')
    : mode === 'internal' ? h('span', {class: 'badge neutral'}, 'Internal checks only') : null;
}
// A flag came from a true-copy comparison when it names the file it was compared with.
export const inferMode = flags => flags.some(f => f.source?.file) ? 'source' : flags.length ? 'internal' : null;
export const aiLabel = () => h('p', {class: 'ai-label'}, h('span', {class: 'badge ai'}, 'AI'), ' AI-written. Numbers come from the checker.');

// ---------- API ----------
export class ApiErr extends Error { constructor(status, err) { super(err?.message || 'Request failed'); this.status = status; this.code = err?.code; this.details = err?.details; } }
export const netMsg = 'Could not reach the checker. Your file was not changed.';
export const errMsg = e => e.status ? e.message : netMsg;
export const aiMsg = e => e.status === 503 ? "AI isn't set up yet; everything else works." : e.status === 429 ? 'Daily AI limit reached. Try again tomorrow.' : e.status === 502 ? `The AI could not answer this time. ${e.message}` : errMsg(e);
export async function api(path, {method = 'GET', body} = {}) {
  const {data: {session}} = await ctx.sb.auth.getSession();
  const res = await fetch(path, {method, headers: {...(session ? {Authorization: `Bearer ${session.access_token}`} : {}), ...(body ? {'Content-Type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { if (res.status === 401) { await ctx.sb.auth.signOut().catch(() => {}); ctx.onAuthLost('Your session ended. Sign in again.'); } throw new ApiErr(res.status, json.error); }
  return json.data ?? json;
}
export const q = obj => Object.entries(obj).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
export async function loadUploads(force) {
  if (ctx.uploads && !force) return ctx.uploads;
  try { ctx.uploads = await api(`/api/checks?${q({team_id: ctx.team.id})}`); } catch (e) { if (!ctx.uploads) ctx.uploads = []; if (e.status === 401) throw e; }
  return ctx.uploads;
}
// Validation details -> readable lines ("Row 9, column Actual: ...").
export const detailLines = e => (e.details || []).map(x => [x.row != null ? `Row ${x.row}` : null, x.column ? `column ${x.column}` : null].filter(Boolean).join(', ') + (x.row != null || x.column ? ': ' : '') + x.message);
export const readFile = file => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(r.error); r.readAsText(file); });

export function problemsBox(list, {retry, title} = {}) {
  return h('div', {class: 'problems', role: 'alert'},
    h('strong', {class: 'err-text'}, title || (retry ? 'Could not finish' : 'This file can not be used yet. Fix these and choose it again:')),
    h('ul', {}, list.slice(0, 5).map(t => h('li', {}, t)), list.length > 5 ? h('li', {}, `+${list.length - 5} more`) : null),
    retry ? h('button', {type: 'button', class: 'btn', onclick: retry}, 'Try again') : null);
}

// File drop zone shared by Analysis and Add data. Calls onFile(file) with a File.
export function dropZone(id, onFile, hint) {
  const input = h('input', {type: 'file', id, accept: '.csv,text/csv', class: 'sr-only', onchange: () => { if (input.files[0]) onFile(input.files[0]); input.value = ''; }});
  const idle = () => [h('p', {}, 'Drop a CSV here or'), h('label', {class: 'btn', for: id}, 'Choose file'), h('p', {class: 'hint'}, hint)];
  const drop = h('div', {class: 'drop'}, ...idle());
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); });
  return {input, drop, busy: text => drop.replaceChildren(h('p', {role: 'status'}, text), reduce.matches ? null : h('div', {class: 'bar', 'aria-hidden': 'true'})), idle: () => drop.replaceChildren(...idle())};
}

// Run fn every `ms` while the browser tab is visible; catch up when it becomes visible again. Returns a stop function.
export function autoRefresh(fn, ms = 60000) {
  let last = Date.now();
  const tick = () => { if (document.visibilityState === 'visible') { last = Date.now(); fn(); } };
  const timer = setInterval(tick, ms);
  const vis = () => { if (document.visibilityState === 'visible' && Date.now() - last >= ms) tick(); };
  document.addEventListener('visibilitychange', vis);
  return () => { clearInterval(timer); document.removeEventListener('visibilitychange', vis); };
}
export const refreshBar = (onClick) => {
  const stamp = h('span', {class: 'hint'});
  const btn = h('button', {type: 'button', class: 'btn', onclick: onClick}, 'Refresh');
  return {node: h('div', {class: 'refresh'}, btn, stamp), stamp, btn, mark: () => { stamp.textContent = `Updated ${clock()}`; }};
};

// ---------- column matching ----------
// Our column names (same list as lib/checker.js). The page only offers choices; the server parses every value.
const OURS = ['record_id', 'company_id', 'period', 'currency', 'revenue_usd', 'budget_revenue_usd', 'revenue_variance_usd', 'revenue_variance_pct', 'opex_usd', 'budget_opex_usd', 'opex_variance_usd', 'opex_variance_pct', 'opening_cash_usd', 'cash_receipts_usd', 'cash_operating_payments_usd', 'capex_usd', 'financing_usd', 'closing_cash_usd'];
const OPTIONAL = ['revenue_variance_usd', 'revenue_variance_pct', 'opex_variance_usd', 'opex_variance_pct'];
const REQ = OURS.filter(c => !['record_id', 'currency', ...OPTIONAL].includes(c));
const LABEL = {record_id: 'Record id (made up if blank)', currency: 'Currency'};
export const templateLink = () => h('a', {class: 'btn', href: '/template.csv', download: 'tally-template.csv'}, 'Download template');

// First n records of a CSV as arrays of strings (quotes and embedded commas handled).
function firstRecords(text, n) {
  const out = []; let row = [], f = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length && out.length < n; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; out.push(row); row = []; }
    else f += c;
  }
  if (out.length < n && (f || row.length)) { row.push(f); out.push(row); }
  return out;
}

// Calls onReady(null) when the headers already match ours, otherwise shows a "Match your columns" table in `mount`
// and calls onReady({columns, assume_usd}) once the person confirms it.
export async function matchColumns(csv, mount, onReady) {
  const [headers = [], sample = []] = firstRecords(csv, 2);
  if (OURS.filter(c => !OPTIONAL.includes(c)).every(c => headers.includes(c))) return onReady(null);
  if (!headers.length || headers.some(x => !x)) return onReady(null); // the server explains a bad header row
  let suggestion = {mapping: {}, ai: []};
  mount.replaceChildren(h('p', {role: 'status', class: 'hint'}, 'Looking at your column names...'));
  try { suggestion = await api('/api/map-columns', {method: 'POST', body: {team_id: ctx.team.id, headers: headers.slice(0, 60), sample_rows: []}}); } catch (e) { if (e.status === 401) return; }
  const selects = headers.map(x => {
    const s = h('select', {'aria-label': `Our column for "${x}"`}, h('option', {value: ''}, 'Do not use'),
      OURS.map(c => h('option', {value: c}, `${LABEL[c] || c}${REQ.includes(c) ? ' (required)' : ''}`)));
    s.value = suggestion.mapping?.[x] || ''; s.addEventListener('change', update); return s;
  });
  const usd = h('input', {type: 'checkbox', id: 'is-usd'}); usd.addEventListener('change', update);
  const usdRow = h('label', {class: 'check', for: 'is-usd'}, usd, ' This file is in US dollars');
  const msg = h('p', {class: 'hint', role: 'status'});
  const go = h('button', {type: 'button', class: 'btn primary', disabled: true, onclick: () => {
    go.disabled = true; onReady({columns: Object.fromEntries(headers.map((x, i) => [x, selects[i].value || null])), assume_usd: usd.checked || undefined});
  }}, 'Check file');
  function update() {
    const picked = selects.map(s => s.value).filter(Boolean);
    const dup = picked.find((c, i) => picked.indexOf(c) !== i);
    const lacking = REQ.filter(c => !picked.includes(c));
    const hasCur = picked.includes('currency');
    usdRow.hidden = hasCur;
    const why = dup ? `${dup} is chosen twice. Match each of our columns once.` : lacking.length ? `Still to match: ${lacking.join(', ')}.` : !hasCur && !usd.checked ? 'Confirm the file is in US dollars.' : '';
    msg.textContent = why; go.disabled = Boolean(why);
  }
  mount.replaceChildren(h('div', {class: 'stack'}, h('h2', {}, 'Match your columns'),
    h('p', {class: 'muted'}, 'Your column names differ from ours. Check each match, fix any that are wrong, then check the file. Values are read by code, never by AI.'),
    h('div', {class: 'table-wrap'}, h('table', {}, h('caption', {class: 'sr-only'}, 'Match each column in your file to one of ours'),
      h('thead', {}, h('tr', {}, ['Your column', 'Example value', 'Our column'].map(t => h('th', {scope: 'col'}, t)))),
      h('tbody', {}, headers.map((x, i) => h('tr', {}, h('th', {scope: 'row'}, x), h('td', {class: 'mono'}, sample[i] ?? ''),
        h('td', {}, selects[i], suggestion.ai?.includes(x) ? h('span', {class: 'hint'}, ' Suggested by AI') : null)))))),
    usdRow, msg, h('div', {class: 'actions'}, go)));
  update();
}
