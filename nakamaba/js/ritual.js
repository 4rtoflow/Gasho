// Press-and-hold interaction. Holding fills the ring; at 100% a gasshō is counted.

const HOLD_SECONDS = 1.8;
const LOCK_SECONDS = 3.6;
const STORAGE_KEY = 'gasho:count';

const MESSAGES = [
  '届きました。',
  'ありがたや。',
  'よい一日を。',
  '静かに、整いました。',
  '今日も、おつかれさまです。',
  'ご縁がありますように。',
  '南無。',
  '心が、ひとつに。',
];

export function readCount() {
  try {
    return Math.max(0, parseInt(localStorage.getItem(STORAGE_KEY) || '0', 10) || 0);
  } catch {
    return 0;
  }
}

function writeCount(n) {
  try {
    localStorage.setItem(STORAGE_KEY, String(n));
  } catch {
    /* storage unavailable */
  }
}

export function createRitual({ button, audio, onComplete }) {
  const hint = button.querySelector('[data-pray-hint]');
  let holding = false;
  let progress = 0;
  let lock = 0;
  let count = readCount();
  let lastMsg = -1;

  const start = () => {
    if (lock > 0) return;
    audio.unlock();
    holding = true;
    button.classList.add('is-holding');
  };
  const stop = () => {
    holding = false;
    button.classList.remove('is-holding');
  };

  button.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    try {
      button.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    start();
  });
  button.addEventListener('pointerup', stop);
  button.addEventListener('pointercancel', stop);
  button.addEventListener('lostpointercapture', stop);
  button.addEventListener('contextmenu', (e) => e.preventDefault());
  button.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' && e.code !== 'Enter') return;
    e.preventDefault();
    if (!e.repeat) start();
  });
  button.addEventListener('keyup', (e) => {
    if (e.code === 'Space' || e.code === 'Enter') stop();
  });
  // Space anywhere inside the ritual section also works, once the section is on screen
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || document.activeElement === button) return;
    const r = button.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return;
    e.preventDefault();
    start();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && document.activeElement !== button) stop();
  });
  window.addEventListener('blur', stop);

  function complete() {
    stop();
    lock = LOCK_SECONDS;
    count += 1;
    writeCount(count);
    let i = Math.floor(Math.random() * MESSAGES.length);
    if (i === lastMsg) i = (i + 1) % MESSAGES.length;
    lastMsg = i;
    button.classList.remove('is-done');
    void button.offsetWidth;
    button.classList.add('is-done');
    hint.textContent = 'THANK YOU';
    audio.setHum(0);
    audio.bell(1);
    navigator.vibrate?.([30, 40, 60]);
    onComplete({ count, message: MESSAGES[i] });
  }

  function update(dt) {
    if (lock > 0) {
      lock -= dt;
      progress = Math.max(0, progress - dt * 0.6);
      if (lock <= 0) {
        lock = 0;
        progress = 0;
        hint.textContent = 'HOLD';
        button.classList.remove('is-done');
      }
    } else if (holding) {
      progress = Math.min(1, progress + dt / HOLD_SECONDS);
      if (progress >= 1) complete();
    } else {
      progress = Math.max(0, progress - dt * 1.4);
    }
    button.style.setProperty('--p', progress.toFixed(4));
    if (lock === 0) audio.setHum(holding ? progress : 0);
  }

  return {
    update,
    get progress() {
      return progress;
    },
    get holding() {
      return holding;
    },
    get locked() {
      return lock > 0;
    },
    get count() {
      return count;
    },
  };
}
