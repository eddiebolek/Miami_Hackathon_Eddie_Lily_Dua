import {h, ctx, api, q, setView, announce, errMsg, plural} from '../util.js';

// Owner only. The shell only shows this tab when GET /api/members succeeded for the selected company.
export async function render(_arg, sig) {
  const list = h('div', {}, h('p', {class: 'hint'}, 'Loading...'));
  const msg = h('p', {role: 'status', class: 'hint'});
  const email = h('input', {type: 'email', id: 'm-email', autocomplete: 'off', required: true, 'aria-describedby': 'm-hint m-msg'});
  msg.id = 'm-msg';
  const add = h('button', {type: 'submit', class: 'btn primary'}, 'Add analyst');

  async function load() {
    try {
      const rows = await api(`/api/members?${q({team_id: ctx.team.id})}`);
      if (sig.stale()) return;
      list.replaceChildren(h('div', {class: 'table-wrap'}, h('table', {},
        h('caption', {class: 'sr-only'}, `${plural(rows.length, 'member')} of ${ctx.team.name}`),
        h('thead', {}, h('tr', {}, h('th', {scope: 'col'}, 'Email'), h('th', {scope: 'col'}, 'Role'))),
        h('tbody', {}, rows.map(r => h('tr', {}, h('th', {scope: 'row'}, r.email), h('td', {}, r.is_owner ? 'Owner' : 'Analyst')))))));
    } catch (e) { if (!sig.stale() && e.status !== 401) list.replaceChildren(h('p', {class: 'err-text', role: 'alert'}, errMsg(e))); }
  }
  const form = h('form', {class: 'stack', novalidate: true, onsubmit: async e => {
    e.preventDefault(); msg.className = 'hint'; msg.textContent = '';
    const v = email.value.trim();
    if (!/^[^@\s]+@[^@\s]+$/.test(v)) { msg.className = 'err-text'; msg.textContent = 'Enter a valid email address.'; email.setAttribute('aria-invalid', 'true'); email.focus(); return; }
    email.removeAttribute('aria-invalid');
    add.disabled = true; add.textContent = 'Adding...';
    try {
      await api('/api/members', {method: 'POST', body: {team_id: ctx.team.id, email: v}});
      msg.textContent = `${v} can now see ${ctx.team.name}.`; email.value = ''; announce(msg.textContent); await load();
    } catch (err) {
      if (err.status === 401) return;
      msg.className = 'err-text';
      msg.textContent = err.status === 404 ? 'No login with that email. Create it in Supabase first (Authentication, Users, Add user), then add it here.' : err.status === 403 ? 'Only the company owner can add analysts.' : errMsg(err);
    }
    add.disabled = false; add.textContent = 'Add analyst';
  }},
    h('div', {class: 'field'}, h('label', {for: 'm-email'}, 'Analyst email'), h('p', {class: 'hint', id: 'm-hint'}, 'The login must already exist in Supabase.'), email), msg, h('div', {class: 'actions'}, add));

  setView('Admin', h('div', {class: 'col-md stack-lg'},
    h('div', {class: 'stack'}, h('h1', {}, 'Admin'), h('p', {class: 'muted'}, `Who can see ${ctx.team.name}. Only these people see its data.`)),
    h('div', {class: 'stack'}, h('h2', {}, 'Members'), list),
    h('div', {class: 'card stack'}, h('h2', {}, 'Add an analyst'), form)));
  await load();
}
