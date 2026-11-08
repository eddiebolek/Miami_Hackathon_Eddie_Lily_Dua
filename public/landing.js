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
// One continuous camera over six nested photos (each 1536x864), from the whole tower down to the office monitor.
// The photos were prepared so that wherever two overlap they hold the same picture (each closer photo is baked,
// shrunk, into the middle of the farther one), so swapping from one to the next mid-zoom changes nothing on screen.
const PW = 1536, PH = 864;
// where each photo sits inside the one before, in the parent's pixels: [x, y, x scale, y scale]
const REL = [
  [527.5, 244.15168, .30312, .30312], // tower shaft in the skyline (square photo)
  [524.017, 560.184, .328385, .328385], // glass wall in the shaft (square photo)
  [510.25, 698.6, .33454, .2555], // a few floors in the wall (floor lines matched)
  [564.24, 325.7, .26357, .347], // the lit window up close
  [412.27, 198.72, .47297, .47297], // the office through the glass
];
const LAYERS = [{o: [0, 0], sx: 1, sy: 1}];
for (const [ox, oy, sx, sy] of REL) {
  const p = LAYERS[LAYERS.length - 1];
  LAYERS.push({o: [p.o[0] + ox * p.sx, p.o[1] + oy * p.sy], sx: p.sx * sx, sy: p.sy * sy});
}
// each photo fades in while its width grows across this share of the screen width
// (the shaft waits until the tower is close enough that the lit window is no longer a dot)
const FADE = [[0, 0], [.36, .6], [.12, .25], [.12, .25], [.12, .25], [.12, .25]];
// height / width of each photo: the shaft and wall photos are square so they cover the screen top to bottom
const AR = [9 / 16, 1, 1, 9 / 16, 9 / 16, 9 / 16];
const L3 = LAYERS[LAYERS.length - 1];
const SCR = [578, 270, 926, 468]; // the office monitor's screen (office-photo pixels)
const toPx1 = (l, q) => [l.o[0] + q[0] * l.sx, l.o[1] + q[1] * l.sy];
const TARGET = toPx1(L3, [(SCR[0] + SCR[2]) / 2, (SCR[1] + SCR[3]) / 2]);

const scene = $('.zoom'), shots = [...document.querySelectorAll('.shot')], screen = $('.screen'), screenBg = $('.screen-bg');
const body = $('.mock-body'), feed = $('.mock-feed'), veil = $('.veil'), mock = $('.screen .mock');
const hero = $('.hero'), cta = $('.cta-wrap'), ctaLink = $('#cta');
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const seg = (p, a, b) => clamp((p - a) / (b - a));
const inOut = t => t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
const total = () => Math.max(1, scene.offsetHeight - innerHeight);

let W = 0, VW = 0, VH = 0, ZEND = 1;
function measure() {
  VW = innerWidth; VH = screen.offsetHeight;
  // every photo box has the same width; read it from one that is shown (a hidden one measures 0)
  W = Math.max(...shots.map(s => s.offsetWidth));
  // end zoom: photo 3's screen covers the viewport, so the Tally screen ends at exactly scale 1
  const sw = (SCR[2] - SCR[0]) * L3.sx * W / PW, sh = (SCR[3] - SCR[1]) * L3.sy * W / PW;
  ZEND = Math.max(VW / sw, VH / sh);
}

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

  // a photo is drawn once it is big enough to add detail, and dropped once the next photo covers the screen
  LAYERS.forEach((l, i) => {
    const el = shots[i], Sx = l.sx * Z, Sy = l.sy * Z, [x, y] = toScreen(l.o);
    el.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${Sx.toFixed(5)}, ${Sy.toFixed(5)})`;
    const n = LAYERS[i + 1], small = Sx * W / VW;
    const [fa, fb] = FADE[i];
    let hide = i > 0 && small < fa;
    if (n) {
      const [nx, ny] = toScreen(n.o);
      hide = hide || (nx <= 0 && ny <= 0 && nx + n.sx * Z * W >= VW && ny + n.sy * Z * W * AR[i + 1] >= VH);
    }
    el.style.display = hide ? 'none' : '';
    if (i) el.style.opacity = rm ? 1 : clamp((small - fa) / (fb - fa)).toFixed(3);
  });
  const S3 = L3.sx * Z;

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
