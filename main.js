// ================================================================
// TONEKEEP — MAIN.JS
// Three.js WebGL scene + JUCE 8 native bridge.
//
// JUCE integration
// ────────────────
// C++ → JS:  webView->emitEventIfBrowserIsVisible("eventId", var)
//             → window.__JUCE__.backend.addEventListener("eventId", fn)
//
// JS → C++:  window.__JUCE__.backend.emitEvent("eventId", object)
//             → Options.withEventListener("eventId", fn)
// ================================================================

import * as THREE from 'three';
import { OBJLoader }         from 'three/addons/loaders/OBJLoader.js';
import { OrbitControls }     from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment }   from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries }   from 'three/addons/utils/BufferGeometryUtils.js';

// ── CONFIG ──────────────────────────────────────────────────────
const CFG = Object.freeze({
  OBJ_PATH: './amp2.obj',

  CAM_FOV: 48, CAM_NEAR: 0.1, CAM_FAR: 100,
  // 3/4 front-right view, eye-level — shows amp face + water surface
  CAM_POS: [1.8, 1.6, 3.8], CAM_TARGET: [0, 0.4, 0],

  AUTO_ROTATE_SPEED: 0,

  FLUID_SEGMENTS:   72,
  FLUID_WORLD_SIZE: 2.2,
  FLUID_MAX_AMP:    0.48,
  FLUID_FREQ_X:     2.5,
  FLUID_FREQ_Z:     2.0,
  FLUID_TIME_SCALE: 0.0020,
  FLUID_PHASE:      1.4,
});

// ── STATE ────────────────────────────────────────────────────────
const STATE = {
  // APVTS mirrors — normalised [0,1]
  inputGain:  0.7692,   // 0 dB on -40→+12 range
  volume:     0.60,
  treble:     0.50,
  bass:       0.50,
  reverb:     0.30,
  rate:       0.20,
  depth:      0.00,
  outputGain: 0.625,    // 0 dB on -40→+24 range

  // Audio level pushed from C++ at 30 Hz
  audioLevel: 0.0,

  frameCount: 0, lastTime: 0, fps: 0,
};

// ── DOM REFS ─────────────────────────────────────────────────────
const canvas     = document.getElementById('webgl-canvas');
const loadStatus = document.getElementById('load-status');
const cabSelect  = document.getElementById('cab-select');
const revSelect  = document.getElementById('rev-select');
const cabToggle  = document.getElementById('cab-toggle');
const revToggle  = document.getElementById('rev-toggle');

const valEls = {
  inputGain:  document.getElementById('val-inputGain'),
  volume:     document.getElementById('val-volume'),
  treble:     document.getElementById('val-treble'),
  bass:       document.getElementById('val-bass'),
  reverb:     document.getElementById('val-reverb'),
  rate:       document.getElementById('val-rate'),
  depth:      document.getElementById('val-depth'),
  outputGain: document.getElementById('val-outputGain'),
};

const inBarFill  = document.getElementById('in-bar-fill');
const outBarFill = document.getElementById('out-bar-fill');

// ── KNOB VALUE FORMATTING ────────────────────────────────────────
// Gain knobs: dB labels matching APVTS ranges in PluginProcessor.cpp
//   inputGain:  -40 → +12 dB  (range 52)
//   outputGain: -40 → +24 dB  (range 64)
// All other knobs: 1.0 – 10.0 float
const GAIN_DB = {
  inputGain:  { min: -40, range: 52 },
  outputGain: { min: -40, range: 64 },
};

function formatKnobValue(param, normalized) {
  const g = GAIN_DB[param];
  if (g) {
    const db = g.min + normalized * g.range;
    if (db <= -39.9) return '-inf';
    return (db >= 0 ? '+' : '') + db.toFixed(1) + ' dB';
  }
  return (normalized * 10).toFixed(1);
}

function updateGainBars() {
  if (inBarFill)  inBarFill.style.height  = (STATE.inputGain  * 100).toFixed(1) + '%';
  if (outBarFill) outBarFill.style.height = (STATE.outputGain * 100).toFixed(1) + '%';
}

// ── JUCE BRIDGE ──────────────────────────────────────────────────
const JUCE_BRIDGE = {
  ready: false,
  pageReadySent: false,
  disposed: false,
  retryTimer: 0,
  queue: [],
  listeners: [],
};

const CLEANUP = [];

function listen(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  CLEANUP.push(() => target.removeEventListener(type, handler, options));
}

function getJuceBackend() {
  return window.__JUCE__?.backend ?? null;
}

function emitToJuce(eventId, payload = {}) {
  if (JUCE_BRIDGE.disposed) return;

  const backend = getJuceBackend();
  if (!backend) {
    if (JUCE_BRIDGE.queue.length >= 64)
      JUCE_BRIDGE.queue.shift();
    JUCE_BRIDGE.queue.push({ eventId, payload });
    return;
  }
  backend.emitEvent(eventId, payload);
}

function addJuceListener(eventId, callback) {
  JUCE_BRIDGE.listeners.push({ eventId, callback, registered: false });
}

function flushJuceBridge() {
  if (JUCE_BRIDGE.disposed) return;

  const backend = getJuceBackend();
  if (!backend) {
    JUCE_BRIDGE.retryTimer = window.setTimeout(flushJuceBridge, 25);
    return;
  }

  for (const entry of JUCE_BRIDGE.listeners) {
    if (!entry.registered) {
      backend.addEventListener(entry.eventId, entry.callback);
      entry.registered = true;
    }
  }

  JUCE_BRIDGE.ready = true;

  while (JUCE_BRIDGE.queue.length > 0) {
    const { eventId, payload } = JUCE_BRIDGE.queue.shift();
    backend.emitEvent(eventId, payload);
  }

  if (!JUCE_BRIDGE.pageReadySent) {
    JUCE_BRIDGE.pageReadySent = true;
    backend.emitEvent('pageReady', {});
  }
}

// ── RENDERER ─────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.localClippingEnabled = true;

// ── SCENE + CAMERA ───────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x3A5268);

const camera = new THREE.PerspectiveCamera(CFG.CAM_FOV, 1, CFG.CAM_NEAR, CFG.CAM_FAR);
camera.position.set(...CFG.CAM_POS);
camera.lookAt(...CFG.CAM_TARGET);

// ── ORBIT CONTROLS ───────────────────────────────────────────────
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping  = true;
controls.dampingFactor  = 0.06;
controls.enablePan      = false;
controls.minDistance    = 1.5;
controls.maxDistance    = 9;
controls.target.set(...CFG.CAM_TARGET);

let isOrbitActive = false;
const onOrbitStart = () => { isOrbitActive = true; };
const onOrbitEnd   = () => { isOrbitActive = false; };
controls.addEventListener('start', onOrbitStart);
controls.addEventListener('end', onOrbitEnd);
CLEANUP.push(() => {
  controls.removeEventListener('start', onOrbitStart);
  controls.removeEventListener('end', onOrbitEnd);
  controls.dispose();
});

// ── ENVIRONMENT ──────────────────────────────────────────────────
const pmrem   = new THREE.PMREMGenerator(renderer);
const roomEnv = new RoomEnvironment();
scene.environment = pmrem.fromScene(roomEnv).texture;
roomEnv.dispose(); pmrem.dispose();

// ── LIGHTING ─────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0x0a1828, 0.6));

const keyLight  = new THREE.DirectionalLight(0xffecd0, 1.8);
keyLight.position.set(3, 5, 3);
scene.add(keyLight);

const rimLight  = new THREE.DirectionalLight(0x1a3fff, 0.6);
rimLight.position.set(-3, 1, -5);
scene.add(rimLight);

const waterLight = new THREE.PointLight(0x00aaff, 5.0, 6);
waterLight.position.set(0, -0.6, 0);
scene.add(waterLight);

const topSpot = new THREE.DirectionalLight(0xffffff, 0.4);
topSpot.position.set(0, 10, 1);
scene.add(topSpot);

// ── GLASS MATERIAL ───────────────────────────────────────────────
const glassMaterial = new THREE.MeshPhysicalMaterial({
  color: 0xe8f4ff, transmission: 0.88, opacity: 1.0,
  roughness: 0.08, metalness: 0.0, ior: 1.18, thickness: 0.4,
  clearcoat: 1.0, clearcoatRoughness: 0.05,
  transparent: true, envMapIntensity: 0.45,
  attenuationColor: new THREE.Color(0xc8e8ff), attenuationDistance: 4.0,
  side: THREE.FrontSide, depthWrite: false,
});

// ── WATER ────────────────────────────────────────────────────────
const waterGeo  = new THREE.BoxGeometry(1, 1, 1, 22, 1, 22);
const posAttr   = waterGeo.attributes.position;

const topVtxIdx  = [];
const topOrigXZ  = [];
for (let i = 0; i < posAttr.count; i++) {
  if (Math.abs(posAttr.getY(i) - 0.5) < 0.001) {
    topVtxIdx.push(i);
    topOrigXZ.push(posAttr.getX(i), posAttr.getZ(i));
  }
}

const waterMat = new THREE.MeshStandardMaterial({
  color: 0x3AACC8, emissive: new THREE.Color(0x003050).multiplyScalar(0.25),
  roughness: 0.06, metalness: 0.15, envMapIntensity: 0.7,
  flatShading: true, side: THREE.FrontSide,
  transparent: true, opacity: 0.82, depthWrite: true,
});
const waterMesh = new THREE.Mesh(waterGeo, waterMat);
waterMesh.renderOrder = 0;

let waterFillH = 1.0;

const WATER_X_MULT    = 0.77;
const WATER_Z_MULT    = 0.88;
const WATER_FLOOR_PCT = 0.18;
const WATER_LEVEL_PCT = 0.50;

let _ampBox = null, _ampSize = null, _ampCX = 0, _ampCZ = 0;

function applyWaterDimensions() {
  if (!_ampBox) return;
  const floorY = _ampBox.min.y + _ampSize.y * WATER_FLOOR_PCT;
  const waterY = _ampBox.min.y + _ampSize.y * WATER_LEVEL_PCT;
  const fillH  = Math.max(0.01, waterY - floorY);
  const yOff   = _ampSize.y * 0.04;
  waterMesh.scale.set(_ampSize.x * WATER_X_MULT, fillH, _ampSize.z * WATER_Z_MULT);
  waterMesh.position.set(_ampCX, floorY + fillH * 0.5 - yOff, _ampCZ);
  waterFillH = fillH;
}

const displayGroup = new THREE.Group();
displayGroup.position.y = 0.28;
scene.add(displayGroup);
displayGroup.add(waterMesh);

// ── OBJ LOADER ───────────────────────────────────────────────────
let ampGroup = null;

new OBJLoader().load(CFG.OBJ_PATH,
  (object) => {
    const box    = new THREE.Box3().setFromObject(object);
    const size   = box.getSize(new THREE.Vector3());
    const scale  = 3.0 / Math.max(size.x, size.y, size.z);
    object.scale.setScalar(scale);
    const centre = box.getCenter(new THREE.Vector3());
    object.position.copy(centre.multiplyScalar(-scale));

    const subGeos = [];
    object.updateWorldMatrix(true, true);
    object.traverse(child => {
      if (!child.isMesh) return;
      const g    = child.geometry.clone().applyMatrix4(child.matrixWorld);
      const lean = new THREE.BufferGeometry();
      lean.setAttribute('position', g.attributes.position);
      if (g.attributes.normal) lean.setAttribute('normal', g.attributes.normal);
      if (g.index) lean.setIndex(g.index);
      subGeos.push(lean);
    });

    let ampMesh;
    if (subGeos.length > 0) {
      const merged = mergeGeometries(subGeos);
      merged.computeVertexNormals();
      ampMesh = new THREE.Mesh(merged, glassMaterial);
    } else {
      ampMesh = object;
      ampMesh.traverse(c => { if (c.isMesh) c.material = glassMaterial; });
    }

    ampGroup = ampMesh;
    ampMesh.renderOrder = 1;
    displayGroup.add(ampMesh);

    _ampBox  = new THREE.Box3().setFromObject(object);
    _ampSize = _ampBox.getSize(new THREE.Vector3());
    _ampCX   = (_ampBox.min.x + _ampBox.max.x) * 0.5;
    _ampCZ   = (_ampBox.min.z + _ampBox.max.z) * 0.5;
    applyWaterDimensions();

    loadStatus.textContent = 'READY';
  },
  (xhr) => {
    if (xhr.total > 0)
      loadStatus.textContent = `LOADING ${Math.round(xhr.loaded / xhr.total * 100)}%`;
  },
  () => {
    loadStatus.textContent = 'MODEL ERROR';
    const fallback = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 1.1, 0.85),
      new THREE.MeshPhysicalMaterial({ color: 0xf5a623, wireframe: true, transparent: true, opacity: 0.4 })
    );
    scene.add(fallback);
    ampGroup = fallback;
  }
);

// ── FLUID DISPLACEMENT ───────────────────────────────────────────
//
// Two-layer audio response:
//   _audioFast  — 25ms attack / 100ms release  → instant ripple response
//   _audioSwell — 150ms attack / 3.0s release  → slow rolling energy
//
// The swell takes 3 seconds to fully decay so the water keeps
// moving beautifully after notes stop — "resonance" feel.
//
// Ripples are outward-propagating radial rings (stone-in-water),
// strongest at center, Gaussian-attenuated toward edges.

let _audioFast  = 0;
let _audioSwell = 0;

function updateFluidDisplacement(timeMs, deltaMs) {
  const t  = timeMs * CFG.FLUID_TIME_SCALE;
  const dt = Math.min(deltaMs * 0.001, 0.05); // seconds, capped

  // ── Attack/release smoothing (frame-rate independent) ────────────
  const raw = Math.min(1.0, STATE.audioLevel);

  const faCoeff = raw > _audioFast
    ? 1 - Math.exp(-dt / 0.025)   // 25 ms attack  — snap to transient
    : 1 - Math.exp(-dt / 0.10);   // 100 ms release — hold briefly
  _audioFast += (raw - _audioFast) * faCoeff;

  const saCoeff = _audioFast > _audioSwell
    ? 1 - Math.exp(-dt / 0.15)    // 150 ms attack  — builds gradually
    : 1 - Math.exp(-dt / 3.0);    // 3.0 s  release — lingers long
  _audioSwell += (_audioFast - _audioSwell) * saCoeff;

  // ── Amplitudes ───────────────────────────────────────────────────
  const wf = Math.max(waterFillH, 0.01);

  // Knob depth + slow swell energy → large rolling waves
  const swellAmp  = (STATE.depth * 0.55 + _audioSwell * 0.45)
                    * CFG.FLUID_MAX_AMP / wf;

  // Fast envelope → outward ring ripples (subtle)
  const rippleAmp = _audioFast * 0.20 * CFG.FLUID_MAX_AMP / wf;

  // Water light pulses gently with the slow swell, not the raw level
  waterLight.intensity = 5.0 + _audioSwell * 5.5;

  // ── Per-vertex displacement ──────────────────────────────────────
  for (let ii = 0; ii < topVtxIdx.length; ii++) {
    const x = topOrigXZ[ii * 2];
    const z = topOrigXZ[ii * 2 + 1];
    const r = Math.sqrt(x * x + z * z);   // radial distance from center

    // ── Idle: always-on micro-motion ─────────────────────────────
    const idle = Math.sin(x * 3.5 + t * 0.55) * Math.cos(z * 3.0 + t * 0.48) * 0.022;

    // ── Primary swells (depth + swell energy) ────────────────────
    const sw1 = Math.sin(x * CFG.FLUID_FREQ_X + t)
              * Math.cos(z * CFG.FLUID_FREQ_Z + t * 0.72 + CFG.FLUID_PHASE);
    const sw2 = Math.sin((x * 0.65 + z * 0.9) * 1.9 + t * 0.85) * 0.65;

    // ── Organic decay envelopes ───────────────────────────────────
    const e1 = Math.pow(Math.max(0, Math.sin(t * 0.62 + 0.00)), 2.2);
    const e2 = Math.pow(Math.max(0, Math.sin(t * 0.79 + 2.09)), 2.2);
    const e3 = Math.pow(Math.max(0, Math.sin(t * 0.51 + 4.19)), 2.2);
    const e4 = Math.pow(Math.max(0, Math.sin(t * 0.94 + 1.05)), 2.2);

    const rb1 = Math.sin(x *  9.0 + z *  7.0 + t * 3.3) * e1 * 0.52;
    const rb2 = Math.cos(x *  7.0 - z * 11.0 + t * 2.9) * e2 * 0.45;
    const rb3 = Math.sin(x * 13.0 + z *  5.5 + t * 3.8) * e3 * 0.40;
    const rb4 = Math.cos(x *  6.0 + z * 14.0 + t * 2.5) * e4 * 0.36;
    const micro = (Math.sin(x * 19.0 + t * 5.2) + Math.cos(z * 16.0 - t * 4.5)) * e2 * 0.10;

    // ── Audio ripple: outward rings from center ───────────────────
    // sin(r * k - t * speed) creates inward-→-outward propagation.
    // exp(-r * falloff) keeps rings visible at center, vanishing at edges.
    const ring = Math.sin(r * 6.5 - t * 7.0) * Math.exp(-r * 0.9);
    // Cross-hatch surface texture for detail
    const tex  = (Math.sin(x * 8.0 + t * 4.5) + Math.cos(z * 7.5 - t * 4.0)) * 0.5;
    const ripple = rippleAmp > 0.001
      ? rippleAmp * (ring * 0.65 + tex * 0.35)
      : 0;

    posAttr.setY(topVtxIdx[ii],
      0.5 + idle
           + swellAmp * (sw1 + sw2 + rb1 + rb2 + rb3 + rb4 + micro)
           + ripple);
  }

  posAttr.needsUpdate = true;
}

// ── KNOB INTERACTION ─────────────────────────────────────────────
let _drag = null;

function applyKnob(svg, valEl, param, v) {
  const c = Math.max(0, Math.min(1, v));
  STATE[param] = c;
  const deg = -135 + c * 270;
  svg.querySelector('.k-notch').setAttribute('transform', `rotate(${deg.toFixed(1)} 30 30)`);
  if (valEl) valEl.textContent = formatKnobValue(param, c);
  updateGainBars();
  emitToJuce('paramChanged', { key: param, value: c });
}

document.querySelectorAll('.knob-svg').forEach(svg => {
  const param = svg.dataset.param;
  const valEl = valEls[param] ?? null;
  let   val   = parseFloat(svg.dataset.default ?? '0');

  applyKnob(svg, valEl, param, val);

  listen(svg, 'pointerdown', e => {
    _drag = { svg, valEl, param, value: STATE[param], startY: e.clientY };
    svg.classList.add('active');
    e.preventDefault();
  });
  listen(svg, 'dblclick', () => {
    val = parseFloat(svg.dataset.default ?? '0');
    applyKnob(svg, valEl, param, val);
  });
  listen(svg, 'wheel', e => {
    e.preventDefault();
    val = Math.max(0, Math.min(1, STATE[param] - e.deltaY / 1800));
    applyKnob(svg, valEl, param, val);
  }, { passive: false });
});

listen(window, 'pointermove', e => {
  if (!_drag) return;
  const { svg, valEl, param, startY } = _drag;
  _drag.value = Math.max(0, Math.min(1, _drag.value + (startY - e.clientY) / 180));
  _drag.startY = e.clientY;
  applyKnob(svg, valEl, param, _drag.value);
});
listen(window, 'pointerup', () => {
  if (_drag) { _drag.svg.classList.remove('active'); _drag = null; }
});

// ── PUBLIC JUCE API ──────────────────────────────────────────────
function _juceSetParam(key, raw) {
  if (!(key in STATE)) return;
  const v   = Math.max(0, Math.min(1, parseFloat(raw)));
  STATE[key] = v;
  const svg   = document.querySelector(`.knob-svg[data-param="${key}"]`);
  const valEl = valEls[key] ?? null;
  if (svg) applyKnob(svg, valEl, key, v);
}

window.PINAM = {
  setParam: _juceSetParam,
  setAll(params) { Object.entries(params).forEach(([k, v]) => _juceSetParam(k, v)); },
  getParam: (key) => STATE[key] ?? 0,
  snapshot: () => ({ ...STATE }),
};

// ── IO: TOGGLE HELPER ────────────────────────────────────────────
function setToggleState(btn, enabled) {
  btn.dataset.on = enabled ? 'true' : 'false';
  btn.classList.toggle('off', !enabled);
}

// ── IO: JUCE EVENT LISTENERS ──────────────────────────────────────
addJuceListener('setParam', (data) => {
  if (data?.key) _juceSetParam(data.key, data.value);
});

addJuceListener('audioLevel', (data) => {
  STATE.audioLevel = (data?.value ?? 0);
});

addJuceListener('initData', (data) => {
  if (!data) return;

  // Populate cab IR select
  if (Array.isArray(data.cabs)) {
    cabSelect.innerHTML = '';
    data.cabs.forEach((name, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = name;
      cabSelect.appendChild(opt);
    });
    cabSelect.selectedIndex = data.currentCab ?? 0;
  }

  // Populate reverb IR select
  if (Array.isArray(data.reverbs)) {
    revSelect.innerHTML = '';
    data.reverbs.forEach((name, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = name;
      revSelect.appendChild(opt);
    });
    revSelect.selectedIndex = data.currentReverb ?? 0;
  }

  if (data.cabEnabled    !== undefined) setToggleState(cabToggle, data.cabEnabled);
  if (data.reverbEnabled !== undefined) setToggleState(revToggle, data.reverbEnabled);
});

// ── IO: UI → JUCE ────────────────────────────────────────────────
listen(cabSelect, 'change', (e) => {
  emitToJuce('selectCab', { index: parseInt(e.target.value, 10) });
});
listen(revSelect, 'change', (e) => {
  emitToJuce('selectReverb', { index: parseInt(e.target.value, 10) });
});
listen(cabToggle, 'click', () => {
  const enabled = cabToggle.dataset.on !== 'true';
  setToggleState(cabToggle, enabled);
  emitToJuce('cabBypass', { enabled });
});
listen(revToggle, 'click', () => {
  const enabled = revToggle.dataset.on !== 'true';
  setToggleState(revToggle, enabled);
  emitToJuce('reverbBypass', { enabled });
});

// ── RESPONSIVE RESIZE ────────────────────────────────────────────
const resizeObserver = new ResizeObserver((entries) => {
  for (const e of entries) {
    const w = Math.floor(e.contentRect.width);
    const h = Math.floor(e.contentRect.height);
    if (w > 0 && h > 0) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }
});
resizeObserver.observe(canvas);
CLEANUP.push(() => resizeObserver.disconnect());

// ── RENDER LOOP ───────────────────────────────────────────────────
let rafId = 0;
let disposed = false;

function animate(nowMs) {
  if (disposed) return;
  rafId = requestAnimationFrame(animate);
  const delta = nowMs - (STATE.lastTime || nowMs);
  STATE.lastTime = nowMs;
  STATE.frameCount++;

  updateFluidDisplacement(nowMs, delta);
  if (ampGroup && !isOrbitActive) displayGroup.rotation.y += CFG.AUTO_ROTATE_SPEED;

  controls.update();
  renderer.render(scene, camera);
}
rafId = requestAnimationFrame(animate);

function disposeMaterial(material) {
  if (!material) return;
  const materials = Array.isArray(material) ? material : [material];
  for (const mat of materials) {
    for (const value of Object.values(mat)) {
      if (value && typeof value.dispose === 'function')
        value.dispose();
    }
    mat.dispose();
  }
}

function disposeSceneResources(root) {
  root.traverse((object) => {
    if (object.geometry)
      object.geometry.dispose();
    if (object.material)
      disposeMaterial(object.material);
  });
}

function shutdown() {
  if (disposed) return;
  disposed = true;
  JUCE_BRIDGE.disposed = true;
  JUCE_BRIDGE.queue.length = 0;
  JUCE_BRIDGE.listeners.length = 0;

  if (JUCE_BRIDGE.retryTimer)
    window.clearTimeout(JUCE_BRIDGE.retryTimer);
  if (rafId)
    cancelAnimationFrame(rafId);

  while (CLEANUP.length > 0) {
    const cleanup = CLEANUP.pop();
    try { cleanup(); } catch {}
  }

  if (scene.environment?.dispose)
    scene.environment.dispose();
  disposeSceneResources(scene);
  renderer.dispose();
  renderer.forceContextLoss?.();
}

listen(window, 'pagehide', shutdown);
listen(window, 'beforeunload', shutdown);

// ── SIGNAL JUCE: PAGE READY ───────────────────────────────────────
// Emitted after all listeners are wired so C++ can safely send initData + params
flushJuceBridge();
