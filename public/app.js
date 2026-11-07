import {createClient} from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

// ---------- tiny helpers (all text goes in via textContent / text nodes, never innerHTML) ----------
const $ = id => document.getElementById(id);
const main = $('main');
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
function h(tag, props = {}, ...kids) {
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
const announce = msg => { $('live').textContent = ''; setTimeout(() => { $('live').textContent = msg; }, 50); };
function banner(msg, retry) {
  const b = $('banner'); b.replaceChildren();
  if (!msg) { b.hidden = true; return; }
  b.append(h('span', {}, h('strong', {}, 'Problem: '), msg));
  if (retry) b.append(h('button', {type: 'button', class: 'btn', onclick: () => { banner(null); retry(); }}, 'Try again'));
  b.hidden = false;
}
function setView(title, ...nodes) {
  banner(null);
  main.replaceChildren(...nodes);
  document.title = `${title} · Sheet Check`;
  main.querySelector('h1')?.setAttribute('tabindex', '-1');
  main.querySelector('h1')?.focus({preventScroll: true});
  scrollTo(0, 0);
}
const when = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('en-US', {timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) + ' ET'; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const cleanName = n => String(n || '').replace(/ \d{4}-\d\d-\d\dT[\d:.]+Z$/, '');

// ---------- number display (strings from the API; BigInt cents so nothing is rounded by floats) ----------
const toCents = s => { const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(s ?? '').trim()); return m ? (m[1] ? -1n : 1n) * (BigInt(m[2]) * 100n + BigInt((m[3] || '').padEnd(2, '0'))) : null; };
const commas = s => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
function fmt(value, column, whole) {
  if (value == null || value === '') return {text: '(blank)', sr: 'blank'};
  const c = toCents(value);
  if (c == null) return {text: String(value), sr: String(value)};
  const neg = c < 0n, abs = neg ? -c : c;
  if (/pct|percent/.test(column || '')) { const t = `${neg ? '-' : ''}${commas(String(abs / 100n))}.${String(abs % 100n).padStart(2, '0')}%`; return {text: t, sr: t.replace('-', 'minus ').replace('%', ' percent')}; }
  const body = whole ? commas(String((abs + 50n) / 100n)) : `${commas(String(abs / 100n))}.${String(abs % 100n).padStart(2, '0')}`;
  return {text: `${neg ? '-' : ''}$${body}`, sr: `${neg ? 'minus ' : ''}${body} dollars`};
}
const money = (v, col, whole) => { const f = fmt(v, col, whole); return h('span', {class: 'num'}, h('span', {'aria-hidden': 'true'}, f.text), h('span', {class: 'sr-only'}, f.sr)); };
const label = s => String(s || '').replace(/_usd$/, '').replace(/_/g, ' ');
const sentence = s => { const t = label(s); return t.charAt(0).toUpperCase() + t.slice(1); };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const period = p => { const m = /^(\d{4})-(\d\d)$/.exec(p || ''); return m && MONTHS[+m[2] - 1] ? `${MONTHS[+m[2] - 1]} ${m[1]}` : (p || ''); };
const sev = f => f.severity === 'high' ? {cls: 'high', text: 'Mismatch'} : {cls: 'review', text: 'Needs review'};
const isMarked = f => f.review_status !== 'open';
function statusBadge(f) {
  if (f.decision === 'corrected') return h('span', {class: 'badge ok'}, 'Corrected');
  if (f.decision === 'no_change_needed') return h('span', {class: 'badge neutral'}, 'No change needed', f.note ? h('span', {class: 'sr-only'}, ' (has a note)') : null);
  return h('span', {class: 'badge open'}, 'Open');
}
const decisionText = f => f.decision === 'corrected' ? 'Corrected' : f.decision === 'no_change_needed' ? 'No change needed' : 'Open';

// ---------- state and API ----------
let sb, team = null, recent = [], cur = null, lastFile = null;
class ApiErr extends Error { constructor(status, err) { super(err?.message || 'Request failed'); this.status = status; this.code = err?.code; this.details = err?.details; } }
async function api(path, {method = 'GET', body} = {}) {
  const {data: {session}} = await sb.auth.getSession();
  const res = await fetch(path, {method, headers: {...(session ? {Authorization: `Bearer ${session.access_token}`} : {}), ...(body ? {'Content-Type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { if (res.status === 401) { await sb.auth.signOut().catch(() => {}); showSignin('Your session ended. Sign in again.'); } throw new ApiErr(res.status, json.error); }
  return json.data ?? json;
}
const netMsg = 'Could not reach the checker. Your file was not changed.';

// ---------- sign-in ----------
function showSignin(note) {
  $('topbar').hidden = true; team = null; cur = null;
  const err = h('p', {class: 'err-text', role: 'alert', id: 'si-err'}, note || '');
  const email = h('input', {type: 'email', id: 'si-email', autocomplete: 'username', required: true});
  const pass = h('input', {type: 'password', id: 'si-pass', autocomplete: 'current-password', required: true});
  const btn = h('button', {type: 'submit', class: 'btn primary block'}, 'Sign in');
  const form = h('form', {class: 'stack', novalidate: true, onsubmit: async e => {
    e.preventDefault();
    if (!email.value.trim() || !pass.value) { err.textContent = 'Enter your email and password.'; return; }
    btn.disabled = true; btn.textContent = 'Signing in...'; err.textContent = '';
    const {error} = await sb.auth.signInWithPassword({email: email.value.trim(), password: pass.value}).catch(() => ({error: {}}));
    btn.disabled = false; btn.textContent = 'Sign in';
    if (error) { err.textContent = 'That email or password is not right, or the service is unreachable. Try again.'; return; }
    afterSignIn();
  }},
    h('div', {class: 'field'}, h('label', {for: 'si-email'}, 'Email'), email),
    h('div', {class: 'field'}, h('label', {for: 'si-pass'}, 'Password'), pass),
    err, btn);
  setView('Sign in', h('div', {class: 'col-sm stack-lg'},
    h('div', {class: 'stack'}, h('p', {class: 'brand'}, 'Sheet Check'), h('h1', {}, 'Sign in'), h('p', {class: 'muted'}, 'Check a budget-vs-actual sheet before it goes out.')),
    h('div', {class: 'card'}, form),
    h('p', {class: 'caption'}, 'Demo data is fictional. The app recommends; you make the changes.')));
  email.focus();
}

async function afterSignIn() {
  setView('Loading', h('p', {class: 'muted', role: 'status'}, 'Loading your team...'));
  const {data, error} = await sb.from('rhb_teams').select('id,name');
  if (error) return showFatal('Could not load your team.');
  if (!data?.length) { $('topbar').hidden = false; $('team-name').textContent = ''; return setView('No team', h('div', {class: 'col-md stack'}, h('h1', {}, 'No team yet'), h('p', {}, 'Ask your team owner to add you.'))); }
  team = data[0];
  $('team-name').textContent = team.name;
  $('topbar').hidden = false;
  showUpload();
}
function showFatal(msg) { $('topbar').hidden = false; setView('Error', h('div', {class: 'col-md stack'}, h('h1', {}, 'Something went wrong'), h('p', {}, msg), h('button', {type: 'button', class: 'btn', onclick: afterSignIn}, 'Try again'))); }

// ---------- upload ----------
async function loadRecent() { try { recent = await api(`/api/checks?team_id=${encodeURIComponent(team.id)}`); } catch { recent = []; } }

async function showUpload() {
  cur = null;
  const status = h('div', {'aria-live': 'polite'});
  const input = h('input', {type: 'file', id: 'file', accept: '.csv,text/csv', class: 'sr-only', onchange: () => input.files[0] && run(input.files[0])});
  const drop = h('div', {class: 'drop'},
    h('p', {}, 'Drop a CSV here or'), h('label', {class: 'btn', for: 'file'}, 'Choose file'),
    h('p', {class: 'hint'}, 'USD, one row per company per month, plus a totals row per company. Max 1 MB.'));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files[0] && run(e.dataTransfer.files[0]); });
  const recentBox = h('div', {}, h('h2', {}, 'Recent checks'), h('p', {class: 'hint'}, 'Loading...'));
  setView('Check a spreadsheet', h('div', {class: 'col-md stack-lg'},
    h('h1', {}, 'Check a spreadsheet'), input, drop, status,
    h('p', {class: 'hint'}, 'Compared against: monthly_financials.csv (36 rows, 2026).'), recentBox));

  async function run(file) {
    lastFile = file; status.replaceChildren(); banner(null);
    if (file.size > 1_000_000) return problems(['That file is over 1 MB. Export just the one sheet as CSV.']);
    const csv = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(r.error); r.readAsText(file); }).catch(() => null);
    if (csv == null) return problems(['Could not read that file.']);
    drop.replaceChildren(h('p', {role: 'status'}, `Checking ${file.name}...`), reduce.matches ? null : h('div', {class: 'bar', 'aria-hidden': 'true'}));
    announce(`Checking ${file.name}`);
    try {
      const out = await api('/api/checks', {method: 'POST', body: {team_id: team.id, filename: file.name, csv}});
      await openDataset(out.dataset_id, {fresh: true});
    } catch (e) {
      showUpload.restore?.();
      if (e.status === 422) {
        const d = (e.details || []).map(x => [x.row != null ? `Row ${x.row}` : null, x.column ? `column ${x.column}` : null].filter(Boolean).join(', ') + (x.row != null || x.column ? ': ' : '') + x.message);
        problems(d.length ? d : [e.message]);
      } else if (e.status === 401) { /* sign-in view already shown */ }
      else problems([e.status ? e.message : netMsg], true);
    }
  }
  const idle = drop.cloneNode(true);
  showUpload.restore = () => { drop.replaceChildren(...idle.childNodes); input.value = ''; };
  function problems(list, retry) {
    status.replaceChildren(h('div', {class: 'problems', role: 'alert'},
      h('strong', {class: 'err-text'}, retry ? 'Could not check the file' : 'This file can not be checked yet. Fix these and choose it again:'),
      h('ul', {}, list.slice(0, 5).map(t => h('li', {}, t)), list.length > 5 ? h('li', {}, `+${list.length - 5} more`) : null),
      retry ? h('button', {type: 'button', class: 'btn', onclick: () => run(lastFile)}, 'Try again') : null));
  }

  await loadRecent();
  recentBox.replaceChildren(h('h2', {}, 'Recent checks'), recent.length
    ? h('ul', {class: 'recent'}, recent.map(r => h('li', {}, h('button', {type: 'button', onclick: () => openDataset(r.dataset_id)},
        h('span', {}, h('strong', {}, cleanName(r.name)), ' ', h('span', {class: 'caption'}, when(r.created_at))),
        h('span', {class: 'hint'}, `${plural(r.flag_count, 'flag')}, ${r.open_count} open`, r.signoff ? ' · signed off' : '')))))
    : h('p', {class: 'hint'}, 'No checks yet. Choose a CSV above to start.'));
}

// ---------- flags list + detail ----------
async function openDataset(id, {fresh} = {}) {
  setView('Loading', h('p', {class: 'muted', role: 'status'}, 'Opening check...'));
  try {
    const d = await api(`/api/checks?dataset_id=${encodeURIComponent(id)}`);
    cur = {id, dataset: d.dataset, flags: d.flags, filter: 'all', selected: null};
    if (!recent.length) await loadRecent();
    showFlags(fresh);
  } catch (e) { if (e.status !== 401) showFatalOpen(e, id); }
}
function showFatalOpen(e, id) { setView('Error', h('div', {class: 'col-md stack'}, h('h1', {}, 'Could not open this check'), h('p', {}, e.status ? e.message : netMsg), h('button', {type: 'button', class: 'btn', onclick: () => openDataset(id)}, 'Try again'))); }

const counts = flags => ({total: flags.length, high: flags.filter(f => f.severity === 'high').length, review: flags.filter(f => f.severity !== 'high').length, marked: flags.filter(isMarked).length, open: flags.filter(f => !isMarked(f)).length});

function showFlags(fresh) {
  const {flags, dataset} = cur;
  const summary = h('p', {class: 'summary'});
  const filters = h('div', {class: 'filters', role: 'group', 'aria-label': 'Filter flags'});
  const tbody = h('tbody');
  const panel = h('aside', {class: 'panel', 'aria-label': 'Flag details', hidden: true});
  const split = h('div', {class: 'split'});
  const tableWrap = h('div', {class: 'table-wrap'}, h('table', {},
    h('caption', {class: 'sr-only'}, 'Flags found in this sheet'),
    h('thead', {}, h('tr', {}, h('th', {scope: 'col'}, h('span', {class: 'sr-only'}, 'Severity')), ['Cell', 'Company', 'Period', 'What looks wrong'].map(t => h('th', {scope: 'col'}, t)),
      h('th', {scope: 'col', class: 'num'}, 'Sheet'), h('th', {scope: 'col', class: 'num'}, 'Suggested'), h('th', {scope: 'col'}, 'Status'))), tbody));
  const signoffBtn = h('button', {type: 'button', class: 'btn primary', onclick: showReport}, dataset.signoff ? 'View report' : 'Review report and sign off');

  function paintSummary() {
    const c = counts(flags);
    summary.textContent = `${cleanName(dataset.name)} · checked ${when(dataset.created_at)} · ${plural(c.total, 'flag')} (${c.high} Mismatch, ${c.review} Needs review) · ${c.marked} of ${c.total} marked${dataset.signoff ? ' · signed off' : ''}`;
    filters.replaceChildren(...[['all', `All ${c.total}`], ['open', `Open ${c.open}`], ['high', 'Mismatch'], ['review', 'Needs review']].map(([k, t]) =>
      h('button', {type: 'button', class: 'chip', 'aria-pressed': String(cur.filter === k), onclick: () => { cur.filter = k; paintSummary(); paintRows(); }}, t)));
  }
  const visible = () => flags.filter(f => cur.filter === 'all' || (cur.filter === 'open' ? !isMarked(f) : cur.filter === 'high' ? f.severity === 'high' : f.severity !== 'high'));
  function paintRows(focusId) {
    const list = visible();
    const active = list.find(f => f.id === cur.selected) || list[0];
    tbody.replaceChildren(...(list.length ? list.map(f => {
      const s = sev(f);
      const btn = h('button', {type: 'button', class: 'rowbtn', 'data-id': f.id, tabindex: f === active ? '0' : '-1', 'aria-label': `${f.cell}, ${s.text}, ${label(f.type)}`}, f.cell);
      return h('tr', {'aria-selected': String(f.id === cur.selected), onclick: () => select(f.id, true)},
        h('td', {class: 'stripe-cell', 'aria-hidden': 'true'}, h('span', {class: `stripe ${isMarked(f) ? '' : s.cls}`})),
        h('td', {}, btn), h('td', {class: 'mono'}, f.company_id || ''), h('td', {}, period(f.period)),
        h('td', {class: 'what'}, h('span', {class: `badge ${s.cls}`}, s.text), ' ', sentence(f.type)),
        h('td', {class: 'num'}, money(f.sheet_value, f.column, true)), h('td', {class: 'num'}, money(f.suggested_value, f.column, true)), h('td', {}, statusBadge(f)));
    }) : [h('tr', {}, h('td', {colspan: 8}, 'No flags match this filter.'))]));
    if (focusId) tbody.querySelector(`[data-id="${CSS.escape(focusId)}"]`)?.focus();
  }
  tbody.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const btns = [...tbody.querySelectorAll('.rowbtn')], i = btns.indexOf(document.activeElement);
    if (i < 0) return; e.preventDefault();
    const n = btns[Math.max(0, Math.min(btns.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    btns.forEach(b => b.tabIndex = -1); n.tabIndex = 0; n.focus();
  });
  panel.addEventListener('keydown', e => { if (e.key === 'Escape' && cur.selected) tbody.querySelector(`[data-id="${CSS.escape(cur.selected)}"]`)?.focus(); });

  function select(id, focus) {
    cur.selected = id;
    const f = flags.find(x => x.id === id);
    [...tbody.children].forEach(tr => tr.setAttribute('aria-selected', String(tr.querySelector('.rowbtn')?.dataset.id === id)));
    tbody.querySelectorAll('.rowbtn').forEach(b => b.tabIndex = b.dataset.id === id ? 0 : -1);
    split.classList.add('has-panel');
    panel.hidden = false;
    panel.replaceChildren(detail(f, {paintSummary, paintRows}));
    announce(`Showing flag ${f.cell}, ${sev(f).text}, ${label(f.type)}.`);
    if (focus) panel.querySelector('h2').focus();
  }

  split.append(h('div', {}, tableWrap), panel);
  const body = flags.length ? [filters, split] : [h('div', {class: 'zero', role: 'status'},
    h('p', {class: 'big'}, '0 flags'), h('p', {}, h('strong', {}, 'No mismatches found.'), ' Every variance, total and cash roll-forward in this sheet matches the source.'),
    h('div', {}, h('button', {type: 'button', class: 'btn primary', onclick: showReport}, 'Go to sign-off')))];
  setView('Flags', h('div', {class: 'head'}, h('div', {class: 'stack'}, h('h1', {}, flags.length ? 'Flags to review' : 'Sheet checked'), summary), signoffBtn), ...body);
  if (flags.length) { paintSummary(); paintRows(); } else paintSummary();
  if (fresh) announce(flags.length ? `Check complete: ${plural(flags.length, 'flag')} found.` : 'Check complete: no mismatches found.');
}

function detail(f, ui) {
  const s = sev(f);
  const statusHolder = h('span', {}, statusBadge(f));
  const saved = h('p', {class: 'hint', role: 'status'});
  const noteErr = h('p', {class: 'err-text', id: 'note-err'});
  const note = h('textarea', {id: 'note', maxlength: '1000', 'aria-describedby': 'note-hint note-err'}, f.note || '');
  const radio = (v, t) => h('label', {class: 'radio'}, h('input', {type: 'radio', name: 'decision', value: v, checked: f.decision === v}), t);
  const save = h('button', {type: 'submit', class: 'btn primary'}, 'Save decision');
  const form = h('form', {class: 'stack', novalidate: true, onsubmit: async e => {
    e.preventDefault();
    const d = form.querySelector('input[name=decision]:checked')?.value;
    noteErr.textContent = ''; note.removeAttribute('aria-invalid'); saved.textContent = '';
    if (!d) { noteErr.textContent = 'Choose Corrected or No change needed.'; return; }
    if (d === 'no_change_needed' && !note.value.trim()) { noteErr.textContent = 'Add a note saying why no change is needed.'; note.setAttribute('aria-invalid', 'true'); note.focus(); return; }
    save.disabled = true; save.textContent = 'Saving...';
    try {
      const out = await api(`/api/findings?id=${encodeURIComponent(f.id)}`, {method: 'PATCH', body: {decision: d, note: note.value}});
      Object.assign(f, out);
      statusHolder.replaceChildren(statusBadge(f));
      saved.textContent = `Saved: ${f.cell} marked ${decisionText(f).toLowerCase()}.`;
      ui.paintSummary(); ui.paintRows();
    } catch (err) { if (err.status !== 401) noteErr.textContent = err.status ? err.message : netMsg; }
    save.disabled = false; save.textContent = 'Save decision';
  }},
    h('fieldset', {}, h('legend', {}, 'Your decision'), radio('corrected', 'Corrected in my sheet'), radio('no_change_needed', 'No change needed'),
      h('div', {class: 'field'}, h('label', {for: 'note'}, 'Note'), h('p', {class: 'hint', id: 'note-hint'}, 'Required when no change is needed.'), note, noteErr)),
    h('div', {class: 'actions'}, save, saved));
  const rel = (f.related || []).map(r => h('div', {class: 'rel'}, h('div', {class: 'l'}, r.label), h('div', {}, h('span', {class: 'c'}, r.cell), ' ', period(r.period)),
    h('div', {}, 'Sheet ', money(r.sheet_value, r.column)), h('div', {class: 'l'}, 'Source ', money(r.source_value, r.column))));
  const rf = /^rollforward/.test(f.type);
  const here = h('div', {class: `rel ${rf ? 'this' : ''}`}, h('div', {class: 'l'}, 'This cell'), h('div', {}, h('span', {class: 'c'}, f.cell), ' ', period(f.period)), h('div', {}, 'Sheet ', money(f.sheet_value, f.column)));
  const src = f.source || {};
  return h('div', {class: 'panel-body'},
    h('div', {class: 'ptitle'}, h('span', {class: `badge ${s.cls}`}, s.text), statusHolder),
    h('h2', {tabindex: '-1'}, `Cell ${f.cell} · ${sentence(f.column || f.type)} · ${f.company_id || ''} · ${period(f.period)}`),
    h('div', {}, h('p', {class: 'sec-label'}, 'What looks wrong'), h('p', {}, f.explanation)),
    h('div', {class: 'vs'}, h('div', {class: 'box'}, h('div', {class: 'lab'}, 'In your sheet'), h('div', {class: 'val'}, money(f.sheet_value, f.column))),
      h('div', {class: 'box'}, h('div', {class: 'lab'}, 'Suggested value'), h('div', {class: 'val'}, money(f.suggested_value, f.column)))),
    f.calculation ? h('div', {}, h('p', {class: 'sec-label'}, 'How it was calculated'), h('p', {class: 'calc'}, f.calculation)) : null,
    h('div', {}, h('p', {class: 'sec-label'}, 'Source row'),
      h('p', {class: 'mono hint'}, `record_id ${src.record_id ?? f.record_id ?? ''} · row ${src.source_row ?? '?'} of ${String(src.file || 'monthly_financials.csv').split('/').pop()}`),
      src.row ? h('details', {class: 'source'}, h('summary', {}, 'View row'), h('dl', {}, Object.entries(src.row).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v == null || v === '' ? '(blank)' : String(v))]))) : null),
    (rel.length || rf) ? h('div', {}, h('p', {class: 'sec-label'}, 'Related cells'), h('div', {class: 'related'}, rf ? [...rel, here] : [here, ...rel])) : null,
    h('p', {class: 'caption'}, 'Suggestions only. This app never changes your spreadsheet; make the fix yourself, then record it here.'),
    form);
}

// ---------- report and sign-off ----------
function showReport() {
  const {flags, dataset} = cur;
  const c = counts(flags);
  const fixed = flags.filter(f => f.decision === 'corrected').length, nochange = flags.filter(f => f.decision === 'no_change_needed').length;
  const so = dataset.signoff;
  const others = recent.filter(r => r.dataset_id !== cur.id);
  let recheckId = so?.recheck_dataset_id || '';
  const recheckOut = h('p', {role: 'status'});
  const paintRecheck = () => {
    const r = recent.find(x => x.dataset_id === recheckId);
    const n = so ? so.recheck_flag_count : r?.flag_count;
    recheckOut.textContent = recheckId && n != null ? `Re-check of corrected file: ${plural(n, 'flag')}${r ? ` (${cleanName(r.name)}, ${when(r.created_at)})` : ''}` : '';
  };
  const select = h('select', {id: 'recheck', disabled: !!so, onchange: e => { recheckId = e.target.value; paintRecheck(); }},
    h('option', {value: ''}, 'None'), others.map(r => h('option', {value: r.dataset_id, selected: r.dataset_id === recheckId}, `${cleanName(r.name)} · ${when(r.created_at)} · ${plural(r.flag_count, 'flag')}`)));
  const signBtn = h('button', {type: 'button', class: 'btn primary', 'aria-disabled': String(!!so || c.open > 0), onclick: () => { if (so || c.open) { announce(so ? 'Already signed off.' : `${plural(c.open, 'flag')} still open.`); return; } dlg.showModal(); }}, so ? 'Signed off' : 'Sign off');

  const dlgErr = h('p', {class: 'err-text', role: 'alert'});
  const dlgNote = h('textarea', {id: 'so-note', maxlength: '1000'});
  const confirm = h('button', {type: 'submit', class: 'btn primary'}, 'Confirm sign-off');
  const dlg = h('dialog', {'aria-labelledby': 'so-title'}, h('form', {class: 'stack', method: 'dialog', onsubmit: async e => {
    e.preventDefault(); dlgErr.textContent = ''; confirm.disabled = true;
    try {
      await api('/api/sign-off', {method: 'POST', body: {dataset_id: cur.id, ...(recheckId ? {recheck_dataset_id: recheckId} : {}), note: dlgNote.value}});
      dlg.close(); await openDataset(cur.id); showReport(); announce('Report signed off.');
    } catch (err) { if (err.status !== 401) dlgErr.textContent = err.status ? err.message : netMsg; }
    confirm.disabled = false;
  }},
    h('h2', {id: 'so-title'}, 'Sign off this review?'),
    h('p', {}, `${plural(c.total, 'flag')}: ${fixed} Corrected, ${nochange} No change needed, ${c.open} open.`),
    h('div', {class: 'field'}, h('label', {for: 'so-note'}, 'Note (optional)'), dlgNote), dlgErr,
    h('div', {class: 'actions'}, confirm, h('button', {type: 'button', class: 'btn', onclick: () => dlg.close()}, 'Cancel'))));

  const rows = flags.map(f => h('tr', {}, h('td', {class: 'mono'}, f.cell), h('td', {}, h('span', {class: `badge ${sev(f).cls}`}, sev(f).text), ' ', sentence(f.type)),
    h('td', {class: 'num'}, money(f.sheet_value, f.column)), h('td', {class: 'num'}, money(f.suggested_value, f.column)), h('td', {}, statusBadge(f)), h('td', {class: 'note-cell'}, f.note || '')));
  setView('Review report', h('div', {class: 'col-lg stack-lg'},
    h('div', {class: 'rhead'}, h('div', {class: 'stack'}, h('h1', {}, `Review report · ${cleanName(dataset.name)}`), h('p', {class: 'summary'}, `Checked ${when(dataset.created_at)}`)),
      so ? h('p', {class: 'summary'}, h('span', {class: 'badge ok'}, 'Signed off'), ` by ${so.email || 'a team member'} · ${when(so.at)}`) : null),
    h('p', {class: 'stats'}, h('span', {}, h('b', {}, c.total), ' flags'), h('span', {}, '·'), h('span', {}, h('b', {}, fixed), ' Corrected'), h('span', {}, '·'), h('span', {}, h('b', {}, nochange), ' No change needed'), h('span', {}, '·'), h('span', {}, h('b', {}, c.open), ' open')),
    so?.note ? h('p', {}, `Sign-off note: ${so.note}`) : null,
    h('div', {class: 'field no-print'}, h('label', {for: 'recheck'}, 'Optional: re-check of your corrected file'), select,
      h('p', {class: 'hint'}, others.length ? 'Upload the corrected sheet first, then pick it here.' : 'No other uploads yet. Upload the corrected sheet from New check, then come back.')),
    recheckOut,
    flags.length ? h('div', {class: 'table-wrap'}, h('table', {class: 'report-table'}, h('caption', {class: 'sr-only'}, 'Every flag with its decision'),
      h('thead', {}, h('tr', {}, ['Cell', 'Issue'].map(t => h('th', {scope: 'col'}, t)), h('th', {scope: 'col', class: 'num'}, 'Sheet'), h('th', {scope: 'col', class: 'num'}, 'Suggested'), h('th', {scope: 'col'}, 'Decision'), h('th', {scope: 'col'}, 'Note'))), h('tbody', {}, rows)))
      : h('div', {class: 'zero'}, h('p', {class: 'big'}, '0 flags'), h('p', {}, 'No mismatches found in this sheet.')),
    h('div', {class: 'actions no-print'}, signBtn, h('button', {type: 'button', class: 'btn', onclick: () => print()}, 'Print report'), h('button', {type: 'button', class: 'btn', onclick: () => showFlags()}, 'Back to flags'),
      !so && c.open ? h('p', {class: 'err-text', role: 'status'}, `${plural(c.open, 'flag')} still open. Mark each one before signing off.`) : null),
    h('p', {class: 'caption'}, 'Calculations done in code from monthly_financials.csv. Demo data is fictional. This app only recommends; it never changes your spreadsheet.'),
    dlg));
  paintRecheck();
}

// ---------- start ----------
$('nav-upload').addEventListener('click', showUpload);
$('sign-out').addEventListener('click', async () => { await sb.auth.signOut().catch(() => {}); showSignin(); });
(async function init() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    if (!cfg.supabaseUrl || !cfg.publishableKey) throw new Error('missing config');
    sb = createClient(cfg.supabaseUrl, cfg.publishableKey);
  } catch { setView('Setup needed', h('div', {class: 'col-md stack'}, h('h1', {}, 'Setup needed'), h('p', {}, 'The app is not connected to its database yet. Check SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in .env, then reload.'))); return; }
  const {data: {session}} = await sb.auth.getSession();
  if (session) afterSignIn(); else showSignin();
})();
