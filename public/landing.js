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
// One continuous camera. The photos (each 1536x864) are nested: photo 2 sits inside the tower in photo 1, photo 3
// sits inside photo 2's lit window, and the Tally screen sits on photo 3's monitor. Nothing cuts or crossfades
// full-screen: each closer photo is already in place, small, and grows. All positions are in photo-1 pixels ("px1").
const PW = 1536, PH = 864;
// nest(parent, child): child point `at` lands on parent point `on`; the child spans `scale` of the parent's width.
// Each step is about 3x, so no photo is ever shown much bigger than its real pixels. Points were measured from the
// lit window (or tower edges) in each photo.
const L1 = {o: [0, 0], s: 1}; // whole tower
const LS = nest(L1, {on: [764, 520], at: [759, 406], scale: .3125}); // tower shaft
const LW = nest(LS, {on: [759, 406], at: [766, 440], scale: .33}); // glass wall
const L2 = nest(LW, {on: [766, 440], at: [762, 430], scale: 37 / 118}); // a few floors, one lit window
const LP = nest(L2, {on: [762, 430], at: [766, 318], scale: 118 / 480}); // the lit window up close
const L3 = nest(LP, {on: [766, 318], at: [750, 382], scale: 480 / 1020}); // the office through the glass
const LAYERS = [L1, LS, LW, L2, LP, L3];
const SCR = [578, 270, 926, 468]; // photo 3's monitor screen (photo-3 pixels)
const TARGET = toPx1(L3, [(SCR[0] + SCR[2]) / 2, (SCR[1] + SCR[3]) / 2]);
function nest(par, {on, at, scale}) { const s = par.s * scale; const p = toPx1(par, on); return {o: [p[0] - at[0] * s, p[1] - at[1] * s], s}; }
function toPx1(l, q) { return [l.o[0] + q[0] * l.s, l.o[1] + q[1] * l.s]; }

const scene = $('.zoom'), shots = [...document.querySelectorAll('.shot')], screen = $('.screen'), screenBg = $('.screen-bg');
const body = $('.mock-body'), feed = $('.mock-feed'), veil = $('.veil'), mock = $('.screen .mock');
const hero = $('.hero'), cta = $('.cta-wrap'), ctaLink = $('#cta');
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const seg = (p, a, b) => clamp((p - a) / (b - a));
const inOut = t => t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
const lseg = (v, a, b) => clamp(Math.log(v / a) / Math.log(b / a)); // progress on a zoom (log) scale
const total = () => Math.max(1, scene.offsetHeight - innerHeight);

let W = 0, VW = 0, VH = 0, ZEND = 1;
function measure() {
  VW = innerWidth; VH = screen.offsetHeight; W = shots[0].offsetWidth;
  // end zoom: photo 3's screen covers the viewport, so the Tally screen ends at exactly scale 1
  const sw = (SCR[2] - SCR[0]) * L3.s * W / PW, sh = (SCR[3] - SCR[1]) * L3.s * W / PW;
  ZEND = Math.max(VW / sw, VH / sh);
}

// a feathered rectangle mask in the element's own % coordinates
function rectMask(el, x0, x1, y0, y1, f) {
  const m = `linear-gradient(to right, transparent ${x0}%, #000 ${x0 + f}%, #000 ${x1 - f}%, transparent ${x1}%), ` +
            `linear-gradient(to bottom, transparent ${y0}%, #000 ${y0 + f * 1.78}%, #000 ${y1 - f * 1.78}%, transparent ${y1}%)`;
  el.style.webkitMaskImage = el.style.maskImage = m;
  el.style.webkitMaskComposite = 'source-in'; el.style.maskComposite = 'intersect';
}
// a soft round mask: solid to a%, fading out by b% (of the distance to the box corner)
function blobMask(el, a, b) { el.style.webkitMaskImage = el.style.maskImage = `radial-gradient(ellipse farthest-corner at 50% 50%, #000 ${a}%, transparent ${b}%)`; el.style.webkitMaskComposite = el.style.maskComposite = ''; }
function clearMask(el) { el.style.webkitMaskImage = el.style.maskImage = 'none'; }

function frame() {
  queued = false;
  let p = clamp(-scene.getBoundingClientRect().top / total());
  const rm = reduce.matches;
  if (rm) p = p < .35 ? 0 : 1; // no camera move: show the first and last frame only

  // camera: zoom Z grows exponentially (steady speed), softened at both ends
  const c = seg(p, 0, .62), q = rm ? p : .6 * c + .4 * inOut(c);
  const Z = ZEND ** q, k = Z * W / PW; // k = screen px per photo-1 px
  // the target starts where it sits in photo 1 and drifts to screen center during the first half of the zoom
  const u = inOut(seg(q, 0, .5));
  const start = [VW / 2 + (TARGET[0] / PW - .5) * W, VH / 2 + (TARGET[1] / PH - .5) * W * 9 / 16];
  const D = [start[0] + (VW / 2 - start[0]) * u, start[1] + (VH / 2 - start[1]) * u];
  const F = [TARGET[0] - (D[0] - VW / 2) / k, TARGET[1] - (D[1] - VH / 2) / k]; // photo-1 point at screen center
  const toScreen = pt => [VW / 2 + (pt[0] - F[0]) * k, VH / 2 + (pt[1] - F[1]) * k];

  // each closer photo grows out of the middle of the one before: soft and feathered at first, sharp once it fills the
  // screen, while the photo it replaces goes out of focus. A sharp edge never meets a blurred one.
  const grow = LAYERS.map(l => lseg(l.s * Z, .15, 1.6));
  const feather = e => 10 + 15 * (1 - e); // soft edge width, % of the photo's width
  // a photo is fully covered once the next photo's solid (unfeathered) middle spans the whole screen
  const fills = i => {
    const l = LAYERS[i], S = l.s * Z, [x, y] = toScreen(l.o), w = S * W, h = w * 9 / 16, f = feather(grow[i]) / 100 * w;
    return x + f <= 0 && y + f <= 0 && x + w - f >= VW && y + h - f >= VH;
  };
  LAYERS.forEach((l, i) => {
    const el = shots[i], S = l.s * Z; // S = this photo's own zoom (1 = exactly covers the viewport box)
    const [x, y] = toScreen(l.o);
    el.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${S.toFixed(5)})`;
    const last = i === LAYERS.length - 1;
    el.style.display = (!last && fills(i + 1)) || S * W < 3 ? 'none' : '';
    const e = i ? grow[i] : 1;
    const blur = (1 - e) * 4 + (last ? clamp((S - 1.8) / 2) * 4 : grow[i + 1] * 6); // in screen px
    el.style.filter = blur > .05 ? `blur(${(blur / S).toFixed(3)}px)` : 'none'; // blur is in local px, so divide by S
    if (!i) return;
    el.style.opacity = rm ? 1 : Math.min(1, e * 4).toFixed(3);
    if (last && e >= 1) clearMask(el); else rectMask(el, 0, 100, 0, 100, feather(e));
  });
  const S3 = L3.s * Z;

  // the Tally screen rides on photo 3's monitor; a dark backing covers the AI-drawn screen underneath
  const a = toScreen(toPx1(L3, [SCR[0], SCR[1]])), b = toScreen(toPx1(L3, [SCR[2], SCR[3]]));
  const rw = b[0] - a[0], rh = b[1] - a[1], show = S3 * W > 40 ? 1 : 0;
  screenBg.style.transform = `translate(${a[0].toFixed(2)}px, ${a[1].toFixed(2)}px) scale(${(rw / 100).toFixed(4)}, ${(rh / 100).toFixed(4)})`;
  screenBg.style.display = shots[LAYERS.length - 1].style.display;
  const m = Math.min(1, rw / VW, rh / VH);
  screen.style.opacity = show;
  screen.style.transform = `translate(${((a[0] + b[0]) / 2 - VW / 2).toFixed(2)}px, ${((a[1] + b[1]) / 2 - VH / 2).toFixed(2)}px) scale(${m.toFixed(5)})`;

  hero.style.opacity = 1 - seg(p, 0, .05);
  hero.style.transform = `translateY(${(-32 * seg(p, 0, .05)).toFixed(1)}px)`;

  // scroll the Flags table, blur it until no text is readable, then show the call to action
  const dist = Math.max(0, feed.offsetHeight - body.clientHeight);
  feed.style.transform = `translateY(${(-dist * inOut(seg(p, .65, .85))).toFixed(1)}px)`;
  const bl = seg(p, .85, .94);
  mock.style.filter = bl > 0 ? `blur(${(bl * 12).toFixed(2)}px)` : 'none';
  veil.style.opacity = (bl * .6).toFixed(3);
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
