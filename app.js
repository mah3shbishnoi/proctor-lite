/* ProctorLite — local mock proctored assessment. No network calls except GET ping.txt on this origin. */
'use strict';

const CONFIG = {
  TEST_MINUTES: 10,
  MIC_THRESHOLD: 0.15,      // level (0..1) the mic must exceed once to pass
  LATENCY_FAIL_MS: 300,     // avg latency above this fails the network check
  SPIKE_MS: 500,            // ping slower than this (or failed) = lag spike
  FLAG_AT: 5,               // violations before the mock "flagged" banner
  STALL_MS: 3000,           // camera frames missing this long = stalled
  SILENCE_SECONDS: 60,      // informational prolonged-silence flag
  FACE_DETECTION: false,    // FEATURE FLAG: experimental window.FaceDetector (OFF by default)
  FACE_INTERVAL_MS: 2000,
  PING_URL: 'ping.txt',
  BG_PING_MS: 5000,         // background re-measure on check screen
  TEST_PING_MS: 2000        // single ping interval during the test
};

const $ = (id) => document.getElementById(id);
const fmtClock = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const NOT_SUPPORTED = 'Not supported in this browser';

/* Translate getUserMedia / getDisplayMedia / fullscreen errors into a human message. */
function mediaError(e, what) {
  const n = (e && e.name) || 'Error';
  if (n === 'NotAllowedError' || n === 'SecurityError') return `${what} permission denied or dismissed. Allow it via the lock/camera icon in the address bar, then Re-check.`;
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return `No ${what.toLowerCase()} device found. Plug one in / enable it in system settings, then Re-check.`;
  if (n === 'NotReadableError' || n === 'AbortError') return `${what} is busy or blocked (another app/tab such as Zoom/OBS, or the OS). Close it and Re-check.`;
  if (n === 'TypeError') return `${what} request is invalid or the page is not in a secure context (use http://localhost:8000).`;
  return `${what} error: ${n}${e && e.message ? ' — ' + e.message : ''}`;
}

/* ============================ Logger ============================ */
const Logger = {
  events: [],            // central log: {time, type, detail, category, elapsedMs}
  t0: Date.now(),
  subs: [],
  reset() { this.events = []; this.t0 = Date.now(); },
  add(type, detail = '', category = 'info') {
    const ev = { time: new Date().toISOString(), type, detail, category, elapsedMs: Date.now() - this.t0 };
    this.events.push(ev);
    this.subs.forEach((fn) => fn(ev));
    return ev;
  }
};

/* ============================== UI ============================== */
const UI = {
  showScreen(name) {
    ['check', 'test', 'report'].forEach((n) => $('screen-' + n).classList.toggle('hidden', n !== name));
    window.scrollTo(0, 0);
  },
  setBadge(key, state, text) {
    const el = $('badge-' + key);
    if (!el) return;
    el.className = 'badge badge-' + state;
    el.textContent = text || { pending: 'Pending', pass: 'Pass', fail: 'Fail', optional: 'Optional', warn: 'Warning' }[state];
  },
  setHint(key, text, kind) {
    const el = $('hint-' + key);
    if (!el) return;
    el.textContent = text;
    el.className = 'hint' + (kind ? ' hint-' + kind : '');
  },
  setText(id, t) { const el = $(id); if (el) el.textContent = t; },
  /* Status bar pill: state = ok | err | warn | pending */
  status(key, state, text) {
    const pill = $('sb-' + key);
    pill.dataset.state = state;
    $('sb-' + key + '-val').textContent = text;
  },
  toast(msg, kind = 'warn', ms = 4500) {
    const box = $('toast-container');
    const t = document.createElement('div');
    t.className = 'toast toast-' + kind;
    t.textContent = msg;
    box.appendChild(t);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(() => t.remove(), ms);
  },
  modal(id, show, focusId) {
    $(id).classList.toggle('hidden', !show);
    if (show && focusId) $(focusId).focus();
  },
  setViolations(n) {
    UI.setText('sb-violations-val', String(n));
    UI.setText('test-violation-count', String(n));
    $('sb-violations').dataset.state = n >= CONFIG.FLAG_AT ? 'err' : n > 0 ? 'warn' : 'ok';
    $('banner-flagged').classList.toggle('hidden', n < CONFIG.FLAG_AT);
  },
  appendLog(ev) {
    const list = $('test-event-list');
    const li = document.createElement('li');
    if (ev.category === 'violation') li.className = 'ev-violation';
    const t = document.createElement('span');
    t.className = 'ev-time';
    t.textContent = fmtClock(ev.elapsedMs / 1000);
    li.append(t, document.createTextNode(ev.type + (ev.detail ? ' — ' + ev.detail : '')));
    list.prepend(li);
    while (list.children.length > 200) list.removeChild(list.lastChild);
    UI.setText('test-log-count', Logger.events.length + ' events');
  }
};
Logger.subs.push((ev) => UI.appendLog(ev));

/* ======================= Frame counter (camera) ======================= */
/* Counts video frames via requestVideoFrameCallback (cheap counter only). */
const Frames = {
  supported: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
  count: 0, last: performance.now(), token: 0,
  start(video) {
    if (!this.supported) return;
    const token = ++this.token;   // starting again kills the previous chain
    this.last = performance.now();
    const cb = () => {
      if (token !== this.token) return;
      this.count++;
      this.last = performance.now();
      video.requestVideoFrameCallback(cb);
    };
    video.requestVideoFrameCallback(cb);
  },
  stop() { this.token++; }
};

/* ============================ Mic meter ============================ */
/* Only requestAnimationFrame user in the app. */
const MicMeter = {
  ctx: null, src: null, analyser: null, buf: null, raf: 0, level: 0, lastLoud: Date.now(),
  supported: !!(window.AudioContext || window.webkitAudioContext),
  start(stream) {
    this.stop();
    if (!this.supported) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.src = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.buf = new Uint8Array(this.analyser.fftSize);
    this.src.connect(this.analyser);   // not connected to destination: no echo
    this.lastLoud = Date.now();
    this.resume();
    const loop = () => {
      this.analyser.getByteTimeDomainData(this.buf);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i++) { const x = (this.buf[i] - 128) / 128; sum += x * x; }
      const raw = Math.min(1, Math.sqrt(sum / this.buf.length) * 4);
      this.level = Math.max(raw, this.level * 0.92);   // fast attack, slow decay
      if (raw > 0.03) this.lastLoud = Date.now();
      const w = (this.level * 100).toFixed(0) + '%';
      $('check-mic-bar').style.width = w;
      $('test-mic-bar').style.width = w;
      if (this.ctx.state === 'suspended') this.resume();
      SystemCheck.onMicLevel(this.level);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  },
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); },
  stop() {
    cancelAnimationFrame(this.raf);
    try { if (this.src) this.src.disconnect(); } catch (e) { /* ignore */ }
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = this.src = this.analyser = null;
    this.level = 0;
    $('check-mic-bar').style.width = '0';
    $('test-mic-bar').style.width = '0';
  }
};

/* ========================== NetworkMonitor ========================== */
const NetworkMonitor = {
  samples: [],        // test-time samples: {t, ms|null}
  bgTimer: null, testTimer: null, busy: false, last: null,

  /* One timed fetch of the tiny local file; returns ms or null on failure. */
  async ping() {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const to = ctl ? setTimeout(() => ctl.abort(), 5000) : null;
    const t = performance.now();
    try {
      const r = await fetch(`${CONFIG.PING_URL}?r=${Date.now()}${Math.random()}`, { cache: 'no-store', signal: ctl ? ctl.signal : undefined });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      await r.text();
      return performance.now() - t;
    } catch (e) {
      return null;
    } finally { if (to) clearTimeout(to); }
  },
  stats(rtts, failed) {
    if (!rtts.length) return { min: null, avg: null, max: null, jitter: null, failed };
    const sum = rtts.reduce((a, b) => a + b, 0);
    let j = 0;
    for (let i = 1; i < rtts.length; i++) j += Math.abs(rtts[i] - rtts[i - 1]);
    return { min: Math.min(...rtts), avg: sum / rtts.length, max: Math.max(...rtts), jitter: rtts.length > 1 ? j / (rtts.length - 1) : 0, failed };
  },
  async burst(n = 10) {
    const rtts = []; let failed = 0;
    for (let i = 0; i < n; i++) { const ms = await this.ping(); if (ms === null) failed++; else rtts.push(ms); }
    return this.stats(rtts, failed);
  },
  startBackground() {
    this.stopBackground();
    this.bgTimer = setInterval(() => SystemCheck.checkNetwork(false), CONFIG.BG_PING_MS);
  },
  stopBackground() { clearInterval(this.bgTimer); this.bgTimer = null; },

  /* During the test: one ping every 2s; every sample is stored and fed to Proctor. */
  startTest() {
    this.samples = [];
    this.testTimer = setInterval(async () => {
      if (this.busy) return;
      this.busy = true;
      const ms = await this.ping();
      this.busy = false;
      if (!Proctor.running) return;
      this.samples.push({ t: Date.now(), ms });
      this.last = ms;
      UI.status('network', ms === null ? 'err' : ms > CONFIG.SPIKE_MS ? 'warn' : 'ok', ms === null ? 'FAILED' : Math.round(ms) + ' ms');
      Proctor.onPing(ms);
    }, CONFIG.TEST_PING_MS);
  },
  stopTest() { clearInterval(this.testTimer); this.testTimer = null; },
  summary() {
    const ok = this.samples.filter((s) => s.ms !== null).map((s) => s.ms);
    const spikes = this.samples.filter((s) => s.ms === null || s.ms > CONFIG.SPIKE_MS).length;
    return {
      samples: this.samples.length,
      avgMs: ok.length ? +(ok.reduce((a, b) => a + b, 0) / ok.length).toFixed(1) : null,
      worstMs: ok.length ? +Math.max(...ok).toFixed(1) : null,
      failedPings: this.samples.length - ok.length,
      lagSpikes: spikes
    };
  }
};

/* =========================== SystemCheck =========================== */
const SystemCheck = {
  state: { browser: 'pending', camera: 'pending', mic: 'pending', network: 'pending', fullscreen: 'pending' },
  cam: null, mic: null, screen: null, screenDetails: null,
  micWaiting: false, micPeak: 0, fpsTimer: null, lastFrameCount: 0, netRunning: false,

  set(key, state, text) { this.state[key] = state; UI.setBadge(key, state, text); this.updateStart(); },
  allPass() { return Object.values(this.state).every((s) => s === 'pass'); },
  updateStart() { $('btn-start-test').disabled = !this.allPass(); },

  /* a. Browser + OS info */
  async checkBrowser(withDetails) {
    const nav = navigator;
    UI.setText('info-ua', nav.userAgent);
    UI.setText('info-platform', (nav.userAgentData && nav.userAgentData.platform) || nav.platform || 'unknown');
    UI.setText('info-screen', `${screen.width}×${screen.height} @ ${window.devicePixelRatio}x`);
    let screens;
    if (typeof window.getScreenDetails === 'function') {
      if (withDetails) {
        try { this.screenDetails = await window.getScreenDetails(); screens = String(this.screenDetails.screens.length); }
        catch (e) { screens = 'Unavailable (permission denied)'; }
      } else screens = 'Available — click Re-check to query';
    } else if ('isExtended' in screen) screens = (screen.isExtended ? '2 or more (extended desktop)' : '1') + ' (approx.)';
    else screens = NOT_SUPPORTED;
    UI.setText('info-screens-count', screens);

    const problems = [];
    if (!window.isSecureContext) problems.push('Page is not a secure context — open http://localhost:8000.');
    if (!(nav.mediaDevices && nav.mediaDevices.getUserMedia)) problems.push('getUserMedia ' + NOT_SUPPORTED + '.');
    if (!MicMeter.supported) problems.push('AudioContext ' + NOT_SUPPORTED + '.');
    if (problems.length) { this.set('browser', 'fail'); UI.setHint('browser', problems.join(' '), 'error'); }
    else { this.set('browser', 'pass'); UI.setHint('browser', 'Browser supports camera, microphone and audio analysis.', 'ok'); }
  },

  stopCam() { if (this.cam) this.cam.getTracks().forEach((t) => t.stop()); this.cam = null; },
  stopMic() { if (this.mic) this.mic.getTracks().forEach((t) => t.stop()); this.mic = null; },
  stopScreen() { if (this.screen) this.screen.getTracks().forEach((t) => t.stop()); this.screen = null; },

  /* Acquire a camera stream and attach it to both preview videos (also used for recovery in the test). */
  async acquireCamera() {
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) throw Object.assign(new Error(NOT_SUPPORTED), { name: 'NotSupported' });
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    this.stopCam();
    this.cam = stream;
    ['check-video', 'test-video'].forEach((id) => { const v = $(id); v.srcObject = stream; const p = v.play(); if (p && p.catch) p.catch(() => {}); });
    const track = stream.getVideoTracks()[0];
    track.addEventListener('ended', () => { if (!Proctor.running) this.onDeviceGone('camera'); });
    return stream;
  },
  async acquireMic() {
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) throw Object.assign(new Error(NOT_SUPPORTED), { name: 'NotSupported' });
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.stopMic();
    this.mic = stream;
    MicMeter.start(stream);
    stream.getAudioTracks()[0].addEventListener('ended', () => { if (!Proctor.running) this.onDeviceGone('mic'); });
    return stream;
  },
  onDeviceGone(kind) {
    const key = kind === 'camera' ? 'camera' : 'mic';
    this.set(key, 'fail');
    UI.setHint(key, (kind === 'camera' ? 'Camera' : 'Microphone') + ' was disconnected. Re-plug it and click Re-check.', 'error');
  },

  /* b. Camera */
  async checkCamera() {
    this.set('camera', 'pending');
    UI.setHint('camera', 'Requesting camera…');
    ['info-cam-label', 'info-cam-res', 'info-cam-fps'].forEach((id) => UI.setText(id, '--'));
    try { await this.acquireCamera(); }
    catch (e) {
      this.set('camera', 'fail');
      UI.setHint('camera', e.name === 'NotSupported' ? NOT_SUPPORTED : mediaError(e, 'Camera'), 'error');
      UI.setText('camera-stats-overlay', 'No feed');
      return;
    }
    const track = this.cam.getVideoTracks()[0];
    const s = track.getSettings();
    UI.setText('info-cam-label', track.label || 'Camera');
    UI.setText('info-cam-res', s.width ? `${s.width}×${s.height}` : 'measuring…');
    UI.setText('camera-stats-overlay', 'Live');
    this.set('camera', 'pass');
    UI.setHint('camera', 'Camera is live. If the preview is black, check the privacy shutter.', 'ok');
    this.startFps(track);
  },
  /* Actual FPS: frames counted by requestVideoFrameCallback, sampled each second (fallback: reported frameRate). */
  startFps(track) {
    clearInterval(this.fpsTimer);
    const v = $('check-video');
    Frames.start(v);
    this.lastFrameCount = Frames.count;
    this.fpsTimer = setInterval(() => {
      if (v.videoWidth) UI.setText('info-cam-res', `${v.videoWidth}×${v.videoHeight}`);
      if (Frames.supported) {
        const fps = Frames.count - this.lastFrameCount;
        this.lastFrameCount = Frames.count;
        UI.setText('info-cam-fps', fps + ' fps');
        if (fps < 5 && this.state.camera === 'pass' && !document.hidden) UI.setHint('camera', 'Very low frame rate — close other apps using the camera or improve lighting.', 'warn');
      } else {
        const fr = track.getSettings().frameRate;
        UI.setText('info-cam-fps', fr ? Math.round(fr) + ' fps (reported)' : NOT_SUPPORTED);
      }
    }, 1000);
  },
  stopFps() { clearInterval(this.fpsTimer); this.fpsTimer = null; },

  /* c. Microphone */
  async checkMic() {
    this.set('mic', 'pending');
    this.micPeak = 0;
    this.micWaiting = false;
    UI.setText('info-mic-peak', '0%');
    UI.setText('info-mic-threshold', `Say something to cross threshold (${CONFIG.MIC_THRESHOLD * 100}%)`);
    UI.setHint('mic', 'Requesting microphone…');
    if (!MicMeter.supported) { this.set('mic', 'fail'); UI.setHint('mic', 'AudioContext ' + NOT_SUPPORTED, 'error'); return; }
    try { await this.acquireMic(); }
    catch (e) {
      this.set('mic', 'fail');
      UI.setHint('mic', e.name === 'NotSupported' ? NOT_SUPPORTED : mediaError(e, 'Microphone'), 'error');
      return;
    }
    UI.setText('info-mic-label', this.mic.getAudioTracks()[0].label || 'Microphone');
    this.micWaiting = true;
    UI.setHint('mic', 'Say something! The bar must pass the black marker. (If it never moves, click anywhere on the page.)');
  },
  /* Called from the rAF loop with the smoothed level. */
  onMicLevel(level) {
    if (level > this.micPeak) {
      this.micPeak = level;
      UI.setText('info-mic-peak', Math.round(level * 100) + '%');
    }
    if (this.micWaiting && level > CONFIG.MIC_THRESHOLD) {
      this.micWaiting = false;
      this.set('mic', 'pass');
      UI.setText('info-mic-threshold', 'Voice detected ✔');
      UI.setHint('mic', 'Microphone works.', 'ok');
    }
  },

  /* d. Network */
  async checkNetwork(manual) {
    if (this.netRunning) return;
    this.netRunning = true;
    const live = $('net-live-indicator');
    live.classList.add('busy');
    live.textContent = '● Measuring…';
    if (manual) { this.set('network', 'pending'); UI.setHint('network', 'Pinging ping.txt × 10…'); }
    const c = navigator.connection;
    UI.setText('info-net-conn', c ? `${c.effectiveType || '?'} · ↓${c.downlink ?? '?'} Mbps · rtt ${c.rtt ?? '?'} ms` : NOT_SUPPORTED);
    const s = await NetworkMonitor.burst(10);
    this.netRunning = false;
    live.classList.remove('busy');
    live.textContent = '● Live (5s)';
    if (!$('screen-check') || $('screen-check').classList.contains('hidden')) return;
    const f = (n) => (n === null ? '--' : n.toFixed(1));
    UI.setText('info-net-rtt', `${f(s.min)} / ${f(s.avg)} / ${f(s.max)} ms`);
    UI.setText('info-net-jitter', s.jitter === null ? '--' : s.jitter.toFixed(1) + ' ms');
    UI.status('network', s.avg === null ? 'err' : 'ok', s.avg === null ? 'FAILED' : Math.round(s.avg) + ' ms');
    if (s.failed > 0) {
      this.set('network', 'fail');
      UI.setHint('network', `${s.failed} of 10 requests failed. Is the server running (python3 -m http.server 8000) and is ping.txt present? Check your connection.`, 'error');
    } else if (s.avg > CONFIG.LATENCY_FAIL_MS) {
      this.set('network', 'fail');
      UI.setHint('network', `Average ${s.avg.toFixed(0)} ms exceeds ${CONFIG.LATENCY_FAIL_MS} ms. Disable DevTools throttling / VPN and retry.`, 'error');
    } else {
      this.set('network', 'pass');
      UI.setHint('network', 'Latency is healthy. Re-measuring every 5 seconds.', 'ok');
    }
  },

  /* e. Fullscreen */
  async checkFullscreen() {
    const el = document.documentElement;
    if (!el.requestFullscreen) { this.set('fullscreen', 'fail'); UI.setHint('fullscreen', NOT_SUPPORTED, 'error'); return; }
    try { await el.requestFullscreen(); }   // pass is set by the fullscreenchange listener
    catch (e) {
      this.set('fullscreen', 'fail');
      UI.setHint('fullscreen', `Fullscreen request rejected (${e.name || 'error'}${e.message ? ': ' + e.message : ''}). Click the button directly; check window-manager/Wayland policy.`, 'error');
    }
  },

  /* f. Screen share (optional) */
  async checkScreen() {
    UI.setText('info-screen-surface', 'Not shared'); UI.setText('info-screen-res', '--');
    if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) {
      UI.setBadge('screen', 'optional', 'Unsupported'); UI.setHint('screen', 'Screen sharing: ' + NOT_SUPPORTED, 'warn'); return;
    }
    this.stopScreen();
    let stream;
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); }
    catch (e) {
      UI.setBadge('screen', 'optional');
      UI.setHint('screen', e.name === 'NotAllowedError' ? 'Screen share cancelled or denied. (Optional — on Wayland this needs PipeWire + xdg-desktop-portal.)' : mediaError(e, 'Screen share'), 'warn');
      return;
    }
    this.screen = stream;
    const track = stream.getVideoTracks()[0];
    const s = track.getSettings();
    const surface = s.displaySurface || 'unknown';
    UI.setText('info-screen-surface', surface);
    UI.setText('info-screen-res', s.width ? `${s.width}×${s.height}` : '--');
    if (surface === 'monitor') { UI.setBadge('screen', 'pass'); UI.setHint('screen', 'Entire screen is being shared. 👍', 'ok'); }
    else if (surface === 'unknown') { UI.setBadge('screen', 'warn'); UI.setHint('screen', 'Sharing works, but this browser does not report what was shared. Make sure it is the entire screen.', 'warn'); }
    else { UI.setBadge('screen', 'warn'); UI.setHint('screen', `You shared a ${surface}, not the entire screen. Re-check and choose "Entire screen".`, 'warn'); }
    track.addEventListener('ended', () => {
      if (Proctor.running) return;
      this.screen = null;
      UI.setText('info-screen-surface', 'Not shared'); UI.setBadge('screen', 'optional');
    });
  },

  runAll(withDetails) {
    this.checkBrowser(withDetails);
    this.checkNetwork(true);
    this.checkCamera().then(() => this.checkMic());   // sequential prompts
  },

  init() {
    const map = {
      browser: () => this.checkBrowser(true), camera: () => this.checkCamera(), mic: () => { MicMeter.resume(); return this.checkMic(); },
      network: () => this.checkNetwork(true), fullscreen: () => this.checkFullscreen(), screen: () => this.checkScreen()
    };
    document.querySelectorAll('[data-recheck]').forEach((b) => b.addEventListener('click', () => map[b.dataset.recheck]()));
    $('btn-recheck-all').addEventListener('click', () => this.runAll(true));
    $('btn-start-test').addEventListener('click', () => App.start());
    // Autoplay policy: resume audio on first user gesture.
    ['click', 'keydown'].forEach((ev) => document.addEventListener(ev, () => MicMeter.resume(), { passive: true }));
    // Optional face-detection flag toggle.
    const cb = $('toggle-facedetector');
    if ('FaceDetector' in window) { UI.setText('hint-facedetector', 'FaceDetector API detected.'); }
    else { cb.disabled = true; UI.setText('hint-facedetector', 'Face detection unavailable in this browser'); }
    cb.checked = CONFIG.FACE_DETECTION && !cb.disabled;
    cb.addEventListener('change', () => { CONFIG.FACE_DETECTION = cb.checked; });
  },
  reset() {
    Object.keys(this.state).forEach((k) => { this.state[k] = 'pending'; UI.setBadge(k, 'pending'); });
    UI.setBadge('screen', 'optional');
    this.updateStart();
  }
};

/* ============================= Proctor ============================= */
const Proctor = {
  running: false, listeners: [], timers: [], counts: {}, total: 0,
  startedAt: 0, endedAt: 0, endsAt: 0,
  fsExitAt: null, awayStart: null, altTabAt: 0, lastClipKeyAt: 0, lastSelectAt: 0, lastPrintAt: 0,
  dev: { camera: 'ok', mic: 'ok' }, recovering: false,
  up: { ticks: 0, cam: 0, mic: 0 },
  stallLogged: false, lastCT: 0, lastCTAt: 0, silenceLogged: false,
  screenCount: 1, screenWasShared: false, offlineAt: null, faceState: 'ok', faceDetector: null,

  on(target, type, fn, opts) { target.addEventListener(type, fn, opts); this.listeners.push([target, type, fn, opts]); },
  every(fn, ms) { this.timers.push(setInterval(fn, ms)); },

  /* Log + count + toast. Every violation goes through here. */
  violation(type, detail = '') {
    this.counts[type] = (this.counts[type] || 0) + 1;
    this.total++;
    Logger.add(type, detail, 'violation');
    UI.toast(type + (detail ? ': ' + detail : ''));
    UI.setViolations(this.total);
  },

  start() {
    this.running = true;
    this.counts = {}; this.total = 0;
    this.up = { ticks: 0, cam: 0, mic: 0 };
    this.dev = { camera: 'ok', mic: 'ok' };
    this.fsExitAt = this.awayStart = null;
    this.stallLogged = this.silenceLogged = false;
    this.startedAt = Date.now();
    this.endsAt = this.startedAt + CONFIG.TEST_MINUTES * 60000;
    this.lastCT = 0; this.lastCTAt = performance.now();
    this.screenWasShared = !!SystemCheck.screen;
    this.screenCount = this.getScreenCount();
    UI.setViolations(0);
    Logger.add('Test started', `${CONFIG.TEST_MINUTES} min, screens: ${this.screenCount}`);

    // Fullscreen exit / return (fullscreenchange)
    this.on(document, 'fullscreenchange', () => this.onFullscreen());
    // Tab hidden / shown (visibilitychange) and window blur / focus
    this.on(document, 'visibilitychange', () => document.hidden ? this.awayBegin('tab hidden') : this.tryReturn());
    this.on(window, 'blur', () => { this.awayBegin('window blur'); if (Date.now() - this.altTabAt < 1500) Logger.add('Alt+Tab detected', 'followed by window blur'); });
    this.on(window, 'focus', () => this.tryReturn());
    // Device plug/unplug (devicechange) — also triggers recovery of lost devices
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      this.on(navigator.mediaDevices, 'devicechange', () => {
        this.violation('Device change', 'Media devices were added or removed');
        if (this.dev.camera === 'ended' || this.dev.mic === 'ended') this.recover();
      });
    }
    // Window resize: breaks fullscreen or just info if already out of fullscreen
    let rt = null;
    this.on(window, 'resize', () => { clearTimeout(rt); rt = setTimeout(() => this.onResize(), 300); });
    // Clipboard + context menu + selection of question
    ['copy', 'cut', 'paste'].forEach((t) => this.on(document, t, (e) => {
      e.preventDefault();
      if (Date.now() - this.lastClipKeyAt < 500) return;   // already counted via keydown
      this.violation('Clipboard ' + t, 'Blocked');
    }));
    this.on(document, 'contextmenu', (e) => { e.preventDefault(); this.violation('Right-click', 'Context menu blocked'); });
    this.on($('question-pane'), 'selectstart', (e) => {
      e.preventDefault();
      if (Date.now() - this.lastSelectAt > 2000) { this.lastSelectAt = Date.now(); this.violation('Text selection', 'Question text selection blocked'); }
    });
    // Keyboard shortcuts
    this.on(document, 'keydown', (e) => this.onKey(e), true);
    this.on(document, 'keyup', (e) => { if (e.key === 'PrintScreen') this.onPrint(); }, true);
    // Leaving / refreshing the page
    this.on(window, 'beforeunload', (e) => { Logger.add('Leave/refresh attempt', 'beforeunload warning shown'); e.preventDefault(); e.returnValue = ''; return ''; });
    // Track events for camera / mic (ended, mute, unmute)
    this.bindTracks();
    // Screen share stopped
    if (SystemCheck.screen) SystemCheck.screen.getTracks().forEach((t) => this.on(t, 'ended', () => { if (this.running) this.violation('Screen share stopped', 'The shared screen ended'); }));

    // Modal buttons
    this.on($('btn-return-fs'), 'click', () => this.returnFullscreen());
    this.on($('btn-away-ok'), 'click', () => { UI.modal('away-modal', false); $('code-editor').focus(); });
    this.on($('btn-device-retry'), 'click', () => this.recover());

    NetworkMonitor.startTest();
    this.every(() => this.tick(), 1000);
    this.startFace();
    this.tick();
    $('code-editor').focus();
  },

  stop() {
    this.running = false;
    this.endedAt = Date.now();
    this.listeners.forEach(([t, ty, fn, o]) => t.removeEventListener(ty, fn, o));
    this.listeners = [];
    this.timers.forEach(clearInterval);
    this.timers = [];
    NetworkMonitor.stopTest();
    Frames.stop();
    ['fs-modal', 'away-modal', 'device-modal'].forEach((m) => UI.modal(m, false));
    $('banner-flagged').classList.add('hidden');
  },

  bindTracks() {
    [SystemCheck.cam, SystemCheck.mic].forEach((s) => {
      if (!s) return;
      s.getTracks().forEach((t) => ['ended', 'mute', 'unmute'].forEach((ev) => this.on(t, ev, () => this.checkDevices())));
    });
  },

  /* ---- Fullscreen ---- */
  onFullscreen() {
    if (!document.fullscreenElement) {
      // Fullscreen exit: violation + blocking modal; return time logged when back
      this.fsExitAt = Date.now();
      this.violation('Fullscreen exit', 'Left fullscreen');
      UI.setText('fs-modal-error', '');
      UI.modal('fs-modal', true, 'btn-return-fs');
    } else if (this.fsExitAt) {
      const s = ((Date.now() - this.fsExitAt) / 1000).toFixed(1);
      this.fsExitAt = null;
      Logger.add('Returned to fullscreen', `after ${s}s`);
      UI.modal('fs-modal', false);
      $('code-editor').focus();
    }
  },
  async returnFullscreen() {
    try { await document.documentElement.requestFullscreen(); }
    catch (e) { UI.setText('fs-modal-error', `Could not enter fullscreen (${e.name || 'error'}). Click the button again.`); }
  },
  onResize() {
    if (!this.running) return;
    if (document.fullscreenElement && (window.innerWidth < screen.width - 50 || window.innerHeight < screen.height - 50)) {
      this.violation('Window resize', `Window ${window.innerWidth}×${window.innerHeight} is smaller than screen`);
    } else if (!document.fullscreenElement) Logger.add('Window resized', 'while not in fullscreen');
  },

  /* ---- Away from window (tab switch / blur) ---- */
  awayBegin(reason) {
    if (this.awayStart !== null) return;
    this.awayStart = Date.now();
    Logger.add('Window left', reason);
  },
  /* Returns only when tab visible AND window focused; then counts one violation and shows blocking modal. */
  tryReturn() {
    if (this.awayStart === null || document.hidden || !document.hasFocus()) return;
    const secs = Math.max(1, Math.round((Date.now() - this.awayStart) / 1000));
    this.awayStart = null;
    this.violation('Left test window', `Away for ${secs} second${secs === 1 ? '' : 's'}`);
    UI.setText('away-modal-text', `You left the test window for ${secs} second${secs === 1 ? '' : 's'}. This has been recorded.`);
    UI.modal('away-modal', true, 'btn-away-ok');
  },

  /* ---- Keyboard ---- */
  onKey(e) {
    const k = e.key, kl = k.length === 1 ? k.toLowerCase() : k, ctrl = e.ctrlKey || e.metaKey;
    if (k === 'Escape') { Logger.add('Esc pressed', 'Esc is handled by the browser in fullscreen'); return; }
    if (k === 'PrintScreen') { this.onPrint(); return; }
    if (e.altKey && k === 'Tab') { this.altTabAt = Date.now(); Logger.add('Alt+Tab pressed', 'logged as violation only if window blur follows'); return; }
    let label = null;
    if (ctrl && !e.shiftKey && !e.altKey && 'cvxpsu'.includes(kl) && kl.length === 1) label = 'Ctrl+' + kl.toUpperCase();
    else if (k === 'F12') label = 'F12';
    else if (ctrl && e.shiftKey && ['i', 'j', 'c'].includes(kl)) label = 'Ctrl+Shift+' + kl.toUpperCase();
    if (!label) return;
    e.preventDefault();   // works for most shortcuts; some are reserved by the browser
    if ('cvx'.includes(kl) && ctrl && !e.shiftKey) this.lastClipKeyAt = Date.now();
    this.violation('Keyboard shortcut', label);
  },
  onPrint() {
    if (Date.now() - this.lastPrintAt < 500) return;
    this.lastPrintAt = Date.now();
    this.violation('Keyboard shortcut', 'PrintScreen (cannot be blocked)');
  },

  /* ---- Devices ---- */
  devStatus(stream) {
    const t = stream && stream.getTracks()[0];
    if (!t || t.readyState === 'ended') return 'ended';
    return t.muted ? 'muted' : 'ok';
  },
  checkDevices() {
    if (!this.running) return;
    [['camera', 'Camera', SystemCheck.cam], ['mic', 'Mic', SystemCheck.mic]].forEach(([k, name, stream]) => {
      const st = this.devStatus(stream);
      if (st === this.dev[k]) return;
      this.dev[k] = st;
      if (st === 'ok') Logger.add(name + ' restored', 'Device working again');
      else this.violation(`${name} ${st}`, st === 'ended' ? 'Track ended (unplugged or revoked)' : 'Track muted');
    });
    this.renderDeviceModal();
  },
  /* Blocking modal stays until every device is working again. */
  renderDeviceModal() {
    const bad = ['camera', 'mic'].filter((k) => this.dev[k] !== 'ok');
    const ul = $('device-modal-list');
    ul.textContent = '';
    ['camera', 'mic'].forEach((k) => {
      const li = document.createElement('li');
      const ok = this.dev[k] === 'ok';
      li.className = ok ? 'dev-ok' : 'dev-bad';
      li.textContent = `${k === 'camera' ? 'Camera' : 'Microphone'}: ${ok ? 'working ✔' : this.dev[k] === 'ended' ? 'disconnected ✖' : 'muted / no signal ✖'}`;
      ul.appendChild(li);
    });
    const open = !$('device-modal').classList.contains('hidden');
    if (bad.length && !open) { UI.setText('device-modal-error', ''); UI.modal('device-modal', true, 'btn-device-retry'); }
    else if (!bad.length && open) { UI.modal('device-modal', false); $('code-editor').focus(); }
  },
  /* Re-acquire ended tracks (button, or automatically on devicechange). */
  async recover() {
    if (this.recovering || !this.running) return;
    this.recovering = true;
    UI.setText('device-modal-error', 'Trying to reconnect…');
    let err = '';
    try {
      if (this.dev.camera === 'ended') { await SystemCheck.acquireCamera(); }
      if (this.dev.mic === 'ended') { await SystemCheck.acquireMic(); }
    } catch (e) { err = mediaError(e, 'Device') + ' (' + (e.name || 'error') + ')'; }
    this.recovering = false;
    this.bindTracks();
    UI.setText('device-modal-error', err);
    this.checkDevices();
  },

  /* ---- Network ---- */
  onPing(ms) {
    if (ms === null) {
      if (navigator.onLine) this.violation('Network lag spike', 'Latency ping failed');
    } else if (ms > CONFIG.SPIKE_MS) this.violation('Network lag spike', `Latency ${Math.round(ms)} ms`);
  },

  /* ---- Screens ---- */
  getScreenCount() {
    if (SystemCheck.screenDetails) return SystemCheck.screenDetails.screens.length;
    return 'isExtended' in screen ? (screen.isExtended ? 2 : 1) : 1;
  },

  /* ---- Face detection (optional, flag) ---- */
  startFace() {
    const badge = $('live-face-status');
    if (!CONFIG.FACE_DETECTION) { badge.textContent = 'Face Check: Off'; return; }
    if (!('FaceDetector' in window)) { badge.textContent = 'Face detection unavailable in this browser'; return; }
    try { this.faceDetector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 3 }); }
    catch (e) { badge.textContent = 'Face detection unavailable in this browser'; return; }
    const canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 120;
    const ctx = canvas.getContext('2d');
    let busy = false;
    badge.textContent = 'Face Check: On';
    this.every(async () => {
      if (busy || document.hidden || this.dev.camera !== 'ok') return;
      busy = true;
      try {
        ctx.drawImage($('test-video'), 0, 0, 160, 120);
        const n = (await this.faceDetector.detect(canvas)).length;
        const st = n === 0 ? 'none' : n > 1 ? 'multi' : 'ok';
        if (st !== this.faceState) {
          this.faceState = st;
          if (st === 'none') this.violation('No face', 'No face visible to camera');
          else if (st === 'multi') this.violation('Multiple faces', n + ' faces detected');
          else Logger.add('Face OK', 'Single face visible');
        }
        badge.textContent = 'Face Check: ' + (st === 'ok' ? 'OK' : st === 'none' ? 'No face' : 'Multiple');
      } catch (e) { badge.textContent = 'Face detection unavailable in this browser'; }
      busy = false;
    }, CONFIG.FACE_INTERVAL_MS);
  },

  /* ---- 1s heartbeat ---- */
  tick() {
    if (!this.running) return;
    const now = performance.now();
    // Timer
    const left = Math.max(0, Math.round((this.endsAt - Date.now()) / 1000));
    UI.setText('test-timer', fmtClock(left));
    if (left <= 0) { App.finish('Time expired'); return; }
    // Devices + uptime
    this.checkDevices();
    this.up.ticks++;
    if (this.dev.camera === 'ok') this.up.cam++;
    if (this.dev.mic === 'ok') this.up.mic++;
    UI.status('camera', this.dev.camera === 'ok' ? 'ok' : 'err', this.dev.camera === 'ok' ? 'OK' : 'ERR');
    UI.status('mic', this.dev.mic === 'ok' ? 'ok' : 'err', this.dev.mic === 'ok' ? 'OK' : 'ERR');
    UI.setText('test-mic-status', this.dev.mic === 'ok' ? 'OK' : 'ERR');
    UI.status('fullscreen', document.fullscreenElement ? 'ok' : 'err', document.fullscreenElement ? 'ON' : 'OFF');
    // Camera stall: no new frames for 3s (rVFC, fallback currentTime). Skipped while tab hidden.
    if (document.hidden || this.dev.camera !== 'ok') { Frames.last = now; this.lastCTAt = now; this.stallLogged = false; }
    else {
      let stalled;
      if (Frames.supported) stalled = now - Frames.last > CONFIG.STALL_MS;
      else { const v = $('test-video'); if (v.currentTime !== this.lastCT) { this.lastCT = v.currentTime; this.lastCTAt = now; } stalled = now - this.lastCTAt > CONFIG.STALL_MS; }
      if (stalled && !this.stallLogged) { this.stallLogged = true; this.violation('Camera stalled', `No new frames for ${CONFIG.STALL_MS / 1000}s`); }
      else if (!stalled && this.stallLogged) { this.stallLogged = false; Logger.add('Camera frames resumed', ''); }
    }
    // Prolonged silence (informational only, not a violation)
    const silent = (Date.now() - MicMeter.lastLoud) / 1000;
    if (!document.hidden && this.dev.mic === 'ok' && silent > CONFIG.SILENCE_SECONDS && !this.silenceLogged) { this.silenceLogged = true; Logger.add('Prolonged silence', `No audio for ${CONFIG.SILENCE_SECONDS}s (informational)`); }
    else if (silent < 1) this.silenceLogged = false;
    // Screen count change
    const sc = this.getScreenCount();
    if (sc !== this.screenCount) { this.violation('Screen count changed', `${this.screenCount} → ${sc}`); this.screenCount = sc; }
  },

  summary() {
    const secs = Math.round(((this.endedAt || Date.now()) - this.startedAt) / 1000);
    const pct = (n) => (this.up.ticks ? +((n / this.up.ticks) * 100).toFixed(1) : 100);
    return {
      durationSeconds: secs,
      totalViolations: this.total,
      flagged: this.total >= CONFIG.FLAG_AT,
      violationsByType: { ...this.counts },
      uptimePercent: { camera: pct(this.up.cam), microphone: pct(this.up.mic) }
    };
  }
};

/* ============================== App ============================== */
const App = {
  report: null,

  init() {
    SystemCheck.init();
    $('btn-submit-test').addEventListener('click', () => { if (window.confirm('Submit and end the assessment?')) App.finish('Submitted by user'); });
    $('btn-download-json').addEventListener('click', () => App.download());
    $('btn-restart').addEventListener('click', () => App.restart());

    // Global listeners (page lifetime): fullscreen status, online/offline
    document.addEventListener('fullscreenchange', () => {
      const on = !!document.fullscreenElement;
      UI.status('fullscreen', on ? 'ok' : 'err', on ? 'ON' : 'OFF');
      if (on && !Proctor.running && !$('screen-check').classList.contains('hidden')) {
        SystemCheck.set('fullscreen', 'pass');
        UI.setHint('fullscreen', 'Fullscreen works. Press Esc to leave; Start Test re-enters it.', 'ok');
      }
    });
    window.addEventListener('offline', () => {
      $('banner-offline').classList.remove('hidden');
      Proctor.offlineAt = Date.now();
      if (Proctor.running) Proctor.violation('Network offline', 'Browser went offline'); else Logger.add('Network offline', 'Browser went offline');
    });
    window.addEventListener('online', () => {
      $('banner-offline').classList.add('hidden');
      const s = Proctor.offlineAt ? ((Date.now() - Proctor.offlineAt) / 1000).toFixed(1) + 's offline' : '';
      Proctor.offlineAt = null;
      Logger.add('Network online', s);
    });
    if (!navigator.onLine) $('banner-offline').classList.remove('hidden');

    UI.status('fullscreen', 'err', 'OFF');
    UI.status('camera', 'pending', 'PENDING');
    UI.status('mic', 'pending', 'PENDING');
    UI.status('network', 'pending', '-- ms');
    UI.setViolations(0);
    SystemCheck.runAll(false);
    NetworkMonitor.startBackground();
  },

  async start() {
    if (!SystemCheck.allPass()) return;
    // Called from a click: allowed to request fullscreen.
    try { await document.documentElement.requestFullscreen(); }
    catch (e) { UI.toast(`Could not enter fullscreen (${e.name || 'error'}${e.message ? ': ' + e.message : ''}).`, 'error'); return; }
    NetworkMonitor.stopBackground();
    SystemCheck.stopFps();
    $('test-event-list').textContent = '';
    UI.showScreen('test');
    UI.status('camera', 'ok', 'OK'); UI.status('mic', 'ok', 'OK');
    Frames.start($('test-video'));
    Proctor.start();
  },

  /* End of test: stop detections, tracks, intervals; leave fullscreen; show report. */
  async finish(reason) {
    if (!Proctor.running) return;
    Logger.add('Test ended', reason);
    Proctor.stop();
    this.report = this.buildReport(reason);
    MicMeter.stop();
    SystemCheck.stopCam(); SystemCheck.stopMic(); SystemCheck.stopScreen();
    ['check-video', 'test-video'].forEach((id) => { $(id).srcObject = null; });
    if (document.fullscreenElement && document.exitFullscreen) { try { await document.exitFullscreen(); } catch (e) { /* ignore */ } }
    UI.status('camera', 'pending', 'OFF'); UI.status('mic', 'pending', 'OFF');
    this.renderReport();
    UI.showScreen('report');
  },

  buildReport(reason) {
    const p = Proctor.summary();
    return {
      generatedAt: new Date().toISOString(),
      endReason: reason,
      ...p,
      network: NetworkMonitor.summary(),
      environment: { userAgent: navigator.userAgent, platform: navigator.platform, screen: `${screen.width}x${screen.height}@${window.devicePixelRatio}x` },
      events: Logger.events.map(({ time, type, detail, category }) => ({ time, type, detail, category }))
    };
  },

  renderReport() {
    const r = this.report;
    UI.setText('rep-duration', fmtClock(r.durationSeconds));
    UI.setText('rep-flag-status', r.flagged ? 'Status: Would be FLAGGED (mock)' : 'Status: Clean (' + r.endReason + ')');
    UI.setText('rep-total-violations', String(r.totalViolations));
    const types = Object.keys(r.violationsByType);
    UI.setText('rep-violation-types', types.length + ' distinct type' + (types.length === 1 ? '' : 's'));
    UI.setText('rep-hw-uptime', `${r.uptimePercent.camera}% / ${r.uptimePercent.microphone}%`);
    UI.setText('rep-net-latency', r.network.avgMs === null ? '-- ms avg' : r.network.avgMs + ' ms avg');
    UI.setText('rep-net-spikes', `Worst: ${r.network.worstMs === null ? '--' : r.network.worstMs} ms | Spikes (>${CONFIG.SPIKE_MS}ms): ${r.network.lagSpikes}`);
    const row = (cells, cls) => { const tr = document.createElement('tr'); if (cls) tr.className = cls; cells.forEach((c) => { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }); return tr; };
    const vb = $('rep-violations-tbody'); vb.textContent = '';
    if (!types.length) vb.appendChild(row(['No violations recorded.', '']));
    types.forEach((t) => vb.appendChild(row([t, r.violationsByType[t]])));
    const eb = $('rep-events-tbody'); eb.textContent = '';
    r.events.forEach((e) => eb.appendChild(row([new Date(e.time).toLocaleTimeString(), e.category, e.type, e.detail], e.category === 'violation' ? 'row-violation' : '')));
  },

  /* Local-only download via Blob (nothing is uploaded). */
  download() {
    const blob = new Blob([JSON.stringify(this.report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `proctorlite-report-${Date.now()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  restart() {
    Logger.reset();
    Proctor.counts = {}; Proctor.total = 0;
    UI.setViolations(0);
    SystemCheck.reset();
    ['info-cam-label', 'info-cam-res', 'info-cam-fps', 'info-mic-label', 'info-net-rtt', 'info-net-jitter'].forEach((id) => UI.setText(id, '--'));
    UI.showScreen('check');
    UI.status('fullscreen', 'err', 'OFF');
    UI.status('camera', 'pending', 'PENDING'); UI.status('mic', 'pending', 'PENDING');
    SystemCheck.runAll(false);
    NetworkMonitor.startBackground();
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());

