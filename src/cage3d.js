/**
 * Tambola MP — the caller's blower (three.js)
 *
 * A stationary horizontal glass cylinder holds every ball still in the pool. Idle, the
 * balls drift slowly; before a draw the "air" comes on and they churn hard, then one
 * ball drops out through the hole in the bottom, falls and settles as the DRAWN ball —
 * shown large, a true glossy sphere, number facing the room. Below it a row of the last
 * three numbers; when the next ball is drawn the current one drops into that row, the
 * row shifts, and the oldest rolls off. The cylinder therefore empties visibly as the
 * round goes on: the balls inside ARE the remaining pool.
 *
 * Column layout (world y, the cylinder axis is x):  cylinder → drawn ball → tray.
 *
 * Only the falling ball gets physics-like motion (ballistic drop, bounce, spin decay).
 * The churn is a scripted swarm (no solver). The drawn number comes from the engine.
 *
 *   mount(hostEl)                → boolean (false if WebGL failed; keep the CSS ball)
 *   setPool(remaining, drawn)    rebuild instantly to match game state (restore / sync)
 *   draw(number)                 → Promise<void>, resolves when the ball has settled
 *   dispose()
 *   DRAW_MS
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* ---- timing (seconds) ---- */
const T_CHURN = 0.9, T_DROP = 0.75, T_SETTLE = 0.5;
export const DRAW_MS = Math.round((T_CHURN + T_DROP + T_SETTLE) * 1000);

/* ---- layout (world units) ---- */
// Compact: 90 balls fill about 60 % of the glass at the start, so it never looks empty early on.
const CYL_R = 0.42, CYL_LEN = 2.9, CYL_Y = 1.3;            // glass cylinder, axis along x
const BALL_R = 0.105;                                       // pool balls
const HATCH_R = BALL_R * 1.45;                              // the round exit hatch on the cylinder's front face
const SHOW = new THREE.Vector3(0, -0.05, 0.35);             // where the drawn ball hangs
const SHOW_R = 0.52;                                        // drawn ball radius (true sphere, big)
const TRAY_Y = -1.15, TRAY_Z = 0.3, TRAY_R = 0.26, TRAY_GAP = 0.78;
const TRAY = [-TRAY_GAP, 0, TRAY_GAP].map((x) => new THREE.Vector3(x, TRAY_Y, TRAY_Z));   // newest left
const TRAY_EXIT = new THREE.Vector3(TRAY_GAP * 2.1, TRAY_Y - 0.4, TRAY_Z);

/* ---- colour by decade, like a real set ---- */
const DECADE_COLOURS = ['#e63946', '#f4a261', '#e9c46a', '#2a9d8f', '#457b9d', '#8e44ad', '#ff7f50', '#06d6a0', '#118ab2'];
const decadeColour = (n) => DECADE_COLOURS[Math.min(8, Math.floor((n - 1) / 10))];

/* =================== module state =================== */
let host = null, canvas = null, renderer = null, scene = null, camera = null;
let poolBalls = new Map();                    // number -> mesh, inside the cylinder
let shownBall = null, trayBalls = [];
let ballGeo = null, bigGeo = null, textures = new Map();
let rafId = 0, last = 0;
let churn = 0;                                // 0 = idle drift, 1 = full blast
let drawAnim = null;
let lowEnd = false;
let hatch = null, hatchOpen = 0;              // lid group; 0 closed … 1 open
const HATCH_POS = new THREE.Vector3(), HATCH_OUT = new THREE.Vector3();
const tmpV = new THREE.Vector3();
const INNER = CYL_R - BALL_R * 1.15;          // radius the pool balls' centres may reach
const HALF_X = CYL_LEN / 2 - BALL_R * 1.3;

/* =================== textures =================== */
/** Solid decade-coloured ball with a white patch carrying the number in black, front and back. */
function ballTexture(n) {
  if (textures.has(n)) return textures.get(n);
  const W = lowEnd ? 256 : 512, H = W / 2;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = decadeColour(n); ctx.fillRect(0, 0, W, H);
  // a soft darker band toward the poles so the sphere reads as solid, not flat
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,0.28)'); g.addColorStop(0.35, 'rgba(0,0,0,0)'); g.addColorStop(0.65, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.28)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.font = `800 ${Math.round(H * 0.27)}px Arial, Helvetica, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  [0.25, 0.75].forEach((u) => {
    ctx.beginPath(); ctx.arc(W * u, H / 2, H * 0.205, 0, Math.PI * 2);
    ctx.fillStyle = '#fbfaf7'; ctx.fill();
    ctx.lineWidth = H * 0.015; ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.stroke();
    ctx.fillStyle = '#111'; ctx.fillText(String(n), W * u, H * 0.515);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  textures.set(n, t);
  return t;
}

/** Glossy resin, like the house balls on the bowling lane. */
function ballMaterial(n) {
  // Satin rather than mirror gloss: a hard clearcoat put the key light's glare right across
  // the number patch. Still reads as resin, but the digits stay clear.
  return new THREE.MeshPhysicalMaterial({
    map: ballTexture(n), roughness: 0.38, metalness: 0,
    clearcoat: 0.45, clearcoatRoughness: 0.35, specularIntensity: 0.6,
  });
}

function makePoolBall(n) {
  const m = new THREE.Mesh(ballGeo, ballMaterial(n));
  m.castShadow = false;                        // 90 small casters bought nothing but noise
  m.renderOrder = 0;                           // before the glass and the hatch (see buildScene)
  m.userData.number = n;
  // swarm parameters: a home spot on the floor of the cylinder and a personal rhythm
  m.userData.home = new THREE.Vector3(0, -INNER, 0);
  m.userData.phase = Math.random() * Math.PI * 2;
  m.userData.rate = 0.7 + Math.random() * 0.8;
  m.userData.spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
  m.quaternion.random();
  return m;
}

/* =================== scene =================== */
function buildScene() {
  scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;
  pmrem.dispose();

  camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0.35, 6.4);
  camera.lookAt(0, 0.15, 0);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.5));
  const key = new THREE.DirectionalLight(0xfff2e0, 2.0);
  key.position.set(-4, 4.5, 2.2); key.castShadow = true;   // well off to the side: its highlight lands beside the number patch, not on it
  key.shadow.mapSize.set(lowEnd ? 1024 : 2048, lowEnd ? 1024 : 2048);
  key.shadow.camera.left = -3; key.shadow.camera.right = 3; key.shadow.camera.top = 3; key.shadow.camera.bottom = -3;
  key.shadow.camera.near = 1; key.shadow.camera.far = 14; key.shadow.bias = -0.0005; key.shadow.normalBias = 0.02;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0xbfd0ff, 0.45); fill.position.set(3, 1, -2); scene.add(fill);

  // ---- the glass cylinder: an open tube plus two end caps, drawn back faces first ----
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xdfeeff, transmission: 0.92, roughness: 0.06, thickness: 0.15, ior: 1.45,
    transparent: true, opacity: 1, clearcoat: 1, clearcoatRoughness: 0.05, side: THREE.DoubleSide, depthWrite: false,
  });
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(CYL_R, CYL_R, CYL_LEN, 48, 1, true), glass);
  tube.rotation.z = Math.PI / 2; tube.position.y = CYL_Y; tube.renderOrder = 10;
  scene.add(tube);
  // Pool balls render BEFORE the glass (lower renderOrder) and the hatch AFTER it, so the
  // lid always reads as sitting in the wall in front of the balls, not floating over them.
  const POOL_ORDER = 0, HATCH_ORDER = 20;
  const chrome = new THREE.MeshStandardMaterial({ color: 0xd9dde3, metalness: 0.85, roughness: 0.25 });
  const capGeo = new THREE.CylinderGeometry(CYL_R * 1.04, CYL_R * 1.04, 0.1, 48);
  [-1, 1].forEach((s) => {
    const cap = new THREE.Mesh(capGeo, chrome);
    cap.rotation.z = Math.PI / 2; cap.position.set(s * (CYL_LEN / 2 + 0.05), CYL_Y, 0);
    cap.castShadow = true; scene.add(cap);
    const band = new THREE.Mesh(new THREE.TorusGeometry(CYL_R * 1.01, 0.02, 8, 48), chrome);
    band.rotation.y = Math.PI / 2; band.position.set(s * CYL_LEN * 0.3, CYL_Y, 0); scene.add(band);
  });
  // Exit hatch on the FRONT face, low, centred: a chrome rim ring set into the glass and a
  // round lid hinged at its top edge. Normally closed; it swings up/out to let the ball roll
  // out, then closes. The lid pivots about a group placed at the hinge.
  const hatchAng = -0.62;                                   // where on the section (radians from +z toward −y)
  const hatchPos = new THREE.Vector3(0, CYL_Y + Math.sin(hatchAng) * CYL_R, Math.cos(hatchAng) * CYL_R);
  const hatchNormal = new THREE.Vector3(0, Math.sin(hatchAng), Math.cos(hatchAng));
  const rim = new THREE.Mesh(new THREE.TorusGeometry(HATCH_R, 0.018, 8, 40), chrome);
  rim.position.copy(hatchPos); rim.lookAt(hatchPos.clone().add(hatchNormal)); rim.renderOrder = HATCH_ORDER; scene.add(rim);
  // Pivot group at the top edge of the opening. Everything lies in the yz plane (the hatch
  // is on the x=0 meridian), so its orientation is a single tilt about x: the lid disc,
  // built facing +z and hanging below the hinge, is tilted so it sits flush in the glass.
  hatch = new THREE.Group();
  const hingeUp = new THREE.Vector3(0, Math.cos(hatchAng), -Math.sin(hatchAng));   // tangent "up" at the hatch
  hatch.position.copy(hatchPos).addScaledVector(hingeUp, HATCH_R);
  hatch.userData.rest = -hatchAng;                          // rotation.x that makes the lid's normal = hatchNormal
  hatch.rotation.x = hatch.userData.rest;
  const lid = new THREE.Mesh(new THREE.CircleGeometry(HATCH_R * 0.97, 32), new THREE.MeshStandardMaterial({ color: 0xb8bec8, metalness: 0.7, roughness: 0.3, side: THREE.DoubleSide }));
  lid.position.y = -HATCH_R;                                // hang the disc below the hinge
  lid.renderOrder = HATCH_ORDER;
  hatch.add(lid);
  const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, HATCH_R * 1.4, 10), chrome);
  hinge.rotation.z = Math.PI / 2; hinge.renderOrder = HATCH_ORDER; hatch.add(hinge);
  scene.add(hatch);
  HATCH_POS.copy(hatchPos); HATCH_OUT.copy(hatchNormal);
  // No backdrop: the scene floats over the page. (A shadow plane behind the cylinder threw a
  // wall of ball shadows onto the TV background.) The drawn ball and tray still shadow each other.

  // ---- display pedestal for the drawn ball, and the tray ----
  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 0.8, roughness: 0.3 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(SHOW_R * 0.75, 0.03, 10, 56), brass);
  ring.rotation.x = Math.PI / 2; ring.position.set(SHOW.x, SHOW.y - SHOW_R * 0.72, SHOW.z); scene.add(ring);
  const trayGeo = new THREE.TorusGeometry(TRAY_R * 0.8, 0.02, 8, 40);
  TRAY.forEach((p) => {
    const r = new THREE.Mesh(trayGeo, brass);
    r.rotation.x = Math.PI / 2; r.position.set(p.x, p.y - TRAY_R * 0.75, p.z); scene.add(r);
  });

  ballGeo = new THREE.SphereGeometry(BALL_R, lowEnd ? 16 : 24, lowEnd ? 12 : 18);
  bigGeo = new THREE.SphereGeometry(1, 48, 32);            // unit; scaled per use
}

/* =================== pool layout =================== */
/** Resting spots along the floor of the cylinder, packed in up to 3 layers. */
function assignHomes() {
  const balls = [...poolBalls.values()].sort((a, b) => a.userData.number - b.userData.number);
  const perRow = Math.max(1, Math.floor((HALF_X * 2) / (BALL_R * 2.1)));
  balls.forEach((m, i) => {
    const layer = Math.floor(i / (perRow * 2)), k = i % (perRow * 2);
    const row = k % 2, col = Math.floor(k / 2);
    const x = -HALF_X + (col + 0.5 + row * 0.5) * (HALF_X * 2) / perRow;
    const z = (row ? 1 : -1) * BALL_R * 0.95;
    const yFloor = -Math.sqrt(Math.max(0, INNER * INNER - z * z));
    m.userData.home.set(THREE.MathUtils.clamp(x, -HALF_X, HALF_X), yFloor + layer * BALL_R * 1.8, z);
  });
}

/* =================== public API =================== */
export function mount(hostEl) {
  if (renderer) { if (!canvas.isConnected) hostEl.appendChild(canvas); resize(); return true; }
  host = hostEl;
  canvas = document.createElement('canvas');
  canvas.className = 'cage3d-layer';
  canvas.setAttribute('aria-hidden', 'true');
  host.appendChild(canvas);
  lowEnd = (navigator.deviceMemory && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) || false;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (err) {
    console.error('3D blower unavailable:', err);
    canvas.remove(); canvas = null; renderer = null;
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowEnd ? 1.5 : 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  buildScene();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => resize()).observe(host);
  resize();
  if (!rafId) { last = performance.now(); rafId = requestAnimationFrame(frame); }
  return true;
}

function resize() {
  if (!renderer || !canvas) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w < 2 || h < 2) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Fit the rig (cylinder with caps ≈ 3.3 wide incl. margin, column ≈ 3.3 tall) whatever
  // the box's aspect: on a portrait phone the WIDTH is the binding constraint, so the
  // vertical fov opens up until the cylinder's end caps are inside the frame.
  const RIG_W = 3.35, RIG_H = 3.3, vFov = 30;
  const tanV = Math.tan(THREE.MathUtils.degToRad(vFov / 2));
  const tanNeededForWidth = (tanV * (RIG_W / RIG_H)) / camera.aspect;   // half-height tan that makes RIG_W fit
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.max(tanV, tanNeededForWidth)));
  camera.updateProjectionMatrix();
}

/** Rebuild to match the game: `remaining` in the cylinder, last of `drawn` shown, three before in the tray. */
export function setPool(remaining, drawn) {
  if (!scene) return;
  if (drawAnim) finishDraw();
  const recentWant = drawn.slice(-4).reverse();
  const recentHave = [shownBall, ...trayBalls].filter(Boolean).map((m) => m.userData.number);
  const sameRecent = recentWant.length === recentHave.length && recentWant.every((n, i) => n === recentHave[i]);
  const sameCage = remaining.length === poolBalls.size && remaining.every((n) => poolBalls.has(n));
  if (sameRecent && sameCage) return;

  const want = new Set(remaining);
  for (const [n, m] of poolBalls) if (!want.has(n)) { scene.remove(m); m.material.dispose(); poolBalls.delete(n); }
  for (const n of remaining) if (!poolBalls.has(n)) { const m = makePoolBall(n); scene.add(m); poolBalls.set(n, m); }
  assignHomes();
  for (const m of poolBalls.values()) m.position.copy(m.userData.home).setY(m.userData.home.y + CYL_Y);

  [shownBall, ...trayBalls].forEach((m) => { if (m) { scene.remove(m); m.material.dispose(); } });
  shownBall = null; trayBalls = [];
  recentWant.forEach((n, i) => {
    const m = new THREE.Mesh(bigGeo, ballMaterial(n));
    m.castShadow = true; m.userData.number = n;
    if (i === 0) { m.position.copy(SHOW); m.scale.setScalar(SHOW_R); shownBall = m; }
    else { m.position.copy(TRAY[i - 1]); m.scale.setScalar(TRAY_R); trayBalls.push(m); }
    faceCamera(m);
    scene.add(m);
  });
  churn = 0;
}

/** SphereGeometry puts texture u=0.25 (the first number) at +z: identity faces the camera. */
function faceCamera(m) { m.quaternion.identity(); m.rotateX(-0.08); }

/**
 * Draw `number`: churn hard, drop the ball through the floor hole, let it fall and settle
 * as the shown ball, and shift the tray. Resolves once it has settled (DRAW_MS).
 */
export function draw(number) {
  if (!scene) return Promise.resolve();
  if (drawAnim) finishDraw();
  let ball = poolBalls.get(number);
  if (!ball) { ball = makePoolBall(number); scene.add(ball); poolBalls.set(number, ball); }
  return new Promise((resolve) => {
    drawAnim = {
      start: performance.now(), number, ball, resolve, phase: 0,
      prevShown: shownBall, prevTray: trayBalls.slice(),
      // spin it arrives with, decaying to a stop as it settles face-on
      spinAxis: new THREE.Vector3(Math.random() - 0.5, 1, Math.random() - 0.5).normalize(),
      spinRate: 16 + Math.random() * 6,
    };
    shownBall = null;
    drawAnim.timer = setTimeout(finishDraw, DRAW_MS + 100);
  });
}

function finishDraw() {
  const a = drawAnim; if (!a) return;
  drawAnim = null; clearTimeout(a.timer);
  // the drawn pool ball becomes the shown ball (swap to the big geometry)
  const b = a.ball;
  poolBalls.delete(a.number);
  b.geometry = bigGeo; b.scale.setScalar(SHOW_R);
  b.position.copy(SHOW); faceCamera(b); shownBall = b;
  const tray = [a.prevShown, ...a.prevTray].filter(Boolean);
  tray.forEach((m, i) => {
    delete m.userData.shiftFrom; delete m.userData.shiftQ; delete m.userData.shiftS;
    if (i >= 3) { scene.remove(m); m.material.dispose(); return; }
    m.position.copy(TRAY[i]); m.scale.setScalar(TRAY_R); faceCamera(m);
    m.material.transparent = false; m.material.opacity = 1;
  });
  trayBalls = tray.slice(0, 3);
  assignHomes();
  churn = 0; hatchOpen = 0;
  a.resolve();
}

/* =================== per-frame =================== */
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
const clamp01 = (t) => Math.max(0, Math.min(1, t));

function frame(now) {
  rafId = requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (drawAnim) tickDraw(now, dt);
  else hatchOpen = Math.max(0, hatchOpen - dt * 3);
  // lid: hinged at its top edge, swings outward and up by ~100° (negative x = bottom edge comes toward +z)
  if (hatch) hatch.rotation.x = hatch.userData.rest - easeInOut(hatchOpen) * 1.75;
  swarm(now / 1000, dt);
  if (document.hidden || !canvas || canvas.clientWidth === 0) return;
  renderer.render(scene, camera);
}

/**
 * The balls inside the cylinder. Idle: they rest near their home spots on the floor with a
 * slow lazy drift. Churning: each rides its own looping path around the cylinder's cross-
 * section and along its length, at a speed set by `churn`, always kept inside the glass.
 */
function swarm(t, dt) {
  for (const m of poolBalls.values()) {
    if (drawAnim && m === drawAnim.ball && drawAnim.phase >= 1) continue;
    const u = m.userData, h = u.home;
    // idle drift: tiny bob and slide around home
    const ix = h.x + Math.sin(t * 0.6 * u.rate + u.phase) * 0.05;
    const iy = h.y + Math.abs(Math.sin(t * 1.1 * u.rate + u.phase)) * 0.04;
    const iz = h.z + Math.cos(t * 0.5 * u.rate + u.phase) * 0.03;
    // churn: a fast loop around the section (angle a) while sweeping along x
    const a = u.phase + t * (5 + 3 * u.rate) ;
    const r = INNER * (0.35 + 0.6 * (0.5 + 0.5 * Math.sin(t * 2.3 * u.rate + u.phase)));
    const cx = THREE.MathUtils.clamp(h.x + Math.sin(t * 1.7 * u.rate + u.phase * 2) * HALF_X * 0.8, -HALF_X, HALF_X);
    const cy = Math.sin(a) * r, cz = Math.cos(a) * r;
    tmpV.set(ix + (cx - ix) * churn, iy + (cy - iy) * churn, iz + (cz - iz) * churn);
    // never outside the glass
    const rr = Math.hypot(tmpV.y, tmpV.z);
    if (rr > INNER) { tmpV.y *= INNER / rr; tmpV.z *= INNER / rr; }
    m.position.set(tmpV.x, CYL_Y + tmpV.y, tmpV.z);
    m.rotateOnAxis(u.spin, dt * (0.6 + 14 * churn));
  }
}

function tickDraw(now, dt) {
  const a = drawAnim;
  const tSec = (now - a.start) / 1000;
  const b = a.ball;
  if (tSec < T_CHURN) {
    /* ---- air on: everything churns; the chosen ball is steered to the floor hole ---- */
    churn = Math.min(1, churn + dt * 3);
    const k = tSec / T_CHURN;
    if (k > 0.5) {
      if (a.phase < 1) { a.phase = 1; a.from = b.position.clone(); }
      const s = easeInOut((k - 0.5) / 0.5);
      // to just inside the hatch, while the lid swings open ahead of it
      tmpV.copy(HATCH_POS).addScaledVector(HATCH_OUT, -BALL_R * 1.1);
      b.position.lerpVectors(a.from, tmpV, s);
      b.rotateOnAxis(a.spinAxis, dt * 10);
      hatchOpen = Math.min(1, hatchOpen + dt * 4);
    }
  } else if (tSec < T_CHURN + T_DROP) {
    /* ---- out: through the open hatch, a short arc forward, then free fall onto the pedestal ---- */
    if (a.phase < 2) {
      a.phase = 2; churn = 0.35;                // air off; the rest settle
      poolBalls.delete(a.number);               // no longer part of the swarm
      b.geometry = bigGeo; b.scale.setScalar(BALL_R);
      a.exit = HATCH_POS.clone().addScaledVector(HATCH_OUT, BALL_R * 1.2);   // just outside the lid
    }
    const u = tSec - T_CHURN, k = u / T_DROP;
    // horizontal: from the hatch to the display spot, easing; vertical: ballistic from the exit
    // height with a forward "kick" so it clears the glass, landing at 70 % then a small hop
    const tLand = T_DROP * 0.7;
    const y0 = a.exit.y, y1 = SHOW.y, vy0 = 0.9;                       // small upward kick out of the hatch
    const g = 2 * (vy0 * tLand + (y0 - y1)) / (tLand * tLand);
    let y;
    if (u < tLand) y = y0 + vy0 * u - 0.5 * g * u * u;
    else { const v = (u - tLand) / (T_DROP - tLand); y = y1 + Math.sin(v * Math.PI) * 0.14 * (1 - v * 0.5); }
    const e = easeInOut(Math.min(1, k * 1.15));
    b.position.set(a.exit.x + (SHOW.x - a.exit.x) * e, y, a.exit.z + (SHOW.z - a.exit.z) * e);
    b.scale.setScalar(BALL_R + (SHOW_R - BALL_R) * easeInOut(Math.min(1, k * 1.3)));
    b.rotateOnAxis(a.spinAxis, dt * a.spinRate);
    if (k > 0.3) hatchOpen = Math.max(0, hatchOpen - dt * 3);          // lid swings shut behind it
    // the tray sequence runs across the drop AND the settle (tray hops first, then the old
    // shown ball hops into the cleared slot), so progress is measured over both phases
    shiftTray(clamp01(u / (T_DROP + T_SETTLE)));
  } else {
    /* ---- settle: spin dies, the number turns to face the room ---- */
    if (a.phase < 3) { a.phase = 3; a.qFrom = b.quaternion.clone(); a.qTo = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.08); }
    churn = Math.max(0, churn - dt * 1.2);
    hatchOpen = Math.max(0, hatchOpen - dt * 3);
    const k = clamp01((tSec - T_CHURN - T_DROP) / T_SETTLE);
    b.position.copy(SHOW);
    b.scale.setScalar(SHOW_R);
    // keep spinning, slower, then slerp the last part onto the face-on pose
    if (k < 0.5) b.rotateOnAxis(a.spinAxis, dt * a.spinRate * (1 - k * 2));
    if (k >= 0.5) { if (!a.qMid) a.qMid = b.quaternion.clone(); b.quaternion.slerpQuaternions(a.qMid, a.qTo, easeInOut((k - 0.5) * 2)); }
    shiftTray(clamp01((tSec - T_CHURN) / (T_DROP + T_SETTLE)));
    if (tSec >= T_CHURN + T_DROP + T_SETTLE) finishDraw();
  }
}

/**
 * Previous shown ball → tray slot 0, others one along, the oldest off the end and fading.
 * Sequenced so nothing crosses: first (0–55 %) the tray balls hop one slot to the right,
 * clearing slot 0 and tipping the oldest off the end; then (45–100 %) the shown ball hops
 * in a single arc from its pedestal straight into the now-empty slot 0. Every hop is
 * exactly ONE full turn about the VERTICAL axis, so the number faces the room again on
 * landing (a horizontal roll would leave it upside down).
 */
function shiftTray(ts) {
  const a = drawAnim;
  const chain = [a.prevShown, ...a.prevTray].filter(Boolean);
  const UP = new THREE.Vector3(0, 1, 0);
  chain.forEach((m, i) => {
    const to = i < 3 ? TRAY[i] : TRAY_EXIT;
    if (!m.userData.shiftFrom) {                        // capture where it started, once per draw
      m.userData.shiftFrom = m.position.clone();
      m.userData.shiftQ = m.quaternion.clone();
      m.userData.shiftS = m.scale.x;
    }
    const from = m.userData.shiftFrom, fromS = m.userData.shiftS;
    const toS = i < 3 ? TRAY_R : TRAY_R * 0.6;
    // local progress: tray balls go first, the shown ball follows once slot 0 is clear
    const k = i === 0 ? clamp01((ts - 0.45) / 0.55) : clamp01(ts / 0.55);
    const e = easeInOut(k);
    m.scale.setScalar(fromS + (toS - fromS) * e);
    m.position.lerpVectors(from, to, e);
    // the hop: the shown ball's is a real fall (high start), the tray hops are small
    const lift = i === 0 ? 0.35 : 0.14;
    m.position.y += Math.sin(k * Math.PI) * lift;
    // one full turn about vertical over the hop, so the number is back at the front
    m.quaternion.copy(m.userData.shiftQ);
    m.rotateOnWorldAxis(UP, e * Math.PI * 2);
    if (i >= 3) {                                       // off the edge: drop away and fade
      m.position.y -= k * k * 0.6;
      m.material.transparent = true; m.material.opacity = 1 - k;
    }
  });
}

export function dispose() {
  if (rafId) cancelAnimationFrame(rafId); rafId = 0;
  if (drawAnim) finishDraw();
  textures.forEach((t) => t.dispose()); textures.clear();
  renderer?.dispose(); renderer = null; scene = null;
  poolBalls = new Map(); shownBall = null; trayBalls = [];
  canvas?.remove(); canvas = null;
}
