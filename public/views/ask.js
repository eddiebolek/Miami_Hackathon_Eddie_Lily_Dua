import {h, ctx, api, setView, announce, aiLabel, aiMsg, plural} from '../util.js';

const MAX = 500;
const STARTERS = ['Which company has the biggest revenue variance?', 'Are there any open flags?', 'Does cash roll forward correctly for every company?'];

// Chat history lives in memory per company; each request sends only the last 6 plain-text turns.
export function render(_arg, sig) {
  const chat = ctx.chats[ctx.team.id] ||= [];
  const log = h('div', {class: 'chat-log', role: 'log', 'aria-label': 'Conversation', 'aria-live': 'polite'});
  const input = h('textarea', {id: 'ask-q', maxlength: String(MAX), rows: '2', 'aria-describedby': 'ask-count ask-hint'});
  const count = h('span', {class: 'hint', id: 'ask-count'}, `0 of ${MAX} characters`);
  const send = h('button', {type: 'submit', class: 'btn primary'}, 'Ask');
  let busy = false;

  function bubble(m) {
    if (m.role === 'user') return h('article', {class: `msg user${m.failed ? ' failed' : ''}`}, h('p', {class: 'who-label'}, 'You'), h('p', {}, m.content));
    if (m.error) return h('article', {class: 'msg err'}, h('p', {class: 'err-text', role: 'alert'}, m.content));
    const rows = (m.citations || []).map(c => `${c.record_id}${c.source_row != null ? ` (row ${c.source_row})` : ''}`);
    return h('article', {class: 'msg ai'}, h('p', {class: 'who-label'}, 'Assistant'), aiLabel(), h('p', {class: 'answer'}, m.content),
      rows.length ? h('p', {class: 'hint'}, h('span', {class: 'sec-label'}, 'Rows cited: '), h('span', {class: 'mono'}, rows.join(', '))) : null,
      m.tools?.length ? h('details', {class: 'source'}, h('summary', {}, `How this was calculated (${plural(m.tools.length, 'checker call')})`),
        h('ul', {class: 'mini'}, m.tools.map(t => h('li', {}, h('span', {class: 'mono'}, t.name), ' ', h('span', {class: 'mono hint'}, JSON.stringify(t.input)))))) : null);
  }
  function paint() {
    log.replaceChildren(...(chat.length ? chat.map(bubble) : [h('div', {class: 'stack'}, h('p', {class: 'hint'}, 'Ask about this company\'s data. Answers use only numbers the checker computed, cite the rows they came from, and say so when they don\'t know.'),
      h('div', {class: 'actions'}, STARTERS.map(t => h('button', {type: 'button', class: 'chip', onclick: () => { input.value = t; input.dispatchEvent(new Event('input')); input.focus(); }}, t))))]));
    log.scrollTop = log.scrollHeight;
  }
  input.addEventListener('input', () => { count.textContent = `${input.value.length} of ${MAX} characters`; });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });

  const form = h('form', {class: 'ask-form', novalidate: true, onsubmit: async e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    if (text.length > MAX) { announce(`Questions are limited to ${MAX} characters.`); return; }
    busy = true; send.disabled = true; send.textContent = 'Asking...';
    const mine = {role: 'user', content: text};
    // earlier failed questions are not part of the conversation
    const history = [...chat.filter(m => !m.error && !m.failed).map(m => ({role: m.role, content: m.content})), {role: 'user', content: text}].slice(-6);
    chat.push(mine); input.value = ''; count.textContent = `0 of ${MAX} characters`; paint();
    const wait = h('p', {class: 'hint', role: 'status'}, 'Thinking...'); log.append(wait); log.scrollTop = log.scrollHeight;
    try {
      const out = await api('/api/chat', {method: 'POST', body: {team_id: ctx.team.id, messages: history}});
      chat.push({role: 'assistant', content: out.answer, citations: out.citations, tools: out.tools, model: out.model});
      announce('Answer received.');
    } catch (err) {
      if (err.status === 401) return;
      mine.failed = true;
      chat.push({role: 'assistant', error: true, content: aiMsg(err)});
    }
    busy = false; send.disabled = false; send.textContent = 'Ask';
    if (!sig.stale()) { paint(); input.focus(); }
  }}, h('label', {for: 'ask-q'}, 'Your question'), input, h('p', {class: 'hint', id: 'ask-hint'}, 'Enter sends, Shift+Enter adds a line.'),
    h('div', {class: 'actions'}, send, count));

  setView('Ask', h('div', {class: 'col-lg stack-lg'},
    h('div', {class: 'stack'}, h('h1', {}, 'Ask'), h('p', {class: 'muted'}, 'Ask a question about this company\'s data in plain English.'), aiLabel()),
    log, form));
  paint();
}
