// 《擺手起家》虛擬畫面：揮手吹出風場（照「擺手起家 波動模擬器」的互動）
// 版本：v3.0（2026-11-01）
// 雙手版（左手木琴、右手捏住）保留在 HTML版_指感受_一排五片/sketch.js，沒有改動。
//
// 互動：
//   鏡頭看到手在「揮」→ 手的動作吹出一陣風，把星點往揮的方向吹開（不分左右手，兩隻手都可以）
//   手在畫面哪一欄（左右分 5 欄）→ 實體那一片亮提示燈，邀請現場的人來抓
//   手的高度 → 畫面由下到上是一條音階，手經過哪一條線就彈出那個音
//   每片陶片在畫面上是一顆光點：x = 它那一欄，y = 它的高度；光點經過音階線也會響
//   現場有人抓住陶片 → 那顆光點把星點吸過去（越抓越久吸越強，外圈的弧 = 蓄力）
//   放開 → 在那顆光點炸開星空＋和弦；如果抓的時候提示燈正亮著（回應了對方），多一圈慢慢擴散的漣漪
// 裝置連線用 Device（USB 版 device.js、Apps Script 版 Remote、MQTT 版 remote_mqtt.js 都可以，用法一樣）。

// ===== 參數 =====
const VIDEO_W = 320, VIDEO_H = 240;
const PARTICLES = 900;
const Y_LOW = 0.9, Y_HIGH = 0.1;         // 陶片最低 → 畫面 90% 高；最高 → 10%（相對座標）
const WAVE_MIN_SPEED = 6;                 // 手每一格移動超過這麼多像素才算「在揮」
const WIND_RADIUS = 260;                  // 風吹得到的範圍（以 1200 寬的畫面為準）
const WIND_POWER = 0.09;                  // 風力
const SCALE = ['D3', 'A3', 'Bb3', 'C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'C5'];   // 手碟 D Kurd
const COLORS = [[25, 25, 112], [65, 105, 225], [30, 191, 255], [255, 215, 0], [255, 140, 0], [72, 61, 139]];

let started = false;
let video, handPose, hands = [];
let parts = [], ripples = [];
let lineFlash = new Array(SCALE.length).fill(0);
let handState = [];                        // 每隻手：{x, y, vx, vy, note, lastPlay, waving}
let shardNote = [-1, -1, -1, -1, -1], shardPlay = [0, 0, 0, 0, 0];
let hintUntil = [0, 0, 0, 0, 0];
let voices = null;
let K = 1;                                 // 畫面縮放（以 1200 寬為準）

function preload() {
  handPose = ml5.handPose({ flipped: true, maxHands: 2 });
}

function setup() {
  createCanvas(windowWidth, windowHeight);
  K = width / 1200;
  video = createCapture(VIDEO);
  video.size(VIDEO_W, VIDEO_H);
  video.hide();
  handPose.detectStart(video, r => { hands = r; });
  for (let i = 0; i < PARTICLES; i++) parts.push(spawn(true));
  background(10, 10, 30);

  const startBtn = document.getElementById('startButton');
  if (startBtn) startBtn.onclick = async () => {
    await Tone.start();
    setupSound();
    started = true;
    startBtn.style.display = 'none';
    const panel = document.getElementById('instruction-panel');
    if (panel) panel.style.opacity = '1';
  };
  const devBtn = document.getElementById('deviceButton');
  if (devBtn) devBtn.onclick = async () => {
    if (Device.connected) { await Device.disconnect(); devBtn.textContent = '連接裝置'; }
    else if (await Device.connect()) devBtn.textContent = '中斷裝置';
  };

  Device.onGrab = (k) => { if (started) { const c = shardPoint(k); ripples.push({ x: c.x, y: c.y, r: 0, a: 0.8, w: 2, sp: 6, fade: 0.03 }); } };
  Device.onRelease = (k, charge, answered) => { if (started) releaseShard(k, charge, answered); };
}

// ===== 聲音：每片陶片一個聲部，加一個給手；左右聲道跟著 x =====
function setupSound() {
  if (voices) return;
  const limiter = new Tone.Limiter(-1).toDestination();
  const reverb = new Tone.Reverb({ decay: 4, wet: 0.45 }).connect(limiter);
  voices = [];
  for (let i = 0; i < 6; i++) {
    const pan = new Tone.Panner(0).connect(reverb);
    const s = new Tone.PolySynth(Tone.Synth, {
      maxPolyphony: 4, oscillator: { type: i === 5 ? 'triangle' : 'sine' },
      envelope: { attack: 0.01, decay: 0.8, sustain: 0.05, release: 1.8 },
    }).connect(pan);
    s.volume.value = -9;
    voices.push({ s, pan });
  }
}
function play(vi, note, vel, dur, xRel) {
  if (!voices) return;
  const v = voices[vi];
  v.pan.pan.value = (xRel - 0.5) * 1.6;
  v.s.triggerAttackRelease(note, dur, undefined, vel);
}

// ===== 座標 =====
const lineY = n => (Y_LOW - (Y_LOW - Y_HIGH) * n / (SCALE.length - 1)) * height;
const noteAtY = y => constrain(round((Y_LOW - y / height) / (Y_LOW - Y_HIGH) * (SCALE.length - 1)), 0, SCALE.length - 1);
const columnAt = x => constrain(floor(x / width * Device.N), 0, Device.N - 1) + 1;
function shardPoint(k) {
  const h = Device.isAlive() ? Device.heightOf(k) : 0;
  return { x: (k - 0.5) / Device.N * width, y: (Y_LOW - (Y_LOW - Y_HIGH) * h) * height };
}

// ===== 星點 =====
function spawn(first) {
  const life = random(150, 300);
  return { x: random(width), y: random(height), vx: 0, vy: 0, size: random(2, 7), col: random(COLORS), life, age: first ? random(life) : 0, boom: 0 };
}
function field(x, y, t) { return sin(x * 0.004 + t * 0.2) * 1.7 + cos(y * 0.005 - t * 0.15) * 1.3 + sin((x + y) * 0.002 + t * 0.1); }
function explode(cx, cy, power, radius) {
  for (const p of parts) {
    const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy);
    if (d < radius && d > 0.01) { p.vx = dx / d * power * random(0.8, 1.2); p.vy = dy / d * power * random(0.8, 1.2); p.boom = 45; p.age = 0; }
  }
}

// ===== 手：揮手 = 風 =====
function updateHands() {
  const now = millis();
  const seen = [];
  for (let i = 0; i < hands.length; i++) {
    const kp = hands[i].keypoints;
    if (!kp || kp.length < 21) continue;
    let x = 0, y = 0;
    for (const j of [0, 5, 9, 13, 17]) { x += kp[j].x; y += kp[j].y; }
    seen.push({ x: map(x / 5, 0, VIDEO_W, 0, width), y: map(y / 5, 0, VIDEO_H, 0, height) });
  }
  // 依距離配對上一格的手，算出速度
  const next = [];
  for (const s of seen) {
    let best = null, bd = 1e9;
    for (const h of handState) { const d = dist(h.x, h.y, s.x, s.y); if (d < bd && next.indexOf(h) < 0) { bd = d; best = h; } }
    if (best && bd < 300 * K) {
      const nx = lerp(best.x, s.x, 0.4), ny = lerp(best.y, s.y, 0.4);
      best.vx = lerp(best.vx, nx - best.x, 0.5); best.vy = lerp(best.vy, ny - best.y, 0.5);
      best.x = nx; best.y = ny;
      next.push(best);
    } else {
      next.push({ x: s.x, y: s.y, vx: 0, vy: 0, note: -1, lastPlay: 0, waving: false });
    }
  }
  handState = next;

  for (const h of handState) {
    h.waving = Math.hypot(h.vx, h.vy) > WAVE_MIN_SPEED * K;
    if (!h.waving) continue;
    const col = columnAt(h.x);
    Device.hint(col);                                   // 實體那一片亮提示燈
    hintUntil[col - 1] = now + 2600;
    const n = noteAtY(h.y);                             // 手的高度彈出音
    if (n !== h.note && now - h.lastPlay > 80) {
      play(5, SCALE[n], 0.16, '8n', h.x / width);
      lineFlash[n] = 1; h.note = n; h.lastPlay = now;
    }
  }
}

function applyWind(p) {
  for (const h of handState) {
    if (!h.waving) continue;
    const dx = p.x - h.x, dy = p.y - h.y, d = Math.hypot(dx, dy), R = WIND_RADIUS * K;
    if (d > R || d < 1) continue;
    const f = 1 - d / R;
    p.vx += h.vx * WIND_POWER * f + dx / d * f * 0.6 * K;   // 順著揮的方向吹，再往外撥開
    p.vy += h.vy * WIND_POWER * f + dy / d * f * 0.6 * K;
  }
}

// ===== 陶片 =====
function updateShards() {
  if (!Device.isAlive() || !Device.protoOk()) return;
  const now = millis();
  for (let k = 1; k <= Device.N; k++) {
    const c = shardPoint(k), n = noteAtY(c.y);
    if (n !== shardNote[k - 1]) {
      if (shardNote[k - 1] >= 0 && !Device.isGrabbed(k) && now - shardPlay[k - 1] > 80) {
        play(k - 1, SCALE[n], n > shardNote[k - 1] ? 0.3 : 0.18, '8n', c.x / width);
        lineFlash[n] = 1; shardPlay[k - 1] = now;
        ripples.push({ x: c.x, y: c.y, r: 0, a: 0.6, w: 1.5, sp: 4, fade: 0.03 });
      }
      shardNote[k - 1] = n;
    }
  }
}

function releaseShard(k, charge, answered) {
  const c = shardPoint(k);
  ripples.push({ x: c.x, y: c.y, r: 0, a: 1, w: 3, sp: 9, fade: 0.025 });
  if (answered) ripples.push({ x: c.x, y: c.y, r: 0, a: 0.8, w: 6, sp: 5, fade: 0.012 });
  explode(c.x, c.y, (5 + 10 * charge) * K, (150 + 220 * charge) * K);
  const n = noteAtY(c.y);
  play(k - 1, SCALE[n], 0.35 + 0.45 * charge, '1n', c.x / width);
  if (n + 2 < SCALE.length) setTimeout(() => play(k - 1, SCALE[n + 2], 0.25 + 0.3 * charge, '1n', c.x / width), 70);
  if (n + 4 < SCALE.length) setTimeout(() => play(k - 1, SCALE[n + 4], 0.2 + 0.3 * charge, '1n', c.x / width), 140);
}

// ===== 畫面 =====
function draw() {
  if (!started) return;
  const t = millis() / 1000, now = millis();
  noStroke();
  fill(10, 10, 30, 51);
  rect(0, 0, width, height);

  updateHands();
  updateShards();

  // 亮提示燈的那一欄：整欄淡淡的光
  const colW = width / Device.N;
  for (let k = 1; k <= Device.N; k++) if (hintUntil[k - 1] > now) { fill(242, 196, 109, 16); rect((k - 1) * colW, 0, colW, height); }

  // 被抓住的陶片把星點吸過去
  const sinks = [];
  if (Device.isAlive() && Device.protoOk()) for (let k = 1; k <= Device.N; k++) if (Device.isGrabbed(k)) sinks.push({ ...shardPoint(k), s: 0.5 + 3.5 * Device.chargeOf(k) });

  noStroke();
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.boom > 0) { p.boom--; p.vx *= 0.94; p.vy *= 0.94; }
    else {
      const a = field(p.x, p.y, t);
      p.vx += cos(a) * 0.05 * K; p.vy += sin(a) * 0.05 * K;
      for (const s of sinks) { const dx = s.x - p.x, dy = s.y - p.y, d = Math.hypot(dx, dy), R = 420 * K; if (d < R && d > 1) { const f = s.s * 1.5 * (1 - d / R) * 0.12 * K; p.vx += dx / d * f; p.vy += dy / d * f; } }
      applyWind(p);
      const sp = Math.hypot(p.vx, p.vy), lim = 5 * K;
      if (sp > lim) { p.vx *= lim / sp; p.vy *= lim / sp; }
      p.vx *= 0.97; p.vy *= 0.97;
      if (++p.age > p.life) { parts[i] = spawn(false); continue; }
    }
    p.x += p.vx; p.y += p.vy;
    if (p.x < 0) p.x += width; if (p.x > width) p.x -= width; if (p.y < 0) p.y += height; if (p.y > height) p.y -= height;
    const al = p.boom > 0 ? 255 : min(1, p.age / 20, (p.life - p.age) / 30) * 204;
    fill(p.col[0], p.col[1], p.col[2], al);
    circle(p.x, p.y, p.size * K * 1.8);
  }

  drawScaleLines();
  drawShards();
  drawRipples();
  drawHands();
  drawDeviceMap();
  for (let n = 0; n < lineFlash.length; n++) lineFlash[n] = max(0, lineFlash[n] - deltaTime / 1000 * 2.2);
}

// 音階線：剛響過的那一條變粗變亮，音名變大
function drawScaleLines() {
  textFont('monospace');
  textAlign(LEFT, CENTER);
  for (let n = 0; n < SCALE.length; n++) {
    const y = lineY(n), f = lineFlash[n];
    stroke(232, 233, 246, 36 + 140 * f); strokeWeight((1 + 3 * f) * K);
    line(56 * K, y, width, y);
    noStroke(); fill(232, 233, 246, 140 + 115 * f);
    textSize(16 * K * (1 + 0.25 * f));
    text(SCALE[n], 8 * K, y);
  }
}

// 每片陶片的光點：x = 那一欄，y = 高度；被抓住時外圈的弧 = 蓄力
function drawShards() {
  if (!Device.isAlive() || !Device.protoOk()) return;
  for (let k = 1; k <= Device.N; k++) {
    const c = shardPoint(k), grabbed = Device.isGrabbed(k), q = Device.chargeOf(k);
    stroke(144, 149, 191, 50); strokeWeight(1);
    drawingContext.setLineDash([4 * K, 6 * K]);
    line(c.x, Y_HIGH * height, c.x, Y_LOW * height);
    drawingContext.setLineDash([]);
    noStroke();
    const glow = grabbed ? 0.4 + 0.6 * q : (hintUntil[k - 1] > millis() ? 0.5 : 0.15);
    for (let r = 3; r >= 1; r--) { fill(255, 220, 160, 40 * glow); circle(c.x, c.y, (20 + 30 * glow) * r * K); }
    fill(232, 233, 246); circle(c.x, c.y, 8 * K + 2);
    if (grabbed) { noFill(); stroke(255, 220, 170, 200); strokeWeight(2 * K); const R = (36 + 80 * q) * K; arc(c.x, c.y, R, R, -HALF_PI, -HALF_PI + TWO_PI * max(0.02, q)); }
    noStroke(); fill(232, 233, 246, 220);
    textFont('monospace'); textSize(18 * K); textAlign(LEFT, BASELINE);
    text(SCALE[noteAtY(c.y)], c.x + 12 * K, c.y - 10 * K);
    textFont('sans-serif'); textSize(20 * K); textAlign(CENTER, BASELINE);
    text(k, c.x, 0.965 * height);
  }
}

function drawRipples() {
  noFill();
  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i];
    r.r += r.sp * K; r.a -= r.fade;
    if (r.a <= 0) { ripples.splice(i, 1); continue; }
    stroke(242, 214, 160, 255 * r.a); strokeWeight(r.w * K);
    circle(r.x, r.y, r.r * 2);
  }
}

// 手：一圈＋音名；在揮的時候外圈變大
function drawHands() {
  textFont('monospace'); textSize(18 * K); textAlign(LEFT, CENTER);
  for (const h of handState) {
    noFill(); stroke(143, 227, 210, h.waving ? 200 : 90); strokeWeight(2 * K);
    circle(h.x, h.y, (h.waving ? 120 : 60) * K);
    noStroke(); fill(232, 233, 246, 220);
    text('手 ' + SCALE[noteAtY(h.y)], h.x + 66 * K, h.y);
  }
  stroke(144, 149, 191, 40); strokeWeight(1);
  for (let i = 1; i < Device.N; i++) line(i * width / Device.N, 0, i * width / Device.N, height);
}

// 右下角：裝置狀態＋一排 5 格高度（被抓住的那格加粗外框，不靠顏色）
function drawDeviceMap() {
  const s = 30, gap = 4, pad = 14, w = s * Device.N + gap * (Device.N - 1);
  const x0 = width - w - pad, y0 = height - s - pad - 96;
  push();
  textFont('sans-serif'); textSize(11); noStroke(); fill(255, 160); textAlign(RIGHT, BOTTOM);
  let status;
  if (!Device.connected) status = '裝置：未連接';
  else if (!Device.isAlive()) status = '裝置：沒有回應';
  else if (!Device.protoOk()) status = '裝置：韌體版本不對（' + Device.firmware + '）';
  else status = '裝置：正常 ' + Device.firmware;
  text(status, x0 + w, y0 - 6);
  const ok = Device.isAlive() && Device.protoOk();
  for (let k = 1; k <= Device.N; k++) {
    const x = x0 + (k - 1) * (s + gap), y = y0, h = ok ? Device.heightOf(k) : 0;
    stroke(255, 90); strokeWeight(1); noFill(); rect(x, y, s, s);
    noStroke(); fill(255, 200); rect(x + 1, y + s - 1 - (s - 2) * h, s - 2, (s - 2) * h);
    fill(255, 230); textAlign(LEFT, TOP); text(k, x + 3, y + 2);
    if (ok && Device.isGrabbed(k)) { noFill(); stroke(255); strokeWeight(3); rect(x - 3, y - 3, s + 6, s + 6); }
  }
  pop();
}

function keyPressed() {
  if (key === 'f' || key === 'F') fullscreen(!fullscreen());
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  K = width / 1200;
}
