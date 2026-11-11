// DOM side: loader, cursor, text effects, scroll-linked sections, HUD.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

const GLYPHS_LATIN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=/<>';
const GLYPHS_JP = '合掌祈念礼禅空無円相心静光影手掌息';

/* ---------- text helpers ---------- */

function splitChars(el, className) {
  const text = el.textContent;
  el.textContent = '';
  const chars = [];
  [...text].forEach((ch, i) => {
    const s = document.createElement('span');
    s.className = className;
    s.style.setProperty('--i', i);
    s.textContent = ch === ' ' ? ' ' : ch;
    if (className === 'char') s.setAttribute('aria-hidden', 'true');
    el.appendChild(s);
    chars.push(s);
  });
  if (className === 'char') el.setAttribute('aria-label', text);
  return chars;
}

export function scramble(el, duration = 650, text) {
  if (el._scramble) cancelAnimationFrame(el._scramble);
  const final = text ?? el.dataset.text ?? (el.dataset.text = el.textContent);
  if (text) el.dataset.text = text;
  const chars = [...final];
  const start = performance.now();
  const at = chars.map((_, i) => (i / chars.length) * duration * 0.6 + Math.random() * duration * 0.4);
  const tick = (now) => {
    const t = now - start;
    let out = '';
    let done = true;
    chars.forEach((ch, i) => {
      if (ch === ' ' || ch === '/' || t >= at[i]) out += ch;
      else {
        done = false;
        const set = ch.codePointAt(0) > 0x2e80 ? GLYPHS_JP : GLYPHS_LATIN;
        out += set[Math.floor(Math.random() * set.length)];
      }
    });
    el.textContent = out;
    el._scramble = done ? 0 : requestAnimationFrame(tick);
  };
  el._scramble = requestAnimationFrame(tick);
}

/* ---------- loader ---------- */

function createLoader(reduced) {
  const el = $('.loader');
  const countEl = $('[data-loader-count]');
  const statusEl = $('[data-loader-status]');
  const bar = $('.loader__bar i');
  const born = performance.now();
  let target = 0;
  let shown = 0;
  let last = born;
  let raf = 0;

  const tick = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    shown = Math.min(target, shown + dt * 1.15);
    countEl.textContent = String(Math.round(shown * 100)).padStart(3, '0');
    bar.style.transform = `scaleX(${shown})`;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  return {
    set(p, status) {
      target = Math.max(target, clamp(p));
      if (status) statusEl.textContent = status;
    },
    async finish() {
      target = 1;
      while (shown < 0.999 || performance.now() - born < 1500) await wait(30);
      cancelAnimationFrame(raf);
      countEl.textContent = '100';
      if (reduced) {
        el.classList.add('is-opening');
        el.style.transition = 'opacity .6s';
        el.style.opacity = '0';
        setTimeout(() => el.classList.add('is-gone'), 700);
        return;
      }
      el.classList.add('is-closing');
      await wait(950);
      el.classList.add('is-joined');
      await wait(900);
      el.classList.add('is-opening');
      setTimeout(() => el.classList.add('is-gone'), 1500);
    },
  };
}

/* ---------- main ---------- */

export function initUI({ reduced, coarse }) {
  const root = document.documentElement;
  const pointer = { x: innerWidth / 2, y: innerHeight / 2, nx: 0, ny: 0, speed: 0, down: false, moved: false };
  let vw = innerWidth;
  let vh = innerHeight;

  const loader = createLoader(reduced);

  /* pointer */
  let lastPX = pointer.x;
  let lastPY = pointer.y;
  window.addEventListener(
    'pointermove',
    (e) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.nx = (e.clientX / vw) * 2 - 1;
      pointer.ny = -((e.clientY / vh) * 2 - 1);
      pointer.moved = true;
    },
    { passive: true },
  );
  window.addEventListener('pointerdown', () => (pointer.down = true));
  window.addEventListener('pointerup', () => (pointer.down = false));
  window.addEventListener('pointercancel', () => (pointer.down = false));

  /* cursor */
  const cursor = $('.cursor');
  const dot = $('.cursor__dot');
  const ring = $('.cursor__ring');
  const label = $('.cursor__label');
  const ringPos = { x: pointer.x, y: pointer.y };
  const useCursor = !coarse;
  if (useCursor) {
    root.classList.add('has-cursor');
    window.addEventListener('pointermove', () => cursor.classList.add('is-visible'), { once: true });
    document.addEventListener('pointerleave', () => cursor.classList.remove('is-visible'));
    document.addEventListener('pointerenter', () => cursor.classList.add('is-visible'));
    document.addEventListener('pointerover', (e) => {
      const t = e.target.closest('a, button, [data-cursor]');
      cursor.classList.toggle('is-hover', !!t);
      const text = t?.dataset.cursor;
      cursor.classList.toggle('has-label', !!text);
      if (text) label.textContent = text;
    });
    window.addEventListener('pointerdown', () => cursor.classList.add('is-down'));
    window.addEventListener('pointerup', () => cursor.classList.remove('is-down'));
  }

  /* split text */
  $$('[data-split]').forEach((el) => splitChars(el, 'char'));

  /* reveal on view */
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add('is-in');
        io.unobserve(e.target);
      });
    },
    { threshold: 0.15, rootMargin: '0px 0px -8% 0px' },
  );
  const observeReveals = () =>
    $$('[data-split]:not([data-hero-split]), [data-reveal], .section-label').forEach((el) => io.observe(el));

  /* scramble on hover */
  $$('[data-scramble]').forEach((el) => {
    const host = el.closest('a, button') || el;
    host.addEventListener('pointerenter', () => scramble(el, 520));
  });

  /* magnetic */
  if (useCursor) {
    $$('[data-magnetic]').forEach((el) => {
      const strength = el.matches('.pray') ? 0.12 : 0.3;
      el.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        el.style.transform = `translate3d(${dx * strength}px, ${dy * strength}px, 0)`;
      });
      el.addEventListener('pointerleave', () => (el.style.transform = ''));
    });
  }

  /* clock */
  const clockEl = $('[data-clock]');
  const fmt = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const updateClock = () => (clockEl.textContent = fmt.format(new Date()));
  updateClock();
  setInterval(updateClock, 1000);

  /* manifesto: characters light up with scroll */
  const mBody = $('.manifesto__body');
  const mChars = $$('[data-reveal-chars]').flatMap((p) => splitChars(p, 'mchar'));
  let mLit = 0;
  let mHead = null;
  function updateManifesto() {
    const r = mBody.getBoundingClientRect();
    const start = vh * 0.82;
    const end = vh * 0.4;
    const p = clamp((start - r.top) / (r.height + start - end));
    const n = Math.round(p * mChars.length);
    if (n === mLit) return;
    const [a, b] = n > mLit ? [mLit, n] : [n, mLit];
    for (let i = a; i < b; i++) mChars[i].classList.toggle('is-lit', i < n);
    mHead?.classList.remove('is-head');
    mHead = n > 0 && n < mChars.length ? mChars[n - 1] : null;
    mHead?.classList.add('is-head');
    mLit = n;
  }

  /* marquee */
  const rows = $$('[data-marquee]').map((row) => {
    const track = $('.marquee__track', row);
    const unit = track.innerHTML;
    track.innerHTML = unit.repeat(4);
    return { row, track, dir: Number(row.dataset.marquee), x: 0, half: 0, unit };
  });
  let skew = 0;
  function layoutMarquee() {
    rows.forEach((r) => {
      r.track.innerHTML = r.unit.repeat(4);
      let reps = 4;
      while (r.track.scrollWidth < vw * 2.2 && reps < 32) {
        reps *= 2;
        r.track.innerHTML = r.unit.repeat(reps);
      }
      r.half = r.track.scrollWidth / 2;
    });
  }
  function updateMarquee(dt, vel) {
    skew = lerp(skew, clamp(vel * 0.004, -14, 14), 1 - Math.exp(-dt * 8));
    rows.forEach((r) => {
      const speed = (reduced ? 20 : 70) + Math.abs(vel) * 0.35;
      r.x += speed * r.dir * (vel < 0 ? -1 : 1) * dt;
      if (r.half > 0) {
        if (r.x <= -r.half) r.x += r.half;
        if (r.x > 0) r.x -= r.half;
      }
      r.row.style.transform = `skewX(${(skew * r.dir).toFixed(2)}deg)`;
      r.track.style.transform = `translate3d(${r.x.toFixed(1)}px,0,0)`;
    });
  }

  /* inversion plate */
  const inv = $('.invert');
  const invKanji = $('.invert__kanji');
  function updateInvert() {
    const r = inv.getBoundingClientRect();
    if (r.bottom < -50 || r.top > vh + 50) return;
    const k = easeOut(clamp((vh - r.top) / (vh * 0.85)));
    inv.style.setProperty('--ci', `${((1 - k) * 14).toFixed(2)}%`);
    inv.style.setProperty('--cx', `${((1 - k) * 8).toFixed(2)}%`);
    inv.style.setProperty('--cr', `${((1 - k) * 48).toFixed(1)}px`);
    const c = (r.top + r.height / 2 - vh / 2) / vh;
    invKanji.style.transform = `translate3d(0, ${(c * -18).toFixed(2)}vh, 0) scale(${(1.08 - k * 0.08).toFixed(3)})`;
  }

  /* the form: sticky horizontal track */
  const form = $('.form');
  const track = $('.form__track');
  const steps = $$('.step');
  const formBar = $('.form__bar i');
  const formGeo = { top: 0, height: 1, trackW: 0, centers: [] };
  function layoutForm() {
    formGeo.top = form.getBoundingClientRect().top + window.scrollY;
    formGeo.height = form.offsetHeight;
    formGeo.trackW = track.scrollWidth;
    formGeo.centers = steps.map((s) => s.offsetLeft + s.offsetWidth / 2);
  }
  function updateForm(scrollY) {
    const p = clamp((scrollY - formGeo.top) / (formGeo.height - vh));
    const max = Math.max(0, formGeo.trackW - vw);
    const x = -p * max;
    track.style.transform = `translate3d(${x.toFixed(1)}px,0,0)`;
    steps.forEach((s, i) => {
      const c = formGeo.centers[i] + x;
      const cp = clamp(1 - Math.abs(c - vw * 0.5) / (vw * 0.5));
      s.style.setProperty('--cp', easeOut(cp).toFixed(3));
    });
    formBar.style.transform = `scaleX(${p.toFixed(4)})`;
    return p;
  }

  /* hero parallax */
  const heroTitle = $('.hero__title');
  const heroBits = $$('.hero__top, .hero__forming, .hero__bottom, .hero__vertical');
  function updateHero(scrollY) {
    if (scrollY > vh * 1.3) return;
    const k = scrollY / vh;
    heroTitle.style.transform = `translate3d(0, ${(k * 32).toFixed(2)}vh, 0) scale(${(1 + k * 0.12).toFixed(4)})`;
    heroTitle.style.opacity = String(clamp(1 - k * 1.1));
    heroBits.forEach((b) => (b.style.opacity = String(clamp(1 - k * 1.8))));
  }

  /* footer spotlight */
  const big = $('[data-spotlight]');
  let spotR = 0;
  let spotTarget = 0;
  big.addEventListener('pointermove', (e) => {
    const r = big.getBoundingClientRect();
    big.style.setProperty('--mx', `${e.clientX - r.left}px`);
    big.style.setProperty('--my', `${e.clientY - r.top}px`);
    spotTarget = Math.max(140, vw * 0.16);
  });
  big.addEventListener('pointerleave', () => (spotTarget = 0));

  /* scroll progress */
  const progFill = $('.progress__rail i');
  const progNum = $('[data-progress]');
  let lastPct = -1;

  /* HUD */
  const hud = {
    fps: $('[data-hud="fps"]'),
    count: $('[data-hud="count"]'),
    state: $('[data-hud="state"]'),
    pointer: $('[data-hud="pointer"]'),
    vel: $('[data-hud="vel"]'),
  };
  let hudTimer = 0;
  const sign = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(3);

  /* odometer + counts */
  const odo = $('[data-odometer]');
  const navCount = $('[data-nav-count]');
  function setCount(n, animate = true) {
    const digits = String(n).padStart(4, '0');
    if (odo.children.length !== digits.length) {
      odo.innerHTML = '';
      [...digits].forEach((_, k) => {
        const d = document.createElement('span');
        d.className = 'odo-digit';
        const strip = document.createElement('span');
        strip.className = 'odo-strip';
        strip.style.setProperty('--k', digits.length - 1 - k);
        strip.innerHTML = '0123456789'
          .split('')
          .map((c) => `<span>${c}</span>`)
          .join('');
        d.appendChild(strip);
        odo.appendChild(d);
      });
    }
    [...odo.querySelectorAll('.odo-strip')].forEach((strip, k) => {
      if (!animate) strip.style.transition = 'none';
      strip.style.setProperty('--d', digits[k]);
      if (!animate) requestAnimationFrame(() => (strip.style.transition = ''));
    });
    odo.setAttribute('aria-label', `${n} 回`);
    navCount.textContent = digits;
  }

  /* messages + flash */
  const msg = $('[data-message]');
  function message(text) {
    msg.classList.remove('is-in');
    msg.textContent = text;
    void msg.offsetWidth;
    msg.classList.add('is-in');
  }
  const flashEl = $('.flash');
  function flash() {
    if (reduced) return;
    flashEl.classList.remove('is-on');
    void flashEl.offsetWidth;
    flashEl.classList.add('is-on');
  }

  /* hero glitch on the big title */
  function glitchTitle() {
    heroTitle.classList.remove('is-glitch');
    void heroTitle.offsetWidth;
    heroTitle.classList.add('is-glitch');
  }

  /* hero "now forming" label */
  const formingEl = $('[data-forming]');
  const FORMING = { text: '合掌 / GASSHŌ', hands: '祈 / FOLDED HANDS', enso: '円相 / ENSŌ', field: '空 / THE FIELD' };
  function setForming(key) {
    if (FORMING[key]) scramble(formingEl, 900, FORMING[key]);
  }

  function layout() {
    vw = innerWidth;
    vh = innerHeight;
    layoutMarquee();
    layoutForm();
  }
  layout();

  /* per frame */
  function update({ dt, scrollY, vel, stats }) {
    // pointer speed (normalised units per second)
    const dx = pointer.x - lastPX;
    const dy = pointer.y - lastPY;
    lastPX = pointer.x;
    lastPY = pointer.y;
    const inst = Math.hypot(dx / vw, dy / vh) / Math.max(dt, 1e-3);
    pointer.speed = lerp(pointer.speed, inst, 1 - Math.exp(-dt * 10));

    if (useCursor) {
      dot.style.transform = `translate3d(${pointer.x}px, ${pointer.y}px, 0)`;
      const k = 1 - Math.exp(-dt * 14);
      ringPos.x = lerp(ringPos.x, pointer.x, k);
      ringPos.y = lerp(ringPos.y, pointer.y, k);
      ring.style.transform = `translate3d(${ringPos.x.toFixed(1)}px, ${ringPos.y.toFixed(1)}px, 0)`;
    }

    updateHero(scrollY);
    updateManifesto();
    updateMarquee(dt, vel);
    updateInvert();
    const formP = updateForm(scrollY);

    spotR = lerp(spotR, spotTarget, 1 - Math.exp(-dt * 6));
    big.style.setProperty('--mr', `${spotR.toFixed(1)}px`);

    const maxScroll = Math.max(1, document.documentElement.scrollHeight - vh);
    const pct = clamp(scrollY / maxScroll);
    progFill.style.transform = `scaleY(${pct.toFixed(4)})`;
    const pctInt = Math.round(pct * 100);
    if (pctInt !== lastPct) {
      progNum.textContent = String(pctInt).padStart(3, '0');
      lastPct = pctInt;
    }

    hudTimer += dt;
    if (hudTimer > 0.25 && stats) {
      hudTimer = 0;
      hud.fps.textContent = String(Math.round(stats.fps));
      hud.count.textContent = stats.count.toLocaleString('en-US');
      hud.state.textContent = stats.state;
      hud.pointer.textContent = `${sign(pointer.nx)} / ${sign(pointer.ny)}`;
      hud.vel.textContent = String(Math.round(vel));
    }

    return { formP };
  }

  function ready() {
    document.body.classList.remove('is-loading');
    document.body.classList.add('is-ready');
    $$('[data-hero-split]').forEach((el) => el.classList.add('is-in'));
    observeReveals();
  }

  return { pointer, loader, layout, update, ready, setCount, message, flash, glitchTitle, setForming };
}
