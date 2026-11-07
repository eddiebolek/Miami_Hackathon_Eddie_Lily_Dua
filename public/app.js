import {createClient} from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
import {$, h, ctx, api, q, setView, banner} from './util.js';
import * as analysis from './views/analysis.js';
import * as add from './views/add.js';
import * as flags from './views/flags.js';
import * as ask from './views/ask.js';
import * as sheet from './views/sheet.js';
import * as admin from './views/admin.js';
import {newCompanyForm} from './views/admin.js';
import * as report from './views/report.js';

const TABS = [['analysis', 'Analysis'], ['add', 'Add data'], ['flags', 'Flags'], ['ask', 'Ask'], ['sheet', 'Spreadsheet'], ['admin', 'Admin']];
const VIEWS = {analysis, add, flags, ask, sheet, admin, report};
const TEAM_KEY = 'sheetcheck.team';
let nav = 0, stop = null, tabs = [];

// ---------- sign-in ----------
function showSignin(note) {
  $('topbar').hidden = true; $('tabbar').hidden = true; $('main').removeAttribute('aria-labelledby'); ctx.team = null; nav++; stop?.(); stop = null;
  const err = h('p', {class: 'err-text', role: 'alert', id: 'si-err'}, note || '');
  const email = h('input', {type: 'email', id: 'si-email', autocomplete: 'username', required: true});
  const pass = h('input', {type: 'password', id: 'si-pass', autocomplete: 'current-password', required: true});
  const btn = h('button', {type: 'submit', class: 'btn primary block'}, 'Sign in');
  const form = h('form', {class: 'stack', novalidate: true, onsubmit: async e => {
    e.preventDefault();
    if (!email.value.trim() || !pass.value) { err.textContent = 'Enter your email and password.'; return; }
    btn.disabled = true; btn.textContent = 'Signing in...'; err.textContent = '';
    const {error} = await ctx.sb.auth.signInWithPassword({email: email.value.trim(), password: pass.value}).catch(() => ({error: {}}));
    btn.disabled = false; btn.textContent = 'Sign in';
    if (error) { err.textContent = 'That email or password is not right, or the service is unreachable. Try again.'; return; }
    afterSignIn();
  }},
    h('div', {class: 'field'}, h('label', {for: 'si-email'}, 'Email'), email),
    h('div', {class: 'field'}, h('label', {for: 'si-pass'}, 'Password'), pass),
    err, btn);
  setView('Sign in', h('div', {class: 'col-sm stack-lg'},
    h('div', {class: 'stack'}, h('p', {class: 'brand'}, 'Sheet Check'), h('h1', {}, 'Sign in'), h('p', {class: 'muted'}, 'Check a company\'s budget-vs-actual data before it goes out.')),
    h('div', {class: 'card'}, form),
    h('p', {class: 'caption'}, 'Demo data is fictional. The app recommends; you make the changes.')));
  email.focus();
}
ctx.onAuthLost = showSignin;
ctx.reloadTeams = id => afterSignIn(id);
// the skip link would change the hash and trigger the router, so focus main directly
document.querySelector('.skip').addEventListener('click', e => { e.preventDefault(); $('main').focus(); });

function showFatal(msg) {
  $('topbar').hidden = false; $('tabbar').hidden = true;
  setView('Error', h('div', {class: 'col-md stack'}, h('h1', {}, 'Something went wrong'), h('p', {}, msg), h('button', {type: 'button', class: 'btn', onclick: () => afterSignIn()}, 'Try again')));
}

async function afterSignIn(pickId) {
  setView('Loading', h('p', {class: 'muted', role: 'status'}, 'Loading your companies...'));
  let data;
  try { const r = await api('/api/companies'); data = r.companies; ctx.isDev = r.is_dev; } catch (e) { if (e.status === 401) return; return showFatal('Could not load your companies.'); }
  $('topbar').hidden = false;
  if (!data?.length && ctx.isDev) { $('tabbar').hidden = true; $('team-pick').replaceChildren(); ctx.team = null; return setView('New company', h('div', {class: 'col-md stack'}, h('h1', {}, 'Create the first company'), newCompanyForm(id => afterSignIn(id)))); }
  if (!data?.length) { $('tabbar').hidden = true; $('team-pick').replaceChildren(); return setView('No company', h('div', {class: 'col-md stack'}, h('h1', {}, 'No company yet'), h('p', {}, 'Ask the account owner to add you to a company.'))); }
  ctx.teams = data;
  let saved = null; try { saved = localStorage.getItem(TEAM_KEY); } catch { /* storage can be blocked */ }
  const pick = $('team-pick');
  pick.replaceChildren(...data.map(t => h('option', {value: t.id}, t.name)));
  pick.hidden = data.length < 2; $('team-name').hidden = data.length > 1; $('team-name').textContent = data[0].name;
  await selectTeam(data.find(t => t.id === (pickId || saved)) || data[0]);
}

async function selectTeam(t) {
  ctx.team = t; ctx.uploads = null; $('team-pick').value = t.id; $('team-name').textContent = t.name;
  try { localStorage.setItem(TEAM_KEY, t.id); } catch { /* optional */ }
  ctx.role = t.my_role; ctx.isOwner = t.my_role === 'admin' || t.my_role === 'developer';
  let badge = $('role-badge');
  if (!badge) { badge = h('span', {id: 'role-badge', class: 'badge neutral'}); $('team-name').after(badge); }
  badge.textContent = {developer: 'Developer', admin: 'Admin', analyst: 'Analyst'}[t.my_role] || '';
  buildTabs();
  if (!location.hash || location.hash === '#') location.hash = '#analysis'; else route();
}

// ---------- tabs and routing ----------
function buildTabs() {
  const bar = $('tabbar'); bar.hidden = false;
  tabs = TABS.filter(([k]) => k !== 'admin' || ctx.isOwner).map(([k, t]) => h('button', {type: 'button', role: 'tab', id: `tab-${k}`, 'data-tab': k, 'aria-selected': 'false', tabindex: '-1', onclick: () => go(k)}, t));
  bar.replaceChildren(...tabs);
}
function go(k) { const t = `#${k}`; if (location.hash === t) route(); else location.hash = t; }
function paintTabs(key) {
  let found = false;
  tabs.forEach(b => { const on = b.dataset.tab === key; found ||= on; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
  if (!found && tabs[0]) tabs[0].tabIndex = 0;
  $('main').setAttribute('aria-labelledby', `tab-${key}`);
}
$('tabbar').addEventListener('keydown', e => {
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  const to = {ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1}[e.key];
  if (to == null) return;
  e.preventDefault(); tabs.forEach(b => b.tabIndex = -1); tabs[to].tabIndex = 0; tabs[to].focus();
});

async function route() {
  if (!ctx.team) return;
  stop?.(); stop = null;
  const [name, arg] = location.hash.slice(1).split('/');
  let key = VIEWS[name] ? name : 'analysis';
  if (key === 'admin' && !ctx.isOwner) key = 'analysis';
  paintTabs(key === 'report' ? 'flags' : key);
  const mine = ++nav, sig = {stale: () => mine !== nav};
  let cleanup;
  try { cleanup = await VIEWS[key].render(arg ? decodeURIComponent(arg) : undefined, sig); }
  catch (e) { if (!sig.stale()) { console.error(e); setView('Error', h('div', {class: 'col-md stack'}, h('h1', {}, 'Something went wrong'), h('p', {}, 'This section could not load. Try again.'), h('button', {type: 'button', class: 'btn', onclick: route}, 'Try again'))); } }
  if (typeof cleanup === 'function') { if (sig.stale()) cleanup(); else stop = cleanup; }
}
addEventListener('hashchange', route);

// ---------- start ----------
$('team-pick').addEventListener('change', e => { const t = ctx.teams.find(x => x.id === e.target.value); if (t) { stop?.(); stop = null; nav++; selectTeam(t); } });
$('sign-out').addEventListener('click', async () => { await ctx.sb.auth.signOut().catch(() => {}); showSignin(); });
(async function init() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    if (!cfg.supabaseUrl || !cfg.publishableKey) throw new Error('missing config');
    ctx.aiEnabled = cfg.aiEnabled !== false;
    ctx.sb = createClient(cfg.supabaseUrl, cfg.publishableKey);
  } catch { setView('Setup needed', h('div', {class: 'col-md stack'}, h('h1', {}, 'Setup needed'), h('p', {}, 'The app is not connected to its database yet. Check SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in .env, then reload.'))); return; }
  const {data: {session}} = await ctx.sb.auth.getSession();
  if (session) afterSignIn(); else showSignin();
})();
