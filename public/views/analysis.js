import {h, ctx, api, q, setView, banner, announce, reduce, money, plural, when, cleanName, errMsg, aiMsg, modeBadge, inferMode, aiLabel, loadUploads, detailLines, readFile, isExcel, requirementsBox, problemsBox, dropZone, matchColumns, templateLink, ApiErr} from '../util.js';

const MODE_TEXT = {
  source: 'This upload was compared with the company\'s saved true copy, so changed, mistyped and wrong-month numbers are caught as well as math errors.',
  internal: 'No saved company data to compare with yet. The checker ran everything that needs only this file: math, totals, cash roll-forward, duplicates and missing months.'
};

export async function render(openId, sig) {
  const status = h('div', {'aria-live': 'polite'});
  const result = h('section', {'aria-label': 'Analysis result'});
  const recentBox = h('div', {}, h('h2', {}, 'Past uploads'), h('p', {class: 'hint'}, 'Loading...'));
  let lastFile = null, lastCsv = null, lastMap = null;

  const dz = dropZone('file', run, 'USD, one row per company per month. Max 1 MB.');
  const reqs = requirementsBox();
  async function run(file) {
    lastFile = file; status.replaceChildren(); banner(null); reqs.open = false;
    if (file.size > 1_000_000) return problems(['That file is over 1 MB. Export just the one sheet as CSV.']);
    const csv = await readFile(file).catch(() => null);
    if (csv == null) return problems(['Could not read that file.']);
    lastCsv = csv;
    matchColumns(csv, status, m => send(file, csv, m), {force: isExcel(file)});
  }
  async function send(file, csv, mapping) {
    lastFile = file; lastCsv = csv; lastMap = mapping; status.replaceChildren(); banner(null);
    dz.busy(`Checking ${file.name}...`); announce(`Checking ${file.name}`);
    try {
      const out = await api('/api/checks', {method: 'POST', body: {team_id: ctx.team.id, filename: file.name, csv, ...(mapping ? {mapping} : {})}});
      ctx.modes[out.dataset_id] = out.mode; ctx.uploads = null;
      announce(out.flag_count ? `Check complete: ${plural(out.flag_count, 'flag')} found.` : 'Check complete: no mismatches found.');
      location.hash = `#analysis/${out.dataset_id}`;
    } catch (e) {
      dz.idle();
      if (e.status === 401) return;
      if (e.status === 422) { const d = detailLines(e); problems(d.length ? d : [e.message]); } else problems([errMsg(e)], true);
    }
  }
  function problems(list, retry) { status.replaceChildren(problemsBox(list, {retry: retry && (() => send(lastFile, lastCsv, lastMap)), title: retry ? 'Could not check the file' : undefined})); }

  setView('Analysis', h('div', {class: 'stack-lg'},
    h('div', {class: 'stack'}, h('h1', {}, 'Analysis'),
      h('p', {class: 'muted'}, 'Upload the full company data file. The checker recomputes every variance, total and cash roll-forward in code, then you can ask the AI to write up what to look at first.')),
    h('div', {class: 'col-md stack'}, dz.input, dz.drop, h('div', {class: 'actions'}, templateLink()), reqs, status), result, recentBox));

  loadUploads(true).then(list => {
    if (sig.stale()) return;
    recentBox.replaceChildren(h('h2', {}, 'Past uploads'), list.length
      ? h('ul', {class: 'recent'}, list.map(r => h('li', {}, h('a', {href: `#analysis/${r.dataset_id}`, 'aria-current': r.dataset_id === openId ? 'true' : null},
          h('span', {}, h('strong', {}, cleanName(r.name)), ' ', h('span', {class: 'caption'}, when(r.created_at))),
          h('span', {class: 'hint'}, `${plural(r.flag_count, 'flag')}, ${r.open_count} open`, r.signoff ? ' · signed off' : '')))))
      : h('p', {class: 'hint'}, 'No uploads yet. Choose a CSV above to start.'));
  }).catch(() => {});

  if (!openId) { result.append(h('p', {class: 'hint'}, 'Choose a file above, or open a past upload below, to see its analysis.')); return; }
  result.replaceChildren(h('p', {class: 'muted', role: 'status'}, 'Opening analysis...'));
  try {
    const d = await api(`/api/checks?${q({dataset_id: openId})}`);
    if (sig.stale()) return;
    paintResult(result, openId, d);
  } catch (e) { if (!sig.stale() && e.status !== 401) result.replaceChildren(problemsBox([errMsg(e)], {retry: () => render(openId, sig), title: 'Could not open this upload'})); }
}

function stat(n, text, cls) { return h('div', {class: `stat ${cls || ''}`}, h('div', {class: 'big'}, String(n)), h('div', {class: 'lab'}, text)); }

function paintResult(root, id, {dataset, flags, summary}) {
  const mode = ctx.modes[id] || inferMode(flags);
  const bySev = summary?.flags?.by_severity || {}, byStatus = summary?.flags?.by_status || {};
  const total = summary?.flags?.total ?? flags.length;
  const cos = summary?.companies || [];
  const aiBox = h('div', {class: 'ai-panel'});
  root.replaceChildren(h('div', {class: 'stack-lg'},
    h('div', {class: 'stack'},
      h('h2', {}, cleanName(dataset.name)),
      h('p', {class: 'summary'}, `Checked ${when(dataset.created_at)}${dataset.signoff ? ' · signed off' : ''}`),
      mode ? h('div', {class: 'mode'}, modeBadge(mode), h('p', {class: 'hint'}, MODE_TEXT[mode])) : h('p', {class: 'hint'}, 'Check mode is shown for uploads checked in this session.')),
    h('div', {class: 'stats-row', role: 'group', 'aria-label': 'Flag counts, calculated by the checker'},
      stat(total, plural(total, 'flag').replace(/^\d+ /, ''), total ? '' : 'ok'), stat(bySev.high ?? 0, 'Mismatch', 'high'), stat(total - (bySev.high ?? 0), 'Needs review', 'review'), stat(byStatus.open ?? 0, 'Open', '')),
    total ? null : h('div', {class: 'zero', role: 'status'}, h('p', {}, h('strong', {}, 'No mismatches found.'), ' Every variance, total and roll-forward checked matches.')),
    cos.length ? h('div', {class: 'stack'}, h('h3', {}, 'Company summary'),
      h('p', {class: 'summary'}, `${cos.length.toLocaleString('en-US')} ${cos.length === 1 ? 'company' : 'companies'} · ${cos.reduce((t, c) => t + c.months, 0).toLocaleString('en-US')} rows checked · one row per company below`),
      h('div', {class: 'table-wrap'}, h('table', {},
        h('caption', {class: 'sr-only'}, 'Totals and variances per company, calculated by the checker in code'),
        h('thead', {}, h('tr', {}, h('th', {scope: 'col'}, 'Company'), h('th', {scope: 'col', class: 'num'}, 'Months'), h('th', {scope: 'col'}, 'Through'),
          ['Revenue', 'Budget revenue', 'Revenue variance', 'Opex', 'Budget opex', 'Opex variance', 'Closing cash'].map(t => h('th', {scope: 'col', class: 'num'}, t)))),
        h('tbody', {}, cos.map(c => h('tr', {}, h('th', {scope: 'row', class: 'mono'}, c.company_id), h('td', {class: 'num'}, String(c.months)), h('td', {}, c.latest_period),
          ['revenue_usd', 'budget_revenue_usd', 'revenue_variance_usd', 'opex_usd', 'budget_opex_usd', 'opex_variance_usd', 'closing_cash_usd'].map(k => h('td', {class: 'num'}, money(c[k], k, true)))))))),
      h('p', {class: 'caption'}, 'Totals are over every month in the upload. Calculated by the checker in code.')) : null,
    h('div', {class: 'actions'},
      total ? h('a', {class: 'btn primary', href: `#flags/${id}`}, `Review ${plural(total, 'flag')}`) : null,
      h('a', {class: 'btn', href: `#report/${id}`}, dataset.signoff ? 'View report' : 'Review report and sign off')),
    aiBox));
  paintAi(aiBox, id, dataset.ai_report, flags);
}

function paintAi(box, id, report, flags) {
  const off = ctx.aiEnabled === false;
  const live = h('p', {class: 'hint', role: 'status'});
  const btn = h('button', {type: 'button', class: 'btn', disabled: off, onclick: async () => {
    btn.disabled = true; live.textContent = 'Writing the report. This can take up to a minute...'; live.classList.remove('err-text');
    try {
      const out = await api('/api/ai-report', {method: 'POST', body: {dataset_id: id}});
      paintAi(box, id, out.ai_report || out, flags); announce('AI report written.');
    } catch (e) { if (e.status === 401) return; btn.disabled = false; live.textContent = aiMsg(e); live.classList.add('err-text'); }
  }}, report ? 'Write it again' : 'Write AI report');
  const body = [];
  if (report) {
    const cell = k => flags.find(f => f.key === k)?.cell || k;
    const pr = Array.isArray(report.priorities) ? report.priorities : [];
    const removed = Array.isArray(report.removed) ? report.removed.length : Number(report.removed) || 0;
    body.push(
      report.headline ? h('p', {class: 'ai-headline'}, report.headline) : null,
      pr.length ? h('ol', {class: 'priorities'}, pr.map(p => h('li', {},
        h('strong', {}, p.title), h('p', {}, p.why), p.action ? h('p', {}, h('span', {class: 'sec-label'}, 'What to check: '), p.action) : null,
        Array.isArray(p.flag_keys) && p.flag_keys.length ? h('p', {class: 'hint'}, 'Flags: ', p.flag_keys.map((k, i) => [i ? ', ' : '', h('a', {href: `#flags/${id}`, class: 'mono'}, cell(k))])) : null))) : h('p', {}, 'The AI found nothing that needs priority attention.'),
      Array.isArray(report.caveats) && report.caveats.length ? h('div', {}, h('p', {class: 'sec-label'}, 'Caveats'), h('ul', {}, report.caveats.map(c => h('li', {}, String(c))))) : null,
      removed ? h('p', {class: 'hint'}, `${plural(removed, 'statement')} hidden because they contained numbers the checker did not produce.`) : null,
      h('p', {class: 'caption'}, [report.model ? `Model: ${report.model}` : null, report.at ? `written ${when(report.at)}` : null].filter(Boolean).join(' · ')));
  } else body.push(h('p', {class: 'hint'}, off ? 'AI is off for this deployment. Everything else works.' : 'The AI reads only the checker\'s results and writes what an analyst should look at first. It never does the math.'));
  box.replaceChildren(h('h3', {}, 'AI report'), aiLabel(), ...body, h('div', {class: 'actions'}, btn, live));
}
