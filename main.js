import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 600);
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

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
  T.wayfinding = canvasTex(2048, 340, (g, w, h) => {
    g.fillStyle = '#0e1840'; g.fillRect(0, 0, w, h);
    const arrow = (x, dir) => { // dir -1 = ahead-left, 1 = ahead-right
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
    g.textBaseline = 'middle';
    arrow(120, -1); tile(220, 'A');
    g.fillStyle = '#f2f4f8'; g.textAlign = 'left'; g.font = FONT(600, 80); g.fillText('Cadet Prep', 460, h / 2 + 4, w / 2 - 500);
    g.fillStyle = 'rgba(242,244,248,0.25)'; g.fillRect(w / 2 - 2, 60, 4, h - 120);
    tile(w - 420, 'B'); arrow(w - 120, 1);
    g.fillStyle = '#f2f4f8'; g.textAlign = 'right'; g.font = FONT(600, 80); g.fillText('1-on-1 Mentorship', w - 460, h / 2 + 4, w / 2 - 500);
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
const DOOR_HOLES = Object.values(DOOR_X).map((x) => [x - DOOR_W / 2, x + DOOR_W / 2, DOOR_H]);

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
  const plaza = panel(30, 12, M.paving, 0, 0.002, 6, 'up');
  plaza.material = M.paving.clone(); plaza.material.map = repeatOf(M.paving.map, 30 / 2.4, 12 / 2.4);
  const path = panel(4.4, 20, M.paving, 0, 0.003, 22, 'up');
  path.material = M.paving.clone(); path.material.map = repeatOf(M.paving.map, 4.4 / 2.4, 20 / 2.4);
  const road = panel(260, 9, M.asphalt, 0, 0.001, 36.5, 'up');
  road.material = M.asphalt.clone(); road.material.map = repeatOf(M.asphalt.map, 60, 2);
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
  clad(16, 4.4, 0.8, 0, 2.2, -22.6);
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

function tree(x, z) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
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
  cyl(0.52, 0.52, 0.035, M.wood, tx, 0.42, cz, scene, 48);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = cyl(0.012, 0.012, 0.42, M.metalDark, tx + Math.cos(a) * 0.36, 0.2, cz + Math.sin(a) * 0.36, scene, 8);
    leg.rotation.set(Math.sin(a) * 0.12, 0, -Math.cos(a) * 0.12);
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
  cg.position.set(0, 2.5, zw + 0.06);
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
  const planks = new THREE.MeshStandardMaterial({ map: repeatOf(R.planks, 2.2, 2.2), roughness: 0.85 });
  const roomWall = new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 0.92 });

  for (const [id, x0, x1] of [['A', -8, -0.1], ['B', 0.1, 8]]) {
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
  box(0.04, 1.08, 2.62, M.frameBlack, -0.13, 1.7, cz);
  panel(2.56, 1.02, new THREE.MeshStandardMaterial({ map: R.stages, roughness: 0.85 }), -0.155, 1.7, cz, '-x');
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
  const desk = airliner(); desk.scale.setScalar(0.28); desk.position.set(bx - 0.65, 0.92, bz - 0.2); desk.rotation.set(0, 0.6, 0.08);
  scene.add(desk);
  cyl(0.003, 0.003, 0.14, M.metal, bx - 0.65, 0.84, bz - 0.2, scene, 6);
  cyl(0.04, 0.04, 0.012, M.paintNavy, bx - 0.65, 0.78, bz - 0.2, scene, 20);
  // mentor's chair behind the desk, student's armchair in front
  const mc = officeChair(); mc.position.set(bx, 0, bz - 0.85);
  const guest = sofa(0.82, { seats: 1 }); guest.position.set(bx + 0.1, 0, bz + 1.0); guest.rotation.y = Math.PI + 0.15;
  // rug + lounge corner by the partition
  panel(3.0, 2.2, M.rug, bx, 0.012, bz + 0.6, 'up');
  // bookshelf on the outer wall and a wall of framed photographs on the partition
  bookshelf(8, cz + 1.2, -1, { bw: 2.2, bh: 2.0 });
  for (let i = 0; i < 6; i++) {
    const col = i % 3, row = (i / 3) | 0, pz = cz + 1.3 - col * 0.62, py = 1.55 + row * 0.5;
    box(0.025, 0.4, 0.52, M.frameBlack, 0.12, py, pz);
    panel(0.46, 0.34, new THREE.MeshStandardMaterial({ map: R.photo(i), roughness: 0.85 }), 0.137, py, pz, '+x');
  }
  // pendant over the desk, plants in the corners
  pendant(bx, bz, 2.3);
  plant(7.4, z1 + 0.6, { height: 1.7, spread: 0.5, leaves: 85, light: true });
  plant(0.7, z1 + 0.6, { height: 1.3, spread: 0.45, leaves: 60 });
  const warm = new THREE.PointLight(0xffd8a8, 5, 6, 1.6);
  warm.position.set(bx, 2.1, bz);
  scene.add(warm);
}

/** Classroom chair facing -z (toward the front of the room). */
function studentChair(x, z) {
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

/* ---------- Aviation touches inside the lobby ---------- */
function buildAviationTouches() {
  // Taxiway-style centreline: a dashed steel inlay leading to the doors, with a stop bar
  for (let z = -1.6; z > -13; z -= 1.3) box(0.035, 0.003, 0.8, M.inlay, 0, 0.0055, z - 0.4, scene, { cast: false });
  box(4.4, 0.003, 0.035, M.inlay, 0, 0.0055, -13.15, scene, { cast: false });

  // Hanging wayfinding sign over the walkway
  const sy = 2.95, sz = -3.4;
  const sign = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.6 * (340 / 2048), 0.06),
    [M.claddingDeep, M.claddingDeep, M.claddingDeep, M.claddingDeep, M.wayfinding, M.claddingDeep]);
  sign.position.set(0, sy, sz);
  add(sign, scene, { cast: false, receive: false });
  for (const x of [-1.1, 1.1]) cyl(0.004, 0.004, LOBBY.h - sy - 0.2, M.metal, x, (LOBBY.h + sy + 0.2) / 2, sz, scene, 6, { cast: false });

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

/** A desk-model airliner (about 1 m long), built nose toward +x. */
function airliner() {
  const g = new THREE.Group();
  const L = 0.95, R = 0.05;
  const prof = [[0, 0], [0.012, 0.004], [0.028, 0.06], [0.045, 0.18], [R, 0.3], [R, 0.78], [0.046, 0.86], [0.034, 0.92], [0.018, 0.96], [0.006, 0.985], [0, 0.99]]
    .map(([r, y]) => new THREE.Vector2(r, y * L));
  const fus = mesh(new THREE.LatheGeometry(prof, 40), M.paint, -L / 2, 0, 0, g);
  fus.rotation.z = -Math.PI / 2;
  // cyan cheatline on both sides
  for (const side of [0, Math.PI]) {
    const stripe = mesh(new THREE.CylinderGeometry(R * 1.006, R * 1.006, L * 0.46, 24, 1, true, side + Math.PI * 0.45, Math.PI * 0.1), M.paintCyan, L * 0.06, 0, 0, g, { cast: false });
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
    const wl = flat([[-0.14, 0], [-0.17, 0.055], [-0.19, 0.055], [-0.19, 0]], 0.004, M.paintNavy);
    wl.position.set(0, 0.005, side * 0.468);
    add(wl, g);
    // engine on a pylon
    const eng = mesh(new THREE.CylinderGeometry(0.024, 0.02, 0.12, 24), M.paintNavy, 0.05, -0.07, side * 0.16, g);
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
  add(flat([[-0.32, 0.03], [-0.43, 0.2], [-0.47, 0.2], [-0.46, 0.03]], 0.008, M.paintNavy), g);
  box(0.045, 0.014, 0.0085, M.paintCyan, -0.442, 0.165, 0, g);
  return g;
}

/* ---------- Camera path ---------- */
const PATH = new THREE.CatmullRomCurve3([
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
let T, M;
async function init() {
  try { await Promise.all([FONT(500, 64), FONT(600, 30), FONT(500, 64, DISPLAY), FONT(700, 27)].map((f) => document.fonts.load(f))); } catch (e) { /* fall back to system fonts */ }
  let logoImg;
  try { logoImg = await loadImage('brand/logo-white.svg'); } catch (e) { logoImg = document.createElement('canvas'); }
  T = makeTextures(logoImg);
  M = makeMaterials(T);

  buildSky();
  // Sunset: lavender sky fill, low amber sun raking across the facade from the west
  scene.add(new THREE.HemisphereLight(0x8a88b8, 0x3a2c26, 0.6));
  const sun = new THREE.DirectionalLight(0xffb37a, 1.7);
  sun.position.set(-42, 12, 6);
  sun.target.position.set(0, 0, 8);
  scene.add(sun.target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 14, bottom: -14, near: 10, far: 90 });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);

  buildExterior();
  buildLobby();
  uDoor = computeDoorU();

  // Glass and logo planes should not throw shadows into the lobby
  scene.traverse((o) => {
    if (o.isMesh && (o.material === M.glass || o.material?.transparent)) o.castShadow = false;
  });

  mergeStatic();
  renderer.shadowMap.autoUpdate = false; // nothing that casts shadows moves, so bake them once
  renderer.shadowMap.needsUpdate = true;

  window.__cc = { renderer, scene, camera, setP: (v) => { targetP = p = v; } }; // debug handle
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
  frame();
  renderer.compile(scene, camera);
  requestAnimationFrame(() => document.documentElement.classList.add('is-ready'));
}

/* ---------- Merge static meshes by material (hundreds of draw calls -> a few dozen) ---------- */
function mergeStatic() {
  scene.updateMatrixWorld(true);
  const buckets = new Map();
  const merged = [];
  scene.traverse((o) => {
    if (!o.isMesh || Array.isArray(o.material)) return;
    for (let a = o; a; a = a.parent) if (a.userData.dynamic) return;
    const key = `${o.material.uuid}|${o.castShadow}|${o.receiveShadow}|${o.renderOrder}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { mat: o.material, cast: o.castShadow, receive: o.receiveShadow, order: o.renderOrder, geos: [] }));
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    g.clearGroups();
    g.applyMatrix4(o.matrixWorld);
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
    eyebrow: 'Room B', title: '1-on-1 Mentorship', side: 'left',
    lede: 'Book time with a mentor for career guidance, subject doubts or a full mentorship programme, without long message threads.',
    points: ['General career and flight-training guidance', 'Subject-specific doubt-clearing sessions', 'Self-study mentorship with recorded classes', 'Pick an open slot, then confirm your booking'],
    via: [[1.2, 1.62, -12.2], [1.65, 1.62, -13.7], [1.9, 1.62, -14.7]], pos: [2.7, 1.62, -15.4], look: [4.7, 1.2, -19.9],
  },
};
let mode = 'walk'; // 'walk' | 'moving' | 'room' | 'screen'
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
  const doorLook = new THREE.Vector3(DOOR_X[id], 1.45, -16);
  const endLook = new THREE.Vector3(...c.look);
  const curve = new THREE.CatmullRomCurve3([lastWalk.pos.clone(), ...c.via.map((v) => new THREE.Vector3(...v)), new THREE.Vector3(...c.pos)], false, 'centripetal');
  const st = { t: 0 };
  const apply = () => {
    curve.getPointAt(st.t, roomCam.pos);
    const a = smooth(clamp01(st.t / 0.5)), b = smooth(clamp01((st.t - 0.5) / 0.5));
    roomCam.look.lerpVectors(startLook, doorLook, a).lerp(endLook, b);
  };
  apply();
  roomTl = gsap.timeline({
    onComplete: () => { mode = 'room'; showCard(id); },
    onReverseComplete: () => { mode = 'walk'; roomTl = null; html.classList.remove('in-room'); lenis?.start(); },
  });
  roomTl.to(DOORS[id], { open: 1, duration: 1.2, ease: 'power2.inOut' }, 0)
    .to(st, { t: 1, duration: reduceMotion ? 0.3 : 3.4, ease: 'power2.inOut', onUpdate: apply }, 0.35);
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
  card.hidden = false;
  requestAnimationFrame(() => card.classList.add('is-open'));
  document.getElementById('roomBack').focus({ preventScroll: true });
}
function hideCard() {
  card.classList.remove('is-open');
  setTimeout(() => { if (!card.classList.contains('is-open')) card.hidden = true; }, 500);
}
document.getElementById('roomBack').addEventListener('click', leaveRoom);
addEventListener('keydown', (e) => { if (e.key === 'Escape') leaveRoom(); });
document.querySelectorAll('[data-room]').forEach((b) => b.addEventListener('click', () => enterRoom(b.dataset.room)));

// Pointer picking on the door leaves, only once the walk has arrived in front of them
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function doorAt(x, y) {
  if (mode !== 'walk' || p < 0.82 || !DOORS.A) return null;
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects([DOORS.A.leaf, DOORS.B.leaf], false)[0];
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
  if (!door) canvas.style.cursor = screenAt(e.clientX, e.clientY) ? 'pointer' : '';
});
canvas.addEventListener('click', (e) => {
  const id = doorAt(e.clientX, e.clientY);
  if (id) return enterRoom(id);
  if (screenAt(e.clientX, e.clientY)) viewScreen();
});

/* ---------- Frame ---------- */
const tmpLook = new THREE.Vector3();
const right = new THREE.Vector3();
let lastCapP = -1;
let frames = 0, slowTime = 0, lastT = performance.now();
function frame() {
  // Drop resolution once if this device can't keep up
  const now = performance.now(), dt = now - lastT; lastT = now;
  if (document.visibilityState === 'visible' && ++frames > 30 && frames < 240) {
    slowTime = slowTime * 0.9 + dt * 0.1;
    if (frames === 239 && slowTime > 26 && pixelRatio > 0.9) { pixelRatio = Math.max(0.85, pixelRatio * 0.7); renderer.setPixelRatio(pixelRatio); renderer.setSize(innerWidth, innerHeight, false); }
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
  // the traffic screen only redraws while the camera is inside the lobby
  updateTraffic(now, (camera.position.z < 1.5 && camera.position.z > -14) || TRAFFIC.force);
  for (const d of Object.values(DOORS)) {
    d.pivot.rotation.y = d.sign * smooth(d.open) * 1.75;
    d.leafMat.emissiveIntensity = d.hover * 0.12;
  }

  pointer.sx += (pointer.x - pointer.sx) * 0.05;
  pointer.sy += (pointer.y - pointer.sy) * 0.05;
  right.subVectors(tmpLook, camera.position).cross(camera.up).normalize();
  const dist = tmpLook.distanceTo(camera.position);
  const sway = mode === 'screen' ? 0.15 : 1; // keep the radar steady while reading it
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

  renderer.render(scene, camera);
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
  ScrollTrigger.refresh();
}
addEventListener('resize', onResize);

init();
