// Landing page zoom-scroll: one tall section, a sticky stage, and scroll progress p (0..1) driving each layer.
const $ = s => document.querySelector(s);

// ---- mock Flags table (synthetic demo rows, same shape as the real Flags tab) ----
const BASE = [
  ['E1974', 'BU-079', 'TOTAL', 'Mismatch', 'Total skips row', '$3,304,568', '$3,426,057'],
  ['M32', 'BU-002', 'Jun 2025', 'Mismatch', 'Rollforward break', '$1,990,673', '$1,980,673'],
  ['K80', 'BU-004', 'Apr 2025', 'Mismatch', 'Sign flipped', '$3,331', '-$3,331'],
  ['row 160', 'BU-007', 'Oct 2025', 'Mismatch', 'Missing row', '(blank)', '(blank)'],
  ['E284', 'BU-012', 'Sep 2025', 'Mismatch', 'Typed over', '$211,756', '$210,521'],
  ['E375', 'BU-015', 'TOTAL', 'Mismatch', 'Total double counts', '$6,397,011', '$6,166,956'],
  ['E452', 'BU-019', 'Feb 2025', 'Mismatch', 'Wrong period', '$466,334', '$407,666'],
  ['G553', 'BU-023', 'Mar 2025', 'Needs review', 'Wrong variance', '-$2,736', '-$3,236'],
  ['R649', 'BU-026', 'Dec 2026', 'Mismatch', 'Rollforward formula', '$4,128,071', '$4,125,571'],
  ['L705', 'BU-029', 'May 2025', 'Needs review', 'Wrong percent', '2.08%', '-0.92%'],
];
const tbody = $('#mock-rows');
if (tbody) {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const [cell, co, per, sev, what, sheet, sug] = BASE[i % BASE.length];
    const bump = Math.floor(i / BASE.length) * 37;
    const c = cell.replace(/\d+/, d => String(+d + bump * 11));
    const company = co.replace(/\d+/, d => String(+d + bump).padStart(3, '0'));
    rows.push(`<tr class="${sev === 'Mismatch' ? 'hi' : 'rv'}"><td class="cell">${c}</td><td>${company}</td><td>${per}</td><td><b>${sev}</b>${what}</td><td class="up">analyst-sheet-errors.csv</td><td class="n">${sheet}</td><td class="n">${sug}</td><td><em>Open</em></td></tr>`);
  }
  tbody.innerHTML = rows.join('');
}

// ---- scroll scene ----
const scene = $('.zoom'), city = $('#city'), office = $('.office'), body = $('.mock-body'), feed = $('.mock-feed');
const veil = $('.veil'), mock = $('.mock'), hero = $('.hero'), cta = $('.cta-wrap'), ctaLink = $('#cta');
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const W0 = 1600, H0 = 1000, TX = 800, TY = 563.5, W1 = 20, S0 = 0.3;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const seg = (p, a, b) => clamp((p - a) / (b - a));
const inOut = t => t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
const total = () => Math.max(1, scene.offsetHeight - innerHeight);

function frame() {
  queued = false;
  let p = clamp(-scene.getBoundingClientRect().top / total());
  const rm = reduce.matches;
  if (rm) p = p < .35 ? 0 : 1; // no zooming: two still scenes, crossfaded by CSS

  // 1. fly toward the lit window. Exponential width = steady zoom speed; the window drifts from 56% to screen center.
  if (!rm) {
    const z = inOut(seg(p, 0, .4));
    const w = W0 * (W1 / W0) ** z, h = w * H0 / W0, ry = .5635 - .0635 * z;
    city.setAttribute('viewBox', `${(TX - w / 2).toFixed(3)} ${(TY - ry * h).toFixed(3)} ${w.toFixed(3)} ${h.toFixed(3)}`);
  }
  const hz = seg(p, 0, .06);
  hero.style.opacity = 1 - hz;
  hero.style.transform = `translateY(${(-32 * hz).toFixed(1)}px)`;

  // 2. through the window into the office, then push in until the monitor fills the screen
  const o = rm ? p : seg(p, .3, .37);
  office.style.opacity = o;
  city.style.visibility = o >= 1 ? 'hidden' : 'visible';
  const s = rm ? 1 : S0 + (1 - S0) * inOut(seg(p, .36, .62));
  office.style.transform = `scale(${s.toFixed(4)})`;

  // 3. scroll the Flags table, 4. blur it until no text is readable, 5. show the call to action
  const dist = Math.max(0, feed.offsetHeight - body.clientHeight);
  feed.style.transform = `translateY(${(-dist * inOut(seg(p, .65, .85))).toFixed(1)}px)`;
  const b = seg(p, .85, .94);
  mock.style.filter = b > 0 ? `blur(${(b * 12).toFixed(2)}px)` : 'none';
  veil.style.opacity = (b * .6).toFixed(3);
  cta.classList.toggle('on', p > .93);
}

let queued = false;
const request = () => { if (!queued) { queued = true; requestAnimationFrame(frame); } };
addEventListener('scroll', request, {passive: true});
addEventListener('resize', request);
reduce.addEventListener?.('change', request);
frame();

// keyboard and screen reader users can reach the button without scrolling: jump to the end when it gets focus
ctaLink.addEventListener('focus', () => {
  if (!cta.classList.contains('on')) scrollTo({top: scene.offsetTop + total(), behavior: 'instant'});
});
