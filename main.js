// ================================================================
// PINAM — MAIN.JS
// Three.js WebGL scene for the PiNAM Amplifier Configurator.
//
// JUCE integration guide
// ──────────────────────
// All "JUCE HOOK" comments mark values/functions to replace with
// JUCE AudioProcessorValueTreeState parameter callbacks once the
// WebView bridge (WebBrowserComponent + native <-> JS postMessage)
// is wired up.
//
// Suggested OSC namespace: /pinam/<param>  type: float  range: [0,1]
//   /pinam/gain         → STATE.gain
//   /pinam/vca_thump    → STATE.thump
//   /pinam/sag          → STATE.sag
//   /pinam/inference_ms → tele.inference (read-only, from DSP thread)
//   /pinam/clip_flag    → tele.clip      (read-only, from DSP thread)
// ================================================================

import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ────────────────────────────────────────────────────────────────
// CONFIG — static tuning constants.
// Move to a config.json and fetch() if you want hot-reload tweaks.
// ────────────────────────────────────────────────────────────────
const CFG = Object.freeze({
  // Asset
  OBJ_PATH: './amp2.obj',

  // Camera — elevated angle so the horizontal fluid plane is clearly visible
  CAM_FOV: 50,
  CAM_NEAR: 0.1,
  CAM_FAR: 100,
  CAM_POS: [0, 4.5, 5.5],
  CAM_TARGET: [0, 0.5, 0],

  // Auto-rotate disabled — OrbitControls gives full manual control.
  // Set > 0 to re-enable, but note it compounds with damping settle.
  AUTO_ROTATE_SPEED: 0,

  // Fluid geometry — low segment count = chunky low-poly facets
  FLUID_SEGMENTS: 72,         // higher res — fine ripple detail needs density
  FLUID_WORLD_SIZE: 2.2,

  // Fluid displacement
  FLUID_MAX_AMP: 0.48,        // big waves dominate
  FLUID_FREQ_X: 2.5,
  FLUID_FREQ_Z: 2.0,
  FLUID_TIME_SCALE: 0.0020,
  FLUID_PHASE: 1.4,

  // Telemetry DOM refresh interval in ms
  TELE_INTERVAL: 180,
});

// ────────────────────────────────────────────────────────────────
// STATE — mutable render-state.
// JUCE writes parameter values directly into this object;
// the render loop reads them every frame without a copy.
// ────────────────────────────────────────────────────────────────
const STATE = {
  // ── JUCE HOOK — APVTS parameter mirrors (/pinam/<key> float [0,1])
  inputGain:  0.50,
  volume:     0.60,
  treble:     0.50,
  bass:       0.50,
  reverb:     0.30,
  rate:       0.20,
  depth:      0.00,  // drives water displacement amplitude
  outputGain: 0.70,

  frameCount: 0,
  lastTime:   0,
  fps:        0,
  fluidCpuMs: 0,
};

// ────────────────────────────────────────────────────────────────
// DOM REFS
// ────────────────────────────────────────────────────────────────
const canvas     = document.getElementById('webgl-canvas');
const loadStatus = document.getElementById('load-status');

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

// ────────────────────────────────────────────────────────────────
// RENDERER
// ────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Required for fluidMat.clippingPlanes to work
renderer.localClippingEnabled = true;

// ────────────────────────────────────────────────────────────────
// SCENE + CAMERA
// ────────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x3A5268); // mid-dark slate — contrast without harshness

const camera = new THREE.PerspectiveCamera(CFG.CAM_FOV, 1, CFG.CAM_NEAR, CFG.CAM_FAR);
camera.position.set(...CFG.CAM_POS);
camera.lookAt(...CFG.CAM_TARGET);

// ────────────────────────────────────────────────────────────────
// ORBIT CONTROLS
// ────────────────────────────────────────────────────────────────
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.minDistance = 2.5;
controls.maxDistance = 14;
controls.target.set(...CFG.CAM_TARGET);

// Track user interaction to pause auto-rotation
let isOrbitActive = false;
controls.addEventListener('start', () => { isOrbitActive = true; });
controls.addEventListener('end', () => { isOrbitActive = false; });

// ────────────────────────────────────────────────────────────────
// ENVIRONMENT MAP
// PMREMGenerator wraps the RoomEnvironment scene into a cube map
// used by MeshPhysicalMaterial for reflections and refraction.
// ────────────────────────────────────────────────────────────────
const pmrem = new THREE.PMREMGenerator(renderer);
const roomEnv = new RoomEnvironment();
scene.environment = pmrem.fromScene(roomEnv).texture;
roomEnv.dispose();
pmrem.dispose();

// ────────────────────────────────────────────────────────────────
// LIGHTING
// ────────────────────────────────────────────────────────────────
// Very low dark-blue ambient so the glass isn't flat — drama comes from
// the key and water lights punching through the dark.
const ambientLight = new THREE.AmbientLight(0x0a1828, 0.6);
scene.add(ambientLight);

// Hard warm key from upper-right — strong specular on the glass clearcoat
const keyLight = new THREE.DirectionalLight(0xffecd0, 1.8);
keyLight.position.set(3, 5, 3);
scene.add(keyLight);

// Cold blue rim from back-left — silhouettes the glass edge
const rimLight = new THREE.DirectionalLight(0x1a3fff, 0.6);
rimLight.position.set(-3, 1, -5);
scene.add(rimLight);

// Intense blue uplight — illuminates water from below, bleeds through glass
const waterLight = new THREE.PointLight(0x00aaff, 5.0, 6);
waterLight.position.set(0, -0.6, 0);
scene.add(waterLight);

// Narrow top spot — catches the glass top edge
const topSpot = new THREE.DirectionalLight(0xffffff, 0.4);
topSpot.position.set(0, 10, 1);
scene.add(topSpot);

// ────────────────────────────────────────────────────────────────
// GLASS MATERIAL  (transmission)
// Water mesh is transparent:false → opaque render pass → captured
// in Three.js's transmission background buffer before glass draws.
// This is how transmission correctly shows objects inside the mesh.
// ────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────
// GLASS MATERIAL — transmission with anti-glitch settings
//
// Glitch sources and fixes:
//   roughness > 0  → blurry sample hits off-screen pixels → set 0.0
//   ior > ~1.25    → large refraction offset → set 1.18
//   DoubleSide     → transmission applied twice (outer+inner face)
//                    → double refraction glitch → use FrontSide
// ────────────────────────────────────────────────────────────────
// clearcoat adds the sharp specular "lacquer" layer that defines glass visually.
// roughness on the base layer creates imperfection.  transmission < 1.0 makes
// it feel solid rather than invisible.
const glassMaterial = new THREE.MeshPhysicalMaterial({
  color:               0xe8f4ff,
  transmission:        0.88,
  opacity:             1.0,
  roughness:           0.08,
  metalness:           0.0,
  ior:                 1.18,
  thickness:           0.4,
  clearcoat:           1.0,
  clearcoatRoughness:  0.05,
  transparent:         true,
  envMapIntensity:     0.45,
  attenuationColor:    new THREE.Color(0xc8e8ff),
  attenuationDistance: 4.0,
  side:                THREE.FrontSide,
  depthWrite:          false,
});

// ────────────────────────────────────────────────────────────────
// WATER — two planes, zero seam
//
// A rippling surface + a static dark floor gives genuine depth
// perception without needing any side-wall geometry.  Side walls
// would require updating top-edge verts every frame to stay flush
// with the displaced surface — costly and still visually fragile.
//
// Both planes are transparent:false → opaque pass → captured in
// the transmission background buffer before glass draws.
// ────────────────────────────────────────────────────────────────

// ── Water: single BoxGeometry, top face + top-wall edges displace ─
//
// BoxGeometry(1,1,1, N,1,N) — heightSegments=1 is critical:
//   • top face has N×N quads  → high-res surface for waves
//   • side walls each have N×1 quads → top-edge verts at y=0.5
//
// All vertices with y≈0.5 (top face + top edges of all four walls)
// are displaced together in the render loop.  The walls below y=0.5
// stay flat.  Because the top wall-edge verts move with the surface,
// there is NO visible seam between the water surface and the sides.
//
// transparent:false → opaque pass → captured in transmission buffer.
// ────────────────────────────────────────────────────────────────
const waterGeo = new THREE.BoxGeometry(1, 1, 1, 22, 1, 22);
const posAttr = waterGeo.attributes.position;

// Collect indices of all top vertices (y ≈ +0.5 in unit-box local space)
const topVtxIdx = [];
const topOrigXZ = [];
for (let i = 0; i < posAttr.count; i++) {
  if (Math.abs(posAttr.getY(i) - 0.5) < 0.001) {
    topVtxIdx.push(i);
    topOrigXZ.push(posAttr.getX(i), posAttr.getZ(i));
  }
}

// transparent:true + depthWrite:false = water blends naturally with the frosted
// glass above it.  Both are alpha-sorted transparent objects so the layering works.
const waterMat = new THREE.MeshStandardMaterial({
  color:           0x3AACC8,   // cool slate-blue water — matches scene palette
  emissive:        new THREE.Color(0x003050).multiplyScalar(0.25),
  roughness:       0.06,       // smoother = more glassy sheen per facet
  metalness:       0.15,
  envMapIntensity: 0.7,
  flatShading:     true,
  side:            THREE.DoubleSide,
  transparent:     true,
  opacity:         0.72,
  depthWrite:      false,
});
const waterMesh = new THREE.Mesh(waterGeo, waterMat);
waterMesh.userData.wasDisplaced = false;

// fillH set in onLoad — converts world amplitude → local amplitude
let waterFillH = 1.0;

// Water placement — tuned values baked in from debug session
const WATER_X_MULT  = 0.77;
const WATER_Z_MULT  = 0.88;
const WATER_FLOOR_PCT = 0.18;
const WATER_LEVEL_PCT = 0.50;

let _ampBox  = null;
let _ampSize = null;
let _ampCX   = 0;
let _ampCZ   = 0;

function applyWaterDimensions() {
  if (!_ampBox) return;
  const floorY = _ampBox.min.y + _ampSize.y * WATER_FLOOR_PCT;
  const waterY = _ampBox.min.y + _ampSize.y * WATER_LEVEL_PCT;
  const fillH  = Math.max(0.01, waterY - floorY);
  const yOffset = _ampSize.y * 0.04; // sloped-front-panel compensation
  waterMesh.scale.set(_ampSize.x * WATER_X_MULT, fillH, _ampSize.z * WATER_Z_MULT);
  waterMesh.position.set(_ampCX, floorY + fillH * 0.5 - yOffset, _ampCZ);
  waterFillH = fillH;
}

const displayGroup = new THREE.Group();
displayGroup.position.y = 0.28; // lift amp+water up in the viewport
scene.add(displayGroup);
displayGroup.add(waterMesh);


// ────────────────────────────────────────────────────────────────
// OBJ LOADER
// ────────────────────────────────────────────────────────────────
let ampGroup = null;   // Set once the model loads; used by the render loop

const objLoader = new OBJLoader();
objLoader.load(
  CFG.OBJ_PATH,

  // ── onLoad ────────────────────────────────────────────────
  (object) => {
    // Auto-scale so the model fits within a 3-unit sphere
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = 3.0 / maxDim;
    object.scale.setScalar(scale);

    // Center at world origin
    const centre = box.getCenter(new THREE.Vector3());
    object.position.copy(centre.multiplyScalar(-scale));

    // Merge all OBJ sub-meshes into ONE geometry → ONE glass surface.
    // Multiple sub-meshes each apply transmission independently, stacking
    // refraction artifacts.  A single merged mesh has exactly one pass.
    const subGeos = [];
    object.updateWorldMatrix(true, true);
    object.traverse(child => {
      if (!child.isMesh) return;
      const g = child.geometry.clone().applyMatrix4(child.matrixWorld);
      // Strip to position + normal only (glass material doesn't need UVs)
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
      // Fallback: add original group if merge fails
      ampMesh = object;
      ampMesh.traverse(c => { if (c.isMesh) c.material = glassMaterial; });
    }
    ampGroup = ampMesh;
    displayGroup.add(ampMesh);

    // Store bounds so debug sliders can re-apply transforms at any time
    _ampBox  = new THREE.Box3().setFromObject(object);
    _ampSize = _ampBox.getSize(new THREE.Vector3());
    _ampCX   = (_ampBox.min.x + _ampBox.max.x) * 0.5;
    _ampCZ   = (_ampBox.min.z + _ampBox.max.z) * 0.5;

    applyWaterDimensions(); // uses current slider values as initial placement

    loadStatus.textContent = 'MODEL LOADED';
    loadStatus.textContent = 'READY';
  },

  // ── onProgress ────────────────────────────────────────────
  (xhr) => {
    if (xhr.total > 0) {
      const pct = Math.round((xhr.loaded / xhr.total) * 100);
      loadStatus.textContent = 'LOADING MODEL... ' + pct + '%';
    }
  },

  // ── onError ───────────────────────────────────────────────
  (err) => {
    loadStatus.textContent = 'MODEL ERROR — ENSURE amp.obj IS IN ROOT DIR';
    loadStatus.textContent = 'MODEL ERROR';
    console.error('[PINAM] OBJLoader failed:', err);

    // Fallback wireframe so the interface isn't completely empty
    const fallback = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 1.1, 0.85),
      new THREE.MeshPhysicalMaterial({
        color: 0xf5a623, wireframe: true, transparent: true, opacity: 0.4,
      })
    );
    scene.add(fallback);
    ampGroup = fallback;
  }
);

// ────────────────────────────────────────────────────────────────
// FLUID VERTEX DISPLACEMENT
// Called once per frame.  Pure CPU — no custom shader needed at
// this scale (52×52 = 2704 vertices).  Upgrade to a GPGPU compute
// pass via THREE.WebGLRenderer.compute() when vertex count > 100k.
//
// JUCE HOOK: replace STATE.thump read with normalised APVTS value.
// ────────────────────────────────────────────────────────────────
function updateFluidDisplacement(timeMs) {
  const localAmp = (STATE.depth * CFG.FLUID_MAX_AMP) / Math.max(waterFillH, 0.01);
  const t        = timeMs * CFG.FLUID_TIME_SCALE;

  for (let ii = 0; ii < topVtxIdx.length; ii++) {
    const x = topOrigXZ[ii * 2];
    const z = topOrigXZ[ii * 2 + 1];

    // Idle: always-on gentle movement at rest
    const idle = Math.sin(x * 3.5 + t * 0.55) * Math.cos(z * 3.0 + t * 0.48) * 0.030;

    // ── Primary swell (dominates) ──────────────────────────────
    // Two large crossing swells create the main rolling surface
    const sw1 = Math.sin(x * CFG.FLUID_FREQ_X + t)
              * Math.cos(z * CFG.FLUID_FREQ_Z + t * 0.72 + CFG.FLUID_PHASE);
    const sw2 = Math.sin((x * 0.65 + z * 0.9) * 1.9 + t * 0.85) * 0.70;

    // ── Secondary chop (occasional, lower amplitude) ──────────
    const chop = Math.sin(x * 5.5 + z * 4.0 + t * 1.8) * 0.18
               + Math.cos(x * 4.0 - z * 6.5 + t * 2.1) * 0.14;

    // ── Surface ripple (fine detail on top of swells) ─────────
    const ripple = (Math.sin(x * 12.0 + t * 3.5) + Math.cos(z * 10.0 - t * 3.0)) * 0.07;

    posAttr.setY(topVtxIdx[ii], 0.5 + idle + localAmp * (sw1 + sw2 + chop + ripple));
  }

  posAttr.needsUpdate = true;
}

// ────────────────────────────────────────────────────────────────
// SVG ROTARY KNOB INTERACTION
//
// Each knob is an SVG with class .knob-svg and data-param / data-default.
// Vertical drag maps to value: 200px drag = full range.
// Double-click resets to default.  Scrollwheel fine-tunes.
//
// JUCE HOOK: replace the STATE writes here with APVTS parameter
//   callbacks received via WebView postMessage.
// ────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────
// ROTARY KNOB SYSTEM
//
// Valhalla-style: filled circle + rotating notch indicator.
// Global pointermove/up on window ensures drag never "drops" when
// the cursor leaves the SVG element mid-drag.
//
// JUCE HOOK: replace STATE writes with APVTS postMessage callbacks.
// ────────────────────────────────────────────────────────────────
let _drag = null; // { svg, valEl, param, value, startY }

function applyKnob(svg, valEl, param, v) {
  const c = Math.max(0, Math.min(1, v));
  STATE[param] = c;
  const deg = -135 + c * 270;
  svg.querySelector('.k-notch').setAttribute('transform', `rotate(${deg.toFixed(1)} 30 30)`);
  if (valEl) valEl.textContent = Math.round(c * 100).toString().padStart(3, '0');
}

document.querySelectorAll('.knob-svg').forEach(svg => {
  const param = svg.dataset.param;
  const valEl = valEls[param] || null;
  let   val   = parseFloat(svg.dataset.default ?? '0');

  applyKnob(svg, valEl, param, val);

  svg.addEventListener('pointerdown', e => {
    // Use STATE[param] so drag always starts from the current value,
    // not from the stale closure variable.
    _drag = { svg, valEl, param, value: STATE[param], startY: e.clientY };
    svg.classList.add('active');
    e.preventDefault();
  });

  svg.addEventListener('dblclick', () => {
    val = parseFloat(svg.dataset.default ?? '0');
    applyKnob(svg, valEl, param, val);
  });

  svg.addEventListener('wheel', e => {
    e.preventDefault();
    val = Math.max(0, Math.min(1, val - e.deltaY / 1800));
    applyKnob(svg, valEl, param, val);
  }, { passive: false });
});

window.addEventListener('pointermove', e => {
  if (!_drag) return;
  const { svg, valEl, param, startY } = _drag;
  const delta = (startY - e.clientY) / 180;
  _drag.value = Math.max(0, Math.min(1, _drag.value + delta));
  _drag.startY = e.clientY;
  applyKnob(svg, valEl, param, _drag.value);
});

window.addEventListener('pointerup', () => {
  if (_drag) { _drag.svg.classList.remove('active'); _drag = null; }
});


// ────────────────────────────────────────────────────────────────
// RESPONSIVE RESIZE
// ResizeObserver fires on first layout and on every subsequent
// container resize — more reliable than window 'resize' for canvas
// elements inside flex/grid layouts.
// ────────────────────────────────────────────────────────────────
const resizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const w = Math.floor(entry.contentRect.width);
    const h = Math.floor(entry.contentRect.height);
    if (w > 0 && h > 0) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }
});
resizeObserver.observe(canvas);

// ────────────────────────────────────────────────────────────────
// RENDER LOOP
// ────────────────────────────────────────────────────────────────
let _fpsAccumMs = 0;
let _fpsFrames = 0;

function animate(nowMs) {
  requestAnimationFrame(animate);

  // FPS — averaged over a 500 ms window
  const delta = nowMs - (STATE.lastTime || nowMs);
  STATE.lastTime = nowMs;
  _fpsAccumMs += delta;
  _fpsFrames += 1;
  if (_fpsAccumMs >= 500) {
    STATE.fps = (_fpsFrames / _fpsAccumMs) * 1000;
    _fpsAccumMs = 0;
    _fpsFrames = 0;
  }
  STATE.frameCount++;

  // Fluid vertex displacement (CPU-timed for telemetry)
  const t0 = performance.now();
  updateFluidDisplacement(nowMs);
  STATE.fluidCpuMs = performance.now() - t0;

  // Rotate the whole display group (amp + water together) so they stay aligned.
  // Pauses when the user grabs orbit controls.
  if (ampGroup && !isOrbitActive) {
    displayGroup.rotation.y += CFG.AUTO_ROTATE_SPEED;
  }

  controls.update();
  renderer.render(scene, camera);
}

requestAnimationFrame(animate);
