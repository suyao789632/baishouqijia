/*
  RemoteMqtt.html — MQTT 版的「Device」：網頁 ⇄ MQTT 伺服器 ⇄ ESP8266 ⇄ Mega
  版本：v1.0（2026-11-01）
  取代 Remote.html（Apps Script 轉接站版，慢 2～4 秒），延遲約 0.1～0.3 秒。
  用法和 Remote.html、USB 版 device.js 完全一樣（同樣叫 Device），所以 Sketch 不用改。
  GitHub 網頁版：index.html 依序載入 mqtt.min.js → remote_mqtt.js → sketch.js。

  ROOM 要和 ESP8266 程式（Row5TouchWave_ESP8266_MQTT）的 ROOM 一字不差。
*/
const Device = {
  ROOM: 'baishouqijia/sy7k2m',
  BROKER: 'wss://broker.hivemq.com:8884/mqtt',
  N: 5, PROTO: 3, TOP: 2038,
  HINT_EVERY_MS: 300,     // 同一欄最快多久送一次提示
  GRAB_MAX_MS: 30000,

  wave: { on: true, period: 8, amp: 0.75, phase: 0.16, maxh: 0.9 },

  connected: false, error: 0, mode: 0, firmware: 'MQTT', proto: 3,
  deviceOnline: false,
  onGrab: null, onRelease: null,

  _client: null, _t0: performance.now(),
  _lastHint: [0, 0, 0, 0, 0], _grabAt: [0, 0, 0, 0, 0], _frozen: [0, 0, 0, 0, 0],

  supported() { return typeof mqtt !== 'undefined'; },
  protoOk() { return true; },
  isAlive() { return this.connected && this._client && this._client.connected && this.deviceOnline; },
  isGrabbed(k) {
    const t = this._grabAt[k - 1];
    return t > 0 && performance.now() - t < this.GRAB_MAX_MS;
  },
  chargeOf(k) { return this.isGrabbed(k) ? Math.min(1, (performance.now() - this._grabAt[k - 1]) / 2000) : 0; },
  waveHeight(k, tSec) {
    const w = this.wave, c = k - 1;
    const a = 2 * Math.PI * tSec / w.period - c * 2 * Math.PI * w.phase;
    const s = 0.82 * Math.sin(a) + 0.18 * Math.sin(1.7 * a + c * 1.3);
    return Math.max(0, Math.min(1, w.maxh * (0.5 + 0.5 * w.amp * s)));
  },
  heightOf(k) {
    if (this.isGrabbed(k)) return this._frozen[k - 1];
    return this.wave.on ? this.waveHeight(k, (performance.now() - this._t0) / 1000) : 0;
  },

  hint(k) {
    if (!this.connected || !this._client || !this._client.connected || k < 1 || k > this.N) return;
    const now = performance.now();
    if (now - this._lastHint[k - 1] < this.HINT_EVERY_MS) return;
    this._lastHint[k - 1] = now;
    this._client.publish(this.ROOM + '/hint', String(k));
  },

  async connect() {
    if (!this.supported()) { alert('MQTT 函式庫沒有載入，請檢查網路。'); return false; }
    const id = 'bsqj-web-' + Math.random().toString(16).slice(2, 10);
    this._client = mqtt.connect(this.BROKER, { clientId: id, keepalive: 15, reconnectPeriod: 2000 });
    this._client.on('connect', () => {
      this.error = 0;
      this._client.subscribe([this.ROOM + '/event', this.ROOM + '/device']);
    });
    this._client.on('close', () => { this.error = 1; });
    this._client.on('message', (topic, buf) => this._handle(topic, buf.toString().trim()));
    this.connected = true;
    return true;
  },
  async disconnect() {
    this.connected = false;
    if (this._client) this._client.end(true);
  },

  _handle(topic, msg) {
    if (topic === this.ROOM + '/device') { this.deviceOnline = msg === 'online'; return; }
    const p = msg.split(/\s+/);
    const k = parseInt(p[1], 10);
    if (!(k >= 1 && k <= this.N)) return;
    if (p[0] === 'G') {
      this._frozen[k - 1] = this.heightOf(k);
      this._grabAt[k - 1] = performance.now();
      if (this.onGrab) this.onGrab(k, p[2] === '1');
    } else if (p[0] === 'P') {
      this._grabAt[k - 1] = 0;
      if (this.onRelease) this.onRelease(k, parseInt(p[2], 10) / 100, p[3] === '1');
    }
  },
};

window.addEventListener('load', () => {
  if (!Device.supported()) return;
  Device.connect();
  const b = document.getElementById('deviceButton');
  if (b) b.textContent = '中斷遠端';
});
