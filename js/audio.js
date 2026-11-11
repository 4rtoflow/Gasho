// Synthesised sound: a rin (bowl bell) on completion and a low hum while holding.
// Nothing plays until the visitor turns sound on.

const STORAGE_KEY = 'gasho:sound';

function readPref() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

function writePref(on) {
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    /* storage unavailable */
  }
}

function makeImpulse(ctx, seconds, decay) {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * seconds);
  const buffer = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
  }
  return buffer;
}

export function createAudio() {
  let enabled = readPref();
  let ctx = null;
  let master = null;
  let reverb = null;
  let hum = null;

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      reverb = ctx.createConvolver();
      reverb.buffer = makeImpulse(ctx, 4.2, 2.8);
      const wet = ctx.createGain();
      wet.gain.value = 0.5;
      reverb.connect(wet);
      wet.connect(master);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function bell(strength = 1) {
    if (!enabled) return;
    const c = ensure();
    if (!c) return;
    const now = c.currentTime + 0.01;
    const f0 = 392 * (0.985 + Math.random() * 0.03);
    // [ratio, amplitude, decay seconds]
    const partials = [
      [1, 1, 8],
      [2.756, 0.55, 5.2],
      [5.404, 0.3, 3.2],
      [8.933, 0.16, 1.9],
      [13.34, 0.07, 1.1],
    ];
    const out = c.createGain();
    out.gain.value = 0.2 * strength;
    out.connect(master);
    out.connect(reverb);

    for (const [ratio, amp, decay] of partials) {
      for (const detune of [-0.7, 0.7]) {
        const osc = c.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = f0 * ratio + detune * ratio;
        const g = c.createGain();
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(amp * 0.5, now + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, now + decay);
        osc.connect(g);
        g.connect(out);
        osc.start(now);
        osc.stop(now + decay + 0.1);
      }
    }

    // the strike
    const len = Math.floor(c.sampleRate * 0.04);
    const nb = c.createBuffer(1, len, c.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < len; i++) nd[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = c.createBufferSource();
    src.buffer = nb;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3200;
    bp.Q.value = 1.4;
    const ng = c.createGain();
    ng.gain.value = 0.35;
    src.connect(bp);
    bp.connect(ng);
    ng.connect(out);
    src.start(now);
  }

  function buildHum(c) {
    const gain = c.createGain();
    gain.gain.value = 0;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 520;
    lp.Q.value = 0.7;
    lp.connect(gain);
    gain.connect(master);
    gain.connect(reverb);
    const oscs = [98, 147, 196.4].map((f, i) => {
      const o = c.createOscillator();
      o.type = i === 1 ? 'triangle' : 'sine';
      o.frequency.value = f;
      const g = c.createGain();
      g.gain.value = [0.6, 0.25, 0.3][i];
      o.connect(g);
      g.connect(lp);
      o.start();
      return o;
    });
    return { gain, lp, oscs };
  }

  function setHum(level) {
    if (!ctx || !enabled) {
      if (hum && ctx) hum.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
      return;
    }
    if (!hum) {
      if (level < 0.001) return;
      hum = buildHum(ctx);
    }
    const t = ctx.currentTime;
    hum.gain.gain.setTargetAtTime(level * level * 0.14, t, 0.08);
    hum.lp.frequency.setTargetAtTime(380 + level * 900, t, 0.1);
    hum.oscs.forEach((o, i) => o.frequency.setTargetAtTime([98, 147, 196.4][i] * (1 + level * 0.06), t, 0.1));
  }

  function setEnabled(on) {
    enabled = on;
    writePref(on);
    if (on) {
      ensure();
      bell(0.45);
    } else if (hum && ctx) {
      hum.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    }
  }

  // call from a user gesture so the context may start
  function unlock() {
    if (enabled) ensure();
  }

  return {
    get enabled() {
      return enabled;
    },
    setEnabled,
    unlock,
    bell,
    setHum,
  };
}
