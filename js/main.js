import { buildShapes } from './shapes.js';
import { initUI } from './ui.js';
import { createRitual, readCount } from './ritual.js';
import { createAudio } from './audio.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;
const small = Math.min(innerWidth, innerHeight) < 700;
const COUNT = reduced ? 32000 : coarse || small ? 48000 : 120000;

const STATE_LABEL = { enso: '円相 ENSŌ', text: '合掌 GASSHŌ', hands: '祈 HANDS', field: '空 FIELD' };
const HERO_CYCLE = ['text', 'hands', 'enso'];
const HERO_HOLD = 6.2;

// per-section look for the particles
const LOOK = {
  cycle: { alpha: 1, noise: 0.06, offsetY: 0.07 },
  field: { alpha: 0.85, noise: 0.24, offsetY: 0 },
  enso: { alpha: 1, noise: 0.05, offsetY: 0 },
  ritual: { alpha: 1, noise: 0.07, offsetY: -0.005 },
  hands: { alpha: 0.72, noise: 0.05, offsetY: 0.1 },
};

const audio = createAudio();
const ui = initUI({ reduced, coarse });
ui.setCount(readCount(), false);

/* ---------- smooth scroll ---------- */
let lenis = null;
if (window.Lenis && !reduced) {
  lenis = new window.Lenis({ lerp: 0.085, smoothWheel: true, wheelMultiplier: 0.9 });
  lenis.stop();
}
window.scrollTo(0, 0);
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

const scrollToTarget = (target) => {
  if (lenis) lenis.scrollTo(target, { duration: 1.8 });
  else if (typeof target === 'number') window.scrollTo({ top: target, behavior: reduced ? 'auto' : 'smooth' });
  else target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
};
document.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener('click', (e) => {
    const id = a.getAttribute('href');
    const el = id === '#top' ? null : document.querySelector(id);
    e.preventDefault();
    scrollToTarget(el || 0);
  });
});
document.querySelector('[data-top]').addEventListener('click', () => scrollToTarget(0));

/* ---------- sound toggle ---------- */
const soundBtn = document.querySelector('[data-sound]');
const soundLabel = document.querySelector('[data-sound-label]');
const paintSound = () => {
  soundBtn.setAttribute('aria-pressed', String(audio.enabled));
  soundLabel.textContent = audio.enabled ? 'ON' : 'OFF';
};
paintSound();
soundBtn.addEventListener('click', () => {
  audio.setEnabled(!audio.enabled);
  paintSound();
});
window.addEventListener('pointerdown', () => audio.unlock(), { once: true });

/* ---------- sections ---------- */
const sections = [...document.querySelectorAll('[data-particles]')].map((el) => ({
  el,
  mode: el.dataset.particles,
  top: 0,
  bottom: 0,
}));
function layoutSections() {
  const y = window.scrollY;
  sections.forEach((s) => {
    const r = s.el.getBoundingClientRect();
    s.top = r.top + y;
    s.bottom = r.bottom + y;
  });
}
function activeMode(scrollY) {
  const probe = scrollY + innerHeight * 0.5;
  for (const s of sections) if (probe >= s.top && probe < s.bottom) return s.mode;
  return sections[sections.length - 1].mode;
}

/* ---------- boot ---------- */
let particles = null;
let ritual = null;
const prayBtn = document.querySelector('[data-pray]');

async function boot() {
  ui.loader.set(0.05, '書体を読み込んでいます');
  const fontsReady = Promise.all([
    document.fonts.load('900 100px "Zen Old Mincho"', '合掌祈'),
    document.fonts.load('400 100px "Instrument Serif"', 'GASHO'),
    document.fonts.load('400 12px "JetBrains Mono"', 'GASHO'),
  ]).catch(() => {});
  await Promise.race([fontsReady, new Promise((r) => setTimeout(r, 3500))]);
  ui.loader.set(0.3, '形をつくっています');

  const shapes = await buildShapes(COUNT, (p) => ui.loader.set(0.3 + p * 0.45));
  ui.loader.set(0.78, '光を集めています');

  try {
    const { createParticles } = await import('./particles.js');
    particles = createParticles(document.getElementById('gl'), shapes, { maxDpr: coarse ? 1.5 : 1.6 });
  } catch (err) {
    console.warn('[gasho] WebGL is unavailable, continuing without particles.', err);
    document.documentElement.classList.add('no-webgl');
  }
  ui.loader.set(1, '手を合わせます');

  ritual = createRitual({
    button: prayBtn,
    audio,
    onComplete: ({ count, message }) => {
      ui.setCount(count);
      ui.message(message);
      ui.flash();
      ui.glitchTitle();
      if (particles) {
        particles.morphTo('hands', 0.01);
        particles.burst();
        setTimeout(() => particles.morphTo('enso', 2.2), 1400);
      }
    },
  });

  ui.layout();
  layoutSections();
  new ResizeObserver(() => {
    ui.layout();
    layoutSections();
  }).observe(document.body);
  window.addEventListener('resize', () => {
    particles?.resize();
    ui.layout();
    layoutSections();
  });

  // handle for poking at the page from the console
  window.__gasho = { lenis, particles, ritual };

  requestAnimationFrame(frame);
  await ui.loader.finish();
  ui.ready();
  lenis?.start();
  started = true;
}

/* ---------- frame loop ---------- */
let started = false;
let last = performance.now();
let lastScroll = 0;
let vel = 0;
let fps = 60;
let mode = null;
let cycleIdx = 0;
let cycleTimer = 0;
let shownKey = '';
let titleGlitchTimer = 4;

function frame(now) {
  const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
  last = now;
  fps = fps + (1 / dt - fps) * 0.05;

  lenis?.raf(now);
  const scrollY = window.scrollY;
  const instVel = (scrollY - lastScroll) / dt;
  lastScroll = scrollY;
  vel = vel + (instVel - vel) * (1 - Math.exp(-dt * 8));

  ritual?.update(dt);

  let stateKey = 'field';
  if (particles) {
    const next = started ? activeMode(scrollY) : 'loading';
    if (next !== mode) {
      mode = next;
      if (mode === 'cycle') cycleTimer = 0;
    }

    if (mode === 'cycle') {
      cycleTimer += dt;
      if (cycleTimer > HERO_HOLD) {
        cycleTimer = 0;
        cycleIdx = (cycleIdx + 1) % HERO_CYCLE.length;
      }
      particles.morphTo(HERO_CYCLE[cycleIdx], cycleIdx === 0 && particles.key === 'field' ? 3.4 : 2.6);
      stateKey = HERO_CYCLE[cycleIdx];
    } else if (mode === 'ritual') {
      if (!ritual.locked) particles.morphManual('enso', 'hands', ritual.progress);
      stateKey = ritual.progress > 0.5 || ritual.locked ? 'hands' : 'enso';
    } else if (mode === 'loading') {
      particles.morphTo('field');
    } else {
      particles.morphTo(mode);
      stateKey = mode;
    }

    if (stateKey !== shownKey) {
      shownKey = stateKey;
      ui.setForming(stateKey);
    }

    const look = { ...(LOOK[mode] || LOOK.field) };
    // in the ritual the ring follows the button as it scrolls
    if (mode === 'ritual') {
      const r = prayBtn.getBoundingClientRect();
      look.offsetY = Math.max(-0.5, Math.min(0.5, -(r.top + r.height / 2 - innerHeight / 2) / innerHeight));
    }
    const speed = Math.min(Math.abs(vel), 4000);
    const hold = mode === 'ritual' ? ritual.progress : 0;
    const p = ui.pointer;
    // no pointer push while the visitor is pressing the button: it would tear the hands apart
    const touchOnly = (coarse && !p.down) || (mode === 'ritual' && (ritual.holding || ritual.locked));
    const glitching = particles.update(dt, {
      alpha: started ? look.alpha : 0.55,
      noise: look.noise + speed * 0.00012,
      offsetY: look.offsetY,
      pointer: { x: p.nx, y: p.ny },
      force: touchOnly || !p.moved ? 0 : 0.28 + Math.min(p.speed * 0.6, 1.5) + (p.down ? 0.6 : 0),
      hold,
      damp: Math.min(0.9, 0.8 + speed * 0.00003 + hold * 0.05),
      bloom: 0.8 + hold * 0.3,
      spinSpeed: (reduced ? 0.04 : 0.16) + speed * 0.0007,
    });

    // occasionally tear the big title along with the canvas glitch
    titleGlitchTimer -= dt;
    if (glitching && titleGlitchTimer <= 0 && scrollY < innerHeight) {
      ui.glitchTitle();
      titleGlitchTimer = 3;
    }
  }

  ui.update({
    dt,
    scrollY,
    vel,
    stats: { fps, count: particles ? particles.count : 0, state: STATE_LABEL[stateKey] || '--' },
  });

  requestAnimationFrame(frame);
}

boot();
