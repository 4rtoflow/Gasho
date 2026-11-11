import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { TEXT_SIZE, HANDS_SIZE } from './shapes.js';

// weights for (enso, text, hands, field)
export const SHAPES = {
  enso: new THREE.Vector4(1, 0, 0, 0),
  text: new THREE.Vector4(0, 1, 0, 0),
  hands: new THREE.Vector4(0, 0, 1, 0),
  field: new THREE.Vector4(0, 0, 0, 1),
};

const NOISE = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uSize;
uniform float uPixelRatio;
uniform vec4 uWA;
uniform vec4 uWB;
uniform float uProgress;
uniform float uShapeScale;
uniform vec2 uShapeOffset;
uniform float uNoiseAmp;
uniform float uNoiseFreq;
uniform float uFlow;
uniform vec3 uMouse;
uniform float uMouseForce;
uniform float uMouseRadius;
uniform float uBurst;
uniform float uSpin;
uniform float uFocus;
uniform float uAlpha;
uniform float uHold;
uniform float uTravel;
uniform float uShapeSize;
uniform float uShapeDim;

attribute vec4 aT0;
attribute vec4 aT1;
attribute vec4 aT2;
attribute vec4 aT3;
attribute vec4 aRnd;

varying float vAlpha;

${NOISE}

mat2 rot2(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, s, -s, c);
}

void main() {
  // staggered morph: every particle leaves at its own moment
  float pp = clamp(uProgress * 1.5 - aRnd.y * 0.5, 0.0, 1.0);
  pp = pp * pp * (3.0 - 2.0 * pp);
  vec4 w = mix(uWA, uWB, pp);

  // galaxy field with differential rotation, then tilted towards the camera
  vec3 f = aT3.xyz;
  float r = length(f.xz);
  f.xz = rot2(uSpin / (0.8 + r * 0.45)) * f.xz;
  f.yz = rot2(1.12) * f.yz;

  float ws = w.x + w.y + w.z;
  vec3 shape = (aT0.xyz * w.x + aT1.xyz * w.y + aT2.xyz * w.z) * uShapeScale;
  vec3 p = shape + vec3(uShapeOffset, 0.0) * ws + f * w.w;
  float shade = aT0.w * w.x + aT1.w * w.y + aT2.w * w.z + aT3.w * w.w;

  // turbulence: always a little, a lot while travelling between shapes
  float travel = sin(pp * 3.14159265) * step(0.001, distance(uWA, uWB));
  float t = uTime * uFlow;
  vec3 q = p * uNoiseFreq + vec3(t * 0.35, -t * 0.22, t * 0.27);
  vec3 n = vec3(
    snoise(q),
    snoise(q + vec3(19.1, 7.3, 3.7)),
    snoise(q + vec3(-5.2, 13.7, 29.1))
  );
  float amp = uNoiseAmp * (0.35 + aRnd.w * 1.3) * (1.0 - uHold * 0.75)
            + travel * uTravel * (1.1 + aRnd.w * 2.2);
  p += n * amp;

  // pointer: push away and swirl around it
  vec2 d = p.xy - uMouse.xy;
  float dist = length(d) + 1e-4;
  float fall = exp(-(dist * dist) / (uMouseRadius * uMouseRadius));
  float force = fall * uMouseForce * (0.55 + aRnd.z * 0.9);
  p.xy += (d / dist) * force;
  p.xy += vec2(-d.y, d.x) / dist * force * 0.65;
  p.z += force * (aRnd.x - 0.35) * 1.4;

  // burst after a completed gasshō
  vec3 bdir = normalize(p + (aRnd.xyz - 0.5) * 0.8 + vec3(0.0, 0.0, 1e-3));
  p += bdir * uBurst * (0.6 + aRnd.z * aRnd.z * 6.0);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float depth = -mv.z;
  float coc = abs(depth - uFocus);
  float size = uSize * (0.35 + aRnd.z * aRnd.z * 1.7) * (1.0 + coc * 0.42) * mix(1.0, uShapeSize, ws);
  gl_PointSize = clamp(size * uPixelRatio * (10.0 / depth), 1.0, 56.0 * uPixelRatio);

  float twinkle = 0.68 + 0.32 * sin(uTime * (0.8 + aRnd.x * 3.2) + aRnd.y * 40.0);
  vAlpha = shade * twinkle * uAlpha * mix(1.0, uShapeDim, ws) / (1.0 + coc * coc * 0.28);
}
`;

const FRAGMENT = /* glsl */ `
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float a = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(vec3(1.0), a * a * vAlpha);
}
`;

// grain, scanlines, vignette, slight lens bend, glitch bands, flash — all in grey
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uGrain: { value: 0.09 },
    uFlash: { value: 0 },
    uGlitch: { value: 0 },
    uSeed: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uRes;
    uniform float uGrain;
    uniform float uFlash;
    uniform float uGlitch;
    uniform float uSeed;
    varying vec2 vUv;

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    void main() {
      vec2 uv = vUv;
      float band = floor(uv.y * 28.0);
      float hit = step(0.8, hash(vec2(band, floor(uSeed * 97.0)))) * uGlitch;
      uv.x += (hash(vec2(band, uSeed * 13.0)) - 0.5) * 0.14 * hit;

      vec2 c = uv - 0.5;
      uv = 0.5 + c * (1.0 - 0.045 * dot(c, c));

      vec3 col = texture2D(tDiffuse, uv).rgb;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      if (hit > 0.0) {
        float g2 = dot(texture2D(tDiffuse, uv + vec2(0.012, 0.0)).rgb, vec3(0.333));
        l = max(l, g2 * 0.7);
        l = mix(l, 1.0 - l, step(0.93, hash(vec2(band, uSeed))));
      }

      // deeper blacks
      l = max(0.0, l - 0.035) / 0.965;
      l = pow(l, 1.12);

      float vig = smoothstep(0.98, 0.22, length(c * vec2(1.0, 1.2)));
      l *= mix(0.5, 1.0, vig);

      float g = hash(vUv * uRes + fract(uTime * 7.13) * 917.0) - 0.5;
      l += g * uGrain;
      l *= 0.965 + 0.035 * sin(vUv.y * uRes.y * 1.5708);
      l += uFlash;

      gl_FragColor = vec4(vec3(clamp(l, 0.0, 1.0)), 1.0);
    }
  `,
};

const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

export function createParticles(canvas, shapes, { maxDpr = 1.6 } = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
  });
  renderer.setClearColor(0x000000, 1);

  let dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  renderer.setPixelRatio(dpr);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 120);
  camera.position.set(0, 0, 10);

  const { count } = shapes;
  // more particles → each one dimmer, so the overall exposure stays similar
  const alphaScale = Math.pow(32000 / count, 0.55);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute('aT0', new THREE.BufferAttribute(shapes.T0, 4));
  geometry.setAttribute('aT1', new THREE.BufferAttribute(shapes.T1, 4));
  geometry.setAttribute('aT2', new THREE.BufferAttribute(shapes.T2, 4));
  geometry.setAttribute('aT3', new THREE.BufferAttribute(shapes.T3, 4));
  geometry.setAttribute('aRnd', new THREE.BufferAttribute(shapes.R, 4));

  const uniforms = {
    uTime: { value: 0 },
    uSize: { value: 2.6 },
    uPixelRatio: { value: dpr },
    uWA: { value: SHAPES.field.clone() },
    uWB: { value: SHAPES.field.clone() },
    uProgress: { value: 1 },
    uShapeScale: { value: 1 },
    uShapeOffset: { value: new THREE.Vector2(0, 0) },
    uNoiseAmp: { value: 0.2 },
    uNoiseFreq: { value: 0.55 },
    uFlow: { value: 1 },
    uMouse: { value: new THREE.Vector3(99, 99, 0) },
    uMouseForce: { value: 0 },
    uMouseRadius: { value: 1.1 },
    uBurst: { value: 0 },
    uSpin: { value: 0 },
    uFocus: { value: 10 },
    uAlpha: { value: 0 },
    uHold: { value: 0 },
    uTravel: { value: 1 },
    uShapeSize: { value: 1 },
    uShapeDim: { value: 1 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);

  // post-processing
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(dpr);
  const renderPass = new RenderPass(scene, camera);
  const afterimage = new AfterimagePass(0.82);
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.85, 0.55, 0.12);
  const output = new OutputPass();
  const finalPass = new ShaderPass(FinalShader);
  composer.addPass(renderPass);
  composer.addPass(afterimage);
  composer.addPass(bloom);
  composer.addPass(output);
  composer.addPass(finalPass);

  const view = { w: 1, h: 1, visW: 1, visH: 1 };

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const visH = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 10;
    const visW = visH * camera.aspect;
    Object.assign(view, { w, h, visW, visH });
    uniforms.uPixelRatio.value = dpr;
    const shapeScale = Math.min(
      1.12,
      (visW * 0.86) / TEXT_SIZE.w,
      (visH * 0.62) / Math.max(TEXT_SIZE.h, HANDS_SIZE.h),
    );
    uniforms.uShapeScale.value = shapeScale;
    // On small screens the shapes cover fewer pixels, so the same particles pile up and burn white.
    // Shrink and dim them in proportion (reference: a 1440x900 window ≈ 151 px per unit).
    const r = ((h / visH) * shapeScale) / 151;
    const sz = Math.min(1.1, Math.max(0.55, Math.sqrt(r)));
    uniforms.uShapeSize.value = sz;
    uniforms.uShapeDim.value = Math.min(1, Math.max(0.15, (r * r) / (sz * sz)));
    finalPass.uniforms.uRes.value.set(w * dpr, h * dpr);
  }
  resize();

  /* ---------- morph ---------- */
  const morph = { a: SHAPES.field.clone(), b: SHAPES.field.clone(), p: 1, dur: 2.4, key: 'field', manual: false };

  // the weights an average particle has right now (matches the shader's stagger for aRnd.y = 0.5)
  function currentWeights() {
    let pp = Math.min(1, Math.max(0, morph.p * 1.5 - 0.25));
    pp = pp * pp * (3 - 2 * pp);
    return morph.a.clone().lerp(morph.b, pp);
  }

  function morphTo(key, dur = 2.4) {
    if (!morph.manual && morph.key === key) return;
    morph.a.copy(currentWeights());
    morph.b.copy(SHAPES[key]);
    morph.p = 0;
    morph.dur = dur;
    morph.key = key;
    morph.manual = false;
  }

  function morphManual(fromKey, toKey, p) {
    morph.a.copy(SHAPES[fromKey]);
    morph.b.copy(SHAPES[toKey]);
    morph.p = p;
    morph.key = `${fromKey}>${toKey}`;
    morph.manual = true;
  }

  /* ---------- one-shot effects ---------- */
  let burstAt = -10;
  let flashAt = -10;
  let glitchUntil = -10;
  let nextGlitch = 5 + Math.random() * 6;
  let clock = 0;

  function burst() {
    burstAt = clock;
    flashAt = clock;
    glitchUntil = clock + 0.28;
  }
  function glitch(duration = 0.18) {
    glitchUntil = clock + duration;
  }

  /* ---------- adaptive resolution ---------- */
  let slowTime = 0;
  function adapt(dt) {
    if (dt > 1 / 38) slowTime += dt;
    else slowTime = Math.max(0, slowTime - dt * 0.5);
    if (slowTime > 1.6 && dpr > 0.8) {
      dpr = Math.max(0.75, dpr * 0.8);
      slowTime = 0;
      resize();
    }
  }

  /* ---------- per frame ---------- */
  const fx = { noise: 0.2, alpha: 0, offsetY: 0, force: 0, hold: 0, damp: 0.82, bloom: 0.85, size: 2.6 };
  let spin = 0;
  let camX = 0;
  let camY = 0;

  function update(dt, target) {
    clock += dt;
    adapt(dt);

    if (!morph.manual && morph.p < 1) morph.p = Math.min(1, morph.p + dt / morph.dur);
    uniforms.uWA.value.copy(morph.a);
    uniforms.uWB.value.copy(morph.b);
    uniforms.uProgress.value = morph.p;
    // a hand-driven morph (press & hold) travels in calmer, straighter lines
    uniforms.uTravel.value = damp(uniforms.uTravel.value, morph.manual ? 0.15 : 1, 4, dt);

    fx.noise = damp(fx.noise, target.noise, 2.2, dt);
    fx.alpha = damp(fx.alpha, target.alpha, 1.6, dt);
    fx.offsetY = damp(fx.offsetY, target.offsetY, 2.5, dt);
    fx.force = damp(fx.force, target.force, 6, dt);
    fx.hold = damp(fx.hold, target.hold, 5, dt);
    fx.damp = damp(fx.damp, target.damp, 3, dt);
    fx.bloom = damp(fx.bloom, target.bloom, 3, dt);

    spin += dt * target.spinSpeed;

    uniforms.uTime.value = clock;
    uniforms.uNoiseAmp.value = fx.noise;
    // while particles travel, their trails pile up; shorten the trails and dim a little
    const moving = morph.p < 1 ? Math.sin(Math.PI * Math.min(1, morph.p * 1.2)) : 0;
    fx.moving = damp(fx.moving || 0, moving, 6, dt);
    uniforms.uAlpha.value = fx.alpha * alphaScale * (1 - 0.4 * fx.moving);
    uniforms.uShapeOffset.value.set(0, fx.offsetY * view.visH);
    uniforms.uMouse.value.set(target.pointer.x * view.visW * 0.5, target.pointer.y * view.visH * 0.5, 0);
    uniforms.uMouseForce.value = fx.force;
    uniforms.uHold.value = fx.hold;
    uniforms.uSpin.value = spin;

    // burst: rises fast, settles back
    const bt = clock - burstAt;
    const tau = 0.32;
    uniforms.uBurst.value = bt < 4 ? 2.1 * (bt / tau) * Math.exp(1 - bt / tau) : 0;

    // camera: drift with the pointer, lean in while holding
    camX = damp(camX, target.pointer.x * 0.45, 2, dt);
    camY = damp(camY, target.pointer.y * 0.3, 2, dt);
    camera.position.set(camX, camY, 10 - fx.hold * 1.6);
    camera.lookAt(0, fx.offsetY * view.visH * 0.3, 0);
    uniforms.uFocus.value = camera.position.length();

    points.rotation.y = Math.sin(clock * 0.21) * 0.2 * (1 - fx.hold);
    points.rotation.x = Math.sin(clock * 0.17 + 1.3) * 0.06;

    afterimage.uniforms.damp.value = fx.damp - 0.22 * fx.moving;
    bloom.strength = fx.bloom;

    // glitch: rare, short, random
    if (clock > nextGlitch) {
      glitch(0.08 + Math.random() * 0.18);
      nextGlitch = clock + 4 + Math.random() * 9;
    }
    const glitching = clock < glitchUntil;
    finalPass.uniforms.uGlitch.value = glitching ? 1 : 0;
    if (glitching) finalPass.uniforms.uSeed.value = Math.random();
    finalPass.uniforms.uTime.value = clock;
    const ft = clock - flashAt;
    finalPass.uniforms.uFlash.value = ft < 1.5 ? 0.55 * Math.exp(-ft / 0.16) : 0;

    composer.render(dt);
    return glitching;
  }

  return {
    count,
    view,
    resize,
    update,
    morphTo,
    morphManual,
    burst,
    glitch,
    get key() {
      return morph.key;
    },
    get dpr() {
      return dpr;
    },
  };
}
