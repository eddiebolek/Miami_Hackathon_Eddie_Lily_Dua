import {h, ctx, api, q, setView, announce, money, fmt, period, label, sentence, plural, when, errMsg, autoRefresh, refreshBar} from '../util.js';

const INPUTS = ['revenue_usd', 'budget_revenue_usd', 'opex_usd', 'budget_opex_usd', 'opening_cash_usd', 'cash_receipts_usd', 'cash_operating_payments_usd', 'capex_usd', 'financing_usd', 'closing_cash_usd'];
// Column order on screen; 'v:' columns are computed by the server, not editable.
const COLS = ['revenue_usd', 'budget_revenue_usd', 'v:revenue_variance_usd', 'v:revenue_variance_pct', 'opex_usd', 'budget_opex_usd', 'v:opex_variance_usd', 'v:opex_variance_pct', 'opening_cash_usd', 'cash_receipts_usd', 'cash_operating_payments_usd', 'capex_usd', 'financing_usd', 'closing_cash_usd'];
const HEAD = {revenue_usd: 'Revenue', budget_revenue_usd: 'Budget revenue', revenue_variance_usd: 'Revenue variance $', revenue_variance_pct: 'Revenue variance %', opex_usd: 'Opex', budget_opex_usd: 'Budget opex', opex_variance_usd: 'Opex variance $', opex_variance_pct: 'Opex variance %',
  opening_cash_usd: 'Opening cash', cash_receipts_usd: 'Cash receipts', cash_operating_payments_usd: 'Operating payments', capex_usd: 'Capex', financing_usd: 'Financing', closing_cash_usd: 'Closing cash'};
const SUG_STATUS = {open: 'Open', confirmed: 'Acknowledged', dismissed: 'Declined'};

export async function render(_arg, sig) {
  let rows = [], sugs = [], datasetId = null, sel = null;
  const tbody = h('tbody');
  const panel = h('aside', {class: 'panel', 'aria-label': 'Suggest an edit', hidden: true});
  const split = h('div', {class: 'split'});
  const live = h('div', {'aria-live': 'polite'});
  const sugBox = h('div', {class: 'stack'});
  const empty = h('div', {class: 'zero', hidden: true}, h('p', {}, h('strong', {}, 'No company data yet.')), h('p', {}, 'Add the first rows on the Add data tab. This table then shows them with the variances and cash roll-forward check calculated in code.'), h('div', {}, h('a', {class: 'btn primary', href: '#add'}, 'Go to Add data')));
  const rb = refreshBar(() => load(true));
  const wrap = h('div', {class: 'table-wrap sheet-wrap', tabindex: '0', role: 'region', 'aria-label': 'Company data table, scrolls sideways'}, h('table', {class: 'sheet'},
    h('caption', {class: 'sr-only'}, 'Company data, one row per company per month. Variances and the roll-forward check are calculated by the checker.'),
    h('thead', {}, h('tr', {}, h('th', {scope: 'col', class: 'sticky'}, 'Company and month'), COLS.map(c => h('th', {scope: 'col', class: 'num'}, HEAD[c.replace('v:', '')])), h('th', {scope: 'col'}, 'Cash roll-forward'))), tbody));
  split.append(h('div', {class: 'stack'}, h('p', {class: 'hint legend'}, h('span', {class: 'swatch', 'aria-hidden': 'true'}), ' A corner mark means a suggested edit is open for that cell. Select any amount to suggest an edit. Arrow keys move between cells.'), wrap), panel);

  const openFor = (rid, col) => sugs.filter(s => s.review_status === 'open' && s.record_id === rid && s.column === col);

  function paintTable() {
    const had = tbody.contains(document.activeElement) && document.activeElement.dataset;
    const keep = had ? `${had.rid}|${had.col}` : null;
    const first = sel ? `${sel.rid}|${sel.col}` : keep;
    tbody.replaceChildren(...rows.map(r => {
      const tds = COLS.map(c => {
        if (c.startsWith('v:')) { const k = c.slice(2); return h('td', {class: 'num'}, money(r.computed?.[k], k, true)); }
        const open = openFor(r.record_id, c).length;
        const f = fmt(r[c], c, true);
        const b = h('button', {type: 'button', class: 'cellbtn num', 'data-rid': r.record_id, 'data-col': c, 'data-open': open ? '1' : null, tabindex: '-1',
          'aria-label': `${r.company_id} ${period(r.period)} ${label(c)}, ${f.sr}${open ? `, ${plural(open, 'open suggested edit')}` : ''}. Suggest an edit.`, onclick: () => choose(r, c)},
          h('span', {'aria-hidden': 'true'}, f.text));
        return h('td', {class: 'num'}, b);
      });
      return h('tr', {}, h('th', {scope: 'row', class: 'sticky'}, h('span', {class: 'mono'}, r.company_id), ' ', period(r.period), h('span', {class: 'caption rid mono'}, r.record_id)),
        tds, h('td', {}, r.computed?.rollforward_ok ? h('span', {class: 'badge ok'}, 'Matches') : h('span', {class: 'badge high'}, 'Mismatch')));
    }));
    const btns = [...tbody.querySelectorAll('.cellbtn')];
    const target = btns.find(b => `${b.dataset.rid}|${b.dataset.col}` === first) || btns[0];
    if (target) target.tabIndex = 0;
    if (keep) btns.find(b => `${b.dataset.rid}|${b.dataset.col}` === keep)?.focus();
  }
  tbody.addEventListener('keydown', e => {
    const move = {ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0]}[e.key];
    const here = document.activeElement;
    if (!here?.classList.contains('cellbtn') || !(move || e.key === 'Home' || e.key === 'End')) return;
    e.preventDefault();
    const grid = [...tbody.children].map(tr => [...tr.querySelectorAll('.cellbtn')]);
    const r = grid.findIndex(row => row.includes(here)), c = grid[r].indexOf(here);
    const nr = move ? Math.max(0, Math.min(grid.length - 1, r + move[0])) : r;
    const nc = move ? Math.max(0, Math.min(INPUTS.length - 1, c + move[1])) : e.key === 'Home' ? 0 : INPUTS.length - 1;
    tbody.querySelectorAll('.cellbtn').forEach(b => b.tabIndex = -1);
    const n = grid[nr][nc]; n.tabIndex = 0; n.focus();
  });

  function choose(r, col) {
    sel = {rid: r.record_id, col};
    tbody.querySelectorAll('.cellbtn').forEach(b => { b.tabIndex = b.dataset.rid === sel.rid && b.dataset.col === col ? 0 : -1; });
    split.classList.add('has-panel'); panel.hidden = false;
    paintPanel(r, col); panel.querySelector('h2').focus();
  }
  panel.addEventListener('keydown', e => { if (e.key === 'Escape' && sel) tbody.querySelector(`[data-rid="${CSS.escape(sel.rid)}"][data-col="${sel.col}"]`)?.focus(); });

  function paintPanel(r, col) {
    const cur = fmt(r[col], col);
    const value = h('input', {type: 'text', id: 'sg-val', inputmode: 'decimal', autocomplete: 'off', 'aria-describedby': 'sg-hint sg-err'});
    const reason = h('textarea', {id: 'sg-reason', maxlength: '500', 'aria-describedby': 'sg-count sg-err'});
    const count = h('p', {class: 'hint', id: 'sg-count'}, '0 of 500 characters');
    reason.addEventListener('input', () => { count.textContent = `${reason.value.length} of 500 characters`; });
    const err = h('p', {class: 'err-text', id: 'sg-err', role: 'alert'});
    const ok = h('p', {class: 'hint', role: 'status'});
    const submit = h('button', {type: 'submit', class: 'btn primary'}, 'Save suggestion');
    const mine = sugs.filter(s => s.record_id === r.record_id && s.column === col);
    const form = h('form', {class: 'stack', novalidate: true, onsubmit: async e => {
      e.preventDefault(); err.textContent = ''; ok.textContent = '';
      const v = value.value.trim().replace(/^\$/, '').replace(/,/g, '');
      if (!/^\d+(\.\d{1,2})?$/.test(v)) { err.textContent = 'Enter a plain amount like 1234.56 (no negative sign, up to 2 decimals).'; value.setAttribute('aria-invalid', 'true'); value.focus(); return; }
      value.removeAttribute('aria-invalid');
      if (!reason.value.trim()) { err.textContent = 'Add a reason (1 to 500 characters).'; reason.setAttribute('aria-invalid', 'true'); reason.focus(); return; }
      reason.removeAttribute('aria-invalid');
      submit.disabled = true; submit.textContent = 'Saving...';
      try {
        const s = await api('/api/findings', {method: 'POST', body: {team_id: ctx.team.id, record_id: r.record_id, column: col, proposed_value: v, reason: reason.value.trim()}});
        sugs.unshift(s); paintTable(); paintSugs(); paintPanel(r, col);
        panel.querySelector('[role=status]').textContent = 'Suggestion saved. The data was not changed.'; announce('Suggestion saved. The data was not changed.');
      } catch (x) { if (x.status !== 401) err.textContent = errMsg(x); submit.disabled = false; submit.textContent = 'Save suggestion'; }
    }},
      h('div', {class: 'field'}, h('label', {for: 'sg-val'}, 'Suggested value (USD)'), h('p', {class: 'hint', id: 'sg-hint'}, 'A plain amount like 1234.56.'), value),
      h('div', {class: 'field'}, h('label', {for: 'sg-reason'}, 'Reason'), reason, count), err,
      h('div', {class: 'actions'}, submit, ok));
    panel.replaceChildren(h('div', {class: 'panel-body'},
      h('h2', {tabindex: '-1'}, `Suggest an edit · ${sentence(col)}`),
      h('p', {class: 'mono hint'}, `${r.company_id} · ${period(r.period)} · record_id ${r.record_id} · row ${r.source_row} of the company data`),
      h('div', {class: 'vs'}, h('div', {class: 'box'}, h('div', {class: 'lab'}, 'Current value'), h('div', {class: 'val'}, money(r[col], col))), h('div', {class: 'box'}, h('div', {class: 'lab'}, 'Your suggestion'), h('div', {class: 'val'}, '-'))),
      mine.length ? h('div', {}, h('p', {class: 'sec-label'}, 'Earlier suggestions for this cell'), h('ul', {class: 'mini'}, mine.map(s => h('li', {}, money(s.proposed_value, col), ` · ${SUG_STATUS[s.review_status]} · ${s.by_email || ''}`)))) : null,
      form, h('p', {class: 'caption'}, 'A suggestion never changes the data. It is a note for a person, who makes any real change themselves.')));
  }

  const decide = async (s, decision, note) => {
    const out = await api(`/api/findings?id=${encodeURIComponent(s.id)}`, {method: 'PATCH', body: {decision, note}});
    Object.assign(s, out); paintTable(); paintSugs(); announce(`Suggestion ${SUG_STATUS[s.review_status].toLowerCase()}.`);
  };
  const dlgNote = h('textarea', {id: 'dc-note', maxlength: '500', 'aria-describedby': 'dc-err'});
  const dlgErr = h('p', {class: 'err-text', id: 'dc-err', role: 'alert'});
  let dlgFor = null;
  const dlg = h('dialog', {'aria-labelledby': 'dc-title'}, h('form', {class: 'stack', method: 'dialog', onsubmit: async e => {
    e.preventDefault(); dlgErr.textContent = '';
    if (!dlgNote.value.trim()) { dlgErr.textContent = 'Add a note saying why you decline.'; dlgNote.focus(); return; }
    try { await decide(dlgFor, 'no_change_needed', dlgNote.value.trim()); dlg.close(); } catch (x) { if (x.status !== 401) dlgErr.textContent = errMsg(x); }
  }}, h('h2', {id: 'dc-title'}, 'Decline this suggestion?'), h('p', {class: 'muted'}, 'Declining only records your decision. Nothing in the data changes.'),
    h('div', {class: 'field'}, h('label', {for: 'dc-note'}, 'Note (required)'), dlgNote), dlgErr,
    h('div', {class: 'actions'}, h('button', {type: 'submit', class: 'btn primary'}, 'Decline'), h('button', {type: 'button', class: 'btn', onclick: () => dlg.close()}, 'Cancel'))));

  function paintSugs() {
    sugBox.replaceChildren(h('h2', {}, 'Suggested edits'),
      h('p', {class: 'muted'}, 'Acknowledging means a person agrees and will make the change in the real data. Neither choice changes the data here.'),
      sugs.length ? h('div', {class: 'table-wrap'}, h('table', {},
        h('caption', {class: 'sr-only'}, 'Suggested edits, newest first'),
        h('thead', {}, h('tr', {}, ['Cell', 'Company and month'].map(t => h('th', {scope: 'col'}, t)), ['Current', 'Suggested'].map(t => h('th', {scope: 'col', class: 'num'}, t)), ['Reason', 'By', 'Status', 'Decision'].map(t => h('th', {scope: 'col'}, t)))),
        h('tbody', {}, sugs.map(s => { const r = rows.find(x => x.record_id === s.record_id);
          return h('tr', {}, h('th', {scope: 'row'}, h('span', {class: 'mono'}, s.record_id), ' ', sentence(s.column)), h('td', {}, r ? `${r.company_id} ${period(r.period)}` : ''),
            h('td', {class: 'num'}, money(s.current_value, s.column)), h('td', {class: 'num'}, money(s.proposed_value, s.column)),
            h('td', {class: 'note-cell'}, s.reason), h('td', {}, s.by_email || ''),
            h('td', {}, h('span', {class: `badge ${s.review_status === 'open' ? 'open' : s.review_status === 'confirmed' ? 'ok' : 'neutral'}`}, SUG_STATUS[s.review_status])),
            h('td', {}, s.review_status === 'open' ? h('div', {class: 'actions'},
              h('button', {type: 'button', class: 'btn', onclick: e => decide(s, 'corrected', '').catch(x => { if (x.status !== 401) e.target.after(h('span', {class: 'err-text', role: 'alert'}, errMsg(x))); })}, 'Acknowledge'),
              h('button', {type: 'button', class: 'btn', onclick: () => { dlgFor = s; dlgNote.value = ''; dlgErr.textContent = ''; dlg.showModal(); }}, 'Decline')) : (s.note ? `Note: ${s.note}` : '')));
        })))) : h('p', {class: 'hint'}, 'No suggestions yet.'), dlg);
  }

  async function load(manual) {
    rb.btn.disabled = true;
    try {
      const [cd, sg] = await Promise.all([api(`/api/company-data?${q({team_id: ctx.team.id})}`), api(`/api/findings?${q({team_id: ctx.team.id, kind: 'suggestion'})}`)]);
      if (sig.stale()) return;
      rows = cd.rows; datasetId = cd.dataset_id; sugs = sg; live.replaceChildren();
      const none = !rows.length; empty.hidden = !none; split.hidden = none;
      paintTable(); if (!dlg.open) paintSugs();
      rb.stamp.textContent = `Updated ${new Date(cd.updated_at).toLocaleTimeString('en-GB', {hour12: false})}`;
      if (manual) announce(`Refreshed: ${plural(rows.length, 'row')}.`);
    } catch (e) {
      if (sig.stale() || e.status === 401) return;
      live.replaceChildren(h('p', {class: 'err-text', role: 'alert'}, `${errMsg(e)}${rows.length ? ' Showing the last data.' : ''}`));
    } finally { rb.btn.disabled = false; }
  }

  setView('Spreadsheet', h('div', {class: 'head'}, h('div', {class: 'stack'}, h('h1', {}, 'Spreadsheet'),
    h('p', {class: 'muted'}, 'The company\'s saved data (the true copy). Variances and the cash roll-forward check are calculated in code. Existing rows are never edited here.')), rb.node),
  live, empty, split, h('div', {class: 'sugs'}, sugBox));
  empty.hidden = true; split.hidden = true;
  await load();
  return autoRefresh(() => load(false));
}
