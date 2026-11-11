// Particle target shapes.
// Every target is a Float32Array of count * 4 : (x, y, z, shade).
//   T0 : 円相 (ensō)  — a single brush stroke circle, generated procedurally
//   T1 : 合掌          — the two kanji, sampled from a canvas
//   T2 : 🙏           — the folded-hands emoji, sampled from a canvas
//   T3 : field        — a spiral galaxy plus loose dust

const TAU = Math.PI * 2;

export const TEXT_SIZE = { w: 6.6, h: 3.4 };
export const HANDS_SIZE = { w: 4.4, h: 3.7 };

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

// Draw something on a canvas and collect the opaque pixels.
// Pixels near the outline (or across a strong change in brightness) go to `edge`.
function sampleCanvas(draw, w, h, threshold = 110) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  draw(ctx, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const alpha = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : data[(y * w + x) * 4 + 3]);
  const lum = (x, y) => {
    const i = (y * w + x) * 4;
    return (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
  };

  const fill = [];
  const edge = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const R = 3;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha(x, y) < threshold) continue;
      const l = lum(x, y);
      let isEdge =
        alpha(x - R, y) < threshold ||
        alpha(x + R, y) < threshold ||
        alpha(x, y - R) < threshold ||
        alpha(x, y + R) < threshold;
      if (!isEdge && x > 1 && y > 1 && x < w - 2 && y < h - 2) {
        const g = Math.max(Math.abs(lum(x + 2, y) - lum(x - 2, y)), Math.abs(lum(x, y + 2) - lum(x, y - 2)));
        if (g > 0.16) isEdge = true;
      }
      (isEdge ? edge : fill).push(x, y, l);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  return {
    fill,
    edge,
    count: (fill.length + edge.length) / 3,
    bbox: { minX, minY, maxX, maxY },
  };
}

function lumRange(sample) {
  const values = [];
  const all = [sample.fill, sample.edge];
  for (const arr of all) for (let i = 2; i < arr.length; i += 30) values.push(arr[i]);
  values.sort((a, b) => a - b);
  if (!values.length) return [0, 1];
  const lo = values[Math.floor(values.length * 0.04)];
  const hi = values[Math.floor(values.length * 0.96)];
  return [lo, Math.max(hi, lo + 0.05)];
}

function writeFromSample(target, count, sample, rand, { maxW, maxH, edgeRatio, z, shade }) {
  const { fill, edge, bbox } = sample;
  const bw = bbox.maxX - bbox.minX + 1;
  const bh = bbox.maxY - bbox.minY + 1;
  const scale = Math.min(maxW / bw, maxH / bh);
  const cx = (bbox.minX + bbox.maxX + 1) / 2;
  const cy = (bbox.minY + bbox.maxY + 1) / 2;
  const nE = edge.length / 3;
  const nF = fill.length / 3;

  for (let i = 0; i < count; i++) {
    const useEdge = nE > 0 && (nF === 0 || rand() < edgeRatio);
    const src = useEdge ? edge : fill;
    const n = useEdge ? nE : nF;
    const k = Math.floor(rand() * n) * 3;
    const px = src[k] + rand();
    const py = src[k + 1] + rand();
    const l = src[k + 2];
    const o = i * 4;
    target[o] = (px - cx) * scale;
    target[o + 1] = -(py - cy) * scale;
    target[o + 2] = z(l, useEdge, rand);
    target[o + 3] = shade(l, useEdge, rand);
  }
}

/* ---------- 円相 ---------- */
function buildEnso(target, count, rand) {
  const start = 1.85;
  const sweep = TAU * 0.9;
  const R0 = 2.0;
  const bristles = Array.from({ length: 72 }, () => rand());
  const drops = Array.from({ length: 16 }, () => {
    const a = start + 0.18 + gauss(rand) * 0.22;
    const r = R0 + gauss(rand) * 0.42;
    return [Math.cos(a) * r, Math.sin(a) * r, 0.012 + rand() * 0.05];
  });

  for (let i = 0; i < count; i++) {
    const o = i * 4;
    if (rand() < 0.03) {
      const d = drops[Math.floor(rand() * drops.length)];
      target[o] = d[0] + gauss(rand) * d[2];
      target[o + 1] = d[1] + gauss(rand) * d[2];
      target[o + 2] = gauss(rand) * 0.05;
      target[o + 3] = 0.85;
      continue;
    }

    let t = 0;
    let u = 0;
    let dry = 0;
    for (let tries = 0; tries < 14; tries++) {
      t = Math.pow(rand(), 1.18);
      u = rand() * 2 - 1;
      dry = smoothstep(0.42, 1.0, t);
      const b = bristles[Math.floor((u * 0.5 + 0.5) * 71.999)];
      // the brush runs out of ink towards the end: whole bristle streaks go empty
      const keep = b > dry * 0.9 ? 1 : 1 - dry;
      if (rand() < keep) break;
    }

    const ang = start - t * sweep;
    const width =
      0.07 + 0.4 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.14 + t * 0.92)), 0.55) * (1 - 0.4 * t);
    const wobble = 0.06 * Math.sin(t * 11.0) + 0.025 * Math.sin(t * 29.0 + 1.3);
    const tail = t > 0.78 ? (t - 0.78) * 0.55 : 0;
    const r = R0 + wobble + tail + u * width * 0.5;

    target[o] = Math.cos(ang) * r;
    target[o + 1] = Math.sin(ang) * r;
    target[o + 2] = u * 0.14 + gauss(rand) * 0.04;
    target[o + 3] = (0.42 + 0.58 * Math.pow(1 - Math.abs(u), 0.5)) * (1 - dry * 0.35);
  }
}

/* ---------- field ---------- */
function buildField(target, count, rand) {
  const ARMS = 3;
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    if (rand() < 0.8) {
      const arm = Math.floor(rand() * ARMS);
      const r = 0.35 + Math.pow(rand(), 0.72) * 9.8;
      const ang = (arm / ARMS) * TAU + r * 0.62 + gauss(rand) * (0.16 + 0.55 / (r + 0.6));
      const spread = 0.1 + r * 0.045;
      target[o] = Math.cos(ang) * r + gauss(rand) * spread;
      target[o + 1] = gauss(rand) * (0.06 + r * 0.03);
      target[o + 2] = Math.sin(ang) * r + gauss(rand) * spread;
      target[o + 3] = 0.2 + 0.55 * Math.exp(-r * 0.28) + rand() * 0.14;
    } else {
      target[o] = (rand() - 0.5) * 26;
      target[o + 1] = (rand() - 0.5) * 14;
      target[o + 2] = (rand() - 0.5) * 14;
      target[o + 3] = 0.1 + rand() * 0.22;
    }
  }
}

export async function buildShapes(count, onProgress = () => {}) {
  const rand = mulberry32(0x6a55);
  const T0 = new Float32Array(count * 4);
  const T1 = new Float32Array(count * 4);
  const T2 = new Float32Array(count * 4);
  const T3 = new Float32Array(count * 4);
  const R = new Float32Array(count * 4);

  for (let i = 0; i < R.length; i++) R[i] = rand();

  buildEnso(T0, count, rand);
  onProgress(0.25);
  await nextFrame();

  buildField(T3, count, rand);
  onProgress(0.4);
  await nextFrame();

  // 合掌
  const textSample = sampleCanvas(
    (ctx, w, h) => {
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `900 ${Math.round(h * 0.8)}px "Zen Old Mincho", "Hiragino Mincho ProN", "Yu Mincho", serif`;
      ctx.fillText('合掌', w / 2, h / 2);
    },
    1100,
    560,
  );
  writeFromSample(T1, count, textSample, rand, {
    maxW: TEXT_SIZE.w,
    maxH: TEXT_SIZE.h,
    edgeRatio: 0.42,
    z: (l, e, r) => (r() - 0.5) * 0.3,
    shade: (l, e, r) => (e ? 1.0 : 0.42 + r() * 0.22),
  });
  onProgress(0.65);
  await nextFrame();

  // 🙏  (falls back to 祈 if the platform cannot draw the emoji)
  let handsSample = sampleCanvas(
    (ctx, w, h) => {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${Math.round(h * 0.82)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
      ctx.fillText('🙏', w / 2, h * 0.54);
    },
    600,
    600,
  );
  let handsFallback = false;
  if (handsSample.count < 4000) {
    handsFallback = true;
    handsSample = sampleCanvas(
      (ctx, w, h) => {
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `900 ${Math.round(h * 0.8)}px "Zen Old Mincho", serif`;
        ctx.fillText('祈', w / 2, h / 2);
      },
      600,
      600,
    );
  }
  const [lo, hi] = lumRange(handsSample);
  writeFromSample(T2, count, handsSample, rand, {
    maxW: HANDS_SIZE.w,
    maxH: HANDS_SIZE.h,
    edgeRatio: 0.38,
    z: (l, e, r) => ((l - lo) / (hi - lo) - 0.5) * 0.9 + (r() - 0.5) * 0.14,
    shade: (l, e, r) => {
      const n = Math.min(1, Math.max(0, (l - lo) / (hi - lo)));
      return e ? 1.0 : 0.22 + n * 0.62 + r() * 0.08;
    },
  });
  onProgress(0.9);
  await nextFrame();

  return { T0, T1, T2, T3, R, count, handsFallback };
}
