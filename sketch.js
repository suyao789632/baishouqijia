// 《指・感受》HTML 版 ＋ 一排 5 片可以被抓的陶片
// 版本：v2.0（2026-10-31）  對應韌體 Row5TouchWave v3.0（118軟結構TPU/一排五片陶片_觸碰波浪）
// 以陳書瑤的 p5 作品（editor.p5js.org/susan20050705/sketches/oXS2teNXt）為基礎。
// 【新增】標記的地方是和裝置連動的部分，其他維持原作（雙手手勢、聲音、粒子都沒有改）。
// 九宮格 v2.7 的版本留在 HTML版_指感受/，沒有改動。
//
// 裝置連動（照「擺手起家 波動模擬器」的規則）：
//   畫面左右平均分成 5 欄 = 一排 5 片陶片（x 軸）
//   陶片的實際高度 = 它在畫面上那顆光點的 y 位置；光點越過木琴的音階，就輕輕響一聲
//   虛擬端的手在哪一欄撥粒子 → 實體那一片亮提示燈，邀請現場的人來抓
//   現場的人抓住陶片 → 那一片立刻停住（韌體做），畫面上它的光點把星星吸過去、越吸越強（蓄力）
//   放開 → 在那片的光點炸開星空＋手碟和弦；如果是「回應了提示燈」，多一圈慢慢擴散的漣漪
//   陶片自己跑一排波浪（網頁送 T）；網頁沒接時，韌體自己跑一樣的波浪
//   畫面右下角的小圖：每片的編號、高度條、被抓住的外框（不靠顏色）

// === 參數設定 ===
const VIDEO_W = 320;
const VIDEO_H = 240;
const PINCH_THRESHOLD = 60;
const PINCH_FULL_MS = 2000;   // 【新增】捏住多久陶片升到頂（和黑洞強度同步）

// === 粒子與流場 ===
let particles = [];
let cols, rows, flowField, scl = 60, zoff = 0;
let maxParticles = 1500;
let started = false;

// === 手部追蹤 ===
let video;
let handPose;
let hands = [];
let rightHandIndex = -1;
let leftHandIndex = -1;
let rightHandPos = { x: -1000, y: -1000 };
let leftHandPos = { x: -1000, y: -1000 };
let isPinching = false, wasPinching = false;
let holdStartTime = 0;
let blackHoleStrength = 0;
let ripples = [];

// 平滑係數：越小越滑順，但反應會慢一點（0.1 ~ 0.3 較佳）
let smoothFactor = 0.2;

// === 聲音 ===
let handpanSynth, xylophoneSynth, reverb, delayEffect;
let limiter, compressor;
let currentXyloNote = "";
let lastXyloTrigger = 0;

// 星空色系
let starryColors = [
  [25, 25, 112], [65, 105, 225], [30, 191, 255],
  [255, 215, 0], [255, 140, 0], [72, 61, 139]
];
let handpanScale = ["D4", "F4", "A4", "Bb4", "C5", "D5", "E5", "F5", "A5"];
let xyloScale = ["D3", "F3", "G3", "A3", "C4", "D4", "F4", "G4", "A4", "C5", "D5", "F5", "G5"];

function preload() {
  handPose = ml5.handPose({ flipped: true, maxHands: 2 });
}

function setup() {
  createCanvas(windowWidth, windowHeight);

  video = createCapture(VIDEO);
  video.size(VIDEO_W, VIDEO_H);
  video.hide();

  handPose.detectStart(video, gotHands);

  initFlowField();

  for (let i = 0; i < maxParticles; i++) {
    particles.push(new Particle(random(width), random(height), true));
  }

  background(10, 10, 30);

  // === 聲音架構 ===
  limiter = new Tone.Limiter(-1).toDestination();
  compressor = new Tone.Compressor({
    threshold: -20, ratio: 3, attack: 0.05, release: 0.2
  }).connect(limiter);

  reverb = new Tone.Reverb({ decay: 4, wet: 0.5 }).connect(compressor);
  delayEffect = new Tone.FeedbackDelay("8n", 0).connect(reverb);

  handpanSynth = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 6,
    oscillator: { type: "sine" },
    envelope: { attack: 0.01, decay: 0.8, sustain: 0.05, release: 2 }
  }).connect(reverb);
  handpanSynth.volume.value = -2;

  xylophoneSynth = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 6,
    oscillator: { type: "sine" },
    envelope: { attack: 0.005, decay: 0.2, sustain: 0, release: 1.0 }
  }).connect(delayEffect);
  xylophoneSynth.volume.value = -2;

  const startBtn = document.getElementById("startButton");
  if (startBtn) {
    startBtn.onclick = async () => {
      await Tone.start();
      started = true;
      startBtn.style.display = "none";
      let panel = document.getElementById("instruction-panel");
      if (panel) panel.style.opacity = "1";
      fullscreen(true);
    };
  }

  // 【新增】連接裝置
  const devBtn = document.getElementById("deviceButton");
  if (devBtn) {
    devBtn.onclick = async () => {
      if (Device.connected) {
        await Device.disconnect();
        devBtn.textContent = "連接裝置";
      } else if (await Device.connect()) {
        devBtn.textContent = "中斷裝置";
      }
    };
  }

  // 【新增】現場的人抓住／放開陶片（韌體回報 G / P）
  Device.onGrab = (k, answered) => {
    if (!started) return;
    const c = shardPoint(k);
    ripples.push(new Ripple(c.x, c.y, 80));
  };
  Device.onRelease = (k, charge, answered) => {
    if (!started) return;
    releaseShard(k, charge, answered);
  };
}

function gotHands(results) {
  hands = results;
  rightHandIndex = -1;
  leftHandIndex = -1;
  for (let i = 0; i < hands.length; i++) {
    let label = hands[i].handedness;
    if (label === 'Right') rightHandIndex = i;
    else if (label === 'Left') leftHandIndex = i;
  }
}

function draw() {
  if (!started) return;

  // 背景半透明，留下殘影
  background(10, 10, 30, 50);

  updateHandLogic();
  updateDevice();   // 【新增】

  // 流場計算
  let yoff = 0;
  for (let y = 0; y < rows; y++) {
    let xoff = 0;
    for (let x = 0; x < cols; x++) {
      let index = x + y * cols;
      let angle = noise(xoff, yoff, zoff) * TWO_PI * 2;
      let v = flowField[index];
      v.set(cos(angle), sin(angle));
      v.mult(0.3);
      xoff += 0.1;
    }
    yoff += 0.1;
  }
  zoff += 0.001;

  drawDeviceGlow();   // 【新增】陶片高度在畫面上的微光
  drawVisuals();

  let repelRadius = 0;
  if (leftHandIndex !== -1) {
    repelRadius = map(leftHandPos.x, 0, width, 180, 350);
  }

  for (let p of particles) {
    p.follow(flowField);
    // 右手引力
    p.applyAttraction(rightHandPos.x, rightHandPos.y, blackHoleStrength);
    // 【新增】被抓住的陶片：它的光點把星星吸過去，蓄力越多吸越強
    for (const g of grabbedPoints) p.applyAttraction(g.x, g.y, g.s);
    // 左手斥力
    if (leftHandIndex !== -1) {
      p.applyRepulsion(leftHandPos.x, leftHandPos.y, repelRadius);
    }
    p.update();
    p.show();
  }

  for (let i = ripples.length - 1; i >= 0; i--) {
    ripples[i].update();
    ripples[i].show();
    if (ripples[i].finished()) ripples.splice(i, 1);
  }

  drawDeviceMap();   // 【新增】右下角小地圖
}

function updateHandLogic() {
  // --- 右手 ---
  if (rightHandIndex !== -1) {
    let hand = hands[rightHandIndex];
    let indexTip = hand.keypoints[8];
    let thumbTip = hand.keypoints[4];

    let tx = map(indexTip.x, 0, VIDEO_W, 0, width);
    let ty = map(indexTip.y, 0, VIDEO_H, 0, height);

    rightHandPos.x = lerp(rightHandPos.x, tx, smoothFactor);
    rightHandPos.y = lerp(rightHandPos.y, ty, smoothFactor);

    let dx = indexTip.x - thumbTip.x;
    let dy = indexTip.y - thumbTip.y;
    let pinchDistSq = dx * dx + dy * dy;
    let currentPinchState = (pinchDistSq < PINCH_THRESHOLD * PINCH_THRESHOLD);

    if (currentPinchState && !wasPinching) {
      isPinching = true;
      holdStartTime = millis();
    } else if (!currentPinchState && wasPinching) {
      isPinching = false;
      triggerHandpanExplosion();
    }
    wasPinching = currentPinchState;
  }

  // --- 左手 ---
  if (leftHandIndex !== -1) {
    let hand = hands[leftHandIndex];
    let indexTip = hand.keypoints[8];

    let tx = map(indexTip.x, 0, VIDEO_W, 0, width);
    let ty = map(indexTip.y, 0, VIDEO_H, 0, height);

    leftHandPos.x = lerp(leftHandPos.x, tx, smoothFactor);
    leftHandPos.y = lerp(leftHandPos.y, ty, smoothFactor);

    // 音高（用平滑後的 Y）
    let noteIndex = floor(map(leftHandPos.y, height, 0, 0, xyloScale.length));
    noteIndex = constrain(noteIndex, 0, xyloScale.length - 1);
    let targetNote = xyloScale[noteIndex];

    // 音符切換間隔至少 80 毫秒，避免連續觸發
    if (targetNote !== currentXyloNote && millis() - lastXyloTrigger > 80) {
      xylophoneSynth.triggerAttackRelease(targetNote, "32n", undefined, 0.6);
      currentXyloNote = targetNote;
      lastXyloTrigger = millis();
    }

    // 回聲（用平滑後的 X）
    let feedbackAmt = map(leftHandPos.x, 0, width, 0, 0.5);
    feedbackAmt = constrain(feedbackAmt, 0, 0.95);
    delayEffect.feedback.rampTo(feedbackAmt, 0.1);
  }
}

function drawVisuals() {
  noStroke();

  // --- 右手視覺（引力）---
  if (rightHandIndex !== -1) {
    if (isPinching) {
      fill(255, 100, 100, 200);
      ellipse(rightHandPos.x, rightHandPos.y, 20);

      let holdTime = millis() - holdStartTime;
      blackHoleStrength = constrain(map(holdTime, 0, 2000, 0.5, 4.0), 0.5, 4.0);

      noFill();
      stroke(255, 200, 180, 150);
      strokeWeight(2);

      let visualRadius = blackHoleStrength * 120 + random(-3, 3);
      ellipse(rightHandPos.x, rightHandPos.y, visualRadius);

      stroke(255, 100, 100, 80);
      ellipse(rightHandPos.x, rightHandPos.y, visualRadius * 0.7);
    } else {
      fill(255, 200, 200, 150);
      ellipse(rightHandPos.x, rightHandPos.y, 15);
      blackHoleStrength = lerp(blackHoleStrength, 0, 0.15);
    }
  }

  // --- 左手視覺 ---
  if (leftHandIndex !== -1) {
    fill(100, 255, 220, 200);
    ellipse(leftHandPos.x, leftHandPos.y, 20);
    let delayAmount = map(leftHandPos.x, 0, width, 0, 3);
    noFill(); stroke(100, 255, 220, 100); strokeWeight(2);
    ellipse(leftHandPos.x, leftHandPos.y, 60);
    if (delayAmount > 1) ellipse(leftHandPos.x, leftHandPos.y, 80);
    if (delayAmount > 2) ellipse(leftHandPos.x, leftHandPos.y, 100);
    stroke(100, 255, 220, 40);
    line(0, leftHandPos.y, width, leftHandPos.y);
  }
}

function triggerHandpanExplosion() {
  let holdTime = millis() - holdStartTime;
  let power = constrain(map(holdTime, 0, 2000, 5, 15), 5, 15);
  let radius = constrain(map(holdTime, 0, 2000, 150, 350), 150, 350);

  let notes = [random(handpanScale)];
  if (random() > 0.4) notes.push(random(handpanScale));

  let velocity = map(holdTime, 0, 2000, 0.4, 0.8);
  handpanSynth.triggerAttackRelease(notes, "1n", undefined, velocity);

  ripples.push(new Ripple(rightHandPos.x, rightHandPos.y, radius));
  for (let p of particles) p.fireworkExplode(createVector(rightHandPos.x, rightHandPos.y), power, radius);
}

// ===================== 【新增】裝置連動 =====================

const Y_LOW = 0.9, Y_HIGH = 0.1;   // 陶片最低 → 畫面 90% 高的位置；最高 → 10%（相對座標，任何螢幕都對）
let grabbedPoints = [];            // 這一格被抓住的陶片光點 {x, y, s}
let shardNote = [-1, -1, -1, -1, -1];
let shardNoteAt = [0, 0, 0, 0, 0];

// 畫面左右分成 5 欄：x → 第幾片（1～5）
function columnAt(x) { return constrain(floor(x / width * Device.N), 0, Device.N - 1) + 1; }

// 第 k 片陶片在畫面上的光點：x = 那一欄的中間，y = 它的實際高度
function shardPoint(k) {
  const h = Device.isAlive() ? Device.heightOf(k) : 0;
  return { x: (k - 0.5) / Device.N * width, y: (Y_LOW - (Y_LOW - Y_HIGH) * h) * height };
}

// 和左手一樣的木琴音階：畫面由下到上
function noteIndexAtY(y) { return constrain(floor(map(y, height, 0, 0, xyloScale.length)), 0, xyloScale.length - 1); }

function updateDevice() {
  // 虛擬端的手（左手或右手）在哪一欄 → 實體那一片亮提示燈
  if (rightHandIndex !== -1) Device.hint(columnAt(rightHandPos.x));
  if (leftHandIndex !== -1) Device.hint(columnAt(leftHandPos.x));

  grabbedPoints = [];
  if (!Device.isAlive() || !Device.protoOk()) return;
  for (let k = 1; k <= Device.N; k++) {
    const c = shardPoint(k);
    if (Device.isGrabbed(k)) grabbedPoints.push({ x: c.x, y: c.y, s: 0.5 + 3.5 * Device.chargeOf(k) });
    // 陶片升降時，光點越過音階線就輕輕響一聲（被抓住停著時不響）
    const n = noteIndexAtY(c.y);
    if (n !== shardNote[k - 1]) {
      if (shardNote[k - 1] >= 0 && !Device.isGrabbed(k) && millis() - shardNoteAt[k - 1] > 120) {
        xylophoneSynth.triggerAttackRelease(xyloScale[n], "32n", undefined, 0.22);
        shardNoteAt[k - 1] = millis();
      }
      shardNote[k - 1] = n;
    }
  }
}

// 放開：在那片的光點炸開星空、彈以它的音為根音的手碟和弦
function releaseShard(k, charge, answered) {
  const c = shardPoint(k);
  const power = 5 + 10 * charge;
  const radius = 150 + 220 * charge;
  ripples.push(new Ripple(c.x, c.y, radius));
  if (answered) ripples.push(new Ripple(c.x, c.y, radius * 1.6, 5, 4));   // 回應了提示燈：一圈慢慢擴散的漣漪
  for (const p of particles) p.fireworkExplode(createVector(c.x, c.y), power, radius);
  const root = constrain(floor(map(c.y, height, 0, 0, handpanScale.length)), 0, handpanScale.length - 1);
  const chord = [handpanScale[root]];
  if (root + 2 < handpanScale.length) chord.push(handpanScale[root + 2]);
  if (root + 4 < handpanScale.length) chord.push(handpanScale[root + 4]);
  handpanSynth.triggerAttackRelease(chord, "1n", undefined, 0.4 + 0.4 * charge);
}

// 每片陶片的光點：高度＝y；被抓住時外圈的弧＝蓄力多少（不靠顏色）
function drawDeviceGlow() {
  if (!Device.isAlive() || !Device.protoOk()) return;
  for (let k = 1; k <= Device.N; k++) {
    const c = shardPoint(k);
    const grabbed = Device.isGrabbed(k), q = Device.chargeOf(k);
    noStroke();
    for (let r = 3; r >= 1; r--) {
      fill(255, 220, 160, grabbed ? 40 + 50 * q : 22);
      ellipse(c.x, c.y, (18 + (grabbed ? 40 * q : 0)) * r);
    }
    fill(255, 240);
    ellipse(c.x, c.y, 8);
    if (grabbed) {
      noFill(); stroke(255, 220, 170, 220); strokeWeight(2);
      const R = 36 + 80 * q;
      arc(c.x, c.y, R, R, -HALF_PI, -HALF_PI + TWO_PI * max(0.02, q));
    }
  }
}

// 右下角小圖：一排 5 格，編號、高度條；被抓住的那格加粗外框
function drawDeviceMap() {
  const s = 30, gap = 4, pad = 14;
  const w = s * Device.N + gap * (Device.N - 1);
  const x0 = width - w - pad, y0 = height - s - pad - 96;
  push();
  textFont('sans-serif');
  textSize(11);
  noStroke();
  fill(255, 160);
  textAlign(RIGHT, BOTTOM);
  let status;
  if (!Device.connected) status = '裝置：未連接';
  else if (!Device.isAlive()) status = '裝置：沒有回應（剛連線請等 3 秒）';
  else if (!Device.protoOk()) status = '裝置：韌體版本不對（' + Device.firmware + '），請上傳 Row5TouchWave';
  else if (Device.error > 1) status = '裝置：錯誤碼 ' + Device.error;
  else status = '裝置：正常 ' + Device.firmware;
  text(status, x0 + w, y0 - 6);

  for (let k = 1; k <= Device.N; k++) {
    const x = x0 + (k - 1) * (s + gap), y = y0;
    const ok = Device.isAlive() && Device.protoOk();
    const h = ok ? Device.heightOf(k) : 0;
    stroke(255, 90); strokeWeight(1); noFill();
    rect(x, y, s, s);
    noStroke();
    fill(255, 200);
    rect(x + 1, y + s - 1 - (s - 2) * h, s - 2, (s - 2) * h);
    fill(255, 230); textAlign(LEFT, TOP); text(k, x + 3, y + 2);
    if (ok && Device.isGrabbed(k)) { noFill(); stroke(255); strokeWeight(3); rect(x - 3, y - 3, s + 6, s + 6); }
  }
  pop();
}

// ===================== 粒子 =====================
class Particle {
  constructor(x, y, first = false) {
    this.pos = createVector(x, y);
    this.vel = p5.Vector.random2D().mult(0.2);
    this.acc = createVector(0, 0);
    this.size = random(4, 12);
    this.color = color(...random(starryColors));
    this.exploding = false;
    this.explodeTimer = 0;
    this.scaleFactor = 1;
    this.maxLife = random(150, 300);
    this.age = first ? random(this.maxLife) : 0;
    this.alpha = first ? 200 : 0;
  }

  respawn() {
    this.pos.set(random(width), random(height));
    this.vel = p5.Vector.random2D().mult(0.2);
    this.acc.set(0, 0);
    this.age = 0; this.alpha = 0; this.exploding = false;
  }

  follow(v) {
    if (!this.exploding) {
      let x = floor(this.pos.x / scl);
      let y = floor(this.pos.y / scl);
      let i = x + y * cols;
      if (i >= 0 && i < v.length) this.acc.add(v[i]);
    }
  }

  applyAttraction(tx, ty, s) {
    if (this.exploding || s < 0.1) return;
    let dx = tx - this.pos.x;
    let dy = ty - this.pos.y;
    let dSq = dx * dx + dy * dy;
    const attractionRadius = 450;
    if (dSq < attractionRadius * attractionRadius) {
      let d = Math.sqrt(dSq);
      let force = map(d, 0, attractionRadius, s * 1.5, 0);
      this.acc.add((dx / d) * force, (dy / d) * force);
    }
  }

  applyRepulsion(tx, ty, r) {
    if (this.exploding) return;
    let dx = this.pos.x - tx;
    let dy = this.pos.y - ty;
    let dSq = dx * dx + dy * dy;
    if (dSq < r * r) {
      let d = Math.sqrt(dSq);
      let force = map(d, 0, r, 1.5, 0);
      this.acc.add((dx / d) * force, (dy / d) * force);
    }
  }

  fireworkExplode(o, p, r) {
    if (this.pos.dist(o) > r) return;
    this.exploding = true;
    this.explodeTimer = 45;
    let dir = p5.Vector.sub(this.pos, o).normalize();
    this.vel = dir.mult(random(p * 0.8, p * 1.2));
    this.age = 0;
    this.alpha = 255;
  }

  update() {
    if (!this.exploding) {
      this.age++;
      if (this.age > this.maxLife) { this.respawn(); return; }
      if (this.age < 20) this.alpha = map(this.age, 0, 20, 0, 200);
      else if (this.age > this.maxLife - 30) this.alpha = map(this.age, this.maxLife - 30, this.maxLife, 200, 0);
      else this.alpha = 200;
      this.vel.add(this.acc);
      this.vel.limit(1.2);
    } else {
      this.explodeTimer--;
      this.vel.mult(0.94);
      if (this.explodeTimer <= 0) this.exploding = false;
    }
    this.pos.add(this.vel);
    this.acc.set(0, 0);
    if (this.pos.x < -20) this.pos.x = width + 20;
    if (this.pos.x > width + 20) this.pos.x = -20;
    if (this.pos.y < -20) this.pos.y = height + 20;
    if (this.pos.y > height + 20) this.pos.y = -20;
  }

  show() {
    strokeWeight(this.size * (this.exploding ? this.scaleFactor : 1));
    stroke(red(this.color), green(this.color), blue(this.color), this.alpha);
    point(this.pos.x, this.pos.y);
  }
}

class Ripple {
  // 【新增】speed、fade 可以調（預設和原作一樣）；回應了提示燈的漣漪用比較慢的
  constructor(x, y, r, speed = 12, fade = 8) { this.x = x; this.y = y; this.r = 0; this.al = 255; this.maxR = r; this.speed = speed; this.fade = fade; }
  update() { this.r += this.speed; this.al -= this.fade; }
  show() { noFill(); stroke(200, 200, 255, this.al); strokeWeight(3); ellipse(this.x, this.y, this.r); }
  finished() { return this.al <= 0; }
}

function keyPressed() {
  if (key === 'f' || key === 'F') fullscreen(!fullscreen());
  if (key === 'Escape') fullscreen(false);
}

function initFlowField() {
  cols = floor(width / scl) + 1;
  rows = floor(height / scl) + 1;
  flowField = new Array(cols * rows);
  for (let i = 0; i < flowField.length; i++) flowField[i] = createVector(0, 0);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  initFlowField();
}
