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
  FLUID_SEGMENTS: 14,         // 14×14 quads → indie low-poly look
  FLUID_WORLD_SIZE: 2.2,

  // Fluid displacement
  FLUID_MAX_AMP: 0.50,       // more drama at full thump
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
  // JUCE HOOK — AudioProcessorValueTreeState parameter mirrors
  gain: 0.50,
  thump: 0.00,
  sag: 0.25,

  // Internal frame counters (not exposed to JUCE)
  frameCount: 0,
  lastTime: 0,
  fps: 0,
  fluidCpuMs: 0,   // CPU time spent on fluid vertex update
};

// ────────────────────────────────────────────────────────────────
// DOM REFS
// ────────────────────────────────────────────────────────────────
const canvas = document.getElementById('webgl-canvas');
const container = document.getElementById('canvas-container');

const sliders = {
  gain: document.getElementById('slider-gain'),
  thump: document.getElementById('slider-thump'),
  sag: document.getElementById('slider-sag'),
};
const valEls = {
  gain: document.getElementById('val-gain'),
  thump: document.getElementById('val-thump'),
  sag: document.getElementById('val-sag'),
};
const tele = {
  status: document.getElementById('tele-status'),
  inference: document.getElementById('tele-inference'),
  buffer: document.getElementById('tele-buffer'),
  sr: document.getElementById('tele-sr'),
  latency: document.getElementById('tele-latency'),
  clip: document.getElementById('tele-clip'),
  fps: document.getElementById('tele-fps'),
  fluidCpu: document.getElementById('tele-fluid-cpu'),
};
const loadStatus = document.getElementById('load-status');

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
scene.background = new THREE.Color(0x06101a); // deep navy — moody

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
  color: 0xe8f4ff,
  transmission: 0.88,
  opacity: 1.0,
  roughness: 0.08,
  metalness: 0.0,
  ior: 1.18,
  thickness: 0.4,
  clearcoat: 1.0,
  clearcoatRoughness: 0.05,
  transparent: true,
  envMapIntensity: 0.45,
  attenuationColor: new THREE.Color(0xc8e8ff),
  attenuationDistance: 4.0,
  side: THREE.FrontSide,
  depthWrite: false,
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

// MeshStandardMaterial + envMapIntensity: each facet reflects the
// RoomEnvironment cube map at its own angle — zero extra assets needed,
// but the surface reads as genuinely textured rather than flat-painted.
const waterMat = new THREE.MeshStandardMaterial({
  color:           0x0e9ed4,
  emissive:        new THREE.Color(0x003344).multiplyScalar(0.5),
  roughness:       0.18,
  metalness:       0.28,
  envMapIntensity: 0.85,
  flatShading:     true,
  side:            THREE.DoubleSide,
  transparent:     false,
});
const waterMesh = new THREE.Mesh(waterGeo, waterMat);
waterMesh.userData.wasDisplaced = false;

// fillH set in onLoad — converts world amplitude → local amplitude
let waterFillH = 1.0;

const displayGroup = new THREE.Group();
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

    // Re-measure in world space after all transforms
    const scaledBox = new THREE.Box3().setFromObject(object);
    const scaledSize = scaledBox.getSize(new THREE.Vector3());

    const cx = (scaledBox.min.x + scaledBox.max.x) * 0.5;
    const cz = (scaledBox.min.z + scaledBox.max.z) * 0.5;
    const fpX = scaledSize.x * 0.82;
    const fpZ = scaledSize.z * 0.82;

    // Water sits from 8% (avoids base geometry) to 58% of amp height
    const floorY = scaledBox.min.y + scaledSize.y * 0.08;
    const waterY = scaledBox.min.y + scaledSize.y * 0.58;
    const fillH = waterY - floorY;

    // Scale box so top face = water surface, bottom face = water floor
    waterMesh.scale.set(fpX, fillH, fpZ);
    waterMesh.position.set(cx, floorY + fillH * 0.5, cz);
    waterFillH = fillH;

    loadStatus.textContent = 'MODEL LOADED';
    tele.status.textContent = 'ACTIVE';
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
    tele.status.textContent = 'ERR';
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
  // Convert world amplitude to local Y (box is scaled by waterFillH in Y)
  const localAmp = (STATE.thump * CFG.FLUID_MAX_AMP) / Math.max(waterFillH, 0.01);

  if (localAmp < 0.0002) {
    if (waterMesh.userData.wasDisplaced) {
      for (let ii = 0; ii < topVtxIdx.length; ii++) posAttr.setY(topVtxIdx[ii], 0.5);
      posAttr.needsUpdate = true;
      waterMesh.userData.wasDisplaced = false;
    }
    return;
  }

  const t = timeMs * CFG.FLUID_TIME_SCALE;
  for (let ii = 0; ii < topVtxIdx.length; ii++) {
    const x = topOrigXZ[ii * 2];
    const z = topOrigXZ[ii * 2 + 1];
    const wave1 = Math.sin(x * CFG.FLUID_FREQ_X + t);
    const wave2 = Math.cos(z * CFG.FLUID_FREQ_Z + t * 0.72 + CFG.FLUID_PHASE);
    // Diagonal cross-wave at ~30% amplitude — creates interference texture
    const wave3 = Math.sin((x - z) * 3.8 + t * 1.15) * 0.28;
    posAttr.setY(topVtxIdx[ii], 0.5 + localAmp * (wave1 * wave2 + wave3));
  }

  posAttr.needsUpdate = true;
  // flatShading: GPU recomputes face normals from dFdx/dFdy — no CPU call needed
  waterMesh.userData.wasDisplaced = true;
}

// ────────────────────────────────────────────────────────────────
// SLIDER → STATE BINDING
// Normalises slider integer [0,100] to float [0.0, 1.0].
// JUCE HOOK: delete these listeners; write to STATE.* directly
//   from your WebView message handler instead.
// ────────────────────────────────────────────────────────────────
function bindSlider(key, stateKey) {
  sliders[key].addEventListener('input', () => {
    const raw = parseInt(sliders[key].value, 10);
    STATE[stateKey] = raw / 100;
    valEls[key].textContent = raw.toString().padStart(3, '0');
  });
}
bindSlider('gain', 'gain');
bindSlider('thump', 'thump');
bindSlider('sag', 'sag');

// ────────────────────────────────────────────────────────────────
// TELEMETRY UPDATER
// Throttled to CFG.TELE_INTERVAL ms — DOM writes are expensive.
// JUCE HOOK: replace the mocked latency/rms lines with values
//   pushed via WebSocket or postMessage from the JUCE audio thread.
// ────────────────────────────────────────────────────────────────
let _teleLastUpdate = 0;

function updateTelemetry(nowMs) {
  if (nowMs - _teleLastUpdate < CFG.TELE_INTERVAL) return;
  _teleLastUpdate = nowMs;

  tele.inference.textContent = STATE.fluidCpuMs.toFixed(2) + 'MS';
  tele.fps.textContent = STATE.fps.toFixed(0);
  tele.fluidCpu.textContent = STATE.fluidCpuMs.toFixed(3) + 'MS';

  // JUCE HOOK: /pinam/latency_ms float
  tele.latency.textContent = (2.9 + (Math.random() * 0.3 - 0.15)).toFixed(1) + 'MS';

  // JUCE HOOK: /pinam/clip_flag bool
  const isClipping = STATE.gain > 0.93;
  tele.clip.textContent = isClipping ? 'CLIP!' : '--';
  tele.clip.style.color = isClipping ? 'var(--red-clip)' : '';
}

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
  updateTelemetry(nowMs);
}

requestAnimationFrame(animate);
