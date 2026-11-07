import {h, ctx, api, setView, banner, announce, money, plural, period, sentence, sev, errMsg, detailLines, readFile, problemsBox, dropZone, matchColumns, templateLink} from '../util.js';

// Preview first, then an explicit "Add N rows" confirm. Existing rows are never changed.
export function render(_arg, sig) {
  const out = h('div', {class: 'stack-lg', 'aria-live': 'polite'});
  let file = null, csv = null, map = null;

  const dz = dropZone('add-file', pick, 'Same columns as the company data file. Max 1 MB. Only new months are accepted.');
  async function pick(f) {
    file = f; out.replaceChildren(); banner(null);
    if (f.size > 1_000_000) return out.append(problemsBox(['That file is over 1 MB.']));
    csv = await readFile(f).catch(() => null);
    if (csv == null) return out.append(problemsBox(['Could not read that file.']));
    matchColumns(csv, out, m => preview(f, m));
  }
  async function preview(f, m) {
    map = m; out.replaceChildren(); dz.busy(`Checking ${f.name}...`);
    try {
      const prev = await api('/api/company-data', {method: 'POST', body: {team_id: ctx.team.id, filename: f.name, csv, confirm: false, ...(map ? {mapping: map} : {})}});
      if (sig.stale()) return;
      dz.idle(); paintPreview(prev);
    } catch (e) {
      if (sig.stale()) return;
      dz.idle();
      if (e.status === 401) return;
      const d = detailLines(e);
      out.replaceChildren(problemsBox(d.length ? d : [errMsg(e)], e.status === 409
        ? {title: 'Some of these rows are already in the company data. Nothing was added.'}
        : e.status === 422 ? {} : {retry: () => preview(f, map), title: 'Could not check the file'}));
    }
  }

  function paintPreview({count, new_rows: rows, warnings}) {
    const add = h('button', {type: 'button', class: 'btn primary'}, `Add ${plural(count, 'row')}`);
    const status = h('p', {role: 'status', class: 'hint'});
    add.addEventListener('click', async () => {
      add.disabled = true; status.textContent = 'Adding...'; status.classList.remove('err-text');
      try {
        const r = await api('/api/company-data', {method: 'POST', body: {team_id: ctx.team.id, filename: file.name, csv, confirm: true, ...(map ? {mapping: map} : {})}});
        ctx.uploads = null;
        announce(`Added ${plural(r.added, 'row')}.`);
        out.replaceChildren(h('div', {class: 'zero', role: 'status'}, h('p', {}, h('strong', {}, `Added ${plural(r.added, 'row')}.`), ' The spreadsheet and summary now include them. Existing rows were not changed.'),
          h('div', {class: 'actions'}, h('a', {class: 'btn primary', href: '#sheet'}, 'Open spreadsheet'), h('a', {class: 'btn', href: '#analysis'}, 'Back to Analysis'))));
      } catch (e) {
        if (e.status === 401) return;
        add.disabled = false; status.classList.add('err-text');
        const d = detailLines(e); status.textContent = (d[0] && e.status !== 500 ? d[0] : errMsg(e));
      }
    });
    const warningsBox = warnings.length ? h('div', {class: 'stack'}, h('h3', {}, `${plural(warnings.length, 'flag')} would appear on these rows`),
        h('p', {class: 'muted'}, 'Adding is still allowed. These are mismatches the checker sees once the new rows are included; review them after adding.'),
        h('ul', {class: 'warns'}, warnings.map(w => h('li', {}, h('span', {class: `badge ${sev(w).cls}`}, sev(w).text), ' ', h('strong', {class: 'mono'}, w.cell || w.record_id), ' ', sentence(w.type), '. ', w.explanation))))
      : h('div', {class: 'zero', role: 'status'}, h('p', {}, h('strong', {}, 'No problems found.'), ' The new rows pass every check, including opening cash against last month\'s closing cash.'));
    out.replaceChildren(
      h('div', {class: 'stack'}, h('h2', {}, `Preview: ${plural(count, 'new row')}`),
        h('p', {class: 'muted'}, `${file.name}. Nothing is saved until you press "Add ${plural(count, 'row')}".`)),
      warningsBox,
      // Buttons sit above the table so a long preview (2,400 rows) never hides them.
      h('div', {class: 'actions'}, add, h('button', {type: 'button', class: 'btn', onclick: () => { out.replaceChildren(); file = csv = null; }}, 'Cancel'), status),
      h('div', {class: 'table-wrap'}, h('table', {},
        h('caption', {class: 'sr-only'}, 'New rows to add'),
        h('thead', {}, h('tr', {}, ['Record', 'Company', 'Period'].map(t => h('th', {scope: 'col'}, t)), ['Revenue', 'Opex', 'Opening cash', 'Closing cash'].map(t => h('th', {scope: 'col', class: 'num'}, t)))),
        h('tbody', {}, rows.map(r => h('tr', {}, h('th', {scope: 'row', class: 'mono'}, r.record_id), h('td', {class: 'mono'}, r.company_id), h('td', {}, period(r.period)),
          ['revenue_usd', 'opex_usd', 'opening_cash_usd', 'closing_cash_usd'].map(k => h('td', {class: 'num'}, money(r[k], k, true)))))))));
  }

  setView('Add data', h('div', {class: 'stack-lg'},
    h('div', {class: 'stack'}, h('h1', {}, 'Add data'),
      h('p', {class: 'muted'}, 'Add new rows (for example a new month) to the company\'s data. The checker validates them first and shows a preview. Existing rows are never edited or deleted.')),
    h('div', {class: 'col-md stack'}, dz.input, dz.drop, h('div', {class: 'actions'}, templateLink())), out));
}
