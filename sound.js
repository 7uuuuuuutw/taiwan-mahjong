/* ============================================================
 * sound.js — 操作音效
 * 用 Web Audio 合成音效（打牌聲、胡牌音階、提示音），
 * 用 SpeechSynthesis 報牌（碰／吃／槓／胡／自摸）。
 * 全部內建，不需外部音檔，離線可用。
 * ============================================================ */

const Sound = (function () {
  let actx = null;
  let muted = false;

  function ctx() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) actx = new AC();
    }
    return actx;
  }

  /** 首次使用者互動後解鎖音訊（避免瀏覽器自動播放限制） */
  function resume() {
    const c = ctx();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
  }

  /** 單一音符 */
  function tone(freq, start, dur, vol = 0.2, type = 'sine') {
    const c = ctx();
    if (!c) return;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    o.connect(g);
    g.connect(c.destination);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(vol, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0008, start + dur);
    o.start(start);
    o.stop(start + dur + 0.02);
  }

  /** 打牌／摸牌的「喀」聲：帶通濾波的短噪音 */
  function clack(vol = 0.35) {
    const c = ctx();
    if (!c || muted) return;
    const now = c.currentTime;
    const len = Math.floor(c.sampleRate * 0.05);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    const filt = c.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = 2400;
    filt.Q.value = 0.8;
    const g = c.createGain();
    g.gain.value = vol;
    src.connect(filt);
    filt.connect(g);
    g.connect(c.destination);
    src.start(now);
    // 低頻「木頭感」補一下
    tone(180, now, 0.06, vol * 0.5, 'triangle');
  }

  /** 語音報牌 */
  function speak(text) {
    if (muted || !window.speechSynthesis) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-TW';
      u.rate = 1.05;
      u.pitch = 1.05;
      u.volume = 1;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  /* ---------- 對外音效 ---------- */
  return {
    resume,
    setMuted(m) { muted = m; if (m && window.speechSynthesis) window.speechSynthesis.cancel(); },
    isMuted() { return muted; },

    discard() { clack(0.35); },
    draw() { clack(0.18); },
    yourTurn() {
      const c = ctx(); if (!c || muted) return;
      const t = c.currentTime;
      tone(784, t, 0.12, 0.12, 'triangle');
      tone(1046, t + 0.09, 0.14, 0.1, 'triangle');
    },
    pong() { clack(0.4); speak('碰'); },
    chi() { clack(0.4); speak('吃'); },
    kong() { clack(0.4); speak('槓'); },
    hu(selfDraw) {
      const c = ctx(); if (!c) return;
      const t = c.currentTime;
      [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.12, 0.35, 0.25));
      speak(selfDraw ? '自摸' : '胡');
    },
    draw_game() {
      const c = ctx(); if (!c || muted) return;
      const t = c.currentTime;
      tone(392, t, 0.3, 0.15, 'sine');
      tone(330, t + 0.15, 0.4, 0.15, 'sine');
    },
  };
})();
