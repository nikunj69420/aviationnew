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
renderer.toneMapping = THREE.AgXToneMapping; // a camera-like curve: bright colours roll off instead of going candy
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.22;

const HORIZON = new THREE.Color('#c3ccd5'); // daytime haze
scene.fog = new THREE.Fog(HORIZON, 34, 150);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 16000);
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
const SUN_DIR = new THREE.Vector3(Math.cos(-2.7925) * Math.cos(0.8378), Math.sin(0.8378), Math.sin(-2.7925) * Math.cos(0.8378)); // = SUN_VEC: 48° up, mid-afternoon
function buildSky() {
  const geo = new THREE.SphereGeometry(420, 64, 32);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color('#3d6fb6') },
      mid: { value: new THREE.Color('#79a4d6') },
      haze: { value: new THREE.Color('#c4d3e2') },
      horizon: { value: new THREE.Color('#d9e1e8') },
      sunGlow: { value: new THREE.Color('#fff1d6') },
      sunCore: { value: new THREE.Color('#ffffff') },
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
        vec3 cloud = mix(vec3(0.80, 0.84, 0.90), vec3(1.0), pow(az, 1.5)); // white fair-weather cloud
        c = mix(c, cloud, cl * 0.55);
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
  void canopyLight; // (by day the canopy's downlights only glow: no light of their own, which keeps every shader smaller)

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
  logo.material.emissiveIntensity = 0.5; // lit from within instead of by its own wall-washer

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
  void withLight; // the shade glows; a light of its own cost every shader in the scene more than it added
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
  void bx; void bz; // (the desk lamp glows without a light of its own: each light is compiled into every shader)
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
const AIRSIDE = { root: null, circuits: [], trainerWins: [], movers: [], blinkers: [], vehicles: [], backLeaves: [], rabbit: null, route: null, active: false, placeholders: { trainers: [], jets: [], tower: null, gse: [] } };
/** which airport the airside is: 'training' (a fictional regional field in farmland, data/airfield.json from
 *  tools/make_airfield.py) or 'delhi' (IGI and Aerocity from OpenStreetMap, data/aerocity.json, with the VIDP scenery) */
const FIELD = 'training';
/** phones, tablets and small-memory devices get a lighter scene: no AO or shadows, less grass, fewer trees and cars, one mist layer */
const LITE = matchMedia('(pointer: coarse)').matches || (navigator.deviceMemory ?? 8) <= 4 || new URLSearchParams(location.search).has('lite'); // (touch devices, not narrow windows)
const RWY_Z = -322, TWY_Z = -118, RWY_THR = 760, RWY_END = -1700; // TWY_Z: IGI's taxiway K, 204 m south of 10/28
let GLOW = null, RUNWAY_MAT = null;

function glowPoints(positions, color, size, parent) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions.flat(), 3));
  const mat = new THREE.PointsMaterial({ color, size, map: GLOW, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const pts = new THREE.Points(geo, mat);
  pts.userData.keep = true;
  pts.userData.size = size;
  GLOWS.push(pts);
  mat.size = size * LIGHT_LEVEL.k;
  (parent || AIRSIDE.root).add(pts);
  return pts;
}
/** every glow sprite set, so the time of day can turn the lamps down (by day they are pin-points) or up (at dusk) */
const GLOWS = [], LIGHT_LEVEL = { k: 0.5 };
function setLightLevel(k) { LIGHT_LEVEL.k = k; for (const p of GLOWS) p.material.size = p.userData.size * k; }
/** the fittings under the glow: elevated edge lights are a small coloured glass dome on a frangible stalk */
function lightFixtures(points, color, parent) {
  if (!points.length) return;
  const stalk = new THREE.CylinderGeometry(0.035, 0.05, 0.32, 6).translate(0, 0.16, 0), dome = new THREE.SphereGeometry(0.075, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.32, 0);
  const sm = new THREE.InstancedMesh(stalk, new THREE.MeshStandardMaterial({ color: 0x8d9095, roughness: 0.6, metalness: 0.4 }), points.length);
  const dm = new THREE.InstancedMesh(dome, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6, roughness: 0.2 }), points.length);
  const d = new THREE.Object3D();
  points.forEach(([x, , z], i) => { d.position.set(x, 0, z); d.updateMatrix(); sm.setMatrixAt(i, d.matrix); dm.setMatrixAt(i, d.matrix); });
  for (const m of [sm, dm]) { m.computeBoundingSphere(); m.userData.dynamic = true; m.userData.noCast = true; parent.add(m); }
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
  void cz; // (no separate lamp here: the lobby's lights and the daylight through the doors carry this corridor)
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
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uShimmer: { value: 0 }, uTilt: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime, uShimmer, uTilt; varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      vec3 c = texture2D(tDiffuse, uv).rgb;
      // tilt-shift: from the air, blur the top and bottom of the frame so the city reads as a miniature
      float band = smoothstep(0.12, 0.42, abs(uv.y - 0.52)) * uTilt;
      if (band > 0.002) {
        vec3 acc = c; float wsum = 1.0;
        for (int i = 0; i < 12; i++) {
          float a = float(i) * 2.39996, r = sqrt(float(i) + 0.5) / 3.6;
          vec2 o = vec2(cos(a), sin(a)) * r * band * vec2(0.010, 0.016);
          acc += texture2D(tDiffuse, uv + o).rgb; wsum += 1.0;
        }
        c = acc / wsum;
        float lm = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(lm), c, 1.0 + 0.12 * uTilt);
      }
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(c, c * vec3(1.0, 1.0, 1.01), smoothstep(0.45, 1.0, l)); // neutral, faintly cool highlights
      c += vec3(0.0, 0.002, 0.006) * (1.0 - l);                             // a touch of sky in the shadows
      c = mix(c, c * c * (3.0 - 2.0 * c), 0.25);                           // a soft S-curve: AgX alone is flat
      c = mix(vec3(l), c, 1.1);                                            // and a little colour back
      float vig = smoothstep(1.1, 0.32, length((vUv - 0.5) * vec2(1.15, 1.0)));
      c *= mix(0.8, 1.0, vig);
      // (no film grain: on flat walls and sky it read as noise, not film)
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
  gtao.blendIntensity = 0.6; // the lobby's occlusion is baked now; outdoors a lighter touch keeps it clean
  composer.addPass(gtao);
  gtao.setSize(w * pixelRatio * 0.5, h * pixelRatio * 0.5); // half resolution (after addPass, which sizes it full)
  const bloom = new UnrealBloomPass(new THREE.Vector2(w / 2, h / 2), 0.08, 0.5, 1.3); // only real light sources glow
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
  FX.grade.uniforms.uTilt.value = 0.4 * THREE.MathUtils.clamp((camera.position.y - 25) / 260, 0, 1); // a hint of lens, not a toy model
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
// shared shapes for the people: rounded limbs and torso (capsules), a head, shoes
const BODY = {};
function bodyGeos() {
  if (BODY.leg) return BODY;
  Object.assign(BODY, { leg: new THREE.CapsuleGeometry(0.075, 0.62, 3, 8).translate(0, -0.4, 0), arm: new THREE.CapsuleGeometry(0.052, 0.46, 3, 8).translate(0, -0.29, 0),
    torso: new THREE.CapsuleGeometry(0.17, 0.36, 4, 10).scale(1.15, 1, 0.72), head: new THREE.SphereGeometry(0.105, 14, 10), neck: new THREE.CylinderGeometry(0.05, 0.055, 0.1, 8),
    shoe: new THREE.BoxGeometry(0.11, 0.07, 0.24).translate(0, -0.79, 0.04), hip: new THREE.CapsuleGeometry(0.15, 0.08, 3, 8).rotateZ(Math.PI / 2).scale(1, 0.9, 0.8) });
  return BODY;
}
/** a person, 1.75 m, facing +z: legs and arms on hip and shoulder pivots (userData.limbs, for walkPose), a rounded
 *  torso, head and neck; a hi-vis vest with its reflective band and a hard hat for ground crew */
function crewman(yellow = false, wands = false) {
  const C = crewMats(), B = bodyGeos(), g = new THREE.Group(), vest = yellow ? C.vestY : C.vest, limbs = [];
  for (const sx of [-0.095, 0.095]) { const hip = new THREE.Group(); hip.position.set(sx, 0.86, 0); g.add(hip); hip.add(new THREE.Mesh(B.leg, C.pants)); hip.add(new THREE.Mesh(B.shoe, CREW.shoe ??= new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 }))); limbs.push(hip); }
  mesh(B.hip, C.pants, 0, 0.92, 0, g);
  mesh(B.torso, vest, 0, 1.2, 0, g);
  const band = mesh(new THREE.CylinderGeometry(0.197, 0.197, 0.045, 12).scale(1, 1, 0.72), C.stripe, 0, 1.08, 0, g); void band;
  for (const sx of [-0.235, 0.235]) { const sh = new THREE.Group(); sh.position.set(sx, 1.43, 0); g.add(sh); sh.add(new THREE.Mesh(B.arm, vest)); const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), C.skin); hand.position.y = -0.58; sh.add(hand); sh.rotation.z = Math.sign(sx) * 0.08; limbs.push(sh);
    if (wands) { const w = box(0.035, 0.38, 0.035, new THREE.MeshBasicMaterial({ color: 0xff5a1a }), 0, -0.72, 0.08, sh); w.rotation.x = 0.4; } }
  mesh(B.neck, C.skin, 0, 1.52, 0, g);
  mesh(B.head, C.skin, 0, 1.63, 0.01, g);
  mesh(new THREE.SphereGeometry(0.118, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), C.helmet, 0, 1.66, 0, g);
  g.userData.limbs = limbs; g.userData.faceZ = true;
  return g;
}
/** swing the legs and arms of a walking figure (crewman / person), phase in radians */
function walkPose(g, ph) {
  const L = g.userData.limbs; if (!L) return;
  const s = Math.sin(ph) * 0.45;
  L[0].rotation.x = s; L[1].rotation.x = -s; L[2].rotation.x = -s * 0.8; L[3].rotation.x = s * 0.8;
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
/** the real taxi path: J2 off the runway, K east, J6 back on, from OSM */
function realTaxiPath() {
  const A = AERO.data?.aero;
  if (!A) return null;
  const key = (x, z) => `${Math.round(x)},${Math.round(z)}`, G = new Map();
  const add = (a, b) => { const L = Math.hypot(a[0] - b[0], a[1] - b[1]);
    for (const [p, q] of [[a, b], [b, a]]) { const k = key(...p); if (!G.has(k)) G.set(k, { p, e: [] }); G.get(k).e.push([key(...q), L]); } };
  const lines = {};
  for (const t of A.taxiways) {
    const pts = []; for (let i = 2; i < t.length; i += 2) pts.push([t[i], t[i + 1]]);
    for (let i = 1; i < pts.length; i++) add(pts[i - 1], pts[i]);
    (lines[t[1]] ||= []).push(pts);
  }
  const runwayEnd = (ref) => { let best = null, bd = 1e9; for (const pts of lines[ref] || []) for (const q of pts) { const d = Math.abs(q[1] - RWY_Z); if (d < bd) { bd = d; best = q; } } return bd < 12 ? best : null; };
  const a = runwayEnd('J2'), b = runwayEnd('J6');
  if (!a || !b) return null;
  const dist = new Map([[key(...a), 0]]), prev = new Map(), done = new Set(), open = [[0, key(...a)]], goal = key(...b);
  while (open.length) {
    open.sort((x, y) => x[0] - y[0]);
    const [d, k] = open.shift(); if (done.has(k)) continue; done.add(k); if (k === goal) break;
    for (const [k2, L] of G.get(k).e) { const q = G.get(k2).p; if (q[1] < RWY_Z - 5 && k2 !== goal) continue; // stay south of the runway
      const nd = d + L; if (nd < (dist.get(k2) ?? 1e12)) { dist.set(k2, nd); prev.set(k2, k); open.push([nd, k2]); } }
  }
  if (!prev.has(goal)) return null;
  const path = []; for (let k = goal; k; k = prev.get(k)) path.unshift(G.get(k).p);
  return path;
}
function buildRoute() {
  const taxi = realTaxiPath();
  if (taxi) return buildRealRoute(taxi);
  return buildSyntheticRoute();
}
function buildRealRoute(taxi) {
  const dt = 0.25, S = [];
  let x = 2200, y = 0, z = RWY_Z, h = Math.PI, p = 0.035, v = 72, t = 0;
  const glide = Math.tan(THREE.MathUtils.degToRad(3)), TD = RWY_THR - 300;
  const rec = () => { S.push({ t, x, y, z, h, p }); t += dt; };
  const fwd = () => { x += Math.cos(h) * v * dt; z -= Math.sin(h) * v * dt; };
  while (x > TD) { y = (x - TD) * glide; rec(); fwd(); }
  y = 0;
  let k = 0;
  while (v > 14 && x > taxi[0][0] + 40) { p = Math.max(0, 0.035 - k * 0.004); k++; rec(); fwd(); v -= 2.2 * dt; }
  p = 0;
  while (x > taxi[0][0] + 2) { v = Math.max(10, v - 1 * dt); rec(); fwd(); }
  // follow the taxi path itself: smoothed (Chaikin), walked at taxi speed, slower through the bends
  let pts = [[x, z], ...taxi];
  for (let it = 0; it < 3; it++) { const q = [pts[0]]; for (let i = 0; i < pts.length - 1; i++) { const [ax, az] = pts[i], [bx, bz] = pts[i + 1]; q.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25], [ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]); } q.push(pts[pts.length - 1]); pts = q; }
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const at = (d) => { let i = 1; while (i < cum.length - 1 && cum[i] < d) i++; const u = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u, Math.atan2(-(pts[i][1] - pts[i - 1][1]), pts[i][0] - pts[i - 1][0])]; };
  const total = cum[cum.length - 1];
  for (let d = 0; d < total; ) {
    const [px, pz, ph] = at(d), [, , ah] = at(Math.min(total, d + 20));
    const bend = Math.abs(Math.atan2(Math.sin(ah - ph), Math.cos(ah - ph)));
    v = bend > 0.35 ? 7 : 12;
    x = px; z = pz; h = ph; rec();
    d += v * dt;
  }
  // line up westbound, hold, roll and climb
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  v = 5; for (let g = 0; g < 400 && Math.abs(wrap(Math.PI - h)) > 0.02; g++) { h += THREE.MathUtils.clamp(wrap(Math.PI - h), -0.25 * dt, 0.25 * dt); rec(); fwd(); }
  z = RWY_Z; h = Math.PI;
  v = 0; for (let i = 0; i < 6 / dt; i++) rec();
  while (v < 76) { rec(); v += 2.3 * dt; fwd(); }
  let c = 0;
  while (x > -2600) { rec(); c += dt; p = Math.min(0.15, c * 0.05); v += 0.6 * dt; y += v * Math.sin(p * 0.9) * dt; fwd(); }
  return routeMarks({ S, dt, T: t, conn: [] });
}
function buildSyntheticRoute() {
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
  return routeMarks({ S, dt, T: t, conn });
}
/** A training circuit for the school's trainers, flown left-hand... right-hand here, north of the runway, away from
 *  the campus: touch down on 28 near the threshold, roll, power up and lift off, climb out westbound to 250 m, a right
 *  turn crosswind, downwind east, base, and a long final back to the touchdown point. Samples every 0.25 s with
 *  heading h, pitch p and bank r; t = 0 is the touchdown. */
function buildCircuit() {
  const dt = 0.25, S = [], wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const TDX = RWY_THR - 260;
  let x = TDX, z = RWY_Z, y = 0, h = Math.PI, v = 29, p = 0.04, r = 0, t = 0;
  const rec = () => { S.push({ t, x, y, z, h, p, r }); t += dt; };
  const fwd = () => { x += Math.cos(h) * v * dt; z -= Math.sin(h) * v * dt; };
  const turn = (dh, R, climb = 0) => { const n = Math.ceil(Math.abs(dh) * R / v / dt);
    for (let i = 0; i < n; i++) { r = -Math.sign(dh) * 0.42 * Math.min(1, i / 6, (n - i) / 6); rec(); h += dh / n; fwd(); y += climb * dt; } r = 0; };
  while (v < 34) { p = Math.max(0, p - 0.02 * dt); rec(); fwd(); v += 1.5 * dt; }      // the roll: power up
  const tLift = t;
  while (y < 250) { p = Math.min(0.13, p + 0.05 * dt); rec(); fwd(); y += 3.6 * dt; if (x < -900 && y > 150) break; }
  while (x > -900) { p = Math.max(0.02, p - 0.03 * dt); rec(); fwd(); y = Math.min(250, y + 3 * dt); }
  v = 42; p = 0.02;
  turn(-Math.PI / 2, 260, 1.5);                                                         // crosswind, north
  while (z > RWY_Z - 820) { rec(); fwd(); y = Math.min(250, y + 2 * dt); }
  turn(-Math.PI / 2, 260);                                                             // downwind, east
  y = 250; while (x < 2150) { rec(); fwd(); }
  const tCommit = t;                                                                    // abeam: decide land or low pass
  p = -0.02; turn(-Math.PI / 2, 260, -1.8);                                            // base, south, descending
  while (z < RWY_Z - 270) { rec(); fwd(); y -= 1.8 * dt; }
  turn(-Math.PI / 2, 270, -1.8);                                                       // onto final, westbound
  h = wrap(h); z = RWY_Z;
  const x0 = x, y0 = y; v = 32;
  while (x > TDX) { const k = (x - TDX) / (x0 - TDX); y = y0 * k; p = -0.03 + 0.08 * (1 - Math.min(1, (x - TDX) / 60)); r = 0; rec(); fwd(); }
  return { S, dt, T: t, tLift, tCommit, tFinal: t - (x0 - TDX) / 32 };
}
/** busy windows the trainers have claimed on the runway (absolute seconds), so the airliners hold for them */
const trainerSoon = (t0, t1) => AIRSIDE.trainerWins.some(([a, b]) => a < t1 && b > t0);
function stepCircuits(t, dt) {
  const C = AIRSIDE.circuit, r = AIRSIDE.route;
  if (!C) return;
  AIRSIDE.trainerWins = AIRSIDE.trainerWins.filter(([, b]) => b > t);
  for (const c of AIRSIDE.circuits) {
    const prev = c.u; c.u = (c.u + dt) % C.T;
    if (prev < C.tCommit && c.u >= C.tCommit) { // abeam the threshold: land if the runway will be clear, else a low pass
      const td = t + (C.T - c.u), win = [td - 14, td + C.tLift + 6];
      let busy = trainerSoon(win[0], win[1]);
      if (!busy && r?.marks) { const m = r.marks; for (const o of AIRSIDE.movers) { const toTD = (((m.tTD - o.u) % r.T) + r.T) % r.T;
        if (t + toTD - 20 < win[1] && t + toTD + (m.tExit - m.tTD) > win[0]) busy = true;          // an arrival on the runway then
        if (o.u > m.tHS - 1 && o.u <= m.tAir + 2) busy = true; } }                                 // a departure lining up or rolling
      c.low = busy;
      if (!busy) AIRSIDE.trainerWins.push(win);
    }
    sampleRoute(C, c.u, c.s);
    let y = c.s.y;
    if (c.low && (c.u > C.tFinal || c.u < C.tLift + 25)) y = Math.max(y, 55);                       // go-around: over the runway at 55 m
    c.g.position.set(c.s.x, y, c.s.z);
    c.g.rotation.set(c.s.r ?? 0, c.s.h, c.s.p);
    if (c.fans?.length) spinFans(c.fans, t, 40);
  }
}
function circuitLights(g, i) {
  glowPoints([[2.6, 0.9, 0]], 0xfff1d6, 6, g);                                         // landing light
  blinker(glowPoints([[-3.4, 2.4, 0]], 0xff3a20, 4, g), 1.1, i * 0.4, 0.15);          // beacon on the fin
  blinker(glowPoints([[0, 1.3, -5.5], [0, 1.3, 5.5]], 0xffffff, 4, g), 1.3, i * 0.3, 0.06); // wingtip strobes
}
/** where the runway is busy along a route: touchdown, runway vacated, the hold-short line, lift-off */
function routeMarks(r) {
  const S = r.S, off = (q) => Math.abs(q.z - RWY_Z);
  let iTD = S.findIndex((q, i) => i > 0 && q.y <= 0.01);
  let iExit = S.findIndex((q, i) => i > iTD && off(q) > 60);
  let iAir = S.findIndex((q, i) => i > iExit && q.y > 0.5);
  // hold with the nose well behind the bar: the aircraft's centre stops 150 m from the centreline, so even a 787's
  // 31 m of nose stays short of the painted line (95-112 m out, depending on the entry)
  let iHS = iAir; while (iHS > iExit && off(S[iHS]) < 150) iHS--;
  let iRoll = iAir; while (iRoll > iHS && !(S[iRoll].x === S[iRoll - 1].x && S[iRoll].z === S[iRoll - 1].z)) iRoll--; // end of the line-up hold
  r.marks = { tTD: S[iTD].t, tExit: S[iExit].t, tHS: S[iHS].t, tRoll: S[iRoll].t, tAir: S[iAir].t };
  return r;
}
function sampleRoute(r, t, out) {
  const f = ((t % r.T) + r.T) % r.T / r.dt, i = Math.min(r.S.length - 2, Math.floor(f)), u = f - i;
  const a = r.S[i], b = r.S[i + 1];
  out.x = a.x + (b.x - a.x) * u; out.y = a.y + (b.y - a.y) * u; out.z = a.z + (b.z - a.z) * u;
  out.h = a.h + (b.h - a.h) * u; out.p = a.p + (b.p - a.p) * u; out.r = (a.r ?? 0) + ((b.r ?? 0) - (a.r ?? 0)) * u;
  return out;
}

/* ---------- Real aircraft models (meshopt .glb), swapped in over the placeholders ---------- */
// Credits: Airbus A320 by OUTPISTON (CC BY-NC-SA 4.0), Cessna 182 Skylane by VTX (CC BY-NC-SA 4.0),
// Gulfstream G650ER by Luca Martina (CC BY 4.0), all via Sketchfab; Delhi ATC tower built for the main site.
const MODEL_SPECS = {
  a320: { url: 'models/a320.glb', yaw: Math.PI / 2, length: 37.6, fullColour: true },
  c182: { url: 'models/c182.glb', yaw: -Math.PI / 2, length: 8.8 }, // cabin interior stripped, simplified
  g650: { url: 'models/g650.glb', yaw: Math.PI / 2, length: 30.4 },
  // AIG AI aircraft (FAIB A320neo CFM, AIG 787-9 RR), converted from their MSFS models with permission; gear baked down
  // full-detail exterior (LOD0, with its normal and occlusion/roughness/metal maps)
  n_igo: { url: 'models/a20n_igo.glb?v=2', yaw: Math.PI / 2, length: 37.57, livery: true },
  b_vir: { url: 'models/b789_vir.glb?v=2', yaw: Math.PI / 2, length: 62.8, livery: true },
};
// ground vehicles from Sketchfab: "GameAsset - Airport Pushback" by Loic ALIX (CC BY-NC 4.0), "Airport Catering Truck" by spot1studios (CC BY 4.0)
MODEL_SPECS.tug = { url: 'models/pushback_tug.glb', yaw: -Math.PI / 2, length: 9.0, keepOne: true };
MODEL_SPECS.cater = { url: 'models/catering_truck.glb', yaw: -Math.PI / 2, length: 9.13 };
// More liveries from the same AIG packs: only the paint differs, so each reuses its type's model with its textures swapped
const LIVERY_TEX = { n_aic: 'a20n_aic', n_vti: 'a20n_vti', b_baw: 'b789_baw', n_iad: 'a20n_iad', n_alk: 'a20n_alk', n_drk: 'a20n_drk', n_kac: 'a20n_kac', n_jzr: 'a20n_jzr', n_kne: 'a20n_kne', n_oms: 'a20n_oms', n_gfa: 'a20n_gfa', n_axm: 'a20n_axm',
  b_ana: 'b789_ana', b_eth: 'b789_eth', b_tha: 'b789_tha', b_msr: 'b789_msr', b_gfa: 'b789_gfa' };
for (const [k, tex] of Object.entries(LIVERY_TEX)) MODEL_SPECS[k] = { base: k.startsWith('b_') ? 'b_vir' : 'n_igo', tex, livery: true };
const LIVERY_KEYS = ['n_igo', 'b_vir', ...Object.keys(LIVERY_TEX)];
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
/** a livery that is only paint: its type's model, cloned, with the livery textures (matched by name) swapped in */
const RAW_AIR = {};
function loadAirModel(key) {
  const sp = MODEL_SPECS[key];
  if (!sp.base) return (RAW_AIR[key] ??= loadAirModelRaw(key));
  const texLoader2 = new THREE.TextureLoader(), files = {};
  const tex = (suf) => (files[suf] ??= texLoader2.loadAsync(`models/liveries/${sp.tex}_${suf}.webp?v=2`));
  return (RAW_AIR[sp.base] ??= loadAirModelRaw(sp.base)).then(async (base) => {
    const w = base.clone(true), jobs = [], mine = new Map(); // one repainted material per original, so the parts still merge
    w.traverse((o) => {
      if (!o.isMesh || !o.material?.map?.name) return;
      const nm = o.material.map.name.split('.')[0], suf = /_T2$/.test(nm) ? 'T2' : /_T$/.test(nm) ? 'T' : null;
      if (!suf) return;
      if (mine.has(o.material)) { o.material = mine.get(o.material); return; }
      const old = o.material.map, m = o.material.clone(); mine.set(o.material, m); o.material = m;
      jobs.push(tex(suf).then((t0) => {
        const t = t0.clone(); t.source = t0.source;
        Object.assign(t, { flipY: false, colorSpace: old.colorSpace, wrapS: old.wrapS, wrapT: old.wrapT, anisotropy: old.anisotropy, channel: old.channel, name: old.name });
        t.needsUpdate = true; m.map = t;
      }));
    });
    await Promise.all(jobs);
    return w;
  });
}
/** The 787's bone-driven control surfaces (outer flaps, flaperons, spoilerons, outer slats, spoilers 3-7) don't
 *  survive the MSFS export: with the skin dropped they sit metres off the wing, some floating above it. They go;
 *  the surfaces that were never skinned (inner flaps and slats, spoilers 1-2, ailerons) sit right and stay. */
const B789_LOOSE = /^(flap2_[lr]|flaperon_[lr]|spoileron_[lr]|slat_[lr]2|spoiler[3-7]_[lr])(_skinned)?$/i;
function fix787Surfaces(root) {
  const drop = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (let p = o; p && p !== root; p = p.parent) if (B789_LOOSE.test(p.name)) { drop.push(o); break; }
  });
  drop.forEach((m) => m.removeFromParent());
  root.updateMatrixWorld(true);
  return drop.length;
}
/** Ground shadows past the sun's shadow map (which only covers ~160 m round the camera): an object carries a soft
 *  silhouette of itself seen from straight above, laid on the ground and slid away from the sun by its height (right
 *  for a box, close for an airliner), so aircraft and hangars sit on the ground from any distance. Near the camera,
 *  where the real shadow map takes over, it shrinks back to a faint contact shadow straight underneath. */
const GSHADOW = { mat: new THREE.MeshBasicMaterial({ color: 0xffffff }), geo: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), w: new THREE.Vector3(), t: new THREE.Vector3() };
class GroundShadow extends THREE.Mesh {
  onBeforeRender() {
    const u = this.userData, par = this.parent;
    if (!par) return;
    if (!u.own) { this.material = this.material.clone(); u.own = true; }
    const w = GSHADOW.w.set(u.cx, 0, u.cz); par.localToWorld(w);
    const above = Math.max(0, par.getWorldPosition(GSHADOW.t).y);
    let far = 1;
    if (SUN?.userData.wide) { const d = Math.hypot(w.x - SUN.target.position.x, w.z - SUN.target.position.z); far = THREE.MathUtils.smoothstep(d, 60, 85); }
    const run = (u.rise + above) * far / SUN_VEC.y;
    w.x -= SUN_VEC.x * run; w.z -= SUN_VEC.z * run; w.y = 0.075;
    par.worldToLocal(w); this.position.copy(w);
    const fade = THREE.MathUtils.clamp(1 - above / 80, 0, 1);
    this.scale.set(u.size * (1 + above / 120), 1, u.size * (1 + above / 120));
    this.material.opacity = u.opacity * fade * (0.35 + 0.65 * far);
    this.updateMatrixWorld();
  }
}
function groundShadow(obj, { rise = 2, opacity = 0.5, res = 256 } = {}) {
  const keep = [obj.position.clone(), obj.quaternion.clone(), obj.scale.clone()], par = obj.parent;
  obj.position.set(0, 0, 0); obj.quaternion.identity(); obj.scale.setScalar(1);
  const tmp = new THREE.Scene(); tmp.add(obj); obj.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(obj), c = b.getCenter(new THREE.Vector3()), sz = b.getSize(new THREE.Vector3());
  const half = Math.max(sz.x, sz.z) * 0.5 * 1.12 + 1;
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, sz.y + 40);
  cam.position.set(c.x, b.max.y + 20, c.z); cam.up.set(0, 0, -1); cam.lookAt(c.x, b.min.y, c.z); cam.updateMatrixWorld();
  const rt = new THREE.WebGLRenderTarget(res, res, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const prevRT = renderer.getRenderTarget(), prevC = renderer.getClearColor(new THREE.Color()), prevA = renderer.getClearAlpha(), prevAuto = renderer.autoClear;
  const mat = GSHADOW.mat; mat.blending = THREE.AdditiveBlending; mat.depthTest = false; mat.transparent = true;
  tmp.overrideMaterial = mat; renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.autoClear = false;
  const soft = (half * 2) / res * 1.6, taps = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];
  mat.color.setScalar(1 / taps.length);
  for (const [dx, dz] of taps) { cam.position.set(c.x + dx * soft, b.max.y + 20, c.z + dz * soft); cam.updateMatrixWorld(); renderer.render(tmp, cam); }
  renderer.setRenderTarget(prevRT); renderer.setClearColor(prevC, prevA); renderer.autoClear = prevAuto;
  tmp.remove(obj); if (par) par.add(obj);
  obj.position.copy(keep[0]); obj.quaternion.copy(keep[1]); obj.scale.copy(keep[2]); obj.updateMatrixWorld(true);
  const sh = new GroundShadow(GSHADOW.geo, new THREE.MeshBasicMaterial({ color: 0x0b0d10, alphaMap: rt.texture, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
  Object.assign(sh.userData, { cx: c.x, cz: c.z, size: half * 2, rise, opacity, keep: true });
  sh.position.set(c.x, 0.075, c.z); sh.scale.set(half * 2, 1, half * 2);
  sh.castShadow = sh.receiveShadow = false; sh.renderOrder = 1;
  obj.add(sh);
  return sh;
}
/** The engines' fans (MSFS "N1 still" / "RR still" parts) on their own pivot about the aircraft's long axis, so a
 *  taxiing aircraft's fans can turn; the motion-blur discs that MSFS swaps in at speed go. */
const FAN_RE = /^(N1_\d_still|engine\d_RR_still)/i, FAN_BLUR = /^engine\d_RR_blur/i;
function rigFans(root) {
  root.updateMatrixWorld(true);
  const fans = [], blur = [];
  root.traverse((o) => { if (o.isMesh) { if (FAN_RE.test(o.name)) fans.push(o); else if (FAN_BLUR.test(o.name)) blur.push(o); } });
  blur.forEach((o) => o.removeFromParent());
  const q = new THREE.Quaternion(), c = new THREE.Vector3();
  for (const f of fans) {
    f.geometry = floatGeometry(f.geometry.clone()); f.geometry.computeBoundingBox(); f.geometry.boundingBox.getCenter(c);
    f.geometry.translate(-c.x, -c.y, -c.z);
    const pivot = new THREE.Object3D(); pivot.name = f.name + '_pivot';
    pivot.position.copy(c).multiply(f.scale).applyQuaternion(f.quaternion).add(f.position); pivot.quaternion.copy(f.quaternion); pivot.scale.copy(f.scale);
    f.parent.add(pivot); pivot.add(f); f.position.set(0, 0, 0); f.quaternion.identity(); f.scale.set(1, 1, 1);
    pivot.updateMatrixWorld(true);
    const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(pivot.getWorldQuaternion(q).invert()).normalize(); // the nose direction, in the fan's own frame
    f.userData.fanAxis = ax.toArray(); f.userData.keep = true;
  }
}
const _fq = new THREE.Quaternion(), _fa = new THREE.Vector3();
function spinFans(fans, t, rate) { for (const f of fans) f.quaternion.setFromAxisAngle(_fa.fromArray(f.userData.fanAxis), t * rate); }
/** Load, turn the nose toward +x, scale to real size, sit it on the ground, matte the paint. */
function loadAirModelRaw(key) {
  const sp = MODEL_SPECS[key];
  return gltfLoader.loadAsync(sp.url).then((gltf) => {
    const root = gltf.scene;
    if (/b789/.test(sp.url)) fix787Surfaces(root);
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
        if (!('roughness' in m)) continue;
        if (m.roughnessMap) { // the AIG maps: R occlusion, G roughness, B metal. Their gloss is tuned for MSFS; ours reads a touch softer
          m.roughness = 1.9; m.metalness = 1; m.aoMap = m.roughnessMap; m.aoMapIntensity = 0.85; m.envMapIntensity = 1.15;
          if (m.normalMap) m.normalScale.multiplyScalar(0.9);
        } else { m.roughness = sp.livery || sp.fullColour ? 0.42 : Math.max(m.roughness ?? 1, 0.55); m.metalness = Math.min(m.metalness ?? 0, 0.15); } // aircraft paint has a sheen
      }
    });
    const inner = new THREE.Group();
    inner.add(root);
    inner.updateMatrixWorld(true);
    unskin(root);
    rigFans(root);
    const b = new THREE.Box3().setFromObject(inner, true), size = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    const s = sp.length ? sp.length / size.x : sp.height / size.y;
    inner.scale.setScalar(s);
    inner.position.set(-c.x * s, -b.min.y * s, -c.z * s);
    const wrap = new THREE.Group();
    wrap.add(inner);
    wrap.userData.height = size.y * s;
    groundShadow(wrap, { rise: wrap.userData.height * 0.3, opacity: 0.5 });
    return wrap;
  });
}
// each model swaps in on its own as soon as it arrives (the A320 is small, the Cessna is the heaviest)
const airModels = Object.fromEntries(Object.keys(MODEL_SPECS).map((k) => [k, loadAirModel(k).catch((e) => { console.warn('model', k, e); return null; })]));
// Terminal 3's pier from the VIDP scenery (converted from its MSFS model library), in metres as built
airModels.t3 = FIELD !== 'delhi' ? Promise.resolve(null) : gltfLoader.loadAsync('models/vidp_t3.glb?v=5').then((gltf) => {
  const root = gltf.scene;
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = false;
    for (const m of [].concat(o.material)) if ('roughness' in m) {
      m.roughness = Math.max(m.roughness ?? 1, 0.6); m.metalness = Math.min(m.metalness ?? 0, 0.3);
      if (m.emissiveMap) m.emissiveIntensity = 0.7; // the scenery's night-light textures: interiors lit for dusk
    }
  });
  root.userData.dynamic = true;
  return root;
}).catch((e) => { console.warn('model t3', e); return null; });
/** a VIDP scenery model at the place, heading and scale the scenery gives it */
function placeVidp(root, file) {
  const m = AERO.data?.models?.[file];
  if (!m) return false;
  root.position.set(m[0], 0.03, m[1]); root.rotation.y = m[2]; root.scale.setScalar(m[3]);
  return true;
}

/* ---------- Realism: photographed sky and light, PBR surfaces, real furniture ---------- */
// Sky and image-based light: "Qwantani Sunset (Pure Sky)" from Poly Haven (CC0), a 1k HDR for light and reflections
// and its tonemapped photo (4096 x 2048) as the visible sky. In the photo the sun sits 14° up at azimuth 38.5°
// (atan2(z, x)); both are turned so it sets at SUN_AZ, where the scene's directional light comes from too.
const SUN_AZ = THREE.MathUtils.degToRad(-160);
const SKY_ROT = THREE.MathUtils.degToRad(34.3) - SUN_AZ; // the photo's sun sits at azimuth 34.3° (atan2(z, x)), 48° up; turned to SUN_AZ
const SUN_EL = THREE.MathUtils.degToRad(48); // a normal day, not sunset
const SUN_VEC = new THREE.Vector3(Math.cos(SUN_AZ) * Math.cos(SUN_EL), Math.sin(SUN_EL), Math.sin(SUN_AZ) * Math.cos(SUN_EL));
function loadSkyAndLight(skyMesh) {
  // a normal day: the procedural sky, captured once into a cube map that serves as the background and as the light
  const skyScene = new THREE.Scene();
  skyScene.add(skyMesh); skyMesh.position.set(0, 0, 0); skyMesh.visible = true;
  // 256: the same environment size the 1k HDR gives (1024 / 4), so swapping to it doesn't recompile every lit shader
  const rt = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
  new THREE.CubeCamera(1, 1000, rt).update(renderer, skyScene);
  scene.background = rt.texture;
  scene.backgroundIntensity = 1; scene.backgroundRotation.set(0, 0, 0);
  scene.environment = pmrem.fromCubemap(rt.texture).texture;
  scene.environmentRotation.set(0, 0, 0);
  scene.fog.color.copy(HORIZON);
  // then the photographed sky, as soon as it arrives: "Kloofendal 48d Partly Cloudy (Pure Sky)" by Greg Zaal and
  // Jarod Guest, Poly Haven (CC0). A 1k HDR lights and reflects; the tonemapped photo, baked to 4096 x 2048, is seen.
  // Both are pre-filtered/baked offline, so this costs two downloads and one PMREM pass, no new shaders.
  // (the cube stays alive until the photo replaces it as the background: freeing it while it is still shown leaves
  // a black sky whenever the HDR lands first)
  let envDone = false, bgDone = false;
  const freeCube = () => { if (envDone && bgDone) rt.dispose(); };
  SKY_DAY.bg = rt.texture; SKY_DAY.env = scene.environment; SKY_DAY.bgI = 1;
  new RGBELoader().loadAsync('tex/kloofendal_day_1k.hdr').then((hdr) => {
    SKY_DAY.env = pmrem.fromEquirectangular(hdr).texture;
    if (TOD.kind === 'day') { scene.environment = SKY_DAY.env; }
    scene.environmentRotation.set(0, SKY_ROT, 0);
    hdr.dispose(); envDone = true; freeCube();
  }).catch((e) => console.warn('hdr', e));
  new THREE.TextureLoader().loadAsync('tex/sky_day.jpg').then((tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = MAX_ANISO;
    SKY_DAY.bg = tex; SKY_DAY.bgI = 0.92;
    if (TOD.kind === 'day') { scene.background = tex; scene.backgroundIntensity = 0.92; }
    scene.backgroundRotation.set(0, SKY_ROT, 0);
    bgDone = true; freeCube();
    // the haze takes the photo's colour just above the horizon, so distant ground melts into this sky
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const g = c.getContext('2d'); g.drawImage(tex.image, 0, 0, 256, 128);
    const row = g.getImageData(0, 60, 256, 3).data; let r = 0, gg = 0, b = 0;
    for (let i = 0; i < row.length; i += 4) { r += row[i]; gg += row[i + 1]; b += row[i + 2]; }
    const n = row.length / 4;
    SKY_DAY.fog.setRGB(r / n / 255, gg / n / 255, b / n / 255, THREE.SRGBColorSpace).multiplyScalar(0.9);
    if (TOD.kind === 'day') { HORIZON.copy(SKY_DAY.fog); scene.fog.color.copy(HORIZON); }
  }).catch((e) => console.warn('sky', e));
}

/** Day or dusk (the airside card's "Time of day"): dusk swaps in a sunset sky ("Qwantani Sunset (Pure Sky)", Poly Haven,
 *  CC0) for light and reflections and the pink-sky photo behind, turns the sun low-warm and weak, the sky light down, and
 *  every lamp up (runway, taxiway, apron masts, hangars, aircraft lights). Both skies stay cached after first use. */
const TOD = { sun: 1, hemi: 1, exp: 1, kind: 'day', dusk: null };
const NIGHT = { value: 0 }; // 0 by day, 1 at dusk: windows, street lamps, headlights, the train's windows
const SKY_DAY = { bg: null, env: null, bgI: 1, fog: HORIZON.clone() }; // kept current by loadSkyAndLight as each part arrives
const dusk0 = (kind) => (kind === 'dusk' ? TOD.dusk : SKY_DAY);
const SUN_DAY = new THREE.Color(0xfff3e3), SUN_DUSK = new THREE.Color(0xff9a5a);
async function setTimeOfDay(kind) {
  if (kind === TOD.kind) return;
  TOD.kind = kind;
  document.querySelectorAll('#todRow [data-tod]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tod === kind)));
  if (kind === 'dusk' && !TOD.dusk) {
    const [hdr, tex] = await Promise.all([new RGBELoader().loadAsync('tex/qwantani_sunset_puresky_1k.hdr'), new THREE.TextureLoader().loadAsync('tex/sky_pink.jpg')]);
    const env = pmrem.fromEquirectangular(hdr).texture; hdr.dispose();
    tex.mapping = THREE.EquirectangularReflectionMapping; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = MAX_ANISO;
    const c = document.createElement('canvas'); c.width = 256; c.height = 128; const g = c.getContext('2d'); g.drawImage(tex.image, 0, 0, 256, 128);
    const row = g.getImageData(0, 60, 256, 3).data; let r = 0, gg = 0, bb = 0; for (let i = 0; i < row.length; i += 4) { r += row[i]; gg += row[i + 1]; bb += row[i + 2]; }
    const n = row.length / 4;
    TOD.dusk = { bg: tex, env, bgI: 0.85, fog: new THREE.Color().setRGB(r / n / 255, gg / n / 255, bb / n / 255, THREE.SRGBColorSpace).multiplyScalar(0.75) };
    if (TOD.kind !== 'dusk') return; // switched back while loading
  }
  const S = dusk0(kind), dusk = kind === 'dusk';
  scene.background = S.bg; scene.environment = S.env; scene.backgroundIntensity = S.bgI; scene.fog.color.copy(S.fog); HORIZON.copy(S.fog);
  Object.assign(TOD, dusk ? { sun: 0.34, hemi: 0.4, exp: 0.86 } : { sun: 1, hemi: 1, exp: 1 });
  SUN?.color.copy(dusk ? SUN_DUSK : SUN_DAY);
  setLightLevel(dusk ? 1.4 : 0.5);
  NIGHT.value = dusk ? 1 : 0;
  for (const p of NIGHT_POINTS) p.visible = dusk;
  if (MIST.mat) MIST.mat.uniforms.uCol.value.set(dusk ? 0xc9a9b6 : 0xdfe5ea);
  for (const m of LAMP_MATS) m.emissiveIntensity = m.userData.dayE * (dusk ? 2.2 : 1);
}
const LAMP_MATS = [];
document.getElementById('todRow')?.addEventListener('click', (e) => { const b = e.target.closest('[data-tod]'); if (b) setTimeOfDay(b.dataset.tod); });
document.getElementById('roomBack')?.addEventListener('click', () => { setTimeOfDay('day'); setSound(false); }); // the lobby's light is baked for day
/* ---------- Sound (off by default): synthesised with Web Audio, no files. The nearest trainer's engine, a low
   rumble from the nearest airliner, wind, birds now and then, and the train's horn at the crossings. ---------- */
const AUDIO = { ctx: null, on: false };
function noiseBuffer(ctx) { const b2 = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = b2.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; return b2; }
function setSound(on) {
  AUDIO.on = on;
  const btn = document.getElementById('soundBtn'); if (btn) { btn.setAttribute('aria-pressed', String(on)); btn.textContent = on ? 'Sound on' : 'Sound off'; }
  if (!on) { AUDIO.master?.gain.setTargetAtTime(0, AUDIO.ctx.currentTime, 0.2); return; }
  if (!AUDIO.ctx) {
    const ctx = AUDIO.ctx = new AudioContext(), master = AUDIO.master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
    const loop = (freq, q, type = 'lowpass') => { const s = ctx.createBufferSource(); s.buffer = noiseBuffer(ctx); s.loop = true; const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; const g = ctx.createGain(); g.gain.value = 0; s.connect(f).connect(g).connect(master); s.start(); return g; };
    AUDIO.wind = loop(500, 0.4, 'bandpass'); AUDIO.wind.gain.value = 0.03;
    AUDIO.rumble = loop(180, 0.7);
    const eng = ctx.createGain(); eng.gain.value = 0; eng.connect(master); const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; lp.connect(eng);
    for (const [f, a] of [[88, 0.5], [176, 0.25], [264, 0.12]]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; const g = ctx.createGain(); g.gain.value = a; o.connect(g).connect(lp); o.start(); }
    AUDIO.engine = eng; AUDIO.birdAt = 0; AUDIO.hornDone = new Set();
  }
  AUDIO.ctx.resume(); AUDIO.master.gain.setTargetAtTime(0.8, AUDIO.ctx.currentTime, 0.3);
}
document.getElementById('soundBtn')?.addEventListener('click', () => setSound(!AUDIO.on));
function chirp(at, gain) { const c = AUDIO.ctx, o = c.createOscillator(), g = c.createGain(); o.type = 'sine'; o.connect(g).connect(AUDIO.master);
  const f0 = 2600 + Math.random() * 1800; o.frequency.setValueAtTime(f0, at); o.frequency.exponentialRampToValueAtTime(f0 * 1.5, at + 0.07);
  g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(gain, at + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.09); o.start(at); o.stop(at + 0.1); }
function horn(gain) { const c = AUDIO.ctx, t = c.currentTime, g = c.createGain(), lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400; g.connect(AUDIO.master); lp.connect(g);
  for (const f of [311, 370]) { const o = c.createOscillator(); o.type = 'square'; o.frequency.value = f; o.connect(lp); o.start(t); o.stop(t + 2.4); }
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.08); g.gain.setValueAtTime(gain, t + 0.9); g.gain.linearRampToValueAtTime(0, t + 1.0); g.gain.linearRampToValueAtTime(gain, t + 1.25); g.gain.setValueAtTime(gain, t + 2.2); g.gain.linearRampToValueAtTime(0, t + 2.4); }
function updateSound() {
  if (!AUDIO.on || !AUDIO.ctx) return;
  const c = AUDIO.ctx, t = c.currentTime, cam = camera.position, near = (list) => list.reduce((m, p) => Math.min(m, cam.distanceTo(p)), 1e9);
  const dT = near(AIRSIDE.circuits.map((q) => q.g.position)), dJ = near(AIRSIDE.movers.filter((m) => m.g.visible).map((m) => m.g.position));
  AUDIO.engine.gain.setTargetAtTime(0.16 * Math.pow(Math.max(0, 1 - dT / 900), 2), t, 0.25);
  AUDIO.rumble.gain.setTargetAtTime(0.5 * Math.pow(Math.max(0, 1 - dJ / 2200), 2), t, 0.4);
  if (t > AUDIO.birdAt) { AUDIO.birdAt = t + 2 + Math.random() * 5; if (cam.y < 120) for (let k = 0; k < 2 + ((Math.random() * 3) | 0); k++) chirp(t + k * 0.13, 0.04); }
  if (RAIL.train) for (const cr of RAIL.crossings) { const d = (cr.at - RAIL.s) * RAIL.dir, key = cr.at + ':' + RAIL.dir;
    if (d > 300 && d < 420 && !AUDIO.hornDone.has(key)) { AUDIO.hornDone.add(key); railAt(RAIL.s, _fo); const dist = cam.distanceTo(_fo.position); if (dist < 2500) horn(0.18 * Math.max(0.15, 1 - dist / 2500)); }
    if (d < 0) AUDIO.hornDone.delete(key); }
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
  for (const m of AIRFIELD) dress(m, 'leafy_grass', { keepRepeatOf: m.map, k: 1, color: 0x7f8d58, rough: 1 }); // the airfield's mown grass
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
  g.userData.dynamic = true; // (as for movers: kept out of mergeStatic, shown and hidden with the airside)
  return bakeGroup(g);
}

/** fly a mover with a real model: beacons, strobes, nav lights and a landing light scaled to its size */
const BAKED_MOVER = new WeakMap();
function swapMover(m, model, k) {
  const g = new THREE.Group();
  g.userData.dynamic = true; // models can land before mergeStatic runs: it must never weld a moving aircraft into the scenery
  g.rotation.order = 'YZX';
  if (!BAKED_MOVER.has(model)) BAKED_MOVER.set(model, bakeGroup(SkeletonUtils.clone(model))); // merged by material once, shared by every mover
  g.add(BAKED_MOVER.get(model).clone()); // (a WeakMap, not userData: liveries clone their base, and userData clones through JSON)
  blinker(glowPoints([[0, 6.2 * k, 0], [0, 1.6, 0]], 0xff3a20, 3, g), 1.2, 0, 0.15);
  blinker(glowPoints([[-3.5 * k, 4.4, -17 * k], [-3.5 * k, 4.4, 17 * k]], 0xffffff, 4, g), 1.0, 0.3, 0.08);
  glowPoints([[-3.5 * k, 4.4, -17 * k]], 0xff2a1a, 2, g);
  glowPoints([[-3.5 * k, 4.4, 17 * k]], 0x2aff6a, 2, g);
  glowPoints([[17.5 * k, 2.6, 0]], 0xfff1d6, 7, g); // landing light
  g.visible = m.g.visible;
  g.position.copy(m.g.position); g.rotation.copy(m.g.rotation); // carry on from the stand-in's place on the route
  m.g.removeFromParent();
  AIRSIDE.root.add(g);
  m.g = g;
  m.lift = 0;
  m.real = model;
  m.fans = []; g.traverse((o) => { if (o.userData.fanAxis) m.fans.push(o); });
}
function upgradeAirside(md) {
  const air = AIRSIDE.root, P = AIRSIDE.placeholders;
  if (md.c182) {
    const spots = P.trainers.map((t) => [t.position.x, t.position.z, t.rotation.y]);
    P.trainers.forEach((t) => t.removeFromParent());
    air.add(parkedGroup(md.c182, spots));
    // and the trainers in the circuit fly the real model too
    if (!BAKED_MOVER.has(md.c182)) BAKED_MOVER.set(md.c182, bakeGroup(SkeletonUtils.clone(md.c182)));
    for (const g2 of [...AIRSIDE.circuits.map((c) => c.g), ...(AIRSIDE.taxiTrainers ?? [])]) { g2.userData.body?.removeFromParent(); g2.userData.body = BAKED_MOVER.get(md.c182).clone(); g2.add(g2.userData.body); }
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
    const house = P.jets.filter((j) => !j.userData.livery && !j.userData.keepSimple && j.parent);
    const spots = house.map((j) => [j.position.x, j.position.z, j.rotation.y]);
    house.forEach((j) => j.removeFromParent());
    air.add(parkedGroup(md.a320, spots));
    // movers still on a placeholder fly the house A320 until their airline's model arrives
    for (const m of AIRSIDE.movers) if (!m.real) swapMover(m, md.a320, 1);
  }
  if (md.t3 && placeVidp(md.t3, 'vidp_t3')) { md.t3.userData.dynamic = true; air.add(md.t3); }
  for (const kind of ['tug', 'cater']) {
    if (!md[kind]) continue;
    const mine = P.gse.filter((o) => o.userData.gse === kind && o.parent);
    const spots = mine.map((o) => { const v = o.getWorldPosition(new THREE.Vector3()); return [v.x, v.z, o.rotation.y]; });
    mine.forEach((o) => o.removeFromParent());
    air.add(parkedGroup(md[kind], spots));
  }
  if (md.g650) air.add(parkedGroup(md.g650, [[96, -44, -Math.PI / 2 + 0.35]])); // the academy's business jet by its hangar

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
  const grass = new THREE.MeshStandardMaterial({ map: repeatOf(T.grass, 750, 750), color: 0x9aa56f, roughness: 1 });
  AIRFIELD.push(grass);

  // ground layers: grass everywhere, apron, service road, taxiway, connectors, runway
  panel(520, 92, apronMat, 0, 0.02, -23 - 46, 'up', air);
  panel(520, 7, tarmacAt(520, 7), 0, 0.03, -33, 'up', air);
  const twy = (x0, x1, z0, z1) => panel(Math.abs(x1 - x0), Math.abs(z1 - z0), tarmacAt(Math.abs(x1 - x0), Math.abs(z1 - z0)), (x0 + x1) / 2, 0.025, (z0 + z1) / 2, 'up', air);
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
  for (const cx of route.conn) for (let z = TWY_Z - 15; z > RWY_Z + 25; z -= 20) { twc.push([cx, 0.3, z]); twe.push([cx - 12.5, 0.4, z], [cx + 12.5, 0.4, z]); }
  glowPoints(edge, 0xfff1d6, 3.2);
  glowPoints(thr, 0x5dff9a, 3.0);
  glowPoints([[RWY_END, 0.4, RWY_Z - 15], [RWY_END, 0.4, RWY_Z], [RWY_END, 0.4, RWY_Z + 15]], 0xff4a3a, 3.0);
  void appr;
  AIRSIDE.rabbits = [approachLights(air, RWY_THR, 1), approachLights(air, RWY_END, -1)]; // 28 (arrivals from the east) and 10
  glowPoints(twc, 0x52f08a, 1.8);
  glowPoints(twe.map(([x, , z]) => [x, 0.36, z]), 0x4a7dff, 2.2);
  lightFixtures(twe, 0x2f5dff, air);
  lightFixtures(edge, 0xfff3d8, air);
  airportSigns(air, route);

  // apron floodlight masts: along the back of the apron, beside the service road, lamps facing out over the stands
  // (clear of taxiway K in front, the hangar and the business jet's stand, and the spotters' deck)
  const MASTS = [-200, -110, -25, 200], MZ = -41;
  for (const x of MASTS) {
    cyl(0.25, 0.4, 24, M.metalDark, x, 12, MZ, air, 10);
    box(4, 0.6, 0.8, M.metalDark, x, 24.2, MZ, air);
    box(3.6, 0.1, 0.6, M.lightWarm, x, 23.85, MZ - 0.1, air, { cast: false, receive: false });
  }
  glowPoints(MASTS.map((x) => [x, 23.8, MZ - 0.6]), 0xffd9a6, 4.5);
  for (const x of MASTS) lightPool(x, -72, 80, 62, air, 0.3);


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
    AIRSIDE.movers.push({ g, shadow: sh, lift: 4.2, offset: (i / liveries.length) * route.T, s: {}, livery: ['n_igo', 'b_eth', 'n_aic', 'n_kac', 'n_iad', 'b_tha'][i] });
  });
  // three of the academy's trainers flying touch-and-go circuits (see buildCircuit and stepCircuits)
  AIRSIDE.circuit = buildCircuit();
  for (let i = 0; i < 3; i++) {
    const g = new THREE.Group(); g.rotation.order = 'YZX'; g.userData.dynamic = true;
    g.userData.body = g.add(bakeGroup(trainer(i % 2 ? tailMat(0x1f6f8a) : M.paintNavy))).children.at(-1);
    circuitLights(g, i);
    air.add(g);
    const u = (i / 3) * AIRSIDE.circuit.T + 7;
    AIRSIDE.circuits.push({ g, u, low: u > AIRSIDE.circuit.tCommit, s: {} }); // (one already past the decision point goes around once)
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

  buildIGI(air, { white, yellow, tarmacAt, apronMat });
  buildHangars(air, apronMat);
  if (FIELD !== 'delhi') { buildFieldBuildings(air); buildFieldExtras(air); }
  // the whole movement area weathered: concrete aprons, the runways, the white paint
  for (const m of CONCRETE_GROUND) weather(m, 'concrete');
  weather(RUNWAY_MAT, 'runway');
  weather(white, 'paint');
  buildDeck(air);
  air.traverse((o) => { o.castShadow = false; });
}

/** Across the runway, after Delhi IGI's layout: a parallel taxiway, a T3-style terminal with jet bridges and gates,
    a second parallel runway lit for the evening, then the olive scrub and the hazy city edge. (Layout studied from
    satellite views as reference only; nothing is traced or copied from them.) */
/** the pool of light a lamp throws on the ground: an additive warm disc (real lights for hundreds of lamps would be too slow) */
let POOL = null;
function lightPool(x, z, w, d, parent, strength = 0.3, y = 0.075) {
  POOL ??= canvasTex(128, 128, (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, 'rgba(255,214,160,1)'); r.addColorStop(0.35, 'rgba(255,200,140,0.5)'); r.addColorStop(1, 'rgba(255,190,120,0)');
    g.fillStyle = r; g.fillRect(0, 0, s, s);
  });
  const key = strength.toFixed(2);
  lightPool.mats ??= {};
  const mat = lightPool.mats[key] ??= new THREE.MeshBasicMaterial({ map: POOL, transparent: true, opacity: strength * 0.3, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
  const m = panel(w, d, mat, x, y, z, 'up', parent, { cast: false, receive: false });
  m.renderOrder = 2;
  return m;
}
/** apron paint, as ICAO Annex 14 and Indian aprons draw it: black-bordered yellow guidance lines, red safety lines */
function apronPaint(yellow, white) {
  const black = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 });
  const red = new THREE.MeshStandardMaterial({ color: 0xb3262b, roughness: 0.85 });
  const hatch = new THREE.MeshStandardMaterial({ transparent: true, depthWrite: false, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2,
    map: canvasTex(256, 256, (g, w, h) => {
      g.strokeStyle = '#b3262b'; g.lineWidth = 14;
      for (let i = -h; i < w + h; i += 52) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + h, h); g.stroke(); }
      g.lineWidth = 18; g.strokeRect(0, 0, w, h);
    }) });
  hatch.map.wrapS = hatch.map.wrapT = THREE.RepeatWrapping;
  const line = (x0, z0, x1, z1, wdt, mat, y = 0.04, parent) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const m = box(len, 0.008, wdt, mat, (x0 + x1) / 2, y, (z0 + z1) / 2, parent || AIRSIDE.root, { cast: false });
    m.rotation.y = Math.atan2(-(z1 - z0), x1 - x0);
    return m;
  };
  const guide = (x0, z0, x1, z1, parent) => { line(x0, z0, x1, z1, 0.6, black, 0.036, parent); line(x0, z0, x1, z1, 0.26, yellow, 0.041, parent); };
  const arc = (cx, cz, r, a0, a1, parent) => {
    const n = 9;
    for (let i = 0; i < n; i++) {
      const a = a0 + (a1 - a0) * (i / n), b = a0 + (a1 - a0) * ((i + 1) / n);
      guide(cx + Math.cos(a) * r, cz + Math.sin(a) * r, cx + Math.cos(b) * r, cz + Math.sin(b) * r, parent);
    }
  };
  /** one nose-in stand: nose at (gx, nz), aircraft running toward +z, taxiway centreline at z = twz */
  const stand = (gx, nz, twz, no, { rot, bay, zebraZ }, parent) => {
    const R = 24, stop = nz + 5.2;
    guide(gx, stop - 1.5, gx, twz - R, parent);                         // lead-in line
    arc(gx + R, twz - R, R, Math.PI, Math.PI / 2, parent);              // turn-ins from both directions
    arc(gx - R, twz - R, R, 0, Math.PI / 2, parent);
    for (const [dz, wd] of [[0, 4.2], [2.6, 2.6], [5.4, 2.6]]) {        // nose-wheel stop bars, by aircraft type
      line(gx - wd / 2, stop + dz, gx + wd / 2, stop + dz, 0.5, black, 0.037, parent);
      line(gx - wd / 2, stop + dz, gx + wd / 2, stop + dz, 0.24, yellow, 0.042, parent);
    }
    // the stand number, read by a pilot turning in from the taxiway
    const num = canvasTex(256, 160, (g, w, h) => {
      g.fillStyle = '#141414'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#e3b62b'; g.font = FONT(800, 120); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(no, w / 2, h / 2 + 8);
    });
    const nm = panel(5.6, 3.5, new THREE.MeshStandardMaterial({ map: num, roughness: 0.85 }), gx + 4.2, 0.043, twz - R - 12, 'up', parent, { cast: false, receive: false });
    nm.renderOrder = 1;
    // red stand safety lines round the aircraft's envelope
    const x0 = gx - 22, x1 = gx + 22, zf = nz - 2.5, zb = twz - 15;
    line(x0, zf, x1, zf, 0.2, red, 0.039, parent); line(x0, zf, x0, zb, 0.2, red, 0.039, parent); line(x1, zf, x1, zb, 0.2, red, 0.039, parent);
    // keep-clear hatching under the jet bridge's sweep
    if (rot) {
      const [rx, rz] = rot, dx = gx - 2.4 - rx, dz = nz + 4.6 - rz, len = Math.hypot(dx, dz) + 5;
      const hm = hatch.clone(); hm.map = hatch.map.clone(); hm.map.repeat.set(len / 4, 2);
      const h = panel(len, 8, hm, rx + dx / 2, 0.045, rz + dz / 2, 'up', parent, { cast: false, receive: false });
      h.rotation.z = Math.atan2(-dz, dx); h.renderOrder = 1;
    }
    // an equipment bay between this stand and the next, and a zebra crossing on the service road
    if (bay !== null) {
      const bz0 = nz + 3, bz1 = nz + 17, b0 = bay - 3.2, b1 = bay + 3.2;
      for (const [a, b, c, d] of [[b0, bz0, b1, bz0], [b0, bz1, b1, bz1], [b0, bz0, b0, bz1], [b1, bz0, b1, bz1]]) line(a, b, c, d, 0.15, white, 0.039, parent);
      line(b0, bz0, b1, bz1, 0.12, white, 0.039, parent);
      for (let k = -3; k <= 3; k++) line(bay + k * 1.0, zebraZ - 3.6, bay + k * 1.0, zebraZ + 3.6, 0.5, white, 0.04, parent);
    }
  };
  return { line, guide, arc, stand, white, red, black };
}


/** runway-holding position, ICAO pattern A across a 23 m taxiway: two solid lines, then two dashed ones on the
    runway side (toward = -1 when the runway lies toward -z) */
function holdLine(x, z, toward, mat, parent) {
  for (let i = 0; i < 2; i++) box(23, 0.01, 0.3, mat, x, 0.042, z - toward * 0.6 * i, parent, { cast: false });
  for (let i = 0; i < 2; i++) for (let d = -10.5; d <= 10.5; d += 2) box(1, 0.01, 0.3, mat, x + d, 0.042, z + toward * (1.2 + 0.6 * i), parent, { cast: false });
}

/* ---------- IGI as it is: runways, taxiways, aprons, bridges and stands from OpenStreetMap ---------- */
const BEARING0 = (() => { // true bearing of the scene's +x (runway 10 -> 28)
  const lat0 = 28.5585512, kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  const e = (77.0848508 - 77.1225627) * kx, n = (28.5672434 - 28.5585512) * ky;
  return Math.atan2(-e, -n);
})();
const bearingOf = (dx, dz) => { // scene direction -> true bearing in degrees
  const a = Math.atan2(dx, -dz) + 0; // angle from scene -z (which is BEARING0 - 90 deg)
  return ((BEARING0 * 180 / Math.PI - 90 + a * 180 / Math.PI) % 360 + 360) % 360;
};
/** Wear and tear for the airfield, in the shader, from world position (and, on ribbons, the distance across):
 *  taxi: rubber tracks down the centreline and main-gear lines, patched repairs, sealed cracks, fuel stains, dust at
 *  the edges; concrete: slab joints, slab-to-slab tone, oil under the stands; runway: rubber in the touchdown zones;
 *  paint: chipped and faded. One program per kind. */
const WEAR_GLSL = `
  float wh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float wn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(wh(i), wh(i + vec2(1, 0)), f.x), mix(wh(i + vec2(0, 1)), wh(i + vec2(1, 1)), f.x), f.y); }
  float wf(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * wn(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }
  float waa(vec2 p, float freq) { vec2 fw = fwidth(p); return clamp(1.0 - max(fw.x, fw.y) * freq * 1.5, 0.0, 1.0); } // 0 once a feature is under a pixel
  uniform float uCloudT;
  // fair-weather cumulus shadows, ~600 m across, drifting east-south-east on a light breeze
  float cloudShade(vec2 p) { vec2 q = p * 0.0013 + vec2(uCloudT * 0.0105, uCloudT * 0.0035);
    return 1.0 - 0.3 * smoothstep(0.55, 0.68, wf(q)); }`;
/** shared clock for the cloud shadows (seconds) */
const CLOUD_T = { value: 0 };
function weather(mat, kind) {
  if (!mat || mat.userData.wear) return mat;
  mat.userData.wear = kind;
  const prev = mat.onBeforeCompile;
  mat.customProgramCacheKey = () => 'wear-' + kind + (mat.map ? '-m' : '') + (mat.transparent ? '-t' : '');
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    sh.uniforms.uRwy = { value: new THREE.Vector4(RWY_Z, RWY_THR, RWY_END, 0) }; sh.uniforms.uCloudT = CLOUD_T;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aAcross; varying vec4 vAcross; varying vec3 vWearP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAcross = aAcross; vWearP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    const body = {
      taxi: `
        if (abs(vWearP.z - uRwy.x) < 30.0 && vWearP.x > uRwy.z - 2.0 && vWearP.x < uRwy.y + 2.0) discard;
        vec2 p = vWearP.xz; float hw = max(vAcross.y, 1.0), a = abs(vAcross.x);
        float path = step(1.5, vAcross.y) * smoothstep(0.0, 30.0, min(vAcross.z, vAcross.w));
        // the photo lends only its grain; the colour is an airport's medium-grey asphalt, not the photo's near-black
        float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
        float avg = dot(texture2D(map, vMapUv, 7.0).rgb * diffuse, vec3(0.2126, 0.7152, 0.0722));
        float grain = clamp(lum / max(avg, 1e-3), 0.7, 1.35);
        vec3 c = vec3(0.092, 0.091, 0.088) * mix(1.0, grain, 0.35);                 // (a light share of the grain: the photo's own tiling stays hidden)
        c *= 0.93 + 0.14 * wf(p * 0.05);                                                 // laid and resurfaced at different times
        // the shoulders: the outer 3 m each side, a paler surface with a joint along it
        float sh = path * smoothstep(hw - 3.05, hw - 2.95, a);
        c = mix(c, vec3(0.13, 0.128, 0.122) * mix(1.0, grain, 0.3), sh);
        c *= 1.0 - path * 0.35 * (1.0 - smoothstep(0.03, 0.09, abs(a - (hw - 3.0)))) * waa(p, 12.0);
        // seams between the 5 m paving lanes, running along the taxiway
        float lane = abs(fract((vAcross.x + hw) / 5.0 + 0.5) - 0.5) * 5.0;
        c *= 1.0 - path * (1.0 - sh) * 0.14 * (1.0 - smoothstep(0.03, 0.08, lane)) * waa(p, 12.0);
        vec2 cl = floor(p / vec2(13.0, 8.0)); float hp = wh(cl);                         // patched repairs
        vec2 fc = abs(fract(p / vec2(13.0, 8.0)) - 0.5);
        c *= mix(1.0, 0.86 + 0.1 * wh(cl + 3.7), step(0.9, hp) * step(max(fc.x, fc.y), 0.38));
        float rub = path * (exp(-a * a / 1.6) * 0.55 + exp(-pow(a - 3.6, 2.0) / 2.2) * 0.35); // nosewheel and main-gear rubber
        c *= 1.0 - rub * (0.16 + 0.14 * wn(p * vec2(0.4, 0.4) + 9.0));
        float r = abs(wf(p * 0.32 + 3.0) - 0.5);                                         // sealed cracks
        c = mix(c, c * 0.55, (1.0 - smoothstep(0.0, 0.008, r)) * step(0.55, wn(p * 0.05)) * 0.6 * waa(p, 8.0));
        c = mix(c, c * 0.7, smoothstep(0.74, 0.88, wf(p * 0.21 + 5.0)) * 0.35);         // the odd fuel stain
        diffuseColor.rgb = c;`,
      concrete: `
        vec2 p = vWearP.xz; vec3 c = diffuseColor.rgb;
        vec2 sl = floor(p / 7.5), f = fract(p / 7.5);
        c *= 0.92 + 0.14 * wh(sl);                                                       // each slab its own tone
        float j = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)) * 7.5;
        c *= mix(1.0 - 0.4 * waa(p, 6.0), 1.0, smoothstep(0.03, 0.12, j));              // joints (fade before they shimmer)
        c *= 0.93 + 0.12 * wf(p * 0.09);
        c = mix(c, c * 0.55, smoothstep(0.68, 0.85, wf(p * 0.18 + 2.0)) * 0.6);         // oil under the stands
        c = mix(c, c * 0.75, smoothstep(0.55, 0.9, wn(p * vec2(0.08, 0.6))) * 0.35);    // tyre scuffs
        diffuseColor.rgb = c;`,
      runway: `
        vec2 p = vWearP.xz; vec3 c = diffuseColor.rgb;
        float main = 1.0 - step(1.5, vAcross.y);
        float a = mix(abs(vAcross.x), abs(vWearP.z - uRwy.x), main), x = vWearP.x;
        float tdz = main > 0.5 ? max(smoothstep(uRwy.y - 1100.0, uRwy.y - 900.0, x) * (1.0 - smoothstep(uRwy.y - 250.0, uRwy.y - 120.0, x)),
                                     smoothstep(uRwy.z + 120.0, uRwy.z + 250.0, x) * (1.0 - smoothstep(uRwy.z + 900.0, uRwy.z + 1100.0, x))) : 0.45;
        float band = 1.0 - smoothstep(6.0, 14.0, a);
        c *= 1.0 - tdz * band * (0.45 + 0.35 * wn(p * vec2(0.05, 1.3)));                // rubber deposits
        c *= 0.92 + 0.14 * wf(p * 0.05);
        c *= 1.0 + waa(p, 3.1) * (0.1 * wn(p * 3.1) - 0.05);
        diffuseColor.rgb = c;`,
      tpaint: `
        if (abs(vWearP.z - uRwy.x) < 30.0 && vWearP.x > uRwy.z - 2.0 && vWearP.x < uRwy.y + 2.0) discard;
        vec2 p = vWearP.xz;
        float chip = smoothstep(0.6, 0.78, wf(p * 1.6 + 4.0)) * 0.6 * waa(p, 5.0);
        diffuseColor.rgb = mix(diffuseColor.rgb * 0.92, vec3(0.2, 0.2, 0.2), chip) * (1.0 + waa(p, 3.0) * (0.12 * wn(p * 3.0) - 0.06));`,
      paint: `
        vec2 p = vWearP.xz;
        float chip = smoothstep(0.6, 0.78, wf(p * 1.6 + 4.0)) * 0.6 * waa(p, 5.0);
        diffuseColor.rgb = mix(diffuseColor.rgb * 0.92, vec3(0.2, 0.2, 0.2), chip) * (1.0 + waa(p, 3.0) * (0.12 * wn(p * 3.0) - 0.06));`,
    }[kind];
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec4 uRwy; varying vec4 vAcross; varying vec3 vWearP;' + WEAR_GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>\n{' + body + '\ndiffuseColor.rgb *= cloudShade(vWearP.xz);\n}');
  };
  mat.needsUpdate = true;
  return mat;
}
function ribbon(lines, y0, mat, parent, uvScale = 12, step = 0) {
  const pos = [], uv = [], idx = [], acr = [];
  let li = 0;
  for (const [w, pts] of lines) {
    const y = y0 + (li++ % 4) * step; // overlapping ribbons (junctions) a few millimetres apart: no z-fighting
    const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const tot = cum[cum.length - 1];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let tx = b[0] - a[0], tz = b[1] - a[1]; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
      const [x, z] = pts[i];
      pos.push(x - tz * w / 2, y, z + tx * w / 2, x + tz * w / 2, y, z - tx * w / 2);
      uv.push((x - tz * w / 2) / uvScale, (z + tx * w / 2) / uvScale, (x + tz * w / 2) / uvScale, (z - tx * w / 2) / uvScale);
      acr.push(-w / 2, w / 2, cum[i], tot - cum[i], w / 2, w / 2, cum[i], tot - cum[i]);
      if (i) { const v = pos.length / 3 - 4; idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3); } // wound to face up
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aAcross', new THREE.Float32BufferAttribute(acr, 4));
  g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat); m.receiveShadow = true; parent.add(m);
  return m;
}
/** Taxiway paint as at a real airport: black-bordered yellow centrelines, double yellow edge lines (left open at
 *  junctions, where another taxiway joins), and at each runway entry the hold-short bars with red runway signs on the ground. */
function paintTaxiways(tx, A, yellow, parent) {
  const paint = (hex) => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const black = weather(paint(0x1a1a1a), 'tpaint'), yel = yellow.clone(); yel.polygonOffset = true; yel.polygonOffsetFactor = -3; yel.polygonOffsetUnits = -3;
  weather(yel, 'tpaint');
  const off = (pts, d) => pts.map(([x, z], i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let tx2 = b[0] - a[0], tz2 = b[1] - a[1]; const L = Math.hypot(tx2, tz2) || 1; tx2 /= L; tz2 /= L;
    return [x - tz2 * d, z + tx2 * d];
  });
  // centrelines: yellow on a black border, so they read on pale concrete as well as asphalt
  ribbon(tx.map(([, pts]) => [1.0, pts]), 0.05, black, parent);
  ribbon(tx.map(([, pts]) => [0.45, pts]), 0.056, yel, parent);
  // junctions: every taxiway end, and wherever two taxiways share a point
  const seen = new Map(), J = [];
  const k = (x, z) => `${Math.round(x / 4)},${Math.round(z / 4)}`;
  tx.forEach(([, pts], ti) => pts.forEach(([x, z], i) => {
    const key = k(x, z), was = seen.get(key);
    if (i === 0 || i === pts.length - 1 || (was !== undefined && was !== ti)) J.push([x, z]);
    seen.set(key, ti);
  }));
  const grid = new Map(), G = 60;
  for (const p of J) { const gk = `${Math.floor(p[0] / G)},${Math.floor(p[1] / G)}`; (grid.get(gk) ?? grid.set(gk, []).get(gk)).push(p); }
  const nearJ = (x, z, r) => { const gx = Math.floor(x / G), gz = Math.floor(z / G);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const p of grid.get(`${gx + i},${gz + j}`) ?? []) if (Math.hypot(p[0] - x, p[1] - z) < r) return true;
    return false; };
  // edges: two thin yellow lines each side, broken off where they would cut across a joining taxiway
  const edges = [];
  for (const [w, pts] of tx) for (const sd of [-1, 1]) for (const d of [w / 2 - 0.9, w / 2 - 1.35]) {
    const o = off(pts, sd * d);
    // resample to ~6 m so the breaks fall close to the junctions
    let run = [];
    for (let i = 1; i < o.length; i++) {
      const [x0, z0] = o[i - 1], [x1, z1] = o[i], L = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(L / 6));
      for (let s2 = i === 1 ? 0 : 1; s2 <= n; s2++) {
        const x = x0 + (x1 - x0) * s2 / n, z = z0 + (z1 - z0) * s2 / n;
        if (nearJ(x, z, w * 1.15)) { if (run.length > 1) edges.push([0.15, run]); run = []; } else run.push([x, z]);
      }
    }
    if (run.length > 1) edges.push([0.15, run]);
  }
  ribbon(edges, 0.053, yel, parent);
  // runway holding points: the nearest runway gives the sign its designators
  const rws = [[[RWY_END, RWY_Z], [RWY_THR, RWY_Z], '10-28']];
  for (const r of A.runways) { const p = []; for (let i = 2; i < r.length; i += 2) p.push([r[i], r[i + 1]]); rws.push([p[0], p[p.length - 1], r[1]]); }
  const nearRwy = (x, z) => { let best = null, bd = 1e9;
    for (const [a, b, ref] of rws) { const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2));
      const qx = a[0] + dx * t, qz = a[1] + dz * t, d = Math.hypot(x - qx, z - qz); if (d < bd) { bd = d; best = { q: [qx, qz], d, ref }; } }
    return best; };
  const named = (x, z) => { let best = '10-28', bd = 1e9; for (const [a, b, ref] of rws) if (ref) { const d = Math.min(Math.hypot(a[0] - x, a[1] - z), Math.hypot(b[0] - x, b[1] - z)); if (d < bd) { bd = d; best = ref; } } return best.replace('/', '-'); };
  const holdTex = canvasTex(512, 64, (g, w, h) => { // dashed pair (runway side, top), solid pair below, on a black band
    g.fillStyle = '#161616'; g.fillRect(0, 0, w, h); g.fillStyle = '#e2b52c';
    for (const y of [6, 20]) for (let x = 0; x < w; x += 46) g.fillRect(x + 4, y, 30, 8);
    for (const y of [36, 50]) g.fillRect(0, y, w, 8);
  });
  const holdMat = weather(new THREE.MeshStandardMaterial({ map: holdTex, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), 'paint');
  const signMats = new Map();
  const signMat = (txt) => signMats.get(txt) ?? signMats.set(txt, (() => {
    const t = canvasTex(512, 192, (g, w, h) => {
      g.fillStyle = '#141414'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#c4161c'; g.fillRect(10, 10, w - 20, h - 20);
      g.fillStyle = '#f4f1ea'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = FONT(800, txt.length > 6 ? 104 : 124);
      g.fillText(txt, w / 2, h / 2 + 6);
    });
    return weather(new THREE.MeshStandardMaterial({ map: t, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), 'paint');
  })()).get(txt);
  // flat quads, batched into one mesh per material: centre c, across-axis a, toward-runway axis r (texture top
  // toward the runway)
  const batches = new Map();
  const quad = (c, a, r, wa, wr, mat, y) => {
    const b = batches.get(mat) ?? batches.set(mat, { pos: [], uv: [], idx: [] }).get(mat), n = b.pos.length / 3;
    for (const [i, j] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.pos.push(c[0] + a[0] * i * wa / 2 + r[0] * j * wr / 2, y, c[1] + a[1] * i * wa / 2 + r[1] * j * wr / 2);
    b.uv.push(0, 0, 1, 0, 0, 1, 1, 1);
    const up = (a[1] * r[0] - a[0] * r[1]) > 0; // keep the faces pointing up whichever way the axes turn
    b.idx.push(...(up ? [0, 1, 2, 1, 3, 2] : [0, 2, 1, 1, 2, 3]).map((k) => k + n));
  };
  // where a taxiway crosses into a runway's protected strip, paint the hold line across it
  const done = [];
  for (const [w, pts] of tx) for (let i = 1; i < pts.length; i++) {
    const [x0, z0] = pts[i - 1], [x1, z1] = pts[i], L = Math.hypot(x1 - x0, z1 - z0); if (L < 1) continue;
    for (let d = 0; d < L; d += 4) {
      const x = x0 + (x1 - x0) * d / L, z = z0 + (z1 - z0) * d / L, R = nearRwy(x, z);
      if (!R || Math.abs(R.d - 95) > 2.5) continue;                // ~95 m from the runway centreline
      if (done.some(([hx, hz]) => Math.hypot(hx - x, hz - z) < 40)) continue;
      done.push([x, z]);
      let rx = R.q[0] - x, rz = R.q[1] - z; const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
      let ax = (x1 - x0) / L, az = (z1 - z0) / L;                // across = perpendicular to the taxiway
      [ax, az] = [-az, ax];
      if (ax * -rz + az * rx < 0) { ax = -ax; az = -az; }
      quad([x, z], [ax, az], [rx, rz], w - 1, 3.2, holdMat, 0.06);
      const txt = named(x, z);
      holdSign(parent, x - rx * 2, z - rz * 2, rx, rz, w, txt);
      for (const s2 of [-1, 1]) quad([x - rx * 7 + ax * s2 * (w / 4), z - rz * 7 + az * s2 * (w / 4)], [ax, az], [rx, rz], w / 2 - 2.5, 3.6, signMat(txt), 0.06);
      // the enhanced centreline: dashed yellow either side of the centreline for the last 45 m before the bar
      for (let d = 3; d < 47; d += 4) for (const s2 of [-1, 1]) quad([x - rx * d + ax * s2 * 0.62, z - rz * d + az * s2 * 0.62], [ax, az], [rx, rz], 0.15, 2.6, yel, 0.058);
      break;
    }
  }
  for (const [mat, b] of batches) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(b.pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setIndex(b.idx);
    const m = new THREE.Mesh(g, mat); m.receiveShadow = true; parent.add(m);
  }
}
/** An ALSF-2-style approach lighting system off one threshold (dir +1: it runs out toward +x): five-light white
 *  barrettes every 30 m to 900 m on stands, crossbars at 150, 300 and 600 m, red side rows over the inner 270 m,
 *  a sequenced strobe, the threshold's green bar and a PAPI on the left of the touchdown zone. */
function approachLights(air, tx, dir) {
  const W = [], R = [], G = [], bars = [], posts = [];
  for (let d = 30; d <= 900; d += 30) {
    const x = tx + dir * d;
    for (let k = -2; k <= 2; k++) W.push([x, 1.7, RWY_Z + k * 1.05]);
    bars.push([x, RWY_Z, 4.8]); posts.push([x, RWY_Z]);
    const hw = d === 300 ? 15 : d === 150 || d === 600 ? 8 : 0;          // crossbars
    if (hw) { for (let z = 3.5; z <= hw; z += 1.5) for (const sd of [-1, 1]) W.push([x, 1.7, RWY_Z + sd * z]); bars.push([x, RWY_Z, hw * 2 + 1]); for (const sd of [-1, 1]) posts.push([x, RWY_Z + sd * hw]); }
    if (d <= 270) for (const sd of [-1, 1]) {                              // red side-row barrettes
      for (let k = 0; k < 3; k++) R.push([x, 1.7, RWY_Z + sd * (11 + k * 1.5)]);
      bars.push([x, RWY_Z + sd * 12.5, 3.6]); posts.push([x, RWY_Z + sd * 12.5]);
    }
  }
  for (let z = -22; z <= 22; z += 2.5) G.push([tx + dir * 3, 0.5, RWY_Z + z]); // threshold bar, just outside the paint
  const metal = new THREE.MeshStandardMaterial({ color: 0x3d4146, roughness: 0.7, metalness: 0.4 });
  const pm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 1.6, 0.16).translate(0, 0.8, 0), metal, posts.length);
  const bm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, 0.14, 1), metal, bars.length);
  const o = new THREE.Object3D();
  posts.forEach(([x, z], i) => { o.position.set(x, 0, z); o.scale.set(1, 1, 1); o.updateMatrix(); pm.setMatrixAt(i, o.matrix); });
  bars.forEach(([x, z, L], i) => { o.position.set(x, 1.6, z); o.scale.set(1, 1, L); o.updateMatrix(); bm.setMatrixAt(i, o.matrix); });
  for (const m of [pm, bm]) { m.userData.keep = true; m.userData.dynamic = true; air.add(m); }
  glowPoints(W, 0xfff4dc, 3.2, air);
  glowPoints(R, 0xff3b30, 3.0, air);
  glowPoints(G, 0x5dff9a, 3.2, air);
  // PAPI: four boxes left of the landing direction, 330 m in; on the glide path the two nearest the runway show red
  const side = dir > 0 ? 1 : -1, papiW = [], papiR = [];
  for (let i = 0; i < 4; i++) {
    const z = RWY_Z + side * (38 + i * 9), x = tx - dir * 330;
    box(1.4, 0.9, 1.0, metal, x, 0.45, z, air, { cast: false });
    (i < 2 ? papiR : papiW).push([x + dir * 0.55, 0.65, z]);
  }
  glowPoints(papiR, 0xff3b30, 4.2, air);
  glowPoints(papiW, 0xfff4dc, 4.2, air);
  return { pts: glowPoints([[tx + dir * 900, 2.1, RWY_Z]], 0xffffff, 10, air), tx, dir };
}
function buildIGI(air, { white, yellow, tarmacAt, apronMat }) {
  const A = AERO.data?.aero;
  if (!A) return;
  const pl = (arr, from) => { const pts = []; for (let i = from; i < arr.length; i += 2) pts.push([arr[i], arr[i + 1]]); return pts; };
  const igi = new THREE.Group(); igi.userData.dynamic = true; air.add(igi);
  // aprons: pale concrete slabs, at their real outlines
  const ag = [];
  for (const a of A.aprons) { const pts = []; for (let i = 0; i < a.length; i += 2) pts.push(new THREE.Vector2(a[i], -a[i + 1]));
    try { const g = new THREE.ShapeGeometry(new THREE.Shape(pts)); g.rotateX(-Math.PI / 2); const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, -uv.getY(i)); ag.push(g); } catch { /* bad ring */ } }
  if (ag.length) {
    const am = apronMat.clone(); am.map = repeatOf(apronMat.map, 1 / 22, 1 / 22); CONCRETE_GROUND.push(am);
    const m = new THREE.Mesh(mergeGeometries(ag), am); m.position.y = 0.018; m.receiveShadow = true; igi.add(m);
  }
  // taxiways: asphalt with a yellow centreline, green centre lights and blue edge lights
  const tx = A.taxiways.map((t) => [t[0], pl(t, 2)]);
  const fillK = [[23, [[-770, TWY_Z], [-344, TWY_Z]]], [23, [[459, TWY_Z], [571, TWY_Z]]]]; // K in full in front of the hangars, where OSM breaks it
  const tm = new THREE.MeshStandardMaterial({ map: repeatOf(T.asphalt, 1, 1), color: 0xa3a19c, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1 });
  ASPHALT.push(tm);
  weather(tm, 'taxi');
  ribbon(tx, 0.028, tm, igi, 12, 0.004); // pavement 28-40 mm up; all paint sits above it
  ribbon(fillK, 0.045, tm, igi);         // the filler K on top of the OSM pieces it covers
  tx.push(...fillK);
  paintTaxiways(tx, A, yellow, igi);
  const tc = [], te = [];
  for (const [w, pts] of tx) for (let i = 1; i < pts.length; i++) {
    const [x0, z0] = pts[i - 1], [x1, z1] = pts[i], L = Math.hypot(x1 - x0, z1 - z0); if (!L) continue;
    const nx = -(z1 - z0) / L, nz = (x1 - x0) / L;
    for (let d = 0; d < L; d += 30) tc.push([x0 + (x1 - x0) * d / L, 0.3, z0 + (z1 - z0) * d / L]);
    for (let d = 15; d < L; d += 60) for (const s2 of [-1, 1]) te.push([x0 + (x1 - x0) * d / L + s2 * nx * (w / 2 + 1), 0.4, z0 + (z1 - z0) * d / L + s2 * nz * (w / 2 + 1)]);
  }
  glowPoints(tc, 0x52f08a, 1.6, igi);
  glowPoints(te.map(([x, , z]) => [x, 0.36, z]), 0x4a7dff, 1.9, igi);
  lightFixtures(te, 0x2f5dff, igi);
  // IGI's other runways: grooved asphalt, edges, centreline, piano keys and designators
  const rm = RUNWAY_MAT || tm;
  const re = [];
  for (const r of A.runways) {
    const w = r[0], ref = r[1], pts = pl(r, 2);
    ribbon([[w, pts]], 0.064, rm, igi, 30);
    ribbon([[0.9, pts]], 0.07, white, igi).visible = false; // (a solid line would read wrong: dashes below)
    const [ax, az] = pts[0], [bx, bz] = pts[pts.length - 1], L = Math.hypot(bx - ax, bz - az), dx = (bx - ax) / L, dz = (bz - az) / L, nx = -dz, nz = dx;
    for (const s2 of [-1, 1]) ribbon([[0.9, [[ax + nx * s2 * (w / 2 - 1.5), az + nz * s2 * (w / 2 - 1.5)], [bx + nx * s2 * (w / 2 - 1.5), bz + nz * s2 * (w / 2 - 1.5)]]]], 0.07, white, igi);
    for (let d = 110; d < L - 110; d += 50) ribbon([[0.9, [[ax + dx * d, az + dz * d], [ax + dx * (d + 30), az + dz * (d + 30)]]]], 0.07, white, igi);
    for (let d = 0; d <= L; d += 60) for (const s2 of [-1, 1]) re.push([ax + dx * d + nx * s2 * (w / 2 + 1.5), 0.5, az + dz * d + nz * s2 * (w / 2 + 1.5)]);
    if (!ref) continue;
    const parts = ref.split('/'), brg = bearingOf(dx, dz);
    const pick = (b) => parts.slice().sort((p, q) => Math.abs(((parseInt(p) * 10 - b + 540) % 360) - 180) - Math.abs(((parseInt(q) * 10 - b + 540) % 360) - 180)).reverse()[0];
    for (const [ex, ez, ddx, ddz, b] of [[ax, az, dx, dz, brg], [bx, bz, -dx, -dz, (brg + 180) % 360]]) {
      const label = pick(b);
      const tex = canvasTex(256, 256, (g, cw, ch) => { g.fillStyle = '#e9e9e4'; g.font = FONT(700, label.length > 2 ? 120 : 170); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, cw / 2, ch / 2 + 10); });
      const lab = panel(22, 22, new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.8 }), ex + ddx * 75, 0.055, ez + ddz * 75, 'up', igi, { cast: false, receive: false });
      lab.rotation.z = Math.atan2(-ddx, -ddz);
      for (let i = 0; i < 6; i++) for (const s2 of [-1, 1]) { const o = s2 * (4 + i * 3) * (w / 45);
        ribbon([[1.8, [[ex + ddx * 10 + nx * o, ez + ddz * 10 + nz * o], [ex + ddx * 40 + nx * o, ez + ddz * 40 + nz * o]]]], 0.072, white, igi); }
    }
  }
  glowPoints(re, 0xfff1d6, 2.6, igi);
  // jet bridges at the real bridge positions, rotunda at the terminal end
  for (const b of A.bridges) jetBridge(b[0], b[1], b[2], b[3], 3.4, igi);
  // aircraft on the real stands, nose to the terminal: airline models near the academy and T1, light stand-ins far off
  const rnd = mulberry32(31);
  const near = (x, z) => FIELD !== 'delhi' || Math.hypot(x, z + 500) < 1100 || Math.hypot(x + 2700, z - 900) < 900; // the academy side, T1, and T3's piers
  const bridgeAt = (x, z) => { let best = null, bd = 70; for (const b of A.bridges) { const d = Math.hypot(b[2] - x, b[3] - z); if (d < bd) { bd = d; best = b; } } return best; };
  const taxiNear = (x, z) => { let best = null, bd = 1e9; for (const [, pts] of tx) for (let i = 1; i < pts.length; i++) { const [x0, z0] = pts[i - 1], [x1, z1] = pts[i], L2 = (x1 - x0) ** 2 + (z1 - z0) ** 2 || 1, k = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (z - z0) * (z1 - z0)) / L2)), qx = x0 + (x1 - x0) * k, qz = z0 + (z1 - z0) * k, d = Math.hypot(x - qx, z - qz); if (d < bd) { bd = d; best = [qx, qz]; } } return best; };
  // T1 is domestic; T3 has the international carriers too
  const T1L = ['n_igo', 'n_igo', 'n_igo', 'n_iad', 'n_aic', 'n_vti'], T3L = ['n_igo', 'n_aic', 'n_vti', 'n_iad', 'b_vir', 'b_baw', 'b_ana', 'b_eth', 'b_tha', 'b_msr', 'b_gfa', 'n_kac', 'n_jzr', 'n_kne', 'n_oms', 'n_gfa', 'n_alk', 'n_drk', 'n_axm'];
  const tails = [M.paintNavy, new THREE.MeshStandardMaterial({ color: 0xa8322d, roughness: 0.7 }), new THREE.MeshStandardMaterial({ color: 0x1f7a7a, roughness: 0.7 }), new THREE.MeshStandardMaterial({ color: 0xd9792b, roughness: 0.7 })];
  for (const [x, z, standName] of A.stands) {
    if (FIELD !== 'delhi') standNumber(x, z, standName, air);
    if (rnd() > 0.82) continue; // some stands stand empty
    const b = bridgeAt(x, z);
    let dx, dz;
    if (b) { dx = b[0] - b[2]; dz = b[1] - b[3]; } else { const q = taxiNear(x, z); if (!q) continue; dx = x - q[0]; dz = z - q[1]; }
    const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    const isNear = near(x, z), LL = x < -1800 ? T3L : T1L, livery = isNear ? LL[(rnd() * LL.length) | 0] : null;
    const len = livery?.startsWith('b_') ? 62.8 : 37.6, back = len / 2 - 4;
    const jet = bakeGroup(airliner({ tail: tails[(rnd() * tails.length) | 0], gear: true }));
    jet.scale.setScalar(livery?.startsWith('b_') ? 67 : 40);
    jet.position.set(x - dx * back, 4.2, z - dz * back);
    jet.rotation.y = Math.atan2(-dz, dx);
    jet.userData.dynamic = true;
    if (isNear) { jet.userData.livery = livery; AIRSIDE.placeholders.jets.push(jet); } else jet.userData.keepSimple = true;
    air.add(jet);
    if (FIELD !== 'delhi' && dz > 0.9) standCrew(x - dx * back, z - dz * back, air); // nose-in toward the terminal (+z)
  }
}
/** the stand's number painted on the apron in front of it, read from the taxiway */
function standNumber(x, z, name, parent) {
  const n = String(name).replace(/\D/g, '');
  const m = panel(6, 6, new THREE.MeshStandardMaterial({ transparent: true, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -4,
    map: canvasTex(128, 128, (c, w, h) => { c.fillStyle = '#e2b52c'; c.font = FONT(800, 110, 'Arial, sans-serif'); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(n, w / 2, h / 2 + 6); }) }), x, 0.06, -97, 'up', parent, { cast: false, receive: true });
  m.rotation.z = Math.PI;
  void z;
}
/** a turnaround at a remote stand, nose toward +z: stairs at the front door, belt loader at the hold, power unit,
 *  chocks, and the crew (wearAndCrew) */
function standCrew(cx, cz, parent) {
  const g = new THREE.Group(), nose = cz + 18.8, put = (o, px, pz, yaw) => { o.position.set(px, 0, pz); o.rotation.y = yaw; g.add(o); return o; };
  put(airstairs(), cx + 2.4, nose - 4.6, 0);
  put(beltLoader(), cx - 2.6, nose - 9.0, Math.PI);
  put(gpu(), cx - 4.5, nose - 1.8, Math.PI / 2);
  const G = gseMats();
  for (const s of [-1, 1]) box(0.25, 0.2, 0.4, G.yellow, cx + s * 0.5, 0.1, nose - 5.2, g);
  wearAndCrew(cx, cz, 1, g, { crew: 3 });
  const kb = bakeGroup(g); kb.userData.dynamic = true; parent.add(kb);
}

/** Maintenance hangars along taxiway K, either side of the academy, built from "Hangar Embraer" by Simaoelis3D
 *  (CC BY 4.0, door opened and apron slab removed): the band round the clerestory in each airline's colour, its logo
 *  over the door and on the roof, lit bays inside and an aircraft nosed in. Doors face north onto the taxiway; the
 *  aircraft sit deep enough that traffic on K clears their tails. The model arrives after the first frame (dressHangars). */
const HANGARS = [];
function buildHangars(air, apronMat) {
  const zf = -70; // door line
  const H = [
    { x: -450, logo: 'air-india', band: '#d61f35', jet: 'n_aic' },
    { x: -570, logo: 'indigo', band: '#0b1f8f', jet: 'n_igo' },
    { x: -690, logo: 'akasa-air', band: '#ff6a2b', jet: null },
    { x: 400, logo: 'airbus', band: '#14205b', jet: 'house' },
    { x: 548, logo: 'boeing', band: '#0b3fa8', jet: 'b_vir', s: 7.2 },
  ];
  const interior = new THREE.MeshStandardMaterial({ color: 0xb9bdc2, roughness: 0.85, metalness: 0.15, side: THREE.BackSide }); // a pale ribbed lining, lit
  interior.userData.rep = [14, 2]; RIBBED.push(interior);
  const floor = new THREE.MeshStandardMaterial({ color: 0xa2a4a0, roughness: 0.4, metalness: 0.05 });
  const lamp = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xfff4e2, emissiveIntensity: 1.3 });
  lamp.userData.dayE = 1.3; LAMP_MATS.push(lamp);
  const stand = new THREE.MeshStandardMaterial({ color: 0xe0b020, roughness: 0.6 });
  const yel = new THREE.MeshBasicMaterial({ color: 0xe0b020 });
  const glow = [];
  for (const h of H) {
    const s = h.s ?? 4.6, W = 12.98 * s, D = 13.42 * s, dW = 9.9 * s, dH = 3.75 * s, cz = zf + D / 2;
    Object.assign(h, { s, zf });
    // inside: a dark lining, a polished floor, rows of lights (the model's own walls are single-sided)
    h.liner = box(W * 0.97, 4.95 * s, D * 0.97, interior, h.x, 2.475 * s, cz, air, { cast: false, receive: false }); // up to the roof: nothing shows through
    h.liner.visible = false; // shown with the model: on its own, from outside, it reads as a black box
    panel(W * 0.96, D * 0.96, floor, h.x, 0.04, cz, 'up', air);
    for (let i = -2; i <= 2; i++) for (const k of [0.3, 0.65]) {
      box(W * 0.12, 0.25, 1.2, lamp, h.x + i * W * 0.18, 4.3 * s, zf + D * k, air, { cast: false, receive: false });
      glow.push([h.x + i * W * 0.18, 4.2 * s, zf + D * k]);
    }
    lightPool(h.x, cz, W * 0.9, D, air, 0.45, 0.09);
    // the apron in front, out to the taxiway edge, with a lead-in line
    const am = apronMat.clone(); am.map = repeatOf(apronMat.map, (W + 16) / 22, 36 / 22); am.polygonOffset = true; am.polygonOffsetFactor = -2; am.polygonOffsetUnits = -2; CONCRETE_GROUND.push(am);
    panel(W + 16, 36, am, h.x, 0.09, zf - 18, 'up', air);
    // the lead-in line: off K's centreline, straight in through the door
    const lz0 = TWY_Z, lz1 = zf + D * 0.7;
    panel(0.35, lz1 - lz0, yel, h.x, 0.1, (lz0 + lz1) / 2, 'up', air, { cast: false, receive: false });
    if (h.jet) {
      const wide = h.jet.startsWith('b_'), len = wide ? 62.8 : 37.6, nose = zf + (wide ? 72 : 20); // the 787 all the way in: its span barely clears the door
      // the hangar floor at work, around the parked jet (nose toward +z): docks beside the nose and outboard of each
      // engine, tool carts, cones round the nose, and crew on the floor and up on the docks
      const kit = new THREE.Group(), eX = wide ? 9.8 : 5.75, eZ = nose - (wide ? 21 : 11.5), nH = wide ? 4.6 : 3.6, eH = wide ? 3.6 : 2.6;
      for (const sd of [-1, 1]) workStand(kit, h.x + sd * 3.4, nose - 4.5, nH, sd);
      for (const sd of [-1, 1]) workStand(kit, h.x + sd * (eX + 3.2), eZ - 1, eH, sd);
      for (const [dx, dz, a] of [[-eX - 7, -2, 0.4], [eX + 6.5, 3, -0.8], [-1.5, 6, 1.6]]) toolCart(kit, h.x + dx, nose + dz, a);
      for (const [dx, dz] of [[-2.2, 1.5], [2.2, 1.5], [0, 3]]) cone(kit, h.x + dx, nose + dz);
      // along the side walls: parts racks; an engine on its transport stand; a wing-jack
      for (const sd of [-1, 1]) for (let k = 0; k < 4; k++) { const rx = h.x + sd * (dW * 0.5 - 1.6), rz = zf + 14 + k * 9; // just inside the side walls (the door's width is the bay's)
        for (const yy of [0.2, 1.4, 2.6]) box(1.2, 0.08, 6.5, KIT.grey ?? kitMats().grey, rx, yy, rz, kit, { cast: true, receive: true });
        for (const dz of [-3.2, 3.2]) box(0.1, 3, 0.1, kitMats().yel, rx, 1.5, rz + dz, kit, { cast: true, receive: true });
        for (let j = 0; j < 3; j++) box(0.8, 0.7, 1.2, j % 2 ? kitMats().red : kitMats().deck, rx, 0.65 + j * 1.2 * (k % 2), rz - 2 + j * 1.8, kit, { cast: true, receive: true }); }
      const ex = h.x - eX - 9, ez = eZ - 16;
      box(3.2, 0.9, 4.6, kitMats().yel, ex, 0.45, ez, kit, { cast: true, receive: true });
      cyl(1.05, 0.9, 3.4, kitMats().grey, ex, 2.0, ez, kit, 16, { cast: true, receive: true }).rotation.x = Math.PI / 2;
      cyl(0.95, 0.95, 0.06, kitMats().dark, ex, 2.0, ez + 1.72, kit, 16, { cast: false, receive: true }).rotation.x = Math.PI / 2;
      crew(kit, [[h.x - 3.4, nose - 4, nH, 0.3], [h.x + eX + 3.2, eZ - 2, eH, -1.6], [h.x + 2.5, nose + 4, 0, 3.4], [h.x - eX - 6, nose - 1, 0, -0.6], [h.x + 1, zf - 8, 0, 3.1]]);
      const kb = bakeGroup(kit); kb.userData.dynamic = true; air.add(kb);
      const jet = bakeGroup(airliner({ tail: new THREE.MeshStandardMaterial({ color: new THREE.Color(h.band), roughness: 0.7 }), gear: true }));
      jet.scale.setScalar(wide ? 67 : 40);
      jet.position.set(h.x, 4.2, nose - len / 2);
      jet.rotation.y = -Math.PI / 2;                                                                                  // nose toward +z, into the hangar
      jet.userData.dynamic = true;
      if (h.jet !== 'house') jet.userData.livery = h.jet;
      AIRSIDE.placeholders.jets.push(jet);
      air.add(jet);
    } else { // nothing in: the door stays shut, light seeping out underneath
      const door = new THREE.MeshStandardMaterial({ color: 0xe9e2cf, roughness: 0.75, metalness: 0.2 }); door.userData.rep = [dW / 2.5, dH / 6]; RIBBED.push(door);
      box(dW, dH, 0.5, door, h.x, dH / 2, zf + 0.6, air);
      for (let i = 1; i < 6; i++) box(0.25, dH, 0.7, M.metalDark, h.x - dW / 2 + i * (dW / 6), dH / 2, zf + 0.35, air);
      box(dW * 0.9, 0.5, 0.1, lamp, h.x, 0.35, zf + 0.2, air, { cast: false });
    }
    HANGARS.push(h);
  }
  glowPoints(glow, 0xfff1d8, 2.4, air);
}
/** The training field's own buildings, west of the hangar row along taxiway K: a small terminal with a glass airside
 *  front (its five remote stands come from data/airfield.json), the control tower, the fire station, the fuel farm,
 *  and the school's GA apron with a line of trainers (placeholders until the Cessna 182 model arrives). */
function buildFieldBuildings(air) {
  const std = (c, r = 0.8, m = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
  const concrete = std(0xd8d4cb, 0.85), white = std(0xeeeeea, 0.7), dark = std(0x2b3040, 0.8), metal = std(0x9aa0a6, 0.5, 0.6);
  const glass = new THREE.MeshStandardMaterial({ color: 0x3d5566, roughness: 0.08, metalness: 0.6, envMapIntensity: 1.3 });
  const red = std(0xb3201b, 0.6), navy = std(0x111c44, 0.75), o = { cast: true, receive: true }, g = new THREE.Group();
  const sign = (txt, w, h, bg = '#111c44', fg = '#ffffff') => new THREE.MeshStandardMaterial({ roughness: 0.6, emissive: 0xffffff, emissiveIntensity: 0.1,
    map: canvasTex(512, Math.round(512 * h / w), (c, cw, ch) => { c.fillStyle = bg; c.fillRect(0, 0, cw, ch); c.fillStyle = fg; c.font = FONT(800, ch * 0.62, 'Arial, sans-serif'); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(txt, cw / 2, ch / 2 + 2); }) });
  // terminal: 200 m long, a glazed airside face under a deep canopy, a plant room on the roof
  const TX = -1060, TZ = -30;
  box(200, 9, 24, concrete, TX, 4.5, TZ, g, o);
  box(196, 6.4, 0.3, glass, TX, 4.1, TZ - 12.1, g, { cast: false, receive: true });
  for (let x = -96; x <= 96; x += 6) box(0.25, 6.6, 0.45, dark, TX + x, 4.1, TZ - 12.2, g, o);
  box(204, 0.5, 9, white, TX, 8.6, TZ - 16, g, o);
  for (let x = -96; x <= 96; x += 24) cyl(0.25, 0.25, 8.4, metal, TX + x, 4.2, TZ - 20, g, 10, o);
  box(40, 3, 14, concrete, TX + 40, 10.5, TZ + 2, g, o);
  panel(36, 3.2, sign('TERMINAL', 36, 3.2), TX, 10.8, TZ - 12.3, '-z', g, { cast: false, receive: false });
  // the landside front: glazed entrances under a canopy, Departures and Arrivals
  for (const [dx, label] of [[-45, 'DEPARTURES'], [45, 'ARRIVALS']]) {
    box(34, 5.2, 0.3, glass, TX + dx, 3.1, TZ + 12.1, g, { cast: false, receive: true });
    for (let x = -16; x <= 16; x += 4) box(0.22, 5.4, 0.4, dark, TX + dx + x, 3.1, TZ + 12.2, g, o);
    box(40, 0.45, 8, white, TX + dx, 6.2, TZ + 16, g, o);
    for (const x of [-18, 18]) cyl(0.2, 0.2, 6, metal, TX + dx + x, 3, TZ + 19.6, g, 8, o);
    panel(14, 1.3, sign(label, 14, 1.3, '#111c44', '#ffffff'), TX + dx, 7.3, TZ + 12.4, '+z', g, { cast: false, receive: false });
  }
  box(200, 0.3, 4, std(0xbab4a8, 0.9), TX, 0.15, TZ + 14, g, o); // the kerb
  box(204, 0.5, 26, std(0x8e8a83, 0.9), TX, 9.2, TZ, g, o);
  // control tower: a base block, a tapering shaft, the gallery and the glazed cab, the radar on top
  const CX = -805, CZ = -34;
  box(22, 4.5, 14, concrete, CX, 2.25, CZ, g, o);
  cyl(2.4, 3.1, 24, concrete, CX, 4.5 + 12, CZ, g, 16, o);
  cyl(5.6, 5.6, 0.5, white, CX, 28.6, CZ, g, 16, o);
  cyl(5.2, 4.4, 3.8, glass, CX, 30.8, CZ, g, 8, { cast: false, receive: true });
  for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2 + Math.PI / 8; box(0.25, 3.8, 0.25, dark, CX + Math.cos(a) * 4.85, 30.8, CZ + Math.sin(a) * 4.85, g, o).rotation.y = -a; }
  cyl(6, 6, 0.6, navy, CX, 33, CZ, g, 8, o);
  cyl(0.25, 0.25, 3, metal, CX, 34.8, CZ, g, 8, o);
  const radar = box(3.4, 0.5, 0.25, metal, CX, 36.4, CZ, g, o);
  radar.userData.keep = true;
  radar.onBeforeRender = () => { radar.rotation.y = NOW / 1000 * 1.6; radar.updateMatrixWorld(); };
  blinker(glowPoints([[CX, 37, CZ]], 0xff3a20, 5, g), 1.4, 0, 0.3);
  // fire station: four red doors onto the airside
  const FX = -1390, FZ = -30;
  box(46, 7.5, 20, concrete, FX, 3.75, FZ, g, o);
  for (let i = 0; i < 4; i++) box(9, 5.6, 0.3, red, FX - 16.5 + i * 11, 2.8, FZ - 10.1, g, o);
  panel(22, 2, sign('FIRE STATION', 22, 2, '#b3201b'), FX, 6.4, FZ - 10.2, '-z', g, { cast: false, receive: false });
  box(14, 3.4, 4.4, red, FX - 30, 1.9, FZ - 16, g, o); box(5, 2.6, 4.2, std(0xe8e8e8, 0.5), FX - 25, 2.1, FZ - 16, g, o); // a crash tender outside
  for (const dx of [-34, -27, -22]) for (const s of [-1, 1]) cyl(0.65, 0.65, 0.5, dark, FX + dx, 0.65, FZ - 16 + s * 2.2, g, 12, o).rotation.x = Math.PI / 2;
  // fuel farm: three tanks inside a low bund, a pump house
  const UX = -1640, UZ = -40;
  box(70, 1.2, 30, concrete, UX, 0.6, UZ, g, o);
  for (const dx of [-22, 0, 22]) { cyl(7, 7, 9, white, UX + dx, 4.5 + 0.6, UZ, g, 24, o); cyl(7.1, 7.1, 0.4, metal, UX + dx, 9.8, UZ, g, 24, o); }
  box(8, 3.5, 6, concrete, UX + 42, 1.75, UZ, g, o);
  const kb = bakeGroup(g); kb.userData.dynamic = true; air.add(kb);
  // the GA apron: the school's trainers in a line, noses toward the taxiway, wingtip cones
  const fleet = [M.paintNavy, new THREE.MeshStandardMaterial({ color: 0x1f6f8a, roughness: 0.7 })];
  for (let i = 0; i < 10; i++) {
    if (i === 3) continue; // (that one is out taxiing: see buildFieldExtras)
    const x = -1515 + i * 22, tr = bakeGroup(trainer(fleet[i % 2]));
    tr.position.set(x, 0, -72); tr.rotation.y = -Math.PI / 2; tr.userData.dynamic = true;
    air.add(tr); AIRSIDE.placeholders.trainers.push(tr);
  }
}
/** The rest of the training field: the terminal forecourt (car park, flags, palms, a bus shelter), the flying club
 *  with its roof terrace, a trainer taxiing out to K and back with pilots walking the line and a fuel bowser, the
 *  perimeter road with a patrol jeep and a guard post at the west gate, and the weather station north of the runway. */
function buildFieldExtras(air) {
  const std = (c, r = 0.8, m = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
  const concrete = std(0xd8d4cb, 0.85), white = std(0xf2f1ec, 0.7), steel = std(0x8d9399, 0.5, 0.6), navy = std(0x111c44, 0.75);
  const o = { cast: true, receive: true }, g = new THREE.Group();
  const asphalt = (w, d) => { const m = new THREE.MeshStandardMaterial({ map: repeatOf(T.asphalt, w / 12, d / 12), color: 0x8e8e8e, roughness: 0.92 }); ASPHALT.push(m); return m; };
  const text = (txt, w, h, bg, fg) => new THREE.MeshStandardMaterial({ roughness: 0.6, emissive: 0xffffff, emissiveIntensity: 0.08,
    map: canvasTex(512, Math.round(512 * h / w), (c, cw, ch) => { c.fillStyle = bg; c.fillRect(0, 0, cw, ch); c.fillStyle = fg; c.font = FONT(800, ch * 0.62, 'Arial, sans-serif'); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(txt, cw / 2, ch / 2 + 2); }) });
  // forecourt: two car parks either side of Terminal Road, bay lines, parked cars, flags, palms, a bus shelter
  const bayLine = std(0xeeeeea, 0.8), cars = [];
  for (const cx of [-1116, -1004]) {
    panel(88, 28, asphalt(88, 28), cx, 0.045, 16, 'up', g, { cast: false, receive: true });
    for (const row of [8, 24]) for (let i = 0; i < 31; i++) { const x = cx - 42 + i * 2.8; box(0.12, 0.01, 4.8, bayLine, x, 0.06, row, g, { cast: false }); if (i < 30 && Math.random() < 0.7) cars.push([x + 1.4, row]); }
  }
  const carGeo = vehicleGeo([[4.3, 0.75, 1.78, 0, 0.72, 0, 1], [2.3, 0.62, 1.62, -0.3, 1.38, 0, 0.16]], { wheels: [[1.35, 0.82, 0.33], [1.35, -0.82, 0.33], [-1.35, 0.82, 0.33], [-1.35, -0.82, 0.33]] });
  const cm = new THREE.InstancedMesh(carGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3 }), cars.length), d = new THREE.Object3D(), col = new THREE.Color();
  cars.forEach(([x, z], i) => { d.position.set(x, 0.05, z); d.rotation.set(0, Math.PI / 2 + (Math.random() - 0.5) * 0.06, 0); d.updateMatrix(); cm.setMatrixAt(i, d.matrix);
    cm.setColorAt(i, col.setHex([0xf2f2f0, 0xb8bcc2, 0x2b2f38, 0xa31f24, 0x2f4f8a, 0xd8d2c0][(Math.random() * 6) | 0])); });
  cm.userData.dynamic = true; cm.computeBoundingSphere(); air.add(cm);
  const flagMats = [navy, std(0x00a2e5, 0.8), white];
  [-1100, -1060, -1020].forEach((x, i) => { cyl(0.09, 0.12, 11, steel, x, 5.5, -9, g, 8, o);
    const f = panel(3, 2, new THREE.MeshStandardMaterial({ color: flagMats[i].color, side: THREE.DoubleSide, roughness: 0.8 }), x + 1.5, 9.8, -9, '+z', g, { cast: false, receive: false });
    f.userData.keep = true; f.onBeforeRender = () => { f.rotation.y = Math.sin(NOW / 600 + i) * 0.2; f.updateMatrixWorld(); }; });
  const palms = []; for (let z = 4; z <= 38; z += 8.5) palms.push([-1069, z], [-1051, z]);
  const pm = new THREE.InstancedMesh(TREE_CARD.geo, treeCardMaterial('palm'), palms.length);
  palms.forEach(([x, z], i) => { const h = 9 + Math.random() * 3; d.position.set(x, 0, z); d.rotation.set(0, 0, 0); d.scale.set(h / 0.94, h / 0.94, 1); d.updateMatrix(); pm.setMatrixAt(i, d.matrix); });
  pm.frustumCulled = false; pm.userData.dynamic = true; pm.userData.noCast = true; air.add(pm);
  box(9, 0.2, 2.6, navy, -985, 2.8, -6, g, o); for (const x of [-989, -981]) box(0.12, 2.8, 0.12, steel, x, 1.4, -5, g, o); box(7, 0.5, 0.5, steel, -985, 0.5, -6.6, g, o);
  // the flying club: a low clubhouse with a roof terrace over the GA apron
  const FX = -1490, FZ = -30;
  box(32, 4.2, 13, white, FX, 2.1, FZ, g, o);
  box(30, 2.4, 0.2, new THREE.MeshStandardMaterial({ color: 0x3d5566, roughness: 0.1, metalness: 0.5 }), FX, 2.2, FZ - 6.55, g, { cast: false, receive: true });
  box(32.4, 0.3, 13.4, concrete, FX, 4.35, FZ, g, o);
  for (const [w, dd, x, z] of [[32, 0.08, 0, -6.6], [0.08, 13, -16, 0], [0.08, 13, 16, 0]]) { box(w || 0.08, 0.06, dd, steel, FX + x, 5.5, FZ + z, g, o); }
  for (let x = -15; x <= 15; x += 2.5) box(0.06, 1.1, 0.06, steel, FX + x, 5, FZ - 6.6, g, o);
  box(16, 0.2, 7, navy, FX + 6, 7.4, FZ + 1, g, o); for (const [x, z] of [[-1.5, -2.2], [13.5, -2.2], [-1.5, 4.2], [13.5, 4.2]]) cyl(0.08, 0.08, 3, steel, FX + x, 5.9, FZ + z, g, 6, o);
  for (let i = 0; i < 5; i++) { box(1.1, 0.06, 1.1, white, FX - 10 + i * 3.2, 5.2, FZ - 3, g, o); cyl(0.04, 0.04, 0.7, steel, FX - 10 + i * 3.2, 4.85, FZ - 3, g, 6, o); }
  panel(16, 1.6, text('FLYING CLUB', 16, 1.6, '#111c44', '#ffffff'), FX, 3.5, FZ - 6.7, '-z', g, { cast: false, receive: false });
  // the bowser beside the line, and the trainer that taxis out (a placeholder until the Cessna arrives)
  const ft = fuelTruck(); ft.position.set(-1500, 0, -58); ft.rotation.y = Math.PI / 2; air.add(ft);
  const taxi = new THREE.Group(); taxi.userData.dynamic = true; taxi.userData.body = taxi.add(bakeGroup(trainer(navy))).children.at(-1);
  circuitLights(taxi, 2); air.add(taxi); AIRSIDE.taxiTrainers = [taxi];
  const tp = [[-1452, -70], [-1452, -100], [-1470, -114], [-1640, -114], [-1662, -118], [-1640, -122], [-1460, -122], [-1446, -104], [-1446, -78], [-1449, -64]];
  AIRSIDE.vehicles.push({ g: taxi, path: new THREE.CatmullRomCurve3(tp.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, 'centripetal'), speed: 5, phase: 0, t0: 13 });
  // two pilots walking out from the club to the line and back
  for (const [i, pts] of [[0, [[-1488, -40], [-1478, -56], [-1471, -66], [-1462, -66], [-1470, -55], [-1484, -42]]], [1, [[-1500, -40], [-1508, -55], [-1515, -64], [-1522, -55], [-1506, -42]]]]) {
    const p = person(0xf4f3ee); p.userData.dynamic = true; air.add(p);
    AIRSIDE.vehicles.push({ g: p, path: new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, 0, z)), true), speed: 1.3, phase: 0, t0: i * 17 });
  }
  // perimeter road inside the fence: west, north and east sides; a jeep on patrol; the guard post at the west gate
  for (const [x0, z0, x1, z1] of [[-1957, -38, -1951, -606], [-1957, -606, 1097, -600], [1091, -606, 1097, -38]]) {
    const w = Math.abs(x1 - x0), dd = Math.abs(z1 - z0); panel(w, dd, asphalt(w, dd), (x0 + x1) / 2, 0.04, (z0 + z1) / 2, 'up', g, { cast: false, receive: true });
  }
  const jeepGeo = vehicleGeo([[4, 1.0, 1.8, 0, 1.0, 0, 1], [1.9, 0.75, 1.7, -0.6, 1.85, 0, 0.9], [1.0, 0.18, 0.3, -0.6, 2.3, 0, 0.6]], { wheels: [[1.3, 0.85, 0.42], [1.3, -0.85, 0.42], [-1.3, 0.85, 0.42], [-1.3, -0.85, 0.42]] });
  const jeep = new THREE.Mesh(jeepGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, color: 0xe9e9e4 }));
  const jg = new THREE.Group(); jg.add(jeep); blinker(glowPoints([[-0.6, 2.35, 0]], 0xffa51a, 2.4, jg), 0.8, 0, 0.3); jg.userData.dynamic = true; air.add(jg);
  const pr = [[-1952, -40], [-1952, -603], [1094, -601], [1094, -40], [1096, -40], [1096, -605], [-1956, -605], [-1956, -40]];
  AIRSIDE.vehicles.push({ g: jg, path: new THREE.CatmullRomCurve3(pr.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, 'centripetal', 0.1), speed: 11, phase: 0, t0: 40 });
  box(3, 2.8, 3, white, -1966, 1.4, -24, g, o); box(3.4, 0.25, 3.4, navy, -1966, 2.95, -24, g, o);
  box(0.12, 0.12, 9, std(0xd0211c, 0.6), -1960, 1.1, -30, g, o);
  // weather station north of the runway: a fenced plot, the white louvred screen, rain gauge, a mast with spinning cups
  const WX = -300, WZ = -470;
  for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; box(0.08, 1.4, 0.08, steel, WX + Math.cos(a) * 7, 0.7, WZ + Math.sin(a) * 7, g, o); }
  box(1.1, 0.9, 0.8, white, WX - 2, 1.6, WZ, g, o); for (const s of [-0.45, 0.45]) box(0.08, 1.15, 0.08, white, WX - 2 + s, 0.58, WZ, g, o);
  cyl(0.18, 0.18, 0.6, steel, WX + 1, 0.6, WZ + 2, g, 10, o);
  cyl(0.06, 0.09, 10, steel, WX + 2, 5, WZ - 1.5, g, 8, o);
  const cups = new THREE.Group(); cups.position.set(WX + 2, 10.2, WZ - 1.5); for (let i = 0; i < 3; i++) { const a = i / 3 * Math.PI * 2; box(0.6, 0.04, 0.04, steel, Math.cos(a) * 0.3, 0, Math.sin(a) * 0.3, cups).rotation.y = -a; mesh(new THREE.SphereGeometry(0.1, 8, 6), steel, Math.cos(a) * 0.6, 0, Math.sin(a) * 0.6, cups); }
  cups.traverse((q) => { q.userData.keep = true; }); g.add(cups);
  cups.onBeforeRender = () => {}; cups.children[0].onBeforeRender = () => { cups.rotation.y = NOW / 1000 * 5; cups.updateMatrixWorld(); };
  const kb = bakeGroup(g); kb.userData.dynamic = true; air.add(kb);
}
/** the mandatory sign at a runway-holding position: red with white "10-28", on frangible legs, on the aircraft's
 *  left beside the hold line, facing it (x, z: the hold; rx, rz: toward the runway; w: the taxiway's width) */
const HOLD_SIGN_MATS = new Map();
function holdSign(parent, x, z, rx, rz, w, txt) {
  const K = kitMats(), o = { cast: true, receive: true };
  const mat = HOLD_SIGN_MATS.get(txt) ?? HOLD_SIGN_MATS.set(txt, new THREE.MeshStandardMaterial({ roughness: 0.6, emissive: 0xffffff, emissiveIntensity: 0.06,
    map: canvasTex(256, 96, (g, cw, ch) => { g.fillStyle = '#c8102e'; g.fillRect(0, 0, cw, ch); g.fillStyle = '#ffffff'; g.font = FONT(800, 60, 'Arial, sans-serif'); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, cw / 2, ch / 2 + 3); }) })).get(txt);
  const g = new THREE.Group(), W = 2.2, H = 0.8;
  panel(W, H, mat, 0, 0.95, 0.12, '+z', g, o); panel(W, H, mat, 0, 0.95, -0.12, '-z', g, o);
  box(W + 0.06, H + 0.06, 0.22, K.dark, 0, 0.95, 0, g, o);
  for (const s of [-1, 1]) box(0.08, 0.6, 0.08, K.grey, s * (W / 2 - 0.3), 0.3, 0, g, o);
  const off = w / 2 + 7;                                                                  // clear of the pavement and a wingtip
  g.position.set(x + rz * off, 0, z - rx * off); g.rotation.y = Math.atan2(-rx, -rz);
  g.userData.dynamic = true; parent.add(g);
}
/** Signs at each runway entry (a red mandatory "10-28" beside a black-and-yellow location sign, on the holding side
 *  of the hold line, on the aircraft's left) and windsocks by both thresholds, gently swinging. */
function airportSigns(air, route) {
  const K = kitMats(), o = { cast: true, receive: true };
  const face = (txt, bg, fg, border) => new THREE.MeshStandardMaterial({ roughness: 0.6, emissive: 0xffffff, emissiveIntensity: 0.08,
    map: canvasTex(256, 96, (g, w, h) => { g.fillStyle = bg; g.fillRect(0, 0, w, h); if (border) { g.strokeStyle = border; g.lineWidth = 8; g.strokeRect(10, 10, w - 20, h - 20); }
      g.fillStyle = fg; g.font = FONT(800, 62, 'Arial, sans-serif'); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, w / 2, h / 2 + 3); }) });
  const sign = (x, z, parts) => {
    const W = 1.6, H = 0.75, n = parts.length, g = new THREE.Group();
    parts.forEach(([txt, bg, fg, border], i) => {
      const m = face(txt, bg, fg, border), cx = (i - (n - 1) / 2) * W;
      panel(W, H, m, cx, 0.95, 0.12, '+z', g, o); panel(W, H, m, cx, 0.95, -0.12, '-z', g, o);
    });
    box(W * n + 0.06, H + 0.06, 0.22, K.dark, 0, 0.95, 0, g, o);
    for (const s of [-1, 1]) box(0.08, 0.6, 0.08, K.grey, s * (W * n / 2 - 0.3), 0.3, 0, g, o);
    g.position.set(x, 0, z); air.add(g);
  };
  void sign;
  // windsocks: a mast and a red-and-white sock streaming downwind (from the west-north-west)
  const sockTex = canvasTex(256, 32, (g, w, h) => { for (let i = 0; i < 5; i++) { g.fillStyle = i % 2 ? '#f4f4f0' : '#e2361f'; g.fillRect(i * w / 5, 0, w / 5, h); } });
  const sockMat = new THREE.MeshStandardMaterial({ map: sockTex, roughness: 0.8, side: THREE.DoubleSide });
  for (const [x, z] of [[RWY_THR - 280, RWY_Z + 70], [RWY_END + 300, RWY_Z - 70]]) {
    cyl(0.07, 0.1, 6, K.white, x, 3, z, air, 8, o);
    const sock = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.22, 3.6, 12, 1, true).rotateZ(-Math.PI / 2).translate(1.8, 0, 0), sockMat);
    sock.position.set(x, 5.8, z); sock.castShadow = true;
    const base = Math.atan2(0.35, 1) + (z > RWY_Z ? 0.1 : -0.05);
    sock.onBeforeRender = () => { const t = NOW / 1000; sock.rotation.set(0, base + Math.sin(t * 0.6 + x) * 0.15, -0.12 + Math.sin(t * 1.7 + z) * 0.05); sock.updateMatrixWorld(); };
    air.add(sock);
  }
}
/** Hangar and apron dressing, code-built and merged per hangar: maintenance docks (a yellow steel frame, a grated deck
 *  with guard rails and a stair), red tool carts, traffic cones and ground crew in hi-vis. */
const KIT = {};
function kitMats() {
  if (KIT.yel) return KIT;
  const std = (c, r = 0.7, m = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
  Object.assign(KIT, { yel: std(0xe3b21c, 0.6, 0.3), grey: std(0x5d6168, 0.6, 0.5), deck: std(0x3a3d42, 0.8, 0.4), red: std(0xb4241e, 0.5, 0.2),
    cone: std(0xf2561d, 0.6), white: std(0xeeeeee, 0.6), vest: std(0xc8f024, 0.7), vestO: std(0xff7a1a, 0.7), dark: std(0x2b3040, 0.85), skin: std(0x8a5a3c, 0.8), helmet: std(0xf4f4f0, 0.5) });
  return KIT;
}
function workStand(g, x, z, hgt, side) {
  const K = kitMats(), w = 2.6, d = 5.5, o = { cast: true, receive: true };
  box(w, 0.12, d, K.deck, x, hgt, z, g, o);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.12, hgt, 0.12, K.yel, x + sx * (w / 2 - 0.1), hgt / 2, z + sz * (d / 2 - 0.1), g, o);
  for (const sz of [-1, 1]) box(w, 0.08, 0.08, K.yel, x, hgt * 0.45, z + sz * (d / 2 - 0.1), g, o);              // cross-braces
  for (const yy of [0.55, 1.05]) { box(0.06, 0.06, d, K.yel, x + side * (w / 2 - 0.05), hgt + yy, z, g, o); box(w, 0.06, 0.06, K.yel, x, hgt + yy, z - d / 2 + 0.05, g, o); }
  for (let i = 0; i < 5; i++) box(0.06, 1.1, 0.06, K.yel, x + side * (w / 2 - 0.05), hgt + 0.55, z - d / 2 + i * d / 4, g, o);
  const n = Math.ceil(hgt / 0.25);                                                                                // a stair down the outer side
  for (let i = 0; i < n; i++) box(0.9, 0.06, 0.32, K.grey, x + side * (w / 2 + 0.5), hgt - (i + 1) * (hgt / n), z + d / 2 - 0.2 - i * 0.27, g, o);
  for (const sx of [0.05, 0.95]) box(0.06, 0.06, Math.hypot(hgt, n * 0.27), K.yel, x + side * (w / 2 + sx), hgt / 2, z + d / 2 - n * 0.135, g, o).rotation.x = -Math.atan2(hgt, n * 0.27);
  box(w * 0.98, 0.18, 0.18, K.grey, x, 0.12, z - d / 2 + 0.2, g, o); box(w * 0.98, 0.18, 0.18, K.grey, x, 0.12, z + d / 2 - 0.2, g, o); // castor beams
}
function toolCart(g, x, z, a) {
  const K = kitMats(), c = new THREE.Group(), o = { cast: true, receive: true };
  box(0.7, 0.9, 1.1, K.red, 0, 0.55, 0, c, o);
  for (let i = 0; i < 4; i++) box(0.01, 0.16, 0.9, K.grey, 0.355, 0.25 + i * 0.2, 0, c, o);                        // drawer fronts
  box(0.72, 0.04, 1.12, K.grey, 0, 1.02, 0, c, o);
  box(0.04, 0.04, 0.5, K.grey, 0, 1.25, -0.6, c, o);
  c.position.set(x, 0, z); c.rotation.y = a; g.add(c);
}
function cone(g, x, z) {
  const K = kitMats();
  cyl(0.03, 0.17, 0.62, K.cone, x, 0.33, z, g, 10, { cast: true, receive: true });
  cyl(0.085, 0.12, 0.12, K.white, x, 0.36, z, g, 10, { cast: false, receive: true });
  box(0.42, 0.04, 0.42, K.cone, x, 0.02, z, g, { cast: true, receive: true });
}
/** standing people, ~1.75 m: legs, hi-vis vest, arms, head and hard hat; [x, z, floor, facing] */
function crew(g, list) {
  list.forEach(([x, z, y0, a], i) => { const p = crewman(i % 2 === 0); p.position.set(x, y0, z); p.rotation.y = a; g.add(p); });
}
/** the hangar model, five times over: placed, its band repainted, the logo boards mounted */
async function dressHangars() {
  const gl = await gltfLoader.loadAsync('models/hangar_embraer.glb').catch((e) => { console.warn('hangar', e); return null; });
  if (!gl || !AIRSIDE.root) return;
  const base = gl.scene;
  base.updateMatrixWorld(true);
  for (const h of HANGARS) {
    const root = base.clone(true), s = h.s;
    const railings = [];
    root.traverse((o) => { if (o.isMesh && /Material_54/.test(o.material?.name ?? '')) railings.push(o); });
    railings.forEach((o) => o.removeFromParent()); // the model's yard railings: a clean front onto the apron
    root.traverse((o) => { if (!o.isMesh) return;
      o.castShadow = false; o.receiveShadow = true;
      o.material = o.material.clone();
      const m = o.material, img = m.map?.image;
      if (img && img.width >= 512) { // the band round the clerestory, in the airline's colour (the model's own lettering painted out)
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        g.fillStyle = h.band; g.fillRect(0, Math.round(c.height * 0.885), c.width, c.height);
        const t = new THREE.CanvasTexture(c); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = MAX_ANISO;
        m.map = t;
      }
      if ('roughness' in m) { m.roughness = Math.max(m.roughness ?? 1, 0.7); m.metalness = Math.min(m.metalness ?? 0, 0.25); }
    });
    // model: door at local x = -0.95 facing -x, 13 m wide; turned to face -z and scaled for airliners
    root.scale.setScalar(s);
    root.rotation.y = -Math.PI / 2;
    root.position.set(h.x, 0, h.zf + 0.95 * s);
    root.userData.dynamic = true;
    groundShadow(root, { rise: 4.9 * s * 0.9, opacity: 0.55, res: 128 });
    AIRSIDE.root.add(root);
    if (h.liner) h.liner.visible = true;
    // the logo over the door, on the clerestory's front, and again on its roof for the view from the air
    const boardY = 4.42 * s, boardH = 0.84 * s, front = h.zf - 0.53 * s - 0.08, roofY = 4.92 * s + 0.08, roofZ = h.zf + 6.45 * s;
    loadImage(`brand/hangars/${h.logo}.png`).then((img) => {
      const t = new THREE.Texture(img); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = MAX_ANISO; t.needsUpdate = true;
      const aspect = img.naturalWidth / img.naturalHeight, w = Math.min(boardH * aspect, 10 * s);
      const front2 = new THREE.MeshStandardMaterial({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.25, roughness: 0.7 });
      panel(w, w / aspect, front2, h.x, boardY, front, '-z', AIRSIDE.root, { cast: false, receive: false });
      const rw = Math.min(9.5 * s, 2.6 * s * aspect);
      panel(rw, rw / aspect, new THREE.MeshStandardMaterial({ map: t, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2 }), h.x, roofY, roofZ, 'up', AIRSIDE.root, { cast: false, receive: false });
    }).catch(() => {});
  }
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

/** One runway, real rules: departures hold short until the runway and the approach are clear; taxiing traffic
 *  keeps its distance in the queue; a new arrival only starts its approach when the one ahead will have vacated and
 *  any departure already rolling will be airborne (until then it waits off-stage, out in the haze). */
function stepTraffic(t) {
  const r = AIRSIDE.route, ms = AIRSIDE.movers;
  if (!r?.marks || !ms.length) return;
  const { tTD, tExit, tHS, tRoll, tAir } = r.marks, T = r.T, D = tAir - tHS, sepArr = tExit - tTD + 6;
  if (AIRSIDE.trafficT == null) { // settle the traffic before anyone sees it: ten minutes of rules from the even spread
    for (const m of ms) m.u = ((m.offset % T) + T) % T;
    AIRSIDE.trafficT = t - 600; for (let k = 0; k < 1200; k++) stepTraffic(t - 600 + (k + 1) * 0.5);
  }
  const dt = Math.min(1, Math.max(0, t - AIRSIDE.trafficT));
  AIRSIDE.trafficT = t;
  const rolling = (o) => o.u > tHS && o.u <= tAir + 2;                  // lining up, holding in position or on the take-off roll
  const onFinalOrRunway = (o) => o.u >= tTD - 20 && o.u <= tExit;         // short final, touchdown, roll-out
  for (const m of ms) {
    let next = m.u + dt;
    m.waiting = false;
    // the hold-short line: line up only with no other departure on the runway, no arrival on short final or just
    // touching down at this end, and the next arrival far enough out for the whole departure
    if (m.u <= tHS && next > tHS) {
      const rollWait = Math.max(0, ...ms.map((o) => (o !== m && o.u > tTD + 12 && o.u <= tExit ? tExit - o.u : 0))); // the arrival still rolling out
      const clear = ms.every((o) => o === m || (!rolling(o) && !(o.u >= tTD - 20 && o.u <= tTD + 12) && (((tTD - 20 - o.u) % T + T) % T) > D + rollWait + 5));
      if (!clear || trainerSoon(t, t + D + rollWait + 5)) next = tHS;
    }
    // line up and wait: the roll starts only once the arrival ahead has vacated the runway
    if (m.u <= tRoll && next > tRoll && (ms.some((o) => o !== m && onFinalOrRunway(o)) || trainerSoon(t, t + 25))) next = tRoll;
    // the taxi queue: stop ten seconds behind the aircraft ahead
    if (m.u >= tExit && m.u <= tHS && ms.some((o) => o !== m && o.u > m.u && o.u - m.u < 10 && o.u <= tHS + 0.5)) next = m.u;
    // the start of the approach: spaced behind the last arrival, and not into a departure that would still be rolling
    if (next >= T) {
      const blocked = ms.some((o) => o !== m && ((o.u >= 0 && o.u < sepArr && !o.waiting) || (rolling(o) && tAir - o.u > tTD - 8))) || trainerSoon(t + tTD - 20, t + tExit + 5);
      if (blocked) { next = T - 1e-3; m.waiting = true; }
    }
    m.u = next >= T ? next - T : next;
  }
}
function updateAirside(now) {
  const on = camera.position.z < -13.5 || camera.position.y > 22; // and from the air, where the whole airport is in view
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
  stepTraffic(t);
  stepCircuits(t, Math.min(0.5, Math.max(0, t - (AIRSIDE.circT ?? t)))); AIRSIDE.circT = t;
  for (const m of AIRSIDE.movers) {
    const s = sampleRoute(AIRSIDE.route, m.u, m.s);
    m.g.visible = AIRSIDE.active && !m.waiting; m.shadow.visible = m.g.visible && !m.real; // a real model brings its own ground shadow
    m.g.position.set(s.x, s.y + m.lift, s.z);
    if (m.fans?.length && m.g.visible) spinFans(m.fans, t, s.y > 1 ? 20 : 12);
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
      v.g.rotation.y = Math.atan2(-d.z, d.x) + (v.g.userData.faceZ ? Math.PI / 2 : 0);
      if (v.g.userData.limbs) walkPose(v.g, (t + (v.t0 || 0)) * v.speed * 4.4);
    } else {
      v.train.forEach((part, i) => {
        const a = -(t * v.speed) / v.rx - i * (3.4 / v.rx);
        part.position.set(v.cx + Math.cos(a) * v.rx, 0, v.cz + Math.sin(a) * v.rz);
        part.rotation.y = Math.atan2(-(-Math.cos(a) * v.rz), Math.sin(a) * v.rx);
      });
    }
  }
  for (const b of AIRSIDE.blinkers) b.mesh.visible = ((t / b.period + b.phase) % 1) < b.duty;
  // sequenced flashers: one strobe after another along the centreline, running in to the threshold twice a second
  const k = (t * 2) % 1;
  for (const r of AIRSIDE.rabbits ?? []) {
    const d = Math.round((900 - k * 870) / 30) * 30;
    r.pts.geometry.attributes.position.setXYZ(0, r.tx + r.dir * d, 2.1, RWY_Z);
    r.pts.geometry.attributes.position.needsUpdate = true;
  }
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
  const STEPS = { furniture: [12, 'Furnishing the lobby'], exterior: [18, 'Building the campus'], lobby: [24, 'Building the campus'], airside: [40, 'Laying out the runway'], built: [62, 'Planting the countryside'],
    merged: [70, 'Lighting the lobby'], sky: [74, 'Painting the sky'], grass: [80, 'Growing the grass'], fx: [84, 'Warming up the engines'], shaders: [94, 'Almost ready'], 'first-frame': [100, 'Cleared for take-off'] };
  const mark = (k) => { window.__marks.push([k, Math.round(performance.now() - t0)]);
    const s = STEPS[k], bar = document.getElementById('loaderBar'), txt = document.getElementById('loaderText'), ld = document.getElementById('loader');
    if (s && bar) { bar.style.width = s[0] + '%'; txt.textContent = s[1] + (s[0] < 100 ? '…' : ''); }
    if (k === 'first-frame' && ld) { ld.style.opacity = '0'; setTimeout(() => ld.remove(), 700); } };
  if (LITE) { pixelRatio = 1; renderer.setPixelRatio(1); QUALITY.ao = false; QUALITY.shadows = false; }
  await loadFurniture();
  await fetchAerocity(); // OSM city and airport: the airside and the route are built from it
  mark('furniture');
  const skyMesh = buildSky();
  // Sunset: lavender sky fill, low amber sun raking across the facade from the west
  hemi = new THREE.HemisphereLight(0xcfe0f5, 0x7a6e5c, 0.6); // blue sky above, sunlit earth below
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3e3, 1.4); // a clear afternoon sun
  sun.target.position.set(0, 0, 4);
  sun.position.copy(SUN_VEC).multiplyScalar(48).add(sun.target.position); // where the photographed sun sets
  scene.add(sun.target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 14, bottom: -14, near: 10, far: 90 });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 5; // soft-edged shadows, as hazy evening light gives
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
  if (!LITE) loadVegetation();
  loadIGI(); dressHangars();
  loadDeskEngine();
  uDoor = computeDoorU();

  // Glass and logo planes should not throw shadows into the lobby
  scene.traverse((o) => {
    if (o.isMesh && (o.material === M.glass || o.material?.transparent)) o.castShadow = false;
  });

  buildStreetStatic();
  buildAcademyParking();
  buildConnaught();
  buildAerocity();
  mark('built');
  if (BAKE_MODE !== 'lobby') { await loadBakedLobby(); mergeStatic(); } // (the bake export needs the interior as it was built)
  mark('merged');
  loadSkyAndLight(skyMesh); mark('sky');
  dressScene(); mark('dressed');
  if (!LITE) buildGrass(skyMesh); mark('grass');
  renderer.shadowMap.autoUpdate = false; // nothing that casts shadows moves, so bake them once
  renderer.shadowMap.needsUpdate = true;

  setupFX(); mark('fx');
  window.__cc = { frame, FILM, get FX() { return FX; }, QUALITY, renderer, scene, camera, AIRSIDE, look: (x, y, z) => roomCam.look.set(x, y, z), view: (p, l) => { mode = "moving"; roomCam.pos.set(...p); roomCam.look.set(...l); }, setP: (v) => { targetP = p = v; }, stepTraffic, exportLobbyForBake }; // debug handle
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
/** The lobby's static interior: every mesh wholly inside the interior volume that isn't glass, additive, custom-shaded,
 *  instanced, animated or airside. ?bake=lobby exports exactly these for Blender (tools/bake_lobby.py); in normal
 *  runs the same set is swapped for the baked result (loadBakedLobby). */
const BAKE_MODE = new URLSearchParams(location.search).get('bake');
function lobbyStaticMeshes() {
  scene.updateMatrixWorld(true);
  const out = [], b = new THREE.Box3();
  scene.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh) return;
    for (let a = o; a; a = a.parent) if (a.userData.dynamic || a === AIRSIDE.root) return;
    if (Array.isArray(o.material)) return;
    const mt = o.material; if (mt.transparent || mt.opacity < 1 || mt.isShaderMaterial || mt.blending === THREE.AdditiveBlending) return;
    b.setFromObject(o);
    if (b.isEmpty() || b.min.x < -9.5 || b.max.x > 9.5 || b.min.y < -0.2 || b.max.y > 4.3 || b.min.z < -27 || b.max.z > 0.6) return;
    out.push(o);
  });
  return out;
}
/** a material's fingerprint: what it looks like (type, colours, texture identity and tiling), so a baked part made
 *  of everything that shared it finds its way back to it whatever order things loaded in */
function matSig(m) {
  const img = (t) => {
    const im = t?.image; if (!im) return '';
    if (im.src) return im.src.split('/').pop().split('?')[0];
    if (im.getContext) { const d = im.getContext('2d').getImageData(0, 0, im.width, im.height).data; let h = 0; for (let i = 0; i < d.length; i += 613) h = (h * 31 + d[i]) | 0; return `c${im.width}x${im.height}:${h}`; }
    return `i${im.width}x${im.height}`;
  };
  const tr = (t) => (t ? `${t.repeat.x.toFixed(3)},${t.repeat.y.toFixed(3)},${t.offset.x.toFixed(3)},${t.offset.y.toFixed(3)},${t.rotation.toFixed(3)}` : '');
  const k = [m.type, m.name, m.color?.getHexString(), m.emissive?.getHexString(), m.emissiveIntensity, img(m.map), tr(m.map), img(m.emissiveMap), m.side].join('|');
  let h = 2166136261; for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 16777619);
  return 'm' + (h >>> 0).toString(36);
}
async function exportLobbyForBake(to = 'http://127.0.0.1:5199/lobby_src') {
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const g = new THREE.Group(), groups = new Map();
  for (const o of lobbyStaticMeshes()) {
    const geo = o.geometry.clone(); geo.applyMatrix4(o.matrixWorld);
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    if (!geo.attributes.normal) geo.computeVertexNormals();
    floatGeometry(geo);
    const key = matSig(o.material);
    (groups.get(key) ?? groups.set(key, { mat: o.material, geos: [] }).get(key)).geos.push(geo.index ? geo.toNonIndexed() : geo);
  }
  for (const [key, { mat, geos }] of groups) { const m = new THREE.Mesh(mergeGeometries(geos), mat); m.name = key; g.add(m); }
  const glb = await new GLTFExporter().parseAsync(g, { binary: true });
  await fetch(to, { method: 'POST', body: new Blob([glb]) });
  // and the lights that shape the interior, for Blender to use: type, position, colour, intensity (candela), range
  const lights = [];
  scene.traverse((l) => {
    if (!(l.isPointLight || l.isSpotLight)) return;
    const p = l.getWorldPosition(new THREE.Vector3()), t = l.target ? l.target.getWorldPosition(new THREE.Vector3()) : null;
    lights.push({ type: l.isSpotLight ? 'spot' : 'point', p: p.toArray(), t: t?.toArray(), color: l.color.toArray(), intensity: l.intensity, distance: l.distance, angle: l.angle, penumbra: l.penumbra });
  });
  const panels = [];
  scene.traverse((o) => { if (o.isMesh && o.material === M.lightPanel) panels.push(o.getWorldPosition(new THREE.Vector3()).toArray()); });
  await fetch(to + '_lights', { method: 'POST', body: JSON.stringify({ lights, panels, sun: SUN_VEC.toArray(), skyRot: SKY_ROT }) });
  return g.children.length;
}
/** The baked lobby (tools/bake_lobby.py): the static interior, path-traced in Blender, arrives as geometry with a
 *  second UV set and one lightmap. Each part is matched to its live material by fingerprint (matSig) and drawn unlit
 *  with the lightmap; the live interior meshes and every interior point/spot light go, so no shader in the scene has
 *  to carry them (the biggest single cost at startup on integrated GPUs). Missing files: the live lobby stays. */
const LOBBY_LM_MAX = 4; // the lightmap stores irradiance / LOBBY_LM_MAX, sRGB-encoded
async function loadBakedLobby() {
  let gl, lm;
  try {
    [gl, lm] = await Promise.all([gltfLoader.loadAsync('models/lobby_baked.glb?v=2'), new THREE.TextureLoader().loadAsync('tex/lobby_lightmap.webp?v=3')]);
  } catch (e) { console.warn('baked lobby: keeping the live interior', e); return false; }
  lm.colorSpace = THREE.SRGBColorSpace; lm.channel = 1; lm.flipY = false; lm.anisotropy = MAX_ANISO;
  const live = lobbyStaticMeshes(), byKey = new Map();
  for (const o of live) if (!byKey.has(matSig(o.material))) byKey.set(matSig(o.material), o.material);
  const made = new Map(), group = new THREE.Group();
  group.name = 'lobby-baked'; group.userData.dynamic = true; // keep its second UV set: no static merge
  gl.scene.updateMatrixWorld(true);
  let parts = 0; const matched = new Set();
  gl.scene.traverse((n) => {
    if (!n.isMesh) return;
    let key = null; for (let q = n; q && !key; q = q.parent) if (byKey.has(q.name)) key = q.name;
    if (!key) return;
    const src = byKey.get(key); matched.add(key);
    const glows = src.emissive && src.emissiveIntensity > 0 && src.emissive.getHex() !== 0;
    const mat = made.get(key) ?? made.set(key, glows ? src : new THREE.MeshBasicMaterial({
      map: src.map ?? null, color: src.color ? src.color.clone() : new THREE.Color(1, 1, 1), side: src.side, alphaTest: src.alphaTest || 0,
      lightMap: lm, lightMapIntensity: LOBBY_LM_MAX * 0.88, // a touch under the bake: the pale floor tiles otherwise read blown out
    })).get(key);
    const mesh = new THREE.Mesh(n.geometry, mat);
    n.matrixWorld.decompose(mesh.position, mesh.quaternion, mesh.scale);
    mesh.receiveShadow = false; mesh.castShadow = false;
    group.add(mesh); parts++;
  });
  if (!parts) { console.warn('baked lobby: no parts matched; keeping the live interior'); return false; }
  for (const o of live) if (matched.has(matSig(o.material))) o.removeFromParent(); // anything without a baked part stays live
  const lights = []; scene.traverse((l) => { if (l.isPointLight || l.isSpotLight) lights.push(l); });
  for (const l of lights) { l.removeFromParent(); l.target?.removeFromParent(); }
  scene.add(group);
  console.info('baked lobby:', parts, 'parts;', [...byKey.keys()].filter((k) => !matched.has(k)).length, 'materials stay live;', lights.length, 'lights retired');
  return true;
}
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
const PLANT_IMS = [];
function plantInstances(piece, pts, parent, rng, [s0, s1] = [0.8, 1.3], sink = 0) {
  if (!piece || !pts.length) return null;
  const im = new THREE.InstancedMesh(piece.geo, piece.mat, pts.length);
  PLANT_IMS.push(im);
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
  let tuft = pick(G, 'rostlinka_07c', (v) => v.size.x < 1); const patch = pick(G, 'rostlinka_07c', (v) => v.size.x >= 1), weeds = pick(G, 'rostlinka12_2k');

  // landside: the campus lawn around the building, off the plaza, path, road and building
  const land = (x, z) => !((Math.abs(x) < 15.8 && z > -0.6 && z < 12.6) || (Math.abs(x) < 2.8 && z < 32.6) || (z > 31.4 && z < 41.6)
    || (Math.abs(x) < 15.5 && z > -24 && z < 1) || (z < -23.2)
    || (z > 29.3 && z < 44.2) || (Math.abs(x) < 17.6 && z > 29 && z < 59.8)); // pavements and the apron across the road
  const front = [-27.5, 27.5, -23, 29.2]; // the campus court between the wings
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
  const green = (pc) => pc && { ...pc, mat: Object.assign(pc.mat.clone(), { color: new THREE.Color(0x8fcf52) }) }; // monsoon-green, not dry
  tuft = green(tuft); const patchG = green(patch), weedsG = green(weeds);
  plantInstances(tuft, [...clusterPoints(3200, [-650, 650, -292, -149], infield, rng, { spread: 6, per: 20 }),
    ...clusterPoints(600, [-900, 700, -390, -355], far, rng, { spread: 6, per: 16 }),
    ...clusterPoints(300, [-260, 260, -122.5, -116.5], () => true, rng, { spread: 3, per: 8 })], air, rng, [0.9, 1.8]);
  plantInstances(patchG, clusterPoints(70, [-600, 600, -288, -152], infield, rng, { spread: 30, per: 4 }), air, rng, [0.9, 1.6], 0.05);
  plantInstances(weedsG, clusterPoints(40, [-500, 500, -288, -152], infield, rng, { spread: 25, per: 3 }), air, rng, [1, 1.5], 0.05);

  // maples: in place of the code-built trees, along the road and around the campus
  if (maple) {
    maple.updateMatrixWorld(true);
    const all = new THREE.Box3().setFromObject(maple), c = all.getCenter(new THREE.Vector3());
    const base = 9 / (all.max.y - all.min.y); // the tree arrives in centimetres: about 9 m tall here
    const spots = [...CODE_TREES.map((t) => [t.position.x, t.position.z]),
      [-22, 25], [22, 25], [-23, -8], [23, -12]];
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
async function loadIGI() {
  if (!AERO.data?.models) return; // (the training field has no VIDP buildings)
  const load = (f) => gltfLoader.loadAsync(`models/${f}.glb?v=3`).then((g) => g.scene).catch((e) => { console.warn('igi', f, e); return null; });
  await Promise.all(['vidp_t1', 'vidp_t3ent', 'vidp_hvac', 'vidp_t2', 'vidp_atc', 'vidp_atcgp1', 'vidp_atcgp2'].map(async (f) => {
    const r = await load(f); if (!r) return;
    r.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = o.receiveShadow = false;
      for (const m of [].concat(o.material)) if ('roughness' in m) { m.roughness = Math.max(m.roughness ?? 1, 0.6); m.metalness = Math.min(m.metalness ?? 0, 0.3); if (m.emissiveMap) m.emissiveIntensity = 0.7; }
    });
    r.userData.dynamic = true;
    if (placeVidp(r, f)) AIRSIDE.root.add(r);
  }));
}


/* ---------- The surroundings, after Connaught Place, New Delhi ---------- */
// White two-storey Georgian blocks: a ground-floor colonnade of round Tuscan columns on a low plinth, a shaded
// verandah with shopfronts behind, a railed upper gallery on slimmer columns, deep cornices and a parapet. Built in
// code and merged with the static scene. Shop names are invented.
let CPM = null;
const CP_GLOW = [];
function cpMats() {
  if (CPM) return CPM;
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const white = std({ color: 0xf0ebdf, roughness: 0.9 }), trim = std({ color: 0xe3dccb, roughness: 0.9 }), stone = std({ color: 0xb4aea1, roughness: 0.95 });
  for (const m of [white, trim]) dress(m, 'painted_plaster_wall', { repeat: [2, 2], diff: false, normal: 0.45, rough: 1 });
  const floor = std({ roughness: 0.6, map: canvasTex(256, 256, (g, w, h) => { // chequered verandah tiles
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { g.fillStyle = (i + j) & 1 ? '#cfc8b8' : '#8f8a80'; g.fillRect(i * 64, j * 64, 64, 64); }
  }) });
  floor.map.wrapS = floor.map.wrapT = THREE.RepeatWrapping;
  const rail = std({ roughness: 0.9, map: canvasTex(256, 128, (g, w, h) => { // balustrade: turned balusters between rails
    g.fillStyle = '#ece6d8'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#5f5a50';
    for (let x = 6; x < w; x += 22) { g.beginPath(); g.ellipse(x + 11, h / 2, 5, h * 0.32, 0, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#ece6d8'; g.fillRect(0, 0, w, 16); g.fillRect(0, h - 18, w, 18);
  }) });
  rail.map.wrapS = THREE.RepeatWrapping;
  const names = [['SHARMA SWEETS', '#7a1f1f', '#f3e3b0'], ['KHADI BHANDAR', '#1f4a3a', '#f1ead6'], ['THE BOOK DEPOT', '#1c2f55', '#f2efe6'], ['CHAI & CO.', '#3a2a1c', '#e9c98a'],
    ['RAJ TAILORS', '#4a1c3a', '#f0e6ee'], ['CITY OPTICALS', '#12404a', '#e6f2f2'], ['SILK EMPORIUM', '#6a4a12', '#f6ecd0'], ['STATIONERS', '#2a2a2a', '#eeeeee']];
  const rnd = mulberry32(88);
  const shops = names.map(([name, bg, fg]) => {
    const tex = canvasTex(512, 512, (g, w, h) => {
      g.fillStyle = '#e9e3d5'; g.fillRect(0, 0, w, h);            // plaster surround
      g.fillStyle = bg; g.fillRect(26, 30, w - 52, 92);            // sign board
      g.strokeStyle = fg; g.lineWidth = 3; g.strokeRect(34, 38, w - 68, 76);
      g.fillStyle = fg; g.font = FONT(700, 44, 'Fraunces, Georgia, serif'); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(name, w / 2, 78);
      const lit = g.createLinearGradient(0, 150, 0, h);             // shop window, lit from inside
      lit.addColorStop(0, '#f6d49a'); lit.addColorStop(1, '#b98a4e');
      g.fillStyle = lit; g.fillRect(40, 150, w - 80, h - 150);
      for (let i = 0; i < 26; i++) { g.fillStyle = `hsla(${(rnd() * 360) | 0},45%,${30 + rnd() * 30}%,0.85)`; g.fillRect(52 + rnd() * (w - 150), 190 + ((rnd() * 4) | 0) * 70, 22 + rnd() * 40, 48); } // goods on shelves
      g.fillStyle = 'rgba(60,40,20,0.9)';
      for (let y = 240; y < h; y += 70) g.fillRect(40, y, w - 80, 6);
      g.fillStyle = '#3b2a1c'; g.fillRect(40, 146, w - 80, 8); g.fillRect(w / 2 - 4, 150, 8, h); g.fillRect(36, 150, 8, h); g.fillRect(w - 44, 150, 8, h); // teak frame
    });
    return std({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.5, roughness: 0.6 });
  });
  const wins = [0, 1].map((k) => {
    const tex = canvasTex(256, 320, (g, w, h) => {
      g.fillStyle = '#ece6d8'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#d9d2c2'; g.fillRect(52, 26, w - 104, h - 52);                       // moulded surround
      g.fillStyle = k ? '#f1cf96' : '#27313c'; g.fillRect(64, 38, w - 128, h - 76);        // lit, or dark with the evening in it
      g.fillStyle = '#4a3523'; g.fillRect(w / 2 - 3, 38, 6, h - 76); g.fillRect(64, h * 0.42, w - 128, 5); g.fillRect(64, 38, w - 128, 5);
      if (!k) { g.fillStyle = '#3f5a48'; g.fillRect(64, 38, 30, h - 76); g.fillRect(w - 94, 38, 30, h - 76); } // green shutters folded back
    });
    return std({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: k ? 0.45 : 0.04, roughness: 0.8 });
  });
  const back = canvasTex(128, 192, (g, w, h) => { g.fillStyle = '#ece6d8'; g.fillRect(0, 0, w, h); g.fillStyle = '#d6cfbf'; g.fillRect(30, 40, 68, 112); g.fillStyle = '#2b333d'; g.fillRect(38, 48, 52, 96); g.fillStyle = '#3f5a48'; g.fillRect(38, 48, 12, 96); g.fillRect(78, 48, 12, 96); g.fillStyle = '#c9c1b0'; g.fillRect(0, h - 6, w, 6); });
  back.wrapS = back.wrapT = THREE.RepeatWrapping;
  CPM = { back: std({ map: back, roughness: 0.9 }), roof: std({ color: 0xb4ada1, roughness: 0.95 }), tank: std({ color: 0x1e1f22, roughness: 0.6 }), white, trim, stone, floor, rail, shops, wins, ceil: std({ color: 0xd9d3c5, roughness: 1 }), iron: std({ color: 0x1b1d20, roughness: 0.6, metalness: 0.4 }) };
  return CPM;
}
/** one block: L metres of colonnade along local +x, its front on local z = 0 facing +z, the building behind */
function cpBlock(x, z, yaw, L, depth = 14) {
  const C = cpMats(), g = new THREE.Group();
  g.position.set(x, 0, z); g.rotation.y = yaw;
  scene.add(g);
  const n = Math.max(2, Math.round(L / 3.4)), bw = L / n, V = 3.3; // bays, bay width, verandah depth
  const y0 = 0.3, yE = 4.5, yF = 5.45, yT = 8.6, yR = 9.45;
  // plinth and verandah floor, the building, floors and roof over the galleries
  box(L + 0.5, y0, V + 0.6, C.stone, L / 2, y0 / 2, -V / 2 + 0.1, g);
  const fl = panel(L, V, C.floor.clone(), L / 2, y0 + 0.006, -V / 2, 'up', g); fl.material.map = repeatOf(C.floor.map, L / 2.4, V / 2.4);
  box(L, yR - y0, depth - V, C.white, L / 2, (yR + y0) / 2, -(depth + V) / 2, g);
  const bw2 = panel(L, yR - y0 - 0.2, C.back.clone(), L / 2, (yR + y0) / 2, -depth - 0.03, '-z', g); bw2.material.map = repeatOf(C.back.map, L / 3.4, 2); // windows on the back
  box(L, 0.25, V, C.ceil, L / 2, yF - 0.3, -V / 2, g);
  box(L, 0.22, V + 0.2, C.ceil, L / 2, yR - 0.2, -V / 2, g);
  box(L - 0.2, 0.06, depth - 0.2, C.roof, L / 2, yR + 0.03, -depth / 2, g); // a grey concrete roof, as seen from the air
  for (let x = 6; x < L - 4; x += 9 + (x * 7 % 5)) cyl(0.75, 0.75, 1.4, C.tank, x, yR + 0.75, -depth + 2.4 + (x * 13 % 4), g, 10); // water tanks
  // entablatures and cornices, lower and upper
  for (const [yb, h, proj] of [[yE, 0.8, 0.42], [yT, 0.72, 0.5]]) {
    box(L + 0.3, h, 0.7, C.white, L / 2, yb + h / 2, -0.12, g);
    box(L + 0.3 + proj * 2, 0.15, 0.7 + proj * 2, C.trim, L / 2, yb + h + 0.075, -0.12, g);
    box(L + 0.3, 0.1, 0.78, C.trim, L / 2, yb + 0.05, -0.12, g);
  }
  // parapet with balustrade panels
  const par = box(L + 0.3, 0.85, 0.22, C.rail.clone(), L / 2, yR + 0.55, -0.3, g); par.material.map = repeatOf(C.rail.map, L / 2.6, 1);
  box(L + 0.4, 0.1, 0.34, C.trim, L / 2, yR + 1.02, -0.3, g);
  for (let i = 0; i <= n; i++) {
    const cx = i * bw, end = i === 0 || i === n;
    // ground-floor column: square piers at the ends, round Tuscan columns between
    if (end) box(0.8, yE - y0, 0.8, C.white, cx, (yE + y0) / 2, 0, g);
    else {
      box(0.78, 0.16, 0.78, C.trim, cx, y0 + 0.08, 0, g);
      cyl(0.27, 0.31, yE - y0 - 0.5, C.white, cx, y0 + 0.16 + (yE - y0 - 0.5) / 2, 0, g, 16);
      cyl(0.36, 0.28, 0.14, C.trim, cx, yE - 0.27, 0, g, 16);
      box(0.76, 0.14, 0.76, C.trim, cx, yE - 0.1, 0, g);
    }
    // upper gallery column
    if (end) box(0.6, yT - yF, 0.6, C.white, cx, (yT + yF) / 2, 0, g);
    else {
      box(0.52, 0.12, 0.52, C.trim, cx, yF + 0.06, 0, g);
      cyl(0.19, 0.22, yT - yF - 0.36, C.white, cx, yF + 0.12 + (yT - yF - 0.36) / 2, 0, g, 14);
      box(0.52, 0.12, 0.52, C.trim, cx, yT - 0.06, 0, g);
    }
    if (i === n) break;
    const mx = cx + bw / 2;
    // upper railing, shopfront and upper window for this bay, a pilaster between bays
    box(bw - 0.5, 0.82, 0.1, C.rail, mx, yF + 0.41, 0, g); // one shared material: every bay merges into one mesh
    box(bw - 0.4, 0.08, 0.2, C.trim, mx, yF + 0.86, 0, g);
    panel(bw - 0.36, yE - y0 - 0.3, C.shops[(i * 5 + Math.round(Math.abs(x + z))) % C.shops.length], mx, y0 + (yE - y0 - 0.3) / 2, -V + 0.02, '+z', g);
    panel(bw - 0.36, yT - yF - 0.2, C.wins[(i * 7 + Math.round(Math.abs(x))) % 3 === 0 ? 1 : 0], mx, yF + (yT - yF - 0.2) / 2, -V + 0.02, '+z', g);
    box(0.36, yR - y0, 0.14, C.trim, cx, (yR + y0) / 2, -V + 0.05, g);
    // a lantern in every other bay
    if (i % 2 === 0) {
      box(0.03, 0.5, 0.03, C.iron, mx, yF - 0.7, -V / 2, g);
      box(0.3, 0.36, 0.3, M.lightWarm, mx, yF - 1.1, -V / 2, g, { cast: false, receive: false });
      g.updateMatrixWorld(true);
      CP_GLOW.push(new THREE.Vector3(mx, yF - 1.1, -V / 2).applyMatrix4(g.matrixWorld).toArray());
    }
  }
  return g;
}
/** a cast-iron street lamp with two globes */
function cpLamp(x, z, alongX = true) {
  const C = cpMats();
  cyl(0.07, 0.11, 4.4, C.iron, x, 2.2, z, scene, 10);
  cyl(0.16, 0.2, 0.5, C.iron, x, 0.25, z, scene, 10);
  const arm = box(alongX ? 1.5 : 0.06, 0.06, alongX ? 0.06 : 1.5, C.iron, x, 4.3, z);
  void arm;
  for (const s of [-0.7, 0.7]) {
    const gx = x + (alongX ? s : 0), gz = z + (alongX ? 0 : s);
    mesh(new THREE.SphereGeometry(0.2, 12, 10), M.lightWarm, gx, 4.05, gz, scene, { cast: false, receive: false });
    CP_GLOW.push([gx, 4.05, gz]);
  }
}
function buildConnaught() {
  const D = 14, kerbN = ROAD.z - ROAD.half - 2.4 - 0.2, kerbF = ROAD.z + ROAD.half + 2.4 + 0.2; // building lines behind the pavements
  // two wings frame the campus court, facing each other across the lawn
  cpBlock(-31, kerbN, Math.PI / 2, kerbN + 21.6, D);
  cpBlock(31, -21.6, -Math.PI / 2, kerbN + 21.6, D);
  // the street: continuous colonnades both sides, open at the campus and at the apron across the road
  if (FIELD === 'delhi') { // (out in the country the street is open: no city front)
    cpBlock(-130, kerbN, 0, 85, D);
    cpBlock(45, kerbN, 0, 85, D);
    cpBlock(130, kerbF, Math.PI, 112.4, D);
    cpBlock(-17.6, kerbF, Math.PI, 112.4, D);
  }
  // (no block behind the apron: the aerial approach drops in through this gap in the street front)
  // a paved walk along each wing
  for (const sx of [-1, 1]) {
    const pv = M.paving.clone(); pv.map = repeatOf(M.paving.map, 3 / 2.4, (kerbN + 21.6) / 2.4); PAVED.push(pv);
    panel(3, kerbN + 21.6, pv, sx * 29.3, 0.011, (kerbN - 21.6) / 2, 'up');
  }
  // lamps along both pavements and down the wings
  for (let x = -122; x <= 122; x += 17) { if (Math.abs(x) > 6) cpLamp(x, ROAD.z - ROAD.half - 0.7); cpLamp(x + 8.5, ROAD.z + ROAD.half + 0.7); }
  for (const sx of [-1, 1]) for (let z = -16; z <= 24; z += 13) cpLamp(sx * 27.4, z, false);
  buildAvenue();
  glowPoints(CP_GLOW, 0xffd9a6, 1.2, scene);
  for (const [x, y, z] of CP_GLOW) lightPool(x, z, y > 4.2 ? 6 : 11, y > 4.2 ? 6 : 11, scene, y > 4.2 ? 0.35 : 0.22, y > 4.2 ? 0.32 : 0.02);
}

/** The avenue: from the city straight to the campus gate, down the gap in the street front, colonnades either side */
function buildAvenue() {
  const z0 = 59.4, z1 = 430, mid = (z0 + z1) / 2, L = z1 - z0; // from the paved apron across the road, south to the city
  const road = panel(8, L, M.asphalt.clone(), 0, 0.006, mid, 'up'); road.material.map = repeatOf(M.asphalt.map, 2, L / 8); ASPHALT.push(road.material);
  const dash = new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.8 });
  for (let z = z0 + 6; z < z1 - 3; z += 9) panel(0.15, 3, dash, 0, 0.012, z, 'up', scene, { cast: false, receive: true });
  const kerb = new THREE.MeshStandardMaterial({ color: 0xa6a195, roughness: 0.9 });
  for (const sx of [-1, 1]) {
    const pv = M.paving.clone(); pv.map = repeatOf(M.paving.map, 10 / 2.4, L / 2.4); PAVED.push(pv);
    panel(10, L, pv, sx * 9, 0.011, mid, 'up');                       // a broad pavement each side, to the colonnades
    box(0.22, 0.15, L, kerb, sx * 4.11, 0.075, mid);
  }
  // three blocks a side with cross streets between, so it reads as a city grid from the air
  for (const [a, b] of FIELD === 'delhi' ? [[62, 160], [178, 296], [314, 428]] : []) {
    cpBlock(-14, b, Math.PI / 2, b - a, 14);   // west side: the front faces the avenue (+x), running north
    cpBlock(14, a, -Math.PI / 2, b - a, 14);   // east side: the front faces the avenue (-x), running south
  }
  for (let z = z0 + 10; z < z1 - 4; z += 16) {
    cpLamp(-4.7, z, false); cpLamp(4.7, z + 8, false);
    for (const sx of [-1, 1]) tree(sx * 9.6, z + (sx > 0 ? 4 : 12)); // maples down both pavements, staggered
  }
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
  const kerbY = new THREE.MeshStandardMaterial({ color: 0xa6a195, roughness: 0.9 }), kerbK = new THREE.MeshStandardMaterial({ color: 0x8e897e, roughness: 0.9 }); // plain stone kerbs
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
/** The academy's car park, across the street east of the avenue: four rows of bays either side of two aisles, a
 *  driveway from the street with a barrier and a booth, lamps, shade trees along the edges, the sign, parked cars
 *  and a few scooters. */
function buildAcademyParking() {
  const X0 = 32, X1 = 112, Z0 = 46, Z1 = 92, cx = (X0 + X1) / 2, cz = (Z0 + Z1) / 2, g = new THREE.Group(), o = { cast: true, receive: true };
  const tar = M.asphalt.clone(); tar.map = repeatOf(M.asphalt.map, (X1 - X0) / 8, (Z1 - Z0) / 8); ASPHALT.push(tar);
  panel(X1 - X0, Z1 - Z0, tar, cx, 0.012, cz, 'up', scene);
  const line = new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: 0.8 }), kerb = new THREE.MeshStandardMaterial({ color: 0xa6a195, roughness: 0.9 });
  const rows = [[50, 1], [64, -1], [69, 1], [83, -1]], bays = []; // [z of the bay row's kerb-side end, which way the bays run]
  for (const [z0, dir] of rows) for (let x = X0 + 3; x <= X1 - 3; x += 2.6) {
    if (z0 === 50 && Math.abs(x - 72) < 8) continue; // the driveway comes in here
    box(0.12, 0.01, 5, line, x, 0.02, z0 + dir * 2.5, scene, { cast: false });
    if (x + 2.6 <= X1 - 3) bays.push([x + 1.3, z0 + dir * 2.5, dir]);
  }
  for (const z of [66.5]) box(X1 - X0 - 6, 0.25, 0.6, kerb, cx, 0.13, z, scene, o);   // the island between back-to-back rows
  for (const [w, d, x, z] of [[X1 - X0, 0.3, cx, Z0], [X1 - X0, 0.3, cx, Z1], [0.3, Z1 - Z0, X0, cz], [0.3, Z1 - Z0, X1, cz]]) if (!(z === Z0)) box(w, 0.18, d, kerb, x, 0.09, z, scene, o);
  for (let x = X0; x < X1; x += 1) if (Math.abs(x - 72) > 5) box(1, 0.18, 0.3, kerb, x + 0.5, 0.09, Z0, scene, o); // the street side, open at the driveway
  for (let x = X0 + 10; x < X1 - 5; x += 6) panel(0.15, 3, line, x, 0.02, 59, 'up', scene, { cast: false }); // aisle arrows' dashes
  // the driveway in: a booth and a red-and-white barrier
  box(2.2, 2.6, 2.2, new THREE.MeshStandardMaterial({ color: 0xf2f1ec, roughness: 0.7 }), 79, 1.3, 48, g, o);
  box(2.6, 0.2, 2.6, M.paintNavy, 79, 2.7, 48, g, o);
  const boom = box(7.5, 0.14, 0.14, new THREE.MeshStandardMaterial({ roughness: 0.6, map: canvasTex(64, 8, (c, w) => { for (let i = 0; i < 8; i++) { c.fillStyle = i % 2 ? '#ffffff' : '#d0211c'; c.fillRect(i * w / 8, 0, w / 8, 8); } }) }), 74.2, 1.05, 52, g, o);
  boom.rotation.z = 1.3; boom.position.set(77.6, 3.6, 49.5); // raised: the car park is open
  // the sign at the entrance
  const sign = new THREE.MeshStandardMaterial({ roughness: 0.6, map: canvasTex(512, 160, (c, w, h) => { c.fillStyle = '#111c44'; c.fillRect(0, 0, w, h); c.fillStyle = '#00a2e5'; c.fillRect(18, 18, 124, 124);
    c.fillStyle = '#fff'; c.font = FONT(800, 110, 'Arial, sans-serif'); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('P', 80, 84);
    c.textAlign = 'left'; c.font = FONT(800, 40, 'Arial, sans-serif'); c.fillText('STUDENT &', 166, 58); c.fillText('VISITOR PARKING', 166, 108); }) });
  for (const s of [-1, 1]) box(0.12, 2.6, 0.12, M.metalDark, 64 + s * 1.6, 1.3, 46.6, g, o);
  panel(4.2, 1.3, sign, 64, 2.6, 46.75, '-z', g, { cast: false, receive: false }); panel(4.2, 1.3, sign, 64, 2.6, 46.45, '+z', g, { cast: false, receive: false });
  scene.add(g);
  // lamps down the aisles, shade trees round the edges
  for (let x = X0 + 8; x < X1 - 4; x += 18) { cpLamp(x, 66.5, false); }
  for (let x = X0 + 4; x <= X1 - 4; x += 12) { tree(x, Z1 + 3.5); }
  for (let z = Z0 + 8; z <= Z1 - 2; z += 12) { tree(X1 + 3.5, z); tree(X0 - 3.5, z); }
  // parked cars (about three bays in four) and a few scooters by the booth
  const rnd = mulberry32(36), carGeo = vehicleGeo([[4.3, 0.75, 1.78, 0, 0.72, 0, 1], [2.3, 0.62, 1.62, -0.3, 1.38, 0, 0.16]], { wheels: [[1.35, 0.82, 0.33], [1.35, -0.82, 0.33], [-1.35, 0.82, 0.33], [-1.35, -0.82, 0.33]] });
  const parked = bays.filter(() => rnd() < 0.74), d = new THREE.Object3D(), col = new THREE.Color();
  const cm = new THREE.InstancedMesh(carGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.35 }), parked.length);
  parked.forEach(([x, z, dir], i) => { d.position.set(x + (rnd() - 0.5) * 0.3, 0.02, z); d.rotation.set(0, (dir > 0 ? Math.PI / 2 : -Math.PI / 2) + (rnd() - 0.5) * 0.05, 0); d.updateMatrix(); cm.setMatrixAt(i, d.matrix);
    cm.setColorAt(i, col.setHex([0xf2f2f0, 0xb8bcc2, 0x2b2f38, 0xa31f24, 0x2f4f8a, 0xd8d2c0, 0x6d7177, 0x8a1c1c][(rnd() * 8) | 0])); });
  cm.userData.dynamic = true; cm.computeBoundingSphere(); scene.add(cm);
  const scoot = vehicleGeo([[1.7, 0.45, 0.45, 0, 0.55, 0, 1], [0.5, 0.7, 0.4, 0.55, 0.9, 0, 1], [0.6, 0.15, 0.35, -0.2, 0.85, 0, 0.15]], { wheels: [[0.65, 0, 0.28], [-0.65, 0, 0.28]] });
  const sm = new THREE.InstancedMesh(scoot, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3 }), 8);
  for (let i = 0; i < 8; i++) { d.position.set(X0 + 2 + i * 1.1, 0.02, 48.5); d.rotation.set(0, Math.PI / 2 + (rnd() - 0.5) * 0.2, 0); d.updateMatrix(); sm.setMatrixAt(i, d.matrix); sm.setColorAt(i, col.setHex([0xd23a2a, 0x2a5aa0, 0x1d1f24, 0xf2f2f0][(rnd() * 4) | 0])); }
  sm.userData.dynamic = true; sm.computeBoundingSphere(); scene.add(sm);
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
    if (m.walk) { m.g.rotation.y = m.dir > 0 ? Math.PI / 2 : -Math.PI / 2; walkPose(m.g, t * m.speed * 4.4 + m.x0); }
  }
}

/* ---------- Aerocity from the air: OpenStreetMap buildings, roads, parks and trees, and the Live View route ---------- */
// data/aerocity.json comes from tools/osm2scene.py: OSM (c) OpenStreetMap contributors, ODbL. Real runway 10/28 is
// laid on the scene's, so the hotels, roads and parks stand where they really are relative to it.
const AERO = { data: null, split: 0.4, route: null, routeLen: 0, pin: null, ready: false, names: [] };
const AERIAL_KEYS = [ // aerial phase of the scroll, t 0..1: position, look target
  [0, [1650, 980, 2050], [180, 0, 160]],
  [0.3, [1050, 520, 1150], [40, 0, -60]],
  [0.6, [260, 150, 470], [0, 6, 0]],
  [0.84, [0, 24, 165], [0, 5, 0]],
  [1, [0, 1.8, 50], [0, 4.6, 0]],
];
const AERIAL_CURVE = new THREE.CatmullRomCurve3(AERIAL_KEYS.map((k) => new THREE.Vector3(...k[1])), false, 'centripetal', 0.5);
function aerialCamera(t, pos, look) {
  const e = t < 1 ? 1 - Math.pow(1 - t, 1.6) : 1; // fast high, slow as it nears the street
  AERIAL_CURVE.getPoint(e, pos);
  for (let i = 0; i < AERIAL_KEYS.length - 1; i++) {
    const [t0, , a] = AERIAL_KEYS[i], [t1, , b] = AERIAL_KEYS[i + 1];
    if (e <= t1) { const k = smooth((e - t0) / (t1 - t0)); look.set(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k); return; }
  }
  look.set(0, 4.6, 0);
}
async function fetchAerocity() {
  const src = FIELD === 'delhi' ? 'data/aerocity.json?v=8' : 'data/airfield.json?v=1';
  try { AERO.data = await (await fetch(src)).json(); } catch (e) { console.warn('aerocity', e); }
}
/** windows drawn per storey from world position: no UVs needed on thousands of extruded walls */
/** City buildings: walls take a baked Delhi facade (models/facades.webp, tools/bake_facades.py: 16 tiles of 2 bays x
 *  2 floors, 6.8 m x 6.6 m; the lowest band uses the four shop-front tiles), chosen per building by aVar; plaster
 *  (atlas alpha) takes the building's own colour, glass, grills, AC units and signs keep theirs. Roofs stay plain. */
let FACADES = null;
function cityMaterial() {
  FACADES ??= (() => { const t = new THREE.TextureLoader().load('models/facades.webp'); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = MAX_ANISO; return t; })();
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.tFac = { value: FACADES };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aVar; varying vec3 vWP; varying vec3 vON; varying float vVar;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = position; vON = normal; vVar = aVar;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      uniform sampler2D tFac; varying vec3 vWP; varying vec3 vON; varying float vVar;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float wall = 1.0 - step(0.6, abs(vON.y)), roof = step(0.6, vON.y);
        vec2 w = vec2((abs(vON.x) > abs(vON.z) ? vWP.z : vWP.x) / 6.8, vWP.y / 6.6);
        float tile = w.y < 1.0 ? 12.0 + mod(vVar, 4.0) : mod(vVar, 12.0);
        vec2 f = fract(w), cell = vec2(mod(tile, 4.0), floor(tile / 4.0));
        vec2 uvA = vec2((cell.x + 0.02 + f.x * 0.96) / 4.0, 1.0 - (cell.y + 1.0 - (0.02 + f.y * 0.96)) / 4.0);
        vec4 fac = textureGrad(tFac, uvA, dFdx(w) * 0.24, dFdy(w) * 0.24);    // continuous derivatives: no seams at tile edges
        vec3 wallCol = mix(fac.rgb, fac.rgb * diffuseColor.rgb / 0.66, fac.a);  // plaster takes the building's colour
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.78 + vec3(0.04), roof);
        diffuseColor.rgb = mix(diffuseColor.rgb, wallCol, wall);`)
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        // at dusk: the glazing (the atlas's dark, bluish texels) lit warm in about half the windows, chosen per bay
        float glass = step(0.0, fac.b - fac.r + 0.02) * (1.0 - smoothstep(0.22, 0.4, dot(fac.rgb, vec3(0.333))));
        float lit = step(0.5, fract(sin(dot(floor(w * vec2(2.0, 2.0)) + vVar * 1.7, vec2(12.9898, 78.233))) * 43758.5453));
        totalEmissiveRadiance += vec3(1.0, 0.72, 0.38) * glass * lit * wall * uNight * 1.8;`);
    sh.uniforms.uNight = NIGHT;
  };
  m.customProgramCacheKey = () => 'city-facades';
  return m;
}
/** Ground surfaces from photographed textures (Poly Haven, CC0), mixed in the shader by world position so nothing
 *  repeats visibly from the air: land (grass with dry patches and field-scale tone), lawn (grass with mowing stripes),
 *  road (asphalt, dashed centre line, edge lines, dust toward the kerbs; needs the ribbon's aRoad attribute). */
const GROUND_TEX = {};
// Real ground colour: Copernicus Sentinel-2 (24 March 2025, 10 m), baked into the scene's frame by
// tools/bake_satellite.py; the photo textures add the fine grain on top; it fades out at the edges of its 9 km square
let SAT_TEX = null;
function satelliteGround() {
  if (SAT_TEX) return SAT_TEX;
  if (FIELD !== 'delhi') { SAT_TEX = new THREE.DataTexture(new Uint8Array([90, 110, 60, 255]), 1, 1); SAT_TEX.needsUpdate = true; return SAT_TEX; } // no imagery: the ground is all procedural
  SAT_TEX = new THREE.TextureLoader().load('tex/ground_sat.webp?v=1');
  SAT_TEX.colorSpace = THREE.SRGBColorSpace; SAT_TEX.anisotropy = MAX_ANISO;
  return SAT_TEX;
}
const SAT_GLSL = `
  vec3 satGround(vec2 p, vec3 fallback, float detail) {
    vec2 suv = (p - uSat.xy) / uSat.zw;
    float inside = smoothstep(0.0, 0.06, min(min(suv.x, 1.0 - suv.x), min(suv.y, 1.0 - suv.y)));
    vec3 sat = texture2D(tSat, vec2(suv.x, 1.0 - suv.y)).rgb;
    float l = dot(sat, vec3(0.2126, 0.7152, 0.0722));
    sat = mix(vec3(l), sat, 0.62) * vec3(0.95, 1.0, 1.02);              // the true-colour product runs warm and saturated
    float veg = smoothstep(-0.004, 0.02, sat.g - sat.r * 0.9);           // greenish already: trees, fields, lawns
    sat *= mix(vec3(0.85, 1.08, 0.78), vec3(0.68, 1.2, 0.6), veg);       // March is Delhi's dry season: a greener one
    float lt = l < 0.14 ? l : 0.14 + (l - 0.14) * 0.25;                // soft knee: bright roofs and sand don't read as white blobs
    sat *= lt / max(l, 1e-3);
    sat = max(sat, vec3(0.025));
    // monsoon green: bare soil and dry grass (warm, not bright) grow over; roofs, roads and concrete (grey or bright) stay.
    // The photo keeps the tone (where it's darker or lighter), the colour is lush grass in two shades
    float soil = smoothstep(0.0, 0.02, sat.r - sat.b * 1.05) * (1.0 - smoothstep(0.15, 0.2, lt));
    float green = max(veg, soil);
    vec3 lush = mix(vec3(0.052, 0.105, 0.026), vec3(0.10, 0.165, 0.04), wf(p * 0.004 + 11.0));
    lush *= clamp(lt / 0.09, 0.75, 1.2);
    lush *= mix(vec3(0.82, 0.92, 1.1), vec3(1.15, 1.05, 0.8), clamp(detail - 0.5, 0.0, 1.0)); // dark blades bluer, lit tips yellower
    sat = mix(sat, lush, green * 0.92);
    return mix(fallback, sat * mix(1.0, detail, mix(0.55, 1.0, green)), inside);
  }`;
function groundTex(name) {
  if (GROUND_TEX[name]) return GROUND_TEX[name];
  const t = new THREE.TextureLoader().load(`tex/${name}_diff.jpg`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = MAX_ANISO;
  return (GROUND_TEX[name] = t);
}
function groundMaterial(kind, opts = {}) {
  const m = new THREE.MeshStandardMaterial({ roughness: 1, map: groundTex(kind === 'road' ? 'asphalt_02' : 'leafy_grass'), ...opts });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.tDry = { value: groundTex('withered_grass') }; sh.uniforms.uCloudT = CLOUD_T;
    sh.uniforms.uField = { value: new THREE.Vector4(-1980, -620, 1120, -12) }; sh.uniforms.uFarm = { value: FIELD === 'delhi' ? 0 : 1 }; // the airfield's fence box
    sh.uniforms.tSat = { value: satelliteGround() };
    sh.uniforms.uSat = { value: FIELD === 'delhi' ? new THREE.Vector4(-5200, -4100, 9000, 9000) : new THREE.Vector4(1e7, 1e7, 1, 1) }; // tools/bake_satellite.py's square (none: far away)
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 aRoad; varying vec3 vRoad; varying vec3 vGP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRoad = aRoad; vGP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    const body = {
      land: `
        // the photos lend their detail (brightness), the colour is ours: the grass photo is mostly leaf litter
        // three octaves of grass detail: blades close up, clumps, field patches (sharp from the ground, no tiling from the air)
        float dg = dot(texture2D(map, p / 2.3).rgb * 0.4 + texture2D(map, p / 7.0 + 0.19).rgb * 0.35 + texture2D(map, p / 29.0 + 0.37).rgb * 0.25, vec3(0.2126, 0.7152, 0.0722)) / 0.24;
        dg = max(1.0 + (dg - 1.0) * 1.7, 0.25);
        float dd = dot(texture2D(tDry, p / 9.0).rgb, vec3(0.2126, 0.7152, 0.0722)) / 0.31;
        float patchy = smoothstep(0.5, 0.72, wf(p * 0.0045));                         // a few trodden patches
        vec3 c = mix(vec3(0.075, 0.14, 0.035) * dg, vec3(0.16, 0.15, 0.08) * dd, patchy * 0.35); // beyond the imagery: green
        // farmland outside the airfield fence and the campus: a patchwork of fields (~150 x 95 m, staggered), each its
        // own crop (wheat green, young shoots, mustard in flower, ploughed earth, fallow), furrowed, with earth bunds between
        if (uFarm > 0.5) {
          vec2 p2 = mat2(0.985, 0.174, -0.174, 0.985) * p;                                    // the field grid runs 10 degrees off the runway
          float row = floor(p2.y / 95.0), fw = 90.0 + 130.0 * wh(vec2(row, 1.3));             // each row of fields its own length
          vec2 fq = vec2(p2.x / fw + row * 0.37, p2.y / 95.0);
          vec2 fc = floor(fq), ff = fract(fq);
          float fh = wh(fc + 3.1), fh2 = wh(fc + 7.7);
          vec3 crop = fh < 0.36 ? vec3(0.065, 0.125, 0.03) : fh < 0.62 ? vec3(0.1, 0.16, 0.042) : fh < 0.72 ? vec3(0.25, 0.215, 0.035)
                    : fh < 0.85 ? vec3(0.15, 0.112, 0.072) : vec3(0.12, 0.135, 0.058);
          crop *= 0.86 + 0.28 * fh2;
          float furrow = 0.9 + 0.1 * sin((fh2 > 0.5 ? p.x : p.y) * 3.927);                         // 1.6 m rows
          crop *= mix(1.0, furrow, waa(p, 0.7));
          float edge = min(min(ff.x, 1.0 - ff.x) * fw, min(ff.y, 1.0 - ff.y) * 95.0);
          crop = mix(crop, vec3(0.15, 0.135, 0.085), (1.0 - smoothstep(0.5, 1.6, edge)) * 0.75 * waa(p, 0.4));
          crop *= mix(1.0, dg, 0.55) * (0.9 + 0.2 * wf(p * 0.01));
          float inField = step(uField.x, p.x) * step(p.x, uField.z) * step(uField.y, p.y) * step(p.y, uField.w);
          float campus = step(abs(p.x), 420.0) * step(-40.0, p.y) * step(p.y, 140.0);
          c = mix(c, crop, (1.0 - inField) * (1.0 - campus));
        }
        c *= 0.82 + 0.34 * wf(p * 0.0012 + 3.0);                                         // field-scale tone
        diffuseColor.rgb *= satGround(p, c, dg);`,
      lawn: `
        float dg = dot(texture2D(map, p / 2.1).rgb * 0.4 + texture2D(map, p / 6.0 + 0.23).rgb * 0.35 + texture2D(map, p / 23.0 + 0.61).rgb * 0.25, vec3(0.2126, 0.7152, 0.0722)) / 0.24;
        dg = max(1.0 + (dg - 1.0) * 1.7, 0.25);
        float stripe = step(0.5, fract(p.x / 24.0));                                     // mowing stripes along the runway
        vec3 c = vec3(0.075, 0.15, 0.035) * dg * (0.88 + 0.24 * wf(p * 0.003));
        float dd = dot(texture2D(tDry, p / 8.0).rgb, vec3(0.2126, 0.7152, 0.0722)) / 0.31;
        c = mix(c, vec3(0.2, 0.19, 0.1) * dd, smoothstep(0.68, 0.84, wf(p * 0.006 + 7.0)) * 0.3);
        diffuseColor.rgb *= mix(satGround(p, c, dg), c, 0.35) * mix(0.96, 1.04, stripe); // the real grass, a little fresher, a hint of mowing`,
      road: `
        vec3 c = texture2D(map, p / 9.0).rgb * 0.82 * (0.9 + 0.2 * wf(p * 0.02));
        float a = abs(vRoad.x), hw = max(vRoad.y, 1.0), along = vRoad.z;
        float onRoad = step(1.0, vRoad.y);
        float centre = (1.0 - smoothstep(0.08, 0.14, a)) * step(0.5, fract(along / 9.0)) * step(7.0, hw * 2.0);
        float edge = (1.0 - smoothstep(0.08, 0.14, abs(a - (hw - 0.6)))) * step(7.0, hw * 2.0);
        c = mix(c, vec3(0.78, 0.76, 0.7), onRoad * max(centre, edge) * 0.85 * waa(p, 4.0));
        c = mix(c, vec3(0.55, 0.5, 0.42), onRoad * smoothstep(hw - 1.2, hw, a) * 0.35);   // dust at the kerb
        diffuseColor.rgb *= c;`,
    }[kind];
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D tDry; uniform sampler2D tSat; uniform vec4 uSat; uniform vec4 uField; uniform float uFarm; varying vec3 vRoad; varying vec3 vGP;' + WEAR_GLSL + SAT_GLSL)
      .replace('#include <map_fragment>', '{ vec2 p = vGP.xz;' + body + '\ndiffuseColor.rgb *= cloudShade(p);\n}');
  };
  m.customProgramCacheKey = () => 'ground-' + kind;
  return m;
}
/** The impostor tree card: a unit quad standing on its base, turned to face the camera about the vertical, showing
 *  the one of 8 baked views (4 x 2 sheet) nearest the camera's bearing from the tree. */
const TREE_CARD = { geo: new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), mat: null };
function treeCardMaterial(sheet = 'tree') {
  if (TREE_CARD[sheet]) return TREE_CARD[sheet];
  const tex = new THREE.TextureLoader().load(`models/${sheet}_impostor.webp`);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = MAX_ANISO;
  const m = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vec3 tp = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        vec2 toCam = cameraPosition.xz - tp.xz;
        float ang = atan(toCam.y, toCam.x);
        float k = mod(floor(ang / 0.785398 + 0.5) + 8.0, 8.0);
        float col = mod(k, 4.0), row = floor(k / 4.0);
        vMapUv = vec2((col + uv.x) / 4.0, 1.0 - (row + 1.0) / 2.0 + uv.y / 2.0);`)
      .replace('#include <project_vertex>', `
        vec2 side = normalize(vec2(toCam.y, -toCam.x) + 1e-5); // the bake camera's right-hand side: (z, -x) of its bearing
        float sx = length(vec3(instanceMatrix[0])), sy = length(vec3(instanceMatrix[1]));
        vec3 wp = tp + vec3(side.x, 0.0, side.y) * position.x * sx + vec3(0.0, position.y * sy, 0.0);
        vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mvPosition;`);
  };
  m.customProgramCacheKey = () => 'tree-card';
  TREE_CARD[sheet] = m;
  return m;
}
function buildAerocity() {
  const D = AERO.data;
  if (!D) return;
  const rnd = mulberry32(2024);
  const city = new THREE.Group(); city.userData.dynamic = true; scene.add(city);
  const col = new THREE.Color();
  const PALETTE = [0xe8dcc4, 0xd9c39c, 0xe6c2a0, 0xe0bdb2, 0xcfcac2, 0xf0ebe0, 0xd2b57a, 0xc9b8a3, 0xbfa58c];
  const HOTEL = [0xa9b6c0, 0xd6ccba, 0x8d9aa6, 0xc8bfb0];
  // buildings, one merged mesh
  const geos = [], tanks = [];
  for (const b of D.buildings) {
    const h = b[0], kind = b[1], pts = [];
    for (let i = 2; i < b.length; i += 2) pts.push(new THREE.Vector2(b[i], -b[i + 1]));
    if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
    let g;
    try { g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: h, bevelEnabled: false }); } catch { continue; }
    g.rotateX(-Math.PI / 2);
    g.deleteAttribute('uv');
    const ng = g.index ? g.toNonIndexed() : g; if (ng !== g) g.dispose(); // extrusions usually arrive non-indexed already
    col.setHex((kind === 1 ? HOTEL : PALETTE)[(rnd() * (kind === 1 ? HOTEL.length : PALETTE.length)) | 0]);
    const n = ng.attributes.position.count, c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
    ng.setAttribute('color', new THREE.BufferAttribute(c, 3));
    ng.setAttribute('aVar', new THREE.BufferAttribute(new Float32Array(n).fill(Math.floor(rnd() * 48)), 1)); // which facade
    geos.push(ng);
    if (kind === 0 && h < 20 && pts.length >= 3) { // black water tanks on Delhi roofs
      let cx = 0, cz = 0; for (const q of pts) { cx += q.x; cz -= q.y; } cx /= pts.length; cz /= pts.length;
      const k = 1 + ((rnd() * 2) | 0);
      for (let i = 0; i < k; i++) tanks.push([cx + (rnd() - 0.5) * 3, h, cz + (rnd() - 0.5) * 3]);
    }
  }
  const bm = new THREE.Mesh(mergeGeometries(geos), cityMaterial());
  geos.forEach((g) => g.dispose());
  bm.castShadow = true; bm.receiveShadow = true;
  city.add(bm);
  const tank = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.75, 0.75, 1.4, 10).translate(0, 0.7, 0), new THREE.MeshStandardMaterial({ color: 0x1e1f22, roughness: 0.6 }), tanks.length);
  const d = new THREE.Object3D();
  tanks.forEach(([x, y, z], i) => { d.position.set(x, y, z); d.scale.setScalar(0.8 + rnd() * 0.5); d.updateMatrix(); tank.setMatrixAt(i, d.matrix); });
  tank.userData.noCast = true; city.add(tank);
  // roads: ribbons along each centreline, with an even asphalt; the road graph for the route
  const rp = [], ri = [], graph = new Map(), key = (x, z) => `${Math.round(x)},${Math.round(z)}`;
  const link = (a, b, w) => { const k1 = key(...a), k2 = key(...b), L = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (!graph.has(k1)) graph.set(k1, { p: a, e: [] }); if (!graph.has(k2)) graph.set(k2, { p: b, e: [] });
    graph.get(k1).e.push([k2, L, w]); graph.get(k2).e.push([k1, L, w]); };
  const ra = [];
  D.roads.forEach((r, idx) => {
    const w = r[0], pts = [];
    for (let i = 1; i < r.length; i += 2) pts.push([r[i], r[i + 1]]);
    let along = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let tx = b[0] - a[0], tz = b[1] - a[1]; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
      const y = w >= 10 ? 0.06 : 0.05;
      rp.push(pts[i][0] - tz * w / 2, y, pts[i][1] + tx * w / 2, pts[i][0] + tz * w / 2, y, pts[i][1] - tx * w / 2);
      if (i) along += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      ra.push(-w / 2, w / 2, along, w / 2, w / 2, along);
      if (i) { const v = rp.length / 3 - 4; ri.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); }
      if (i) link(pts[i - 1], pts[i], w);
    }
    if (D.names[idx]) AERO.names.push([pts, D.names[idx]]);
  });
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3));
  rg.setAttribute('aRoad', new THREE.Float32BufferAttribute(ra, 3));
  rg.setIndex(ri); rg.computeVertexNormals();
  const road = new THREE.Mesh(rg, groundMaterial('road', { roughness: 0.92, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 }));
  road.receiveShadow = true; city.add(road);
  // the campus street joins the city at both ends
  for (const sx of [-1, 1]) link([sx * 130, ROAD.z], [sx * 175, ROAD.z], 9);
  link([-130, ROAD.z], [0, ROAD.z], 9); link([0, ROAD.z], [130, ROAD.z], 9);
  let best = null, bd = 1e9; // nearest city node to each street end
  for (const sx of [-1, 1]) { for (const v of graph.values()) { const dd = Math.hypot(v.p[0] - sx * 175, v.p[1] - ROAD.z); if (dd < bd && dd > 1) { bd = dd; best = v.p; } } link([sx * 175, ROAD.z], best, 9); bd = 1e9; }
  // parks and water
  const ap = { park: [], wood: [], water: [], pitch: [] };
  for (const a of D.areas) { const pts = []; for (let i = 1; i < a.length; i += 2) pts.push(new THREE.Vector2(a[i], -a[i + 1])); try { const g = new THREE.ShapeGeometry(new THREE.Shape(pts)); g.rotateX(-Math.PI / 2); g.deleteAttribute('uv'); (ap[a[0]] || ap.park).push(g); } catch { /* bad ring */ } }
  const areaCol = { park: 0x6f8748, wood: 0x55693a, water: 0x587b84, pitch: 0x7d9650 };
  for (const [k, gs] of Object.entries(ap)) if (gs.length) {
    const mat = k === 'water' ? new THREE.MeshStandardMaterial({ color: areaCol[k], roughness: 0.25, polygonOffset: true, polygonOffsetFactor: -0.5 })
      : groundMaterial('lawn', { polygonOffset: true, polygonOffsetFactor: -0.5, color: k === 'wood' ? 0xb8c0a8 : 0xffffff });
    const m = new THREE.Mesh(mergeGeometries(gs), mat);
    m.position.y = 0.04; m.receiveShadow = true; city.add(m);
  }
  // trees: avenues along the bigger roads, and clumps in the parks
  const trees = [];
  D.roads.forEach((r) => { const w = r[0]; if (w < 10) return;
    for (let i = 3; i < r.length; i += 2) { const x0 = r[i - 2], z0 = r[i - 1], x1 = r[i], z1 = r[i + 1], L = Math.hypot(x1 - x0, z1 - z0); if (!L) continue;
      const nx = -(z1 - z0) / L, nz = (x1 - x0) / L;
      for (let s2 = 0; s2 < L; s2 += 15) for (const sd of [-1, 1]) if (rnd() < 0.8) trees.push([x0 + (x1 - x0) * s2 / L + sd * nx * (w / 2 + 3.5), z0 + (z1 - z0) * s2 / L + sd * nz * (w / 2 + 3.5)]); } });
  for (const a of D.areas) if (a[0] === 'park' || a[0] === 'wood') {
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (let i = 1; i < a.length; i += 2) { x0 = Math.min(x0, a[i]); x1 = Math.max(x1, a[i]); z0 = Math.min(z0, a[i + 1]); z1 = Math.max(z1, a[i + 1]); }
    const n = Math.min(400, ((x1 - x0) * (z1 - z0)) / (a[0] === 'wood' ? 60 : 180));
    for (let i = 0; i < n; i++) trees.push([x0 + rnd() * (x1 - x0), z0 + rnd() * (z1 - z0)]);
  }
  // the empty land between: Delhi is green, so the gaps fill with tree cover in clumps (8 m occupancy grid)
  const G0x = -3200, G0z = -40, GS = 8, GW = Math.ceil(6000 / GS), GH = Math.ceil(3300 / GS), occ = new Uint8Array(GW * GH);
  const mark = (x, z, r) => { for (let gx = Math.floor((x - r - G0x) / GS); gx <= Math.floor((x + r - G0x) / GS); gx++) for (let gz = Math.floor((z - r - G0z) / GS); gz <= Math.floor((z + r - G0z) / GS); gz++) if (gx >= 0 && gz >= 0 && gx < GW && gz < GH) occ[gz * GW + gx] = 1; };
  for (const b of D.buildings) { let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (let i = 2; i < b.length; i += 2) { x0 = Math.min(x0, b[i]); x1 = Math.max(x1, b[i]); z0 = Math.min(z0, b[i + 1]); z1 = Math.max(z1, b[i + 1]); }
    for (let x = x0; x <= x1; x += GS) for (let z = z0; z <= z1; z += GS) mark(x, z, 3); }
  D.roads.forEach((r) => { for (let i = 3; i < r.length; i += 2) { const L = Math.hypot(r[i] - r[i - 2], r[i + 1] - r[i - 1]); for (let s2 = 0; s2 <= L; s2 += GS / 2) mark(r[i - 2] + (r[i] - r[i - 2]) * s2 / (L || 1), r[i - 1] + (r[i + 1] - r[i - 1]) * s2 / (L || 1), r[0] / 2 + 2); } });
  for (const a of D.areas) if (a[0] === 'water') for (let i = 1; i < a.length; i += 2) mark(a[i], a[i + 1], 12);
  const fill = [];
  const clump = (x, z) => (Math.sin(x * 0.011 + Math.sin(z * 0.007) * 3) + Math.sin(z * 0.013 - x * 0.004) + Math.sin((x + z) * 0.021)) / 3;
  for (let gz = 0; gz < GH; gz++) for (let gx = 0; gx < GW; gx++) {
    if (occ[gz * GW + gx]) continue;
    const x = G0x + (gx + rnd()) * GS, z = G0z + (gz + rnd()) * GS;
    if (rnd() < (FIELD === 'delhi' ? 1 : 0.22) * (0.08 + 0.55 * Math.max(0, clump(x, z) + 0.15))) fill.push([x, z]); // (farmland: copses and tree lines, not tree cover)
  }
  // IGI's real perimeter: no trees inside the fence, and the airfield's dusty ground instead of the city's
  const fence = []; { const bd = D.aero?.boundary || []; for (let i = 0; i < bd.length; i += 2) fence.push([bd[i], bd[i + 1]]); }
  const inAirport = (x, z) => { let c = false; for (let i = 0, j = fence.length - 1; i < fence.length; j = i++) { const [xi, zi] = fence[i], [xj, zj] = fence[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; };
  // the movement area (runways, taxiways, aprons) as a quick distance test: keeps fences and filler off it
  const pave = [], G = 250, grid = new Map();
  const addSeg = (r, a, b) => { const c = [r, a, b];
    for (let gx = Math.floor((Math.min(a[0], b[0]) - r) / G); gx <= Math.floor((Math.max(a[0], b[0]) + r) / G); gx++)
      for (let gz = Math.floor((Math.min(a[1], b[1]) - r) / G); gz <= Math.floor((Math.max(a[1], b[1]) + r) / G); gz++) { const k = gx + ',' + gz; (grid.get(k) ?? grid.set(k, []).get(k)).push(c); } };
  const A = D.aero ?? {}, pts2 = (v) => { const o = []; for (let i = 0; i + 1 < v.length; i += 2) o.push([v[i], v[i + 1]]); return o; };
  for (const r of A.runways ?? []) { const q = pts2(r.slice(2)); for (let i = 1; i < q.length; i++) addSeg(160, q[i - 1], q[i]); }
  addSeg(160, [RWY_END - 950, RWY_Z], [RWY_THR + 950, RWY_Z]);                       // the scene's own runway and its approach lights
  for (const t of A.taxiways ?? []) { const q = pts2(t.slice(2)); for (let i = 1; i < q.length; i++) addSeg(t[0] / 2 + 40, q[i - 1], q[i]); }
  for (const a of A.aprons ?? []) { const q = pts2(a); for (let i = 0; i < q.length; i++) addSeg(40, q[i], q[(i + 1) % q.length]); }
  const dseg = (x, z, a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2)); return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t); };
  const onField = (x, z) => (grid.get(Math.floor(x / G) + ',' + Math.floor(z / G)) ?? []).some(([r, a, b]) => dseg(x, z, a, b) < r);
  const offCampus = ([x, z]) => !(Math.abs(x) < 185 && z < 105) && !(Math.abs(x) < 70 + z * 0.12 && z < 600) && !inAirport(x, z) && !(x > -800 && x < 720 && z < 40); // clear of the approach and the airport
  const tc = new THREE.Color();
  // trees: baked impostors (tools/bake_impostor.html renders the maple from 8 sides, lit by the scene's sun, into
  // models/tree_impostor.webp); each tree is one camera-facing card showing the view nearest the camera's angle
  // and coconut palms (a code-built palm baked the same way, models/palm_impostor.webp): about one tree in three
  // nothing grows in the water: a point-in-polygon test over the lakes and ponds
  const waters = D.areas.filter((a) => a[0] === 'water').map((a) => { const q = []; for (let i = 1; i < a.length; i += 2) q.push([a[i], a[i + 1]]); return q; });
  const canals = (D.canals ?? []).map((c) => { const q = []; for (let i = 1; i < c.length; i += 2) q.push([c[i], c[i + 1]]); return { w: c[0], q }; });
  const nearCanal = (x, z, pad = 6) => canals.some(({ w, q }) => { for (let i = 1; i < q.length; i++) { const [ax, az] = q[i - 1], [bx, bz] = q[i], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)); if (Math.hypot(x - ax - dx * t, z - az - dz * t) < w / 2 + pad) return true; } return false; });
  const railPts = []; for (let i = 0; i < (D.rail ?? []).length; i += 2) railPts.push([D.rail[i], D.rail[i + 1]]);
  const nearRail = (x, z) => { for (let i = 1; i < railPts.length; i++) { const [ax, az] = railPts[i - 1], [bx, bz] = railPts[i], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)); if (Math.hypot(x - ax - dx * t, z - az - dz * t) < 14) return true; } return false; };
  const inWater = (x, z) => nearCanal(x, z) || nearRail(x, z) || waters.some((ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, zi] = ring[i], [xj, zj] = ring[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; });
  const forest = (list, geo, rMin, rMax, { palms = 0.32, filter = true } = {}) => {
    void geo;
    if (filter) list = list.filter(offCampus);
    list = list.filter(([x, z], i) => !inWater(x, z) && (!LITE || i % 2 === 0));
    const broad = [], palm = [];
    for (const q of list) (rnd() < palms ? palm : broad).push(q);
    const tm = new THREE.InstancedMesh(TREE_CARD.geo, treeCardMaterial(), broad.length);
    broad.forEach(([x, z], i) => {
      const h = (rMin + rnd() * (rMax - rMin)) * 2.7, w = 0.95 + rnd() * 0.35;                 // 6.5-15 m, some broad like neem
      d.position.set(x, 0, z); d.rotation.set(0, 0, 0); d.scale.set(h * w / 0.96, h / 0.96, 1); d.updateMatrix(); tm.setMatrixAt(i, d.matrix);
      tm.setColorAt(i, tc.setRGB(0.8 + rnd() * 0.18, 0.92 + rnd() * 0.16, 0.7 + rnd() * 0.16));   // a little variety, on the lush side
    });
    const pm = new THREE.InstancedMesh(TREE_CARD.geo, treeCardMaterial('palm'), palm.length);
    palm.forEach(([x, z], i) => {
      const h = 8 + rnd() * 7;                                                                     // 8-15 m
      d.position.set(x, 0, z); d.rotation.set(0, 0, 0); d.scale.set(h * (0.9 + rnd() * 0.2) / 0.94, h / 0.94, 1); d.updateMatrix(); pm.setMatrixAt(i, d.matrix);
      pm.setColorAt(i, tc.setRGB(0.88 + rnd() * 0.16, 0.92 + rnd() * 0.12, 0.82 + rnd() * 0.14));
    });
    for (const m of [tm, pm]) { m.frustumCulled = false; m.userData.noCast = true; m.userData.dynamic = true; city.add(m); }
  };
  forest(trees, new THREE.IcosahedronGeometry(1, 2), 2.4, 4.2);
  // Delhi has far more buildings than OSM maps: fill the empty land with low-rise neighbourhoods and their trees,
  // in clumps, off the roads, parks, water, the campus approach and the airport
  function fillSuburbs() {
    const X0 = -4800, X1 = 3400, Z0 = -3400, Z1 = 4200, C = 30, NW = Math.ceil((X1 - X0) / C), NH = Math.ceil((Z1 - Z0) / C);
    const busy = new Uint8Array(NW * NH);
    const hit = (x, z, r) => { for (let gx = Math.floor((x - r - X0) / C); gx <= Math.floor((x + r - X0) / C); gx++) for (let gz = Math.floor((z - r - Z0) / C); gz <= Math.floor((z + r - Z0) / C); gz++) if (gx >= 0 && gz >= 0 && gx < NW && gz < NH) busy[gz * NW + gx] = 1; };
    for (const b of D.buildings) for (let i = 2; i < b.length; i += 2) hit(b[i], b[i + 1], 12);
    for (const r of D.roads) { const w = r[0]; for (let i = 3; i < r.length; i += 2) { const L = Math.hypot(r[i] - r[i - 2], r[i + 1] - r[i - 1]); for (let t = 0; t <= L; t += 10) hit(r[i - 2] + (r[i] - r[i - 2]) * t / (L || 1), r[i - 1] + (r[i + 1] - r[i - 1]) * t / (L || 1), w / 2 + 4); } }
    for (const a of D.areas) { let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (let i = 1; i < a.length; i += 2) { x0 = Math.min(x0, a[i]); x1 = Math.max(x1, a[i]); z0 = Math.min(z0, a[i + 1]); z1 = Math.max(z1, a[i + 1]); }
      for (let x = x0; x <= x1; x += C) for (let z = z0; z <= z1; z += C) hit(x, z, 0); }
    const hood = (x, z) => (Math.sin(x * 0.0021 + Math.sin(z * 0.0017) * 2.2) + Math.sin(z * 0.0026 - x * 0.0011 + 1.3) + Math.sin((x - z) * 0.0043)) / 3; // neighbourhoods and open ground between
    const pos = [], nor = [], colr = [], vars = [], more = [];
    let fv = 0;
    const face = (P, n, c) => { for (const k of [0, 1, 2, 0, 2, 3]) { pos.push(...P[k]); nor.push(...n); colr.push(c.r, c.g, c.b); vars.push(fv); } };
    const house = (x, z, w, d, h, a, c) => {
      fv = Math.floor(rnd() * 48);
      const ca = Math.cos(a), sa = Math.sin(a), at = (u, v, y) => [x + u * ca - v * sa, y, z + u * sa + v * ca];
      const hw = w / 2, hd = d / 2, n = (u, v) => [u * ca - v * sa, 0, u * sa + v * ca];
      face([at(-hw, hd, 0), at(hw, hd, 0), at(hw, hd, h), at(-hw, hd, h)], n(0, 1), c);
      face([at(hw, -hd, 0), at(-hw, -hd, 0), at(-hw, -hd, h), at(hw, -hd, h)], n(0, -1), c);
      face([at(hw, hd, 0), at(hw, -hd, 0), at(hw, -hd, h), at(hw, hd, h)], n(1, 0), c);
      face([at(-hw, -hd, 0), at(-hw, hd, 0), at(-hw, hd, h), at(-hw, -hd, h)], n(-1, 0), c);
      face([at(-hw, hd, h), at(hw, hd, h), at(hw, -hd, h), at(-hw, -hd, h)], [0, 1, 0], c);
    };
    const cc = new THREE.Color();
    for (let gz = 0; gz < NH; gz++) for (let gx = 0; gx < NW; gx++) {
      if (busy[gz * NW + gx]) continue;
      const x = X0 + (gx + 0.5) * C, z = Z0 + (gz + 0.5) * C;
      if (!offCampus([x, z]) || inAirport(x, z) || Math.hypot(x, z + 322) < 300 || (x > -780 && x < 800 && z > -130 && z < 45) || (z < -100 && z > -1750 && x > -4800 && x < 1800) || onField(x, z)) continue; // off the hangar row and the airfield
      if (D.towns && (rnd() < 0.4 || !D.towns.some(([tx, tz, r]) => Math.hypot(x - tx, z - tz) < r * (0.75 + 0.35 * Math.sin(Math.atan2(z - tz, x - tx) * 3 + tx))))) { if (rnd() < 0.05) more.push([x + (rnd() - 0.5) * C, z + (rnd() - 0.5) * C]); continue; } // farmland between the town and villages
      const v = hood(x, z);
      if (v < -0.12) { for (let k = 0; k < 2; k++) if (rnd() < 0.3) more.push([x + (rnd() - 0.5) * C, z + (rnd() - 0.5) * C]); continue; } // open ground: scattered trees
      const a = Math.round(hood(x * 0.3, z * 0.3) * 6) * 0.26;                                                   // a street grid per neighbourhood
      const tall = rnd() < 0.04, n2 = rnd() < 0.55 ? 2 : 1;
      for (let k = 0; k < n2; k++) {
        const w = 9 + rnd() * 12, d = 8 + rnd() * 9, h = tall ? 20 + rnd() * 18 : 3.3 * (2 + ((rnd() * 4) | 0)) + 0.6;
        const ox = n2 === 2 ? (k ? 7 : -7) : 0, oz = (rnd() - 0.5) * 6;
        cc.setHex(PALETTE[(rnd() * PALETTE.length) | 0]);
        house(x + ox * Math.cos(a) - oz * Math.sin(a), z + ox * Math.sin(a) + oz * Math.cos(a), w, d, h, a, cc);
      }
      for (let k = 0; k < 2; k++) if (rnd() < 0.45) more.push([x + (rnd() - 0.5) * C, z + (rnd() - 0.5) * C]);  // neem and peepal in the yards: Delhi is green from above
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
    g.setAttribute('aVar', new THREE.Float32BufferAttribute(vars, 1));
    const m = new THREE.Mesh(g, cityMaterial()); m.receiveShadow = true; m.userData.noCast = true; city.add(m);
    forest(more, new THREE.IcosahedronGeometry(1, 1), 3, 5.5);
    console.info('suburbs', pos.length / 90, 'buildings,', more.length, 'trees');
  }
  forest(fill, new THREE.IcosahedronGeometry(1, 1), 2.6, 5);
  // a palm-lined boundary behind the hangar row, both sides of the academy
  const row = [];
  for (const [x0, x1] of [[-760, -390], [370, 640]]) for (let x = x0; x <= x1; x += 13) row.push([x + (rnd() - 0.5) * 3, 26 + (rnd() - 0.5) * 3]);
  forest(row, null, 0, 0, { palms: 1, filter: false });
  // the ground under the city: a dusty sage, not the airfield's bare earth
  const gt = canvasTex(256, 256, (g, w, h) => { g.fillStyle = '#8a9465'; g.fillRect(0, 0, w, h); speckle(g, w, h, 9000, ['#7e895a', '#97a06f', '#848f5d', '#9da574'], 0.5, [1, 4]); });
  gt.wrapS = gt.wrapT = THREE.RepeatWrapping; gt.repeat.set(30000 / 40, 30000 / 40);
  // everywhere outside the airport fence (whose dusty ground sits just above): out to the horizon, where the haze takes it
  void gt;
  const ground = panel(30000, 30000, groundMaterial('land'), -200, -0.03, 0, 'up', city);
  ground.receiveShadow = true;
  fillSuburbs();
  if (fence.length > 3 && AIRFIELD[0]) {
    try {
      const g = new THREE.ShapeGeometry(new THREE.Shape(fence.map(([x, z]) => new THREE.Vector2(x, -z))));
      g.rotateX(-Math.PI / 2);
      const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, -uv.getY(i));
      const am = AIRFIELD[0].clone(); am.map = repeatOf(AIRFIELD[0].map, 1 / 8, 1 / 8); AIRFIELD.push(am);
      void g; void am; // the airport sits on the same ground as the city (its own darker sheet read as bare earth)
      perimeterFence(fence);
    } catch { /* a bad ring: keep the city ground */ }
  }
  /** IGI's perimeter fence on the real boundary: posts, mesh panels, a top wire with the barbed outrigger;
   *  left open where the boundary runs through the campus, the street and the avenue */
  function perimeterFence(ring) {
    // never across the movement area: the stitched boundary has chords over the field, and the real line runs
    // between aprons in places; a fence goes round the outside only
    const skip = (x, z) => (Math.abs(x) < 340 && z > -140 && z < 470) || onField(x, z);
    const H = 3, post = [], quads = [];
    for (let i = 0; i < ring.length; i++) {
      const [x0, z0] = ring[i], [x1, z1] = ring[(i + 1) % ring.length], L = Math.hypot(x1 - x0, z1 - z0);
      if (L < 0.5 || L > 250 || skip(x0, z0) || skip(x1, z1) || skip((x0 + x1) / 2, (z0 + z1) / 2)) continue; // (a chord that long is a stitching artefact)
      quads.push([x0, z0, x1, z1]);
      for (let t = 0; t < L; t += 6) post.push([x0 + (x1 - x0) * t / L, z0 + (z1 - z0) * t / L]);
    }
    const pos = [], top = [];
    for (const [x0, z0, x1, z1] of quads) {
      pos.push(x0, 0, z0, x1, 0, z1, x1, H, z1, x0, 0, z0, x1, H, z1, x0, H, z0);
      top.push(x0, H - 0.05, z0, x1, H - 0.05, z1, x1, H + 0.12, z1, x0, H - 0.05, z0, x1, H + 0.12, z1, x0, H + 0.12, z0);
    }
    const mk = (arr) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)); g.computeVertexNormals(); return g; };
    const mesh = new THREE.Mesh(mk(pos), new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.8, metalness: 0.3, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false }));
    mesh.renderOrder = 1; mesh.userData.noCast = true; city.add(mesh);
    const rail = new THREE.Mesh(mk(top), new THREE.MeshStandardMaterial({ color: 0x55595f, roughness: 0.7, metalness: 0.4, side: THREE.DoubleSide }));
    rail.userData.noCast = true; city.add(rail);
    const pm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, H + 0.45, 0.1).translate(0, (H + 0.45) / 2, 0), new THREE.MeshStandardMaterial({ color: 0x4b4f55, roughness: 0.7, metalness: 0.4 }), post.length);
    post.forEach(([x, z], i) => { d.position.set(x, 0, z); d.rotation.set(0, 0, 0); d.scale.setScalar(1); d.updateMatrix(); pm.setMatrixAt(i, d.matrix); });
    pm.userData.noCast = true; city.add(pm);
  }
  // the Live View route: Dijkstra from the JW Marriott forecourt to the academy gate
  const start = D.pois.start || D.pois['JW Marriott Hotel New Delhi Aerocity'] || [800, 300];
  const near = (x, z) => { let b2 = null, dd = 1e9; for (const [k, v] of graph) { const q = Math.hypot(v.p[0] - x, v.p[1] - z); if (q < dd) { dd = q; b2 = k; } } return b2; };
  const s0 = near(...start), goal = key(0, ROAD.z);
  const dist = new Map([[s0, 0]]), prev = new Map(), done = new Set();
  const open = [[0, s0]];
  while (open.length) {
    open.sort((a, b) => a[0] - b[0]);
    const [dd, k] = open.shift(); if (done.has(k)) continue; done.add(k); if (k === goal) break;
    for (const [k2, L, w] of graph.get(k).e) { const nd = dd + L * (w >= 6 ? 1 : 1.6); if (nd < (dist.get(k2) ?? 1e12)) { dist.set(k2, nd); prev.set(k2, k); open.push([nd, k2]); } }
  }
  const route = [];
  for (let k = goal; k; k = prev.get(k)) route.unshift(graph.get(k).p);
  if (route.length > 1) {
    route.push([0, ROAD.z + ROAD.half + 1.2]); // across to the apron's kerb, where the walk begins
    AERO.route = route.map(([x, z]) => new THREE.Vector3(x, 0.4, z));
    for (let i = 1; i < AERO.route.length; i++) AERO.routeLen += AERO.route[i].distanceTo(AERO.route[i - 1]);
    // a blue ribbon, wide enough to read from the air
    const pts = AERO.route, pp = [], ii = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let tx = b.x - a.x, tz = b.z - a.z; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
      pp.push(pts[i].x - tz * 2.2, 0.32, pts[i].z + tx * 2.2, pts[i].x + tz * 2.2, 0.32, pts[i].z - tx * 2.2);
      if (i) { const v = pp.length / 3 - 4; ii.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); }
    }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(pp, 3)); lg.setIndex(ii);
    AERO.line = new THREE.Mesh(lg, new THREE.MeshBasicMaterial({ color: 0x3d8bff, transparent: true, opacity: 0.92, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, side: THREE.DoubleSide }));
    AERO.line.renderOrder = 3; AERO.line.userData.noCast = true; city.add(AERO.line);
    // ground chevrons over the last stretch, pointing the way
    const chev = canvasTex(128, 128, (g, w, h) => {
      g.strokeStyle = '#ffffff'; g.lineWidth = 16; g.lineCap = 'round'; g.lineJoin = 'round';
      g.shadowColor = '#5aa2ff'; g.shadowBlur = 18;
      for (const y of [30, 70]) { g.beginPath(); g.moveTo(26, y + 30); g.lineTo(64, y - 4); g.lineTo(102, y + 30); g.stroke(); }
    });
    AERO.chevMat = new THREE.MeshBasicMaterial({ map: chev, color: 0x9cc8ff, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8 });
    let acc = 0;
    for (let i = AERO.route.length - 1; i > 0 && acc < 260; i--) {
      const a = AERO.route[i - 1], b = AERO.route[i], L = a.distanceTo(b), dx = (b.x - a.x) / (L || 1), dz = (b.z - a.z) / (L || 1);
      for (let s2 = L - 4; s2 > 0 && acc + (L - s2) < 260; s2 -= 9) {
        const m = panel(2.6, 2.6, AERO.chevMat, a.x + dx * s2, 0.36, a.z + dz * s2, 'up', city, { cast: false, receive: false });
        m.rotation.z = Math.atan2(-dx, -dz); m.renderOrder = 4;
      }
      acc += L;
    }
  }
  // the destination pin over the academy
  const pin = new THREE.Group();
  const red = new THREE.MeshStandardMaterial({ color: 0xea4335, roughness: 0.4, emissive: 0x5a0d08 });
  const shape = [];
  for (let i = 0; i <= 24; i++) { const a = -Math.PI / 2 + (i / 24) * Math.PI * 1.5; shape.push(new THREE.Vector2(Math.max(0.001, Math.cos(a) * 1), 1.6 + Math.sin(a) * 1)); }
  const body = new THREE.Mesh(new THREE.LatheGeometry([new THREE.Vector2(0.001, 0), new THREE.Vector2(0.45, 0.7), ...shape.filter((v) => v.y > 0.75)], 28), red);
  pin.add(body);
  pin.add(new THREE.Mesh(new THREE.SphereGeometry(0.38, 18, 12), new THREE.MeshBasicMaterial({ color: 0x7a1a12 })).translateY(1.65).translateZ(0.72));
  pin.userData.noCast = true;
  pin.userData.dynamic = true; // kept out of the static merge: it scales with distance
  pin.position.set(0, 15, -8);
  scene.add(pin);
  AERO.pin = pin;
  AERO.ready = true;
  if (FIELD !== 'delhi') { buildCountryLife(city, D); buildCountryDetail(city, D); }
}
/* ---------- Country life: traffic on the roads, birds over the lake and fields, cattle grazing ---------- */
// All code-built and instanced (one draw per kind): cars, buses and tractors keep left along the road polylines and
// turn back at the ends; flocks wheel over the lake, the fields and the town; cattle graze in loose herds.
const COUNTRY = { vehicles: [], flocks: [], ready: false };
function vehicleGeo(parts, { wheels = null, round = 0.22 } = {}) { // parts: [w, h, d, x, y, z, shade]; merged softened boxes, vertex-shaded so one instance colour paints the body
  if (wheels) for (const [x, z, r] of wheels) parts = [...parts, [r * 2, r * 2, 0.28, x, r, z, 0.06, 'wheel']];
  const geos = parts.map(([w, h, d, x, y, z, s, kind]) => { const g = (kind === 'wheel' ? new THREE.CylinderGeometry(h / 2, h / 2, d, 12).rotateX(Math.PI / 2)
      : new RoundedBoxGeometry(w, h, d, 2, Math.max(0.001, Math.min(w, h, d) * round))).translate(x, y, z).toNonIndexed(); g.deleteAttribute('uv');
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(s), 3)); return g; });
  return mergeGeometries(geos);
}
function buildCountryLife(city, D) {
  const rnd = mulberry32(77), d = new THREE.Object3D(), col = new THREE.Color();
  const std = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25 });
  const KINDS = {
    car: { geo: vehicleGeo([[4.3, 0.75, 1.78, 0, 0.72, 0, 1], [2.3, 0.62, 1.62, -0.3, 1.38, 0, 0.16], [0.08, 0.16, 0.5, 2.15, 0.82, 0.55, 2.5], [0.08, 0.16, 0.5, 2.15, 0.82, -0.55, 2.5]], { wheels: [[1.35, 0.82, 0.33], [1.35, -0.82, 0.33], [-1.35, 0.82, 0.33], [-1.35, -0.82, 0.33]] }),
      colors: [0xf2f2f0, 0xb8bcc2, 0x2b2f38, 0xa31f24, 0x2f4f8a, 0xd8d2c0, 0x6d7177], speed: [13, 21], n: 60 },
    bus: { geo: vehicleGeo([[11, 2.6, 2.5, 0, 1.75, 0, 1], [10.6, 0.9, 2.56, 0, 2.3, 0, 0.15], [0.1, 1.3, 2.2, 5.5, 2.0, 0, 0.15]], { wheels: [[3.8, 1.15, 0.5], [3.8, -1.15, 0.5], [-3.6, 1.15, 0.5], [-3.6, -1.15, 0.5]], round: 0.12 }),
      colors: [0xd23a2a, 0x2e7d4f, 0xe0b11c], speed: [11, 15], n: 6 },
    tractor: { geo: vehicleGeo([[2.6, 0.9, 1.1, 0.4, 1.15, 0, 1], [1.0, 1.1, 1.1, -0.7, 2.1, 0, 0.2], [3.4, 1.0, 2.0, -3.6, 1.0, 0, 0.75]],
      { wheels: [[-0.8, 0.85, 0.75], [-0.8, -0.85, 0.75], [1.3, 0.7, 0.42], [1.3, -0.7, 0.42], [-3.6, 1.05, 0.38], [-3.6, -1.05, 0.38]] }), colors: [0xb3201b, 0x2f6b2f, 0x2a5aa0], speed: [4, 6], n: 10 },
  };
  // lanes: every road polyline long enough to drive, with its cumulative length
  const lanes = D.roads.map((r) => { const pts = []; for (let i = 1; i < r.length; i += 2) pts.push([r[i], r[i + 1]]);
    const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    return { w: r[0], pts, cum, L: cum.at(-1) }; }).filter((l) => l.L > 150);
  const main = lanes.filter((l) => l.w >= 8), minor = lanes.filter((l) => l.w < 8);
  for (const [kind, K] of Object.entries(KINDS)) {
    if (LITE) K.n = Math.ceil(K.n / 2);
    const im = new THREE.InstancedMesh(K.geo, std, K.n); im.userData.dynamic = true; im.userData.noCast = true; im.frustumCulled = false;
    for (let i = 0; i < K.n; i++) {
      const pool = kind === 'tractor' ? minor : kind === 'bus' ? main : (rnd() < 0.6 ? main : lanes), lane = pool[(rnd() * pool.length) | 0];
      im.setColorAt(i, col.setHex(K.colors[(rnd() * K.colors.length) | 0]).multiplyScalar(0.85 + rnd() * 0.2));
      COUNTRY.vehicles.push({ im, i, lane, s: rnd() * lane.L, dir: rnd() < 0.5 ? 1 : -1, v: K.speed[0] + rnd() * (K.speed[1] - K.speed[0]) });
    }
    city.add(im);
  }
  // birds: a V of two wings, flapped by flipping the instance's vertical scale
  const bird = new THREE.BufferGeometry();
  bird.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, -0.25, 0.25, 0.9, 0.25, 0, 0,  0, 0, 0, 0.25, 0, 0, -0.25, 0.25, -0.9], 3)); bird.computeVertexNormals();
  const birds = new THREE.InstancedMesh(bird, new THREE.MeshBasicMaterial({ color: 0x2a2a2a, side: THREE.DoubleSide }), 60);
  birds.userData.dynamic = true; birds.userData.noCast = true; birds.frustumCulled = false; city.add(birds);
  [[-900, 620, 35, 140], [600, -1050, 55, 220], [660, 980, 70, 260], [-1500, -700, 45, 180]].forEach(([cx, cz, alt, R], f) => {
    for (let k = 0; k < 15; k++) COUNTRY.flocks.push({ im: birds, i: f * 15 + k, cx, cz, alt: alt + rnd() * 18, R: R * (0.6 + rnd() * 0.5), w: (0.05 + rnd() * 0.04) * (f % 2 ? 1 : -1), ph: rnd() * 6.28, flap: 6 + rnd() * 4 });
  });
  // cattle: a body, head, legs; white, grey and brown, grazing in loose herds near the villages and the lake
  // a zebu: deep body, the hump over the shoulders, dewlap, a lowered grazing head with short horns, thin legs, tail
  const cow = vehicleGeo([[1.9, 0.8, 0.72, 0, 1.2, 0, 1], [1.5, 0.25, 0.6, -0.05, 0.75, 0, 0.92], [0.42, 0.38, 0.44, 0.55, 1.72, 0, 1], [0.35, 0.55, 0.22, 0.85, 1.0, 0, 0.95],
    [0.5, 0.42, 0.34, 1.22, 0.85, 0, 1], [0.32, 0.22, 0.26, 1.48, 0.62, 0, 0.75], [0.07, 0.25, 0.07, 1.12, 1.15, 0.12, 0.35], [0.07, 0.25, 0.07, 1.12, 1.15, -0.12, 0.35],
    [0.07, 0.75, 0.07, -0.98, 0.95, 0, 0.8],
    ...[[-0.72, -0.22], [-0.72, 0.22], [0.66, -0.22], [0.66, 0.22]].map(([x, z]) => [0.13, 0.82, 0.13, x, 0.41, z, 0.85])]);
  const herds = [[-1300, 700], [-760, 470], [1650, 560], [-430, 1550], [-820, -1150], [980, -1060], [2200, -420], [200, 1450]];
  const cows = new THREE.InstancedMesh(cow, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), herds.length * 7);
  herds.forEach(([hx, hz], h) => { for (let k = 0; k < 7; k++) {
    d.position.set(hx + (rnd() - 0.5) * 70, 0, hz + (rnd() - 0.5) * 50); d.rotation.set(0, rnd() * 6.28, 0); d.scale.setScalar(0.9 + rnd() * 0.25); d.updateMatrix();
    cows.setMatrixAt(h * 7 + k, d.matrix); cows.setColorAt(h * 7 + k, col.setHex([0xeeeae0, 0xbdb6aa, 0x8a6a4a, 0x5a4434][(rnd() * 4) | 0]));
  } });
  cows.userData.dynamic = true; cows.userData.noCast = true; cows.computeBoundingSphere(); city.add(cows);
  // a herdsman or farmer by each herd: kurta, dhoti, a turban
  const man = vehicleGeo([[0.22, 0.85, 0.36, 0, 0.43, 0, 0.95], [0.3, 0.7, 0.44, 0, 1.2, 0, 1], [0.08, 0.6, 0.08, 0, 1.15, 0.27, 0.95], [0.08, 0.6, 0.08, 0, 1.15, -0.27, 0.95],
    [0.2, 0.22, 0.2, 0, 1.68, 0, 0.42], [0.26, 0.12, 0.26, 0, 1.84, 0, 0.7], [0.03, 1.7, 0.03, 0.25, 0.9, 0.3, 0.3]]);
  const men = new THREE.InstancedMesh(man, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), herds.length * 2);
  herds.forEach(([hx, hz], h) => { for (let k = 0; k < 2; k++) {
    d.position.set(hx + (rnd() - 0.5) * 60, 0, hz + (rnd() - 0.5) * 50); d.rotation.set(0, rnd() * 6.28, 0); d.scale.setScalar(1); d.updateMatrix();
    men.setMatrixAt(h * 2 + k, d.matrix); men.setColorAt(h * 2 + k, col.setHex([0xf2efe6, 0xe8dcc0, 0xbfd3e6, 0xe3c46a][(rnd() * 4) | 0]));
  } });
  men.userData.dynamic = true; men.userData.noCast = true; men.computeBoundingSphere(); city.add(men);
  COUNTRY.ready = true;
}
/** a flat strip along a polyline (water, ballast, embankment), y up */
function stripGeo(pts, w, y) {
  const pos = [], idx = [];
  pts.forEach(([x, z], i) => { const a = pts[Math.max(0, i - 1)], c = pts[Math.min(pts.length - 1, i + 1)]; let tx = c[0] - a[0], tz = c[1] - a[1]; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
    pos.push(x - tz * w / 2, y, z + tx * w / 2, x + tz * w / 2, y, z - tx * w / 2); if (i) { const v = i * 2 - 2; idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); } });
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  if (g.attributes.normal.getY(0) < 0) { g.setIndex(idx.map((v, k) => idx[k - (k % 3) + [0, 2, 1][k % 3]])); g.computeVertexNormals(); }
  return g;
}
/** where two polylines cross: [x, z, heading of a] */
function crossings(a, b) {
  const out = [];
  for (let i = 1; i < a.length; i++) for (let j = 1; j < b.length; j++) {
    const [p0x, p0z] = a[i - 1], [p1x, p1z] = a[i], [q0x, q0z] = b[j - 1], [q1x, q1z] = b[j];
    const rx = p1x - p0x, rz = p1z - p0z, sx = q1x - q0x, sz = q1z - q0z, den = rx * sz - rz * sx; if (Math.abs(den) < 1e-6) continue;
    const t = ((q0x - p0x) * sz - (q0z - p0z) * sx) / den, u = ((q0x - p0x) * rz - (q0z - p0z) * rx) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) out.push([p0x + rx * t, p0z + rz * t, Math.atan2(-rz, rx), Math.atan2(-sz, sx)]);
  }
  return out;
}
const RAIL = { pts: [], cum: [], train: null, s: 0, dir: 1, v: 0, wait: 0, crossings: [], station: 0 };
function buildCountryDetail(city, D) {
  const rnd = mulberry32(91), g = new THREE.Group(), o = { cast: true, receive: true };
  const std = (c, r = 0.85, m = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
  const water = new THREE.MeshStandardMaterial({ color: 0x587b84, roughness: 0.25, polygonOffset: true, polygonOffsetFactor: -0.6 });
  const earth = std(0x8a7a5c, 0.95), concrete = std(0xcfc9bd), white = std(0xeeebe4, 0.8), steel = std(0x7d838a, 0.5, 0.6), dark = std(0x2b2d31, 0.8);
  const roads = D.roads.map((r) => { const q = []; for (let i = 1; i < r.length; i += 2) q.push([r[i], r[i + 1]]); return { w: r[0], q }; });
  // the canal: water between earth banks, a bridge at every road over it
  for (const c of D.canals ?? []) {
    const q = []; for (let i = 1; i < c.length; i += 2) q.push([c[i], c[i + 1]]);
    const bank = new THREE.Mesh(stripGeo(q, c[0] + 8, 0.035), earth); bank.receiveShadow = true; city.add(bank);
    const wm = new THREE.Mesh(stripGeo(q, c[0], 0.07), water); wm.receiveShadow = true; city.add(wm);
    for (const r of roads) for (const [x, z, , rh] of crossings(q, r.q)) {
      const bw = r.w + 2.5, bl = c[0] + 14, br = new THREE.Group();
      box(bl, 0.5, bw, concrete, 0, 0.55, 0, br, o);                                   // the deck, ramped by its ends
      for (const s of [-1, 1]) { box(bl, 0.9, 0.35, white, 0, 1.25, s * (bw / 2 - 0.2), br, o); for (let k = -2; k <= 2; k++) box(0.5, 0.6, 0.5, concrete, k * (bl / 5), 1.95, s * (bw / 2 - 0.2), br, o); }
      const deck = new THREE.MeshStandardMaterial({ map: repeatOf(T.asphalt, bl / 10, bw / 10), color: 0x8f8f8f, roughness: 0.9 }); ASPHALT.push(deck);
      box(bl, 0.06, bw - 1, deck, 0, 0.83, 0, br, o);
      br.position.set(x, 0, z); br.rotation.y = rh; g.add(br);
    }
  }
  // the railway: ballast, two rails, sleepers near the station; a station; level crossings where roads cross
  if (D.rail?.length) {
    const q = []; for (let i = 0; i < D.rail.length; i += 2) q.push([D.rail[i], D.rail[i + 1]]);
    RAIL.pts = q; RAIL.cum = [0]; for (let i = 1; i < q.length; i++) RAIL.cum.push(RAIL.cum[i - 1] + Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]));
    const ballast = new THREE.Mesh(stripGeo(q, 5.5, 0.09), std(0x6f6a62, 0.95)); ballast.receiveShadow = true; city.add(ballast);
    for (const s of [-0.75, 0.75]) { const off = q.map(([x, z], i) => { const a = q[Math.max(0, i - 1)], c2 = q[Math.min(q.length - 1, i + 1)]; let tx = c2[0] - a[0], tz = c2[1] - a[1]; const L = Math.hypot(tx, tz); return [x - tz / L * s, z + tx / L * s]; });
      city.add(new THREE.Mesh(stripGeo(off, 0.14, 0.22), steel)); }
    const st = D.landmarks?.station;
    if (st) { // a small station: platform, building in railway red and cream, a canopy, the name board
      const sg = new THREE.Group();
      box(140, 0.9, 7, concrete, 0, 0.45, 0, sg, o);
      box(30, 5, 9, std(0xb8452f), 0, 0.9 + 2.5, -8.5, sg, o); box(30.4, 0.6, 9.4, std(0xe9dfc8), 0, 0.9 + 5.2, -8.5, sg, o);
      for (let x = -40; x <= 40; x += 10) cyl(0.18, 0.18, 4, steel, x, 0.9 + 2, 1.8, sg, 8, o);
      box(90, 0.25, 6, std(0x8e2f22), 0, 0.9 + 4.1, 0.5, sg, o);
      const nb = panel(10, 1.4, new THREE.MeshStandardMaterial({ roughness: 0.6, map: canvasTex(512, 72, (c2, w, h) => { c2.fillStyle = '#f4d03f'; c2.fillRect(0, 0, w, h); c2.fillStyle = '#111'; c2.font = FONT(800, 46, 'Arial, sans-serif'); c2.textAlign = 'center'; c2.textBaseline = 'middle'; c2.fillText('MANDI JUNCTION', w / 2, h / 2 + 2); }) }), 20, 2.6, 3.4, '+z', sg, o);
      void nb;
      // its position along the line, and the platform beside it (south side of the track)
      let best = 0, bd = 1e9; for (let i = 1; i < q.length; i++) { const [ax, az] = q[i - 1], [bx, bz] = q[i], L = Math.hypot(bx - ax, bz - az); for (let s = 0; s <= L; s += 5) { const x = ax + (bx - ax) * s / L, z = az + (bz - az) * s / L, dd = Math.hypot(x - st[0], z - st[1]); if (dd < bd) { bd = dd; best = RAIL.cum[i - 1] + s; } } }
      RAIL.station = best;
      sg.position.set(st[0], 0, st[1] - 2); sg.rotation.y = Math.PI; g.add(sg);
    }
    for (const r of roads) for (const [x, z, rh] of crossings(q, r.q)) { // level crossings: booms each side, lights
      const lc = new THREE.Group(), booms = [];
      for (const s of [-1, 1]) {
        const post = new THREE.Group(); post.position.set(s * 6.5, 0, s * (r.w / 2 + 1.2)); lc.add(post);
        box(0.35, 1.3, 0.35, white, 0, 0.65, 0, post, o);
        const pivot = new THREE.Group(); pivot.position.set(0, 1.15, 0); post.add(pivot);
        const boom = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, r.w + 1), new THREE.MeshStandardMaterial({ roughness: 0.6, map: canvasTex(64, 8, (c2, w) => { for (let i = 0; i < 8; i++) { c2.fillStyle = i % 2 ? '#ffffff' : '#d0211c'; c2.fillRect(i * w / 8, 0, w / 8, 8); } }) }));
        boom.position.set(0, 0, -s * (r.w + 1) / 2); pivot.add(boom); booms.push({ pivot, s });
      }
      lc.position.set(x, 0, z); lc.rotation.y = rh; city.add(lc);
      let at = 0, bd = 1e9; for (let i = 1; i < q.length; i++) { const [ax, az] = q[i - 1], [bx, bz] = q[i], L = Math.hypot(bx - ax, bz - az); const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / (L * L))); const dd = Math.hypot(x - ax - (bx - ax) * t, z - az - (bz - az) * t); if (dd < bd) { bd = dd; at = RAIL.cum[i - 1] + t * L; } }
      RAIL.crossings.push({ at, booms });
    }
    // the train: a diesel locomotive and nine coaches, in blue and cream
    // coaches: body, a band of windows framed by pillars, the cream roof, doors at the ends, bogies under
    const pillars = []; for (let i = 0; i < 13; i++) for (const s of [-1, 1]) pillars.push([0.18, 0.78, 0.06, -8.4 + i * 1.4, 3.05, s * 1.56, 1]);
    const coach = vehicleGeo([[21, 3.4, 3.1, 0, 2.6, 0, 1], [18.4, 0.72, 3.14, 0, 3.05, 0, 0.12], ...pillars, [21.2, 0.35, 3.2, 0, 4.45, 0, 0.85],
      ...[-9.6, 9.6].flatMap((x) => [[0.9, 2.2, 3.16, x, 2.3, 0, 0.6]]), ...[-7, 7].flatMap((x) => [[2.6, 0.7, 2.6, x, 0.55, 0, 0.1]])], { round: 0.05 });
    const loco = vehicleGeo([[19, 3.6, 3.1, 0, 2.7, 0, 1], [3.2, 1.2, 3.12, 7.5, 3.5, 0, 0.15], [19.4, 0.5, 3.2, 0, 4.7, 0, 0.6], [0.2, 0.9, 2.6, 9.55, 2.1, 0, 0.9],
      ...[-6, 6].flatMap((x) => [[3, 0.75, 2.6, x, 0.55, 0, 0.1]])], { round: 0.05 });
    const tm = new THREE.InstancedMesh(coach, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.2 }), 9);
    const col = new THREE.Color(); for (let i = 0; i < 9; i++) tm.setColorAt(i, col.setHex(i === 4 ? 0x8e2f22 : 0x2d5aa6));
    const lm = new THREE.Mesh(loco, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.2, color: 0xc9462b }));
    for (const m of [tm, lm]) { m.frustumCulled = false; m.userData.dynamic = true; city.add(m); }
    RAIL.train = { tm, lm }; RAIL.s = 400; RAIL.dir = 1; RAIL.v = 24;
  }
  // power line: lattice pylons on the route and every ~250 m, three sagging conductors; the substation by the field
  if (D.power?.length) {
    const q = []; for (let i = 0; i < D.power.length; i += 2) q.push([D.power[i], D.power[i + 1]]);
    const spots = []; for (let i = 1; i < q.length; i++) { const [ax, az] = q[i - 1], [bx, bz] = q[i], L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(L / 250)); for (let k = i === 1 ? 0 : 1; k <= n; k++) spots.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n, Math.atan2(-(bz - az), bx - ax)]); }
    const pyl = new THREE.Group();
    for (const s of [-1, 1]) for (const t2 of [-1, 1]) { const leg = box(0.3, 26, 0.3, steel, s * 1.6, 13, t2 * 1.6, pyl, o); leg.rotation.set(t2 * -0.07, 0, s * 0.07); }
    for (const y of [6, 12, 18]) box(2.6, 0.2, 2.6, steel, 0, y, 0, pyl, o);
    box(0.25, 0.25, 12, steel, 0, 20, 0, pyl, o); box(0.25, 0.25, 8, steel, 0, 24, 0, pyl, o);
    const pg = bakeGroup(pyl), wires = [];
    for (const [x, z, a] of spots) { const c2 = pg.clone(); c2.position.set(x, 0, z); c2.rotation.y = a; g.add(c2); } // cross-arms square to the line
    for (let i = 1; i < spots.length; i++) for (const [off, y] of [[-6, 19.6], [6, 19.6], [0, 23.6]]) {
      const [ax, az, aa] = spots[i - 1], [bx, bz, ba] = spots[i];
      const P = [];
      for (let k = 0; k <= 12; k++) { const t = k / 12, nx = Math.sin(aa) * off * (1 - t) + Math.sin(ba) * off * t, nz = Math.cos(aa) * off * (1 - t) + Math.cos(ba) * off * t;
        P.push(ax + (bx - ax) * t + nx, y - 4 * Math.sin(Math.PI * t), az + (bz - az) * t + nz); }
      wires.push(...P.slice(0, -3).flatMap((v, k) => k % 3 === 0 ? [P[k], P[k + 1], P[k + 2], P[k + 3], P[k + 4], P[k + 5]] : []));
    }
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
    city.add(new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x3a3d42 })));
    const ss = D.landmarks?.substation;
    if (ss) { const sb = new THREE.Group(); box(40, 0.3, 30, concrete, 0, 0.15, 0, sb, o); for (const [x, z] of [[-10, -6], [0, -6], [10, -6], [-10, 6], [0, 6]]) { box(3.5, 3.5, 2.6, std(0x5d6a5a, 0.6, 0.3), x, 2, z, sb, o); cyl(0.3, 0.3, 2, white, x, 4.6, z, sb, 8, o); } box(14, 3.5, 8, concrete, 12, 1.75, 8, sb, o); sb.position.set(ss[0], 0, ss[1]); g.add(sb); }
  }
  // the temple in the town square: a plinth, the sanctum, a curved shikhara with its kalash and flag
  const L = D.landmarks ?? {};
  if (L.temple) {
    const tg = new THREE.Group(), saff = std(0xe39b3a, 0.7), cream = std(0xf0e2c4, 0.75);
    box(22, 1.6, 22, cream, 0, 0.8, 0, tg, o); box(10, 7, 10, cream, 0, 1.6 + 3.5, 0, tg, o); box(8, 4, 5, saff, 0, 1.6 + 2, 7.5, tg, o);
    const prof = []; for (let i = 0; i <= 12; i++) { const t = i / 12; prof.push(new THREE.Vector2(Math.max(0.05, 5.2 * Math.pow(1 - t, 0.75)), t * 16)); }
    const sh = new THREE.Mesh(new THREE.LatheGeometry(prof, 8), saff); sh.position.set(0, 8.6, 0); tg.add(sh);
    cyl(0.9, 0.3, 1.6, std(0xd4a017, 0.3, 0.8), 0, 25.4, 0, tg, 10, o); cyl(0.06, 0.06, 4, steel, 0, 27, 0, tg, 6, o);
    const flag = panel(2.2, 1.3, new THREE.MeshStandardMaterial({ color: 0xff7a1a, side: THREE.DoubleSide, roughness: 0.8 }), 1.1, 28.2, 0, '+z', tg, { cast: false, receive: false });
    flag.userData.keep = true; flag.onBeforeRender = () => { flag.rotation.y = Math.sin(NOW / 500) * 0.25; flag.updateMatrixWorld(); };
    tg.position.set(L.temple[0], 0, L.temple[1]); g.add(tg);
  }
  if (L.waterTower) { const wt = new THREE.Group(); for (const [x, z] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) box(0.6, 18, 0.6, concrete, x, 9, z, wt, o); cyl(1, 1, 18, concrete, 0, 9, 0, wt, 10, o); cyl(7.5, 6, 6, concrete, 0, 21, 0, wt, 20, o); cyl(7.6, 7.6, 0.6, white, 0, 24.3, 0, wt, 20, o); wt.position.set(L.waterTower[0], 0, L.waterTower[1]); g.add(wt); }
  if (L.kiln) { // a brick kiln: the oval of the firing trench, stacks of bricks, the tall chimney, smoke
    const kg = new THREE.Group(), brick = std(0x9a4a32, 0.95);
    box(90, 2.5, 40, std(0x7c5a44), 0, 1.25, 0, kg, o); for (let i = 0; i < 14; i++) box(4, 1.6, 3, brick, -55 + (i % 7) * 5, 0.8, 26 + Math.floor(i / 7) * 5, kg, o);
    cyl(1.4, 2.6, 34, brick, 0, 17, 0, kg, 14, o);
    kg.position.set(L.kiln[0], 0, L.kiln[1]); g.add(kg);
    const puff = canvasTex(64, 64, (c2, w, h) => { const gr = c2.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); gr.addColorStop(0, 'rgba(120,115,110,0.55)'); gr.addColorStop(1, 'rgba(120,115,110,0)'); c2.fillStyle = gr; c2.fillRect(0, 0, w, h); });
    COUNTRY.smoke = []; for (let i = 0; i < 14; i++) { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: puff, depthWrite: false, transparent: true })); sp.userData.dynamic = true; city.add(sp); COUNTRY.smoke.push({ sp, ph: i / 14, base: [L.kiln[0], 34, L.kiln[1]] }); }
  }
  // farmhouses: a low house in a walled yard, haystacks, a neem by the gate
  const hay = std(0xc9a55a, 0.95), wall = std(0xd9cdb0, 0.9), roof = std(0x8c5a3c, 0.85);
  for (const [x, z, a] of D.farms ?? []) {
    if (nearCanalPt(D, x, z)) continue;
    const f = new THREE.Group();
    box(11, 3.6, 7, wall, -3, 1.8, -4, f, o); box(11.4, 0.4, 7.4, roof, -3, 3.8, -4, f, o);
    for (const [w, d, x2, z2] of [[22, 0.4, 0, -10], [22, 0.4, 0, 10], [0.4, 20, -11, 0], [0.4, 8, 11, -6], [0.4, 8, 11, 6]]) box(w || 0.4, 1.8, d, wall, x2, 0.9, z2, f, o);
    for (let k = 0; k < 2 + ((rnd() * 2) | 0); k++) { const hx = 16 + k * 5, hz = -6 + rnd() * 12; cyl(2, 2.2, 2.5, hay, hx, 1.25, hz, f, 12, o); const cone = mesh(new THREE.ConeGeometry(2.1, 2.2, 12), hay, hx, 3.6, hz, f, o); void cone; }
    f.position.set(x, 0, z); f.rotation.y = a; g.add(f);
  }
  const kb = bakeGroup(g); kb.userData.dynamic = true; kb.userData.noCast = true; city.add(kb);
  buildMist(city);
  // street lamps along the main roads, lit at dusk
  const lamps = [];
  for (const r of roads) if (r.w >= 8) for (let i = 1; i < r.q.length; i++) { const [ax, az] = r.q[i - 1], [bx, bz] = r.q[i], L = Math.hypot(bx - ax, bz - az), nx = -(bz - az) / L, nz = (bx - ax) / L;
    for (let s = 0; s < L; s += 45) { const sd = (Math.floor(s / 45) % 2) ? 1 : -1; lamps.push([ax + (bx - ax) * s / L + nx * sd * (r.w / 2 + 1.5), 7.5, az + (bz - az) * s / L + nz * sd * (r.w / 2 + 1.5)]); } }
  nightPoints(lamps, 0xffc879, 9, city);
  // headlights and tail lights, moved with the traffic; the train's windows and headlamp
  COUNTRY.heads = nightPoints(new Array(COUNTRY.vehicles.length * 2).fill([0, -100, 0]), 0xfff1d0, 5, city);
  COUNTRY.tails = nightPoints(new Array(COUNTRY.vehicles.length).fill([0, -100, 0]), 0xff2a1a, 3, city);
  if (RAIL.train) {
    const strip = new THREE.InstancedMesh(new THREE.BoxGeometry(19.6, 0.75, 3.18).translate(0, 3.0, 0), new THREE.MeshBasicMaterial({ color: 0xffc46a }), 9);
    strip.frustumCulled = false; strip.visible = false; strip.userData.dynamic = true; city.add(strip); NIGHT_POINTS.push(strip); RAIL.train.strip = strip;
    RAIL.train.head = nightPoints([[0, -100, 0]], 0xfff4d6, 14, city);
  }
  // dust: puffs kicked up behind the tractors and the train
  const dustTex = canvasTex(64, 64, (c2, w, h) => { const gr = c2.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); gr.addColorStop(0, 'rgba(176,150,112,0.5)'); gr.addColorStop(1, 'rgba(176,150,112,0)'); c2.fillStyle = gr; c2.fillRect(0, 0, w, h); });
  COUNTRY.dust = []; for (let i = 0; i < 60; i++) { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dustTex, depthWrite: false, transparent: true, opacity: 0 })); sp.visible = false; sp.userData.dynamic = true; city.add(sp); COUNTRY.dust.push({ sp, age: 9 }); }
  COUNTRY.dustAt = 0;
}
/** light sprites that only show at dusk (street lamps, headlights) */
const NIGHT_POINTS = [];
function nightPoints(positions, color, size, parent) {
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(positions.flat(), 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color, size, map: GLOW, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  pts.frustumCulled = false; pts.visible = NIGHT.value > 0.5; pts.userData.dynamic = true; parent.add(pts); NIGHT_POINTS.push(pts);
  return pts;
}
/** Morning mist: two soft layers a few metres up, thick over the fields, the lake and the canal, thin over the
 *  airfield, drifting on the breeze and burning off over the first minute and a half to a light haze */
const MIST = { mat: null, t0: 0 };
function buildMist(city) {
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uT: CLOUD_T, uCol: { value: new THREE.Color(0xdfe5ea) }, uDens: { value: 0.75 }, uField: { value: new THREE.Vector4(-1980, -620, 1120, -12) } },
    vertexShader: `varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform float uT, uDens; uniform vec3 uCol; uniform vec4 uField; varying vec3 vW;` + WEAR_GLSL + `
      void main() {
        vec2 p = vW.xz;
        float n = wf(p * 0.0035 + vec2(uT * 0.004, uT * 0.0015) + vW.y * 0.37);
        float a = smoothstep(0.42, 0.78, n) * uDens;
        float inField = step(uField.x, p.x) * step(p.x, uField.z) * step(uField.y, p.y) * step(p.y, uField.w);
        a *= 1.0 - inField * 0.75;
        float d = distance(cameraPosition, vW);
        a *= smoothstep(20.0, 220.0, d) * (1.0 - smoothstep(5000.0, 9000.0, d));
        gl_FragColor = vec4(uCol, a * 0.55);
      }`,
  });
  for (const y of [3, 7]) { const m = new THREE.Mesh(new THREE.PlaneGeometry(14000, 14000).rotateX(-Math.PI / 2), mat); m.position.set(-200, y, 0); m.renderOrder = 5; m.userData.dynamic = true; m.userData.noCast = true; m.frustumCulled = false; city.add(m); if (LITE) break; }
  MIST.mat = mat; MIST.t0 = performance.now();
}
function nearCanalPt(D, x, z) { for (const c of D.canals ?? []) for (let i = 3; i < c.length; i += 2) { const ax = c[i - 2], az = c[i - 1], bx = c[i], bz = c[i + 1], dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz))); if (Math.hypot(x - ax - dx * t, z - az - dz * t) < c[0] / 2 + 35) return true; } return false; }
function railAt(s, out) { // position and heading at distance s along the line
  const R = RAIL, cum = R.cum; s = Math.max(0, Math.min(cum.at(-1), s));
  let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
  const [ax, az] = R.pts[i - 1], [bx, bz] = R.pts[i], u = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
  out.position.set(ax + (bx - ax) * u, 0.2, az + (bz - az) * u); out.rotation.set(0, Math.atan2(-(bz - az), bx - ax), 0); out.scale.setScalar(1); out.updateMatrix();
  return out;
}
function updateRail(t, dts) {
  const R = RAIL; if (!R.train) return;
  const end = R.cum.at(-1), toStation = (R.station - R.s) * R.dir;
  if (R.wait > 0) { R.wait -= dts; if (R.wait <= 0 && (R.s <= 50 || R.s >= end - 50)) R.dir *= -1; }
  else {
    let vt = 24;
    if (toStation > 0 && toStation < 420) vt = Math.max(1.5, 24 * Math.sqrt(toStation / 420));
    const toEnd = R.dir > 0 ? end - R.s : R.s; if (toEnd < 400) vt = Math.min(vt, Math.max(1.5, 24 * Math.sqrt(toEnd / 400)));
    R.v += Math.max(-2, Math.min(0.6, vt - R.v)) * dts * 2;
    const prev = R.s; R.s += R.dir * R.v * dts;
    if (toStation > 0 && (R.station - R.s) * R.dir <= 0) { R.s = R.station; R.v = 0; R.wait = 25; }
    if (R.s >= end - 30 || R.s <= 30) { R.s = Math.max(30, Math.min(end - 30, R.s)); R.v = 0; R.wait = 40; }
    void prev;
  }
  // the loco leads: cars trail behind it along the line, 21.6 m apart
  railAt(R.s, _cq); if (R.dir < 0) _cq.rotation.y += Math.PI, _cq.updateMatrix(); R.train.lm.matrix.copy(_cq.matrix); R.train.lm.matrixAutoUpdate = false;
  for (let i = 0; i < 9; i++) { railAt(R.s - R.dir * (20.6 + i * 21.8), _cq); R.train.tm.setMatrixAt(i, _cq.matrix); }
  R.train.tm.instanceMatrix.needsUpdate = true;
  // the booms come down while any part of the train is within 450 m of a crossing
  for (const c of R.crossings) { const d = (c.at - R.s) * R.dir, near = d > -230 && d < 450; c.k = (c.k ?? 0) + ((near ? 1 : 0) - (c.k ?? 0)) * Math.min(1, dts * 1.5);
    for (const b of c.booms) b.pivot.rotation.x = b.s * (1 - c.k) * 1.45; }
}
const _cq = new THREE.Object3D(), _m4 = new THREE.Matrix4(), _v3 = new THREE.Vector3();
function updateCountryLife(now, dt) {
  if (!COUNTRY.ready) return;
  const t = now / 1000, dts = Math.min(0.1, dt / 1000), touched = new Set();
  for (const v of COUNTRY.vehicles) {
    const l = v.lane;
    v.s += v.dir * v.v * dts;
    if (v.s > l.L) { v.s = l.L; v.dir = -1; } else if (v.s < 0) { v.s = 0; v.dir = 1; }  // the end of the road: turn round
    let i = 1; while (i < l.cum.length - 1 && l.cum[i] < v.s) i++;
    const [x0, z0] = l.pts[i - 1], [x1, z1] = l.pts[i], seg = (l.cum[i] - l.cum[i - 1]) || 1, u = (v.s - l.cum[i - 1]) / seg;
    let dx = (x1 - x0) / seg * v.dir, dz = (z1 - z0) / seg * v.dir;
    const off = l.w / 4;                                                                  // keep left
    _cq.position.set(x0 + (x1 - x0) * u + dz * off, 0.06, z0 + (z1 - z0) * u - dx * off);
    _cq.rotation.set(0, Math.atan2(-dz, dx), 0); _cq.scale.setScalar(1); _cq.updateMatrix();
    v.im.setMatrixAt(v.i, _cq.matrix); touched.add(v.im);
  }
  for (const b of COUNTRY.flocks) {
    const a = b.ph + t * b.w, wob = Math.sin(t * 0.7 + b.ph * 3) * 0.18;
    _cq.position.set(b.cx + Math.cos(a) * b.R * (1 + wob), b.alt + Math.sin(t * 0.5 + b.ph) * 6, b.cz + Math.sin(a) * b.R * (1 - wob));
    const sg = Math.sign(b.w); _cq.rotation.set(0, Math.atan2(-Math.cos(a) * sg, -Math.sin(a) * sg), 0); // nose along the orbit
    _cq.scale.set(2.6, 2.6 * Math.sin(t * b.flap + b.ph), 2.6); _cq.updateMatrix();
    b.im.setMatrixAt(b.i, _cq.matrix); touched.add(b.im);
  }
  for (const im of touched) im.instanceMatrix.needsUpdate = true;
  updateRail(t, dts);
  if (MIST.mat) MIST.mat.uniforms.uDens.value = (TOD.kind === 'dusk' ? 0.9 : 0.32 + 0.43 * Math.max(0, 1 - (now - MIST.t0) / 90000));
  if (NIGHT.value > 0.5 && COUNTRY.heads) { // lights follow the traffic
    const hp = COUNTRY.heads.geometry.attributes.position, tp = COUNTRY.tails.geometry.attributes.position, m4 = new THREE.Matrix4(), v3 = new THREE.Vector3();
    COUNTRY.vehicles.forEach((v, i) => { v.im.getMatrixAt(v.i, m4);
      v3.set(2.2, 0.7, 0.6).applyMatrix4(m4); hp.setXYZ(i * 2, v3.x, v3.y, v3.z); v3.set(2.2, 0.7, -0.6).applyMatrix4(m4); hp.setXYZ(i * 2 + 1, v3.x, v3.y, v3.z);
      v3.set(-2.2, 0.7, 0).applyMatrix4(m4); tp.setXYZ(i, v3.x, v3.y, v3.z); });
    hp.needsUpdate = tp.needsUpdate = true;
  }
  const T2 = RAIL.train;
  if (T2?.strip && T2.strip.visible) { for (let i = 0; i < 9; i++) { T2.tm.getMatrixAt(i, _m4); T2.strip.setMatrixAt(i, _m4); } T2.strip.instanceMatrix.needsUpdate = true;
    _v3.set(10, 2.6, 0).applyMatrix4(T2.lm.matrix); T2.head.geometry.attributes.position.setXYZ(0, _v3.x, _v3.y, _v3.z); T2.head.geometry.attributes.position.needsUpdate = true; }
  if (COUNTRY.dust && t > COUNTRY.dustAt) { // puffs behind the tractors, and the last coach when the train is quick
    COUNTRY.dustAt = t + 0.35;
    const src = COUNTRY.vehicles.filter((v) => v.v < 7).map((v) => { v.im.getMatrixAt(v.i, _m4); return _v3.set(-4.5, 0.8, 0).applyMatrix4(_m4).clone(); });
    if (T2 && RAIL.v > 12) { T2.tm.getMatrixAt(8, _m4); src.push(_v3.set(-11, 0.8, 0).applyMatrix4(_m4).clone()); }
    for (const s of src) { const d2 = COUNTRY.dust.find((q) => q.age > 4); if (!d2) break; d2.age = 0; d2.sp.position.copy(s); d2.sp.visible = true; }
  }
  for (const d2 of COUNTRY.dust ?? []) if (d2.age <= 4) { d2.age += dts; const k = d2.age / 4; d2.sp.scale.setScalar(1.5 + k * 6); d2.sp.position.y += dts * 0.6; d2.sp.material.opacity = 0.5 * (1 - k); if (k >= 1) d2.sp.visible = false; }
  for (const s of COUNTRY.smoke ?? []) { const k = (t * 0.05 + s.ph) % 1; s.sp.position.set(s.base[0] + k * 40, s.base[1] + k * 45, s.base[2] - k * 15); s.sp.scale.setScalar(4 + k * 22); s.sp.material.opacity = 0.75 * (1 - k); }
}
/** per frame: pin scale and visibility, the route's fade, the Live View card */
const _v = new THREE.Vector3();
function updateAerial(pAll) {
  if (!AERO.ready) return;
  const t = clamp01(pAll / AERO.split), dPin = camera.position.distanceTo(AERO.pin.position);
  AERO.pin.scale.setScalar(THREE.MathUtils.clamp(dPin / 48, 0.6, 30)); // a steady size on screen
  AERO.pin.position.y = 15 + Math.sin(NOW / 600) * 0.4 * (1 - t);
  AERO.pin.rotation.y = Math.atan2(camera.position.x - AERO.pin.position.x, camera.position.z - AERO.pin.position.z);
  AERO.pin.visible = camera.position.z > 8 && dPin > 90; // gone once you are at the gate
  if (AERO.line) AERO.line.material.opacity = 0.92 * (1 - range(camera.position.y, 70, 30)); // the route reads from the air, then gets out of the way
  if (AERO.chevMat) { // the chevrons come up as the camera descends, pulse, and go once you are at the gate
    const on = range(t, 0.45, 0.7) * (1 - range(pAll, AERO.split + 0.01, AERO.split + 0.05));
    AERO.chevMat.opacity = on * (0.7 + 0.3 * Math.sin(NOW / 260));
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
    via: [[0, 1.62, -12.0], [0, 1.62, -14.3], [0, 1.64, -18.5], [0, 1.66, -22.6], [0.6, 1.7, -24.8], [2.3, 1.8, -26.4], [4.5, 3.4, -27.0], [9.5, 7.0, -27.0], [12.8, 9.55, -27.1], [14.6, 9.7, -27.6], [15.8, 11, -40]],
    // then lift off the deck and rise east to a vantage point 75 m over the airfield, looking west down the runway:
    // the hangar row and the campus on the left, traffic on K and the runway on the right, arrivals passing below
    flight: [[60, 32, -40], [260, 60, -70], [520, 72, -130]],
    pos: [720, 75, -175], look: [-260, 0, -250],
    // once there, a few more places to look from (the first is where the flight ends)
    views: [
      { label: 'Down the runway', pos: [720, 75, -175], look: [-260, 0, -250] },
      { label: 'Final approach', pos: [1290, 46, -262], look: [560, 10, -322] },
      { label: 'Hangar row', pos: [-330, 26, -200], look: [-610, 9, -55] },
      ...(FIELD !== 'delhi' ? [{ label: 'Control tower', pos: [-812, 33.6, -44], look: [-620, 0, -470] }, { label: 'Flying club', pos: [-1478, 6.4, -40], look: [-1380, 1, -150] },
        { label: 'Ride a trainer', follow: 'trainer' }, { label: 'Ride the train', follow: 'train' }] : []),
    ],
    doorLook: [0, 1.6, -40], split: 0.5, dur: 16,
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
  const split = c.flight ? 0.25 : c.split ?? 0.5;
  const endLook = new THREE.Vector3(...c.look);
  const walkPts = [lastWalk.pos.clone(), ...c.via.map((v) => new THREE.Vector3(...v))];
  const curve = new THREE.CatmullRomCurve3([...walkPts, ...(c.flight ?? []).map((v) => new THREE.Vector3(...v)), new THREE.Vector3(...c.pos)], false, 'centripetal');
  // a long flight after the walk: the walk keeps a quarter of the time, the flight gets the rest
  const fw = c.flight ? new THREE.CatmullRomCurve3(walkPts, false, 'centripetal').getLength() / curve.getLength() : 0;
  const along = (t) => (!c.flight ? t : t < split ? fw * (t / split) : fw + (1 - fw) * ((t - split) / (1 - split)));
  const st = { t: 0 };
  const apply = () => {
    curve.getPointAt(Math.min(1, along(st.t)), roomCam.pos);
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
/** fly between the airside viewpoints: up and over in an arc, then settle with the new view */
const VIEW = { at: 0, tween: null };
function flyTo(pos, look, dur = 3.2) {
  return new Promise((done) => {
    const p0 = roomCam.pos.clone(), l0 = roomCam.look.clone(), p1 = new THREE.Vector3(...pos), l1 = new THREE.Vector3(...look);
    const lift = Math.min(160, p0.distanceTo(p1) * 0.18), st = { t: 0 };
    VIEW.tween?.kill();
    VIEW.tween = gsap.to(st, { t: 1, duration: reduceMotion ? 0.3 : dur, ease: 'power2.inOut', onComplete: done, onUpdate: () => {
      roomCam.pos.lerpVectors(p0, p1, st.t); roomCam.pos.y += Math.sin(Math.PI * st.t) * lift;
      roomCam.look.lerpVectors(l0, l1, smooth(clamp01(st.t * 1.25)));
    } });
  });
}
function goToView(c, i) {
  if (mode !== 'room' || i === VIEW.at) return;
  VIEW.at = i;
  card.querySelectorAll('[data-f="views"] button').forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
  const v = c.views[i];
  FOLLOW.kind = v.follow ?? null; FOLLOW.k = 0;
  if (v.follow) { VIEW.tween?.kill(); setCardCollapsed(true); return; }
  flyTo(v.pos, v.look, 2.4 + roomCam.pos.distanceTo(new THREE.Vector3(...v.pos)) / 900);
}
/** Ride-along: a chase camera behind one of the circuit trainers (the one furthest from its touchdown, so the ride
 *  starts in the air), or alongside the train; it eases in from wherever the camera was */
const FOLLOW = { kind: null, k: 0, who: null };
const _fp = new THREE.Vector3(), _ff = new THREE.Vector3(), _fl = new THREE.Vector3(), _fo = new THREE.Object3D();
function updateFollow(dt) {
  const e = 1 - Math.exp(-Math.min(dt, 100) / 1000 * (FOLLOW.k < 1 ? 1.2 : 4)); FOLLOW.k = Math.min(1, FOLLOW.k + Math.min(dt, 100) / 2500);
  if (FOLLOW.kind === 'trainer') {
    if (!FOLLOW.who || !AIRSIDE.circuits.includes(FOLLOW.who)) FOLLOW.who = AIRSIDE.circuits.reduce((a, c2) => (c2.g.position.y > (a?.g.position.y ?? -1) ? c2 : a), null);
    const g = FOLLOW.who?.g; if (!g) return;
    g.getWorldPosition(_fp); _ff.set(1, 0, 0).applyQuaternion(g.quaternion); _ff.y *= 0.3; _ff.normalize();
    _fl.copy(_fp).addScaledVector(_ff, -15); _fl.y += 3.8;
    roomCam.pos.lerp(_fl, e); roomCam.look.lerp(_fl.copy(_fp).addScaledVector(_ff, 40), e);
  } else if (FOLLOW.kind === 'train' && RAIL.train) {
    railAt(RAIL.s, _fo); _fp.copy(_fo.position); _ff.set(Math.cos(_fo.rotation.y), 0, -Math.sin(_fo.rotation.y)).multiplyScalar(RAIL.dir);
    _fl.copy(_fp).addScaledVector(_ff, -40).add(new THREE.Vector3(_ff.z, 0, -_ff.x).multiplyScalar(45)); _fl.y += 22;
    roomCam.pos.lerp(_fl, e); roomCam.look.lerp(_fl.copy(_fp).addScaledVector(_ff, -70).setY(3), e);
  }
}
async function leaveRoom() {
  if ((mode !== 'room' && mode !== 'screen') || !roomTl) return;
  FOLLOW.kind = null; hideTip();
  // from another viewpoint, fly back to where the door's flight ended, then reverse it home
  const c = COURSES[activeRoom];
  if (mode === 'room' && c?.views && VIEW.at !== 0) { hideCard(); mode = 'moving'; VIEW.at = 0; await flyTo(c.pos, c.look, 2.6); mode = 'room'; }
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
  const views = document.getElementById('roomViews');
  views.hidden = !c.views;
  if (c.views) card.querySelector('[data-f="views"]').replaceChildren(...c.views.map((v, i) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: v.label });
    b.setAttribute('aria-pressed', String(i === 0));
    b.addEventListener('click', () => goToView(c, i));
    return b;
  }));
  VIEW.at = 0;
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
/** Hover labels airside: what you are looking at, and what the school teaches about it */
const TIP = Object.assign(document.createElement('div'), { className: 'scene-tip' });
TIP.style.cssText = 'position:fixed;z-index:30;pointer-events:none;padding:8px 12px;border-radius:10px;background:rgba(10,18,44,.88);color:#fff;font:500 13px/1.35 Manrope,system-ui,sans-serif;max-width:260px;box-shadow:0 6px 24px rgba(0,0,0,.3);opacity:0;transition:opacity .15s';
document.body.appendChild(TIP);
function hideTip() { TIP.style.opacity = '0'; }
const PLACES = () => [
  [-805, 31, -34, 'Control tower', 'Air traffic control clears every take-off and landing: you will learn the radio calls in ground school.'],
  [-1490, 5, -30, 'Flying club', 'Where cadets brief, debrief and wait for the weather.'],
  [-1060, 9, -30, 'Terminal', 'Regional airline flights: the career most cadets train for.'],
  [-1390, 7, -30, 'Fire station', 'Airport rescue and fire-fighting cover, on call whenever aircraft fly.'],
  [-1640, 9, -40, 'Fuel farm', 'Avgas for the trainers, Jet A-1 for the airliners.'],
  [-300, 6, -470, 'Weather station', 'Wind, visibility, temperature and pressure: the METAR every pilot reads before flight.'],
  ...HANGARS.map((h) => [h.x, 22, h.zf + 30, 'Maintenance hangar', 'Engineers keep the fleet airworthy: checks, inspections, repairs.']),
  ...AIRSIDE.circuits.map((c) => [c.g.position.x, c.g.position.y + 2, c.g.position.z, 'Cessna 182 · circuit training', 'Take-off, crosswind, downwind, base, final: the first lessons in the air.']),
  ...AIRSIDE.movers.filter((m) => m.g.visible).map((m) => [m.g.position.x, m.g.position.y + 8, m.g.position.z, m.livery?.startsWith('b_') ? 'Boeing 787-9' : 'Airbus A320neo', 'Airline traffic, sharing the runway with the school.']),
];
const _tp = new THREE.Vector3();
function updateTip(x, y) {
  if (activeRoom !== 'C' || mode !== 'room') return hideTip();
  let best = null, bd = 46;
  for (const p of PLACES()) { _tp.set(p[0], p[1], p[2]).project(camera); if (_tp.z > 1) continue; const sx = (_tp.x + 1) / 2 * innerWidth, sy = (1 - _tp.y) / 2 * innerHeight, d = Math.hypot(sx - x, sy - y); if (d < bd) { bd = d; best = p; } }
  if (!best) return hideTip();
  TIP.innerHTML = `<strong style="display:block;margin-bottom:2px">${best[3]}</strong>${best[4]}`;
  TIP.style.left = Math.min(innerWidth - 280, x + 16) + 'px'; TIP.style.top = (y + 16) + 'px'; TIP.style.opacity = '1';
}
canvas.addEventListener('pointermove', (e) => {
  updateTip(e.clientX, e.clientY);
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
// the film renderer drives a fixed clock so every moving thing advances exactly one frame per step
const FILM = { clock: null };
let NOW = 0;
function frame() {
  // Drop resolution once if this device can't keep up
  const now = FILM.clock ?? performance.now(), dt = FILM.clock != null ? 1000 / 30 : now - lastT; lastT = now; NOW = now; CLOUD_T.value = now / 1000;
  if (engineOpen && engineOv.classList.contains('is-open')) return; // the simulator has the GPU while it is open
  if (DESK_ENGINE.mixer && camera.position.z < -14 && camera.position.x > 0) DESK_ENGINE.mixer.update(Math.min(dt, 100) / 1000);
  if (document.visibilityState === 'visible' && ++frames > 30 && frames < 240) {
    slowTime = slowTime * 0.9 + dt * 0.1;
    if (frames === 239 && slowTime > 26 && pixelRatio > 0.9) { pixelRatio = Math.max(0.85, pixelRatio * 0.7); renderer.setPixelRatio(pixelRatio); renderer.setSize(innerWidth, innerHeight, false); if (FX) { FX.composer.setPixelRatio(pixelRatio); FX.composer.setSize(innerWidth, innerHeight); } }
  }
  p += (targetP - p) * (reduceMotion ? 1 : 0.14);
  const pw = AERO.ready ? clamp01((p - AERO.split) / (1 - AERO.split)) : clamp01(p);
  const u = progressToU(pw);
  const pos = PATH.getPointAt(u);
  if (mode === 'walk' && AERO.ready && p < AERO.split) {
    aerialCamera(clamp01(p / AERO.split), camera.position, tmpLook);
    lastWalk.pos.copy(camera.position);
    lastWalk.look.copy(tmpLook);
  } else if (mode === 'walk') {
    camera.position.copy(pos);
    lookAt(pos.z, tmpLook);
    // subtle walking sway, fading out as the camera comes to rest
    const walking = (1 - range(u, 0.94, 1)) * range(u, 0.02, 0.08);
    camera.position.y += Math.sin(u * 95) * 0.012 * walking;
    lastWalk.pos.copy(camera.position);
    lastWalk.look.copy(tmpLook);
  } else {
    if (FOLLOW.kind && mode === 'room') updateFollow(dt);
    camera.position.copy(roomCam.pos);
    tmpLook.copy(roomCam.look);
  }
  // airside: open up the fog and the depth range once the camera is outside the back door
  const out = range(-camera.position.z, 21, 26);
  // from the air the haze is a city's worth of distance away; on the ground it closes in
  const alt = Math.max(0, camera.position.y - 2);
  scene.fog.near = Math.max(34 + out * 170, alt * 3);
  // grass tufts are for close views: from the air each blade is under a pixel and they shimmer
  const lowDown = camera.position.y < 90;
  if (PLANT_IMS.low !== lowDown) { PLANT_IMS.low = lowDown; PLANT_IMS.forEach((m) => { m.visible = lowDown; }); }
  scene.fog.far = Math.min(13000, Math.max(150 + out * 1500, 2600 + alt * 6));
  updateAerial(p);
  // outdoors (the forecourt, the apron) the sky does most of the lighting at sunset; indoors it only tints reflections
  const outdoors = Math.max(out, range(camera.position.z, -0.5, 3.5));
  scene.environmentIntensity = 0.35 + 0.25 * outdoors; // reflections kept low: matte, not glossy
  if (hemi) hemi.intensity = (0.55 + 0.15 * outdoors) * TOD.hemi; // at sunset the sky does most of the lighting
  if (SUN) SUN.intensity = (1.3 + 0.5 * outdoors) * TOD.sun; // a sun this low is weak: a gentle warm rim and long soft shadows, no glare
  renderer.toneMappingExposure = (1.0 - 0.1 * outdoors) * TOD.exp; // a camera stops down outside (AgX sits darker than ACES)
  const near = FOLLOW.kind ? 1 : camera.position.y > 12 ? Math.max(0.5, camera.position.y * 0.15) : camera.position.z < -25.5 ? 0.3 : 0.05; // depth precision from the air: no z-fighting
  if (Math.abs(camera.near - near) > 0.01) { camera.near = near; camera.updateProjectionMatrix(); }
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
  updateCountryLife(now, dt);
  updateSound();
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
