import {h, ctx, api, q, setView, announce, errMsg} from '../util.js';

const ROLE_TEXT = {admin: 'Admin', analyst: 'Analyst'};
const roleSelect = (id, value, label) => h('select', {id, 'aria-label': label, class: 'role-select'},
  ['analyst', 'admin'].map(r => h('option', {value: r, selected: r === value}, ROLE_TEXT[r])));
const bad = (el, msg, node) => { el.className = 'err-text'; el.textContent = msg; node.setAttribute('aria-invalid', 'true'); node.focus(); };
const EMAIL = /^[^@\s]+@[^@\s]+$/;

// Native modal dialog: focus moves in, Escape or Cancel closes it, focus returns to the trigger.
function confirmRemove(text) {
  return new Promise(done => {
    const dlg = h('dialog', {'aria-labelledby': 'rm-title'}, h('div', {class: 'stack'},
      h('h2', {id: 'rm-title'}, 'Remove this person?'), h('p', {}, text),
      h('div', {class: 'actions'},
        h('button', {type: 'button', class: 'btn', autofocus: true, onclick: () => dlg.close('no')}, 'Cancel'),
        h('button', {type: 'button', class: 'btn primary', onclick: () => dlg.close('yes')}, 'Remove'))));
    dlg.addEventListener('close', () => { dlg.remove(); done(dlg.returnValue === 'yes'); });
    document.body.append(dlg); dlg.showModal();
  });
}

// Developer only. onCreated(id) runs after the company exists.
export function newCompanyForm(onCreated) {
  const name = h('input', {type: 'text', id: 'nc-name', required: true, maxlength: 100, autocomplete: 'off'});
  const email = h('input', {type: 'email', id: 'nc-email', required: true, autocomplete: 'off', 'aria-describedby': 'nc-hint'});
  const msg = h('p', {role: 'status', class: 'hint', id: 'nc-msg'});
  const go = h('button', {type: 'submit', class: 'btn primary'}, 'Create company');
  return h('form', {class: 'card stack', novalidate: true, onsubmit: async e => {
    e.preventDefault(); msg.className = 'hint'; msg.textContent = ''; name.removeAttribute('aria-invalid'); email.removeAttribute('aria-invalid');
    if (!name.value.trim()) return bad(msg, 'Enter a company name.', name);
    if (!EMAIL.test(email.value.trim())) return bad(msg, 'Enter a valid email address for the first admin.', email);
    go.disabled = true; go.textContent = 'Creating...';
    try {
      const {id} = await api('/api/companies', {method: 'POST', body: {name: name.value.trim(), admin_email: email.value.trim()}});
      announce(`${name.value.trim()} created.`); await onCreated(id); return;
    } catch (err) {
      if (err.status !== 401) { msg.className = 'err-text'; msg.textContent = err.status === 404 ? 'No login with that email. Create it in Supabase first (Authentication, Users, Add user), then try again.' : errMsg(err); }
    }
    go.disabled = false; go.textContent = 'Create company';
  }},
    h('h2', {}, 'New company'),
    h('div', {class: 'field'}, h('label', {for: 'nc-name'}, 'Company name'), name),
    h('div', {class: 'field'}, h('label', {for: 'nc-email'}, 'First admin email'), h('p', {class: 'hint', id: 'nc-hint'}, 'Their login must already exist in Supabase. It can be your own.'), email),
    msg, h('div', {class: 'actions'}, go));
}

// Admins and developers. The shell only shows this tab to them.
export async function render(_arg, sig) {
  const list = h('div', {}, h('p', {class: 'hint'}, 'Loading...'));
  const status = h('p', {role: 'status', class: 'hint', id: 'm-status'});
  const email = h('input', {type: 'email', id: 'm-email', autocomplete: 'off', required: true, 'aria-describedby': 'm-hint m-msg'});
  const newRole = roleSelect('m-role', 'analyst', 'Role');
  const msg = h('p', {role: 'status', class: 'hint', id: 'm-msg'});
  const add = h('button', {type: 'submit', class: 'btn primary'}, 'Add person');
  const say = (text, isErr) => { status.className = isErr ? 'err-text' : 'hint'; status.textContent = text; };
  const fail = err => { if (err.status !== 401) say(err.status === 409 || err.status === 403 || err.status === 404 ? err.message : errMsg(err), true); };

  async function load() {
    try {
      const rows = await api(`/api/members?${q({team_id: ctx.team.id})}`);
      if (sig.stale()) return;
      list.replaceChildren(h('div', {class: 'table-wrap'}, h('table', {},
        h('caption', {class: 'sr-only'}, `${rows.length === 1 ? '1 person' : rows.length + ' people'} in ${ctx.team.name}`),
        h('thead', {}, h('tr', {}, h('th', {scope: 'col'}, 'Email'), h('th', {scope: 'col'}, 'Role'), h('th', {scope: 'col'}, h('span', {class: 'sr-only'}, 'Remove')))),
        h('tbody', {}, rows.map(r => r.is_owner
          ? h('tr', {}, h('th', {scope: 'row'}, r.email), h('td', {}, 'Owner (admin)'), h('td', {}))
          : h('tr', {}, h('th', {scope: 'row'}, r.email),
            h('td', {}, (() => { const s = roleSelect(`role-${r.user_id}`, r.role, `Role for ${r.email}`); s.addEventListener('change', async () => {
              say(''); s.disabled = true;
              try { await api('/api/members', {method: 'PATCH', body: {team_id: ctx.team.id, user_id: r.user_id, role: s.value}}); say(`${r.email} is now ${ROLE_TEXT[s.value].toLowerCase()}.`); announce(status.textContent); }
              catch (err) { fail(err); }
              await load(); }); return s; })()),
            h('td', {}, h('button', {type: 'button', class: 'btn', onclick: async () => {
              if (!await confirmRemove(`${r.email} will no longer see ${ctx.team.name}. You can add them again later.`)) return;
              try { await api(`/api/members?${q({team_id: ctx.team.id, user_id: r.user_id})}`, {method: 'DELETE'}); say(`${r.email} was removed.`); announce(status.textContent); }
              catch (err) { fail(err); }
              await load(); }}, 'Remove', h('span', {class: 'sr-only'}, ` ${r.email}`)))))))));
    } catch (e) { if (!sig.stale() && e.status !== 401) list.replaceChildren(h('p', {class: 'err-text', role: 'alert'}, errMsg(e))); }
  }
  const form = h('form', {class: 'stack', novalidate: true, onsubmit: async e => {
    e.preventDefault(); msg.className = 'hint'; msg.textContent = ''; email.removeAttribute('aria-invalid');
    const v = email.value.trim();
    if (!EMAIL.test(v)) return bad(msg, 'Enter a valid email address.', email);
    add.disabled = true; add.textContent = 'Adding...';
    try {
      await api('/api/members', {method: 'POST', body: {team_id: ctx.team.id, email: v, role: newRole.value}});
      msg.textContent = `${v} can now see ${ctx.team.name}.`; email.value = ''; announce(msg.textContent); await load();
    } catch (err) {
      if (err.status !== 401) { msg.className = 'err-text'; msg.textContent = err.status === 404 ? 'No login with that email. Create it in Supabase first (Authentication, Users, Add user), then add it here.' : err.status === 403 ? 'Only a company admin can add people.' : errMsg(err); }
    }
    add.disabled = false; add.textContent = 'Add person';
  }},
    h('div', {class: 'field'}, h('label', {for: 'm-email'}, 'Email'), h('p', {class: 'hint', id: 'm-hint'}, 'The login must already exist in Supabase.'), email),
    h('div', {class: 'field'}, h('label', {for: 'm-role'}, 'Role'), newRole),
    msg, h('div', {class: 'actions'}, add));

  setView('Admin', h('div', {class: 'col-md stack-lg'},
    h('div', {class: 'stack'}, h('h1', {}, 'Admin'), h('p', {class: 'muted'}, `Who can see ${ctx.team.name}. Only these people see its data. Admins manage people; analysts use the checker.`)),
    h('div', {class: 'stack'}, h('h2', {}, 'People'), status, list),
    h('div', {class: 'card stack'}, h('h2', {}, 'Add a person'), form),
    ctx.isDev ? newCompanyForm(id => ctx.reloadTeams(id)) : null));
  await load();
}
