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
// Four photos (1536x864). Each zooms toward a target point (fractions of the photo) and blends into the next, closer one.
// Stage ranges are in q, the eased camera progress; they overlap so the next photo is already moving when it fades in.
const SHOTS = [
  {t: [.497, .58], k: 2.6, q: [0, .3]},      // tower, middle of the facade
  {t: [.497, .496], k: 2.8, q: [.22, .54]},  // glass wall, the lit window
  {t: [.49, .427], k: 2.05, q: [.47, .76]},  // office through the window, its monitor
  {t: [.5, .4126], k: 0, q: [.7, 1]},        // desk monitor screen; k is computed so the screen fills the viewport
];
const FADES = [null, [.22, .29], [.47, .53], [.7, .75]];
const SCREEN = {w: 690 / 1536, h: 387 / 864}; // image 4's screen size as a fraction of the photo

const scene = $('.zoom'), shots = [...document.querySelectorAll('.shot')], screen = $('.screen');
const body = $('.mock-body'), feed = $('.mock-feed'), veil = $('.veil'), mock = $('.screen .mock');
const hero = $('.hero'), cta = $('.cta-wrap'), ctaLink = $('#cta'), mini = $('.mini');
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const seg = (p, a, b) => clamp((p - a) / (b - a));
const inOut = t => t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
const total = () => Math.max(1, scene.offsetHeight - innerHeight);

// image 3's monitor gets a small copy of the Tally screen, scaled to the measured screen box
const miniMock = mock.cloneNode(true);
miniMock.querySelector('.veil').remove();
mini.append(miniMock);

let W = 0, H = 0, VW = 0, VH = 0;
function measure() {
  VW = innerWidth; VH = screen.offsetHeight; W = shots[0].offsetWidth; H = W * 9 / 16;
  SHOTS[3].k = Math.max(VW / (SCREEN.w * W), VH / (SCREEN.h * H));
  miniMock.style.transform = `scale(${(mini.offsetWidth / 1280).toFixed(4)})`;
}

// zoom k toward target t; the target drifts from its spot in the photo to screen center as the stage runs (a: 0..1)
function place(i, k, a) {
  const [tx, ty] = SHOTS[i].t, ox = (tx - .5) * W, oy = (ty - .5) * H;
  const dx = ox * (1 - a - k), dy = oy * (1 - a - k);
  shots[i].style.transform = `translate(-50%, -50%) translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${k.toFixed(4)})`;
  return [VW / 2 + ox * k + dx, VH / 2 + oy * k + dy]; // where the target is on screen now
}

function frame() {
  queued = false;
  let p = clamp(-scene.getBoundingClientRect().top / total());
  const rm = reduce.matches;
  if (rm) p = p < .35 ? 0 : 1; // no zooming: two still scenes, crossfaded by CSS

  const c = seg(p, 0, .62), q = rm ? p : .6 * c + .4 * inOut(c); // mostly steady camera, softened at both ends
  let last = [VW / 2, VH / 2], k4 = 1;
  SHOTS.forEach((s, i) => {
    const t = seg(q, s.q[0], s.q[1]);
    const k = rm ? (i === 3 ? s.k : 1) : s.k ** t; // exponential = steady zoom speed
    const pos = place(i, k, rm ? (i === 3 ? 1 : 0) : t);
    const o = i === 0 ? 1 : seg(q, FADES[i][0], FADES[i][1]);
    const next = FADES[i + 1] ? seg(q, FADES[i + 1][0], FADES[i + 1][1]) : 0;
    shots[i].style.opacity = rm ? (i === 0 ? 1 - p : i === 3 ? p : 0) : o;
    // a light blur on the incoming photo hides the cut between shots. Photos stay painted (no visibility toggle)
    // so the first frame of each one never flashes black while it decodes.
    shots[i].style.filter = !rm && o > 0 && o < 1 ? `blur(${((1 - o) * 6).toFixed(2)}px)` : 'none';
    shots[i].style.opacity = next >= 1 && !rm ? 0 : shots[i].style.opacity;
    if (i === 3) { last = pos; k4 = k; }
  });
  hero.style.opacity = 1 - seg(p, 0, .05);
  hero.style.transform = `translateY(${(-32 * seg(p, 0, .05)).toFixed(1)}px)`;

  // the Tally screen rides on image 4's monitor: fit the viewport-sized screen inside the photo's screen box
  const m = Math.min(1, Math.min(SCREEN.w * W * k4 / VW, SCREEN.h * H * k4 / VH));
  // fades in just after photo 4 is fully shown (the monitor "switches on"), so two layouts never overlap
  screen.style.opacity = rm ? p : seg(q, FADES[3][1], FADES[3][1] + .05);
  screen.style.transform = `translate(${(last[0] - VW / 2).toFixed(1)}px, ${(last[1] - VH / 2).toFixed(1)}px) scale(${m.toFixed(4)})`;

  // scroll the Flags table, blur it until no text is readable, then show the call to action
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
addEventListener('resize', () => { measure(); request(); });
reduce.addEventListener?.('change', request);
measure();
frame();
// decode every photo up front so none of them stalls the first time it appears mid-scroll
shots.forEach(s => s.querySelector('img').decode?.().catch(() => {}));

// keyboard and screen reader users can reach the button without scrolling: jump to the end when it gets focus
ctaLink.addEventListener('focus', () => {
  if (!cta.classList.contains('on')) scrollTo({top: scene.offsetTop + total(), behavior: 'instant'});
});
