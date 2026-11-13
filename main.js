import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/*
  AviationSpot360 Ground School: a scroll-driven walk from the campus forecourt,
  through the main entrance, across the reception lobby, to rest facing doors A and B.

  World units are metres. The facade sits on z = 0 and faces +z; the lobby runs
  from z = 0 back to z = -14, x = -8..8, with a 3.6 m ceiling. The camera walks down x = 0.
*/

const { gsap, ScrollTrigger, Lenis } = window;
gsap.registerPlugin(ScrollTrigger);

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (t) => t * t * (3 - 2 * t);
const range = (v, a, b) => smooth(clamp01((v - a) / (b - a)));
const rand = mulberry32(360);

const COLORS = {
  navy: 0x111c44,
  navyDeep: 0x0b163a,
  cyan: 0x00a2e5,
};

/* ---------- Renderer, scene, camera ---------- */
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
let pixelRatio = Math.min(devicePixelRatio, 1.5);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.22;

const HORIZON = new THREE.Color('#7c7590');
scene.fog = new THREE.Fog(HORIZON, 34, 150);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 3200);
// 4x is plenty at these viewing angles; 16x on every big textured floor and wall triples the frame time on integrated GPUs
const MAX_ANISO = Math.min(4, renderer.capabilities.getMaxAnisotropy());

/* ---------- Small helpers ---------- */
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function add(obj, parent = scene, { cast = true, receive = true } = {}) {
  obj.castShadow = cast;
  obj.receiveShadow = receive;
  parent.add(obj);
  return obj;
}
function mesh(geo, mat, x = 0, y = 0, z = 0, parent = scene, opts) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return add(m, parent, opts);
}
/** Box positioned by its centre. */
const box = (w, h, d, mat, x, y, z, parent, opts) => mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z, parent, opts);
/** Rounded box positioned by its centre. */
const rbox = (w, h, d, r, mat, x, y, z, parent, opts) =>
  mesh(new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2, h / 2, d / 2) - 1e-4), mat, x, y, z, parent, opts);
const cyl = (rt, rb, h, mat, x, y, z, parent, seg = 24, opts) =>
  mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat, x, y, z, parent, opts);
/** Flat panel facing +z, rotated to face `facing` ('+x', '-x', '+z', '-z', 'down', 'up'). */
function panel(w, h, mat, x, y, z, facing = '+z', parent = scene, opts = { cast: false, receive: true }) {
  const m = mesh(new THREE.PlaneGeometry(w, h), mat, x, y, z, parent, opts);
  const rot = { '+z': [0, 0], '-z': [0, Math.PI], '+x': [0, Math.PI / 2], '-x': [0, -Math.PI / 2], down: [Math.PI / 2, 0], up: [-Math.PI / 2, 0] }[facing];
  m.rotation.set(rot[0], rot[1], 0);
  return m;
}

function canvasTex(w, h, draw, { repeat = null, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = MAX_ANISO;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}
function repeatOf(tex, rx, ry) {
  const t = tex.clone();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.needsUpdate = true;
  return t;
}
function speckle(g, w, h, n, colors, alpha, size = [1, 3]) {
  for (let i = 0; i < n; i++) {
    g.globalAlpha = alpha * (0.4 + rand() * 0.6);
    g.fillStyle = colors[(rand() * colors.length) | 0];
    const s = size[0] + rand() * (size[1] - size[0]);
    g.fillRect(rand() * w, rand() * h, s, s);
  }
  g.globalAlpha = 1;
}
const DISPLAY = 'Fraunces, Georgia, serif';
const FONT = (weight, px, family = 'Manrope, system-ui, sans-serif') => `${weight} ${px}px ${family}`;

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

/* ---------- Textures (all drawn in code) ---------- */
function makeTextures(logoWhite) {
  const T = {};

  // Large-format porcelain floor: 2 x 2 tiles of 1.2 m per texture repeat
  T.floor = canvasTex(1024, 1024, (g, w, h) => {
    const n = 2, s = w / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const l = 84 + rand() * 3;
      g.fillStyle = `hsl(36 7% ${l}%)`;
      g.fillRect(i * s, j * s, s, s);
    }
    speckle(g, w, h, 9000, ['#ffffff', '#b8b1a6', '#cfc8bc'], 0.18, [1, 2.5]);
    // soft veining
    g.strokeStyle = 'rgba(150,140,128,0.10)'; g.lineWidth = 1.5;
    for (let k = 0; k < 14; k++) {
      g.beginPath(); let x = rand() * w, y = rand() * h; g.moveTo(x, y);
      for (let q = 0; q < 8; q++) { x += (rand() - 0.3) * 90; y += (rand() - 0.5) * 60; g.lineTo(x, y); }
      g.stroke();
    }
    g.fillStyle = '#a49c90';
    for (let i = 0; i <= n; i++) { g.fillRect(i * s - 2, 0, 4, h); g.fillRect(0, i * s - 2, w, 4); }
  });

  // Oak veneer
  T.wood = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#9a7352'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 160; i++) {
      const y = rand() * h, a = 0.05 + rand() * 0.12;
      g.strokeStyle = rand() > 0.5 ? `rgba(70,45,25,${a})` : `rgba(210,170,130,${a})`;
      g.lineWidth = 0.6 + rand() * 2.2;
      g.beginPath(); g.moveTo(0, y);
      for (let x = 0; x <= w; x += 32) g.lineTo(x, y + Math.sin(x * 0.012 + i) * 4 + (rand() - 0.5) * 2);
      g.stroke();
    }
  }, { repeat: [1, 1] });

  // Exterior paving: 0.6 x 0.3 m stretcher bond, texture = 2.4 m square
  T.paving = canvasTex(1024, 1024, (g, w, h) => {
    g.fillStyle = '#6f6c68'; g.fillRect(0, 0, w, h);
    const bw = w / 4, bh = h / 8;
    for (let r = 0; r < 8; r++) for (let c = -1; c < 5; c++) {
      const x = c * bw + (r % 2 ? bw / 2 : 0);
      const l = 50 + rand() * 8;
      g.fillStyle = `hsl(30 4% ${l}%)`;
      g.fillRect(x + 3, r * bh + 3, bw - 6, bh - 6);
    }
    speckle(g, w, h, 12000, ['#2d2b29', '#a5a19b'], 0.2, [1, 2]);
  });

  // Lawn
  T.grass = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#2c3a28'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 26000, ['#3a4d32', '#22301f', '#46593a', '#1c2619'], 0.6, [1, 3]);
  });

  // Asphalt for the street beyond the forecourt
  T.asphalt = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#2a2b2e'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 20000, ['#3c3d41', '#1c1d20', '#4a4b4f'], 0.5, [1, 2]);
  });

  // Facade cladding: navy aluminium panels with fine joints (texture = 3 x 1.5 m)
  T.cladding = canvasTex(512, 256, (g, w, h) => {
    g.fillStyle = '#121d45'; g.fillRect(0, 0, w, h);
    const grd = g.createLinearGradient(0, 0, w, h);
    grd.addColorStop(0, 'rgba(255,255,255,0.025)'); grd.addColorStop(1, 'rgba(0,0,0,0.05)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    g.fillStyle = '#080f2a';
    g.fillRect(0, 0, w, 2); g.fillRect(0, 0, 2, h);
  });

  // What you see through the upper-floor windows: a lit study hall behind blinds
  T.upperWindows = canvasTex(1024, 256, (g, w, h) => {
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#2b3350'); bg.addColorStop(0.5, '#3b3f52'); bg.addColorStop(1, '#1a2036');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    // ceiling light strips
    for (let i = 0; i < 9; i++) {
      const x = 40 + i * 112;
      const gl = g.createRadialGradient(x + 30, 26, 2, x + 30, 26, 70);
      gl.addColorStop(0, 'rgba(255,240,215,0.75)'); gl.addColorStop(1, 'rgba(255,240,215,0)');
      g.fillStyle = gl; g.fillRect(x - 50, 0, 160, 120);
      g.fillStyle = 'rgba(255,248,235,0.95)'; g.fillRect(x, 20, 60, 5);
    }
    // desks / heads silhouettes low down
    g.fillStyle = 'rgba(14,18,34,0.7)';
    for (let i = 0; i < 26; i++) g.fillRect(rand() * w, 170 + rand() * 30, 30 + rand() * 50, 60);
    // half-drawn blinds on some bays
    for (let b = 0; b < 8; b++) {
      if (rand() > 0.55) continue;
      const x = b * 128, depth = 50 + rand() * 110;
      g.fillStyle = 'rgba(200,196,186,0.82)'; g.fillRect(x, 0, 128, depth);
      g.fillStyle = 'rgba(0,0,0,0.12)';
      for (let y = 0; y < depth; y += 6) g.fillRect(x, y, 128, 1);
    }
  });

  // Side-block ground-floor windows: offices, dimmer
  T.sideWindows = canvasTex(512, 256, (g, w, h) => {
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#2a3048'); bg.addColorStop(1, '#151a2c');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 3; i++) {
      const x = 80 + i * 170;
      const gl = g.createRadialGradient(x, 20, 2, x, 20, 90);
      gl.addColorStop(0, 'rgba(255,236,205,0.55)'); gl.addColorStop(1, 'rgba(255,236,205,0)');
      g.fillStyle = gl; g.fillRect(x - 100, 0, 200, 160);
    }
    g.fillStyle = 'rgba(205,200,190,0.75)'; g.fillRect(0, 0, w, 70);
    g.fillStyle = 'rgba(0,0,0,0.12)';
    for (let y = 0; y < 70; y += 5) g.fillRect(0, y, w, 1);
  });

  // Logo on a transparent canvas, for the facade and the reception wall
  T.logo = canvasTex(2048, 620, (g, w, h) => {
    g.drawImage(logoWhite, 0, 0, w, h);
  });

  // Door leaves: big letter, a short cyan rule, the room name in spaced capitals
  T.door = (letter, name) => canvasTex(512, 1100, (g, w, h) => {
    g.fillStyle = '#18234f'; g.fillRect(0, 0, w, h);
    g.globalAlpha = 0.02;
    for (let i = 0; i < 300; i++) {
      g.fillStyle = rand() > 0.5 ? '#ffffff' : '#000000';
      g.fillRect(rand() * w, 0, 1 + rand() * 2, h);
    }
    g.globalAlpha = 1;
    g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 3;
    g.strokeRect(36, 36, w - 72, h - 72);
    g.fillStyle = '#f2f4f8';
    g.font = FONT(500, 250, DISPLAY);
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillText(letter, w / 2, 470);
    g.fillStyle = '#00a2e5'; g.fillRect(w / 2 - 34, 516, 68, 4);
    g.fillStyle = 'rgba(242,244,248,0.85)';
    g.font = FONT(700, 27);
    g.letterSpacing = '5px';
    const words = name.toUpperCase().split(' ');
    const lines = words.length > 1 ? [words.slice(0, -1).join(' '), words.at(-1)] : words;
    lines.forEach((l, i) => g.fillText(l, w / 2 + 2.5, 580 + i * 42));
  });

  // Room sign above each frame: letter tile + room name
  T.plaque = (letter, name) => canvasTex(1024, 220, (g, w, h) => {
    g.fillStyle = '#f4f3ef'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#111c44'; g.fillRect(0, 0, h, h);
    g.fillStyle = '#f4f3ef';
    g.font = FONT(500, 140, DISPLAY); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(letter, h / 2, h / 2 + 6);
    g.fillStyle = '#111c44'; g.textAlign = 'left';
    g.font = FONT(700, name.length > 12 ? 78 : 92);
    g.fillText(name, h + 40, h / 2 + 4, w - h - 60);
    g.fillStyle = '#00a2e5'; g.fillRect(h, h - 8, w - h, 8);
  });

  // Hanging wayfinding sign over the walkway, airport style
  T.wayfinding = canvasTex(3072, 340, (g, w, h) => {
    g.fillStyle = '#0e1840'; g.fillRect(0, 0, w, h);
    const arrow = (x, dir) => { // dir -1 = ahead-left, 0 = straight ahead, 1 = ahead-right
      g.save(); g.translate(x, h / 2); g.rotate((dir * Math.PI) / 4);
      g.strokeStyle = '#f2f4f8'; g.lineWidth = 15; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath(); g.moveTo(0, 66); g.lineTo(0, -66); g.moveTo(-46, -20); g.lineTo(0, -66); g.lineTo(46, -20); g.stroke();
      g.restore();
    };
    const tile = (x, letter) => {
      g.fillStyle = '#f2f4f8'; g.fillRect(x, 70, 200, 200);
      g.fillStyle = '#0e1840'; g.font = FONT(500, 160, DISPLAY); g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(letter, x + 100, 176);
    };
    const label = (t, x, align) => { g.fillStyle = '#f2f4f8'; g.textAlign = align; g.textBaseline = 'middle'; g.font = FONT(600, 80); g.fillText(t, x, h / 2 + 4, 560); };
    arrow(100, -1); tile(180, 'A'); label('Cadet Prep', 420, 'left');
    tile(1024 + 160, 'C'); label('Airside', 1024 + 400, 'left'); arrow(1024 + 880, 0);
    arrow(w - 100, 1); tile(w - 380, 'B'); label('1-on-1 Mentorship', w - 420, 'right');
    g.fillStyle = 'rgba(242,244,248,0.25)';
    for (const x of [1024, 2048]) g.fillRect(x - 2, 60, 4, h - 120);
    g.fillStyle = '#00a2e5'; g.fillRect(0, h - 10, w, 10);
  });

  // Entrance monument: logo over a short line of text
  T.monument = canvasTex(2048, 820, (g, w, h) => {
    g.fillStyle = '#111c44'; g.fillRect(0, 0, w, h);
    g.drawImage(logoWhite, 224, 90, 1600, 1600 * (473 / 1564));
    g.fillStyle = '#00a2e5'; g.fillRect(w / 2 - 60, 640, 120, 6);
    g.fillStyle = 'rgba(242,244,248,0.85)'; g.font = FONT(500, 64); g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.letterSpacing = '18px';
    g.fillText('GROUND SCHOOL', w / 2 + 9, 740);
  });

  // Notice board: cork with pinned sheets (DGCA ground-school subjects)
  T.notice = canvasTex(1400, 760, (g, w, h) => {
    g.fillStyle = '#a98258'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 40000, ['#7d5c3a', '#c9a173', '#8f6b45', '#d8b384'], 0.55, [1, 3]);
    const sheets = [
      { x: 70, y: 70, w: 340, h: 430, c: '#f6f4ee', title: 'Batch Schedule', lines: ['Mon  Air Navigation', 'Tue  Meteorology', 'Wed  Air Regulations', 'Thu  Technical General', 'Fri  RTR (A) prep', 'Sat  Full mock test'] },
      { x: 450, y: 110, w: 300, h: 250, c: '#eef3f8', title: 'Mock Test', lines: ['Saturday · 10:00', 'Hall A · 2 hours', 'Bring your ID'] },
      { x: 790, y: 60, w: 260, h: 340, c: '#f7f0dc', title: 'Cadet Prep', lines: ['Aptitude drills', 'Interview practice', 'Group discussion'] },
      { x: 1090, y: 90, w: 250, h: 300, c: '#f6f4ee', title: 'Notices', lines: ['Library open 8-8', 'Doubt clinic Wed', 'Mentor hours Fri'] },
      { x: 470, y: 410, w: 380, h: 280, c: '#f6f4ee', title: 'Exam Dates', lines: ['Check the DGCA portal', 'for the next session', 'and book your slot'] },
      { x: 900, y: 440, w: 420, h: 250, c: '#e9eef6', title: 'Welcome, new batch', lines: ['Orientation in the lounge', 'Collect your study kit', 'at the front desk'] },
    ];
    for (const s of sheets) {
      g.save();
      g.translate(s.x + s.w / 2, s.y + s.h / 2);
      g.rotate((rand() - 0.5) * 0.05);
      g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(-s.w / 2 + 6, -s.h / 2 + 8, s.w, s.h);
      g.fillStyle = s.c; g.fillRect(-s.w / 2, -s.h / 2, s.w, s.h);
      g.fillStyle = '#111c44'; g.font = FONT(600, 30); g.textAlign = 'left'; g.textBaseline = 'top';
      g.fillText(s.title, -s.w / 2 + 24, -s.h / 2 + 26);
      g.fillStyle = '#00a2e5'; g.fillRect(-s.w / 2 + 24, -s.h / 2 + 68, 40, 3);
      g.fillStyle = '#3a4160'; g.font = FONT(500, 22);
      s.lines.forEach((l, i) => g.fillText(l, -s.w / 2 + 24, -s.h / 2 + 92 + i * 40));
      // pin
      g.fillStyle = ['#c0392b', '#00a2e5', '#2c3e50', '#d4a017'][(rand() * 4) | 0];
      g.beginPath(); g.arc(0, -s.h / 2 + 12, 9, 0, Math.PI * 2); g.fill();
      g.restore();
    }
  });

  // Framed poster above the lounge sofa: a runway at dusk and the platform's promise
  T.poster = canvasTex(1200, 700, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#0b163a'); sky.addColorStop(0.55, '#1d2b5c'); sky.addColorStop(0.62, '#4a4f72'); sky.addColorStop(1, '#141b33');
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    const hz = h * 0.6;
    // runway in perspective
    g.fillStyle = '#20263a';
    g.beginPath(); g.moveTo(w * 0.5 - 18, hz); g.lineTo(w * 0.5 + 18, hz); g.lineTo(w * 0.86, h); g.lineTo(w * 0.14, h); g.closePath(); g.fill();
    g.fillStyle = 'rgba(240,240,240,0.85)';
    for (let i = 0; i < 9; i++) {
      const t0 = Math.pow(i / 9, 1.8), t1 = Math.pow((i + 0.45) / 9, 1.8);
      const y0 = hz + (h - hz) * t0, y1 = hz + (h - hz) * t1;
      const w0 = 1 + 7 * t0, w1 = 1 + 7 * t1;
      g.beginPath(); g.moveTo(w / 2 - w0, y0); g.lineTo(w / 2 + w0, y0); g.lineTo(w / 2 + w1, y1); g.lineTo(w / 2 - w1, y1); g.fill();
    }
    // edge lights
    for (let i = 0; i < 14; i++) {
      const t = Math.pow(i / 14, 1.6), y = hz + (h - hz) * t;
      const dx = 18 + (w * 0.36 - 18) * t;
      g.fillStyle = 'rgba(255,214,150,0.95)';
      g.beginPath(); g.arc(w / 2 - dx - 6, y, 1.5 + t * 4, 0, 7); g.arc(w / 2 + dx + 6, y, 1.5 + t * 4, 0, 7); g.fill();
    }
    g.fillStyle = '#00a2e5'; g.fillRect(70, 90, 46, 4);
    g.fillStyle = '#f2f4f8'; g.font = FONT(500, 54); g.textBaseline = 'top';
    ['Exam practice.', 'Cadet prep.', 'Flight-training discovery.'].forEach((l, i) => g.fillText(l, 70, 120 + i * 66));
  });

  // Rug in the lounge
  T.rug = canvasTex(1024, 820, (g, w, h) => {
    g.fillStyle = '#2a3354'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 30000, ['#323c62', '#222a47', '#3a4468'], 0.5, [1, 3]);
    g.strokeStyle = 'rgba(160,170,200,0.35)'; g.lineWidth = 6;
    g.strokeRect(46, 46, w - 92, h - 92);
  });

  // Clock face
  T.clock = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#f6f5f1'; g.beginPath(); g.arc(w / 2, h / 2, w / 2, 0, 7); g.fill();
    g.fillStyle = '#111c44';
    for (let i = 0; i < 60; i++) {
      g.save(); g.translate(w / 2, h / 2); g.rotate((i / 60) * Math.PI * 2);
      if (i % 5 === 0) g.fillRect(-5, -w / 2 + 26, 10, 46); else g.fillRect(-1.5, -w / 2 + 26, 3, 16);
      g.restore();
    }
  });

  return T;
}

/* ---------- Materials ---------- */
function makeMaterials(T) {
  const M = {};
  const std = (o) => new THREE.MeshStandardMaterial(o);
  M.cladding = std({ map: repeatOf(T.cladding, 1, 1), color: 0xffffff, roughness: 0.85, metalness: 0.1 });
  M.claddingPlain = std({ color: 0x111c44, roughness: 0.85, metalness: 0.1 });
  M.claddingDeep = std({ color: 0x0b163a, roughness: 0.85, metalness: 0.1 });
  M.mullion = std({ color: 0x2b2f38, roughness: 0.75, metalness: 0.3 });
  M.glass = new THREE.MeshPhysicalMaterial({
    color: 0x9fb3c8, roughness: 0.04, metalness: 0.1, transparent: true, opacity: 0.16,
    envMapIntensity: 2.2, depthWrite: false, side: THREE.DoubleSide, specularIntensity: 1,
  });
  M.darkGlass = std({ color: 0x55627e, roughness: 0.35, metalness: 0.2 });
  M.upperView = std({ map: T.upperWindows, emissive: 0xffffff, emissiveMap: T.upperWindows, emissiveIntensity: 0.55, roughness: 1 });
  M.sideView = std({ map: T.sideWindows, emissive: 0xffffff, emissiveMap: T.sideWindows, emissiveIntensity: 0.45, roughness: 1 });
  M.concrete = std({ color: 0x8c8984, roughness: 0.92 });
  M.paving = std({ map: T.paving, roughness: 0.85 });
  M.grass = std({ map: T.grass, roughness: 1 });
  M.asphalt = std({ map: T.asphalt, roughness: 0.9 });
  M.hedge = std({ color: 0x2c4128, roughness: 1 });
  M.logo = std({ map: T.logo, transparent: true, emissive: 0xffffff, emissiveMap: T.logo, emissiveIntensity: 0.5, roughness: 0.8, metalness: 0, depthWrite: false });

  M.wall = std({ color: 0xebe8e2, roughness: 0.92 });
  M.wallWarm = std({ color: 0xd9d3c9, roughness: 0.92 });
  M.ceiling = std({ color: 0xf1f0ec, roughness: 0.95 });
  M.floor = std({ map: repeatOf(T.floor, 16 / 2.4, 14 / 2.4), roughness: 0.82, metalness: 0.0, envMapIntensity: 0.5 });
  M.skirting = std({ color: 0x3a3d45, roughness: 0.85 });
  M.featureWall = std({ color: 0x111c44, roughness: 0.75, metalness: 0.05 });
  M.wood = std({ map: T.wood, roughness: 0.85 });
  M.woodDark = std({ map: T.wood, color: 0x7a6a5e, roughness: 0.85 });
  M.deskWhite = std({ color: 0xf2f0eb, roughness: 0.85 });
  M.fabric = std({ color: 0x3a4258, roughness: 1 });
  M.fabricLight = std({ color: 0x8c8a86, roughness: 1 });
  M.fabricAccent = std({ color: 0x2f6c82, roughness: 1 });
  M.leather = std({ color: 0x23252b, roughness: 0.85 });
  M.metal = std({ color: 0xb8bcc2, roughness: 0.6, metalness: 0.6 });
  M.metalDark = std({ color: 0x2a2c31, roughness: 0.75, metalness: 0.3 });
  M.screen = std({ color: 0x0b0f1a, roughness: 0.6, emissive: 0x16305a, emissiveIntensity: 0.6 });
  M.lightPanel = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4e6, emissiveIntensity: 2.2 });
  M.lightWarm = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffd9a8, emissiveIntensity: 2.4 });
  M.cyanLine = new THREE.MeshStandardMaterial({ color: 0x00a2e5, emissive: 0x00a2e5, emissiveIntensity: 0.6 });
  M.pot = std({ color: 0x3b3a38, roughness: 0.8 });
  M.potLight = std({ color: 0xcfc9bf, roughness: 0.85 });
  M.soil = std({ color: 0x2a211a, roughness: 1 });
  M.stem = std({ color: 0x4a3b28, roughness: 0.9 });
  M.leaves = [0x355236, 0x2c4a2f, 0x3e5e3a, 0x2a4129].map((c) =>
    std({ color: c, roughness: 0.7, side: THREE.DoubleSide }));
  M.paper = std({ color: 0xf3f1ec, roughness: 0.9 });
  M.cork = std({ map: T.notice, roughness: 0.95 });
  M.poster = std({ map: T.poster, roughness: 0.85 });
  M.rug = std({ map: T.rug, roughness: 1 });
  M.clockFace = std({ map: T.clock, roughness: 0.85 });
  M.frameBlack = std({ color: 0x1d1f24, roughness: 0.85, metalness: 0.1 });
  M.books = [0x6d2f2f, 0x1f3a5f, 0x2f4a3a, 0x8a6d3b, 0x3d3f4a, 0x5a4a6a, 0xb7b0a2, 0x111c44].map((c) =>
    std({ color: c, roughness: 0.8 }));
  M.ceramic = std({ color: 0xece9e2, roughness: 0.75 });
  M.paint = std({ color: 0xf4f4f2, roughness: 0.7, metalness: 0 });
  M.paintNavy = std({ color: 0x111c44, roughness: 0.7, metalness: 0 });
  M.paintCyan = std({ color: 0x00a2e5, roughness: 0.7, metalness: 0 });
  M.inlay = std({ color: 0x9aa3ad, roughness: 0.6, metalness: 0.5 });
  M.wayfinding = std({ map: T.wayfinding, emissive: 0xffffff, emissiveMap: T.wayfinding, emissiveIntensity: 0.35, roughness: 0.85 });
  M.monument = std({ map: T.monument, emissive: 0xffffff, emissiveMap: T.monument, emissiveIntensity: 0.2, roughness: 0.85, metalness: 0 });
  M.stone = std({ color: 0x5d5a57, roughness: 0.85 });
  return M;
}

/* ---------- Sky: a quiet sunset ---------- */
// The sun sits just above the horizon to the west (-x), off the camera's left shoulder.
const SUN_DIR = new THREE.Vector3(-0.85, 0.03, -0.5).normalize();
function buildSky() {
  const geo = new THREE.SphereGeometry(420, 64, 32);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color('#0d1840') },
      mid: { value: new THREE.Color('#2f3c76') },
      haze: { value: new THREE.Color('#a08aaa') },
      horizon: { value: new THREE.Color('#e3a587') },
      sunGlow: { value: new THREE.Color('#ff9b5e') },
      sunCore: { value: new THREE.Color('#ffe4bd') },
      ground: { value: HORIZON.clone() },
      sunDir: { value: SUN_DIR },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform vec3 top, mid, haze, horizon, sunGlow, sunCore, ground, sunDir; varying vec3 vDir;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
      float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
      void main(){
        vec3 d = normalize(vDir);
        float h = d.y;
        float az = max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(sunDir.x, 0.0, sunDir.z))), 0.0);
        float toSun = max(dot(d, sunDir), 0.0);
        // warm band at the horizon (widest toward the sun), lavender haze, dusk blue, navy overhead
        float warmth = 0.55 + 0.45 * pow(az, 1.5);
        vec3 low = mix(haze, horizon, warmth);
        vec3 c = mix(low, haze, smoothstep(0.0, 0.12 + 0.12 * warmth, h));
        c = mix(c, mid, smoothstep(0.14, 0.52, h));
        c = mix(c, top, smoothstep(0.48, 0.98, h));
        // soft glow around the sun
        c += sunGlow * pow(az, 5.0) * (1.0 - smoothstep(0.0, 0.32, h)) * 0.32;
        c += sunCore * (smoothstep(0.99965, 0.99985, toSun) * 0.9 + pow(toSun, 80.0) * 0.22);
        // thin stratus streaks, lit warm underneath toward the sun
        vec2 uv = d.xz / (h + 0.06);
        float n = fbm(uv * vec2(0.35, 1.6) + vec2(3.1, 7.4));
        float band = smoothstep(0.015, 0.06, h) * (1.0 - smoothstep(0.16, 0.34, h));
        float cl = smoothstep(0.56, 0.8, n) * band;
        vec3 cloud = mix(vec3(0.40, 0.37, 0.52), vec3(1.0, 0.68, 0.52), pow(az, 1.5));
        c = mix(c, cloud, cl * 0.45);
        if (h < 0.0) c = mix(c, ground, smoothstep(0.0, -0.03, h));
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.userData.dynamic = true;
  sky.renderOrder = -1;
  scene.add(sky);
  return sky;
}

/* ---------- Plants ---------- */
const leafGeos = [];
function leafGeo(len, wid) {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.quadraticCurveTo(wid, len * 0.38, 0, len);
  s.quadraticCurveTo(-wid, len * 0.38, 0, 0);
  const g = new THREE.ShapeGeometry(s, 10);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / len, x = p.getX(i);
    p.setZ(i, y * y * len * 0.35 + Math.abs(x) * 0.35); // droop along the length, fold along the midrib
  }
  g.computeVertexNormals();
  return g;
}
for (let i = 0; i < 4; i++) leafGeos.push(leafGeo(0.22 + i * 0.05, 0.07 + i * 0.015));

/** A potted plant. `height` is the foliage top above the floor. */
function plant(x, z, { height = 1.5, spread = 0.45, potH = 0.48, potR = 0.24, leaves = 70, light = false } = {}) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  scene.add(g);
  const prof = [
    new THREE.Vector2(0, 0), new THREE.Vector2(potR * 0.78, 0), new THREE.Vector2(potR * 0.92, potH * 0.4),
    new THREE.Vector2(potR, potH * 0.96), new THREE.Vector2(potR * 1.02, potH), new THREE.Vector2(potR * 0.94, potH),
    new THREE.Vector2(potR * 0.9, potH * 0.92), new THREE.Vector2(0, potH * 0.92),
  ];
  mesh(new THREE.LatheGeometry(prof, 32), light ? M.potLight : M.pot, 0, 0, 0, g);
  cyl(potR * 0.88, potR * 0.88, 0.01, M.soil, 0, potH * 0.88, 0, g);
  // a few stems
  const stems = 3;
  for (let s = 0; s < stems; s++) {
    const st = cyl(0.008, 0.012, height - potH, M.stem, (rand() - 0.5) * 0.06, potH + (height - potH) / 2 - 0.05, (rand() - 0.5) * 0.06, g, 6);
    st.rotation.set((rand() - 0.5) * 0.18, 0, (rand() - 0.5) * 0.18);
  }
  for (let i = 0; i < leaves; i++) {
    const t = Math.pow(rand(), 0.7);
    const y = potH + 0.12 + t * (height - potH - 0.2);
    const r = spread * (0.25 + 0.75 * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.15)));
    const az = rand() * Math.PI * 2;
    const pivot = new THREE.Group();
    pivot.position.set(Math.cos(az) * r * 0.35, y, Math.sin(az) * r * 0.35);
    pivot.rotation.y = -az + Math.PI / 2;
    g.add(pivot);
    const leaf = new THREE.Mesh(leafGeos[(rand() * leafGeos.length) | 0], M.leaves[(rand() * M.leaves.length) | 0]);
    leaf.rotation.x = 0.5 + rand() * 0.9 - t * 0.3;
    leaf.rotation.z = (rand() - 0.5) * 0.5;
    const sc = 0.8 + rand() * 0.6;
    leaf.scale.setScalar(sc);
    add(leaf, pivot);
  }
  return g;
}

/* ---------- Furniture ---------- */
/** Sofa or armchair built facing +z, origin on the floor at the centre. */
function sofa(width, { seats = 3, accent = false } = {}) {
  if (width >= 2 && FURN.sofa3) return placeFurn('sofa3', 0, 0, 0);
  if (width < 1.2 && FURN.lounge_chair) return placeFurn('lounge_chair', 0, 0, 0);
  const g = new THREE.Group();
  const depth = 0.9, armW = 0.16;
  const inner = width - armW * 2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    cyl(0.018, 0.014, 0.1, M.metalDark, sx * (width / 2 - 0.08), 0.05, sz * (depth / 2 - 0.08), g, 10);
  rbox(width, 0.2, depth, 0.03, M.fabric, 0, 0.2, 0, g);
  const cw = inner / seats;
  for (let i = 0; i < seats; i++) {
    const cx = -inner / 2 + cw * (i + 0.5);
    rbox(cw - 0.015, 0.15, 0.66, 0.06, M.fabric, cx, 0.375, 0.1, g);
    const back = rbox(cw - 0.03, 0.42, 0.18, 0.07, M.fabric, cx, 0.66, -0.24, g);
    back.rotation.x = -0.14;
  }
  rbox(width, 0.62, 0.16, 0.04, M.fabric, 0, 0.41, -depth / 2 + 0.08, g);
  for (const sx of [-1, 1]) rbox(armW, 0.5, depth, 0.05, M.fabric, sx * (width / 2 - armW / 2), 0.35, 0, g);
  if (accent) {
    const c = rbox(0.42, 0.4, 0.13, 0.07, M.fabricAccent, inner / 2 - 0.3, 0.62, -0.1, g);
    c.rotation.set(-0.25, -0.3, 0.12);
    const c2 = rbox(0.42, 0.4, 0.13, 0.07, M.fabricLight, -inner / 2 + 0.3, 0.62, -0.1, g);
    c2.rotation.set(-0.25, 0.3, -0.1);
  }
  scene.add(g);
  return g;
}

function officeChair() {
  if (FURN.office_chair) return placeFurn('office_chair', 0, 0, 0);
  const g = new THREE.Group();
  rbox(0.5, 0.08, 0.48, 0.03, M.leather, 0, 0.48, 0, g);
  const back = rbox(0.46, 0.56, 0.06, 0.03, M.leather, 0, 0.86, -0.25, g);
  back.rotation.x = -0.1;
  cyl(0.02, 0.02, 0.36, M.metal, 0, 0.27, 0, g, 12);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const arm = box(0.3, 0.03, 0.04, M.metalDark, Math.cos(a) * 0.15, 0.07, Math.sin(a) * 0.15, g);
    arm.rotation.y = -a;
    mesh(new THREE.SphereGeometry(0.025, 10, 8), M.metalDark, Math.cos(a) * 0.3, 0.03, Math.sin(a) * 0.3, g);
  }
  scene.add(g);
  return g;
}

/* ---------- Building ---------- */
const LOBBY = { x0: -8, x1: 8, z0: 0, z1: -14, h: 3.6 };
const doorLeaves = []; // main entrance sliding leaves
const DOORS = {};      // classroom doors A and B: { pivot, leaf, leafMat, sign, open, hover }
const DOOR_X = { A: -1.65, B: 1.65 };
const DOOR_W = 1.06, DOOR_H = 2.3;
const DOOR_HOLES = [...Object.values(DOOR_X).map((x) => [x - DOOR_W / 2, x + DOOR_W / 2, DOOR_H]), [-0.62, 0.62, 2.42]]; // A, B and the double door C

/** A wall plane from x0..x1 with door-shaped notches cut from the floor up. holes: [xa, xb, height]. */
function holedWall(x0, x1, h, z, facing, holes, mat) {
  const cx = (x0 + x1) / 2, sgn = facing === '+z' ? 1 : -1;
  const local = holes.map(([a, b, hh]) => { const u = (a - cx) * sgn, v = (b - cx) * sgn; return [Math.min(u, v), Math.max(u, v), hh]; })
    .filter(([a, b]) => b > x0 - cx && a < x1 - cx).sort((p, q) => p[0] - q[0]);
  const w = x1 - x0, sh = new THREE.Shape();
  sh.moveTo(-w / 2, 0);
  for (const [a, b, hh] of local) { sh.lineTo(a, 0); sh.lineTo(a, hh); sh.lineTo(b, hh); sh.lineTo(b, 0); }
  sh.lineTo(w / 2, 0); sh.lineTo(w / 2, h); sh.lineTo(-w / 2, h); sh.closePath();
  const m = mesh(new THREE.ShapeGeometry(sh), mat, cx, 0, z, scene, { cast: false, receive: true });
  if (sgn < 0) m.rotation.y = Math.PI;
  return m;
}
let clockHands = null;

function buildExterior() {
  // Ground: lawn, forecourt paving, street
  const lawn = panel(260, 260, M.grass, 0, -0.01, 40, 'up');
  lawn.material.map = repeatOf(M.grass.map, 90, 90);
  LAWN.push(lawn.material);
  const plaza = panel(30, 12, M.paving, 0, 0.002, 6, 'up');
  plaza.material = M.paving.clone(); plaza.material.map = repeatOf(M.paving.map, 30 / 2.4, 12 / 2.4);
  PAVED.push(plaza.material);
  const path = panel(4.4, 20, M.paving, 0, 0.003, 22, 'up');
  path.material = M.paving.clone(); path.material.map = repeatOf(M.paving.map, 4.4 / 2.4, 20 / 2.4);
  PAVED.push(path.material);
  const road = panel(260, 9, M.asphalt, 0, 0.001, 36.5, 'up');
  road.material = M.asphalt.clone(); road.material.map = repeatOf(M.asphalt.map, 60, 2);
  ASPHALT.push(road.material);
  // kerbs and road markings
  box(260, 0.12, 0.25, M.concrete, 0, 0.06, 31.9);
  box(260, 0.12, 0.25, M.concrete, 0, 0.06, 41.1);
  for (let x = -120; x < 120; x += 6) box(3, 0.005, 0.14, M.paper, x, 0.006, 36.5, scene, { cast: false });
  // entrance step / threshold
  box(8, 0.06, 1.6, M.concrete, 0, 0.03, 0.8);

  // Volumes around the lobby
  const clad = (w, h, d, x, y, z) => {
    const m = box(w, h, d, M.cladding, x, y, z);
    m.material = M.cladding.clone();
    m.material.map = repeatOf(M.cladding.map, Math.max(w, d) / 3, h / 1.5);
    return m;
  };
  // the building runs back to z = -23 so rooms A and B fit behind the lobby
  clad(6, 4.4, 23, -11, 2.2, -11.5);
  clad(6, 4.4, 23, 11, 2.2, -11.5);
  // back wall, with the opening (x -0.8..0.8, up to 3 m) for the airside exit
  clad(7.2, 4.4, 0.8, -4.4, 2.2, -22.6);
  clad(7.2, 4.4, 0.8, 4.4, 2.2, -22.6);
  clad(1.6, 1.4, 0.8, 0, 3.7, -22.6);
  clad(28, 4.6, 23, 0, 6.7, -11.5);
  box(28.3, 0.35, 23.3, M.claddingDeep, 0, 9.15, -11.5); // parapet coping
  box(16, 0.8, 0.5, M.claddingDeep, 0, 4.0, -0.25);   // lobby fascia
  // front lining between glass and side blocks
  box(2, 3.6, 0.3, M.claddingPlain, -7, 1.8, -0.15);
  box(2, 3.6, 0.3, M.claddingPlain, 7, 1.8, -0.15);

  // Upper storey: ribbon windows with vertical fins, logo panel in the middle
  for (const side of [-1, 1]) {
    const cx = side * 8.9, w = 9;
    panel(w, 3.2, M.upperView, cx, 6.6, 0.02, '+z');
    panel(w, 3.2, M.glass, cx, 6.6, 0.05, '+z');
    box(w, 0.08, 0.12, M.mullion, cx, 5.0, 0.06);
    box(w, 0.08, 0.12, M.mullion, cx, 8.2, 0.06);
    box(w, 0.06, 0.08, M.mullion, cx, 7.45, 0.06);
    for (let i = 0; i <= 6; i++) box(0.1, 3.3, 0.55, M.claddingDeep, cx - w / 2 + (w / 6) * i, 6.6, 0.28);
  }
  box(8.6, 3.6, 0.36, M.claddingDeep, 0, 6.6, 0.18);
  const logo = panel(6.8, 6.8 * (473 / 1564), M.logo, 0, 6.6, 0.37, '+z', scene, { cast: false, receive: false });
  logo.renderOrder = 2;

  // Side-block windows on the ground floor
  for (const side of [-1, 1]) {
    for (const off of [-1.4, 1.4]) {
      const cx = side * (11 + off);
      panel(2.2, 2.6, M.sideView, cx, 1.9, 0.02, '+z');
      panel(2.2, 2.6, M.glass, cx, 1.9, 0.05, '+z');
      box(2.36, 0.08, 0.12, M.mullion, cx, 0.56, 0.06);
      box(2.36, 0.08, 0.12, M.mullion, cx, 3.24, 0.06);
      box(0.08, 2.76, 0.12, M.mullion, cx - 1.14, 1.9, 0.06);
      box(0.08, 2.76, 0.12, M.mullion, cx + 1.14, 1.9, 0.06);
    }
  }

  // Lobby curtain wall, x -6..6, with the sliding entrance x -1.4..1.4
  const gz = 0;
  const mul = (x) => box(0.09, 3.6, 0.16, M.mullion, x, 1.8, gz);
  [-6, -4, -1.45, 1.45, 4, 6].forEach(mul);
  box(12, 0.1, 0.16, M.mullion, 0, 3.55, gz);
  box(12, 0.06, 0.16, M.mullion, 0, 0.03, gz);
  box(2.9, 0.12, 0.2, M.mullion, 0, 2.86, gz);   // door head
  for (const [a, b] of [[-6, -4], [-4, -1.45], [1.45, 4], [4, 6]]) panel(b - a, 3.5, M.glass, (a + b) / 2, 1.8, gz, '+z', scene, { cast: false, receive: false });
  panel(2.9, 0.65, M.glass, 0, 3.2, gz, '+z', scene, { cast: false, receive: false });
  // sliding leaves, each 1.4 m, run inside the fixed glass when open
  for (const side of [-1, 1]) {
    const leaf = new THREE.Group();
    leaf.userData.closedX = side * 0.7;
    leaf.position.set(side * 0.7, 0, -0.14);
    leaf.userData.dynamic = true;
    scene.add(leaf);
    panel(1.32, 2.72, M.glass, 0, 1.4, 0, '+z', leaf, { cast: false, receive: false });
    box(1.4, 0.06, 0.05, M.mullion, 0, 0.04, 0, leaf);
    box(1.4, 0.06, 0.05, M.mullion, 0, 2.77, 0, leaf);
    box(0.05, 2.8, 0.05, M.mullion, -0.68, 1.4, 0, leaf);
    box(0.05, 2.8, 0.05, M.mullion, 0.68, 1.4, 0, leaf);
    cyl(0.014, 0.014, 0.9, M.metal, -side * 0.56, 1.1, 0.06, leaf, 10);
    doorLeaves.push(leaf);
  }
  // door track box above
  box(5.8, 0.18, 0.18, M.mullion, 0, 2.98, -0.14);

  // Entrance canopy with downlights
  box(7.4, 0.22, 3.2, M.claddingDeep, 0, 3.25, 1.6);
  for (const x of [-2.4, 0, 2.4]) cyl(0.11, 0.11, 0.02, M.lightWarm, x, 3.13, 1.9, scene, 24, { cast: false, receive: false });
  const canopyLight = new THREE.SpotLight(0xffd8a8, 22, 9, 1.0, 0.8, 1.6);
  canopyLight.position.set(0, 3.1, 1.9);
  canopyLight.target.position.set(0, 0, 2.2);
  scene.add(canopyLight, canopyLight.target);

  // Planters with clipped hedges either side of the forecourt
  for (const side of [-1, 1]) {
    for (const z of [4.2, 8.6]) {
      box(1.0, 0.55, 3.4, M.concrete, side * 4.6, 0.275, z);
      rbox(0.86, 0.5, 3.26, 0.18, M.hedge, side * 4.6, 0.78, z);
    }
    // low bollard lights along the path
    for (const z of [3, 7, 11, 15, 19, 23, 27]) {
      cyl(0.07, 0.07, 0.8, M.metalDark, side * 2.6, 0.4, z, scene, 16);
      cyl(0.071, 0.071, 0.06, M.lightWarm, side * 2.6, 0.7, z, scene, 16, { cast: false, receive: false });
    }
    // street lamps
    const lx = side * 9, lz = 12;
    cyl(0.06, 0.08, 5.2, M.metalDark, lx, 2.6, lz, scene, 16);
    box(0.9, 0.08, 0.22, M.metalDark, lx - side * 0.4, 5.2, lz);
    box(0.6, 0.02, 0.16, M.lightWarm, lx - side * 0.5, 5.15, lz, scene, { cast: false, receive: false });
  }
  // Monument sign beside the head of the path
  const mg = new THREE.Group();
  mg.position.set(6.4, 0, 15.5);
  mg.rotation.y = -0.32;
  scene.add(mg);
  box(4.2, 0.18, 0.9, M.stone, 0, 0.09, 0, mg);
  box(3.9, 1.5, 0.5, M.claddingDeep, 0, 0.93, 0, mg);
  panel(3.8, 3.8 * (820 / 2048), M.monument, 0, 0.94, 0.252, '+z', mg, { cast: false, receive: false });
  box(3.9, 0.04, 0.52, M.metal, 0, 1.7, 0, mg);
  rbox(3.6, 0.5, 0.8, 0.18, M.hedge, 0, 0.25, -0.75, mg);
  // Timber soffit under the entrance canopy
  const soffit = panel(7.2, 3.0, M.wood.clone(), 0, 3.138, 1.6, 'down');
  soffit.material.map = repeatOf(M.wood.map, 6, 1);
  for (let i = 0; i < 24; i++) box(0.012, 0.012, 3.0, M.claddingDeep, -3.45 + i * 0.3, 3.13, 1.6, scene, { cast: false });
  // a pair of trees beyond the planters, on the lawn
  for (const [x, z] of [[-14, 9], [15, 7], [-20, 14], [21, 16]]) tree(x, z);
}

const CODE_TREES = [];
function tree(x, z) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.userData.dynamic = true; // replaced by a maple once the vegetation loads
  CODE_TREES.push(g);
  scene.add(g);
  const h = 4 + rand() * 1.5;
  cyl(0.1, 0.16, h * 0.55, M.stem, 0, h * 0.275, 0, g, 10);
  const foliage = new THREE.MeshStandardMaterial({ color: 0x24361f, roughness: 1, flatShading: false });
  for (let i = 0; i < 26; i++) {
    const r = 0.6 + rand() * 0.6;
    const a = rand() * Math.PI * 2, d = rand() * 1.1;
    const s = mesh(new THREE.IcosahedronGeometry(r, 2), foliage, Math.cos(a) * d, h * 0.55 + rand() * h * 0.45, Math.sin(a) * d, g);
    s.scale.y = 0.8;
  }
}

function buildLobby() {
  const { x0, x1, z1, h } = LOBBY;
  const W = x1 - x0, D = -z1, cz = z1 / 2;

  // Shell
  panel(W, D, M.floor, 0, 0.004, cz, 'up');
  panel(W, D, M.ceiling, 0, h, cz, 'down');
  panel(D, h, M.wall, x0 + 0.01, h / 2, cz, '+x');
  panel(D, h, M.wall, x1 - 0.01, h / 2, cz, '-x');
  holedWall(x0, x1, h, z1 + 0.01, '+z', DOOR_HOLES, M.wallWarm);
  panel(2, h, M.wall, -7, h / 2, -0.31, '-z');
  panel(2, h, M.wall, 7, h / 2, -0.31, '-z');
  // skirting
  box(D, 0.09, 0.015, M.skirting, x0 + 0.02, 0.045, cz).rotation.y = Math.PI / 2;
  box(D, 0.09, 0.015, M.skirting, x1 - 0.02, 0.045, cz).rotation.y = Math.PI / 2;
  box(W, 0.09, 0.015, M.skirting, 0, 0.045, z1 + 0.02);
  // entrance mat just inside
  box(3.0, 0.012, 1.6, M.leather, 0, 0.006, -1.2, scene, { cast: false });

  // Ceiling: recessed panels and a perimeter cove
  for (const x of [-4, 0, 4]) for (const z of [-2.6, -6.2, -9.8, -12.6]) {
    if (x === 4 && (z === -6.2 || z === -9.8)) continue; // pendants live over the lounge
    box(0.62, 0.02, 0.62, M.mullion, x, h - 0.008, z, scene, { cast: false, receive: false });
    box(0.58, 0.01, 0.58, M.lightPanel, x, h - 0.02, z, scene, { cast: false, receive: false });
  }

  buildReception();
  buildLounge();
  buildBackWall();
  buildSideWalls();
  buildAviationTouches();
  buildRooms();
  buildDoorC();
  buildCorridor();

  // Corner plants by the glass
  plant(-7.25, -0.9, { height: 1.75, spread: 0.55, potR: 0.27, potH: 0.55, leaves: 90 });
  plant(7.25, -0.9, { height: 1.75, spread: 0.55, potR: 0.27, potH: 0.55, leaves: 90 });

  // Interior lighting: soft ceiling fill + one shadow-casting key over the walkway
  for (const [x, z] of [[0, -2.8], [0, -11]]) {
    const p = new THREE.PointLight(0xfff0dc, 14, 18, 1.4);
    p.position.set(x, h - 0.35, z);
    scene.add(p);
  }
  const key = new THREE.SpotLight(0xfff3e4, 38, 16, 1.2, 1, 1.5);
  key.position.set(0, h - 0.1, -7.2);
  key.target.position.set(0, 0, -7.4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 6;
  key.shadow.camera.near = 0.3;
  key.shadow.camera.far = 8;
  scene.add(key, key.target);
}

function buildReception() {
  // Navy feature wall with the logo, washed from above
  panel(5.2, LOBBY.h, M.featureWall, LOBBY.x0 + 0.03, LOBBY.h / 2, -7.2, '+x');
  // vertical oak slats either side of the navy panel
  for (const side of [-1, 1]) for (let i = 0; i < 6; i++) box(0.04, LOBBY.h, 0.05, M.wood, LOBBY.x0 + 0.04, LOBBY.h / 2, -7.2 + side * (2.72 + i * 0.1));
  const logo = panel(3.4, 3.4 * (473 / 1564), M.logo.clone(), LOBBY.x0 + 0.05, 2.35, -7.2, '+x', scene, { cast: false, receive: false });
  logo.material.emissiveIntensity = 0.25;
  const wash = new THREE.SpotLight(0xfff1de, 16, 7, 0.9, 1, 1.5);
  wash.position.set(-6.4, LOBBY.h - 0.1, -7.2);
  wash.target.position.set(-8, 1.6, -7.2);
  scene.add(wash, wash.target);

  // Desk: front counter (visitor side faces +x) and a lower work surface behind
  const dx = -5.0, dz = -7.2, len = 3.4;
  rbox(0.5, 1.06, len, 0.03, M.deskWhite, dx, 0.53, dz);
  box(0.02, 0.62, len - 0.2, M.featureWall, dx + 0.26, 0.6, dz);           // navy front inlay
  box(0.012, 0.012, len - 0.2, M.cyanLine, dx + 0.272, 0.93, dz, scene, { cast: false });
  box(0.66, 0.045, len + 0.12, M.wood, dx + 0.08, 1.08, dz);              // oak transaction top
  box(0.06, 0.08, len - 0.1, M.skirting, dx + 0.2, 0.04, dz);
  // return ends
  rbox(0.9, 0.76, 0.06, 0.02, M.deskWhite, dx - 0.65, 0.38, dz - len / 2 + 0.03);
  rbox(0.9, 0.76, 0.06, 0.02, M.deskWhite, dx - 0.65, 0.38, dz + len / 2 - 0.03);
  box(0.8, 0.04, len, M.deskWhite, dx - 0.65, 0.76, dz);

  // Two monitors (screens face -x towards the staff side), keyboard, phone, papers
  for (const z of [dz - 0.7, dz + 0.8]) {
    const g = new THREE.Group();
    g.position.set(dx - 0.55, 0.78, z);
    g.rotation.y = -Math.PI / 2 + (z > dz ? -0.12 : 0.12);
    scene.add(g);
    box(0.2, 0.012, 0.16, M.metalDark, 0, 0.006, 0, g);
    box(0.04, 0.3, 0.02, M.metalDark, 0, 0.16, -0.04, g);
    box(0.56, 0.34, 0.025, M.metalDark, 0, 0.42, -0.02, g);
    box(0.53, 0.31, 0.002, M.screen, 0, 0.42, -0.006, g, { cast: false });
    box(0.42, 0.015, 0.13, M.metalDark, 0, 0.008, 0.26, g);
  }
  box(0.3, 0.008, 0.22, M.paper, dx - 0.8, 0.784, dz + 0.1).rotation.y = 0.2;
  // brochure stand and a small plant on the counter
  box(0.24, 0.3, 0.12, M.frameBlack, dx + 0.1, 1.25, dz + 1.25).rotation.z = 0.08;
  box(0.2, 0.26, 0.01, M.poster, dx + 0.13, 1.27, dz + 1.25, scene, { cast: false }).rotation.y = Math.PI / 2;
  const p = plant(dx + 0.1, dz - 1.3, { height: 0.48, spread: 0.18, potR: 0.08, potH: 0.12, leaves: 22, light: true });
  p.position.y = 1.1;
  // staff chairs
  for (const z of [dz - 0.7, dz + 0.8]) {
    const c = officeChair();
    c.position.set(dx - 1.25, 0, z);
    c.rotation.y = Math.PI / 2 + (rand() - 0.5) * 0.4;
  }
  // a pendant pair over the desk
  pendant(dx - 0.2, dz - 0.8, 2.55);
  pendant(dx - 0.2, dz + 0.8, 2.55);
  plant(-7.3, -4.0, { height: 1.4, spread: 0.45, leaves: 70 });
}

function pendant(x, z, y, withLight = false) {
  const prof = [new THREE.Vector2(0.02, 0.32), new THREE.Vector2(0.06, 0.3), new THREE.Vector2(0.15, 0.12), new THREE.Vector2(0.2, 0.0), new THREE.Vector2(0.195, 0.0)];
  const shade = mesh(new THREE.LatheGeometry(prof, 40), new THREE.MeshStandardMaterial({ color: 0x111c44, roughness: 0.8, metalness: 0.1, side: THREE.DoubleSide }), x, y, z);
  shade.castShadow = false;
  cyl(0.004, 0.004, LOBBY.h - y - 0.3, M.metalDark, x, (LOBBY.h + y + 0.3) / 2, z, scene, 6, { cast: false });
  cyl(0.17, 0.17, 0.01, M.lightWarm, x, y + 0.02, z, scene, 32, { cast: false, receive: false });
  if (withLight) {
    const l = new THREE.PointLight(0xffd9ad, 4, 6, 1.6);
    l.position.set(x, y - 0.1, z);
    scene.add(l);
  }
}

function buildLounge() {
  const cx = 5.5, cz = -7.6;
  const rug = panel(3.6, 2.9, M.rug, cx, 0.012, cz, 'up');
  rug.rotation.z = Math.PI / 2;

  const s = sofa(2.4, { seats: 3, accent: true });
  s.position.set(7.45, 0, cz);
  s.rotation.y = -Math.PI / 2;
  for (const z of [cz - 1.1, cz + 1.1]) {
    const a = sofa(0.9, { seats: 1 });
    a.position.set(4.25, 0, z);
    a.rotation.y = Math.PI / 2 + (z < cz ? 0.35 : -0.35);
  }
  // round coffee table: oak top, slim steel legs
  const tx = 5.85;
  if (FURN.coffee_table) placeFurn('coffee_table', tx, 0, cz);
  else {
    cyl(0.52, 0.52, 0.035, M.wood, tx, 0.42, cz, scene, 48);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const leg = cyl(0.012, 0.012, 0.42, M.metalDark, tx + Math.cos(a) * 0.36, 0.2, cz + Math.sin(a) * 0.36, scene, 8);
      leg.rotation.set(Math.sin(a) * 0.12, 0, -Math.cos(a) * 0.12);
    }
  }
  // magazines + mug + a small vase
  [0.0, 0.1].forEach((r, i) => box(0.24, 0.008, 0.32, M.books[i + 1], tx - 0.15, 0.442 + i * 0.009, cz + 0.12).rotation.y = r + 0.3);
  box(0.24, 0.008, 0.32, M.paper, tx - 0.13, 0.46, cz + 0.1).rotation.y = 0.5;
  const mug = cyl(0.04, 0.035, 0.09, M.ceramic, tx + 0.2, 0.483, cz - 0.15, scene, 20);
  const vase = mesh(new THREE.LatheGeometry([new THREE.Vector2(0, 0), new THREE.Vector2(0.06, 0), new THREE.Vector2(0.08, 0.08), new THREE.Vector2(0.04, 0.2), new THREE.Vector2(0.045, 0.24), new THREE.Vector2(0, 0.24)], 24), M.ceramic, tx + 0.15, 0.44, cz + 0.22);
  // side table with a lamp by the sofa
  cyl(0.24, 0.24, 0.03, M.wood, 7.4, 0.55, cz + 1.6, scene, 32);
  cyl(0.02, 0.02, 0.54, M.metalDark, 7.4, 0.27, cz + 1.6, scene, 8);
  cyl(0.16, 0.16, 0.012, M.metalDark, 7.4, 0.006, cz + 1.6, scene, 24);
  cyl(0.05, 0.07, 0.3, M.ceramic, 7.4, 0.72, cz + 1.6, scene, 20);
  const lampShade = cyl(0.11, 0.16, 0.2, new THREE.MeshStandardMaterial({ color: 0xf3ead9, emissive: 0xffe0b8, emissiveIntensity: 0.7, roughness: 1, side: THREE.DoubleSide }), 7.4, 0.95, cz + 1.6, scene, 32, { cast: false });

  // Pendants over the coffee table
  pendant(tx - 0.1, cz - 0.55, 2.35);
  pendant(tx - 0.1, cz + 0.55, 2.35);

  // Live traffic display above the sofa
  buildTrafficScreen(LOBBY.x1, 2.0, cz);

  plant(7.3, cz - 1.75, { height: 1.55, spread: 0.45, leaves: 80 });
}

/** Oak bookshelf against a side wall at wallX; dir = +1 faces +x, -1 faces -x. */
function bookshelf(wallX, bz, dir, { bw = 2.6, bh = 2.1, bd = 0.36, shelves = 5 } = {}) {
  if (FURN.bookshelf) {
    // real bookshelves side by side along the wall, shelves facing the room
    const size = FURN.bookshelfSize, n = Math.max(1, Math.round(bw / size.z));
    for (let i = 0; i < n; i++) placeFurn('bookshelf', wallX + dir * (size.x / 2 + 0.03), 0, bz + (i - (n - 1) / 2) * size.z, dir > 0 ? 0 : Math.PI);
    return;
  }
  const bx = wallX + dir * (bd / 2 + 0.02);
  box(bd, 0.04, bw, M.wood, bx, bh, bz);
  box(bd, 0.08, bw, M.wood, bx, 0.04, bz);
  box(0.02, bh, bw, M.woodDark, wallX + dir * 0.03, bh / 2, bz);
  for (const z of [bz - bw / 2 + 0.02, bz, bz + bw / 2 - 0.02]) box(bd, bh, 0.03, M.wood, bx, bh / 2, z);
  const step = (bh - 0.04) / shelves;
  for (let s = 0; s < shelves; s++) {
    const y = 0.08 + s * step;
    if (s > 0) box(bd, 0.025, bw, M.wood, bx, y, bz);
    for (const [za, zb] of [[bz - bw / 2 + 0.04, bz - 0.02], [bz + 0.02, bz + bw / 2 - 0.04]]) {
      let z = za + 0.02;
      while (z < zb - 0.05) {
        if (rand() < 0.08) { z += 0.15; continue; }
        const t = 0.025 + rand() * 0.035, hh = Math.min(step - 0.06, 0.22 + rand() * 0.1);
        if (z + t > zb) break;
        const b = box(0.2 + rand() * 0.06, hh, t, M.books[(rand() * M.books.length) | 0], bx + dir * 0.02, y + 0.0125 + hh / 2, z + t / 2);
        if (rand() < 0.06) b.rotation.x = 0.12;
        z += t + 0.003;
      }
    }
  }
}

function buildSideWalls() {
  const { x0, x1 } = LOBBY;
  // Notice board on the right wall, past the lounge
  const nz = -11.3;
  box(0.05, 1.42, 2.56, M.woodDark, x1 - 0.03, 1.6, nz);
  panel(2.44, 1.3, M.cork, x1 - 0.058, 1.6, nz, '-x');
  bookshelf(x0, -11.2, 1);
  plant(-7.3, -13.3, { height: 1.2, spread: 0.4, leaves: 60, light: true });
  // water point by the shelf
  rbox(0.32, 1.05, 0.32, 0.03, M.deskWhite, -7.6, 0.525, -9.35);
  cyl(0.13, 0.13, 0.36, new THREE.MeshPhysicalMaterial({ color: 0x9ec7e0, transparent: true, opacity: 0.45, roughness: 0.05 }), -7.6, 1.23, -9.35, scene, 24, { cast: false });
}

function buildBackWall() {
  const zw = LOBBY.z1;
  // Oak slat band behind the doors gives the end of the walk a focal point
  holedWall(-3.3, 3.3, LOBBY.h, zw + 0.02, '+z', DOOR_HOLES, M.featureWall);
  for (const side of [-1, 1]) for (let i = 0; i < 4; i++) box(0.06, LOBBY.h, 0.04, M.wood, side * (3.3 - i * 0.12), LOBBY.h / 2, zw + 0.04);

  for (const [letter, x, name] of [['A', -1.65, 'Cadet Prep'], ['B', 1.65, '1-on-1 Mentorship']]) {
    const dw = DOOR_W, dh = DOOR_H;
    // frame
    box(dw + 0.16, 0.08, 0.1, M.frameBlack, x, dh + 0.04, zw + 0.05);
    box(0.08, dh + 0.08, 0.1, M.frameBlack, x - dw / 2 - 0.04, (dh + 0.08) / 2, zw + 0.05);
    box(0.08, dh + 0.08, 0.1, M.frameBlack, x + dw / 2 + 0.04, (dh + 0.08) / 2, zw + 0.05);
    // reveal through the wall thickness
    box(0.03, dh, 0.24, M.frameBlack, x - dw / 2 - 0.005, dh / 2, zw - 0.1, scene, { cast: false });
    box(0.03, dh, 0.24, M.frameBlack, x + dw / 2 + 0.005, dh / 2, zw - 0.1, scene, { cast: false });
    box(dw + 0.04, 0.03, 0.24, M.frameBlack, x, dh + 0.005, zw - 0.1, scene, { cast: false });
    // leaf on a hinge pivot (A hinges on its right, B on its left, so both swing toward the partition)
    const hingeSide = letter === 'A' ? 1 : -1;
    const pivot = new THREE.Group();
    pivot.position.set(x + hingeSide * dw / 2, 0, zw + 0.05);
    pivot.userData.dynamic = true;
    scene.add(pivot);
    const leafMat = new THREE.MeshStandardMaterial({ map: T.door(letter, name), roughness: 0.85, metalness: 0, emissive: 0xffffff, emissiveIntensity: 0 });
    leafMat.emissiveMap = leafMat.map;
    const lx = -hingeSide * dw / 2; // leaf centre relative to the hinge
    const leaf = box(dw - 0.01, dh - 0.01, 0.045, leafMat, lx, dh / 2, 0, pivot);
    leaf.material = [M.claddingDeep, M.claddingDeep, M.claddingDeep, M.claddingDeep, leafMat, M.claddingDeep]; // letter on the front face only
    leaf.userData.room = letter;
    // vision panel and lever handles on the latch side
    const latch = lx - hingeSide * 0.32;
    box(0.12, 1.1, 0.052, M.darkGlass, latch, 1.45, 0, pivot, { cast: false });
    const hx = lx - hingeSide * 0.4;
    for (const face of [1, -1]) {
      cyl(0.03, 0.03, 0.03, M.metal, hx, 1.02, face * 0.04, pivot, 16).rotation.x = Math.PI / 2;
      box(0.16, 0.022, 0.022, M.metal, hx + hingeSide * 0.07, 1.02, face * 0.065, pivot);
    }
    DOORS[letter] = { pivot, leaf, leafMat, sign: -hingeSide, open: 0, hover: 0 };
    // plaque above the frame
    box(1.1, 0.236, 0.02, M.frameBlack, x, 2.7, zw + 0.03);
    panel(1.08, 1.08 * (220 / 1024), new THREE.MeshStandardMaterial({ map: T.plaque(letter, name), roughness: 0.85 }), x, 2.7, zw + 0.041, '+z');
    // wall-washer onto the door
    const wl = new THREE.SpotLight(0xfff0dd, 14, 6, 0.55, 0.9, 1.5);
    wl.position.set(x, LOBBY.h - 0.05, zw + 1.0);
    wl.target.position.set(x, 1.1, zw);
    scene.add(wl, wl.target);
    box(0.16, 0.02, 0.16, M.metalDark, x, LOBBY.h - 0.01, zw + 1.0, scene, { cast: false });
    cyl(0.05, 0.05, 0.005, M.lightPanel, x, LOBBY.h - 0.022, zw + 1.0, scene, 20, { cast: false, receive: false });
  }

  // Wall clock between the doors, with live hands
  const cg = new THREE.Group();
  cg.position.set(0, 3.12, zw + 0.06);
  scene.add(cg);
  const rim = cyl(0.25, 0.25, 0.05, M.frameBlack, 0, 0, 0, cg, 48);
  rim.rotation.x = Math.PI / 2;
  panel(0.46, 0.46, M.clockFace, 0, 0, 0.027, '+z', cg).material = new THREE.MeshStandardMaterial({ map: T.clock, roughness: 0.85, transparent: true, alphaTest: 0.5 });
  const hand = (len, w, mat, z) => {
    const pivot = new THREE.Group(); pivot.position.z = z; pivot.userData.dynamic = true; cg.add(pivot);
    box(w, len, 0.004, mat, 0, len / 2 - 0.03, 0, pivot, { cast: false });
    return pivot;
  };
  clockHands = { h: hand(0.13, 0.016, M.featureWall, 0.032), m: hand(0.19, 0.01, M.featureWall, 0.036), s: hand(0.2, 0.004, M.cyanLine, 0.04) };
  cyl(0.012, 0.012, 0.01, M.metalDark, 0, 0, 0.042, cg, 12).rotation.x = Math.PI / 2;

  // Tall plants framing the doors, plus a bench to wait at
  plant(-3.15, -13.45, { height: 1.85, spread: 0.5, potR: 0.25, potH: 0.6, leaves: 95, light: true });
  plant(3.15, -13.45, { height: 1.85, spread: 0.5, potR: 0.25, potH: 0.6, leaves: 95, light: true });
  for (const x of [-5.4, 5.4]) {
    if (FURN.bench) { placeFurn('bench', x, 0, -13.6); continue; }
    box(1.6, 0.05, 0.42, M.wood, x, 0.45, -13.6);
    for (const dx of [-0.7, 0.7]) box(0.04, 0.43, 0.38, M.metalDark, x + dx, 0.215, -13.6);
  }
}

/* ---------- Live traffic screen ---------- */
// Real ADS-B traffic comes from /api/traffic (coaching-centre/dev_server.py proxies adsb.lol).
// If that endpoint isn't there (static hosting, offline, rate-limited) the screen shows
// simulated traffic and says so in its header.
const AIRSPACES = [
  { code: 'BOM', icao: 'VABB', city: 'Mumbai', lat: 19.0896, lon: 72.8656 },
  { code: 'DEL', icao: 'VIDP', city: 'Delhi', lat: 28.5562, lon: 77.1 },
  { code: 'BLR', icao: 'VOBL', city: 'Bengaluru', lat: 13.1986, lon: 77.7066 },
];
const TRAFFIC = {
  screen: null, tex: null, ctx: null, idx: 0, cycleAt: 0, fetchAt: 0, drawAt: 0,
  data: null, live: false, loading: false, trails: new Map(),
};
const RANGE_NM = 45;

function buildTrafficScreen(wallX, y, z) {
  const c = document.createElement('canvas');
  c.width = 1920; c.height = 1080;
  TRAFFIC.ctx = c.getContext('2d');
  TRAFFIC.tex = new THREE.CanvasTexture(c);
  TRAFFIC.tex.colorSpace = THREE.SRGBColorSpace;
  TRAFFIC.tex.anisotropy = MAX_ANISO;
  // self-lit and matte, so lobby lights don't wash it out
  const mat = new THREE.MeshBasicMaterial({ map: TRAFFIC.tex, color: 0xe6e9f0 });
  const W = 2.3, H = W * 9 / 16;
  box(0.06, H + 0.07, W + 0.07, M.frameBlack, wallX - 0.04, y, z);
  const s = panel(W, H, mat, wallX - 0.072, y, z, '-x');
  s.userData.dynamic = true;
  TRAFFIC.screen = s;
  TRAFFIC.cycleAt = performance.now() + 30000;
  drawTraffic(performance.now());
}

function trafficAirspace() { return AIRSPACES[TRAFFIC.idx]; }
function cycleAirspace() { selectAirspace((TRAFFIC.idx + 1) % AIRSPACES.length); }
function selectAirspace(i) {
  if (i === TRAFFIC.idx && TRAFFIC.data) return;
  TRAFFIC.idx = i;
  TRAFFIC.live = false; TRAFFIC.drawAt = 0;
  document.querySelectorAll('[data-ap]').forEach((b) => b.setAttribute('aria-selected', String(+b.dataset.ap === i)));
  TRAFFIC.data = null; TRAFFIC.trails.clear(); TRAFFIC.fetchAt = 0;
  TRAFFIC.cycleAt = performance.now() + 30000;
}

async function fetchTraffic() {
  const ap = trafficAirspace();
  TRAFFIC.loading = true;
  try {
    const r = await fetch(`/api/traffic?airport=${ap.code}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    if (d.airport !== trafficAirspace().code) { TRAFFIC.fetchAt = 0; return; } // switched while loading: fetch the new one now
    TRAFFIC.data = { at: performance.now(), ac: d.ac.filter((a) => a.trk != null) };
    TRAFFIC.live = true;
  } catch (e) {
    if (ap !== trafficAirspace()) { TRAFFIC.fetchAt = 0; return; }
    if (!TRAFFIC.live || !TRAFFIC.data) { TRAFFIC.data = { at: performance.now(), ac: simulateTraffic(ap) }; TRAFFIC.live = false; }
  } finally {
    TRAFFIC.loading = false;
  }
}

function simulateTraffic(ap) {
  const r = mulberry32(ap.code.charCodeAt(0) * 31 + Math.floor(Date.now() / 600000));
  const airlines = ['IGO', 'AIC', 'AKJ', 'VTI', 'SEJ', 'UAE', 'QTR', 'SIA'];
  const types = ['A20N', 'A21N', 'B738', 'B38M', 'A320', 'AT76', 'B77W', 'B789'];
  const cosLat = Math.cos(THREE.MathUtils.degToRad(ap.lat));
  return Array.from({ length: 16 }, (_, i) => {
    const arriving = i % 2 === 0;
    const rwy = RWYS[ap.code][0].h;
    const d = 4 + r() * 40, brg = arriving ? rwy + 180 + (r() - 0.5) * 70 : rwy + (r() - 0.5) * 120;
    const br = THREE.MathUtils.degToRad(brg);
    const dy = Math.cos(br) * d, dx = Math.sin(br) * d;
    return {
      id: `sim${i}`, cs: `${airlines[(r() * airlines.length) | 0]}${100 + ((r() * 899) | 0)}`, type: types[(r() * types.length) | 0],
      lat: ap.lat + dy / 60, lon: ap.lon + dx / 60 / cosLat,
      alt: Math.round((d * 300 + r() * 3000) / 100) * 100, gs: 160 + d * 6 + r() * 60,
      trk: arriving ? (brg + 180) % 360 : brg % 360,
      vr: arriving ? -600 - r() * 500 : 1200 + r() * 1200,
    };
  });
}

// Runways are schematic: true heading, length (km), lateral offset from the airport reference point (km, + = left of the heading).
const RWYS = {
  BOM: [{ h: 93, km: 3.4, off: 0, ids: ['09', '27'] }, { h: 143, km: 2.9, off: 0, ids: ['14', '32'] }],
  DEL: [{ h: 93, km: 2.8, off: 1.6, ids: ['09', '27'] }, { h: 104, km: 3.8, off: -1.3, ids: ['10', '28'] }, { h: 113, km: 4.4, off: 0, ids: ['11', '29'] }],
  BLR: [{ h: 93, km: 4.0, off: 0.8, ids: ['09L', '27R'] }, { h: 93, km: 4.0, off: -0.8, ids: ['09R', '27L'] }],
};
const RADAR = {
  bg: '#0a1215', map: 'rgba(120,150,160,0.20)', mapText: 'rgba(150,175,185,0.55)',
  arr: '#9fdcff', dep: '#ffd391', ovf: '#cfe6d6', gnd: '#6c7c82', text: '#dfe9ec',
};
const KM_PER_NM = 1.852;
const mono = (wt, px) => FONT(wt, px, "'JetBrains Mono', ui-monospace, monospace");
const pad = (n, l = 2) => String(n).padStart(l, '0');

/** Arrival, departure or overflight, from altitude, vertical rate and range. */
function trackKind(a) {
  if (!a.alt) return 'gnd';
  if (a.alt < 16000 && a.rNm < 40) {
    if ((a.vr ?? 0) < -250) return 'arr';
    if ((a.vr ?? 0) > 250) return 'dep';
  }
  return 'ovf';
}

/** Draws an approach-radar style situation display, the way a controller sees the sector. */
function drawTraffic(now) {
  const g = TRAFFIC.ctx, W = 1920, H = 1080, ap = trafficAirspace();
  const bayW = 500, top = 64, cx = (W - bayW) / 2, cy = top + (H - top - 44) / 2, R = 470;
  const ppn = R / RANGE_NM; // pixels per nautical mile
  const cosLat = Math.cos(THREE.MathUtils.degToRad(ap.lat));
  const rad = THREE.MathUtils.degToRad;
  const at = (xNm, yNm) => [cx + xNm * ppn, cy - yNm * ppn];
  g.letterSpacing = '0px';
  g.lineCap = 'butt';
  g.fillStyle = RADAR.bg; g.fillRect(0, 0, W, H);

  // --- static map: range rings every 5 NM, compass rose, runways with extended centrelines ---
  g.save();
  g.beginPath(); g.arc(cx, cy, R + 2, 0, Math.PI * 2); g.clip();
  g.fillStyle = '#0c171b'; g.fillRect(0, 0, W, H);
  g.strokeStyle = RADAR.map; g.lineWidth = 1.5;
  for (let nm = 5; nm <= RANGE_NM; nm += 5) {
    g.globalAlpha = nm % 10 ? 0.55 : 1;
    g.beginPath(); g.arc(cx, cy, nm * ppn, 0, Math.PI * 2); g.stroke();
  }
  g.globalAlpha = 1;
  g.fillStyle = RADAR.mapText; g.font = mono(500, 15); g.textAlign = 'left';
  for (let nm = 10; nm < RANGE_NM; nm += 10) g.fillText(`${nm}`, cx + 4, cy - nm * ppn - 5);
  for (const rw of RWYS[ap.code]) {
    const d = [Math.sin(rad(rw.h)), Math.cos(rad(rw.h))], left = [-d[1], d[0]];
    const o = [left[0] * rw.off / KM_PER_NM, left[1] * rw.off / KM_PER_NM];
    const half = rw.km / KM_PER_NM / 2;
    // extended centrelines out to 15 NM from each threshold, ticks every mile
    for (const s of [-1, 1]) {
      const thr = [o[0] + d[0] * half * s, o[1] + d[1] * half * s];
      g.strokeStyle = 'rgba(150,175,185,0.35)'; g.lineWidth = 1.2; g.setLineDash([10, 8]);
      const end = at(thr[0] + d[0] * 15 * s, thr[1] + d[1] * 15 * s), st = at(...thr);
      g.beginPath(); g.moveTo(...st); g.lineTo(...end); g.stroke(); g.setLineDash([]);
      for (let m = 1; m <= 15; m++) {
        const p = at(thr[0] + d[0] * m * s, thr[1] + d[1] * m * s), len = m % 5 ? 4 : 10;
        g.beginPath(); g.moveTo(p[0] - left[0] * len, p[1] + left[1] * len); g.lineTo(p[0] + left[0] * len, p[1] - left[1] * len); g.stroke();
      }
    }
    // the runway itself
    const a1 = at(o[0] - d[0] * half, o[1] - d[1] * half), a2 = at(o[0] + d[0] * half, o[1] + d[1] * half);
    g.strokeStyle = '#c9d6da'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(...a1); g.lineTo(...a2); g.stroke();
    g.fillStyle = RADAR.mapText; g.font = mono(600, 13); g.textAlign = 'center';
    g.fillText(rw.ids[0], a1[0] - d[0] * 16, a1[1] + d[1] * 16 + 4);
    g.fillText(rw.ids[1], a2[0] + d[0] * 16, a2[1] - d[1] * 16 + 4);
  }
  g.restore();
  // compass rose on the outer ring
  g.strokeStyle = 'rgba(150,175,185,0.5)'; g.lineWidth = 1.5;
  g.fillStyle = RADAR.mapText; g.font = mono(500, 15); g.textAlign = 'center';
  for (let b = 0; b < 360; b += 5) {
    const a = rad(b), len = b % 30 === 0 ? 14 : b % 10 === 0 ? 8 : 4;
    g.beginPath(); g.moveTo(cx + Math.sin(a) * R, cy - Math.cos(a) * R); g.lineTo(cx + Math.sin(a) * (R + len), cy - Math.cos(a) * (R + len)); g.stroke();
    if (b % 30 === 0) g.fillText(pad(b, 3), cx + Math.sin(a) * (R + 30), cy - Math.cos(a) * (R + 30) + 5);
  }

  // --- tracks: position symbol, history dots, 1-minute speed vector, leader line and data block ---
  const ac = TRAFFIC.data?.ac || [];
  const dtH = TRAFFIC.data ? Math.min((now - TRAFFIC.data.at) / 3.6e6, 0.02) : 0;
  const shown = [];
  g.save();
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
  for (const a of ac) {
    const t = rad(a.trk || 0), run = (a.gs || 0) * dtH;
    const xNm = (a.lon - ap.lon) * 60 * cosLat + Math.sin(t) * run;
    const yNm = (a.lat - ap.lat) * 60 + Math.cos(t) * run;
    const rNm = Math.hypot(xNm, yNm);
    if (rNm > RANGE_NM + 1) continue;
    const alt = a.alt ? a.alt + (a.vr || 0) * dtH * 60 : 0;
    const tr = { ...a, alt, rNm, brg: (THREE.MathUtils.radToDeg(Math.atan2(xNm, yNm)) + 360) % 360 };
    tr.kind = trackKind(tr);
    shown.push(tr);
    const [px, py] = at(xNm, yNm);
    const col = RADAR[tr.kind];
    // history: a dot every few seconds of movement
    let hist = TRAFFIC.trails.get(a.id);
    if (!hist) TRAFFIC.trails.set(a.id, (hist = []));
    const last = hist[hist.length - 1];
    if (!last || Math.hypot(last[0] - xNm, last[1] - yNm) > 0.45) { hist.push([xNm, yNm]); if (hist.length > 7) hist.shift(); }
    hist.slice(0, -1).forEach(([hx, hy], i, arr) => {
      const [qx, qy] = at(hx, hy);
      g.fillStyle = col; g.globalAlpha = 0.15 + 0.5 * (i / arr.length);
      g.beginPath(); g.arc(qx, qy, 2.2, 0, Math.PI * 2); g.fill();
    });
    g.globalAlpha = 1;
    // speed vector: where it will be in one minute
    if (a.gs) {
      const vl = (a.gs / 60) * ppn;
      g.strokeStyle = col; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.sin(t) * vl, py - Math.cos(t) * vl); g.stroke();
    }
    // ADS-B position symbol
    g.strokeStyle = col; g.lineWidth = 2;
    g.beginPath(); g.moveTo(px, py - 6); g.lineTo(px + 6, py); g.lineTo(px, py + 6); g.lineTo(px - 6, py); g.closePath(); g.stroke();
    // leader line + three-line data block, flipped away from the edge of the scope
    const flip = px > cx + R * 0.45 ? -1 : 1, up = py < cy - R * 0.7 ? 1 : -1;
    const lx = px + flip * 30, ly = py + up * 26;
    g.lineWidth = 1; g.beginPath(); g.moveTo(px + flip * 7, py + up * 6); g.lineTo(lx, ly); g.stroke();
    const bx = flip > 0 ? lx + 4 : lx - 4;
    g.textAlign = flip > 0 ? 'left' : 'right';
    const by = up < 0 ? ly - 40 : ly + 6;
    g.fillStyle = col; g.font = mono(700, 21);
    g.fillText(a.cs || a.id, bx, by + 12);
    const fl = alt ? pad(Math.round(alt / 100), 3) : 'GND';
    const arrow = (a.vr ?? 0) > 250 ? '↑' : (a.vr ?? 0) < -250 ? '↓' : ' ';
    g.font = mono(600, 19); g.fillStyle = RADAR.text;
    g.fillText(`${fl}${arrow} ${a.gs ? pad(Math.round(a.gs / 10)) : '--'}`, bx, by + 35);
    g.fillStyle = 'rgba(223,233,236,0.6)';
    g.font = mono(500, 17);
    g.fillText(a.type || '', bx, by + 56);
  }
  g.restore();
  // airport reference point
  g.strokeStyle = '#00a2e5'; g.lineWidth = 2;
  g.beginPath(); g.arc(cx, cy, 5, 0, Math.PI * 2); g.stroke();

  // --- toolbar ---
  const live = TRAFFIC.live && TRAFFIC.data;
  g.fillStyle = '#121c20'; g.fillRect(0, 0, W, top);
  g.fillStyle = '#00a2e5'; g.fillRect(0, top - 2, W, 2);
  g.textAlign = 'left'; g.fillStyle = RADAR.text; g.font = mono(700, 26);
  g.fillText(`${ap.icao} APP`, 28, 42);
  g.fillStyle = 'rgba(223,233,236,0.6)'; g.font = mono(500, 18);
  g.fillText(`${ap.city.toUpperCase()}  ·  RNG ${RANGE_NM} NM  ·  VEC 1 MIN  ·  HIST 6`, 230, 41);
  const d = new Date();
  g.textAlign = 'center'; g.fillStyle = RADAR.text; g.font = mono(700, 28);
  g.fillText(`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`, cx + 180, 43);
  const status = live ? 'LIVE ADS-B' : TRAFFIC.data ? 'SIMULATED' : 'CONNECTING';
  g.textAlign = 'right'; g.font = mono(700, 20);
  g.fillStyle = live ? `rgba(110,230,150,${0.6 + 0.4 * Math.sin(now / 280)})` : '#ffd391';
  g.fillText(status, W - 28, 41);
  g.beginPath(); g.arc(W - 40 - g.measureText(status).width, 34, 6, 0, Math.PI * 2); g.fill();

  // --- strip bay: one electronic strip per track, arrivals first ---
  const sx = W - bayW;
  g.fillStyle = '#0f181c'; g.fillRect(sx, top, bayW, H - top);
  g.fillStyle = 'rgba(150,175,185,0.25)'; g.fillRect(sx, top, 2, H - top);
  const order = { arr: 0, dep: 1, ovf: 2, gnd: 3 };
  const strips = shown.sort((p, q) => order[p.kind] - order[q.kind] || p.rNm - q.rNm);
  g.textAlign = 'left'; g.fillStyle = 'rgba(223,233,236,0.6)'; g.font = mono(600, 17);
  const n = (k) => pad(strips.filter((s) => s.kind === k).length);
  g.fillText(`STRIPS ${pad(strips.length)}   ARR ${n('arr')}  DEP ${n('dep')}  OVF ${n('ovf')}`, sx + 24, top + 38);
  strips.slice(0, 11).forEach((s, i) => {
    const y = top + 62 + i * 78;
    g.fillStyle = '#16232a'; g.fillRect(sx + 18, y, bayW - 36, 68);
    g.fillStyle = RADAR[s.kind]; g.fillRect(sx + 18, y, 6, 68);
    g.fillStyle = RADAR.text; g.font = mono(700, 22); g.fillText(s.cs || s.id, sx + 38, y + 29);
    g.fillStyle = RADAR[s.kind]; g.font = mono(600, 15);
    g.fillText(s.kind.toUpperCase(), sx + 200, y + 28);
    g.textAlign = 'right'; g.fillStyle = 'rgba(223,233,236,0.7)'; g.font = mono(500, 17);
    g.fillText(s.type || '', sx + bayW - 32, y + 28);
    g.textAlign = 'left';
    const fl = s.alt ? `FL${pad(Math.round(s.alt / 100), 3)}` : 'GND';
    const arrow = (s.vr ?? 0) > 250 ? '↑' : (s.vr ?? 0) < -250 ? '↓' : ' ';
    g.fillStyle = 'rgba(223,233,236,0.85)'; g.font = mono(500, 17);
    g.fillText(`${fl}${arrow}  ${s.gs ? Math.round(s.gs) + 'KT' : '---'}  ${pad(Math.round(s.brg), 3)}°/${Math.round(s.rNm)}NM`, sx + 38, y + 55);
  });

  // --- footer: legend, scale bar, source, airspace tabs ---
  g.textAlign = 'left'; g.font = mono(500, 15);
  [['ARR', 'arr'], ['DEP', 'dep'], ['OVF', 'ovf'], ['GND', 'gnd']].forEach(([t, k], i) => {
    g.fillStyle = RADAR[k]; g.fillRect(28 + i * 82, H - 32, 12, 12);
    g.fillStyle = 'rgba(223,233,236,0.6)'; g.fillText(t, 46 + i * 82, H - 21);
  });
  g.strokeStyle = 'rgba(223,233,236,0.6)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(28, H - 52); g.lineTo(28 + 10 * ppn, H - 52); g.moveTo(28, H - 58); g.lineTo(28, H - 46); g.moveTo(28 + 10 * ppn, H - 58); g.lineTo(28 + 10 * ppn, H - 46); g.stroke();
  g.fillStyle = 'rgba(223,233,236,0.6)'; g.fillText('10 NM', 36 + 10 * ppn, H - 47);
  g.fillText(live ? 'ADS-B: adsb.lol (ODbL) · not for operational use' : TRAFFIC.data ? 'Simulated traffic · not real aircraft' : 'Connecting to the ADS-B feed…', sx - 470, H - 21);
  AIRSPACES.forEach((a, i) => {
    const x = sx + 24 + i * 156;
    g.fillStyle = i === TRAFFIC.idx ? '#00a2e5' : 'rgba(223,233,236,0.18)'; g.fillRect(x, H - 40, 140, 3);
    g.fillStyle = i === TRAFFIC.idx ? RADAR.text : 'rgba(223,233,236,0.5)'; g.font = mono(600, 16);
    g.fillText(`${a.code} ${a.icao}`, x, H - 14);
  });
  TRAFFIC.tex.needsUpdate = true;
}

/** Called each frame; only redraws while the lobby screen could be seen. */
function updateTraffic(now, visible) {
  if (!TRAFFIC.screen || !visible) return;
  if (!TRAFFIC.focus && now > TRAFFIC.cycleAt) cycleAirspace();
  if (!TRAFFIC.loading && now > TRAFFIC.fetchAt) { TRAFFIC.fetchAt = now + 12000; fetchTraffic(); }
  if (now > TRAFFIC.drawAt) { TRAFFIC.drawAt = now + (TRAFFIC.focus ? 100 : 250); drawTraffic(now); }
}

/* ---------- Rooms behind doors A and B ---------- */
const ROOM = { z0: -14.22, z1: -22.2, h: 3.6 };

function roomTextures() {
  const R = {};
  R.carpet = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#3a4156'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 30000, ['#444c63', '#30364a', '#4b536b'], 0.55, [1, 2.5]);
    g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, 0, w, 2); g.fillRect(0, 0, 2, h); // carpet-tile seams
  }, { repeat: [8 / 1, 8 / 1] });
  R.planks = canvasTex(1024, 1024, (g, w, h) => {
    const rows = 8, ph = h / rows;
    for (let r = 0; r < rows; r++) {
      let x = -((r * 397) % 600);
      while (x < w) {
        const len = 500 + rand() * 500, l = 44 + rand() * 9;
        g.fillStyle = `hsl(28 34% ${l}%)`; g.fillRect(x, r * ph, len, ph);
        g.globalAlpha = 0.12;
        for (let i = 0; i < 14; i++) {
          g.strokeStyle = rand() > 0.5 ? '#3a2412' : '#e2b98c'; g.lineWidth = 0.8 + rand() * 1.6;
          const y = r * ph + rand() * ph; g.beginPath(); g.moveTo(x, y); g.bezierCurveTo(x + len * 0.3, y + 4, x + len * 0.7, y - 4, x + len, y); g.stroke();
        }
        g.globalAlpha = 1;
        g.fillStyle = 'rgba(40,24,12,0.55)'; g.fillRect(x, r * ph, 2, ph);
        x += len;
      }
      g.fillStyle = 'rgba(40,24,12,0.5)'; g.fillRect(0, r * ph, w, 2);
    }
  });
  // Lesson slide on the classroom display
  R.slideA = canvasTex(1600, 800, (g, w, h) => {
    const bg = g.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#0f1b48'); bg.addColorStop(1, '#0a1336');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.fillStyle = '#4cc3f2'; g.font = FONT(600, 26, "'JetBrains Mono', monospace"); g.letterSpacing = '6px';
    g.fillText('ROOM A · CADET PREP', 90, 110);
    g.letterSpacing = '0px';
    g.fillStyle = '#f2f4f8'; g.font = FONT(500, 92, DISPLAY);
    g.fillText('Selection readiness', 90, 230);
    const cols = [['Aptitude', 'Reasoning, numerical', 'and verbal drills'], ['Interview', 'Mock panels with', 'structured feedback'], ['Group discussion', 'Practice rounds and', 'personal preparation']];
    cols.forEach(([t, a, b], i) => {
      const x = 90 + i * 480, y = 380;
      g.strokeStyle = 'rgba(242,244,248,0.18)'; g.lineWidth = 2; g.strokeRect(x, y, 430, 300);
      g.fillStyle = '#00a2e5'; g.fillRect(x, y, 430, 6);
      g.fillStyle = '#f2f4f8'; g.font = FONT(600, 44); g.fillText(t, x + 34, y + 96);
      g.fillStyle = 'rgba(242,244,248,0.72)'; g.font = FONT(500, 30);
      g.fillText(a, x + 34, y + 170); g.fillText(b, x + 34, y + 214);
      g.fillStyle = 'rgba(242,244,248,0.5)'; g.font = FONT(600, 26, "'JetBrains Mono', monospace");
      g.fillText(`0${i + 1}`, x + 34, y + 266);
    });
  });
  // Selection-stage timeline board for the classroom side wall
  R.stages = canvasTex(1400, 560, (g, w, h) => {
    g.fillStyle = '#f5f4f0'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#111c44'; g.font = FONT(500, 64, DISPLAY); g.fillText('The road to the right seat', 70, 120);
    const steps = ['Apply', 'Aptitude test', 'Interview', 'Medical', 'Training'];
    g.strokeStyle = '#111c44'; g.lineWidth = 4; g.beginPath(); g.moveTo(110, 300); g.lineTo(w - 110, 300); g.stroke();
    steps.forEach((t, i) => {
      const x = 110 + i * ((w - 220) / (steps.length - 1));
      g.fillStyle = i === 1 || i === 2 ? '#00a2e5' : '#111c44';
      g.beginPath(); g.arc(x, 300, 22, 0, 7); g.fill();
      g.fillStyle = '#111c44'; g.font = FONT(600, 36); g.textAlign = 'center'; g.fillText(t, x, 390);
      g.fillStyle = '#6a7088'; g.font = FONT(500, 26, "'JetBrains Mono', monospace"); g.fillText(`STAGE ${i + 1}`, x, 250);
      g.textAlign = 'left';
    });
  });
  // An aeronautical-chart style print
  R.chart = canvasTex(1000, 700, (g, w, h) => {
    g.fillStyle = '#e9e4d6'; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(17,28,68,0.12)'; g.lineWidth = 1;
    for (let x = 0; x < w; x += 50) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 0; y < h; y += 50) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    g.strokeStyle = 'rgba(120,150,110,0.5)'; g.lineWidth = 2;
    for (let k = 0; k < 9; k++) { g.beginPath(); let x = rand() * w, y = rand() * h; g.moveTo(x, y); for (let q = 0; q < 12; q++) { x += (rand() - 0.5) * 90; y += (rand() - 0.5) * 90; g.lineTo(x, y); } g.stroke(); }
    const vor = (x, y, r) => { g.strokeStyle = 'rgba(17,28,68,0.55)'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, r, 0, 7); g.stroke();
      for (let i = 0; i < 36; i++) { const a = (i / 36) * Math.PI * 2; g.beginPath(); g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r); g.lineTo(x + Math.cos(a) * (r - (i % 3 ? 6 : 14)), y + Math.sin(a) * (r - (i % 3 ? 6 : 14))); g.stroke(); } };
    vor(300, 280, 110); vor(720, 470, 90);
    g.strokeStyle = '#0a6fa0'; g.lineWidth = 3; g.setLineDash([16, 10]);
    g.beginPath(); g.moveTo(120, 600); g.lineTo(300, 280); g.lineTo(720, 470); g.lineTo(900, 120); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#c0392b'; g.beginPath(); g.arc(120, 600, 9, 0, 7); g.arc(900, 120, 9, 0, 7); g.fill();
  });
  // Small framed photographs: skies and runways at different times of day
  R.photo = (i) => canvasTex(300, 220, (g, w, h) => {
    const sets = [['#0b163a', '#e3a587'], ['#5d86b8', '#d9e6f2'], ['#1e2a57', '#a08aaa'], ['#203c66', '#f1c48f'], ['#3c5f8a', '#c9d8e6'], ['#141b33', '#7c7590']];
    const [a, b] = sets[i % sets.length];
    const sky = g.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, a); sky.addColorStop(1, b);
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(10,14,28,0.85)';
    if (i % 2) { g.beginPath(); g.moveTo(w * 0.45, h); g.lineTo(w * 0.55, h); g.lineTo(w * 0.51, h * 0.62); g.lineTo(w * 0.49, h * 0.62); g.fill(); g.fillRect(0, h * 0.8, w, h * 0.2); }
    else { // a small aircraft silhouette climbing out
      g.save(); g.translate(w * 0.55, h * 0.45); g.rotate(-0.25);
      g.fillRect(-40, -4, 80, 8); g.fillRect(-6, -30, 14, 60); g.fillRect(-40, -12, 8, 12); g.restore();
      g.fillRect(0, h * 0.86, w, h * 0.14);
    }
  });
  return R;
}

function buildRooms() {
  const R = roomTextures();
  const { z0, z1, h } = ROOM;
  const D = z0 - z1, cz = (z0 + z1) / 2;
  const carpet = new THREE.MeshStandardMaterial({ map: repeatOf(R.carpet, 8, 8), roughness: 1 });
  CARPET.push(carpet);
  const planks = new THREE.MeshStandardMaterial({ map: repeatOf(R.planks, 2.2, 2.2), roughness: 0.85 });
  const roomWall = new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 0.92 });

  for (const [id, x0, x1] of [['A', -8, -0.8], ['B', 0.8, 8]]) {
    const W = x1 - x0, cx = (x0 + x1) / 2;
    panel(W, D, id === 'A' ? carpet : planks, cx, 0.004, cz, 'up');
    panel(W, D, M.ceiling, cx, h, cz, 'down');
    panel(D, h, roomWall, x0 + 0.01, h / 2, cz, '+x');
    panel(D, h, roomWall, x1 - 0.01, h / 2, cz, '-x');
    panel(W, h, id === 'A' ? M.featureWall : roomWall, cx, h / 2, z1 + 0.01, '+z');
    holedWall(x0, x1, h, z0, '-z', DOOR_HOLES, roomWall);
    // skirting
    box(D, 0.09, 0.015, M.skirting, x0 + 0.02, 0.045, cz).rotation.y = Math.PI / 2;
    box(D, 0.09, 0.015, M.skirting, x1 - 0.02, 0.045, cz).rotation.y = Math.PI / 2;
    box(W, 0.09, 0.015, M.skirting, cx, 0.045, z1 + 0.02);
    // ceiling panels + one soft fill light
    for (const lx of [cx - 2, cx + 2]) for (const lz of [cz + 2, cz - 2]) {
      box(0.62, 0.02, 0.62, M.mullion, lx, h - 0.008, lz, scene, { cast: false, receive: false });
      box(0.58, 0.01, 0.58, M.lightPanel, lx, h - 0.02, lz, scene, { cast: false, receive: false });
    }
    const fill = new THREE.PointLight(0xfff0dc, 18, 14, 1.4);
    fill.position.set(cx, h - 0.4, cz + 0.5);
    scene.add(fill);
  }

  /* Room A: Cadet Prep classroom, desks facing a display on the navy end wall */
  const ax = -4.05;
  box(3.5, 1.78, 0.06, M.frameBlack, ax, 1.75, z1 + 0.05);
  panel(3.4, 1.7, new THREE.MeshStandardMaterial({ map: R.slideA, emissive: 0xffffff, emissiveMap: R.slideA, emissiveIntensity: 0.55, roughness: 0.8 }), ax, 1.75, z1 + 0.085, '+z');
  box(0.6, 0.04, 0.12, M.metalDark, ax, 0.82, z1 + 0.12); // soundbar
  // lectern
  box(0.62, 1.05, 0.46, M.wood, -6.6, 0.525, z1 + 1.2);
  box(0.66, 0.03, 0.52, M.woodDark, -6.6, 1.06, z1 + 1.2).rotation.x = 0.12;
  // student desks and chairs
  for (const dz of [z1 + 2.2, z1 + 3.7, z1 + 5.2]) {
    for (const dx of [-6.3, -4.05, -1.8]) {
      box(1.25, 0.035, 0.58, M.deskWhite, dx, 0.74, dz);
      for (const sx of [-1, 1]) box(0.04, 0.72, 0.5, M.metalDark, dx + sx * 0.58, 0.36, dz);
      box(1.15, 0.25, 0.02, M.metalDark, dx, 0.58, dz - 0.27);
      box(0.24, 0.012, 0.32, M.paper, dx - 0.25 + rand() * 0.1, 0.764, dz + 0.04).rotation.y = (rand() - 0.5) * 0.4;
      if (rand() > 0.4) box(0.008, 0.008, 0.14, M.metalDark, dx + 0.1, 0.764, dz + 0.05).rotation.y = rand();
      for (const cxo of [-0.3, 0.3]) studentChair(dx + cxo, dz + 0.52);
    }
  }
  // side walls: stage timeline on the partition, chart print on the outer wall
  box(0.04, 1.08, 2.62, M.frameBlack, -0.83, 1.7, cz);
  panel(2.56, 1.02, new THREE.MeshStandardMaterial({ map: R.stages, roughness: 0.85 }), -0.855, 1.7, cz, '-x');
  box(0.04, 1.32, 1.84, M.frameBlack, -7.97, 1.7, cz + 0.6);
  panel(1.76, 1.24, new THREE.MeshStandardMaterial({ map: R.chart, roughness: 0.7 }), -7.945, 1.7, cz + 0.6, '+x');
  plant(-7.4, z1 + 0.6, { height: 1.6, spread: 0.5, leaves: 80, light: true });
  plant(-7.4, z0 - 0.6, { height: 1.2, spread: 0.4, leaves: 60 });

  /* Room B: 1-on-1 Mentorship, a warm study with a mentor desk */
  const bx = 4.6, bz = z1 + 2.4;
  // oak slat feature on the end wall with the runway print
  for (let i = 0; i < 26; i++) box(0.05, h, 0.05, M.wood, bx - 1.5 + i * 0.12, h / 2, z1 + 0.04);
  box(1.92, 1.12, 0.04, M.frameBlack, bx, 1.85, z1 + 0.1);
  panel(1.8, 1.04, M.poster, bx, 1.85, z1 + 0.125, '+z');
  // desk
  box(1.7, 0.05, 0.82, M.wood, bx, 0.75, bz);
  box(1.6, 0.6, 0.03, M.woodDark, bx, 0.43, bz - 0.36);
  for (const sx of [-1, 1]) box(0.05, 0.73, 0.76, M.wood, bx + sx * 0.8, 0.365, bz);
  // laptop, notebook, mug, lamp, and a small airliner model on the desk
  box(0.34, 0.015, 0.24, M.metal, bx - 0.25, 0.783, bz - 0.05);
  const lid = box(0.34, 0.23, 0.012, M.metal, bx - 0.25, 0.89, bz - 0.17);
  lid.rotation.x = -0.25;
  box(0.32, 0.21, 0.002, M.screen, bx - 0.25, 0.89, bz - 0.163, scene, { cast: false }).rotation.x = -0.25;
  box(0.22, 0.012, 0.3, M.paper, bx + 0.25, 0.782, bz + 0.12).rotation.y = 0.25;
  cyl(0.04, 0.035, 0.09, M.ceramic, bx + 0.55, 0.82, bz - 0.1, scene, 20);
  cyl(0.07, 0.08, 0.02, M.metalDark, bx + 0.65, 0.785, bz - 0.25, scene, 20);
  const arm = cyl(0.008, 0.008, 0.42, M.metalDark, bx + 0.62, 0.98, bz - 0.25, scene, 8); arm.rotation.z = 0.25;
  cyl(0.03, 0.08, 0.1, M.metalDark, bx + 0.5, 1.15, bz - 0.25, scene, 20);
  // a turbofan display on a plinth: the glTF engine arrives later (loadDeskEngine), the plaque says what it does
  DESK_ENGINE.pos.set(bx - 0.45, 0.775 + 0.045, bz - 0.12);
  rbox(0.56, 0.045, 0.26, 0.012, M.frameBlack, DESK_ENGINE.pos.x, 0.775 + 0.0225, DESK_ENGINE.pos.z);
  const plaque = canvasTex(512, 96, (g, w, h) => {
    g.fillStyle = '#c9a45c'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#1d1f24'; g.font = FONT(700, 34); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.letterSpacing = '4px';
    g.fillText('CFM56-5B · TAKE IT APART', w / 2 + 2, h / 2 + 2);
  });
  panel(0.3, 0.056, new THREE.MeshStandardMaterial({ map: plaque, roughness: 0.4, metalness: 0.6 }), DESK_ENGINE.pos.x, 0.775 + 0.0225, DESK_ENGINE.pos.z + 0.1305, '+z');
  // mentor's chair behind the desk, student's armchair in front
  const mc = officeChair(); mc.position.set(bx, 0, bz - 0.85);
  const guest = sofa(0.82, { seats: 1 }); guest.position.set(bx + 0.1, 0, bz + 1.0); guest.rotation.y = Math.PI + 0.15;
  // rug + lounge corner by the partition
  panel(3.0, 2.2, M.rug, bx, 0.012, bz + 0.6, 'up');
  // bookshelf on the outer wall and a wall of framed photographs on the partition
  bookshelf(8, cz + 1.2, -1, { bw: 2.2, bh: 2.0 });
  for (let i = 0; i < 6; i++) {
    const col = i % 3, row = (i / 3) | 0, pz = cz + 1.3 - col * 0.62, py = 1.55 + row * 0.5;
    box(0.025, 0.4, 0.52, M.frameBlack, 0.82, py, pz);
    panel(0.46, 0.34, new THREE.MeshStandardMaterial({ map: R.photo(i), roughness: 0.85 }), 0.837, py, pz, '+x');
  }
  // pendant over the desk, plants in the corners
  pendant(bx, bz, 2.3);
  plant(7.4, z1 + 0.6, { height: 1.7, spread: 0.5, leaves: 85, light: true });
  plant(1.45, z1 + 0.6, { height: 1.3, spread: 0.45, leaves: 60 });
  const warm = new THREE.PointLight(0xffd8a8, 5, 6, 1.6);
  warm.position.set(bx, 2.1, bz);
  scene.add(warm);
}

/** Classroom chair facing -z (toward the front of the room). */
function studentChair(x, z) {
  if (FURN.student_chair) return placeFurn('student_chair', x, 0, z, Math.PI + (rand() - 0.5) * 0.25);
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = Math.PI + (rand() - 0.5) * 0.25;
  scene.add(g);
  rbox(0.42, 0.04, 0.42, 0.02, M.fabric, 0, 0.46, 0, g);
  const back = rbox(0.42, 0.32, 0.03, 0.015, M.fabric, 0, 0.72, -0.2, g);
  back.rotation.x = -0.08;
  for (const sx of [-1, 1]) {
    box(0.02, 0.46, 0.02, M.metalDark, sx * 0.19, 0.23, 0.17, g);
    box(0.02, 0.86, 0.02, M.metalDark, sx * 0.19, 0.43, -0.19, g);
  }
}

/* ---------- Door C, the corridor and the airside ---------- */
// The airside opens behind the building (z < -23), facing west into the sunset. The runway runs
// east-west 300 m out; four airliners fly one loop (land, taxi, line up, take off) at staggered times.
const AIRSIDE = { root: null, movers: [], blinkers: [], vehicles: [], backLeaves: [], rabbit: null, route: null, active: false, placeholders: { trainers: [], jets: [], tower: null, gse: [] } };
const RWY_Z = -322, TWY_Z = -135, RWY_THR = 760, RWY_END = -1700;
let GLOW = null, RUNWAY_MAT = null;

function glowPoints(positions, color, size, parent) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions.flat(), 3));
  const mat = new THREE.PointsMaterial({ color, size, map: GLOW, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const pts = new THREE.Points(geo, mat);
  pts.userData.keep = true;
  (parent || AIRSIDE.root).add(pts);
  return pts;
}

/** Merge a freshly built group's meshes by material (keeps meshes flagged userData.keep). */
function bakeGroup(g) {
  g.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(g.matrixWorld).invert();
  const buckets = new Map(), done = [];
  g.traverse((o) => {
    if (!o.isMesh || o.userData.keep || Array.isArray(o.material)) return;
    const src = o.geometry.clone();
    for (const k of Object.keys(src.attributes)) if (!['position', 'normal', 'uv'].includes(k)) src.deleteAttribute(k);
    floatGeometry(src);
    const geo = src.index ? src.toNonIndexed() : src;
    for (const k of Object.keys(geo.attributes)) {
      if (!['position', 'normal', 'uv'].includes(k)) { geo.deleteAttribute(k); continue; }
      // glTF models arrive quantized (normalized int16 / int8, often interleaved): unpack to floats
      // first, or transforming them would clamp positions to the [-1, 1] range
      const a = geo.attributes[k];
      if (a.isInterleavedBufferAttribute || !(a.array instanceof Float32Array) || a.normalized) geo.setAttribute(k, floatAttr(a));
    }
    geo.clearGroups();
    geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    const key = o.material.uuid + '|' + Object.keys(geo.attributes).sort().join();
    if (!buckets.has(key)) buckets.set(key, { mat: o.material, geos: [] });
    buckets.get(key).geos.push(geo);
    done.push(o);
  });
  done.forEach((o) => o.removeFromParent());
  for (const { mat, geos } of buckets.values()) g.add(new THREE.Mesh(mergeGeometries(geos), mat));
  return g;
}

function blinker(mesh, period, phase = 0, duty = 0.12) {
  mesh.userData.keep = true;
  AIRSIDE.blinkers.push({ mesh, period, phase, duty });
  return mesh;
}

/* Door C: glass double door in the middle of the back wall */
function buildDoorC() {
  const zw = LOBBY.z1, dh = 2.42, hw = 0.62;
  box(2 * hw + 0.16, 0.08, 0.12, M.frameBlack, 0, dh + 0.04, zw + 0.05);
  for (const s of [-1, 1]) {
    box(0.08, dh + 0.08, 0.12, M.frameBlack, s * (hw + 0.04), (dh + 0.08) / 2, zw + 0.05);
    box(0.03, dh, 0.24, M.frameBlack, s * (hw + 0.005), dh / 2, zw - 0.1, scene, { cast: false });
  }
  box(2 * hw + 0.04, 0.03, 0.24, M.frameBlack, 0, dh + 0.005, zw - 0.1, scene, { cast: false });
  const frost = (txt) => canvasTex(512, 256, (g, w, h) => {
    g.fillStyle = 'rgba(236,240,244,0.92)'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#00a2e5'; g.fillRect(0, h - 10, w, 10);
    g.fillStyle = '#111c44'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = txt.length === 1 ? FONT(500, 170, DISPLAY) : FONT(700, 64);
    if (txt.length > 1) g.letterSpacing = '10px';
    g.fillText(txt, w / 2 + (txt.length > 1 ? 5 : 0), h / 2 + 4);
  });
  const bandMat = (txt) => {
    const t = frost(txt);
    return new THREE.MeshStandardMaterial({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0, roughness: 0.9, transparent: true });
  };
  const bands = [bandMat('C'), bandMat('AIRSIDE')];
  const pivots = [];
  [-1, 1].forEach((s, i) => {
    const pv = new THREE.Group();
    pv.position.set(s * hw, 0, zw + 0.05);
    pv.userData.dynamic = true;
    scene.add(pv);
    const lw = hw - 0.005, cx = -s * lw / 2;
    panel(lw - 0.08, dh - 0.12, M.glass, cx, dh / 2, 0, '+z', pv, { cast: false, receive: false });
    for (const e of [-1, 1]) box(0.05, dh, 0.05, M.metalDark, cx + e * (lw / 2 - 0.025), dh / 2, 0, pv);
    box(lw, 0.06, 0.05, M.metalDark, cx, 0.03, 0, pv);
    box(lw, 0.06, 0.05, M.metalDark, cx, dh - 0.03, 0, pv);
    const band = panel(lw - 0.1, (lw - 0.1) / 2, bands[i], cx, 1.5, 0.006, '+z', pv, { cast: false, receive: false });
    const back = band.clone(); back.rotation.y = Math.PI; back.position.z = -0.006; pv.add(back);
    for (const f of [1, -1]) cyl(0.014, 0.014, 0.9, M.metal, -s * (lw - 0.1), 1.05, f * 0.06, pv, 10);
    pivots.push(pv);
  });
  const hit = panel(2 * hw, dh, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }), 0, dh / 2, zw + 0.12, '+z', scene, { cast: false, receive: false });
  hit.userData.dynamic = true;
  hit.userData.room = 'C';
  // sign above the frame
  box(1.1, 0.236, 0.02, M.frameBlack, 0, 2.72, zw + 0.03);
  panel(1.08, 1.08 * (220 / 1024), new THREE.MeshStandardMaterial({ map: T.plaque('C', 'Airside'), roughness: 0.85 }), 0, 2.72, zw + 0.041, '+z');
  // the hover glow drives both bands
  const leafMat = { set emissiveIntensity(v) { bands.forEach((b) => { b.emissiveIntensity = v; }); } };
  DOORS.C = { pivot: pivots[0], pivot2: pivots[1], leaf: hit, leafMat, sign: 1, open: 0, hover: 0 };
}

/* Corridor from door C to the back of the building, ending in sliding doors */
function buildCorridor() {
  const z0 = LOBBY.z1 - 0.02, z1 = -23.0, h = 2.95, cz = (z0 + z1) / 2, D = z0 - z1;
  const floor = new THREE.MeshStandardMaterial({ map: repeatOf(M.floor.map, 1.6 / 2.4, D / 2.4), roughness: 0.82 });
  panel(1.6, D, floor, 0, 0.004, cz, 'up');
  panel(1.6, D, M.ceiling, 0, h, cz, 'down');
  panel(D, h, M.wall, -0.79, h / 2, cz, '+x');
  panel(D, h, M.wall, 0.79, h / 2, cz, '-x');
  box(0.14, 0.02, D - 0.6, M.lightPanel, 0, h - 0.012, cz, scene, { cast: false, receive: false });
  for (const s of [-1, 1]) box(0.015, 0.09, D, M.skirting, s * 0.78, 0.045, cz);
  // a strip of cyan inlay that carries the taxiway line on toward the airside
  for (let z = z0 - 0.6; z > z1 + 0.6; z -= 1.3) box(0.035, 0.003, 0.8, M.inlay, 0, 0.0055, z - 0.4, scene, { cast: false });
  const lamp = new THREE.PointLight(0xfff0dc, 6, 9, 1.5);
  lamp.position.set(0, h - 0.3, cz);
  scene.add(lamp);
  // sliding exit doors in the back facade
  box(1.7, 0.1, 0.2, M.mullion, 0, 2.98, z1 + 0.05);
  for (const s of [-1, 1]) {
    const g = new THREE.Group();
    g.userData.dynamic = true;
    g.userData.closedX = s * 0.4;
    g.position.set(s * 0.4, 0, z1 + 0.12);
    scene.add(g);
    panel(0.76, 2.86, M.glass, 0, 1.45, 0, '-z', g, { cast: false, receive: false });
    box(0.8, 0.05, 0.04, M.mullion, 0, 0.03, 0, g);
    box(0.8, 0.05, 0.04, M.mullion, 0, 2.88, 0, g);
    for (const e of [-1, 1]) box(0.04, 2.9, 0.04, M.mullion, e * 0.38, 1.45, 0, g);
    AIRSIDE.backLeaves.push(g);
  }
  // canopy and light over the exit, outside
  box(3.2, 0.16, 2.2, M.claddingDeep, 0, 3.12, z1 - 1.1);
  cyl(0.1, 0.1, 0.02, M.lightWarm, 0, 3.03, z1 - 1.2, scene, 20, { cast: false, receive: false });
}

/* Simple vehicle and aircraft models, built nose toward +x */
function trainer(stripe) {
  const g = new THREE.Group();
  const L = 7.6;
  const prof = [[0, 0], [0.12, 0.05], [0.26, 1.2], [0.42, 3.0], [0.6, 4.5], [0.62, 5.6], [0.56, 6.6], [0.42, 7.2], [0.2, 7.55], [0, 7.6]].map(([r, y]) => new THREE.Vector2(r, y));
  const f = mesh(new THREE.LatheGeometry(prof, 24), M.paint, -L / 2, 1.25, 0, g);
  f.rotation.z = -Math.PI / 2;
  box(1.75, 0.55, 1.16, M.darkGlass, 0.75, 1.82, 0, g);
  box(1.9, 0.12, 1.1, M.paint, 0.7, 2.13, 0, g);
  box(1.55, 0.12, 11, M.paint, 0.8, 2.28, 0, g);
  for (const s of [-1, 1]) {
    box(0.4, 0.125, 0.5, stripe, 0.8, 2.28, s * 5.3, g);
    // wing strut from the lower fuselage out to the wing
    const st = box(0.07, Math.hypot(1.25, 2.05), 0.12, M.paint, 0.75, 1.62, s * 1.58, g);
    st.rotation.x = s * Math.atan2(2.05, 1.25);
    // main gear
    const leg = box(0.1, 0.9, 0.12, M.paint, 0.2, 0.62, s * 0.85, g);
    leg.rotation.x = s * 0.6;
    const wheel = cyl(0.25, 0.25, 0.14, M.leather, 0.2, 0.25, s * 1.15, g, 16);
    wheel.rotation.x = Math.PI / 2;
  }
  box(5.6, 0.14, 1.26, stripe, 0.2, 1.16, 0, g);
  box(5.6, 0.05, 1.27, M.paintCyan, 0.2, 1.03, 0, g);
  box(0.9, 0.08, 3.4, M.paint, -3.25, 1.42, 0, g);
  const finShape = new THREE.Shape([[-2.5, 1.45], [-3.5, 2.85], [-3.95, 2.85], [-3.85, 1.4]].map(([a, b]) => new THREE.Vector2(a, b)));
  const fin = new THREE.Mesh(new THREE.ExtrudeGeometry(finShape, { depth: 0.08, bevelEnabled: false }), stripe);
  fin.geometry.translate(0, 0, -0.04);
  add(fin, g);
  const spinner = mesh(new THREE.ConeGeometry(0.17, 0.35, 16), M.paint, L / 2 + 0.12, 1.25, 0, g);
  spinner.rotation.z = -Math.PI / 2;
  box(0.05, 1.85, 0.13, M.metalDark, L / 2 + 0.02, 1.25, 0, g).rotation.x = 0.4;
  cyl(0.03, 0.03, 0.9, M.metal, 2.9, 0.65, 0, g, 8);
  const nw = cyl(0.19, 0.19, 0.12, M.leather, 2.9, 0.19, 0, g, 16);
  nw.rotation.x = Math.PI / 2;
  return g;
}

function followMeCar() {
  const g = new THREE.Group();
  const yellow = new THREE.MeshStandardMaterial({ color: 0xe0b52a, roughness: 0.7 });
  box(4.4, 0.8, 1.8, yellow, 0, 0.75, 0, g);
  box(2.2, 0.6, 1.62, M.darkGlass, -0.2, 1.42, 0, g);
  box(2.0, 0.08, 1.64, yellow, -0.2, 1.76, 0, g);
  const sign = canvasTex(512, 128, (c, w, h) => {
    c.fillStyle = '#111111'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#ffd23a'; c.font = FONT(700, 72); c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('FOLLOW ME', w / 2, h / 2 + 4);
  });
  const sm = new THREE.MeshBasicMaterial({ map: sign });
  const board = box(0.1, 0.42, 1.5, [M.frameBlack, M.frameBlack, M.frameBlack, M.frameBlack, sm, sm], -0.2, 2.05, 0, g);
  board.rotation.y = Math.PI / 2;
  board.userData.keep = true;
  for (const sx of [-1.4, 1.4]) for (const sz of [-0.9, 0.9]) cyl(0.34, 0.34, 0.24, M.leather, sx, 0.34, sz, g, 14).rotation.x = Math.PI / 2;
  const amber = new THREE.MeshBasicMaterial({ color: 0xffa21a });
  for (const sz of [-0.55, 0.55]) blinker(mesh(new THREE.SphereGeometry(0.11, 10, 8), amber, -0.2, 2.34, sz, g), 0.8, sz > 0 ? 0.5 : 0, 0.4);
  blinker(glowPoints([[-0.2, 2.34, 0]], 0xffa21a, 2.2, g), 0.8, 0, 0.4);
  return g;
}

function tugTrain() {
  const parts = [];
  const tug = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xe8e6e1, roughness: 0.75 });
  const orange = new THREE.MeshStandardMaterial({ color: 0xd8742a, roughness: 0.75 });
  box(2.6, 0.9, 1.5, white, 0, 0.75, 0, tug);
  box(2.62, 0.18, 1.52, orange, 0, 0.5, 0, tug);
  box(1.0, 1.0, 1.4, M.darkGlass, -0.6, 1.65, 0, tug);
  for (const sx of [-0.9, 0.9]) for (const sz of [-0.7, 0.7]) cyl(0.3, 0.3, 0.2, M.leather, sx, 0.3, sz, tug, 12).rotation.x = Math.PI / 2;
  blinker(mesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffa21a }), -0.6, 2.22, 0, tug), 0.9, 0, 0.4);
  parts.push(tug);
  const bagCols = [0x2a3354, 0x6d2f2f, 0x1f4a3a, 0x3d3f4a, 0x8a6d3b, 0x111111];
  for (let i = 0; i < 3; i++) {
    const cart = new THREE.Group();
    box(2.8, 0.12, 1.5, M.metalDark, 0, 0.55, 0, cart);
    for (const sx of [-1.35, 1.35]) box(0.06, 1.1, 1.5, M.metalDark, sx, 1.1, 0, cart);
    box(2.8, 0.06, 1.5, M.metalDark, 0, 1.65, 0, cart);
    for (let b = 0; b < 6; b++) box(0.5 + rand() * 0.3, 0.3 + rand() * 0.3, 0.5, new THREE.MeshStandardMaterial({ color: bagCols[(rand() * bagCols.length) | 0], roughness: 0.9 }), -1 + (b % 3) * 0.95, 0.8 + ((b / 3) | 0) * 0.42, (rand() - 0.5) * 0.6, cart);
    for (const sx of [-1, 1]) for (const sz of [-0.6, 0.6]) cyl(0.2, 0.2, 0.15, M.leather, sx, 0.2, sz, cart, 10).rotation.x = Math.PI / 2;
    parts.push(cart);
  }
  return parts;
}

function fuelTruck() {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xe8e6e1, roughness: 0.75 });
  box(2.2, 2.2, 2.4, white, 3.6, 1.6, 0, g);
  box(1.4, 0.8, 2.2, M.darkGlass, 4.0, 2.2, 0, g);
  const tank = cyl(1.15, 1.15, 6.6, white, -0.9, 1.9, 0, g, 24);
  tank.rotation.z = Math.PI / 2;
  box(6.4, 0.25, 2.34, new THREE.MeshStandardMaterial({ color: 0x1f6f8a, roughness: 0.8 }), -0.9, 1.4, 0, g);
  for (const sx of [-3.2, -1.6, 3.6]) for (const sz of [-1.05, 1.05]) cyl(0.5, 0.5, 0.3, M.leather, sx, 0.5, sz, g, 14).rotation.x = Math.PI / 2;
  return g;
}

/* ---------- Camera finish, live sun shadows, haze: what makes it read as a photograph ---------- */
// Each extra can be dropped on its own; QUALITY steps them down if a device can't keep up outdoors.
const QUALITY = { ao: true, shadows: true, bloom: true };
{ // contact shadows (GTAO) are the costliest extra: integrated and mobile GPUs start without them
  const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
  if (/Intel|UHD|Iris|Mali|Adreno|PowerVR|SwiftShader/i.test(gpu)) QUALITY.ao = false;
}
let FX = null, SUN = null;
/** fog that is warmer looking toward the low sun and cooler away from it, slightly denser near the ground */
function patchFog() {
  const v = SUN_VEC.clone().normalize(), sd = `vec3(${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)})`;
  THREE.ShaderChunk.fog_pars_vertex += '\n#ifdef USE_FOG\nvarying vec3 vFogDir;\n#endif\n';
  THREE.ShaderChunk.fog_vertex += '\n#ifdef USE_FOG\nvFogDir = transpose(mat3(viewMatrix)) * mvPosition.xyz;\n#endif\n';
  THREE.ShaderChunk.fog_pars_fragment += '\n#ifdef USE_FOG\nvarying vec3 vFogDir;\n#endif\n';
  THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    vec3 fd = normalize( vFogDir );
    float toSun = pow( max( dot( fd, ${sd} ), 0.0 ), 5.0 );
    vec3 haze = fogColor * mix( vec3( 0.93, 0.95, 1.05 ), vec3( 1.22, 1.04, 0.86 ), toSun );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, haze, fogFactor * mix( 1.0, 0.86, smoothstep( 0.0, 0.3, fd.y ) ) );
  #endif`;
}
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uShimmer: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime, uShimmer; varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      vec3 c = texture2D(tDiffuse, uv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(c, c * vec3(1.035, 0.995, 0.955), smoothstep(0.45, 1.0, l)); // warm highlights
      c += vec3(0.010, 0.004, 0.018) * (1.0 - l);                          // mauve in the shadows
      c = mix(vec3(l), c, 1.07);                                           // a touch more colour
      float vig = smoothstep(1.1, 0.32, length((vUv - 0.5) * vec2(1.15, 1.0)));
      c *= mix(0.8, 1.0, vig);
      c += (hash(vUv * 1024.0 + fract(uTime) * 61.0) - 0.5) * 0.022;     // film grain
      gl_FragColor = vec4(c, 1.0);
    }`,
};
function setupFX() {
  const w = innerWidth, h = innerHeight;
  const rt = new THREE.WebGLRenderTarget(w * pixelRatio, h * pixelRatio, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(w, h);
  composer.addPass(new RenderPass(scene, camera));
  const gtao = new GTAOPass(scene, camera, w, h);
  gtao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 12 });
  gtao.blendIntensity = 0.85;
  composer.addPass(gtao);
  gtao.setSize(w * pixelRatio * 0.5, h * pixelRatio * 0.5); // half resolution (after addPass, which sizes it full)
  const bloom = new UnrealBloomPass(new THREE.Vector2(w / 2, h / 2), 0.2, 0.5, 1.15); // only real light sources glow
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  FX = { composer, gtao, bloom, grade };
}
const SHADOW_HOME = { target: new THREE.Vector3(0, 0, 4), cam: { left: -26, right: 26, top: 14, bottom: -14, near: 10, far: 90 } };
const _fwd = new THREE.Vector3();
/** outdoors the sun's shadow map follows the camera, so aircraft, trucks, crew and trees cast long evening shadows */
function updateSunShadow(outdoors) {
  if (!SUN) return;
  const c = SUN.shadow.camera;
  if (QUALITY.shadows && outdoors > 0.5) {
    camera.getWorldDirection(_fwd); _fwd.y = 0; _fwd.normalize();
    const fx = Math.round((camera.position.x + _fwd.x * 50) / 4) * 4, fz = Math.round((camera.position.z + _fwd.z * 50) / 4) * 4;
    SUN.target.position.set(fx, 0, fz);
    SUN.position.copy(SUN_VEC).multiplyScalar(260).add(SUN.target.position);
    SUN.target.updateMatrixWorld();
    if (!SUN.userData.wide) {
      Object.assign(c, { left: -80, right: 80, top: 80, bottom: -80, near: 1, far: 640 }); c.updateProjectionMatrix();
      SUN.shadow.normalBias = 0.06;
      SUN.userData.wide = true;
      renderer.shadowMap.autoUpdate = true;
    }
  } else if (SUN.userData.wide) {
    SUN.target.position.copy(SHADOW_HOME.target);
    SUN.position.copy(SUN_VEC).multiplyScalar(48).add(SUN.target.position);
    SUN.target.updateMatrixWorld();
    Object.assign(c, SHADOW_HOME.cam); c.updateProjectionMatrix();
    SUN.shadow.normalBias = 0.03;
    SUN.userData.wide = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
  }
}
/** let the models that arrive after load cast and take shadows (flat things and the vegetation carpets don't) */
let castersAt = 0;
const _box = new THREE.Box3();
function refreshCasters(now) {
  if (now < castersAt) return;
  castersAt = now + 2500;
  scene.traverse((o) => {
    if (!o.isMesh || o.userData.castDone || !o.visible && !o.parent) return;
    for (let a = o; a; a = a.parent) if (a.userData.noCast) return;
    o.userData.castDone = true;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    _box.copy(o.geometry.boundingBox);
    const sc = o.getWorldScale(_fwd), hgt = (_box.max.y - _box.min.y) * sc.y, wid = Math.max(_box.max.x - _box.min.x, _box.max.z - _box.min.z) * Math.max(sc.x, sc.z);
    if (o.isInstancedMesh && wid < 5 && !o.userData.tree) return; // small instanced plants
    if (hgt > 0.35 && wid < 900) { o.castShadow = true; o.receiveShadow = true; }
  });
}
let qT = 16, qN = 0;
function renderFrame(now, dt, outdoors, airside) {
  if (!FX) { renderer.render(scene, camera); return; }
  if (outdoors > 0.5 && document.visibilityState === 'visible') {
    // adaptive: if the outdoor views run slow, shed the costliest extra first
    qT = qT * 0.96 + Math.min(dt, 120) * 0.04;
    if (++qN > 150 && qT > 34) {
      if (QUALITY.ao) QUALITY.ao = false; else if (QUALITY.shadows) QUALITY.shadows = false; else if (QUALITY.bloom) QUALITY.bloom = false;
      qN = 0; qT = 20;
    }
    refreshCasters(now);
  }
  FX.gtao.enabled = QUALITY.ao && outdoors > 0.5;
  FX.bloom.enabled = QUALITY.bloom;
  FX.grade.uniforms.uTime.value = (now / 1000) % 1000;
  FX.grade.uniforms.uShimmer.value = airside;
  updateSunShadow(outdoors);
  FX.composer.render();
}

/* ---------- Wear: oil, rubber, the marks a working stand collects ---------- */
let WEAR = null;
function wearMats() {
  if (WEAR) return WEAR;
  const rnd = mulberry32(31);
  const oil = canvasTex(256, 256, (g, w, h) => {
    for (let i = 0; i < 26; i++) {
      const x = w / 2 + (rnd() - 0.5) * w * 0.5, y = h / 2 + (rnd() - 0.5) * h * 0.5, r = 12 + rnd() * 55;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(18,16,14,${0.35 + rnd() * 0.35})`); gr.addColorStop(1, 'rgba(18,16,14,0)');
      g.fillStyle = gr; g.beginPath(); g.ellipse(x, y, r, r * (0.6 + rnd() * 0.5), rnd() * 3, 0, Math.PI * 2); g.fill();
    }
  });
  const streak = canvasTex(64, 512, (g, w, h) => {
    for (let i = 0; i < 40; i++) {
      const x = w * 0.15 + rnd() * w * 0.7, a = 0.05 + rnd() * 0.12;
      g.fillStyle = `rgba(20,19,18,${a})`; g.fillRect(x, 0, 1 + rnd() * 3, h);
    }
    for (let i = 0; i < 30; i++) { g.fillStyle = `rgba(20,19,18,${0.05 + rnd() * 0.1})`; g.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 10, 6 + rnd() * 50); }
  });
  streak.wrapS = streak.wrapT = THREE.RepeatWrapping;
  const mk = (map, op) => new THREE.MeshStandardMaterial({ map, transparent: true, opacity: op, depthWrite: false, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -3 });
  WEAR = { oil: mk(oil, 0.9), streak: mk(streak, 0.75), streakTex: streak };
  return WEAR;
}
const decal = (w, d, mat, x, z, parent, rotZ = 0) => {
  const m = panel(w, d, mat, x, 0.06, z, 'up', parent, { cast: false, receive: false });
  m.rotation.z = rotZ; m.renderOrder = 1;
  return m;
};
const CREW = {};
function crewMats() {
  if (CREW.vest) return CREW;
  const std = (c, r = 0.8) => new THREE.MeshStandardMaterial({ color: c, roughness: r });
  Object.assign(CREW, { vest: std(0xff8a1c, 0.6), vestY: std(0xd8e636, 0.6), pants: std(0x232a3a), skin: std(0x8a5a3c), helmet: std(0xf2f2ee, 0.5), stripe: std(0xdfe3e6, 0.3) });
  return CREW;
}
/** a ground-crew figure, 1.75 m: hi-vis vest, reflective band, helmet */
function crewman(yellow = false, wands = false) {
  const C = crewMats(), g = new THREE.Group(), vest = yellow ? C.vestY : C.vest;
  for (const sx of [-0.1, 0.1]) box(0.15, 0.84, 0.17, C.pants, sx, 0.42, 0, g);
  box(0.42, 0.6, 0.24, vest, 0, 1.15, 0, g);
  box(0.43, 0.05, 0.25, C.stripe, 0, 1.0, 0, g);
  for (const sx of [-0.28, 0.28]) box(0.1, 0.56, 0.11, vest, sx, 1.13, 0, g);
  mesh(new THREE.SphereGeometry(0.11, 10, 8), C.skin, 0, 1.58, 0, g);
  mesh(new THREE.SphereGeometry(0.125, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), C.helmet, 0, 1.62, 0, g);
  if (wands) for (const sx of [-0.4, 0.4]) { const w = box(0.04, 0.4, 0.04, new THREE.MeshBasicMaterial({ color: 0xff5a1a }), sx, 1.55, 0.05, g); w.rotation.z = sx * 0.8; }
  return g;
}
/** oil under the engines and gear, tyre tracks into the stand, and the crew working the turnaround */
function wearAndCrew(x, zc, dir, parent, { crew = 5 } = {}) {
  const W = wearMats(), nose = zc + dir * 18.8, left = dir;
  for (const s of [-1, 1]) decal(4.5, 4.5, W.oil, x + s * 5.8, zc + dir * 4.5, parent, s);
  decal(3, 2.6, W.oil, x, nose - dir * 5.2, parent, 0.7);
  decal(2.5, 2.5, W.oil, x, zc - dir * 16, parent, 2);
  for (const sx of [-3.8, 3.8]) decal(1.3, 46, W.streak, x + sx, zc - dir * 22, parent);
  decal(0.9, 44, W.streak, x, nose - dir * 27, parent);
  const spots = [[x, nose + dir * 9, dir > 0 ? Math.PI : 0, true], [x - left * 4.4, nose - dir * 10, 0, false],
    [x + left * 9.5, nose - dir * 3.5, Math.PI / 2, false], [x - left * 5.6, nose - dir * 1.2, -Math.PI / 2, false], [x + left * 19, zc, 0, false]];
  spots.slice(0, crew).forEach(([px, pz, yaw, wands], i) => {
    const c = crewman(i % 2 === 1, wands);
    c.position.set(px, 0, pz); c.rotation.y = yaw + (i ? (mulberry32(i * 7 + x)() - 0.5) : 0);
    parent.add(c);
  });
}
function van() {
  const g = new THREE.Group(), white = new THREE.MeshStandardMaterial({ color: 0xeceae6, roughness: 0.6 });
  box(5.2, 2.3, 2.0, white, 0, 1.45, 0, g);
  box(1.2, 1.0, 1.96, M.darkGlass, 2.2, 1.9, 0, g);
  box(5.22, 0.3, 2.02, new THREE.MeshStandardMaterial({ color: 0xff8a1c, roughness: 0.6 }), 0, 1.0, 0, g);
  for (const sx of [-1.7, 1.7]) for (const sz of [-0.95, 0.95]) cyl(0.36, 0.36, 0.25, M.leather, sx, 0.36, sz, g, 12).rotation.x = Math.PI / 2;
  blinker(mesh(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffa21a }), 1.6, 2.68, 0, g), 0.8, 0.2, 0.4);
  return g;
}

/* ---------- Ground support equipment and jet bridges (sizes from real A320 turnarounds) ---------- */
let GSEM = null;
function gseMats() {
  if (GSEM) return GSEM;
  const std = (c, r = 0.75, m = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
  GSEM = { white: std(0xe9e7e2), yellow: std(0xe3b62b), orange: std(0xd8742a), grey: std(0x6b6f76, 0.6, 0.4), steel: std(0xa9adb3, 0.5, 0.6),
    tyre: std(0x161616, 0.95), rubber: std(0x202020, 0.9), belt: std(0x2b2b2b, 0.9), red: std(0xb3262b, 0.8), navy: M.paintNavy,
    bridge: std(0xc3c6ca, 0.55, 0.5), bridgeDark: std(0x5c6168, 0.6, 0.4), glass: std(0x2a3a4a, 0.15, 0.6) };
  return GSEM;
}
const wheels = (g, pts, r = 0.4, w = 0.28) => { for (const [x, z] of pts) cyl(r, r, w, gseMats().tyre, x, r, z, g, 14).rotation.x = Math.PI / 2; };
/** a self-propelled passenger stair truck; the top platform at +x end, sill height h */
function airstairs(h = 3.4) {
  const G = gseMats(), g = new THREE.Group();
  box(7.2, 0.5, 2.2, G.white, 3.8, 0.75, 0, g);
  box(1.8, 1.4, 2.2, G.white, 6.6, 1.6, 0, g);
  box(1.0, 0.7, 2.0, G.glass, 6.9, 1.9, 0, g);
  const run = 5.6, len = Math.hypot(run, h - 1.0), ang = Math.atan2(h - 1.0, run);
  const flight = new THREE.Group();
  box(len, 0.15, 1.5, G.grey, 0, 0, 0, flight);
  for (let i = 0; i < 14; i++) box(0.04, 0.2, 1.5, G.steel, -len / 2 + (i + 0.5) * len / 14, 0.12, 0, flight);
  for (const sz of [-0.8, 0.8]) { box(len, 0.06, 0.06, G.yellow, 0, 1.0, sz, flight); box(len, 0.9, 0.04, G.white, 0, 0.5, sz, flight); }
  flight.rotation.z = -ang;
  flight.position.set(run / 2 + 0.4, (h + 1.0) / 2 + 0.1, 0);
  g.add(flight);
  box(1.6, 0.15, 1.6, G.grey, -0.6, h, 0, g); // top landing at the door
  for (const sz of [-0.8, 0.8]) box(1.6, 1.0, 0.05, G.white, -0.6, h + 0.55, sz, g);
  box(0.3, 2.4, 0.3, G.grey, -0.2, h + 1.0, 0.82, g).position.y = h + 1.2; // canopy post
  box(2.0, 0.08, 2.0, G.white, -0.4, h + 2.35, 0, g); // canopy
  wheels(g, [[1.2, -1.05], [1.2, 1.05], [6.4, -1.05], [6.4, 1.05]]);
  return g;
}
/** belt loader: a chassis with an inclined conveyor rising toward -x */
function beltLoader(h = 2.0) {
  const G = gseMats(), g = new THREE.Group();
  box(6.4, 0.45, 1.8, G.yellow, 0, 0.7, 0, g);
  box(1.2, 1.2, 1.0, G.yellow, 1.8, 1.4, 0.55, g);
  const len = 8.2, ang = Math.atan2(h - 0.9, 7.6);
  const belt = new THREE.Group();
  box(len, 0.25, 1.0, G.grey, 0, 0, 0, belt);
  box(len, 0.06, 0.8, G.belt, 0, 0.15, 0, belt);
  for (const sz of [-0.55, 0.55]) box(len, 0.25, 0.06, G.yellow, 0, 0.3, sz, belt);
  belt.rotation.z = -ang;
  belt.position.set(-0.4, (h + 0.9) / 2 + 0.2, 0);
  g.add(belt);
  for (const x of [-1.2, 1.4]) box(0.15, 1.2, 0.15, G.grey, x, 1.2, 0, g);
  wheels(g, [[-2.3, -0.95], [-2.3, 0.95], [2.3, -0.95], [2.3, 0.95]], 0.35, 0.25);
  return g;
}
/** catering high-loader: cab in front (+x), white body raised on a scissor lift to door height */
function cateringTruck(h = 3.4) {
  const G = gseMats(), g = new THREE.Group();
  g.userData.isCater = true;
  box(8.0, 0.6, 2.4, G.grey, 0, 0.85, 0, g);
  box(2.0, 2.0, 2.4, G.white, 3.2, 2.0, 0, g);
  box(0.9, 0.9, 2.3, G.glass, 3.9, 2.4, 0, g);
  for (const sz of [-0.8, 0.8]) { const a = box(5.4, 0.12, 0.12, G.steel, -1.2, (h + 1.1) / 2, sz, g); a.rotation.z = 0.45; const b = box(5.4, 0.12, 0.12, G.steel, -1.2, (h + 1.1) / 2, sz, g); b.rotation.z = -0.45; }
  box(6.0, 2.6, 2.5, G.white, -1.2, h + 1.3, 0, g);
  box(6.02, 0.35, 2.52, G.navy, -1.2, h + 0.25, 0, g);
  box(1.6, 0.12, 2.0, G.grey, -4.9, h + 0.05, 0, g); // platform to the door
  wheels(g, [[-2.6, -1.15], [-2.6, 1.15], [3.0, -1.15], [3.0, 1.15]], 0.5, 0.3);
  return g;
}
/** ground power unit on a small towed cart */
function gpu() {
  const G = gseMats(), g = new THREE.Group();
  box(2.6, 1.3, 1.4, G.white, 0, 1.0, 0, g);
  box(2.62, 0.2, 1.42, G.orange, 0, 0.55, 0, g);
  box(1.0, 0.04, 0.04, G.belt, -1.8, 0.4, 0, g);
  wheels(g, [[-0.9, -0.75], [-0.9, 0.75], [0.9, -0.75], [0.9, 0.75]], 0.3, 0.2);
  return g;
}
/** towbarless pushback tug: long, low and wide */
function pushbackTug() {
  const G = gseMats(), g = new THREE.Group();
  box(7.5, 1.3, 3.6, G.yellow, 0, 0.95, 0, g);
  box(1.2, 1.2, 1.2, G.glass, 2.9, 2.2, 1.0, g);
  box(1.3, 0.1, 1.3, G.yellow, 2.9, 2.85, 1.0, g);
  box(1.6, 0.25, 2.2, G.grey, -3.4, 0.55, 0, g); // nose-gear cradle
  wheels(g, [[-2.2, -1.85], [-2.2, 1.85], [2.4, -1.85], [2.4, 1.85]], 0.6, 0.45);
  return g;
}
/** an apron bus (Cobus-type): long, low, glass all round */
function apronBus(livery = 0x111c44) {
  const G = gseMats(), g = new THREE.Group();
  box(14, 2.4, 3.0, G.white, 0, 1.75, 0, g);
  box(13.6, 1.1, 3.04, G.glass, 0, 2.1, 0, g);
  box(14.02, 0.35, 3.02, new THREE.MeshStandardMaterial({ color: livery, roughness: 0.7 }), 0, 0.75, 0, g);
  box(14, 0.15, 3.0, G.grey, 0, 3.0, 0, g);
  for (const x of [-4.2, 0, 4.2]) box(1.4, 2.0, 0.05, G.glass, x, 1.6, 1.53, g); // doors
  wheels(g, [[-5.2, -1.4], [-5.2, 1.4], [5.2, -1.4], [5.2, 1.4]], 0.5, 0.3);
  return g;
}
/** stand number board on a pole, readable from the flight deck */
function standBoard(txt) {
  const G = gseMats(), g = new THREE.Group();
  cyl(0.1, 0.1, 6, G.grey, 0, 3, 0, g, 8);
  const tex = canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#e3b62b'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#111'; c.font = FONT(700, 150); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(txt, w / 2, h / 2 + 8);
  });
  const sm = new THREE.MeshBasicMaterial({ map: tex });
  box(1.6, 1.6, 0.12, [G.grey, G.grey, G.grey, G.grey, sm, sm], 0, 6.6, 0, g);
  return g;
}
/** a code-built vehicle that a real model replaces once it loads */
function gseSpot(o, kind) { o.userData.dynamic = true; o.userData.gse = kind; AIRSIDE.placeholders.gse.push(o); return o; }
/** an apron-drive jet bridge from a rotunda at (rx, rz) to the aircraft door at (dx, dz), sill height h */
function jetBridge(rx, rz, dx, dz, h = 3.4, parent) {
  const G = gseMats(), g = new THREE.Group();
  const yaw = Math.atan2(-(dz - rz), dx - rx), len = Math.hypot(dx - rx, dz - rz);
  cyl(2.6, 2.6, 3.4, G.bridge, rx, h + 1.4, rz, g, 18); // rotunda
  cyl(0.5, 0.6, h - 0.3, G.bridgeDark, rx, (h - 0.3) / 2, rz, g, 10);
  const t = new THREE.Group();
  t.position.set(rx, 0, rz);
  t.rotation.y = yaw;
  const cabLen = 3.2, tun = len - 2.6 - cabLen + 0.4, seg = tun / 3;
  [[3.4, 3.2], [3.15, 3.0], [2.9, 2.8]].forEach(([w, hh], i) => { // three telescopic sections
    const x = 2.4 + seg * (i + 0.5) + i * 0.15;
    box(seg + 0.3, hh, w, G.bridge, x, h + 1.4, 0, t);
    box(seg, 1.0, w + 0.04, G.glass, x, h + 1.8, 0, t);
    box(seg + 0.32, 0.2, w + 0.02, G.bridgeDark, x, h + 1.4 - hh / 2 + 0.1, 0, t);
  });
  const legX = 2.4 + seg * 2.4;
  for (const sz of [-1.1, 1.1]) box(0.35, h - 0.1, 0.35, G.bridgeDark, legX, (h - 0.1) / 2 + 0.3, sz, t);
  box(0.6, 0.5, 3.0, G.bridgeDark, legX, 0.55, 0, t); // drive bogie
  for (const sz of [-1.0, 1.0]) cyl(0.45, 0.45, 0.4, G.tyre, legX, 0.45, sz, t, 14).rotation.x = Math.PI / 2;
  const cx = len - cabLen / 2;
  box(cabLen, 3.3, 3.8, G.bridge, cx, h + 1.4, 0, t);
  box(cabLen - 0.4, 1.0, 3.84, G.glass, cx, h + 1.9, 0, t);
  box(0.6, 3.0, 3.0, G.rubber, len + 0.2, h + 1.3, 0, t); // canopy bellows at the door
  g.add(t);
  parent.add(g);
  return g;
}
/** everything a parked A320 has round it mid-turnaround. Nose points along +z (dir 1) or -z (dir -1), centre (x, z). */
function turnaround(x, z, dir, standNo, parent, { bus = true } = {}) {
  const put = (o, px, pz, yaw) => { o.position.set(px, 0, pz); o.rotation.y = yaw; parent.add(o); return o; };
  const nose = z + dir * 18.8, left = dir; // aircraft's left lies toward +x when the nose points +z
  const fwdDoorZ = nose - dir * 4.6, aftDoorZ = nose - dir * 30.6;
  put(airstairs(), x + left * 2.4, fwdDoorZ, left > 0 ? 0 : Math.PI);
  put(airstairs(), x + left * 2.4, aftDoorZ, left > 0 ? 0 : Math.PI);
  put(beltLoader(), x - left * 2.6, nose - dir * 9.0, left > 0 ? Math.PI : 0);
  put(beltLoader(1.9), x - left * 2.6, nose - dir * 25.5, left > 0 ? Math.PI : 0);
  gseSpot(put(cateringTruck(), x - left * 7.4, aftDoorZ, left > 0 ? Math.PI : 0), 'cater');
  put(gpu(), x - left * 4.5, nose - dir * 1.5, Math.PI / 2);
  gseSpot(put(pushbackTug(), x, nose + dir * 6.5, dir > 0 ? Math.PI / 2 : -Math.PI / 2), 'tug');
  if (bus) put(apronBus(), x + left * 26, z + dir * 14, Math.PI / 2);
  put(standBoard(standNo), x + 4, nose + dir * 12, dir > 0 ? 0 : Math.PI);
  const G = gseMats();
  for (const s of [-1, 1]) box(0.25, 0.2, 0.4, G.yellow, x + s * 0.5, 0.1, nose - dir * 5.2, parent); // nose-gear chocks
  wearAndCrew(x, z, dir, parent);
  for (const s of [-1, 1]) box(0.6, 0.25, 0.3, G.yellow, x + s * 3.8, 0.12, z - dir * 0.6, parent); // main-gear chocks
  // stand safety lines: red equipment-restraint box and a white walkway at the forward door
  box(48, 0.01, 0.3, G.red, x, 0.036, nose + dir * 2, parent, { cast: false });
  for (const s of [-1, 1]) box(0.3, 0.01, 44, G.red, x + s * 24, 0.036, z, parent, { cast: false });
}

/** The arrival-to-departure loop every moving airliner flies, sampled every 0.25 s. */
function buildRoute() {
  const dt = 0.25, S = [];
  let x = 2200, y = 0, z = RWY_Z, h = Math.PI, p = 0.035, v = 72, t = 0;
  const glide = Math.tan(THREE.MathUtils.degToRad(3)), TD = RWY_THR - 300;
  const rec = () => { S.push({ t, x, y, z, h, p }); t += dt; };
  const fwd = () => { x += Math.cos(h) * v * dt; z -= Math.sin(h) * v * dt; };
  const turn = (dh, R) => { const n = Math.ceil(Math.abs(dh) * R / v / dt); for (let i = 0; i < n; i++) { rec(); h += dh / n; fwd(); } };
  while (x > TD) { y = (x - TD) * glide; rec(); fwd(); }
  y = 0;
  let k = 0;
  while (v > 12) { p = Math.max(0, 0.035 - k * 0.004); k++; rec(); fwd(); v -= 2.4 * dt; }
  p = 0; v = 12;
  while (x > -640) { rec(); fwd(); }
  const conn = [];
  v = 8; turn(Math.PI / 2, 45); conn.push(x);
  v = 12; while (z < TWY_Z - 45) { rec(); fwd(); }
  v = 8; turn(Math.PI / 2, 45);
  v = 14; while (x < 640) { rec(); fwd(); }
  v = 8; turn(Math.PI / 2, 45); conn.push(x);
  v = 10; while (z > RWY_Z + 45) { rec(); fwd(); }
  v = 8; turn(Math.PI / 2, 45);
  v = 0; for (let i = 0; i < 6 / dt; i++) rec();
  while (v < 76) { rec(); v += 2.3 * dt; fwd(); }
  let c = 0;
  while (x > -2600) { rec(); c += dt; p = Math.min(0.15, c * 0.05); v += 0.6 * dt; y += v * Math.sin(p * 0.9) * dt; fwd(); }
  return { S, dt, T: t, conn };
}
function sampleRoute(r, t, out) {
  const f = ((t % r.T) + r.T) % r.T / r.dt, i = Math.min(r.S.length - 2, Math.floor(f)), u = f - i;
  const a = r.S[i], b = r.S[i + 1];
  out.x = a.x + (b.x - a.x) * u; out.y = a.y + (b.y - a.y) * u; out.z = a.z + (b.z - a.z) * u;
  out.h = a.h + (b.h - a.h) * u; out.p = a.p + (b.p - a.p) * u;
  return out;
}

/* ---------- Real aircraft models (meshopt .glb), swapped in over the placeholders ---------- */
// Credits: Airbus A320 by OUTPISTON (CC BY-NC-SA 4.0), Cessna 182 Skylane by VTX (CC BY-NC-SA 4.0),
// Gulfstream G650ER by Luca Martina (CC BY 4.0), all via Sketchfab; Delhi ATC tower built for the main site.
const MODEL_SPECS = {
  a320: { url: 'models/a320.glb', yaw: Math.PI / 2, length: 37.6, fullColour: true },
  c182: { url: 'models/c182.glb', yaw: -Math.PI / 2, length: 8.8 }, // cabin interior stripped, simplified
  g650: { url: 'models/g650.glb', yaw: Math.PI / 2, length: 30.4 },
  tower: { url: 'models/delhi_atc_tower.glb', yaw: 0, height: 72 },
  // AIG AI aircraft (FAIB A320neo CFM, AIG 787-9 RR), converted from their MSFS models with permission; gear baked down
  n_igo: { url: 'models/a20n_igo.glb', yaw: Math.PI / 2, length: 37.57, livery: true },
  n_aic: { url: 'models/a20n_aic.glb', yaw: Math.PI / 2, length: 37.57, livery: true },
  n_vti: { url: 'models/a20n_vti.glb', yaw: Math.PI / 2, length: 37.57, livery: true },
  b_vir: { url: 'models/b789_vir.glb', yaw: Math.PI / 2, length: 62.8, livery: true },
  b_baw: { url: 'models/b789_baw.glb', yaw: Math.PI / 2, length: 62.8, livery: true },
};
// ground vehicles from Sketchfab: "GameAsset - Airport Pushback" by Loic ALIX (CC BY-NC 4.0), "Airport Catering Truck" by spot1studios (CC BY 4.0)
MODEL_SPECS.tug = { url: 'models/pushback_tug.glb', yaw: -Math.PI / 2, length: 9.0, keepOne: true };
MODEL_SPECS.cater = { url: 'models/catering_truck.glb', yaw: -Math.PI / 2, length: 9.13 };
const LIVERY_KEYS = ['n_igo', 'n_aic', 'n_vti', 'b_vir', 'b_baw'];
const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
/** a float copy of any attribute, read straight off its typed array (getX per element is far too slow at 100k+) */
function floatAttr(a) {
  const n = a.itemSize, cnt = a.count, inter = a.isInterleavedBufferAttribute;
  const src = inter ? a.data.array : a.array, stride = inter ? a.data.stride : n, off = inter ? a.offset : 0;
  let scale = 1;
  if (a.normalized) scale = src instanceof Int8Array ? 1 / 127 : src instanceof Uint8Array ? 1 / 255 : src instanceof Int16Array ? 1 / 32767 : src instanceof Uint16Array ? 1 / 65535 : 1;
  const f = new Float32Array(cnt * n);
  for (let i = 0, o = 0; i < cnt; i++) {
    const b = i * stride + off;
    for (let j = 0; j < n; j++, o++) f[o] = Math.max(-1e30, src[b + j] * scale);
  }
  if (a.normalized && (src instanceof Int8Array || src instanceof Int16Array)) for (let i = 0; i < f.length; i++) if (f[i] < -1) f[i] = -1;
  return new THREE.BufferAttribute(f, n);
}
/** Load, turn the nose toward +x, scale to real size, sit it on the ground, matte the paint. */
function loadAirModel(key) {
  const sp = MODEL_SPECS[key];
  return gltfLoader.loadAsync(sp.url).then((gltf) => {
    const root = gltf.scene;
    root.rotation.y = sp.yaw;
    if (sp.keepOne) { // the tug file holds two copies side by side: keep the one at -x
      root.updateMatrixWorld(true);
      const drop = [];
      root.traverse((o) => { if (o.isMesh && new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()).applyAxisAngle(new THREE.Vector3(0, 1, 0), -sp.yaw).x > 0) drop.push(o); });
      drop.forEach((o) => o.removeFromParent());
    }
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false;
      for (const m of [].concat(o.material)) {
        if (sp.fullColour) m.color?.setScalar(1); // the A320 export darkens its livery
        if ('roughness' in m) { m.roughness = Math.max(m.roughness ?? 1, 0.55); m.metalness = Math.min(m.metalness ?? 0, 0.15); }
      }
    });
    const inner = new THREE.Group();
    inner.add(root);
    inner.updateMatrixWorld(true);
    unskin(root);
    const b = new THREE.Box3().setFromObject(inner, true), size = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    const s = sp.length ? sp.length / size.x : sp.height / size.y;
    inner.scale.setScalar(s);
    inner.position.set(-c.x * s, -b.min.y * s, -c.z * s);
    const wrap = new THREE.Group();
    wrap.add(inner);
    wrap.userData.height = size.y * s;
    return wrap;
  });
}
// each model swaps in on its own as soon as it arrives (the A320 is small, the Cessna is the heaviest)
const airModels = Object.fromEntries(Object.keys(MODEL_SPECS).map((k) => [k, loadAirModel(k).catch((e) => { console.warn('model', k, e); return null; })]));
// Terminal 3's pier from the VIDP scenery (converted from its MSFS model library), in metres as built
airModels.t3 = gltfLoader.loadAsync('models/vidp_t3.glb?v=4').then((gltf) => {
  const root = gltf.scene;
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = false;
    for (const m of [].concat(o.material)) if ('roughness' in m) { m.roughness = Math.max(m.roughness ?? 1, 0.6); m.metalness = Math.min(m.metalness ?? 0, 0.3); }
  });
  root.rotation.y = T3P.rot;
  root.position.set(T3P.tx, 0.03, T3P.tz);
  root.userData.dynamic = true;
  return root;
}).catch((e) => { console.warn('model t3', e); return null; });

/* ---------- Realism: photographed sky and light, PBR surfaces, real furniture ---------- */
// Sky and image-based light: "Qwantani Sunset (Pure Sky)" from Poly Haven (CC0), a 1k HDR for light and reflections
// and its tonemapped photo (4096 x 2048) as the visible sky. In the photo the sun sits 14° up at azimuth 38.5°
// (atan2(z, x)); both are turned so it sets at SUN_AZ, where the scene's directional light comes from too.
const SUN_AZ = THREE.MathUtils.degToRad(-160);
const SKY_ROT = THREE.MathUtils.degToRad(38.5) - SUN_AZ;
const SUN_EL = THREE.MathUtils.degToRad(14);
const SUN_VEC = new THREE.Vector3(Math.cos(SUN_AZ) * Math.cos(SUN_EL), Math.sin(SUN_EL), Math.sin(SUN_AZ) * Math.cos(SUN_EL));
function loadSkyAndLight(skyMesh) {
  new RGBELoader().loadAsync('tex/qwantani_sunset_puresky_1k.hdr').then((hdr) => {
    const env = pmrem.fromEquirectangular(hdr).texture;
    scene.environment = env;
    scene.environmentRotation.y = SKY_ROT;
    hdr.dispose();
  }).catch((e) => console.warn('hdr', e));
  new THREE.TextureLoader().loadAsync('tex/sky_pink.jpg').then((tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    scene.background = tex;
    scene.backgroundRotation.y = SKY_ROT;
    scene.backgroundIntensity = 0.75;
    skyMesh.visible = false;
    // the fog takes the photo's colour just above the horizon, so distant ground melts into this sky
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const g = c.getContext('2d');
    g.drawImage(tex.image, 0, 0, 256, 128);
    const row = g.getImageData(0, 61, 256, 2).data;
    let r = 0, gg = 0, b = 0;
    for (let i = 0; i < row.length; i += 4) { r += row[i]; gg += row[i + 1]; b += row[i + 2]; }
    const n = row.length / 4;
    HORIZON.setRGB(r / n / 255, gg / n / 255, b / n / 255, THREE.SRGBColorSpace).multiplyScalar(0.85);
    scene.fog.color.copy(HORIZON);
  }).catch((e) => console.warn('sky', e));
}

// PBR texture sets from Poly Haven (CC0): diffuse 1k, roughness and GL normal 512, in tex/.
const PBR_CACHE = new Map();
const texLoader = new THREE.TextureLoader();
function pbrSet(name, maps = ['diff', 'rough', 'nor']) {
  const key = name + maps.join();
  if (!PBR_CACHE.has(key)) {
    PBR_CACHE.set(key, Promise.all(maps.map((k) => texLoader.loadAsync(`tex/${name}_${k}.jpg`).then((t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = MAX_ANISO;
      if (k === 'diff') t.colorSpace = THREE.SRGBColorSpace;
      return [k, t];
    }))).then(Object.fromEntries));
  }
  return PBR_CACHE.get(key);
}
/** dress a material in a texture set once its images are in; repeat [x, y] (or the repeat its old map had, times k) */
function dress(mat, name, { repeat, keepRepeatOf, k = 1, color, diff = true, normal = 1, rough } = {}) {
  const rep = repeat || (keepRepeatOf ? [keepRepeatOf.repeat.x * k, keepRepeatOf.repeat.y * k] : [1, 1]);
  pbrSet(name, diff ? ['diff', 'rough', 'nor'] : ['rough', 'nor']).then((set) => {
    const use = (t) => { const c = t.clone(); c.repeat.set(rep[0], rep[1]); return c; };
    if (diff) mat.map = use(set.diff);
    mat.roughnessMap = use(set.rough);
    mat.normalMap = use(set.nor);
    mat.normalScale.set(normal, normal);
    mat.roughness = rough ?? 1;
    if (color !== undefined) mat.color.set(color);
    mat.needsUpdate = true;
  }).catch((e) => console.warn('texture set', name, e));
}

/** Lay the Poly Haven surfaces over the scene's materials (walls, floors, wood, fabric, ground). */
function dressScene() {
  // inside: marble-tile floor, plaster walls, oak veneer, woven upholstery, leather
  // the lobby keeps its large-format porcelain tiles (the marble set is a small mosaic): a light polish instead
  M.floor.roughness = 0.45;
  M.floor.envMapIntensity = 0.8;
  for (const w of [M.wall, M.wallWarm]) dress(w, 'painted_plaster_wall', { repeat: [3, 1.2], diff: false, normal: 0.5, rough: 1 });
  dress(M.wood, 'oak_veneer_01', { repeat: [1, 1], color: 0xffffff, rough: 0.9 });
  dress(M.woodDark, 'oak_veneer_01', { repeat: [1, 1], color: 0x8a7a6e, rough: 0.9 });
  for (const f of [M.fabric, M.fabricLight, M.fabricAccent]) dress(f, 'fabric_pattern_07', { repeat: [3, 3], diff: false, normal: 0.8, rough: 1 });
  dress(M.leather, 'brown_leather', { repeat: [2, 2], diff: false, normal: 0.6, rough: 1 });
  // outside: paving, lawn, asphalt, concrete
  for (const m of PAVED) dress(m, 'rectangular_paving', { keepRepeatOf: m.map, k: 1.2, color: 0xffffff, rough: 1 });
  for (const m of LAWN) dress(m, 'leafy_grass', { keepRepeatOf: m.map, k: 1.3, color: 0x6f7d4c, rough: 1 }); // dark under the blades
  for (const m of ASPHALT) dress(m, 'asphalt_02', { keepRepeatOf: m.map, k: 1.5, rough: 1 });
  // the airfield after Delhi IGI: dusty olive infield, pale concrete apron slabs, rubber-marked runway asphalt
  for (const m of CONCRETE_GROUND) dress(m, 'concrete_pavement', { keepRepeatOf: m.map, k: 0.75, color: 0xeae4d8, rough: 1 });
  for (const m of AIRFIELD) dress(m, 'withered_grass', { keepRepeatOf: m.map, k: 1, color: 0x9a8e66, rough: 1 }); // olive-khaki under the blades
  for (const m of RUNWAY) dress(m, 'aerial_asphalt_01', { keepRepeatOf: m.map, k: 1, color: 0xa29f99, rough: 1 });
  for (const m of RIBBED) dress(m, 'box_profile_metal_sheet', { repeat: m.userData.rep, diff: false, normal: 1.2, rough: 0.75 });
  // inside: acoustic ceiling texture, real carpet pile in room A
  dress(M.ceiling, 'ceiling_interior', { repeat: [5, 5], diff: false, normal: 0.35, rough: 1 });
  for (const m of CARPET) dress(m, 'dirty_carpet', { keepRepeatOf: m.map, k: 1, diff: false, normal: 0.8, rough: 1 });
  dress(M.concrete, 'brushed_concrete', { repeat: [1, 1], color: 0xcfcac2, rough: 1 });
}
// filled while the scene is built: materials that later take a texture set
const PAVED = [], LAWN = [], ASPHALT = [], CONCRETE_GROUND = [], AIRFIELD = [], RUNWAY = [], RIBBED = [], CARPET = [];

// Real furniture: pieces cut from "Residential Furniture" by ATD-London (CC BY 4.0) into models/furniture.glb, and
// "Bookshelf [CC0]" by Crew Froebel (CC BY 4.0) as models/bookshelf.glb. Loaded before the scene is built.
const FURN = {};
/** unpack quantized attributes to plain floats (meshopt files arrive int16 / int8, often interleaved) */
function floatGeometry(geo) {
  for (const k of Object.keys(geo.attributes)) {
    const a = geo.attributes[k];
    if (!a.isInterleavedBufferAttribute && a.array instanceof Float32Array && !a.normalized) continue;
    geo.setAttribute(k, floatAttr(a));
  }
  return geo;
}
/** which way a seat faces: its backrest is the tallest side; turn it so the back is at -z and it faces +z */
function faceForward(root) {
  const pts = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i += 3) pts.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld));
  });
  const score = (sel) => { let s = 0, n = 0; for (const v of pts) if (sel(v)) { s += v.y; n++; } return n ? s / n : 0; };
  const sides = [['-z', 0, score((v) => v.z < 0)], ['+z', Math.PI, score((v) => v.z > 0)], ['+x', Math.PI / 2, score((v) => v.x > 0)], ['-x', -Math.PI / 2, score((v) => v.x < 0)]];
  sides.sort((a, b) => b[2] - a[2]);
  return sides[0][1]; // yaw that puts the back at -z
}
async function loadFurniture() {
  const timeout = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), 6000))]).catch(() => null);
  const [f, b] = await Promise.all([timeout(gltfLoader.loadAsync('models/furniture.glb')), timeout(gltfLoader.loadAsync('models/bookshelf.glb'))]);
  const glassy = new THREE.MeshPhysicalMaterial({ color: 0xcfe3ea, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.35, envMapIntensity: 1.2 });
  // the catalogue's materials are plain colours; each piece says what they really are
  const DRESS = {
    sofa3: { fabric: M.fabric, other: M.metalDark, seat: true },
    lounge_chair: { fabric: M.fabricLight, other: M.metalDark, seat: true },
    office_chair: { fabric: M.leather, other: M.leather, seat: true },
    student_chair: { fabric: M.paintNavy, other: M.paintNavy, seat: true },
    bench: { fabric: M.fabric, other: M.metalDark },
    coffee_table: { fabric: M.wood, other: M.metalDark, glass: glassy },
    coffee_table_rect: { fabric: M.wood, other: M.wood },
    side_table: { fabric: M.wood, other: M.wood },
    desk: { fabric: M.wood, other: M.wood },
  };
  if (f) {
    for (const [name, d] of Object.entries(DRESS)) {
      let node = null;
      for (const s of f.scenes) node = node || s.getObjectByName(name);
      if (!node) continue;
      const t = new THREE.Group();
      const c = node.clone();
      c.position.set(0, 0, 0);
      c.rotation.set(0, 0, 0);
      c.scale.set(1, 1, 1);
      t.add(c);
      t.updateMatrixWorld(true);
      c.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry = floatGeometry(o.geometry.clone());
        const nm = o.material.name || '';
        o.material = /Canvas|Linen/.test(nm) ? d.fabric : /R0_G192/.test(nm) ? d.glass || d.other : /R1[5-7]\d_|R120/.test(nm) ? d.other : d.fabric === M.fabric || d.fabric === M.fabricLight ? d.other : d.fabric;
        o.castShadow = o.receiveShadow = true;
      });
      if (d.seat) c.rotation.y = faceForward(t);
      FURN[name] = t;
    }
  }
  if (b) {
    const root = b.scene;
    root.traverse((o) => { if (o.isMesh) { o.geometry = floatGeometry(o.geometry.clone()); o.castShadow = o.receiveShadow = true; } });
    const t = new THREE.Group();
    t.add(root);
    t.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(t), c = box.getCenter(new THREE.Vector3());
    root.position.set(-c.x, -box.min.y, -c.z);
    // the shelf stands 1.15 m tall; at 1.75x it fills a 2 m wall bay. Its shelves face +x in the file.
    const w = new THREE.Group();
    w.add(t);
    w.scale.setScalar(1.75);
    FURN.bookshelf = w;
    FURN.bookshelfSize = box.getSize(new THREE.Vector3()).multiplyScalar(1.75);
  }
}
/** a copy of a furniture model, placed; parent defaults to the scene (static, so mergeStatic bakes it) */
function placeFurn(name, x, y, z, yaw = 0, parent = scene) {
  const t = FURN[name];
  if (!t) return null;
  const c = t.clone();
  c.position.set(x, y, z);
  c.rotation.y = yaw;
  parent.add(c);
  return c;
}

/** Replace rigged meshes with plain ones frozen in their rest pose (the Cessna arrives rigged). */
function unskin(root) {
  const skinned = [];
  root.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
  const v = new THREE.Vector3();
  for (const sm of skinned) {
    sm.skeleton.update();
    const src = sm.geometry, pos = src.attributes.position, out = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      sm.applyBoneTransform(i, v);
      out.set([v.x, v.y, v.z], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
    if (src.attributes.uv) geo.setAttribute('uv', src.attributes.uv);
    if (src.index) geo.setIndex(src.index);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, sm.material);
    m.name = sm.name;
    m.position.copy(sm.position); m.quaternion.copy(sm.quaternion); m.scale.copy(sm.scale);
    sm.parent.add(m);
    sm.removeFromParent();
  }
  if (skinned.length) root.updateMatrixWorld(true);
}

/** Several copies of one model, merged into a handful of meshes (for parked aircraft). */
function parkedGroup(model, placements) {
  const g = new THREE.Group();
  for (const [x, z, yaw] of placements) {
    const c = SkeletonUtils.clone(model);
    c.position.set(x, 0, z);
    c.rotation.y = yaw;
    g.add(c);
  }
  return bakeGroup(g);
}

/** fly a mover with a real model: beacons, strobes, nav lights and a landing light scaled to its size */
function swapMover(m, model, k) {
  const g = new THREE.Group();
  g.rotation.order = 'YZX';
  model.userData.baked ??= bakeGroup(SkeletonUtils.clone(model)); // merged by material once, shared by every mover
  g.add(model.userData.baked.clone());
  blinker(glowPoints([[0, 6.2 * k, 0], [0, 1.6, 0]], 0xff3a20, 3, g), 1.2, 0, 0.15);
  blinker(glowPoints([[-3.5 * k, 4.4, -17 * k], [-3.5 * k, 4.4, 17 * k]], 0xffffff, 4, g), 1.0, 0.3, 0.08);
  glowPoints([[-3.5 * k, 4.4, -17 * k]], 0xff2a1a, 2, g);
  glowPoints([[-3.5 * k, 4.4, 17 * k]], 0x2aff6a, 2, g);
  glowPoints([[17.5 * k, 2.6, 0]], 0xfff1d6, 7, g); // landing light
  g.visible = m.g.visible;
  m.g.removeFromParent();
  AIRSIDE.root.add(g);
  m.g = g;
  m.lift = 0;
  m.real = model;
}
function upgradeAirside(md) {
  const air = AIRSIDE.root, P = AIRSIDE.placeholders;
  if (md.c182) {
    const spots = P.trainers.map((t) => [t.position.x, t.position.z, t.rotation.y]);
    P.trainers.forEach((t) => t.removeFromParent());
    air.add(parkedGroup(md.c182, spots));
  }
  for (const key of LIVERY_KEYS) {
    if (!md[key]) continue;
    const mine = P.jets.filter((j) => j.userData.livery === key && j.parent);
    if (mine.length) {
      const spots = mine.map((j) => [j.position.x, j.position.z, j.rotation.y]);
      mine.forEach((j) => j.removeFromParent());
      air.add(parkedGroup(md[key], spots));
    }
    for (const m of AIRSIDE.movers) if (m.livery === key) swapMover(m, md[key], key.startsWith('b_') ? 1.67 : 1);
  }
  if (md.a320) {
    const house = P.jets.filter((j) => !j.userData.livery && j.parent);
    const spots = house.map((j) => [j.position.x, j.position.z, j.rotation.y]);
    house.forEach((j) => j.removeFromParent());
    air.add(parkedGroup(md.a320, spots));
    // movers still on a placeholder fly the house A320 until their airline's model arrives
    for (const m of AIRSIDE.movers) if (!m.real) swapMover(m, md.a320, 1);
  }
  if (md.t3) { P.hall?.removeFromParent(); air.add(md.t3); }
  for (const kind of ['tug', 'cater']) {
    if (!md[kind]) continue;
    const mine = P.gse.filter((o) => o.userData.gse === kind && o.parent);
    const spots = mine.map((o) => { const v = o.getWorldPosition(new THREE.Vector3()); return [v.x, v.z, o.rotation.y]; });
    mine.forEach((o) => o.removeFromParent());
    air.add(parkedGroup(md[kind], spots));
  }
  if (md.g650) air.add(parkedGroup(md.g650, [[96, -44, -Math.PI / 2 + 0.35]])); // the academy's business jet by its hangar
  if (md.tower) {
    P.tower.removeFromParent();
    md.tower.position.set(-260, 0, -175);
    air.add(md.tower);
    AIRSIDE.towerLight.position.set(-260, md.tower.userData.height + 0.6, -175);
  }
}

function buildAirside() {
  const air = new THREE.Group();
  air.visible = false; // shown once the camera heads airside (see updateAirside)
  scene.add(air);
  AIRSIDE.root = air;
  GLOW = canvasTex(64, 64, (g, w, h) => {
    const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(255,255,255,0.7)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, w, h);
  });
  const blobTex = canvasTex(128, 128, (g, w, h) => {
    const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    r.addColorStop(0, 'rgba(0,0,0,0.5)'); r.addColorStop(0.6, 'rgba(0,0,0,0.25)'); r.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = r; g.fillRect(0, 0, w, h);
  });
  const blobMat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false });
  const blob = (x, z, sx, sz, parent = air) => {
    const m = panel(sx, sz, blobMat, x, 0.07, z, 'up', parent, { cast: false, receive: false });
    m.renderOrder = 1;
    return m;
  };
  const concreteTex = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#8a8883'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 16000, ['#77756f', '#9d9b95', '#6b6964'], 0.35, [1, 3]);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { g.fillStyle = `rgba(0,0,0,${0.02 + rand() * 0.05})`; g.fillRect(i * 128, j * 128, 128, 128); }
    g.fillStyle = 'rgba(40,38,35,0.45)';
    for (let i = 0; i <= 4; i++) { g.fillRect(i * 128 - 1, 0, 2, h); g.fillRect(0, i * 128 - 1, w, 2); }
  });
  const apronMat = new THREE.MeshStandardMaterial({ map: repeatOf(concreteTex, 520 / 24, 92 / 24), roughness: 0.9 });
  CONCRETE_GROUND.push(apronMat);
  const tarmac = new THREE.MeshStandardMaterial({ map: repeatOf(T.asphalt, 1, 1), color: 0x9a9a9a, roughness: 0.9 });
  const tarmacAt = (w, d) => { const m = tarmac.clone(); m.map = repeatOf(T.asphalt, w / 12, d / 12); ASPHALT.push(m); return m; };
  const yellow = new THREE.MeshStandardMaterial({ color: 0xd9b23a, roughness: 0.8 });
  const white = new THREE.MeshStandardMaterial({ color: 0xe9e9e4, roughness: 0.8 });
  const grass = new THREE.MeshStandardMaterial({ map: repeatOf(T.grass, 750, 750), color: 0xb8ab84, roughness: 1 });
  AIRFIELD.push(grass);

  // ground layers: grass everywhere, apron, service road, taxiway, connectors, runway
  panel(6000, 6000, grass, 0, -0.06, -900, 'up', air);
  panel(520, 92, apronMat, 0, 0.02, -23 - 46, 'up', air);
  panel(520, 7, tarmacAt(520, 7), 0, 0.03, -33, 'up', air);
  const twy = (x0, x1, z0, z1) => panel(Math.abs(x1 - x0), Math.abs(z1 - z0), tarmacAt(Math.abs(x1 - x0), Math.abs(z1 - z0)), (x0 + x1) / 2, 0.025, (z0 + z1) / 2, 'up', air);
  twy(-730, 730, TWY_Z - 11.5, TWY_Z + 11.5);
  for (const x of [-180, 180]) twy(x - 11.5, x + 11.5, -116, TWY_Z + 11);
  const route = buildRoute();
  AIRSIDE.route = route;
  for (const x of route.conn) twy(x - 11.5, x + 11.5, TWY_Z - 11, RWY_Z + 22);
  // runway 28/10 (the heading Delhi's 10/28 runs on): 45 m of grooved asphalt between 7.5 m paved shoulders
  const RL = RWY_THR - RWY_END + 60, RX = (RWY_THR + RWY_END) / 2 + 30;
  const shoulder = tarmacAt(RL, 60); shoulder.color.set(0xb3aea4);
  panel(RL, 60, shoulder, RX, 0.03, RWY_Z, 'up', air);
  RUNWAY_MAT = new THREE.MeshStandardMaterial({ map: repeatOf(T.asphalt, RL / 30, 45 / 30), color: 0x7d7d7d, roughness: 0.9 });
  RUNWAY.push(RUNWAY_MAT);
  panel(RL, 45, RUNWAY_MAT, RX, 0.035, RWY_Z, 'up', air);
  // markings: centreline, side stripes, threshold piano keys, designators, aiming point and touchdown zone, both ends
  for (let x = RWY_THR - 110; x > RWY_END + 110; x -= 50) box(30, 0.01, 0.9, white, x, 0.05, RWY_Z, air, { cast: false });
  for (const s of [-1, 1]) box(RWY_THR - RWY_END, 0.01, 0.9, white, (RWY_THR + RWY_END) / 2, 0.05, RWY_Z + s * 21.5, air, { cast: false });
  const designator = (txt, x, rot) => {
    const tex = canvasTex(256, 256, (g, w, h) => { g.fillStyle = '#e9e9e4'; g.font = FONT(700, 200); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, w / 2, h / 2 + 10); });
    panel(22, 22, new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.8 }), x, 0.055, RWY_Z, 'up', air, { cast: false, receive: false }).rotation.z = rot;
  };
  for (const [x0, dir, txt, rot] of [[RWY_THR, -1, '28', Math.PI / 2], [RWY_END, 1, '10', -Math.PI / 2]]) {
    for (const s of [-1, 1]) for (let i = 0; i < 6; i++) box(30, 0.01, 1.8, white, x0 + dir * 25, 0.05, RWY_Z + s * (4 + i * 3), air, { cast: false });
    designator(txt, x0 + dir * 75, rot);
    for (const s of [-1, 1]) box(45, 0.01, 9, white, x0 + dir * 400, 0.05, RWY_Z + s * 11, air, { cast: false }); // aiming point
    for (const [dx, n] of [[150, 3], [300, 2], [550, 2], [700, 1], [850, 1]]) for (const s of [-1, 1]) for (let j = 0; j < n; j++) {
      box(22, 0.01, 1.8, white, x0 + dir * dx, 0.05, RWY_Z + s * (5 + j * 2.7), air, { cast: false });
    }
  }
  // rubber laid down in the touchdown zones: heavy at the 28 end, where most traffic lands, lighter at the 10 end
  // (tyre-gum texture from FlyerGaia's HeavySkidMark pack)
  const gumTex = new THREE.TextureLoader().load('tex/tire_gum.png');
  gumTex.colorSpace = THREE.SRGBColorSpace;
  gumTex.anisotropy = MAX_ANISO;
  const gum = new THREE.MeshStandardMaterial({ map: gumTex, transparent: true, opacity: 0.9, depthWrite: false, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2 });
  const grng = mulberry32(10);
  for (const [x0, dir, n] of [[RWY_THR, -1, 14], [RWY_END, 1, 7]]) for (let k = 0; k < n; k++) {
    const dx = 120 + k * (n > 10 ? 55 : 80) + grng() * 30, len = 70 + grng() * 60, wid = 12 + grng() * 8;
    const m = panel(wid, len, gum, x0 + dir * dx, 0.056, RWY_Z + (grng() - 0.5) * 5, 'up', air, { cast: false, receive: false });
    m.rotation.z = Math.PI / 2;
    m.renderOrder = 1;
  }
  // taxiway and apron paint
  box(1460, 0.01, 0.3, yellow, 0, 0.04, TWY_Z, air, { cast: false });
  { const W = wearMats(), st = W.streak.clone(); st.map = W.streakTex.clone(); st.map.repeat.set(1, 1460 / 40); st.opacity = 0.55;
    decal(3.2, 1460, st, 0, TWY_Z, air, Math.PI / 2); }
  box(520, 0.01, 0.3, yellow, 0, 0.035, -104, air, { cast: false });
  for (const x of route.conn) box(0.3, 0.01, Math.abs(RWY_Z - TWY_Z), yellow, x, 0.04, (RWY_Z + TWY_Z) / 2, air, { cast: false });
  for (const x of route.conn) holdLine(x, RWY_Z + 90, -1, yellow, air);
  const STANDS = [-125, -70, -15];
  for (const x of STANDS) { box(0.3, 0.01, 40, yellow, x, 0.035, -84, air, { cast: false }); box(6, 0.01, 0.4, yellow, x, 0.035, -63, air, { cast: false }); }
  for (let x = -250; x < 250; x += 6) box(3, 0.01, 0.2, white, x, 0.04, -36.6, air, { cast: false }); // road edge

  // lights: runway edge (white), threshold (green), end (red), approach + sequenced flasher, taxiway (green / blue)
  const edge = [], thr = [], appr = [], twc = [], twe = [];
  for (let x = RWY_THR; x >= RWY_END; x -= 60) for (const s of [-1, 1]) edge.push([x, 0.5, RWY_Z + s * 23.5]);
  for (let z = -22; z <= 22; z += 3) thr.push([RWY_THR + 2, 0.4, RWY_Z + z]);
  for (let x = RWY_THR + 30; x <= RWY_THR + 900; x += 30) appr.push([x, 0.8, RWY_Z]);
  for (const s of [-1, 1]) for (let z = 4; z <= 16; z += 3) appr.push([RWY_THR + 300, 0.8, RWY_Z + s * z]);
  for (let x = -720; x <= 720; x += 20) twc.push([x, 0.3, TWY_Z]);
  for (let x = -720; x <= 720; x += 40) for (const s of [-1, 1]) twe.push([x, 0.4, TWY_Z + s * 12.5]);
  for (const cx of route.conn) for (let z = TWY_Z - 15; z > RWY_Z + 25; z -= 20) { twc.push([cx, 0.3, z]); twe.push([cx - 12.5, 0.4, z], [cx + 12.5, 0.4, z]); }
  glowPoints(edge, 0xfff1d6, 3.2);
  glowPoints(thr, 0x5dff9a, 3.0);
  glowPoints([[RWY_END, 0.4, RWY_Z - 15], [RWY_END, 0.4, RWY_Z], [RWY_END, 0.4, RWY_Z + 15]], 0xff4a3a, 3.0);
  glowPoints(appr, 0xfff6e6, 3.4);
  glowPoints(twc, 0x52f08a, 1.8);
  glowPoints(twe, 0x4a7dff, 2.2);
  AIRSIDE.rabbit = glowPoints([[RWY_THR + 900, 1, RWY_Z]], 0xffffff, 9);

  // apron floodlight masts
  for (const x of [-190, -95, 0, 95, 190]) {
    cyl(0.25, 0.4, 24, M.metalDark, x, 12, -112, air, 10);
    box(4, 0.6, 0.8, M.metalDark, x, 24.2, -112, air);
    box(3.6, 0.1, 0.6, M.lightWarm, x, 23.85, -111.9, air, { cast: false, receive: false });
  }
  glowPoints([-190, -95, 0, 95, 190].map((x) => [x, 23.8, -111.4]), 0xffd9a6, 9);

  // control tower, off to the west, by the sunset
  const tx = -260, tz = -175;
  const tower = new THREE.Group();
  cyl(3.2, 4.2, 40, M.concrete, tx, 20, tz, tower, 24);
  cyl(7.2, 6.4, 1.2, M.concrete, tx, 40.6, tz, tower, 8);
  cyl(7.0, 6.2, 5, new THREE.MeshStandardMaterial({ color: 0x1b2a3a, emissive: 0x7fb3d6, emissiveIntensity: 0.35, roughness: 0.3 }), tx, 43.7, tz, tower, 8);
  cyl(7.8, 7.8, 0.9, M.claddingDeep, tx, 46.6, tz, tower, 8);
  cyl(0.15, 0.15, 6, M.metal, tx, 50, tz, tower, 6);
  bakeGroup(tower).userData.dynamic = true; // a placeholder until the Delhi ATC tower model arrives
  air.add(tower);
  AIRSIDE.placeholders.tower = tower;
  AIRSIDE.towerLight = blinker(mesh(new THREE.SphereGeometry(0.35, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff3020 }), tx, 53.1, tz, air), 1.6, 0, 0.5);
  AIRSIDE.towerLight.userData.dynamic = true;

  // academy hangar with the logo, to the east
  const hx = 120, hz = -75;
  const hangarSkin = new THREE.MeshStandardMaterial({ color: 0x2a3760, roughness: 0.75, metalness: 0.35 });
  hangarSkin.userData.rep = [26, 7];
  RIBBED.push(hangarSkin);
  box(64, 16, 36, hangarSkin, hx, 8, hz, air);
  box(66, 1.2, 38, M.claddingDeep, hx, 16.6, hz, air);
  box(52, 13, 0.4, new THREE.MeshStandardMaterial({ color: 0x5d636c, roughness: 0.8 }), hx, 6.5, hz + 18.1, air);
  for (let i = 1; i < 6; i++) box(0.2, 13, 0.5, M.mullion, hx - 26 + i * (52 / 6), 6.5, hz + 18.2, air);
  panel(20, 20 * (473 / 1564), M.logo, hx, 14.6, hz + 18.25, '+z', air, { cast: false, receive: false });
  const glowWin = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffe2b5, emissiveIntensity: 0.6 });
  box(40, 0.6, 0.1, glowWin, hx, 0.4, hz + 18.35, air, { cast: false }); // light spilling under the doors

  // perimeter fence on either side of the building
  const fence = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, transparent: true, opacity: 0.22, roughness: 0.8, side: THREE.DoubleSide, depthWrite: false });
  for (const s of [-1, 1]) {
    panel(240, 2.6, fence, s * 134, 1.3, -23.5, '+z', air, { cast: false, receive: false });
    for (let x = 14; x < 254; x += 4) box(0.08, 2.8, 0.08, M.metalDark, s * x, 1.4, -23.5, air);
    box(240, 0.06, 0.06, M.metalDark, s * 134, 2.75, -23.5, air);
  }

  // back facade of the building: windows and the logo, seen from the apron
  for (const side of [-1, 1]) {
    panel(9, 3.2, M.upperView, side * 8.9, 6.6, -23.02, '-z', air);
    panel(9, 3.2, M.glass, side * 8.9, 6.6, -23.05, '-z', air, { cast: false, receive: false });
    for (let i = 0; i <= 6; i++) box(0.1, 3.3, 0.5, M.claddingDeep, side * 8.9 - 4.5 + 1.5 * i, 6.6, -23.25, air);
  }
  box(8.6, 3.6, 0.3, M.claddingDeep, 0, 6.6, -23.15, air);
  const backLogo = panel(6.8, 6.8 * (473 / 1564), M.logo, 0, 6.6, -23.31, '-z', air, { cast: false, receive: false });
  backLogo.renderOrder = 2;

  // the academy's own fleet: four trainers in brand colours, close to the building
  const fleet = [M.paintNavy, M.paintNavy, new THREE.MeshStandardMaterial({ color: 0x1f6f8a, roughness: 0.7 }), M.paintNavy];
  [-10, -22, -34, -46].forEach((x, i) => {
    const tr = bakeGroup(trainer(fleet[i]));
    tr.position.set(x, 0, -50);
    tr.rotation.y = -Math.PI / 2 + (i === 2 ? 0.25 : 0);
    tr.userData.dynamic = true; // a placeholder until the Cessna 182 model arrives
    air.add(tr);
    AIRSIDE.placeholders.trainers.push(tr);
    blob(x, -50, 11, 9);
    for (const s of [-1, 1]) cyl(0.08, 0.15, 0.45, new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.8 }), x + s * 5.6, 0.22, -49.2, air, 10); // wingtip cones
  });

  // parked airliners on their stands, nose toward the building
  const tails = [new THREE.MeshStandardMaterial({ color: 0xa8322d, roughness: 0.7 }), M.paintNavy, new THREE.MeshStandardMaterial({ color: 0x1f7a7a, roughness: 0.7 })];
  STANDS.forEach((x, i) => {
    const jet = bakeGroup(airliner({ tail: tails[i], gear: true }));
    jet.scale.setScalar(40);
    jet.position.set(x, 4.2, -86);
    jet.rotation.y = -Math.PI / 2;
    jet.userData.dynamic = true; // a placeholder until the A320 model arrives
    air.add(jet);
    AIRSIDE.placeholders.jets.push(jet);
    blob(x, -86, 40, 42);
    for (const dz of [-2, 2]) cyl(0.12, 0.25, 0.7, new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.8 }), x + 2.5, 0.35, -66 + dz, air, 10);
  });
  const ft = fuelTruck();
  ft.position.set(-58, 0, -78); ft.rotation.y = Math.PI / 2 + 0.2;
  air.add(ft);
  blob(-58, -78, 5, 11);
  STANDS.forEach((x, i) => turnaround(x, -86, 1, `${31 + i}`, air, { bus: i !== 2 }));

  // moving traffic: four airliners on the loop, a follow-me car and a baggage train
  const tailMat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 });
  const liveries = [[tailMat(0x2e5aa8), M.paintCyan], [tailMat(0xd9792b), M.paintNavy], [M.paintNavy, M.paintCyan], [tailMat(0x6b2a5e), M.paintCyan], [tailMat(0xa8322d), M.paintNavy], [tailMat(0x1f7a7a), M.paintCyan]];
  liveries.forEach(([tail, stripe], i) => {
    const g = bakeGroup(airliner({ tail, stripe, gear: true, lights: true }));
    g.scale.setScalar(40);
    g.rotation.order = 'YZX';
    g.userData.dynamic = true;
    g.visible = false;
    air.add(g);
    const sh = blob(0, 0, 40, 42);
    sh.userData.dynamic = true;
    AIRSIDE.movers.push({ g, shadow: sh, lift: 4.2, offset: (i / liveries.length) * route.T, s: {}, livery: ['n_igo', 'b_vir', 'n_aic', 'n_vti', 'n_igo', 'b_baw'][i] });
  });
  // two of the academy's trainers flying circuits over the field
  for (let i = 0; i < 2; i++) {
    const g = trainer(i ? tailMat(0x1f6f8a) : M.paintNavy);
    glowPoints([[3.9, 1.2, 0]], 0xfff1d6, 9, g);
    blinker(glowPoints([[-3.7, 2.9, 0]], 0xff3a20, 6, g), 1.1, i * 0.4, 0.15);
    const b = bakeGroup(g);
    b.rotation.order = 'YZX';
    b.userData.dynamic = true;
    air.add(b);
    AIRSIDE.vehicles.push({ circuit: b, cx: -60, cz: -440, rx: 620, rz: 200, alt: 120 + i * 40, speed: 42, phase: i * 0.5 });
  }
  const car = bakeGroup(followMeCar());
  car.userData.dynamic = true;
  air.add(car);
  const carPath = new THREE.CatmullRomCurve3([[170, -31.2], [0, -31.2], [-170, -31.2], [-177, -33.2], [-170, -35.2], [0, -35.2], [170, -35.2], [177, -33.2]].map(([x, z]) => new THREE.Vector3(x, 0, z)), true, 'centripetal');
  AIRSIDE.vehicles.push({ g: car, path: carPath, speed: 9, phase: 0 });
  for (const [mk, sp] of [[() => apronBus(), 7], [van, 8.5], [van, 10]]) {
    const v = bakeGroup(mk()); v.userData.dynamic = true; air.add(v);
    AIRSIDE.vehicles.push({ g: v, path: carPath, speed: sp, phase: 0, t0: AIRSIDE.vehicles.length * 23 });
  }
  for (const [x, z] of [[-125, -80], [-70, -78], [-15, -82]]) {
    const loop = new THREE.CatmullRomCurve3([[x + 6, z + 8], [x + 12, z - 6], [x - 6, z - 10], [x - 9, z + 6]].map(([a, b]) => new THREE.Vector3(a, 0, b)), true);
    const c = crewman(x > -50); c.userData.dynamic = true; air.add(c);
    AIRSIDE.vehicles.push({ g: c, path: loop, speed: 1.3, phase: 0, t0: x });
  }
  const train = tugTrain().map((p) => { const b = bakeGroup(p); b.userData.dynamic = true; air.add(b); return b; });
  AIRSIDE.vehicles.push({ train, cx: -70, cz: -59, rx: 48, rz: 4.5, speed: 5 });

  buildFarField(air, { white, yellow, tarmacAt, apronMat });
  buildCity(air);
  buildDeck(air);
  air.traverse((o) => { o.castShadow = false; });
}

/** Across the runway, after Delhi IGI's layout: a parallel taxiway, a T3-style terminal with jet bridges and gates,
    a second parallel runway lit for the evening, then the olive scrub and the hazy city edge. (Layout studied from
    satellite views as reference only; nothing is traced or copied from them.) */
// where the VIDP T3 pier model sits: model metres turned about y, then moved (see buildFarField)
const T3P = { rot: -2.1006, tx: 537.6, tz: -879.9 };
function t3xz(x, z) { const c = Math.cos(T3P.rot), s = Math.sin(T3P.rot); return [x * c + z * s + T3P.tx, -x * s + z * c + T3P.tz]; }
function buildFarField(air, { white, yellow, tarmacAt, apronMat }) {
  // parallel taxiway on the far side, with its centreline lights
  const FTW = RWY_Z - 80;
  panel(2400, 23, tarmacAt(2400, 23), -350, 0.025, FTW, 'up', air);
  box(2400, 0.01, 0.3, yellow, -350, 0.04, FTW, air, { cast: false });
  const twc = [];
  for (let x = -1500; x <= 800; x += 30) twc.push([x, 0.3, FTW]);
  for (const x of [-600, -150, 300]) {
    panel(23, 50, tarmacAt(23, 50), x, 0.024, (RWY_Z - 30 + FTW) / 2 - 6, 'up', air);
    box(0.3, 0.01, 52, yellow, x, 0.04, (RWY_Z - 30 + FTW) / 2 - 6, air, { cast: false });
    for (let z = FTW + 8; z < RWY_Z - 30; z += 12) twc.push([x, 0.3, z]);
    holdLine(x, RWY_Z - 62, 1, yellow, air);
  }
  glowPoints(twc, 0x52f08a, 1.6, air);

  // Terminal 3's west pier from the VIDP scenery by AvinashC (used with the author's permission), turned so its
  // straight face (stands 46-62) runs parallel to the runway. Stand positions are the scenery's own stand markers.
  const W = [[588.6, 273.3], [616.4, 320.8], [643.4, 367], [669, 410.8], [698.8, 450.4], [722.9, 491.8], [747, 539.1], [772, 582.7], [795.1, 626]];
  const D = [[622.2, 271.3], [647.8, 316.6], [674.3, 359.7], [701.6, 403.1], [726.8, 448.3], [752, 492.9], [776.3, 537.3], [801, 582.9], [828.4, 626.7]];
  const ws = W.map(([x, z]) => t3xz(x, z)), ds = D.map(([x, z]) => t3xz(x, z));
  const fx0 = Math.min(...ws.map((w) => w[0])) - 40, fx1 = Math.max(...ws.map((w) => w[0])) + 40, face = ws.reduce((a, w) => a + w[1], 0) / ws.length;
  const apron2 = apronMat.clone();
  apron2.map = repeatOf(apronMat.map, (fx1 - fx0) / 24, 90 / 24);
  CONCRETE_GROUND.push(apron2);
  panel(fx1 - fx0, 90, apron2, (fx0 + fx1) / 2, 0.02, face + 45, 'up', air);
  box(fx1 - fx0, 0.01, 0.3, yellow, (fx0 + fx1) / 2, 0.035, face + 82, air, { cast: false });

  // a stand-in hall until the pier model arrives
  const hall = new THREE.Group();
  const facadeTex = canvasTex(512, 256, (g, w, h) => {
    g.fillStyle = '#26303b'; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,214,160,0.35)'; g.fillRect(0, h * 0.3, w, h * 0.7);
    g.fillStyle = '#525a63';
    for (let x = 0; x < w; x += 32) g.fillRect(x, 0, 3, h);
  });
  const facade = new THREE.MeshStandardMaterial({ map: repeatOf(facadeTex, (fx1 - fx0) / 24, 1), roughness: 0.25, metalness: 0.3 });
  box(fx1 - fx0, 12, 40, facade, (fx0 + fx1) / 2, 6, face - 20, hall);
  box(fx1 - fx0 + 8, 1.2, 46, new THREE.MeshStandardMaterial({ color: 0xc8cbcf, roughness: 0.7, metalness: 0.45 }), (fx0 + fx1) / 2, 12.6, face - 20, hall);
  hall.userData.dynamic = true;
  air.add(hall);
  AIRSIDE.placeholders.hall = hall;

  // stands: apron-drive bridges from the pier's fixed links to the forward door, an A320 nose-in, a light turnaround
  const term = new THREE.Group();
  ds.forEach(([gx, nz], i) => {
    const jz = nz + 18.8, wx = ws[i][0];
    box(0.3, 0.01, 44, yellow, gx, 0.035, jz + 4, air, { cast: false });
    if (i === 4) { jetBridge(wx - 6, face + 6, wx - 2, face + 14, 3.4, term); return; } // stand 54 empty, bridge parked
    jetBridge(wx - 6, face + 6, gx - 2.4, nz + 4.6, 3.4, term);
    const G = gseMats();
    for (const [o, px, pz, yaw] of [[beltLoader(), gx + 2.6, nz + 9, 0], [gpu(), gx + 4.5, nz + 1.5, Math.PI / 2], [cateringTruck(), gx + 7.4, nz + 30.6, 0]]) {
      o.position.set(px, 0, pz); o.rotation.y = yaw; term.add(o);
      if (o.userData.isCater) gseSpot(o, 'cater');
    }
    box(0.6, 0.25, 0.3, G.yellow, gx, 0.12, nz + 5, term);
    wearAndCrew(gx, jz, -1, term, { crew: 3 });
    const jet = bakeGroup(airliner({ tail: M.paintNavy, gear: true }));
    jet.scale.setScalar(40);
    jet.position.set(gx, 4.2, jz);
    jet.rotation.y = Math.PI / 2; // nose in, toward the pier
    jet.userData.livery = ['n_igo', 'n_aic', 'b_vir', 'n_igo', null, 'n_vti', 'n_igo', 'b_baw', 'n_aic'][i];
    if (jet.userData.livery?.startsWith('b_')) jet.position.z = nz + 31.4; // a 787 is 63 m long
    jet.userData.dynamic = true; // a placeholder until the A320 model arrives
    air.add(jet);
    AIRSIDE.placeholders.jets.push(jet);
  });
  air.add(term);

  // the second parallel runway, far out: only its lights read at this distance, which is how it looks at dusk
  const R2 = RWY_Z - 700, R2L = 3200;
  panel(R2L, 45, RUNWAY_MAT, -400, 0.035, R2, 'up', air);
  const e2 = [], c2 = [];
  for (let x = -2000; x <= 1200; x += 60) for (const s of [-1, 1]) e2.push([x, 0.5, R2 + s * 23.5]);
  for (let x = -1980; x <= 1180; x += 30) c2.push([x, 0.3, R2]);
  glowPoints(e2, 0xfff1d6, 2.8, air);
  glowPoints(c2, 0xfff6e6, 1.6, air);
  glowPoints(Array.from({ length: 15 }, (_, i) => [1202, 0.4, R2 - 21 + i * 3]), 0x5dff9a, 2.6, air);

  // olive scrub (kikar and neem) along the boundary, and the city's edge in the haze beyond
  const rnd = mulberry32(28);
  const crowns = [];
  const scatter = (n, x0, x1, z0, z1) => { for (let i = 0; i < n; i++) crowns.push([x0 + rnd() * (x1 - x0), z0 + rnd() * (z1 - z0)]); };
  scatter(520, -2600, 2200, -1300, -1180);
  scatter(140, -2600, -1900, -1180, -40);
  scatter(140, 1500, 2200, -1180, -40);
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x4f5634, roughness: 1, flatShading: true });
  const trees = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), crownMat, crowns.length);
  const dm = new THREE.Object3D();
  crowns.forEach(([x, z], i) => {
    const r = 4 + rnd() * 5;
    dm.position.set(x, r * 0.75 + 1.5, z);
    dm.scale.set(r * (1 + rnd() * 0.4), r * (0.55 + rnd() * 0.25), r * (1 + rnd() * 0.4));
    dm.rotation.y = rnd() * 6.28;
    dm.updateMatrix();
    trees.setMatrixAt(i, dm.matrix);
  });
  trees.userData.dynamic = true;
  air.add(trees);
  const blocks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x8d8f96, roughness: 0.9 }), 70);
  for (let i = 0; i < 70; i++) {
    const h = 18 + rnd() * rnd() * 70, x = -2600 + rnd() * 4800;
    dm.position.set(x, h / 2, -1450 - rnd() * 250);
    dm.scale.set(20 + rnd() * 40, h, 20 + rnd() * 30);
    dm.rotation.y = (rnd() - 0.5) * 0.3;
    dm.updateMatrix();
    blocks.setMatrixAt(i, dm.matrix);
  }
  blocks.userData.dynamic = true;
  air.add(blocks);
}

/** runway-holding position, ICAO pattern A across a 23 m taxiway: two solid lines, then two dashed ones on the
    runway side (toward = -1 when the runway lies toward -z) */
function holdLine(x, z, toward, mat, parent) {
  for (let i = 0; i < 2; i++) box(23, 0.01, 0.3, mat, x, 0.042, z - toward * 0.6 * i, parent, { cast: false });
  for (let i = 0; i < 2; i++) for (let d = -10.5; d <= 10.5; d += 2) box(1, 0.01, 0.3, mat, x + d, 0.042, z + toward * (1.2 + 0.6 * i), parent, { cast: false });
}

/** Spotters' deck behind the building: a steel stair up to a glass-railed platform 8 m up. */
function buildDeck(air) {
  const top = 8, x0 = 2.6, x1 = 13, zc = -27, n = 28, rise = top / n, run = (x1 - x0) / n;
  const steel = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.75, metalness: 0.3 });
  for (let i = 0; i < n; i++) box(run + 0.02, 0.05, 1.4, steel, x0 + (i + 0.5) * run, (i + 1) * rise - 0.025, zc, air);
  const ang = Math.atan2(top, x1 - x0), len = Math.hypot(top, x1 - x0);
  for (const s of [-1, 1]) {
    box(len, 0.3, 0.08, steel, (x0 + x1) / 2, top / 2 - 0.05, zc + s * 0.74, air).rotation.z = ang;
    box(len, 0.05, 0.05, M.metal, (x0 + x1) / 2, top / 2 + 1.0, zc + s * 0.74, air).rotation.z = ang;
    for (let i = 2; i < n; i += 5) box(0.04, 1.0, 0.04, M.metal, x0 + i * run, i * rise + 0.5, zc + s * 0.74, air);
  }
  // platform
  const dx = 16.5, dz = -26.6, W = 7, D = 6.8;
  box(W, 0.3, D, steel, dx, top - 0.15, dz, air);
  for (const [cx, cz] of [[13.3, -23.5], [19.7, -23.5], [13.3, -29.7], [19.7, -29.7], [x0 + 0.2, zc - 0.74], [x0 + 0.2, zc + 0.74]]) {
    const h = cx < 5 ? 0.4 : top;
    cyl(0.14, 0.14, h, steel, cx, h / 2, cz, air, 12);
  }
  for (let i = 3; i < n - 2; i += 8) cyl(0.08, 0.08, (i + 1) * rise, steel, x0 + (i + 0.5) * run, (i + 1) * rise / 2, zc, air, 8);
  // glass balustrade with a steel top rail (open where the stair arrives)
  const rail = (x, z, w, facing) => {
    panel(w, 1.05, M.glass, x, top + 0.55, z, facing, air, { cast: false, receive: false });
    const along = facing === '+z' ? [w, 0.06, 0.08] : [0.08, 0.06, w];
    box(...along, M.metal, x, top + 1.1, z, air);
  };
  rail(dx, dz - D / 2, W, '+z');
  rail(dx + W / 2, dz, D, '-x');
  rail(13, -24.5, 2.4, '+x');
  rail(13, -29.1, 1.8, '+x');
  // a couple of benches and a lamp post up top
  for (const bz of [-24.4]) { box(2.2, 0.06, 0.5, M.wood, 17.2, top + 0.45, bz, air); for (const ex of [-0.95, 0.95]) box(0.05, 0.45, 0.45, steel, 17.2 + ex, top + 0.22, bz, air); }
  cyl(0.05, 0.06, 3.2, steel, 19.4, top + 1.6, -24, air, 8);
  box(0.5, 0.1, 0.3, M.lightWarm, 19.25, top + 3.2, -24, air, { cast: false, receive: false });
  glowPoints([[19.25, top + 3.1, -24]], 0xffd9a6, 3, air);
}

function updateAirside(now) {
  const on = camera.position.z < -13.5;
  if (on !== AIRSIDE.active) {
    AIRSIDE.active = on;
    // the aircraft models only draw once the camera heads airside (they sit behind the lobby's back wall)
    AIRSIDE.root.visible = on;
    AIRSIDE.movers.forEach((m) => { m.g.visible = on; m.shadow.visible = on; });
  }
  // back sliding doors open as the camera reaches them, whichever way it is going
  const open = range(-camera.position.z, 20, 22);
  AIRSIDE.backLeaves.forEach((g) => { g.position.x = g.userData.closedX + Math.sign(g.userData.closedX) * 0.75 * open; });
  // Keep every vehicle on its route even while the airside is hidden: anything left at its
  // build position would sit at the world origin, which is the front entrance. Throttled indoors.
  if (!on && now < (AIRSIDE.idleAt || 0)) return;
  if (!on) AIRSIDE.idleAt = now + 1000;
  const t = now / 1000;
  for (const m of AIRSIDE.movers) {
    const s = sampleRoute(AIRSIDE.route, t + m.offset, m.s);
    m.g.position.set(s.x, s.y + m.lift, s.z);
    m.g.rotation.set(0, s.h, s.p);
    m.shadow.position.set(s.x, 0.07, s.z);
    m.shadow.material.opacity = 1;
    m.shadow.scale.setScalar(Math.max(0, 1 - s.y / 40));
  }
  for (const v of AIRSIDE.vehicles) {
    if (v.circuit) {
      const a = v.phase * Math.PI * 2 + (t * v.speed) / ((v.rx + v.rz) / 2);
      v.circuit.position.set(v.cx + Math.cos(a) * v.rx, v.alt + Math.sin(a * 2) * 12, v.cz + Math.sin(a) * v.rz);
      v.circuit.rotation.set(-0.3, Math.atan2(-Math.cos(a) * v.rz, -Math.sin(a) * v.rx), 0);
    } else if (v.path) {
      const u = (((((t + (v.t0 || 0)) * v.speed) / v.path.getLength()) % 1) + 1) % 1;
      const p = v.path.getPointAt(u), d = v.path.getTangentAt(u);
      v.g.position.copy(p);
      v.g.rotation.y = Math.atan2(-d.z, d.x);
    } else {
      v.train.forEach((part, i) => {
        const a = -(t * v.speed) / v.rx - i * (3.4 / v.rx);
        part.position.set(v.cx + Math.cos(a) * v.rx, 0, v.cz + Math.sin(a) * v.rz);
        part.rotation.y = Math.atan2(-(-Math.cos(a) * v.rz), Math.sin(a) * v.rx);
      });
    }
  }
  for (const b of AIRSIDE.blinkers) b.mesh.visible = ((t / b.period + b.phase) % 1) < b.duty;
  // sequenced flashers run toward the threshold twice a second
  const k = (t * 2) % 1, rx = RWY_THR + 900 - k * 860;
  AIRSIDE.rabbit.geometry.attributes.position.setXYZ(0, rx, 1, RWY_Z);
  AIRSIDE.rabbit.geometry.attributes.position.needsUpdate = true;
}

/* ---------- Aviation touches inside the lobby ---------- */
function buildAviationTouches() {
  // Taxiway-style centreline: a dashed steel inlay leading to the doors, with a stop bar
  for (let z = -1.6; z > -13; z -= 1.3) box(0.035, 0.003, 0.8, M.inlay, 0, 0.0055, z - 0.4, scene, { cast: false });
  box(4.4, 0.003, 0.035, M.inlay, 0, 0.0055, -13.15, scene, { cast: false });

  // Hanging wayfinding sign over the walkway
  const sy = 2.95, sz = -3.4;
  const sign = new THREE.Mesh(new THREE.BoxGeometry(3.9, 3.9 * (340 / 3072), 0.06),
    [M.claddingDeep, M.claddingDeep, M.claddingDeep, M.claddingDeep, M.wayfinding, M.claddingDeep]);
  sign.position.set(0, sy, sz);
  add(sign, scene, { cast: false, receive: false });
  for (const x of [-1.7, 1.7]) cyl(0.004, 0.004, LOBBY.h - sy - 0.2, M.metal, x, (LOBBY.h + sy + 0.2) / 2, sz, scene, 6, { cast: false });

  // Model airliner in brand livery on a plinth, by the front glass
  const plinth = new THREE.Group();
  plinth.position.set(3.1, 0, -4.7);
  plinth.rotation.y = -0.5;
  scene.add(plinth);
  rbox(0.55, 0.95, 0.55, 0.02, M.deskWhite, 0, 0.475, 0, plinth);
  box(0.57, 0.02, 0.57, M.paintNavy, 0, 0.96, 0, plinth);
  cyl(0.008, 0.008, 0.42, M.metal, 0, 1.18, 0, plinth, 10);
  const plane = airliner();
  plane.position.set(0, 1.42, 0);
  plane.rotation.order = 'YZX';
  plane.rotation.set(0, Math.PI * 0.75, 0.1); // banked toward the walkway, gently climbing
  plinth.add(plane);
}

/** An airliner about 1 unit long, built nose toward +x; scale by ~40 for a full-size A320-class jet.
 *  tail: fin/engine colour, stripe: cheatline colour, gear: landing gear (ground at y = -0.105),
 *  lights: blinking beacons, wingtip nav lights and a landing-light glow. */
function airliner({ tail = M.paintNavy, stripe: stripeMat = M.paintCyan, gear = false, lights = false } = {}) {
  const g = new THREE.Group();
  const L = 0.95, R = 0.05;
  const prof = [[0, 0], [0.012, 0.004], [0.028, 0.06], [0.045, 0.18], [R, 0.3], [R, 0.78], [0.046, 0.86], [0.034, 0.92], [0.018, 0.96], [0.006, 0.985], [0, 0.99]]
    .map(([r, y]) => new THREE.Vector2(r, y * L));
  const fus = mesh(new THREE.LatheGeometry(prof, 40), M.paint, -L / 2, 0, 0, g);
  fus.rotation.z = -Math.PI / 2;
  // cyan cheatline on both sides
  for (const side of [0, Math.PI]) {
    const stripe = mesh(new THREE.CylinderGeometry(R * 1.006, R * 1.006, L * 0.46, 24, 1, true, side + Math.PI * 0.45, Math.PI * 0.1), stripeMat, L * 0.06, 0, 0, g, { cast: false });
    stripe.rotation.z = -Math.PI / 2;
  }
  // cockpit windows
  for (const z of [-1, 1]) box(0.03, 0.008, 0.012, M.metalDark, L * 0.43, 0.022, z * 0.024, g, { cast: false });

  const flat = (pts, depth, mat) => {
    const geo = new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([a, b]) => new THREE.Vector2(a, b))), { depth, bevelEnabled: false });
    geo.translate(0, 0, -depth / 2);
    return new THREE.Mesh(geo, mat);
  };
  for (const side of [-1, 1]) {
    // swept wing, thin in y, with a touch of dihedral
    const wing = flat([[0.08, 0], [-0.13, side * 0.47], [-0.19, side * 0.47], [-0.1, 0]], 0.008, M.paint);
    wing.geometry.rotateX(Math.PI / 2);
    wing.position.set(0, -0.025, 0);
    wing.rotation.x = side * 0.07;
    add(wing, g);
    const wl = flat([[-0.14, 0], [-0.17, 0.055], [-0.19, 0.055], [-0.19, 0]], 0.004, tail);
    wl.position.set(0, 0.005, side * 0.468);
    add(wl, g);
    // engine on a pylon
    const eng = mesh(new THREE.CylinderGeometry(0.024, 0.02, 0.12, 24), tail, 0.05, -0.07, side * 0.16, g);
    eng.rotation.z = Math.PI / 2;
    cyl(0.019, 0.019, 0.002, M.metalDark, 0.111, -0.07, side * 0.16, g, 24).rotation.z = Math.PI / 2;
    box(0.08, 0.035, 0.008, M.paint, 0.02, -0.045, side * 0.16, g);
    // tailplane
    const tp = flat([[-0.36, 0], [-0.44, side * 0.17], [-0.47, side * 0.17], [-0.45, 0]], 0.006, M.paint);
    tp.geometry.rotateX(Math.PI / 2);
    tp.position.y = 0.012;
    add(tp, g);
  }
  // navy fin with a cyan band
  add(flat([[-0.32, 0.03], [-0.43, 0.2], [-0.47, 0.2], [-0.46, 0.03]], 0.008, tail), g);
  box(0.045, 0.014, 0.0085, stripeMat, -0.442, 0.165, 0, g);
  if (gear) {
    for (const [gx, gz] of [[0.36, 0], [0.0, -0.055], [0.0, 0.055]]) {
      cyl(0.0035, 0.0035, 0.05, M.metal, gx, -0.068, gz, g, 8);
      for (const dz of [-0.008, 0.008]) cyl(0.012, 0.012, 0.007, M.leather, gx, -0.093, gz + dz, g, 14).rotation.x = Math.PI / 2;
    }
  }
  if (lights) {
    const red = new THREE.MeshBasicMaterial({ color: 0xff2a1a });
    for (const y of [0.053, -0.053]) blinker(mesh(new THREE.SphereGeometry(0.004, 8, 6), red, 0, y, 0, g, { cast: false }), 1.2, y > 0 ? 0 : 0.5, 0.15);
    mesh(new THREE.SphereGeometry(0.003, 6, 4), new THREE.MeshBasicMaterial({ color: 0xff2a1a }), -0.19, -0.02, -0.47, g, { cast: false }).userData.keep = true;
    mesh(new THREE.SphereGeometry(0.003, 6, 4), new THREE.MeshBasicMaterial({ color: 0x2aff6a }), -0.19, -0.02, 0.47, g, { cast: false }).userData.keep = true;
    blinker(glowPoints([[-0.19, -0.02, -0.47], [-0.19, -0.02, 0.47]], 0xffffff, 4, g), 1.0, 0.3, 0.08);
    blinker(glowPoints([[0, 0.053, 0]], 0xff3a20, 3, g), 1.2, 0, 0.15);
    glowPoints([[0.47, -0.03, 0]], 0xfff1d6, 7, g); // landing light
  }
  return g;
}

/* ---------- Camera path ---------- */
const PATH = new THREE.CatmullRomCurve3([
  new THREE.Vector3(0, 1.8, 50),
  new THREE.Vector3(0, 1.78, 36.5),
  new THREE.Vector3(0, 1.75, 23),
  new THREE.Vector3(0, 1.72, 13),
  new THREE.Vector3(0, 1.66, 5.0),
  new THREE.Vector3(0, 1.63, 0.6),
  new THREE.Vector3(0.1, 1.62, -3.2),
  new THREE.Vector3(0, 1.6, -6.6),
  new THREE.Vector3(0, 1.6, -9.3),
], false, 'centripetal');

// Where the camera looks, keyed by its z along the walk
const LOOK = [
  { z: 50, v: [0, 4.6, 0] },
  { z: 23, v: [0, 4.2, 0] },
  { z: 13, v: [0, 3.3, 0] },
  { z: 5, v: [0, 2.0, -3] },
  { z: 0.6, v: [0, 1.6, -8] },
  { z: -1.9, v: [4.4, 1.55, -7.5] },   // glance right at the lounge and its traffic screen
  { z: -3.7, v: [-2.6, 1.3, -8.2] },   // then left at reception
  { z: -5.7, v: [0, 1.4, -14] },
  { z: -9.3, v: [0, 1.38, -14] },
];
function lookAt(z, out) {
  if (z >= LOOK[0].z) return out.fromArray(LOOK[0].v);
  for (let i = 0; i < LOOK.length - 1; i++) {
    const a = LOOK[i], b = LOOK[i + 1];
    if (z <= a.z && z >= b.z) {
      const t = smooth((a.z - z) / (a.z - b.z));
      return out.set(a.v[0] + (b.v[0] - a.v[0]) * t, a.v[1] + (b.v[1] - a.v[1]) * t, a.v[2] + (b.v[2] - a.v[2]) * t);
    }
  }
  return out.fromArray(LOOK[LOOK.length - 1].v);
}

// Scroll progress -> path position. The walk inside gets more scroll than the approach,
// and the last stretch holds still so the doors can be read.
let uDoor = 0.7;
function computeDoorU() {
  for (let u = 0; u <= 1; u += 0.002) if (PATH.getPointAt(u).z <= 0.6) return u;
  return 0.7;
}
function progressToU(p) {
  const K = [[0, 0], [0.04, 0], [0.38, uDoor], [0.9, 1], [1, 1]];
  for (let i = 0; i < K.length - 1; i++) {
    const [p0, u0] = K[i], [p1, u1] = K[i + 1];
    if (p <= p1) {
      const t = (p - p0) / (p1 - p0 || 1);
      // ease into the rest position at the end
      const e = i === 2 ? 1 - Math.pow(1 - t, 1.5) : t;
      return u0 + (u1 - u0) * e;
    }
  }
  return 1;
}

/* ---------- Boot ---------- */
let T, M, hemi;
async function init() {
  patchFog();
  window.__boot = Math.round(performance.now());
  try { await Promise.all([FONT(500, 64), FONT(600, 30), FONT(500, 64, DISPLAY), FONT(700, 27)].map((f) => document.fonts.load(f))); } catch (e) { /* fall back to system fonts */ }
  let logoImg;
  try { logoImg = await loadImage('brand/logo-white.svg'); } catch (e) { logoImg = document.createElement('canvas'); }
  T = makeTextures(logoImg);
  M = makeMaterials(T);

  const t0 = performance.now();
  window.__marks = [['start', Math.round(t0)]];
  const mark = (k) => window.__marks.push([k, Math.round(performance.now() - t0)]);
  await loadFurniture();
  mark('furniture');
  const skyMesh = buildSky();
  // Sunset: lavender sky fill, low amber sun raking across the facade from the west
  hemi = new THREE.HemisphereLight(0xb497c6, 0x3d2c2e, 0.6); // lavender-pink sky fill
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffa98e, 1.7); // rose-gold low sun
  sun.target.position.set(0, 0, 4);
  sun.position.copy(SUN_VEC).multiplyScalar(48).add(sun.target.position); // where the photographed sun sets
  scene.add(sun.target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 14, bottom: -14, near: 10, far: 90 });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  SUN = sun;

  buildExterior();
  mark('exterior');
  buildLobby();
  mark('lobby');
  buildAirside();
  mark('airside');
  updateAirside(performance.now()); // place every vehicle on its route before the first frame
  for (const [k, pr] of Object.entries(airModels)) pr.then((m) => m && upgradeAirside({ [k]: m }));
  loadVegetation();
  loadNeighbours();
  loadStreet();
  loadIGI();
  loadDeskEngine();
  uDoor = computeDoorU();

  // Glass and logo planes should not throw shadows into the lobby
  scene.traverse((o) => {
    if (o.isMesh && (o.material === M.glass || o.material?.transparent)) o.castShadow = false;
  });

  buildStreetStatic();
  mark('built');
  mergeStatic();
  mark('merged');
  loadSkyAndLight(skyMesh);
  dressScene();
  buildGrass(skyMesh);
  renderer.shadowMap.autoUpdate = false; // nothing that casts shadows moves, so bake them once
  renderer.shadowMap.needsUpdate = true;

  setupFX();
  window.__cc = { get FX() { return FX; }, QUALITY, renderer, scene, camera, AIRSIDE, look: (x, y, z) => roomCam.look.set(x, y, z), view: (p, l) => { mode = "moving"; roomCam.pos.set(...p); roomCam.look.set(...l); }, setP: (v) => { targetP = p = v; } }; // debug handle
  setupScroll();
  onResize();
  // ?p=0.5 jumps the walk to that point (handy for screenshots)
  // ?room=A walks straight into a room. Both are debug/screenshot helpers.
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  const jump = room ? 1 : parseFloat(params.get('p'));
  if (jump >= 0 && jump <= 1) {
    lenis?.stop(); targetP = p = jump; ScrollTrigger.getAll().forEach((t) => t.disable());
    document.getElementById('cover')?.remove();
    if (room) setTimeout(() => { enterRoom(room.toUpperCase()); roomTl?.progress(1); }, 50);
    if (params.has('screen')) { // look straight at the traffic screen
      mode = 'moving'; TRAFFIC.force = true;
      roomCam.pos.set(5.6, 1.9, -7.6); roomCam.look.set(8, 1.95, -7.6);
    }
  }
  // compile the opening view's shaders in parallel (KHR_parallel_shader_compile), capped so a slow GPU never holds the
  // cover for long; once the page is up, the airside and rooms warm in the background so walking in doesn't hitch
  await Promise.race([renderer.compileAsync(scene, camera).catch(() => {}), new Promise((r) => setTimeout(r, 6000))]);
  mark('shaders');
  frame();
  mark('first-frame');
  setTimeout(() => {
    const all = camera.clone();
    all.position.set(0, 60, 40);
    all.lookAt(0, 0, -60);
    all.far = 4000;
    all.updateProjectionMatrix();
    AIRSIDE.root.visible = true; // programs are created synchronously; the wait for them is what runs in parallel
    renderer.compileAsync(scene, all).catch(() => {});
    AIRSIDE.root.visible = AIRSIDE.active;
  }, 800);
  requestAnimationFrame(() => { mark('raf'); document.documentElement.classList.add('is-ready'); });
}

/* ---------- Merge static meshes by material (hundreds of draw calls -> a few dozen) ---------- */
function mergeStatic() {
  scene.updateMatrixWorld(true);
  const buckets = new Map();
  const merged = [];
  scene.traverse((o) => {
    if (!o.isMesh || Array.isArray(o.material)) return;
    for (let a = o; a; a = a.parent) if (a.userData.dynamic) return;
    const src = o.geometry.clone();
    for (const k of Object.keys(src.attributes)) if (!['position', 'normal', 'uv'].includes(k)) src.deleteAttribute(k);
    floatGeometry(src);
    const g = src.index ? src.toNonIndexed() : src;
    g.clearGroups();
    g.applyMatrix4(o.matrixWorld);
    // models and code-built parts can share a material yet differ in attributes (no uv): merge them separately
    const key = `${o.material.uuid}|${o.castShadow}|${o.receiveShadow}|${o.renderOrder}|${Object.keys(g.attributes).sort().join()}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { mat: o.material, cast: o.castShadow, receive: o.receiveShadow, order: o.renderOrder, geos: [] }));
    b.geos.push(g);
    merged.push(o);
  });
  merged.forEach((o) => o.removeFromParent());
  for (const b of buckets.values()) {
    const m = new THREE.Mesh(mergeGeometries(b.geos), b.mat);
    m.castShadow = b.cast; m.receiveShadow = b.receive; m.renderOrder = b.order;
    m.matrixAutoUpdate = false;
    scene.add(m);
    b.geos.forEach((g) => g.dispose());
  }
}

/* ---------- Vegetation: scanned plants, dry grass and maples, instanced ---------- */
// "Scanned Plants and Grass (Free Download)" by Kless, "Simple grass chunks" by 3dhdscan and "Maple tree" by atrodler,
// all CC BY 4.0 on Sketchfab. Each piece becomes one InstancedMesh, scattered in loose clusters off the hard surfaces.
function vegPieces(root) {
  root.updateMatrixWorld(true);
  const out = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    floatGeometry(g);
    g.applyMatrix4(o.matrixWorld);
    g.computeBoundingBox();
    const b = g.boundingBox, c = b.getCenter(new THREE.Vector3()), size = b.getSize(new THREE.Vector3());
    g.translate(-c.x, -b.min.y, -c.z);
    g.computeBoundingSphere();
    const m = o.material.clone();
    m.side = THREE.DoubleSide; m.transparent = false; m.alphaTest = 0.45; m.depthWrite = true;
    if ('roughness' in m) { m.roughness = Math.max(m.roughness ?? 1, 0.85); m.metalness = 0; }
    out.push({ name: o.material.name, geo: g, mat: m, size });
  });
  return out;
}
/** n positions in clusters inside the box, kept where ok(x, z) */
function clusterPoints(n, [x0, x1, z0, z1], ok, rng, { spread = 4, per = 12 } = {}) {
  const pts = [];
  let guard = 0;
  while (pts.length < n && guard++ < n * 40) {
    const cx = x0 + rng() * (x1 - x0), cz = z0 + rng() * (z1 - z0);
    const k = 1 + Math.floor(rng() * per);
    for (let i = 0; i < k && pts.length < n; i++) {
      const a = rng() * Math.PI * 2, r = spread * Math.sqrt(-2 * Math.log(1 - rng() * 0.999)) * 0.5;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (x > x0 && x < x1 && z > z0 && z < z1 && ok(x, z)) pts.push([x, z]);
    }
  }
  return pts;
}
function plantInstances(piece, pts, parent, rng, [s0, s1] = [0.8, 1.3], sink = 0) {
  if (!piece || !pts.length) return null;
  const im = new THREE.InstancedMesh(piece.geo, piece.mat, pts.length);
  const d = new THREE.Object3D();
  pts.forEach(([x, z], i) => {
    const sc = s0 + rng() * (s1 - s0);
    d.position.set(x, -sink * sc, z);
    d.rotation.set((rng() - 0.5) * 0.08, rng() * Math.PI * 2, (rng() - 0.5) * 0.08);
    d.scale.setScalar(sc);
    d.updateMatrix();
    im.setMatrixAt(i, d.matrix);
  });
  im.computeBoundingSphere();
  im.castShadow = false; im.receiveShadow = true;
  im.userData.dynamic = true;
  im.userData.noCast = true;
  parent.add(im);
  return im;
}
async function loadVegetation() {
  const load = (u) => gltfLoader.loadAsync(u).then((g) => g.scene).catch((e) => { console.warn('vegetation', u, e); return null; });
  const [plants, grass, maple] = await Promise.all([load('models/veg_plants.glb'), load('models/veg_grass.glb'), load('models/maple.glb')]);
  const rng = mulberry32(77);
  const P = plants ? vegPieces(plants) : [], G = grass ? vegPieces(grass) : [];
  const pick = (list, name, test = () => true) => list.find((v) => v.name === name && test(v));
  const blades = pick(P, 'Grass_Blades'), cloves = pick(P, 'Grass_Cloves'), dand = pick(P, 'dandelion'), leaf5 = pick(P, '5_leaf_ground_plant');
  const covers = P.filter((v) => v.name === 'Ground_Cover_Bunch'), purple = pick(P, 'Purple_Flower');
  const tuft = pick(G, 'rostlinka_07c', (v) => v.size.x < 1), patch = pick(G, 'rostlinka_07c', (v) => v.size.x >= 1), weeds = pick(G, 'rostlinka12_2k');

  // landside: the campus lawn around the building, off the plaza, path, road and building
  const land = (x, z) => !((Math.abs(x) < 15.8 && z > -0.6 && z < 12.6) || (Math.abs(x) < 2.8 && z < 32.6) || (z > 31.4 && z < 41.6)
    || (Math.abs(x) < 15.5 && z > -24 && z < 1) || (z < -23.2)
    || (z > 29.3 && z < 44.2) || (Math.abs(x) < 17.6 && z > 29 && z < 59.8)); // pavements and the apron across the road
  const front = [-75, 75, -23, 95];
  plantInstances(blades, clusterPoints(2600, front, land, rng, { spread: 3, per: 14 }), scene, rng, [0.7, 1.2]);
  plantInstances(cloves, clusterPoints(1400, front, land, rng, { spread: 2.5, per: 10 }), scene, rng, [0.8, 1.3]);
  plantInstances(dand, clusterPoints(160, front, land, rng, { spread: 3, per: 6 }), scene, rng, [0.7, 1.1]);
  plantInstances(leaf5, clusterPoints(140, front, land, rng, { spread: 2, per: 5 }), scene, rng, [0.6, 1.0]);
  covers.forEach((c) => plantInstances(c, clusterPoints(22, front, (x, z) => land(x, z) && (Math.abs(x) > 18 || z > 14), rng, { spread: 6, per: 3 }), scene, rng, [0.5, 0.8], 0.15));
  plantInstances(purple, clusterPoints(30, front, (x, z) => land(x, z) && Math.abs(x) > 16, rng, { spread: 4, per: 4 }), scene, rng, [0.5, 0.8]);
  plantInstances(tuft, clusterPoints(1600, front, land, rng, { spread: 3, per: 10 }), scene, rng, [0.9, 1.5]);

  // airside: dry tufts and weeds over the dusty infield between the taxiway and the runway, and beyond it
  const conn = AIRSIDE.route?.conn ?? [];
  const infield = (x, z) => conn.every((c) => Math.abs(x - c) > 16) && !(z > -300 && z < -146 && Math.abs(x) > 700);
  const far = (x, z) => [-600, -150, 300].every((c) => Math.abs(x - c) > 16);
  const air = AIRSIDE.root;
  plantInstances(tuft, [...clusterPoints(3200, [-650, 650, -292, -149], infield, rng, { spread: 6, per: 20 }),
    ...clusterPoints(600, [-900, 700, -390, -355], far, rng, { spread: 6, per: 16 }),
    ...clusterPoints(300, [-260, 260, -122.5, -116.5], () => true, rng, { spread: 3, per: 8 })], air, rng, [0.9, 1.8]);
  plantInstances(patch, clusterPoints(70, [-600, 600, -288, -152], infield, rng, { spread: 30, per: 4 }), air, rng, [0.9, 1.6], 0.05);
  plantInstances(weeds, clusterPoints(40, [-500, 500, -288, -152], infield, rng, { spread: 25, per: 3 }), air, rng, [1, 1.5], 0.05);

  // maples: in place of the code-built trees, along the road and around the campus
  if (maple) {
    maple.updateMatrixWorld(true);
    const all = new THREE.Box3().setFromObject(maple), c = all.getCenter(new THREE.Vector3());
    const base = 9 / (all.max.y - all.min.y); // the tree arrives in centimetres: about 9 m tall here
    const spots = [...CODE_TREES.map((t) => [t.position.x, t.position.z]),
      [-26, 26], [26, 27], [-40, 28], [40, 27], [-56, 26], [56, 28], [-30, 47], [30, 46], [-48, 48], [48, 47],
      [-24, -8], [24, -12], [-34, -16], [36, -6]];
    CODE_TREES.forEach((t) => t.removeFromParent());
    const tr = mulberry32(5);
    const mats = spots.map(([x, z]) => {
      const d = new THREE.Object3D();
      d.position.set(x, 0, z); d.rotation.y = tr() * Math.PI * 2; d.scale.setScalar(base * (0.85 + tr() * 0.35));
      d.updateMatrix();
      return d.matrix.clone();
    });
    // bark and leaves share one pivot: seat both on the whole tree's footprint, not their own centres
    maple.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      floatGeometry(g);
      g.applyMatrix4(o.matrixWorld);
      g.translate(-c.x, -all.min.y, -c.z);
      g.computeBoundingSphere();
      const m = o.material.clone();
      m.side = THREE.DoubleSide; m.transparent = false; m.alphaTest = 0.5;
      if ('roughness' in m) { m.roughness = 0.9; m.metalness = 0; }
      if (/leaf/i.test(m.name)) { m.color.set(0x6f8f48); m.alphaTest = 0.55; m.alphaToCoverage = true; } // deeper green, soft card edges
      const im = new THREE.InstancedMesh(g, m, mats.length);
      mats.forEach((mx, i) => im.setMatrixAt(i, mx));
      im.computeBoundingSphere();
      im.userData.dynamic = true;
      im.userData.tree = true;
      scene.add(im);
    });
  }
}

/* ---------- The rest of IGI, and a city all round ---------- */
// More of the VIDP scenery (AvinashC, with permission): T3's main hall and its plant sit where the scenery puts them
// relative to the pier; Terminal 2 and the ATC complex stand behind T3 across the far side, facing the airfield.
const VIDP_S0 = 0.873;
const IGI_CLIP = new THREE.Plane(new THREE.Vector3(0, 0, -1), -415); // keeps z < -415, beyond the far taxiway // the scale the scenery places the pier at; the pier here is drawn at 1, so the rest scale by s / s0
const IGI_EXTRAS = [
  // [file, real offset from the pier east/north in metres, heading, scenery scale] -> placed relative to the pier
  ['vidp_t3ent', 101, 75, 180, 0.886], ['vidp_hvac', 411, -98, 180, 0.873],
];
const IGI_FREE = [
  // [file, scene x, scene z, yaw, scenery scale]: placed by hand, behind T3
  ['vidp_t2', -880, -720, T3P.rot, 0.861], ['vidp_atc', -470, -760, T3P.rot, 0.9],
  ['vidp_atcgp1', -560, -830, T3P.rot, 0.95], ['vidp_atcgp2', -390, -700, T3P.rot, 0.783],
];
async function loadIGI() {
  const load = (f) => gltfLoader.loadAsync(`models/${f}.glb`).then((g) => g.scene).catch((e) => { console.warn('igi', f, e); return null; });
  const prep = (root) => {
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = o.receiveShadow = false;
      for (const m of [].concat(o.material)) if ('roughness' in m) { m.roughness = Math.max(m.roughness ?? 1, 0.6); m.metalness = Math.min(m.metalness ?? 0, 0.3); }
    });
    root.userData.dynamic = true;
    return root;
  };
  const frame = new THREE.Group(); // the pier's own frame: model metres, turned and moved as the pier is
  frame.rotation.y = T3P.rot;
  frame.position.set(T3P.tx, 0.03, T3P.tz);
  frame.userData.dynamic = true;
  AIRSIDE.root.add(frame);
  await Promise.all([
    ...IGI_EXTRAS.map(async ([f, e, n, h, sc]) => {
      const r = await load(f); if (!r) return;
      prep(r);
      // our runway sits closer to T3 than IGI's real one: trim the forecourt end so nothing crosses it
      renderer.localClippingEnabled = true;
      r.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) m.clippingPlanes = [IGI_CLIP]; });
      r.position.set(e / VIDP_S0, 0, -n / VIDP_S0);
      r.rotation.y = -THREE.MathUtils.degToRad(h - 180);
      r.scale.setScalar(sc / VIDP_S0);
      frame.add(r);
    }),
    ...IGI_FREE.map(async ([f, x, z, yaw, sc]) => {
      const r = await load(f); if (!r) return;
      prep(r);
      r.position.set(x, 0.03, z);
      r.rotation.y = yaw;
      r.scale.setScalar(sc / VIDP_S0);
      AIRSIDE.root.add(r);
    }),
  ]);
}

/** windows for the city blocks: lit at dusk, some dark, a few with the blinds down */
function cityFacade(base, frame, seed) {
  const rnd = mulberry32(seed);
  return canvasTex(256, 512, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    for (let y = 8; y < h - 8; y += 21) {
      g.fillStyle = frame; g.fillRect(0, y + 15, w, 4);
      for (let x = 6; x < w - 6; x += 18) {
        const r = rnd();
        g.fillStyle = r < 0.32 ? `rgba(255,${200 + (rnd() * 40) | 0},${130 + (rnd() * 60) | 0},${0.75 + rnd() * 0.25})` : r < 0.4 ? '#cfc6b4' : '#2b3340';
        g.fillRect(x, y, 12, 13);
      }
    }
  });
}
/** a ring of city blocks: a near belt around the campus and a far belt round the whole airfield, fading into the haze */
function buildCity(air) {
  const rnd = mulberry32(404);
  const styles = [
    { tex: cityFacade('#b9ab92', '#8f846f', 1), color: 0xffffff }, // sandstone
    { tex: cityFacade('#5d6f82', '#3d4a58', 2), color: 0xffffff }, // glass offices
    { tex: cityFacade('#d9d2c4', '#a8a091', 3), color: 0xffffff }, // white plaster
    { tex: cityFacade('#9a6d55', '#7a5443', 4), color: 0xffffff }, // brick
  ];
  const lots = styles.map(() => []);
  const free = (x, z) => {
    // keep off the campus, the road, the airfield and its approach
    if (z > -40 && z < 75 && Math.abs(x) < 82) return false;
    if (z < -20 && z > -1080 && x > -2000 && x < 1250) return false; // the airside
    if (Math.abs(z + 322) < 120 && x > 700 && x < 1800) return false; // approach lights
    return true;
  };
  const add = (x, z, w, d, h) => { if (free(x, z)) lots[(rnd() * styles.length) | 0].push([x, z, w, d, h]); };
  // near belt: streets of 6-14 storey blocks round the campus, tallest further out
  for (let x = -330; x <= 330; x += 34) for (let z = 82; z <= 380; z += 32) add(x + (rnd() - 0.5) * 6, z + (rnd() - 0.5) * 6, 18 + rnd() * 10, 16 + rnd() * 10, 14 + rnd() * 18 + (z - 82) * 0.06);
  for (const sx of [-1, 1]) for (let x = 92; x <= 330; x += 34) for (let z = -18; z <= 80; z += 30) add(sx * (x + rnd() * 6), z, 18 + rnd() * 10, 16 + rnd() * 8, 12 + rnd() * 16);
  // far belt: round the whole field, 600 m to 1.4 km out, taller with distance
  for (let i = 0; i < 520; i++) {
    const a = rnd() * Math.PI * 2, r = 700 + rnd() * 700;
    const x = -350 + Math.cos(a) * r * 1.6, z = -500 + Math.sin(a) * r;
    add(x, z, 24 + rnd() * 30, 22 + rnd() * 30, 18 + rnd() * rnd() * 70);
  }
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  const d = new THREE.Object3D();
  styles.forEach((st, k) => {
    const list = lots[k];
    if (!list.length) return;
    st.tex.wrapS = st.tex.wrapT = THREE.RepeatWrapping;
    const mat = new THREE.MeshStandardMaterial({ map: st.tex, emissive: 0xffffff, emissiveMap: st.tex, emissiveIntensity: 0.18, roughness: 0.85 });
    // windows at true size: one texture tile is 36 m wide and 24 storeys (79 m) tall, whatever the block's size
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
        vec3 isc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vec2 wuv = vec2(uv.x * (abs(normal.x) > 0.5 ? isc.z : isc.x) / 36.0, uv.y * isc.y / 79.0);
        #ifdef USE_MAP
          vMapUv = wuv;
        #endif
        #ifdef USE_EMISSIVEMAP
          vEmissiveMapUv = wuv;
        #endif`);
    };
    const roof = new THREE.MeshStandardMaterial({ color: [0x8d877c, 0x6f747a, 0xa29d93, 0x7d6a5f][k], roughness: 0.95 });
    const near = new THREE.InstancedMesh(geo, [mat, mat, roof, roof, mat, mat], list.length);
    list.forEach(([x, z, w, dd, h], i) => {
      d.position.set(x, 0, z); d.rotation.set(0, (rnd() - 0.5) * 0.12, 0); d.scale.set(w, h, dd); d.updateMatrix();
      near.setMatrixAt(i, d.matrix);
    });
    near.computeBoundingSphere();
    near.userData.dynamic = true;
    near.userData.noCast = true;
    scene.add(near); // landside and airside both see them
  });
}

/* ---------- The street outside the gate: pavements, median, autos, a bhel-puri cart ---------- */
// Models from Sketchfab (CC BY 4.0): "Autorikshaw - Indian Tuk Tuk" by bhagathartworks, "Indian Ricksha" and
// "Indian Shop" by anandmohan662, "Bhelpuri Shop By Ajay" by AJ_AY, "Indian Post Box" by Geeky_,
// "Road Divider Indian Version" by Artistio. Traffic keeps left: +x on the campus side, -x on the far side.
const ROAD = { z: 36.5, half: 4.5, gate: 5 };
const STREET = { movers: [] };
/** pavements both sides with painted kerbs, built with the static scene (so the grass mask sees them) */
function buildStreetStatic() {
  const pave = M.paving.clone(); pave.map = repeatOf(M.paving.map, 260 / 2.4, 2.4 / 2.4);
  PAVED.push(pave);
  const kerbY = new THREE.MeshStandardMaterial({ color: 0xe0b52a, roughness: 0.8 }), kerbK = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.8 });
  for (const side of [-1, 1]) {
    const zk = ROAD.z + side * ROAD.half; // kerb line
    panel(260, 2.4, pave, 0, 0.012, zk + side * 1.2, 'up');
    if (side > 0) { // a paved apron across the road, where the walk begins (a bus stop's worth of space)
      const apron = M.paving.clone(); apron.map = repeatOf(M.paving.map, 34 / 2.4, 16 / 2.4); PAVED.push(apron);
      panel(34, 16, apron, 0, 0.011, zk + 2.4 + 8, 'up');
    }
    for (let x = -130; x < 130; x += 1) {
      if (side < 0 && Math.abs(x + 0.5) < 2.6) continue; // the gate's dropped kerb
      box(1, 0.15, 0.22, (Math.floor(x) & 1) ? kerbY : kerbK, x + 0.5, 0.075, zk + side * 0.11);
    }
  }
}
function seatModel(root, { height, length, keepLongest } = {}) {
  root.updateMatrixWorld(true);
  if (keepLongest) { // a kit of pieces: keep the longest one
    let best = null, bestL = 0;
    for (const c of root.getObjectByProperty('name', 'RootNode')?.children ?? []) {
      const b = new THREE.Box3().setFromObject(c), z = b.getSize(new THREE.Vector3()), L = Math.max(z.x, z.z);
      if (z.y > 0.05 && L > bestL) { bestL = L; best = c; }
    }
    if (best) for (const c of [...best.parent.children]) if (c !== best) c.removeFromParent();
  }
  root.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) if ('roughness' in m) { m.roughness = Math.max(m.roughness ?? 1, 0.6); m.metalness = Math.min(m.metalness ?? 0, 0.3); } });
  root.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(root), c = b.getCenter(new THREE.Vector3()), z = b.getSize(new THREE.Vector3());
  const inner = new THREE.Group(); inner.add(root);
  root.position.set(-c.x, -b.min.y, -c.z);
  const w = new THREE.Group(); w.add(inner);
  const sc = height ? height / z.y : length ? length / Math.max(z.x, z.z) : 1;
  w.scale.setScalar(sc);
  w.userData.size = z.clone().multiplyScalar(sc);
  return w;
}
function person(shirt) {
  const g = crewman();
  const m = new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.85 });
  g.traverse((o) => { if (o.isMesh && o.material === CREW.vest) o.material = m; });
  g.children.forEach((c) => { if (c.isMesh && c.material === CREW.helmet) c.visible = false; });
  return g;
}
async function loadStreet() {
  const load = (f) => gltfLoader.loadAsync(`models/${f}.glb`).then((g) => g.scene).catch((e) => { console.warn('street', f, e); return null; });
  const [auto, ricksha, bhel, shop, postbox, divider] = await Promise.all(['st_auto', 'st_ricksha', 'st_bhel', 'st_shop', 'st_postbox', 'st_divider'].map(load));
  const g = new THREE.Group(); g.userData.dynamic = true; scene.add(g);
  const put = (m, x, z, yaw) => { if (!m) return null; const c = m.clone(); c.position.set(x, 0, z); c.rotation.y = yaw; g.add(c); return c; };
  // the median down the middle, with a gap at the gate
  if (divider) {
    const d = seatModel(divider, { keepLongest: true }), z = d.userData.size;
    const along = z.x >= z.z ? 0 : Math.PI / 2, L = Math.max(z.x, z.z);
    for (let x = -130 + L / 2; x < 130; x += L) if (Math.abs(x) - L / 2 > ROAD.gate) put(d, x, ROAD.z, along);
  }
  // the bhel-puri cart by the gate, people at it; the post box; corner shops across the road
  const cart = bhel && seatModel(bhel, { height: 2.6 });
  put(cart, 8.5, ROAD.z - ROAD.half - 1.25, 0); // painted front to the street
  const shirts = [0xd94a4a, 0x3a6fb5, 0xf2f0ea, 0x6b4c9a, 0x2f7d5c, 0xe0a030];
  [[6.9, 30.6, -1.2], [7.6, 29.9, -0.4], [10.3, 30.4, 1.3], [-6.5, 30.7, 0.3]].forEach(([x, z, yaw], i) => { const p = person(shirts[i]); p.position.set(x, 0, z); p.rotation.y = yaw; g.add(p); });
  const box = postbox && seatModel(postbox, { height: 1.5 });
  put(box, 4.0, ROAD.z - ROAD.half - 1.6, 0);
  const kirana = shop && seatModel(shop, { height: 5.6 });
  if (kirana) for (const x of [-16, 21]) put(kirana, x, ROAD.z + ROAD.half + 2.4 + kirana.userData.size.x / 2, Math.PI / 2);
  // an auto stand by the gate
  const tuk = auto && seatModel(auto, { length: 2.65 });
  if (tuk) for (const [x, z] of [[-11, 33.3], [-14.3, 33.3], [-17.6, 33.4]]) put(tuk, x, z, -Math.PI / 2);
  // moving traffic: autos both ways, a cycle rickshaw at walking pace, pedestrians on the pavements
  const cyc = ricksha && seatModel(ricksha, { length: 3.0 });
  const lane = (dir) => ROAD.z - dir * 2.3;
  const run = (m, dir, speed, x0, yawFor) => { const c = put(m, x0, lane(dir), yawFor(dir)); if (c) STREET.movers.push({ g: c, dir, speed, x0, z: lane(dir) }); };
  if (tuk) { run(tuk, 1, 9, -60, (d) => (d > 0 ? -Math.PI / 2 : Math.PI / 2)); run(tuk, -1, 8, 40, (d) => (d > 0 ? -Math.PI / 2 : Math.PI / 2)); run(tuk, -1, 10.5, -90, (d) => (d > 0 ? -Math.PI / 2 : Math.PI / 2)); }
  if (cyc) run(cyc, 1, 3.2, 20, (d) => (d > 0 ? Math.PI / 2 : -Math.PI / 2));
  [[1, 1.3, -40, 0x2f5f9e], [-1, 1.4, 30, 0xb84a3a], [1, 1.2, 70, 0xe8e2d4]].forEach(([dir, sp, x0, c]) => {
    const p = person(c); g.add(p);
    STREET.movers.push({ g: p, dir, speed: sp, x0, z: ROAD.z + (dir > 0 ? -1 : 1) * (ROAD.half + 1.3), walk: true });
  });
}
function updateStreet(now) {
  if (!STREET.movers.length || camera.position.z < -14) return;
  const t = now / 1000;
  for (const m of STREET.movers) {
    const span = 280, x = ((m.x0 + 140 + m.dir * m.speed * t) % span + span) % span - 140;
    m.g.position.set(x, m.walk ? Math.abs(Math.sin(t * 7 + m.x0)) * 0.04 : 0, m.z);
    if (m.walk) m.g.rotation.y = m.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
  }
}

/* ---------- Neighbours: the plots around the campus ---------- */
// "Futuristic Building" by 3DHaupt (CC BY-NC 4.0) and "3d low poly buidling" by Mahreen (CC BY 4.0), Sketchfab.
async function loadNeighbours() {
  const load = (u) => gltfLoader.loadAsync(u).then((g) => g.scene).catch((e) => { console.warn('building', u, e); return null; });
  const [ops, brick] = await Promise.all([load('models/bldg_futuristic.glb'), load('models/bldg_lowpoly.glb')]);
  const seat = (root, scale) => { // drop any display plate, then stand the model on the ground at its footprint's centre
    root.updateMatrixWorld(true);
    const plates = [];
    root.traverse((o) => { if (o.isMesh) { const b = new THREE.Box3().setFromObject(o), z = b.getSize(new THREE.Vector3()); if (z.y < 0.6 && z.x > 12 && z.z > 12) plates.push(o); } });
    plates.forEach((o) => o.removeFromParent());
    root.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) if ('roughness' in m) { m.roughness = Math.max(m.roughness ?? 1, 0.7); m.metalness = Math.min(m.metalness ?? 0, 0.2); } });
    const b = new THREE.Box3().setFromObject(root), c = b.getCenter(new THREE.Vector3());
    const inner = new THREE.Group();
    inner.add(root);
    root.position.set(-c.x, -b.min.y, -c.z);
    const w = new THREE.Group();
    w.add(inner);
    w.scale.setScalar(scale);
    return w;
  };
  const place = (model, spots) => {
    if (!model) return;
    const g = new THREE.Group();
    for (const [x, z, yaw] of spots) { const c = model.clone(); c.position.set(x, 0, z); c.rotation.y = yaw; g.add(c); }
    const baked = bakeGroup(g);
    baked.userData.dynamic = true;
    scene.add(baked);
  };
  // the ops block with its mast on either flank; brick blocks along the far side of the road
  place(ops && seat(ops, 1), [[-78, 6, Math.PI / 2]]);
  const row = [];
  for (let x = -76; x <= 76; x += 11.5) if (Math.abs(x) > 4) row.push([x, 63 + (Math.abs(x) % 3), (Math.round(x) % 2) * 0.03]); // across the road
  for (const sx of [-1, 1]) for (let z = -18; z <= 52; z += 11.5) if (!(sx < 0 && Math.abs(z - 6) < 16)) row.push([sx * 72, z, sx > 0 ? -Math.PI / 2 : Math.PI / 2]); // the flanks
  place(brick && seat(brick, 1.7), row);
}

/* ---------- Grass: real blades on every unpaved surface ---------- */
// A top-down mask of the scene says where grass may grow (red) and how lush it is (green: campus lawn vs dry airfield).
// Two instanced layers of blade clumps follow the camera: each clump keeps a fixed world position (its offset wraps
// around the camera), so nothing swims; clumps fade to nothing toward the layer's edge, where the ground texture takes over.
const GRASS = { layers: [], mask: null, box: { x0: -2300, x1: 1700, z0: -1500, z1: 200 } };
function grassMask() {
  const { x0, x1, z0, z1 } = GRASS.box, W = x1 - x0, H = z1 - z0;
  const pxW = 2000, pxH = Math.round(pxW * H / W);
  const rt = new THREE.WebGLRenderTarget(pxW, pxH);
  const cam = new THREE.OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, 1, 2000);
  cam.up.set(0, 0, -1);
  cam.position.set((x0 + x1) / 2, 900, (z0 + z1) / 2);
  cam.lookAt((x0 + x1) / 2, 0, (z0 + z1) / 2);
  const lush = new THREE.MeshBasicMaterial({ color: 0xffff00, side: THREE.DoubleSide });
  const dry = new THREE.MeshBasicMaterial({ color: 0xff3300, side: THREE.DoubleSide });
  const none = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
  const lawns = new Set(LAWN), fields = new Set(AIRFIELD);
  const swapped = [], hidden = [];
  const airWas = AIRSIDE.root.visible;
  AIRSIDE.root.visible = true;
  for (const m of AIRSIDE.movers) if (m.g.visible) { m.g.visible = false; hidden.push(m.g); }
  scene.traverse((o) => {
    if (o.isPoints || o.isSprite || o.isLine) { if (o.visible) { o.visible = false; hidden.push(o); } return; }
    if (!o.isMesh || o === GRASS.skip) return;
    swapped.push([o, o.material]);
    o.material = lawns.has(o.material) ? lush : fields.has(o.material) ? dry : none;
  });
  const bg = scene.background, fog = scene.fog;
  scene.background = new THREE.Color(0x000000); scene.fog = null;
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  const px = new Uint8Array(pxW * pxH * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, pxW, pxH, px);
  renderer.setRenderTarget(null);
  scene.background = bg; scene.fog = fog;
  swapped.forEach(([o, m]) => { o.material = m; });
  hidden.forEach((o) => { o.visible = true; });
  AIRSIDE.root.visible = airWas;
  rt.dispose(); lush.dispose(); dry.dispose(); none.dispose();
  const tex = new THREE.DataTexture(px, pxW, pxH, THREE.RGBAFormat);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex; // row 0 is the +z edge (the view's bottom), column 0 the -x edge
}
/** a clump of tapered blades, up to 1 unit tall (position.y doubles as the root-to-tip fraction); detailed blades have a
    bend (3 triangles), far ones are a single triangle */
function bladeClump(blades, detailed) {
  const pos = [], idx = [];
  const rnd = mulberry32(9);
  for (let b = 0; b < blades; b++) {
    const a = rnd() * Math.PI * 2, r = rnd() * 0.08, lean = 0.12 + rnd() * 0.22, w = 0.03 + rnd() * 0.02, h = 0.6 + rnd() * 0.4;
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r, dx = Math.cos(a + 1.3), dz = Math.sin(a + 1.3), lx = Math.cos(a) * lean, lz = Math.sin(a) * lean;
    const base = pos.length / 3;
    pos.push(cx - dx * w, 0, cz - dz * w, cx + dx * w, 0, cz + dz * w);
    if (detailed) {
      pos.push(cx - dx * w * 0.7 + lx * 0.35, h * 0.5, cz - dz * w * 0.7 + lz * 0.35, cx + dx * w * 0.7 + lx * 0.35, h * 0.5, cz + dz * w * 0.7 + lz * 0.35);
      pos.push(cx + lx, h, cz + lz);
      idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4);
    } else {
      pos.push(cx + lx, h, cz + lz);
      idx.push(base, base + 1, base + 2);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}
function grassLayer(size, count, height, seed, blades, detailed) {
  const geo = bladeClump(blades, detailed);
  const off = new Float32Array(count * 4), rnd = mulberry32(seed);
  for (let i = 0; i < count; i++) { off[i * 4] = rnd() * size; off[i * 4 + 1] = rnd() * size; off[i * 4 + 2] = rnd(); off[i * 4 + 3] = rnd(); }
  geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4));
  geo.instanceCount = count;
  const { x0, x1, z0, z1 } = GRASS.box;
  const u = {
    uCam: { value: new THREE.Vector2() }, uTime: { value: 0 }, uSize: { value: size }, uHeight: { value: height },
    uMask: { value: GRASS.mask }, uBox: { value: new THREE.Vector4(x0, z1, x1 - x0, z1 - z0) },
  };
  const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aOff; uniform vec2 uCam; uniform float uTime, uSize, uHeight; uniform sampler2D uMask; uniform vec4 uBox;
        varying float vTip; varying float vLush; varying float vHash; varying float vPatch;`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace('#include <begin_vertex>', `
        vec2 wp = uCam + mod(aOff.xy - uCam + 0.5 * uSize, uSize) - 0.5 * uSize;
        vec2 muv = vec2((wp.x - uBox.x) / uBox.z, (uBox.y - wp.y) / uBox.w);
        vec4 mk = texture2D(uMask, muv);
        float inside = step(0.0, muv.x) * step(muv.x, 1.0) * step(0.0, muv.y) * step(muv.y, 1.0);
        float d = distance(wp, uCam);
        float fade = smoothstep(0.5 * uSize, 0.36 * uSize, d);
        float grow = smoothstep(0.55, 0.85, mk.r) * inside;
        float h = uHeight * (0.6 + aOff.w * 0.8) * mix(0.8, 1.15, mk.g) * fade * grow;
        float ang = aOff.z * 6.2831853, c = cos(ang), sn = sin(ang);
        vec3 transformed = vec3(position);
        float tip = position.y;
        transformed.y *= h;
        transformed.xz *= (0.75 + aOff.w * 0.6) * step(0.001, h) * (h / max(uHeight, 0.001) * 0.6 + 0.4);
        transformed.xz = vec2(c * transformed.x - sn * transformed.z, sn * transformed.x + c * transformed.z);
        float gust = sin(uTime * 1.3 + wp.x * 0.11 + wp.y * 0.07) * 0.5 + 0.5;
        float sway = (sin(uTime * 2.1 + wp.x * 0.8 + wp.y * 0.6) * 0.6 + gust * 0.9) * tip * tip * h * 0.35;
        transformed.x += sway; transformed.z += sway * 0.4;
        transformed.xz += wp;
        vTip = tip; vLush = mk.g; vHash = aOff.w;
        vPatch = sin(wp.x * 0.043 + sin(wp.y * 0.031) * 2.0) * sin(wp.y * 0.052 + 1.7) * 0.5 + 0.5;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vTip; varying float vLush; varying float vHash; varying float vPatch;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 lushBase = vec3(0.035, 0.07, 0.02), lushTip = mix(vec3(0.20, 0.33, 0.07), vec3(0.30, 0.40, 0.10), vPatch);
        // dry airfield grass: straw, olive and a few greener patches where the ground holds water
        vec3 dryBase = vec3(0.09, 0.085, 0.04);
        vec3 dryTip = mix(vec3(0.42, 0.36, 0.19), vec3(0.27, 0.30, 0.12), smoothstep(0.35, 0.8, vPatch));
        vec3 base = mix(dryBase, lushBase, vLush), tipc = mix(dryTip, lushTip, vLush);
        tipc *= 0.8 + vHash * 0.35;
        diffuseColor.rgb = mix(base, tipc, smoothstep(0.0, 0.9, vTip));`);
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.userData.dynamic = true;
  mesh.userData.noCast = true;
  mesh.receiveShadow = true;
  mesh.userData.u = u;
  scene.add(mesh);
  GRASS.layers.push(mesh);
}
function buildGrass(skyMesh) {
  GRASS.skip = skyMesh;
  GRASS.mask = grassMask();
  // near: dense bent blades for the lawn walk and the apron; far: a wider carpet of simple blades out across the airfield
  grassLayer(34, 22000, 0.42, 11, 4, true);
  grassLayer(100, 45000, 0.5, 13, 4, false);
  grassLayer(260, 80000, 0.6, 12, 3, false);
}
function updateGrass(now) {
  for (const m of GRASS.layers) { m.userData.u.uCam.value.set(camera.position.x, camera.position.z); m.userData.u.uTime.value = now / 1000; }
}

/* ---------- Scroll ---------- */
let targetP = 0, p = 0;
let lenis = null;
function setupScroll() {
  if (!reduceMotion) {
    lenis = new Lenis({ lerp: 0.08, smoothWheel: true });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
  }
  ScrollTrigger.create({
    trigger: '#track', start: 'top top', end: 'bottom bottom',
    onUpdate: (s) => { targetP = s.progress; },
  });
  targetP = ScrollTrigger.maxScroll(window) ? scrollY / ScrollTrigger.maxScroll(window) : 0;
  p = targetP;
  gsap.ticker.add(frame);
}

const caps = [...document.querySelectorAll('.cap')].map((el) => ({
  el, a: +el.dataset.in, b: +el.dataset.hold, c: +el.dataset.out,
}));
const progressFill = document.getElementById('progressFill');

/* ---------- Pointer parallax (tiny) ---------- */
const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
addEventListener('pointermove', (e) => {
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = (e.clientY / innerHeight) * 2 - 1;
}, { passive: true });

/* ---------- Doors A and B: click to step inside ---------- */
// Course copy follows the AviationSpot360 project brief (sections 8 and 10).
const COURSES = {
  A: {
    eyebrow: 'Room A', title: 'Cadet Prep', side: 'right',
    lede: 'A dedicated pathway for airline cadet-pilot programme applicants, kept separate from the general DGCA question bank.',
    points: ['Aptitude, reasoning, numerical and verbal practice', 'Interview preparation and group-discussion guidance', 'Practice material for each selection stage', 'Programme updates with dates and sources'],
    via: [[-1.2, 1.62, -12.2], [-1.65, 1.62, -13.7], [-1.9, 1.62, -14.7]], pos: [-2.75, 1.62, -15.5], look: [-4.2, 1.45, -22.2],
  },
  B: {
    eyebrow: 'Room B', title: '1-on-1 Mentorship', side: 'left', engine: true,
    lede: 'Book time with a mentor for career guidance, subject doubts or a full mentorship programme, without long message threads.',
    points: ['General career and flight-training guidance', 'Subject-specific doubt-clearing sessions', 'Self-study mentorship with recorded classes', 'Pick an open slot, then confirm your booking'],
    via: [[1.2, 1.62, -12.2], [1.65, 1.62, -13.7], [1.9, 1.62, -14.7]], pos: [2.7, 1.62, -15.4], look: [4.7, 1.2, -19.9],
  },
  // Door C follows the brief's flight-training discovery section (9).
  C: {
    eyebrow: 'Door C · Airside', title: 'Flight-training discovery', side: 'right',
    lede: 'Step airside and explore where you could fly next: flight training organisations and partner schools in different countries, side by side.',
    points: ['FTOs by country and location, including partner schools', 'Training programmes and licence pathways offered', 'Facilities and fleet information where verified', 'Entry requirements, indicative duration and costs'],
    // out the back door, up the spotters' stair, onto the deck
    via: [[0, 1.62, -12.0], [0, 1.62, -14.3], [0, 1.64, -18.5], [0, 1.66, -22.6], [0.6, 1.7, -24.8], [2.3, 1.8, -26.4], [4.5, 3.4, -27.0], [9.5, 7.0, -27.0], [12.8, 9.55, -27.1], [14.6, 9.7, -27.6], [15.8, 11, -40], [-20, 34, -150], [-220, 36, -320], [-400, 22, -410]],
    // then lift off the deck, cross the runway and settle beside Terminal 3's pier with the gates in view
    pos: [-470, 13, -436], look: [-170, 1, -505],
    doorLook: [0, 1.6, -40], split: 0.5, dur: 12,
  },
};
let activeRoom = null;
let mode = 'walk'; // 'walk' | 'moving' | 'room' | 'screen'

/* ---------- The turbofan on the mentor's desk, and the teardown simulator it opens ---------- */
// The desk model is "Jet Engine" by Pilot (sketchfab.com/playerhack), CC BY 4.0, with its own idle animation turning
// the fan. engine/cfm56.html is the CFM56-5B4 simulator built with the teardown kit from coaching-centre/sims/.
const DESK_ENGINE = { pos: new THREE.Vector3(), mixer: null, hit: null };
function loadDeskEngine() {
  gltfLoader.loadAsync('models/jet_engine.glb').then((gltf) => {
    const m = gltf.scene, s = 0.42 / 13.97; // the source is 13.97 units long, centred at (-0.8, 4.0, -0.59)
    m.scale.setScalar(s);
    m.position.set(0.8 * s, -0.25 * s, 0.59 * s);
    m.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; } });
    const g = new THREE.Group();
    g.add(m);
    g.position.copy(DESK_ENGINE.pos);
    g.rotation.y = 0.55;
    g.userData.dynamic = true;
    scene.add(g);
    DESK_ENGINE.mixer = new THREE.AnimationMixer(m);
    const idle = gltf.animations.find((a) => a.name === 'idle');
    if (idle) DESK_ENGINE.mixer.clipAction(idle).play();
    const hit = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.26, 0.24), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    hit.position.set(0, 0.12, 0);
    g.add(hit);
    DESK_ENGINE.hit = hit;
  }).catch((e) => console.warn('desk engine', e));
}
const engineOv = document.getElementById('engineOv');
const engineFrame = engineOv.querySelector('iframe');
let engineOpen = false;
function openEngine() {
  if (engineOpen) return;
  engineOpen = true;
  if (!engineFrame.src) engineFrame.src = 'engine/cfm56.html';
  engineOv.hidden = false;
  requestAnimationFrame(() => engineOv.classList.add('is-open'));
  document.getElementById('engineClose').focus({ preventScroll: true });
}
function closeEngine() {
  if (!engineOpen) return;
  engineOpen = false;
  engineOv.classList.remove('is-open');
  setTimeout(() => { if (!engineOpen) engineOv.hidden = true; }, 350);
}
document.getElementById('engineClose').addEventListener('click', closeEngine);
document.getElementById('engineOpen').addEventListener('click', openEngine);
function engineAt(x, y) {
  if (mode !== 'room' || activeRoom !== 'B' || !DESK_ENGINE.hit) return false;
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  return ray.intersectObject(DESK_ENGINE.hit, false).length > 0;
}
let roomTl = null, hovered = null;
const roomCam = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
const lastWalk = { pos: new THREE.Vector3(0, 1.6, -9.3), look: new THREE.Vector3(0, 1.4, -14) };
const html = document.documentElement;
const card = document.getElementById('roomCard');

function enterRoom(id) {
  if (mode !== 'walk' || !DOORS[id]) return;
  const c = COURSES[id];
  mode = 'moving';
  setHover(null);
  lenis?.stop();
  html.classList.add('in-room');
  const startLook = lastWalk.look.clone();
  activeRoom = id;
  const doorLook = c.doorLook ? new THREE.Vector3(...c.doorLook) : new THREE.Vector3(DOOR_X[id], 1.45, -16);
  const split = c.split ?? 0.5;
  const endLook = new THREE.Vector3(...c.look);
  const curve = new THREE.CatmullRomCurve3([lastWalk.pos.clone(), ...c.via.map((v) => new THREE.Vector3(...v)), new THREE.Vector3(...c.pos)], false, 'centripetal');
  const st = { t: 0 };
  const apply = () => {
    curve.getPointAt(st.t, roomCam.pos);
    const a = smooth(clamp01(st.t / split)), b = smooth(clamp01((st.t - split) / (1 - split)));
    roomCam.look.lerpVectors(startLook, doorLook, a).lerp(endLook, b);
  };
  apply();
  roomTl = gsap.timeline({
    onComplete: () => { mode = 'room'; showCard(id); },
    onReverseComplete: () => { mode = 'walk'; roomTl = null; activeRoom = null; html.classList.remove('in-room'); lenis?.start(); },
  });
  roomTl.to(DOORS[id], { open: 1, duration: 1.2, ease: 'power2.inOut' }, 0)
    .to(st, { t: 1, duration: reduceMotion ? 0.3 : c.dur ?? 3.4, ease: 'power2.inOut', onUpdate: apply }, 0.35);
}
function leaveRoom() {
  if ((mode !== 'room' && mode !== 'screen') || !roomTl) return;
  if (mode === 'room') hideCard();
  if (mode === 'screen') hideRadarUi();
  mode = 'moving';
  roomTl.timeScale(1.3).reverse();
}

/* ---------- Live radar: fly up to the lounge screen ---------- */
const radarUi = document.getElementById('radarUi');
/** Where the camera stands so the whole screen fits, whatever the window shape. */
function screenViewPoint() {
  const s = TRAFFIC.screen, W = 2.3, H = W * 9 / 16, m = 0.14;
  const tv = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const d = Math.max((H / 2 + m) / tv, (W / 2 + m) / (tv * camera.aspect));
  return new THREE.Vector3(s.position.x - d, s.position.y, s.position.z);
}
function viewScreen() {
  if (mode !== 'walk' || !TRAFFIC.screen) return;
  mode = 'moving';
  setHover(null);
  lenis?.stop();
  html.classList.add('in-room', 'at-screen');
  TRAFFIC.focus = true; TRAFFIC.drawAt = 0;
  const start = lastWalk.pos.clone(), startLook = lastWalk.look.clone();
  const target = screenViewPoint(), screenLook = TRAFFIC.screen.position.clone();
  const pts = [start];
  if (start.z > -0.6) pts.push(new THREE.Vector3(0, 1.64, Math.min(start.z - 0.5, 1.6)), new THREE.Vector3(0.4, 1.66, -1.8)); // in through the entrance first
  pts.push(new THREE.Vector3((start.x + target.x) / 2, (start.y + target.y) / 2, (Math.min(start.z, -1.8) + target.z) / 2 + 0.6), target);
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const st = { t: 0 };
  const apply = () => {
    curve.getPointAt(st.t, roomCam.pos);
    roomCam.look.lerpVectors(startLook, screenLook, smooth(clamp01(st.t * 1.4)));
  };
  apply();
  const dur = reduceMotion ? 0.3 : Math.min(5, 1.8 + curve.getLength() * 0.12);
  roomTl = gsap.timeline({
    onComplete: () => { mode = 'screen'; showRadarUi(); },
    onReverseComplete: () => {
      mode = 'walk'; roomTl = null; TRAFFIC.focus = false; TRAFFIC.cycleAt = performance.now() + 30000;
      html.classList.remove('in-room', 'at-screen'); lenis?.start();
    },
  });
  roomTl.to(st, { t: 1, duration: dur, ease: 'power2.inOut', onUpdate: apply });
}
function showRadarUi() {
  radarUi.hidden = false;
  requestAnimationFrame(() => radarUi.classList.add('is-open'));
  radarUi.querySelector(`[data-ap="${TRAFFIC.idx}"]`)?.focus({ preventScroll: true });
}
function hideRadarUi() {
  radarUi.classList.remove('is-open');
  setTimeout(() => { if (!radarUi.classList.contains('is-open')) radarUi.hidden = true; }, 400);
}
document.getElementById('radarOpen').addEventListener('click', viewScreen);
document.getElementById('radarBack').addEventListener('click', leaveRoom);
radarUi.querySelectorAll('[data-ap]').forEach((b) => b.addEventListener('click', () => selectAirspace(+b.dataset.ap)));
addEventListener('keydown', (e) => { if (mode === 'screen' && ['1', '2', '3'].includes(e.key)) selectAirspace(+e.key - 1); });

function showCard(id) {
  const c = COURSES[id];
  card.querySelector('[data-f="eyebrow"]').textContent = c.eyebrow;
  card.querySelector('[data-f="title"]').textContent = c.title;
  card.querySelector('[data-f="lede"]').textContent = c.lede;
  card.querySelector('[data-f="points"]').replaceChildren(...c.points.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
  card.dataset.side = c.side;
  document.getElementById('engineOpen').hidden = !c.engine;
  setCardCollapsed(false);
  card.hidden = false;
  requestAnimationFrame(() => card.classList.add('is-open'));
  document.getElementById('roomBack').focus({ preventScroll: true });
}
function hideCard() {
  card.classList.remove('is-open');
  setTimeout(() => { if (!card.classList.contains('is-open')) card.hidden = true; }, 500);
}
function setCardCollapsed(on) {
  card.classList.toggle('is-collapsed', on);
  const t = document.getElementById('roomToggle');
  t.setAttribute('aria-expanded', String(!on));
  t.querySelector('[data-label]').textContent = on ? 'Details' : 'Hide';
}
document.getElementById('roomToggle').addEventListener('click', () => setCardCollapsed(!card.classList.contains('is-collapsed')));
document.getElementById('roomBack').addEventListener('click', leaveRoom);
addEventListener('keydown', (e) => { if (e.key !== 'Escape') return; if (engineOpen) closeEngine(); else leaveRoom(); });
document.querySelectorAll('[data-room]').forEach((b) => b.addEventListener('click', () => enterRoom(b.dataset.room)));

// Pointer picking on the door leaves, only once the walk has arrived in front of them
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function doorAt(x, y) {
  if (mode !== 'walk' || p < 0.82 || !DOORS.A) return null;
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(Object.values(DOORS).map((d) => d.leaf), false)[0];
  return hit ? hit.object.userData.room : null;
}
function setHover(id) {
  if (id === hovered) return;
  hovered = id;
  canvas.style.cursor = id ? 'pointer' : '';
  for (const [k, d] of Object.entries(DOORS)) gsap.to(d, { hover: k === id ? 1 : 0, duration: 0.35 });
}
function screenAt(x, y) {
  if (mode !== 'walk' || !TRAFFIC.screen) return false;
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  return ray.intersectObject(TRAFFIC.screen, false).length > 0;
}
canvas.addEventListener('pointermove', (e) => {
  const door = doorAt(e.clientX, e.clientY);
  setHover(door);
  if (!door) canvas.style.cursor = screenAt(e.clientX, e.clientY) || engineAt(e.clientX, e.clientY) ? 'pointer' : '';
});
canvas.addEventListener('click', (e) => {
  const id = doorAt(e.clientX, e.clientY);
  if (id) return enterRoom(id);
  if (screenAt(e.clientX, e.clientY)) viewScreen();
  else if (engineAt(e.clientX, e.clientY)) openEngine();
});

/* ---------- Frame ---------- */
const tmpLook = new THREE.Vector3();
const right = new THREE.Vector3();
let lastCapP = -1;
let frames = 0, slowTime = 0, lastT = performance.now();
function frame() {
  // Drop resolution once if this device can't keep up
  const now = performance.now(), dt = now - lastT; lastT = now;
  if (engineOpen && engineOv.classList.contains('is-open')) return; // the simulator has the GPU while it is open
  if (DESK_ENGINE.mixer && camera.position.z < -14 && camera.position.x > 0) DESK_ENGINE.mixer.update(Math.min(dt, 100) / 1000);
  if (document.visibilityState === 'visible' && ++frames > 30 && frames < 240) {
    slowTime = slowTime * 0.9 + dt * 0.1;
    if (frames === 239 && slowTime > 26 && pixelRatio > 0.9) { pixelRatio = Math.max(0.85, pixelRatio * 0.7); renderer.setPixelRatio(pixelRatio); renderer.setSize(innerWidth, innerHeight, false); if (FX) { FX.composer.setPixelRatio(pixelRatio); FX.composer.setSize(innerWidth, innerHeight); } }
  }
  p += (targetP - p) * (reduceMotion ? 1 : 0.14);
  const u = progressToU(clamp01(p));
  const pos = PATH.getPointAt(u);
  if (mode === 'walk') {
    camera.position.copy(pos);
    lookAt(pos.z, tmpLook);
    // subtle walking sway, fading out as the camera comes to rest
    const walking = (1 - range(u, 0.94, 1)) * range(u, 0.02, 0.08);
    camera.position.y += Math.sin(u * 95) * 0.012 * walking;
    lastWalk.pos.copy(camera.position);
    lastWalk.look.copy(tmpLook);
  } else {
    camera.position.copy(roomCam.pos);
    tmpLook.copy(roomCam.look);
  }
  // airside: open up the fog and the depth range once the camera is outside the back door
  const out = range(-camera.position.z, 21, 26);
  scene.fog.near = 34 + out * 170;
  scene.fog.far = 150 + out * 1500;
  // outdoors (the forecourt, the apron) the sky does most of the lighting at sunset; indoors it only tints reflections
  const outdoors = Math.max(out, range(camera.position.z, -0.5, 3.5));
  scene.environmentIntensity = 0.3 + 0.55 * outdoors;
  if (hemi) hemi.intensity = 0.55 + 0.15 * outdoors;
  if (SUN) SUN.intensity = 1.7 + 0.45 * outdoors; // outdoors the low sun is the key light: shadows that read
  renderer.toneMappingExposure = 0.92 - 0.1 * outdoors; // a camera stops down outside
  const near = camera.position.z < -25.5 ? 0.3 : 0.05;
  if (camera.near !== near) { camera.near = near; camera.updateProjectionMatrix(); }
  if (AIRSIDE.root) updateAirside(now);
  // the traffic screen only redraws while the camera is inside the lobby
  updateTraffic(now, (camera.position.z < 1.5 && camera.position.z > -14) || TRAFFIC.force);
  for (const d of Object.values(DOORS)) {
    d.pivot.rotation.y = d.sign * smooth(d.open) * (d.pivot2 ? 1.5 : 1.75);
    if (d.pivot2) d.pivot2.rotation.y = -d.sign * smooth(d.open) * 1.5;
    d.leafMat.emissiveIntensity = d.hover * 0.12;
  }

  pointer.sx += (pointer.x - pointer.sx) * 0.05;
  pointer.sy += (pointer.y - pointer.sy) * 0.05;
  right.subVectors(tmpLook, camera.position).cross(camera.up).normalize();
  const dist = tmpLook.distanceTo(camera.position);
  // keep the radar steady while reading it; let people look around more out on the apron
  const sway = mode === 'screen' ? 0.15 : mode === 'room' && activeRoom === 'C' ? 5 : 1;
  tmpLook.addScaledVector(right, pointer.sx * dist * 0.02 * sway);
  tmpLook.y -= pointer.sy * dist * 0.012 * sway;
  camera.lookAt(tmpLook);

  // Main entrance slides open as the camera approaches
  const open = range(camera.position.z, 8, 3.2);
  doorLeaves.forEach((leaf) => {
    const side = Math.sign(leaf.userData.closedX);
    leaf.position.x = leaf.userData.closedX + side * 1.36 * open;
  });

  // Clock
  if (clockHands) {
    const d = new Date();
    const s = d.getSeconds() + d.getMilliseconds() / 1000, m = d.getMinutes() + s / 60, h = (d.getHours() % 12) + m / 60;
    clockHands.s.rotation.z = -(s / 60) * Math.PI * 2;
    clockHands.m.rotation.z = -(m / 60) * Math.PI * 2;
    clockHands.h.rotation.z = -(h / 12) * Math.PI * 2;
  }

  // Captions + progress line
  if (Math.abs(p - lastCapP) > 0.0002) {
    lastCapP = p;
    for (const c of caps) {
      const fadeIn = c.a < 0 ? 1 : range(p, c.a, c.b);
      const fadeOut = 1 - range(p, c.c, c.c + 0.06);
      const o = Math.min(fadeIn, fadeOut);
      c.el.style.opacity = o.toFixed(3);
      c.el.style.translate = `0 ${((1 - fadeIn) * 18 - (1 - fadeOut) * 18).toFixed(1)}px`;
      c.el.style.pointerEvents = o > 0.6 ? 'auto' : 'none';
    }
    progressFill.style.transform = `scaleY(${clamp01(p).toFixed(4)})`;
  }

  updateGrass(now);
  updateStreet(now);
  renderFrame(now, dt, outdoors, out);
}

function onResize() {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h;
  // portrait screens need a wider lens so both doors fit at the end
  camera.fov = w / h < 0.8 ? 74 : w / h < 1.2 ? 58 : 50;
  camera.updateProjectionMatrix();
  // Stop far enough back that both doors (x -2.25..2.25, plus margin) fit across the screen
  const halfW = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect;
  const restZ = Math.min(-6.0, Math.max(-9.3, LOBBY.z1 + 3.2 / halfW));
  const last = PATH.points[PATH.points.length - 1];
  if (Math.abs(last.z - restZ) > 1e-3) {
    last.z = restZ;
    PATH.points[PATH.points.length - 2].z = Math.max(restZ + 1.2, -6.6);
    PATH.updateArcLengths();
    if (M) uDoor = computeDoorU();
  }
  renderer.setSize(w, h, false);
  if (FX) { FX.composer.setPixelRatio(pixelRatio); FX.composer.setSize(w, h); FX.gtao.setSize(w * pixelRatio * 0.5, h * pixelRatio * 0.5); }
  ScrollTrigger.refresh();
}
addEventListener('resize', onResize);

init();
