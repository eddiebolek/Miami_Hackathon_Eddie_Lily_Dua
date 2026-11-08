// Home dashboard: one card per section. Picking a card opens that section, and the tabs appear on top.
import {h, ctx, setView} from '../util.js';

const NS = 'http://www.w3.org/2000/svg';
// 24px line icons, drawn with the current text colour
const ICONS = {
  analysis: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
  add: ['M12 5v14', 'M5 12h14'],
  flags: ['M5 21V4', 'M5 4h11l-2 4 2 4H5'],
  ask: ['M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z'],
  sheet: ['M4 4h16v16H4Z', 'M4 10h16', 'M4 15h16', 'M10 4v16'],
  admin: ['M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M2 21a7 7 0 0 1 14 0', 'M17 4a4 4 0 0 1 0 7', 'M22 21a7 7 0 0 0-4-6.3'],
};
function icon(key) {
  const s = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false'})) s.setAttribute(k, v);
  for (const d of ICONS[key]) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
}

const ITEMS = [
  ['analysis', 'Analysis', 'Upload the company data file. Every variance, total and cash roll-forward is rechecked in code, with an AI write-up of what to look at first.'],
  ['add', 'Add data', 'Add new rows to the company dataset. Existing rows are never edited or deleted.'],
  ['flags', 'Flags', 'Every problem the checks found: the cell, what looks wrong, the suggested value and how it was worked out.'],
  ['ask', 'Ask', 'Ask a question about this company\'s data in plain English. Answers use numbers computed in code.'],
  ['sheet', 'Spreadsheet', 'Browse the data and suggest edits. Nothing changes until a person makes the change.'],
  ['admin', 'Admin', 'Choose who can see this company\'s data, and who manages people.'],
];

export function render() {
  const cards = ITEMS.filter(([k]) => k !== 'admin' || ctx.isOwner).map(([k, title, text], i) =>
    h('li', {style: `--i: ${i}`}, h('a', {class: 'dash-card', href: `#${k}`, 'aria-labelledby': `dash-${k}`, 'aria-describedby': `dash-${k}-d`},
      h('span', {class: 'dash-icon'}, icon(k)),
      h('h2', {id: `dash-${k}`}, title),
      h('p', {id: `dash-${k}-d`}, text),
      h('span', {class: 'dash-go', 'aria-hidden': 'true'}, 'Open ', h('span', {}, '→')))));
  setView('Home', h('div', {class: 'dash stack-lg'},
    h('div', {class: 'stack'}, h('h1', {}, ctx.team.name), h('p', {class: 'muted'}, 'Choose where to start. You can switch sections any time from the tabs at the top.')),
    h('ul', {class: 'dash-grid', 'aria-label': 'Sections'}, cards)));
}
