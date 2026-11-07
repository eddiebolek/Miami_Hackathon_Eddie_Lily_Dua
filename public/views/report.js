import {h, ctx, api, q, setView, announce, money, plural, when, cleanName, sentence, sev, isMarked, statusBadge, errMsg, loadUploads, modeBadge, inferMode} from '../util.js';

const counts = flags => ({total: flags.length, open: flags.filter(f => !isMarked(f)).length});

export async function render(id, sig) {
  if (!id) { location.hash = '#flags'; return; }
  setView('Review report', h('p', {class: 'muted', role: 'status'}, 'Opening report...'));
  try {
    const [d, uploads] = await Promise.all([api(`/api/checks?${q({dataset_id: id})}`), loadUploads(true)]);
    if (sig.stale()) return;
    paint(id, d.dataset, d.flags, uploads);
  } catch (e) {
    if (sig.stale() || e.status === 401) return;
    setView('Error', h('div', {class: 'col-md stack'}, h('h1', {}, 'Could not open this report'), h('p', {}, errMsg(e)), h('button', {type: 'button', class: 'btn', onclick: () => render(id, sig)}, 'Try again')));
  }
}

function paint(id, dataset, flags, uploads) {
  const c = counts(flags);
  const fixed = flags.filter(f => f.decision === 'corrected').length, nochange = flags.filter(f => f.decision === 'no_change_needed').length;
  const so = dataset.signoff;
  const others = uploads.filter(r => r.dataset_id !== id);
  let recheckId = so?.recheck_dataset_id || '';
  const recheckOut = h('p', {role: 'status'});
  const paintRecheck = () => {
    const r = uploads.find(x => x.dataset_id === recheckId);
    const n = so ? so.recheck_flag_count : r?.flag_count;
    recheckOut.textContent = recheckId && n != null ? `Re-check of corrected file: ${plural(n, 'flag')}${r ? ` (${cleanName(r.name)}, ${when(r.created_at)})` : ''}` : '';
  };
  const pick = h('select', {id: 'recheck', disabled: !!so, onchange: e => { recheckId = e.target.value; paintRecheck(); }},
    h('option', {value: ''}, 'None'), others.map(r => h('option', {value: r.dataset_id, selected: r.dataset_id === recheckId}, `${cleanName(r.name)} · ${when(r.created_at)} · ${plural(r.flag_count, 'flag')}`)));
  const signBtn = h('button', {type: 'button', class: 'btn primary', 'aria-disabled': String(!!so || c.open > 0), onclick: () => { if (so || c.open) { announce(so ? 'Already signed off.' : `${plural(c.open, 'flag')} still open.`); return; } dlg.showModal(); }}, so ? 'Signed off' : 'Sign off');

  const dlgErr = h('p', {class: 'err-text', role: 'alert'});
  const dlgNote = h('textarea', {id: 'so-note', maxlength: '1000'});
  const confirm = h('button', {type: 'submit', class: 'btn primary'}, 'Confirm sign-off');
  const dlg = h('dialog', {'aria-labelledby': 'so-title'}, h('form', {class: 'stack', method: 'dialog', onsubmit: async e => {
    e.preventDefault(); dlgErr.textContent = ''; confirm.disabled = true;
    try {
      await api('/api/sign-off', {method: 'POST', body: {dataset_id: id, ...(recheckId ? {recheck_dataset_id: recheckId} : {}), note: dlgNote.value}});
      dlg.close(); ctx.uploads = null; location.hash.endsWith(id) && render(id, {stale: () => !location.hash.endsWith(id)}); announce('Report signed off.');
    } catch (err) { if (err.status !== 401) dlgErr.textContent = errMsg(err); }
    confirm.disabled = false;
  }},
    h('h2', {id: 'so-title'}, 'Sign off this review?'),
    h('p', {}, `${plural(c.total, 'flag')}: ${fixed} Corrected, ${nochange} No change needed, ${c.open} open.`),
    h('div', {class: 'field'}, h('label', {for: 'so-note'}, 'Note (optional)'), dlgNote), dlgErr,
    h('div', {class: 'actions'}, confirm, h('button', {type: 'button', class: 'btn', onclick: () => dlg.close()}, 'Cancel'))));

  const rows = flags.map(f => h('tr', {}, h('td', {class: 'mono'}, f.cell), h('td', {}, h('span', {class: `badge ${sev(f).cls}`}, sev(f).text), ' ', sentence(f.type)),
    h('td', {class: 'num'}, money(f.sheet_value, f.column)), h('td', {class: 'num'}, money(f.suggested_value, f.column)), h('td', {}, statusBadge(f)), h('td', {class: 'note-cell'}, f.note || '')));
  const mode = ctx.modes[id] || inferMode(flags);
  setView('Review report', h('div', {class: 'col-lg stack-lg'},
    h('div', {class: 'rhead'}, h('div', {class: 'stack'}, h('h1', {}, `Review report · ${cleanName(dataset.name)}`), h('p', {class: 'summary'}, `Checked ${when(dataset.created_at)}`), mode ? modeBadge(mode) : null),
      so ? h('p', {class: 'summary'}, h('span', {class: 'badge ok'}, 'Signed off'), ` by ${so.email || 'a team member'} · ${when(so.at)}`) : null),
    h('p', {class: 'stats'}, h('span', {}, h('b', {}, c.total), ' flags'), h('span', {}, '·'), h('span', {}, h('b', {}, fixed), ' Corrected'), h('span', {}, '·'), h('span', {}, h('b', {}, nochange), ' No change needed'), h('span', {}, '·'), h('span', {}, h('b', {}, c.open), ' open')),
    so?.note ? h('p', {}, `Sign-off note: ${so.note}`) : null,
    h('div', {class: 'field no-print'}, h('label', {for: 'recheck'}, 'Optional: re-check of your corrected file'), pick,
      h('p', {class: 'hint'}, others.length ? 'Upload the corrected sheet on the Analysis tab first, then pick it here.' : 'No other uploads yet. Upload the corrected sheet on the Analysis tab, then come back.')),
    recheckOut,
    flags.length ? h('div', {class: 'table-wrap'}, h('table', {class: 'report-table'}, h('caption', {class: 'sr-only'}, 'Every flag with its decision'),
      h('thead', {}, h('tr', {}, ['Cell', 'Issue'].map(t => h('th', {scope: 'col'}, t)), h('th', {scope: 'col', class: 'num'}, 'Sheet'), h('th', {scope: 'col', class: 'num'}, 'Suggested'), h('th', {scope: 'col'}, 'Decision'), h('th', {scope: 'col'}, 'Note'))), h('tbody', {}, rows)))
      : h('div', {class: 'zero'}, h('p', {class: 'big'}, '0 flags'), h('p', {}, 'No mismatches found in this sheet.')),
    h('div', {class: 'actions no-print'}, signBtn, h('button', {type: 'button', class: 'btn', onclick: () => print()}, 'Print report'), h('a', {class: 'btn', href: `#flags/${id}`}, 'Back to flags'),
      !so && c.open ? h('p', {class: 'err-text', role: 'status'}, `${plural(c.open, 'flag')} still open. Mark each one before signing off.`) : null),
    h('p', {class: 'caption'}, 'Calculations done in code from the uploaded file. Demo data is fictional. This app only recommends; it never changes your spreadsheet.'),
    dlg));
  paintRecheck();
}
