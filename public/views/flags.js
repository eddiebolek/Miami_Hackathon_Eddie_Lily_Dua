import {h, ctx, api, q, setView, announce, money, plural, period, label, sentence, sev, isMarked, statusBadge, decisionText, when, cleanName, errMsg, loadUploads, autoRefresh, refreshBar} from '../util.js';

// Every flag across all of the company's uploads. Filters run in the browser on one fetched list.
export async function render(uploadId, sig) {
  const st = {status: 'all', sev: 'all', type: 'all', upload: uploadId || 'all', selected: null};
  let flags = [], uploads = [];
  const summary = h('p', {class: 'summary'});
  const chips = h('div', {class: 'filters', role: 'group', 'aria-label': 'Filter flags'});
  const typeSel = h('select', {id: 'f-type', onchange: e => { st.type = e.target.value; paint(); }});
  const upSel = h('select', {id: 'f-up', onchange: e => { st.upload = e.target.value; paint(); }});
  const tbody = h('tbody');
  const panel = h('aside', {class: 'panel', 'aria-label': 'Flag details', hidden: true});
  const split = h('div', {class: 'split'});
  const reportLink = h('a', {class: 'btn primary', href: '#report', hidden: true}, 'Review report and sign off');
  const rb = refreshBar(() => load(true));
  const live = h('div', {'aria-live': 'polite'});
  const tableWrap = h('div', {class: 'table-wrap'}, h('table', {},
    h('caption', {class: 'sr-only'}, 'Flags found across all uploads'),
    h('thead', {}, h('tr', {}, h('th', {scope: 'col'}, h('span', {class: 'sr-only'}, 'Severity')), ['Cell', 'Company', 'Period', 'What looks wrong', 'Upload'].map(t => h('th', {scope: 'col'}, t)),
      h('th', {scope: 'col', class: 'num'}, 'Sheet'), h('th', {scope: 'col', class: 'num'}, 'Suggested'), h('th', {scope: 'col'}, 'Status'))), tbody));
  split.append(h('div', {}, tableWrap), panel);
  const nameOf = id => cleanName(uploads.find(u => u.dataset_id === id)?.name || 'Upload');

  const match = f => (st.status === 'all' || (st.status === 'open' ? !isMarked(f) : st.status === 'corrected' ? f.decision === 'corrected' : f.decision === 'no_change_needed'))
    && (st.sev === 'all' || (st.sev === 'high') === (f.severity === 'high')) && (st.type === 'all' || f.type === st.type) && (st.upload === 'all' || f.dataset_id === st.upload);
  const visible = () => flags.filter(match);

  // Chips are built once and only updated, so keyboard focus stays on the chip you pressed.
  const CHIPS = [['status', 'all', n => `All ${n.all}`], ['status', 'open', n => `Open ${n.open}`], ['status', 'corrected', n => `Corrected ${n.corrected}`], ['status', 'no_change', n => `No change needed ${n.no_change}`],
    null, ['sev', 'all', () => 'Any severity'], ['sev', 'high', () => 'Mismatch'], ['sev', 'review', () => 'Needs review']];
  const chipBtns = CHIPS.map(c => c ? h('button', {type: 'button', class: 'chip', onclick: () => { st[c[0]] = c[1]; paint(); }}) : h('span', {class: 'chip-sep', 'aria-hidden': 'true'}));
  chips.append(...chipBtns);
  function paintChips() {
    const scoped = flags.filter(f => st.upload === 'all' || f.dataset_id === st.upload);
    const n = {all: scoped.length, open: scoped.filter(f => !isMarked(f)).length, corrected: scoped.filter(f => f.decision === 'corrected').length, no_change: scoped.filter(f => f.decision === 'no_change_needed').length};
    CHIPS.forEach((c, i) => { if (!c) return; chipBtns[i].textContent = c[2](n); chipBtns[i].setAttribute('aria-pressed', String(st[c[0]] === c[1])); });
  }
  function paintSummary() {
    const s = flags.filter(f => st.upload === 'all' || f.dataset_id === st.upload);
    const hi = s.filter(f => f.severity === 'high').length, marked = s.filter(isMarked).length;
    summary.textContent = `${plural(s.length, 'flag')} (${hi} Mismatch, ${s.length - hi} Needs review) · ${marked} of ${s.length} marked${st.upload !== 'all' ? ` · ${nameOf(st.upload)}` : ' · all uploads'}`;
    reportLink.hidden = st.upload === 'all'; reportLink.href = `#report/${st.upload}`;
  }
  function paint() {
    // keep the filter values valid, then redraw the controls and rows
    const types = [...new Set(flags.map(f => f.type))].sort();
    if (st.type !== 'all' && !types.includes(st.type)) st.type = 'all';
    if (document.activeElement !== typeSel && document.activeElement !== upSel) {
    typeSel.replaceChildren(h('option', {value: 'all'}, 'All types'), types.map(t => h('option', {value: t, selected: t === st.type}, sentence(t))));
    upSel.replaceChildren(h('option', {value: 'all'}, 'All uploads'), uploads.map(u => h('option', {value: u.dataset_id, selected: u.dataset_id === st.upload}, `${cleanName(u.name)} · ${when(u.created_at)}`)));
    upSel.value = st.upload; typeSel.value = st.type;
    }
    paintChips(); paintSummary(); paintRows();
  }
  function paintRows(focusId) {
    const list = visible();
    const active = list.find(f => f.id === st.selected) || list[0];
    tbody.replaceChildren(...(list.length ? list.map(f => {
      const s = sev(f);
      const btn = h('button', {type: 'button', class: 'rowbtn', 'data-id': f.id, tabindex: f === active ? '0' : '-1', 'aria-label': `${f.cell}, ${s.text}, ${label(f.type)}`}, f.cell);
      return h('tr', {'aria-selected': String(f.id === st.selected), onclick: () => select(f.id, true)},
        h('td', {class: 'stripe-cell', 'aria-hidden': 'true'}, h('span', {class: `stripe ${isMarked(f) ? '' : s.cls}`})),
        h('td', {}, btn), h('td', {class: 'mono'}, f.company_id || ''), h('td', {}, period(f.period)),
        h('td', {class: 'what'}, h('span', {class: `badge ${s.cls}`}, s.text), ' ', sentence(f.type)),
        h('td', {class: 'upl'}, nameOf(f.dataset_id)),
        h('td', {class: 'num'}, money(f.sheet_value, f.column, true)), h('td', {class: 'num'}, money(f.suggested_value, f.column, true)), h('td', {}, statusBadge(f)));
    }) : [h('tr', {}, h('td', {colspan: 9}, flags.length ? 'No flags match these filters.' : 'No flags yet. Upload a file on the Analysis tab.'))]));
    if (focusId) tbody.querySelector(`[data-id="${CSS.escape(focusId)}"]`)?.focus();
  }
  tbody.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const btns = [...tbody.querySelectorAll('.rowbtn')], i = btns.indexOf(document.activeElement);
    if (i < 0) return; e.preventDefault();
    const n = btns[Math.max(0, Math.min(btns.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    btns.forEach(b => b.tabIndex = -1); n.tabIndex = 0; n.focus();
  });
  panel.addEventListener('keydown', e => { if (e.key === 'Escape' && st.selected) tbody.querySelector(`[data-id="${CSS.escape(st.selected)}"]`)?.focus(); });
  function select(id, focus) {
    st.selected = id;
    const f = flags.find(x => x.id === id);
    if (!f) return;
    [...tbody.children].forEach(tr => tr.setAttribute('aria-selected', String(tr.querySelector('.rowbtn')?.dataset.id === id)));
    tbody.querySelectorAll('.rowbtn').forEach(b => b.tabIndex = b.dataset.id === id ? 0 : -1);
    split.classList.add('has-panel'); panel.hidden = false;
    panel.replaceChildren(detail(f, {saved: (out) => { Object.assign(f, out); paint(); }}));
    announce(`Showing flag ${f.cell}, ${sev(f).text}, ${label(f.type)}.`);
    if (focus) panel.querySelector('h2').focus();
  }

  async function load(manual) {
    rb.btn.disabled = true;
    try {
      const [fl, up] = await Promise.all([api(`/api/findings?${q({team_id: ctx.team.id, kind: 'flag'})}`), loadUploads(true)]);
      if (sig.stale()) return;
      flags = fl; uploads = up; live.replaceChildren();
      paint(); rb.mark();
      if (manual) announce(`Flags refreshed: ${plural(flags.length, 'flag')}.`);
    } catch (e) {
      if (sig.stale() || e.status === 401) return;
      live.replaceChildren(h('p', {class: 'err-text', role: 'alert'}, `${errMsg(e)} Showing the last list.`));
    } finally { rb.btn.disabled = false; }
  }

  setView('Flags', h('div', {class: 'head'}, h('div', {class: 'stack'}, h('h1', {}, 'Flags'), summary), h('div', {class: 'actions'}, reportLink, rb.node)),
    live, h('div', {class: 'filters'}, chips),
    h('div', {class: 'filter-selects'}, h('div', {class: 'field'}, h('label', {for: 'f-up'}, 'Upload'), upSel), h('div', {class: 'field'}, h('label', {for: 'f-type'}, 'Type'), typeSel)),
    split);
  summary.textContent = 'Loading...';
  await load();
  return autoRefresh(() => load(false));
}

export function detail(f, ui) {
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
      ui.saved(out);
    } catch (err) { if (err.status !== 401) noteErr.textContent = errMsg(err); }
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
      h('p', {class: 'mono hint'}, `record_id ${src.record_id ?? f.record_id ?? ''} · row ${src.source_row ?? '?'} of ${String(src.file || 'the source').split('/').pop()}`),
      src.row ? h('details', {class: 'source'}, h('summary', {}, 'View row'), h('dl', {}, Object.entries(src.row).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v == null || v === '' ? '(blank)' : String(v))]))) : null),
    (rel.length || rf) ? h('div', {}, h('p', {class: 'sec-label'}, 'Related cells'), h('div', {class: 'related'}, rf ? [...rel, here] : [here, ...rel])) : null,
    h('p', {class: 'caption'}, 'Suggestions only. This app never changes your spreadsheet; make the fix yourself, then record it here.'),
    form);
}
