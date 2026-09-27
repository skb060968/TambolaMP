/**
 * Tambola MP — the caller's cage (three.js)
 *
 * Replaces the CSS "vibrating ball" on the TV screen with a hand-cranked spherical
 * wire cage holding every ball still in the pool. On a draw the cage spins up, the
 * balls tumble, one drops through the chute into the cradle at the front with its
 * number facing the room, and the previous ball moves along a three-slot tray of
 * recent numbers (the oldest rolling off). The cage therefore empties visibly as the
 * round goes on: the pile of balls inside IS the remaining pool.
 *
 * Purely visual: the number comes from the engine; the tumble is a cheap scripted
 * motion (no physics solver), and the chute ball is simply the one it is told to be.
 *
 *   mount(hostEl)                     → boolean (false if WebGL failed; keep the CSS ball)
 *   setPool(remaining, drawn)         rebuild instantly: balls in cage, cradle, tray (restore)
 *   draw(number)                      → Promise<void>, resolves when the ball is in the cradle
 *   dispose()
 *   DRAW_MS
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export const DRAW_MS = 1700;

/* ---- layout (world units; the cage radius is 1) ---- */
const CAGE_R = 1;
const BALL_R = 0.135;                         // 90 balls fill roughly the bottom 40 % of the cage
const CAGE_Y = 0.55;                          // cage centre height above the "table"
const CRADLE = new THREE.Vector3(1.22, -0.66, 1.08);   // front-right: the chute is seen in profile on its way here
const CRADLE_SCALE = 1.7;                     // the called ball is shown big enough to read across a room
const TRAY = [new THREE.Vector3(-0.55, -0.76, 1.2), new THREE.Vector3(-0.98, -0.78, 1.18), new THREE.Vector3(-1.36, -0.8, 1.14)];
const TRAY_SCALE = [1.15, 0.95, 0.8];
const TRAY_EXIT = new THREE.Vector3(-1.9, -0.82, 1.08);
const MERIDIANS = 14, RINGS = 3;

/* ---- colour by decade, like a real set ---- */
const DECADE_COLOURS = ['#e63946', '#f4a261', '#e9c46a', '#2a9d8f', '#457b9d', '#8e44ad', '#ff7f50', '#06d6a0', '#118ab2'];
const decadeColour = (n) => DECADE_COLOURS[Math.min(8, Math.floor((n - 1) / 10))];

/* =================== module state =================== */
let host = null, canvas = null, renderer = null, scene = null, camera = null;
let cage = null, cageBalls = new Map();       // number -> mesh (inside the cage)
let cradleBall = null, trayBalls = [];        // meshes outside the cage
let ballGeo = null, textures = new Map();
let rafId = 0, last = 0;
let spin = 0.15, spinTarget = 0.15;           // cage angular speed (rad/s)
let tumble = 0;                               // 0 = balls resting, 1 = full tumble
let drawAnim = null;
let lowEnd = false;
let chuteCurve = null;                        // the ball rides this from the cage to the cradle
const tmpV = new THREE.Vector3();

/* =================== textures =================== */
/** White ball, coloured band, big black number twice (front and back) so one always faces out. */
function ballTexture(n) {
  if (textures.has(n)) return textures.get(n);
  const W = lowEnd ? 256 : 512, H = W / 2;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f7f5f0'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = decadeColour(n);
  ctx.fillRect(0, 0, W, H * 0.16); ctx.fillRect(0, H * 0.84, W, H * 0.16);   // polar caps
  ctx.font = `900 ${Math.round(H * 0.6)}px "Arial Black", Arial, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#111';
  [0.25, 0.75].forEach((u) => {                // two numbers, 180° apart
    ctx.beginPath(); ctx.arc(W * u, H / 2, H * 0.36, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.lineWidth = H * 0.025; ctx.strokeStyle = decadeColour(n); ctx.stroke();
    ctx.fillStyle = '#111'; ctx.fillText(String(n), W * u, H * 0.53);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  textures.set(n, t);
  return t;
}

function makeBall(n) {
  const m = new THREE.Mesh(ballGeo, new THREE.MeshPhysicalMaterial({
    map: ballTexture(n), roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.15,
  }));
  m.castShadow = true;
  m.userData.number = n;
  m.userData.seat = new THREE.Vector3();       // resting spot in the pile
  m.userData.phase = Math.random() * Math.PI * 2;
  m.userData.rate = 0.8 + Math.random() * 0.6;
  m.quaternion.random();                       // balls in the pile lie every which way
  return m;
}

/* =================== scene =================== */
function buildScene() {
  scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.5;
  pmrem.dispose();

  camera = new THREE.PerspectiveCamera(34, 1, 0.1, 50);
  camera.position.set(-0.35, 1.25, 4.7);       // a touch to the left and above so the chute shows in profile
  camera.lookAt(0.05, -0.05, 0.5);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x554433, 0.55));
  const key = new THREE.DirectionalLight(0xfff2e0, 2.2);
  key.position.set(-3, 5, 4); key.castShadow = true;
  key.shadow.mapSize.set(lowEnd ? 1024 : 2048, lowEnd ? 1024 : 2048);
  key.shadow.camera.left = -3; key.shadow.camera.right = 3; key.shadow.camera.top = 3; key.shadow.camera.bottom = -3;
  key.shadow.camera.near = 1; key.shadow.camera.far = 14; key.shadow.bias = -0.0006; key.shadow.normalBias = 0.02;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0xbfd0ff, 0.5); fill.position.set(3, 2, -2); scene.add(fill);

  // table: catches shadows only (page background shows through the transparent canvas)
  const table = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.ShadowMaterial({ opacity: 0.4 }));
  table.rotation.x = -Math.PI / 2; table.position.y = -0.9; table.receiveShadow = true;
  scene.add(table);

  const chrome = new THREE.MeshStandardMaterial({ color: 0xd9dde3, metalness: 0.85, roughness: 0.25 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2320, metalness: 0.3, roughness: 0.6 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 0.8, roughness: 0.3 });

  // ---- the cage: a group that spins about the x axis ----
  cage = new THREE.Group();
  cage.position.y = CAGE_Y;
  const barR = 0.016;
  for (let i = 0; i < MERIDIANS; i += 1) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(CAGE_R, barR, 8, 64), chrome);
    ring.rotation.x = (i / MERIDIANS) * Math.PI;   // meridians about the spin axis (x)
    ring.castShadow = true;
    cage.add(ring);
  }
  for (let j = 1; j <= RINGS; j += 1) {
    const lat = (j / (RINGS + 1) - 0.5) * Math.PI;   // latitude rings perpendicular to x
    const r = Math.cos(lat) * CAGE_R;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, barR * 0.9, 8, 64), chrome);
    ring.rotation.y = Math.PI / 2; ring.position.x = Math.sin(lat) * CAGE_R;
    cage.add(ring);
  }
  // hubs + axle through x
  const hubGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.08, 20);
  [-1, 1].forEach((s) => {
    const hub = new THREE.Mesh(hubGeo, brass); hub.rotation.z = Math.PI / 2; hub.position.x = s * (CAGE_R + 0.02); cage.add(hub);
  });
  scene.add(cage);

  // static: axle, stand, crank, chute, cradle, tray
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, CAGE_R * 2 + 0.7, 12), chrome);
  axle.rotation.z = Math.PI / 2; axle.position.y = CAGE_Y; scene.add(axle);
  [-1, 1].forEach((s) => {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, CAGE_Y + 0.9, 0.08), dark);
    post.position.set(s * (CAGE_R + 0.3), (CAGE_Y - 0.9) / 2, 0); post.castShadow = true; scene.add(post);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.7), dark);
    foot.position.set(s * (CAGE_R + 0.3), -0.87, 0); foot.receiveShadow = true; scene.add(foot);
  });
  const crankArm = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.3, 0.04), chrome);
  crankArm.position.set(CAGE_R + 0.4, CAGE_Y + 0.15, 0); scene.add(crankArm);
  const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.16, 12), dark);
  knob.rotation.z = Math.PI / 2; knob.position.set(CAGE_R + 0.5, CAGE_Y + 0.3, 0); scene.add(knob);
  // chute: an open half-pipe (trough) leaning from the cage's bottom-front opening down to
  // the cradle, open side up so the ball is seen rolling in it. Built as a tube along a curve.
  // Shallow slope so the ball is seen rolling rather than falling: exits the cage at its
  // front-bottom, runs forward and down to the cradle.
  const chutePath = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.05, CAGE_Y - CAGE_R * 0.7, CAGE_R * 0.7),     // just inside the cage's front-bottom
    new THREE.Vector3(0.3, CAGE_Y - CAGE_R * 0.95, CAGE_R * 0.95),
    new THREE.Vector3(0.7, -0.5, 1.08),
    new THREE.Vector3(CRADLE.x - 0.3, CRADLE.y - BALL_R * 0.7, CRADLE.z - 0.02),
  ]);
  chuteCurve = chutePath;
  const chuteMat = chrome.clone(); chuteMat.side = THREE.DoubleSide;
  const chute = new THREE.Mesh(troughGeometry(chutePath, BALL_R * 1.15, 28), chuteMat);
  chute.receiveShadow = true;
  scene.add(chute);
  // cradle ring + tray groove
  const cradle = new THREE.Mesh(new THREE.TorusGeometry(BALL_R * CRADLE_SCALE * 0.95, 0.025, 8, 48), brass);
  cradle.rotation.x = Math.PI / 2; cradle.position.set(CRADLE.x, -0.86, CRADLE.z); scene.add(cradle);
  const tray = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.04, 0.42), dark);
  tray.position.set(-0.95, -0.88, 1.17); tray.receiveShadow = true; scene.add(tray);

  ballGeo = new THREE.SphereGeometry(BALL_R, lowEnd ? 18 : 28, lowEnd ? 12 : 20);
}

/**
 * An open U-shaped trough swept along `curve`: a half-circle cross-section of radius r,
 * open side facing world-up, so a ball rolling in it is seen. Frames use world up, so the
 * opening never twists along the path.
 */
function troughGeometry(curve, r, segs) {
  const pos = [], nor = [], idx = [];
  const p = new THREE.Vector3(), T = new THREE.Vector3(), S = new THREE.Vector3(), n = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const radial = 12;
  for (let i = 0; i <= segs; i += 1) {
    const t = i / segs;
    curve.getPointAt(t, p);
    curve.getTangentAt(t, T).normalize();
    S.crossVectors(T, UP).normalize();          // sideways
    const D = new THREE.Vector3().crossVectors(S, T).normalize();   // "down" relative to the path, ≈ −UP
    for (let j = 0; j <= radial; j += 1) {
      const a = 0.35 + (j / radial) * (Math.PI - 0.7);   // a shallow U: rims below the ball's centre, so the ball shows
      n.copy(S).multiplyScalar(Math.cos(a)).addScaledVector(D, Math.sin(a));
      pos.push(p.x + n.x * r, p.y + n.y * r, p.z + n.z * r);
      nor.push(-n.x, -n.y, -n.z);               // inside surface faces the ball
    }
  }
  for (let i = 0; i < segs; i += 1) {
    for (let j = 0; j < radial; j += 1) {
      const a = i * (radial + 1) + j, b = a + radial + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setIndex(idx);
  return geo;
}

/* =================== the pile =================== */
/**
 * Resting seats for N balls: packed layers at the bottom of the sphere (inside radius
 * CAGE_R − BALL_R), in local cage space. Deterministic for a given N so a restore looks
 * the same as continuous play.
 */
function assignSeats() {
  const balls = [...cageBalls.values()].sort((a, b) => a.userData.number - b.userData.number);
  const inner = CAGE_R - BALL_R * 1.05;
  let i = 0, y = -inner + BALL_R;
  while (i < balls.length) {
    const rowR = Math.sqrt(Math.max(0, inner * inner - y * y)) - BALL_R;   // radius available at this height
    const count = Math.max(1, Math.floor((Math.PI * rowR * rowR) / (Math.PI * BALL_R * BALL_R * 1.35)));
    // fill this layer in rings
    let placed = 0;
    for (let ring = 0; placed < count && i < balls.length; ring += 1) {
      const rr = ring * BALL_R * 2.15;
      if (rr > rowR + 1e-6 && ring > 0) break;
      const n = ring === 0 ? 1 : Math.floor((Math.PI * 2 * rr) / (BALL_R * 2.15));
      for (let k = 0; k < n && i < balls.length && placed < count; k += 1, i += 1, placed += 1) {
        const a = (k / n) * Math.PI * 2 + ring * 0.7;
        balls[i].userData.seat.set(Math.cos(a) * rr, y, Math.sin(a) * rr);
      }
    }
    y += BALL_R * 1.85;
  }
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
    console.error('3D cage unavailable:', err);
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
  // keep the whole rig (cage + tray, ~3.6 wide, ~2.9 tall) in frame whatever the aspect
  camera.fov = camera.aspect < 1 ? 34 / camera.aspect : 34;
  camera.updateProjectionMatrix();
}

/**
 * Rebuild the scene to match the game: `remaining` numbers in the cage, the last of
 * `drawn` in the cradle, the three before it in the tray. No animation (restore / sync).
 */
export function setPool(remaining, drawn) {
  if (!scene) return;
  if (drawAnim) finishDraw();
  // Already showing exactly this? (renderCallerUi calls this after every draw.)
  const recentWant = drawn.slice(-4).reverse();
  const recentHave = [cradleBall, ...trayBalls].filter(Boolean).map((m) => m.userData.number);
  const sameRecent = recentWant.length === recentHave.length && recentWant.every((n, i) => n === recentHave[i]);
  const sameCage = remaining.length === cageBalls.size && remaining.every((n) => cageBalls.has(n));
  if (sameRecent && sameCage) return;
  // cage
  const want = new Set(remaining);
  for (const [n, m] of cageBalls) if (!want.has(n)) { cage.remove(m); m.material.dispose(); cageBalls.delete(n); }
  for (const n of remaining) if (!cageBalls.has(n)) { const m = makeBall(n); cage.add(m); cageBalls.set(n, m); }
  assignSeats();
  for (const m of cageBalls.values()) m.position.copy(m.userData.seat);
  // cradle + tray
  [cradleBall, ...trayBalls].forEach((m) => { if (m) { scene.remove(m); m.material.dispose(); } });
  cradleBall = null; trayBalls = [];
  const recent = drawn.slice(-4).reverse();              // newest first
  recent.forEach((n, i) => {
    const m = makeBall(n);
    if (i === 0) { m.position.copy(CRADLE); m.scale.setScalar(CRADLE_SCALE); faceCamera(m); cradleBall = m; }
    else { m.position.copy(TRAY[i - 1]); m.scale.setScalar(TRAY_SCALE[i - 1]); faceCamera(m); trayBalls.push(m); }
    scene.add(m);
  });
  tumble = 0; spinTarget = 0.15;
}

/** Turn a ball so one of its two numbers faces the camera squarely. */
function faceCamera(m) {
  // SphereGeometry maps texture u=0.25 (the first number) to +z, i.e. straight at the
  // camera, with identity rotation; just tilt it up a little toward the raised camera.
  m.quaternion.identity();
  m.rotateX(-0.22);
}

/**
 * Draw `number`: spin up, tumble, drop the ball through the chute into the cradle, and
 * shift the tray. Resolves when the ball is seated (DRAW_MS).
 */
export function draw(number) {
  if (!scene) return Promise.resolve();
  if (drawAnim) finishDraw();
  let ball = cageBalls.get(number);
  if (!ball) { ball = makeBall(number); cage.add(ball); cageBalls.set(number, ball); }   // defensive: always something to drop
  return new Promise((resolve) => {
    drawAnim = { start: performance.now(), number, ball, resolve, phase: 0, prevCradle: cradleBall, prevTray: trayBalls.slice(), exiting: null };
    cradleBall = null;
    drawAnim.timer = setTimeout(finishDraw, DRAW_MS + 100);
  });
}

function finishDraw() {
  const a = drawAnim; if (!a) return;
  drawAnim = null; clearTimeout(a.timer);
  // final state, exactly as setPool would leave it
  const b = a.ball;
  if (b.parent === cage) { cage.remove(b); cageBalls.delete(a.number); scene.add(b); }
  b.position.copy(CRADLE); b.scale.setScalar(CRADLE_SCALE); faceCamera(b); cradleBall = b;
  const tray = [a.prevCradle, ...a.prevTray].filter(Boolean);
  tray.forEach((m, i) => {
    if (i >= 3) { scene.remove(m); m.material.dispose(); return; }
    m.position.copy(TRAY[i]); m.scale.setScalar(TRAY_SCALE[i]); faceCamera(m);
  });
  trayBalls = tray.slice(0, 3);
  assignSeats();
  tumble = 0; spinTarget = 0.15;
  a.resolve();
}

/* =================== per-frame =================== */
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const clamp01 = (t) => Math.max(0, Math.min(1, t));

function frame(now) {
  rafId = requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (drawAnim) tickDraw(now, dt);
  // cage spin
  spin += (spinTarget - spin) * Math.min(1, dt * 4);
  cage.rotation.x += spin * dt;
  // balls: blend between resting seats (counter-rotated so the pile stays at the bottom
  // while the cage turns) and a tumbling orbit
  const invCage = tmpV;   // reuse
  const t = now / 1000;
  for (const m of cageBalls.values()) {
    if (drawAnim && m === drawAnim.ball && drawAnim.phase >= 1) continue;
    const u = m.userData;
    // seat in world = cage.position + seat (pile does not rotate with the cage)
    const seat = u.seat;
    // tumbling position: swept up the wall in the spin direction, jittering
    const ang = u.phase + t * (2.2 + spin * 0.8) * u.rate;
    const r = (CAGE_R - BALL_R * 1.3) * (0.55 + 0.45 * Math.sin(ang * 0.7 + u.phase));
    const tx = seat.x * 0.6, ty = Math.sin(ang) * r * 0.9, tz = Math.cos(ang) * r;
    // local position must be expressed in cage space (which rotates): counter-rotate the world offset
    invCage.set(seat.x + (tx - seat.x) * tumble, seat.y + (ty - seat.y) * tumble, seat.z + (tz - seat.z) * tumble);
    invCage.applyAxisAngle(new THREE.Vector3(1, 0, 0), -cage.rotation.x);
    m.position.copy(invCage);
    m.rotation.x -= spin * dt * 3 * (0.3 + tumble);
  }
  if (document.hidden || !canvas || canvas.clientWidth === 0) return;
  renderer.render(scene, camera);
}

function tickDraw(now, dt) {
  const a = drawAnim;
  const k = clamp01((now - a.start) / DRAW_MS);
  // 0.00–0.35 spin up + tumble; 0.35–0.60 slow, chosen ball to the chute mouth;
  // 0.60–0.85 drop through chute into the cradle; 0.60–1.00 tray shift
  if (k < 0.35) {
    spinTarget = 5.5; tumble = Math.min(1, tumble + dt * 4);
  } else if (k < 0.6) {
    spinTarget = 1.2; tumble = Math.max(0, tumble - dt * 2.5);
    if (a.phase < 1) {
      a.phase = 1;
      // hand the ball to the scene so it is no longer carried by the cage
      const wp = a.ball.getWorldPosition(new THREE.Vector3());
      cage.remove(a.ball); cageBalls.delete(a.number); scene.add(a.ball); a.ball.position.copy(wp);
      a.from = wp.clone();
    }
    const s = easeInOut((k - 0.35) / 0.25);
    // to the chute mouth at the bottom-front of the cage
    tmpV.set(0.05, CAGE_Y - CAGE_R * 0.7 + BALL_R * 0.4, CAGE_R * 0.7);
    a.ball.position.lerpVectors(a.from, tmpV, s);
    a.ball.rotation.x += dt * 8;
  } else {
    spinTarget = 0.15;
    const s = clamp01((k - 0.6) / 0.25);
    const e = easeOut(s);
    // down the chute (a quarter-arc) to the cradle
    // rides the chute's own curve, sitting on its floor, growing to cradle size on the way
    chuteCurve.getPointAt(e, tmpV);
    tmpV.y += BALL_R * (0.7 + 0.6 * e);
    a.ball.position.copy(tmpV);
    a.ball.scale.setScalar(1 + (CRADLE_SCALE - 1) * e);
    // rolling down: turn about x, then snap the number to the camera as it seats
    if (s < 1) { a.ball.rotation.x += dt * 9 * (1 - s); a.ball.rotation.z -= dt * 4 * (1 - s); }
    else faceCamera(a.ball);
    // tray shift: previous cradle → slot 0, slots shift, last one exits and fades
    const ts = easeInOut(clamp01((k - 0.6) / 0.4));
    const chain = [a.prevCradle, ...a.prevTray].filter(Boolean);
    chain.forEach((m, i) => {
      const from = i === 0 ? CRADLE : TRAY[i - 1];
      const fromS = i === 0 ? CRADLE_SCALE : TRAY_SCALE[i - 1];
      const to = i < 3 ? TRAY[i] : TRAY_EXIT;
      const toS = i < 3 ? TRAY_SCALE[i] : 0.3;
      m.position.lerpVectors(from, to, ts);
      m.scale.setScalar(fromS + (toS - fromS) * ts);
      if (i >= 3) { m.material.transparent = true; m.material.opacity = 1 - ts; }
    });
  }
  if (k >= 1) finishDraw();
}

export function dispose() {
  if (rafId) cancelAnimationFrame(rafId); rafId = 0;
  if (drawAnim) finishDraw();
  textures.forEach((t) => t.dispose()); textures.clear();
  renderer?.dispose(); renderer = null; scene = null; cage = null;
  cageBalls = new Map(); cradleBall = null; trayBalls = [];
  canvas?.remove(); canvas = null;
}
