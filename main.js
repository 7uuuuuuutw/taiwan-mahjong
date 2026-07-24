/* ============================================================
 * main.js — UI 與流程整合
 * 大廳 / 等待室 / 牌桌渲染 / host 編排 / client 顯示
 * 依賴 mahjong.js, ai.js, game.js, network.js
 *
 * © 2026 7u. All Rights Reserved. 詳見專案根目錄 LICENSE。
 * ============================================================ */

// 版本號：直接沿用 index.html 幫這支 script 標的 ?v= 快取版本號，跟每次
// 改版強制重載用的是同一個數字，不用另外維護——玩家在大廳看到的版本號
// 就是「目前這台瀏覽器實際載入的是第幾版」，可以拿來確認有沒有更新到。
// 必須在頂層同步執行時讀取 document.currentScript，搬到函式裡就會是 null。
const APP_VERSION = (() => {
  try { return new URL(document.currentScript.src).searchParams.get('v') || '?'; }
  catch (e) { return '?'; }
})();

let net = new NetworkManager(); // 等待室房主轉移時需要整個換掉，不能是 const
let engine = null;          // host 才有
let myName = '';
let mySeat = 0;             // 我的座位（host 通常為 0）
let lastView = null;        // 最近一次收到/產生的視圖
let currentActions = null;  // 目前可行動作
let currentClaim = null;    // 目前索取視窗
let pendingChi = null;      // 吃的選擇暫存

// host 專用：座位 → { kind:'host'|'client'|'ai', peerId }
let seatOwners = [];
let lobbyPlayers = [];      // host 專用：等待室名單

/* ---------- 斷線偵測心跳 ----------
 * PeerJS 的連線 close 事件在真實斷線情境（WiFi 斷掉、App 被砍、換基地台）
 * 不一定會確實觸發，不能只靠它判斷斷線——改成雙方互相定期送 ping，
 * 超過門檻沒收到任何回應（含遊戲內其他訊息）就視同斷線。 */
const HEARTBEAT_INTERVAL_MS = 4000;
const HEARTBEAT_TIMEOUT_MS = 12000;
let heartbeatInterval = null;   // host 專用：定時 ping 各 client、檢查是否逾時
let lastSeenAt = {};            // host 專用：peerId → 最後收到訊息的時間
let lastHostMsgAt = 0;          // client 專用：最後收到 host 訊息的時間
let clientWatchdog = null;      // client 專用：定時檢查 host 是否已讀不回
let reconnectInFlight = false;  // client 專用：避免重連流程被重複觸發

/* ---------- 重新整理後自動回到房間（client 專用） ----------
 * 只存最基本的「房號＋座位＋名字」到 localStorage，重新整理（等於整個
 * JS 狀態重來）後如果還在有效期限內，就自動用同一個房號＋座位敲房主
 * 重連——host 端既有的重連判斷（見 hostHandleClientMessage 的 join
 * 分支）本來就接受這種請求，不需要另外改 host 邏輯。
 * 只對 client 有意義：host 重新整理等於整個 GameEngine（唯一的權威狀態）
 * 都沒了，重連也救不回來，所以不存。 */
const SESSION_KEY = 'mj_session_v1';
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 分鐘沒更新就視為過期，避免很久之後開新房間還被拉回舊房間
function saveSession() {
  try {
    const roomCode = document.getElementById('room-code-display').textContent;
    if (!roomCode || roomCode === '----') return;
    localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode, seat: mySeat, name: myName, ts: Date.now() }));
  } catch (e) {}
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
}
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.roomCode || s.seat == null || !s.name) return null;
    if (Date.now() - s.ts > SESSION_TTL_MS) { clearSession(); return null; }
    return s;
  } catch (e) { return null; }
}

/* ---------- 畫面切換 ---------- */
function show(screenId) {
  for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
  document.getElementById(screenId).classList.add('active');
}

/* ---------- 大廳/等待室動態背景（麻將氛圍） ----------
 * 飄浮的麻將牌（重用遊戲牌面）＋祥雲＋金塵，純裝飾不擋操作 */
function decorateBackground(screenId) {
  const screen = document.getElementById(screenId);
  if (!screen || screen.querySelector('.bg-decor')) return;
  const d = document.createElement('div');
  d.className = 'bg-decor';
  const TILES = ['m1', 'm5', 'm9', 'p1', 'p5', 'p9', 's1', 's5', 's8', 'z1', 'z5', 'z6', 'z7', 'f1', 'f5', 'p7'];
  let html = '';
  // 飄浮麻將牌
  for (let i = 0; i < 12; i++) {
    const t = TILES[Math.floor(Math.random() * TILES.length)];
    const size = 34 + Math.random() * 42;
    const dur = (18 + Math.random() * 22).toFixed(1);
    html += `<div class="float-tile" style="left:${(Math.random() * 100).toFixed(1)}%;` +
      `width:${size | 0}px;height:${(size * 1.35) | 0}px;font-size:${(size * .45) | 0}px;` +
      `--dur:${dur}s;--delay:${(-Math.random() * dur).toFixed(1)}s;` +
      `--rot:${(Math.random() * 80 - 40) | 0}deg;--drift:${(Math.random() * 140 - 70) | 0}px">` +
      tileFaceHTML(t) + `</div>`;
  }
  // 金塵光點
  for (let i = 0; i < 16; i++) {
    html += `<span class="spark" style="left:${(Math.random() * 100).toFixed(1)}%;top:${(Math.random() * 100).toFixed(1)}%;` +
      `--tw:${(2.2 + Math.random() * 4).toFixed(1)}s;--twd:${(Math.random() * 5).toFixed(1)}s"></span>`;
  }
  // 祥雲（線描，緩緩橫移）
  const cloud = `<svg class="cloud-svg" viewBox="0 0 200 60">
    <path d="M20 45 q-12 0 -12 -11 q0 -11 12 -11 q2 -12 15 -12 q11 0 15 9 q4 -6 12 -6 q11 0 13 10 q10 0 10 10.5 q0 10.5 -12 10.5 Z" fill="none" stroke="currentColor" stroke-width="2.5"/>
    <path d="M120 45 q-9 0 -9 -8 q0 -8 9 -8 q2 -9 11 -9 q8 0 11 7 q8 0 9 8 q1 10 -10 10 Z" fill="none" stroke="currentColor" stroke-width="2"/>
  </svg>`;
  html += `<div class="cloud cloud-a">${cloud}</div><div class="cloud cloud-b">${cloud}</div>`;
  d.innerHTML = html;
  screen.prepend(d);
}

/* ---------- 大廳按鈕 ---------- */
window.addEventListener('DOMContentLoaded', () => {
  const versionEl = document.getElementById('app-version');
  if (versionEl) versionEl.textContent = 'v' + APP_VERSION;
  // 意見回饋：mailto 連結內文預帶版本號，方便回報問題時附上。
  // 但很多電腦沒設定預設郵件軟體，點 mailto 會完全沒反應——所以點擊時
  // 同時把信箱複製到剪貼簿並跳提示，不管對方有沒有郵件軟體都拿得到
  // 聯絡方式，不會讓人以為按鈕壞掉。
  const FEEDBACK_EMAIL = 'dreemurr.0703@gmail.com';
  const feedbackEl = document.getElementById('btn-feedback');
  if (feedbackEl) {
    const subject = encodeURIComponent('台灣麻將 意見回饋');
    const bodyText = encodeURIComponent(`（請描述你遇到的問題或建議）\n\n版本：v${APP_VERSION}`);
    feedbackEl.href = `mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${bodyText}`;
    feedbackEl.addEventListener('click', () => {
      navigator.clipboard && navigator.clipboard.writeText(FEEDBACK_EMAIL);
      toast('已複製信箱 ' + FEEDBACK_EMAIL + '（若沒開啟郵件軟體可自行貼上寄信）');
    });
  }
  document.getElementById('btn-create').onclick = onCreateRoom;
  document.getElementById('btn-join').onclick = onJoinRoom;
  document.getElementById('btn-start').onclick = onHostStart;
  document.getElementById('btn-next').onclick = onNextHand;
  document.getElementById('btn-end').onclick = endGame;
  document.getElementById('btn-lobby').onclick = backToLobby;
  // 常駐胡牌鈕：按錯（牌未成）= 詐胡賠付！
  document.getElementById('btn-hu').onclick = sendHuAttempt;
  document.getElementById('btn-copy').onclick = () => {
    const code = document.getElementById('room-code-display').textContent;
    navigator.clipboard && navigator.clipboard.writeText(code);
    toast('已複製房號 ' + code);
  };
  document.getElementById('btn-copy-link').onclick = () => {
    const code = document.getElementById('room-code-display').textContent;
    const url = location.origin + location.pathname + '?room=' + code;
    navigator.clipboard && navigator.clipboard.writeText(url);
    toast('已複製邀請連結');
  };

  // 從邀請連結進來（?room=XXXX）：自動帶入房號，朋友只要填暱稱、按加入
  const roomFromLink = new URLSearchParams(location.search).get('room');
  if (roomFromLink) {
    document.getElementById('join-code-input').value = roomFromLink.toUpperCase().slice(0, 4);
    document.getElementById('name-input').focus();
  }

  // 特殊規則速查
  document.getElementById('btn-rules').onclick = () => { document.getElementById('rules-modal').style.display = 'flex'; };
  document.getElementById('btn-rules-close').onclick = () => { document.getElementById('rules-modal').style.display = 'none'; };

  // 遊玩統計
  document.getElementById('btn-stats').onclick = () => { renderStats(); document.getElementById('stats-modal').style.display = 'flex'; };
  document.getElementById('btn-stats-close').onclick = () => { document.getElementById('stats-modal').style.display = 'none'; };
  document.getElementById('btn-stats-reset').onclick = () => {
    if (confirm('確定要清除這台裝置上的遊玩統計嗎？')) { saveStats({ hands: 0, bigHands: {}, multiShots: {} }); renderStats(); }
  };
  document.getElementById('btn-leave').onclick = () => { clearSession(); location.reload(); };
  document.getElementById('btn-leave2').onclick = () => { clearSession(); location.reload(); };

  // 音效開關
  document.getElementById('btn-sound').onclick = (e) => {
    const nowMuted = !Sound.isMuted();
    Sound.setMuted(nowMuted);
    e.target.textContent = nowMuted ? '🔇' : '🔊';
  };
  // 首次互動解鎖音訊（瀏覽器自動播放限制）
  const unlock = () => { Sound.resume(); window.removeEventListener('pointerdown', unlock); };
  window.addEventListener('pointerdown', unlock);

  // 大廳與等待室的麻將氛圍動態背景
  decorateBackground('lobby-screen');
  decorateBackground('room-screen');

  attemptSessionResume();
});

/** 開頁時如果偵測到 30 分鐘內還有效的「上次房間」記錄，直接自動重連
 *  回去（不用使用者再輸入房號/暱稱一次）——對應斷線後把分頁整個重新
 *  整理的情境，跟一般斷線重連共用同一套 host 端接受邏輯與 client 端的
 *  rejoinAfterMigration 重試流程。 */
function attemptSessionResume() {
  const s = loadSession();
  if (!s) return;
  myName = s.name;
  mySeat = s.seat;
  document.getElementById('room-code-display').textContent = s.roomCode;
  document.getElementById('host-controls').style.display = 'none';
  show('game-screen');
  toast('偵測到你先前在房間 ' + s.roomCode + '，正在自動重新連線…');
  rejoinAfterMigration(s.roomCode);
}

// 音效用：追蹤狀態變化以觸發對應聲音
let sndPrevDiscards = 0;
let sndPrevMsg = '';
// 中央大牌動畫去重（防吃碰考慮期的二次閃爍）
let prevCenterKey = '';

/* ---------- 電腦角色對話泡泡（純演出） ---------- */
function charOf(seatName) {
  return AI_CHARACTERS.find(c => c.emoji + c.name === seatName) || null;
}

function showSpeech(seatIdx, text) {
  if (!lastView) return;
  const rel = (seatIdx - lastView.you + 4) % 4;
  const pos = SEAT_LABELS[rel];
  const seatEl = document.getElementById('seat-' + pos);
  if (!seatEl) return;
  const old = seatEl.querySelector('.speech-bubble');
  if (old) old.remove();
  const b = document.createElement('div');
  b.className = 'speech-bubble bubble-' + pos;
  b.textContent = text;
  seatEl.appendChild(b);
  // 上/下家（左右兩側）：.seat-left/.seat-right 的內容是整塊垂直置中
  // （align-content:center），螢幕越高（例如平板），名字標籤離容器頂端
  // 就越遠——CSS 寫死的 top 值只在手機那種內容剛好貼齊容器頂端的情況
  // 才準，螢幕變高就會讓泡泡冒在名字上方一大截、對不齊。改成量測名字
  // 標籤（.seat-info）在容器內的實際位置，泡泡才能在各種螢幕高度下都
  // 穩定貼著它。
  if (pos === 'left' || pos === 'right') {
    const infoEl = seatEl.querySelector('.seat-info');
    if (infoEl) b.style.top = (infoEl.offsetTop + infoEl.offsetHeight + 8) + 'px';
  }
  setTimeout(() => { if (b.parentNode) b.remove(); }, 3400);
}

/** 讓某座位的 AI 依情境說一句話（chance = 開口機率） */
function maybeSpeak(seatIdx, event, chance = 1) {
  if (seatIdx == null || seatIdx < 0 || !lastView) return;
  const s = lastView.seats[seatIdx];
  if (!s || !s.isAI) return;
  const ch = charOf(s.name);
  if (!ch || !ch.lines[event] || Math.random() > chance) return;
  const lines = ch.lines[event];
  showSpeech(seatIdx, lines[Math.floor(Math.random() * lines.length)]);
}

/** 找一位「非當事人」且真的有這句台詞的 AI 開口評論當事人（不是每個角色都會接這種話題） */
function maybeCommentOn(subjectSeat, event, chance = 1) {
  if (!lastView) return;
  const withLine = lastView.seats
    .map((s, i) => i)
    .filter(i => i !== subjectSeat && lastView.seats[i].isAI
      && charOf(lastView.seats[i].name) && charOf(lastView.seats[i].name).lines[event]);
  if (!withLine.length || Math.random() > chance) return;
  const speaker = withLine[Math.floor(Math.random() * withLine.length)];
  maybeSpeak(speaker, event, 1);
}

/* ---------- 特殊情境對話（觀察局勢觸發，非每角色皆有，每局各項最多說一次） ---------- */
let specialFired = new Set();          // 本局已觸發過的項目key
let specialLastHandSig = null;         // 判斷是否已進入新的一局（用 rollId，每局擲骰時才會變）
let skipStreak = [0, 0, 0, 0];         // 各家「本該摸牌卻被碰/槓跳過」連續次數
let lastDiscardFrom = null;            // 追蹤最近一次棄牌者（供判斷碰/槓是否跳過摸牌順位）

function resetSpecialDialogueIfNewHand(view) {
  // 注意：不能用「總棄牌數」當作換局訊號——吃/碰/槓會把被吃的那張牌從
  // 棄牌紀錄裡 pop 掉（見 game.js 的 discards.pop()），總棄牌數在同一局
  // 內反而會變少，誤判成「換局」而重置 specialFired，導致同一句台詞
  // （例如 honorBadLuck）在同一局內被吃碰觸發好幾次重複講。改用 rollId
  // （每局開局擲骰才 +1，同一局內恆定不變）才是真正可靠的換局訊號。
  const sig = view.rollId || 0;
  if (specialLastHandSig !== null && sig !== specialLastHandSig) {
    specialFired = new Set();
    skipStreak = [0, 0, 0, 0];
    lastDiscardFrom = null;
  }
  specialLastHandSig = sig;
}

/** 碰／槓跳過了誰的摸牌順位？連續跳過同一家 2 次以上，讓他喊一下想摸牌 */
function trackSkippedDraw(claimerSeat) {
  if (lastDiscardFrom == null) return;
  const naturalDrawer = (lastDiscardFrom + 1) % 4;
  if (claimerSeat === naturalDrawer) { skipStreak[naturalDrawer] = 0; return; }
  let s = naturalDrawer, guard = 0;
  while (s !== claimerSeat && guard < 4) {
    skipStreak[s] = (skipStreak[s] || 0) + 1;
    if (skipStreak[s] >= 2) {
      maybeSpeak(s, 'wantToDraw', .85);
      skipStreak[s] = 0;
    }
    s = (s + 1) % 4; guard++;
  }
}

/** 逐家檢查各種「看牌局猜牌型／猜運氣」的情境，符合就評論一次（本局內不重複） */
function checkSpecialDialogue(view) {
  resetSpecialDialogueIfNewHand(view);

  for (let seat = 0; seat < 4; seat++) {
    const s = view.seats[seat];
    const melds = s.melds || [];
    const discards = s.discards || [];

    // 混一色／清一色跡象：亮出面子 ≥2 組，且花色全同（排除字牌組）
    const suitedMelds = melds.filter(m => m.tiles && m.tiles.length && isSuited(m.tiles[0]));
    if (!specialFired.has('flush' + seat) && suitedMelds.length >= 2) {
      const suits = new Set(suitedMelds.map(m => m.tiles[0][0]));
      if (suits.size === 1) { specialFired.add('flush' + seat); maybeCommentOn(seat, 'flushWarn', .8); }
    }

    // 碰碰胡跡象：亮出面子 ≥2 組，全是碰／槓、完全沒有吃
    const nonChi = melds.filter(m => m.type === 'pong' || m.type === 'kong');
    const chiMelds = melds.filter(m => m.type === 'chi');
    if (!specialFired.has('pongpong' + seat) && nonChi.length >= 2 && chiMelds.length === 0) {
      specialFired.add('pongpong' + seat); maybeCommentOn(seat, 'pongpongWarn', .8);
    }

    // 頻繁吃：吃 ≥3 次 → 調侃上家餵飽飽
    if (!specialFired.has('chifeed' + seat) && chiMelds.length >= 3) {
      specialFired.add('chifeed' + seat); maybeCommentOn(seat, 'chiFeeding', .8);
    }

    // 門清跡象：牌牆剩 ≤30 張，該家完全沒有吃／碰／明槓（暗槓不影響門清）
    const hasOpenMeld = melds.some(m => !m.concealed);
    if (!specialFired.has('menqing' + seat) && view.wallLeft <= 30 && !hasOpenMeld) {
      specialFired.add('menqing' + seat); maybeCommentOn(seat, 'menqingWatch', .7);
    }

    // 連續打出大字（字牌）：最近三次棄牌都是字牌才觸發（原本只要連續兩次
    // 太容易中，講太頻繁；改成連三次且機率降低，變成比較少見的吐槽）
    if (!specialFired.has('honor' + seat) && discards.length >= 3) {
      const lastThree = discards.slice(-3);
      if (lastThree.every(t => t[0] === 'z')) { specialFired.add('honor' + seat); maybeCommentOn(seat, 'honorBadLuck', .5); }
    }

    // 連續兩回合打出同一張牌：推測摸進同一張，運氣很差
    if (!specialFired.has('same' + seat) && discards.length >= 2) {
      const lastTwo = discards.slice(-2);
      if (lastTwo[0] === lastTwo[1]) { specialFired.add('same' + seat); maybeCommentOn(seat, 'sameTileBadLuck', .75); }
    }

    // 補花手氣：單局補花 ≥3 張
    if (!specialFired.has('flowerlucky' + seat) && (s.flowers || []).length >= 3) {
      specialFired.add('flowerlucky' + seat); maybeCommentOn(seat, 'flowerLucky', .8);
    }
  }
}

/* ============================================================
 * 開房（HOST）
 * ============================================================ */
function onCreateRoom() {
  myName = (document.getElementById('name-input').value || '玩家').trim().slice(0, 8);
  // 自訂房號（選填）：留空就沿用原本的隨機 4 碼；有填就直接拿它當 PeerJS
  // 房間 ID，讓朋友能用好記的房號加入。
  const rawCode = (document.getElementById('custom-code-input').value || '').trim().toUpperCase();
  let customCode = null;
  if (rawCode) {
    if (!/^[A-Z0-9]{4,8}$/.test(rawCode)) {
      toast('自訂房號需為 4～8 碼英文字母或數字');
      return;
    }
    customCode = rawCode;
  }
  net.host(myName, (roomCode) => {
    mySeat = 0;
    // 固定 4 格：null = 空位（開局補電腦）。玩家可用 ↑↓ 換到任何位置（含對家）
    lobbyPlayers = [{ seat: 0, name: myName, kind: 'host', peerId: null }, null, null, null];
    document.getElementById('room-code-display').textContent = roomCode;
    document.getElementById('host-controls').style.display = 'block';
    show('room-screen');
    renderLobby();
  }, (err) => {
    // 自訂房號被占用時要讓玩家換一個試試，不能像隨機房號那樣自動偷換掉
    if (customCode && err && err.type === 'unavailable-id') {
      toast('這個房號已經有人在用，換一個試試');
    } else {
      toast('開房失敗：' + (err.message || err.type || err));
    }
  }, customCode);
  wireHostHandlers();
}

/** host 專用事件監聽（新開房、或等待室房主轉移後重新當房主都要掛上）。 */
function wireHostHandlers() {
  // 有 client 連上
  net.on('clientConnected', ({ peerId }) => {
    lastSeenAt[peerId] = Date.now(); // 等待對方送 join(name)，先預設視為存活
  });
  net.on('clientLeft', ({ peerId }) => {
    // 遊戲已經開始（不在等待室）：斷線只暫停該座位，等對方重連，不移出名單
    if (engine && engine.phase !== 'idle' && engine.phase !== 'over') {
      const seat = seatByPeer(peerId);
      if (seat >= 0) { engine.pauseGame(seat); return; }
    }
    lobbyPlayers = lobbyPlayers.map(p => (p && p.peerId === peerId) ? null : p);
    renderLobby();
    broadcastLobby();
  });
  net.on('clientMessage', ({ peerId, msg }) => hostHandleClientMessage(peerId, msg));

  // 心跳：定時 ping 所有 client，超過門檻沒有任何回應（含遊戲內其他訊息）
  // 就視同斷線並暫停——PeerJS 的 close 事件在真實斷線時不一定會觸發，
  // 不能只靠它判斷。等待室房主轉移重新掛上時要先清掉舊的計時器。
  clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (!engine || engine.phase === 'idle' || engine.phase === 'over') return;
    net.broadcast({ type: 'ping' });
    const now = Date.now();
    seatOwners.forEach(o => {
      if (o.kind !== 'client') return;
      const last = lastSeenAt[o.peerId];
      if (last != null && now - last > HEARTBEAT_TIMEOUT_MS &&
          engine.seats[o.seat] && engine.seats[o.seat].connected) {
        engine.pauseGame(o.seat);
      }
    });
  }, HEARTBEAT_INTERVAL_MS);
}

function hostHandleClientMessage(peerId, msg) {
  lastSeenAt[peerId] = Date.now(); // 任何訊息（含 pong）都算存活證明
  // 保險：心跳誤判暫停（例如筆電睡眠喚醒後短暫沒回應）但連線其實沒斷、
  // 同一條連線後來又送出訊息了，直接視為恢復，不用逼對方走一次完整重連。
  if (engine && engine.paused && seatByPeer(peerId) === engine.pausedSeat) {
    engine.resumeGame(engine.pausedSeat);
  }
  if (msg.type === 'join') {
    // 遊戲中斷線重連：rejoinSeat 對應目前這場牌局裡、原本屬於某個 client
    // 的座位 → 視為重連（換上新的 peerId、視需要恢復遊戲、補送一份最新
    // 視圖），不當成等待室的新加入處理。
    // 註：這裡刻意不要求「該座位當下一定要被標記成已斷線」——host 的
    // 斷線偵測（心跳／PeerJS close 事件）不一定會即時觸發，只要是自己
    // 過去這個座位、且重連訊息帶著 rejoinSeat（只有我方重連流程才會帶），
    // 就直接接受，避免偵測沒跟上導致重連永遠被當成新加入而失敗。
    if (engine && msg.rejoinSeat != null && engine.seats[msg.rejoinSeat] &&
        seatOwners[msg.rejoinSeat] && seatOwners[msg.rejoinSeat].kind === 'client') {
      const seat = msg.rejoinSeat;
      seatOwners[seat].peerId = peerId;
      if (engine.paused && engine.pausedSeat === seat) engine.resumeGame(seat);
      else engine.seats[seat].connected = true;
      net.sendTo(peerId, { type: 'view', view: engine.viewFor(seat) });
      return;
    }
    // rejoinSeat：等待室房主轉移後，原本的玩家重新連進來，優先還原原本
    // 坐的位置——那個位置若還是新房主暫記的「等你重連」佔位（peerId
    // 為 null）就直接接手；若已經被真正的連線佔走（少見的競爭情況）
    // 才退回找空位。
    let seat = -1;
    const slot = msg.rejoinSeat != null ? lobbyPlayers[msg.rejoinSeat] : undefined;
    if (msg.rejoinSeat != null && msg.rejoinSeat >= 0 && msg.rejoinSeat <= 3 && (!slot || slot.peerId == null)) {
      seat = msg.rejoinSeat;
    } else {
      seat = lobbyPlayers.findIndex(p => !p);
    }
    if (seat < 0) {
      net.sendTo(peerId, { type: 'roomFull' });
      return;
    }
    lobbyPlayers[seat] = { seat, name: (msg.name || '玩家').slice(0, 8), kind: 'client', peerId };
    renderLobby();
    broadcastLobby();
  } else if (msg.type === 'action') {
    if (engine) {
      const seat = seatByPeer(peerId);
      if (seat >= 0) engine.playerAct(seat, msg.action);
    }
  } else if (msg.type === 'claim') {
    if (engine) {
      const seat = seatByPeer(peerId);
      if (seat >= 0) engine.playerAct(seat, msg.decision);
    }
  }
}

function seatByPeer(peerId) {
  const p = seatOwners.find(o => o && o.peerId === peerId);
  return p ? p.seat : -1;
}

function reindexSeats() {
  lobbyPlayers.forEach((p, i) => { if (p) p.seat = i; });
}

function broadcastLobby() {
  const players = lobbyPlayers
    .map((x, i) => x ? { seat: i, name: x.name, isHost: x.kind === 'host' } : null)
    .filter(Boolean);
  lobbyPlayers.forEach(p => {
    if (p && p.kind === 'client') {
      net.sendTo(p.peerId, { type: 'lobby', players, yourSeat: p.seat });
    }
  });
}

function renderLobby() {
  const box = document.getElementById('player-list');
  box.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const p = lobbyPlayers[i];
    const div = document.createElement('div');
    div.className = 'lobby-slot';
    if (p) {
      div.innerHTML = `<span class="slot-seat">座位 ${i + 1}</span>
        <span class="slot-name">${escapeHtml(p.name)}${p.kind === 'host' ? ' 👑' : ''}${p.seat === mySeat && net.isHost ? '（你）' : ''}</span>`;
      // host 可調整座位（可與空位/電腦互換 → 兩名玩家能坐對家）
      if (net.isHost) {
        const ctrl = document.createElement('span');
        ctrl.className = 'slot-ctrl';
        if (i > 0) {
          const up = document.createElement('button');
          up.className = 'mini-btn'; up.textContent = '↑';
          up.onclick = () => moveSeat(i, i - 1);
          ctrl.appendChild(up);
        }
        if (i < 3) {
          const dn = document.createElement('button');
          dn.className = 'mini-btn'; dn.textContent = '↓';
          dn.onclick = () => moveSeat(i, i + 1);
          ctrl.appendChild(dn);
        }
        div.appendChild(ctrl);
      }
    } else {
      div.classList.add('empty');
      div.innerHTML = `<span class="slot-seat">座位 ${i + 1}</span><span class="slot-name">空位 → 電腦補位</span>`;
    }
    box.appendChild(div);
  }
}

/** host 調整座位（目標可為空位/電腦位） */
function moveSeat(a, b) {
  if (!net.isHost || !lobbyPlayers[a] || b < 0 || b > 3) return;
  [lobbyPlayers[a], lobbyPlayers[b]] = [lobbyPlayers[b], lobbyPlayers[a]];
  reindexSeats();
  // 更新自己的座位號
  const me = lobbyPlayers.find(p => p && p.kind === 'host');
  if (me) mySeat = me.seat;
  renderLobby();
  broadcastLobby();
}

/* ---------- 電腦角色（個性與情境對話，純演出不影響遊戲） ---------- */
const AI_CHARACTERS = [
  { name: '旺來伯', emoji: '🍍', style: 'gambler', lines: { // 台語老江湖
    greet: ['少年仔，來啦來啦～', '呷飽沒？來摸兩圈！'],
    pong: ['碰！這款好料我怎會放過', '歹勢啦，碰！'],
    chi: ['呷一下無要緊乎？', '吃！嘸通見怪～'],
    kong: ['槓落去！氣魄啦！', '哈！四支全到齊'],
    flower: ['喔～有花有春！', '花開富貴啦！'],
    win: ['哈哈，緊來算台！', '少年仔，學著點～'],
    tsumo: ['自摸啦！緊來看！', '天公疼憨人～自摸！'],
    lose: ['唉唷，煞去了了…', '這張嘸應該打的啦…'],
    draw: ['流局喔，摸心酸的', '嘸魚蝦也好…再來！'],
    dice: ['骰仔有靈聖喔！', '你看這手氣！'],
    mock: ['啊你是在胡啥啦！', '憨囝仔，詐胡是要賠錢的餒'],
  }},
  { name: '阿花姨', emoji: '🌺', style: 'aggressive', lines: { // 菜市場戰神，愛碎念
    greet: ['我跟你說，我今天手氣特別好', '等我一下，滷肉還在爐上'],
    pong: ['碰！這我要的啦', '碰起來！別跟我搶'],
    chi: ['吃啊，不吃白不吃', '這張我等很久了餒'],
    kong: ['槓！嚇到了齁', '四張咧，看到沒？'],
    flower: ['花喔？我最愛花了', '又補花，美賣美賣'],
    win: ['哎唷胡了啦！快點算錢', '我就說我今天手氣好吧！'],
    tsumo: ['自摸！通通拿錢來', '菜市場殺價都沒這麼爽！'],
    lose: ['夭壽喔放槍了…', '氣死我了，這局不算啦（開玩笑的）'],
    draw: ['摸半天摸個寂寞', '流局？我滷肉都滷好了'],
    dice: ['看我的骰！旺喔！', '這骰數，發啦！'],
    mock: ['嘖嘖，詐胡喔，丟臉丟到家', '看清楚再喊啦！'],
    chiFeeding: ['你上家根本在餵你吃到飽耶', '這樣吃法，上家都要跳腳了'],
  }},
  { name: '雀聖', emoji: '🐦', style: 'defensive', lines: { // 高深莫測的宗師
    greet: ['牌品即人品。', '靜心，方能聽牌。'],
    pong: ['碰。此乃天意。', '碰。時機已至。'],
    chi: ['吃。順勢而為。', '牌河之流，取之有道。'],
    kong: ['槓。四象歸一。', '槓上，或有花開。'],
    flower: ['花自飄零水自流。', '一花一世界。'],
    win: ['勝負，早在十巡前已定。', '承讓。'],
    tsumo: ['自摸。萬象歸心。', '此牌，本座等了三巡。'],
    lose: ['大意了。', '牌局如人生，起落無常。'],
    draw: ['無勝無敗，亦是一局。', '流局，天不欲戰。'],
    dice: ['骰運通天。', '此數，吉。'],
    mock: ['心浮氣躁，故有此敗。', '詐胡者，戒。'],
    flushWarn: ['牌河一色，此局非同小可。', '色調漸純，不可小覷。'],
    menqingWatch: ['不動聲色，門清氣度。', '靜觀其變，是在等一鳴驚人。'],
  }},
  { name: '紅中俠', emoji: '🀄', style: 'aggressive', lines: { // 中二武俠
    greet: ['紅中俠參上！今日必雪前恥！', '江湖險惡，牌桌更甚！'],
    pong: ['碰！接我這招！', '哼，天下武功唯快不破！'],
    chi: ['吃！此乃借力打力！', '多謝施主贈牌！'],
    kong: ['開槓！見識我的絕學！', '四連斬！'],
    flower: ['花蝴蝶步法！', '踏花歸去馬蹄香！'],
    win: ['勝負已分！承讓承讓！', '此役必載入江湖史冊！'],
    tsumo: ['自摸！天助我也！', '哈哈哈！氣運在我！'],
    lose: ['嗚呼！中計了！', '此仇不報非君子！'],
    draw: ['平手？下回再戰！', '勝負未分，來日方長！'],
    dice: ['骰出驚天之數！', '此乃天命！'],
    mock: ['詐胡？武林大忌！', '年輕人，莫要心急！'],
  }},
  { name: '發財哥', emoji: '💰', style: 'bigHand', lines: { // 滿腦子錢
    greet: ['各位！今天誰要發財？', '本金帶夠沒？哈哈！'],
    pong: ['碰！穩賺不賠！', '這張是績優股，碰！'],
    chi: ['吃！低買高賣！', '這波我抄底！'],
    kong: ['槓！翻倍再翻倍！', '梭哈！全押！'],
    flower: ['花牌就是股利！', '被動收入又進帳！'],
    win: ['財富自由！就是現在！', '收租啦各位～'],
    tsumo: ['自摸！漲停板！', '這局年化報酬率爆表！'],
    lose: ['崩盤了崩盤了…', '這是計畫性虧損…對，計畫性的'],
    draw: ['橫盤整理，下局突破', '沒賺沒賠，手續費都省了'],
    dice: ['開盤大吉！', '這骰數，牛市啊！'],
    mock: ['詐胡跟內線交易一樣母湯！', '違約交割囉～'],
  }},
  { name: '骰神', emoji: '🎲', style: 'gambler', lines: { // 迷信賭徒
    greet: ['今天黃道吉日，宜打牌', '我拜過了，這局穩的'],
    pong: ['碰！運勢來了擋不住！', '碰！這是註定的'],
    chi: ['吃！命中帶吃！', '流年利我！'],
    kong: ['槓！勢不可擋！', '槓出一片天！'],
    flower: ['花開見喜！', '這花是幸運之兆！'],
    win: ['我就說我拜過了吧！', '運！全是運！'],
    tsumo: ['自摸！神明保佑！', '擲筊擲出來的自摸！'],
    lose: ['等等，我再去拜一下…', '水逆！一定是水逆！'],
    draw: ['天機未到，再等等', '這局神明在休息'],
    dice: ['看到沒！這就是骰神！', '骰出吉數，大殺四方！'],
    mock: ['亂喊胡會倒楣三年喔', '神明都看不下去了'],
    honorBadLuck: ['連字都不放過你，水逆無誤', '字牌纏身，該去收驚了'],
  }},
  { name: '月光姐', emoji: '🌙', style: 'defensive', lines: { // 優雅淡定
    greet: ['晚上好，各位。', '願今晚牌局如月色般美好。'],
    pong: ['碰。失禮了。', '這張，我便收下了。'],
    chi: ['吃。謝謝你。', '正好缺這張呢。'],
    kong: ['槓。難得的緣分。', '四張齊聚，像滿月呢。'],
    flower: ['花好月圓。', '這花，真美。'],
    win: ['承讓了，各位。', '月滿則盈，胡了。'],
    tsumo: ['自摸。月光眷顧。', '靜靜地，就胡了呢。'],
    lose: ['月有陰晴圓缺，難免的。', '無妨，下局再來。'],
    draw: ['流局也有流局的美。', '就當賞了一輪月吧。'],
    dice: ['月色與骰運都正好。', '好兆頭。'],
    mock: ['急躁了呢。', '深呼吸，再看一次牌吧。'],
    menqingWatch: ['始終不動聲色，門清氣度呢。', '這樣的沉靜，是在醞釀大牌吧。'],
  }},
  { name: '海底撈', emoji: '🎣', style: 'bigHand', lines: { // 釣魚梗大王
    greet: ['今天來釣大魚！', '魚餌上好了，開局！'],
    pong: ['碰！上鉤了！', '這尾我要了！'],
    chi: ['吃！願者上鉤！', '收線收線～'],
    kong: ['槓！一網打盡！', '四尾一起收！'],
    flower: ['撈到水草…不對，是花！', '副產物也不錯！'],
    win: ['大豐收！收竿！', '這尾夠肥！'],
    tsumo: ['海底撈月！撈到了！', '自摸！魚獲滿艙！'],
    lose: ['線斷了…', '魚跑了啦！'],
    draw: ['今天魚不咬餌', '空軍！明天再來'],
    dice: ['浪頭正好！', '出海吉日！'],
    mock: ['喊胡前先看魚上鉤沒啊', '空鉤起竿，糗了吧'],
    chiFeeding: ['上家在放飼料喔，吃不停', '這魚餌也太多了吧'],
  }},
  { name: '龜速伯', emoji: '🐢', style: 'defensive', lines: { // 慢性子
    greet: ['等等我…讓我坐好…', '不急，牌會等人的…'],
    pong: ['等一下…碰。', '慢慢來…碰。'],
    chi: ['讓我想想…吃。', '嗯…吃好了。'],
    kong: ['這個…槓吧。', '不急不急…槓。'],
    flower: ['喔？有花？我看看…', '慢工出細活，補花～'],
    win: ['咦，我胡了？', '慢慢打…也是會胡的。'],
    tsumo: ['等等…這是自摸吧？', '龜兔賽跑，懂？'],
    lose: ['唉呀…放槍了嗎…', '太急了，我太急了…'],
    draw: ['流局了？我才剛熱身…', '呼…終於可以休息了'],
    dice: ['骰子…滾慢一點…', '好數字，不錯不錯…'],
    mock: ['你看，急就出錯了吧…', '像我這樣慢慢確認嘛…'],
    wantToDraw: ['喂…輪到我摸牌了沒…', '一直被碰過去，我也想摸牌啊…'],
  }},
  { name: '小辣椒', emoji: '🌶️', style: 'aggressive', lines: { // 嗆辣直球
    greet: ['就這陣容？贏定了', '手下不留情喔，先說'],
    pong: ['碰！不好意思喔～', '這張？我的！'],
    chi: ['吃！謝謝招待～', '送到嘴邊哪有不吃的'],
    kong: ['槓！怕了吧！', '四張！服不服？'],
    flower: ['連花都站我這邊', '美的東西都歸我'],
    win: ['太弱了吧～胡了！', '就說贏定了嘛！'],
    tsumo: ['自摸！自己看台數！', '完美！無可挑剔！'],
    lose: ['嘖！算你厲害…這次啦', '哼，讓你一次'],
    draw: ['無聊！都不給胡', '你們防太緊了吧！'],
    dice: ['看到沒？氣勢！', '骰子也懂看人臉色'],
    mock: ['噗，詐胡？笑死', '衝動是魔鬼～'],
    sameTileBadLuck: ['同一張連兩次？運氣有夠爛', '這是特別想供養那張牌嗎'],
  }},
  { name: '阿吉師', emoji: '🔥', style: 'aggressive', lines: { // 台式黑手工頭，做事衝
    greet: ['開工開工，今仔日拚一下！', '免驚，我攏嘛全力以赴'],
    pong: ['碰！手路到位！', '免客氣，我拿去！'],
    chi: ['吃！順手牽羊', '吃起來，繼續衝！'],
    kong: ['槓落去，大工程開始！', '槓！加碼下去！'],
    flower: ['花也拿去，賺到賺到', '順便補一支花'],
    win: ['贏啦！收工領錢！', '衝就對了，胡啦！'],
    tsumo: ['自摸！力量的證明！', '免放槍，自己摸就好！'],
    lose: ['哎，這關過不去', '拚過頭，煞去'],
    draw: ['流局？下一場再拚', '沒關係，工程還沒完'],
    dice: ['骰仔給我大力一點！', '這手氣不錯喔！'],
    mock: ['衝過頭就是這樣', '做工也要看時機啦'],
  }},
  { name: '風火輪嫂', emoji: '🛞', style: 'speed', lines: { // 做什麼都風風火火
    greet: ['來來來，別浪費時間', '手腳要快，牌才會贏'],
    pong: ['碰，秒殺！', '快狠準，碰！'],
    chi: ['吃，別耽誤時間', '吃了就走，效率至上'],
    kong: ['槓，一次到位！', '槓完馬上補！'],
    flower: ['花補一下，順便的事', '快速補花，不囉唆'],
    win: ['胡了！我最快！', '看吧，速度才是王道'],
    tsumo: ['自摸，眨眼間的事', '快！自摸來了！'],
    lose: ['太趕了，漏算一步', '下次要更快'],
    draw: ['流局也不浪費時間', '走，下一局！'],
    dice: ['骰子咻一下就好了', '快轉，看結果！'],
    mock: ['衝太快反而摔跤', '欲速則不達啦'],
  }},
  { name: '錦鯉妹', emoji: '🐠', style: 'gambler', lines: { // 自認超強運
    greet: ['我是錦鯉本鯉，沾點運氣', '今天氣場很旺喔'],
    pong: ['碰！錦鯉附體！', '運氣來了擋不住，碰！'],
    chi: ['吃，這是命運安排', '吃了，緣分到了'],
    kong: ['槓！大吉大利！', '槓出好運道！'],
    flower: ['錦鯉當然要花團錦簇', '花來了，好兆頭！'],
    win: ['看吧，我就是錦鯉！', '沾我的手氣，胡啦！'],
    tsumo: ['自摸！錦鯉威力！', '運氣爆棚，自摸！'],
    lose: ['咦，今天鯉魚失靈？', '運氣也有離線的時候'],
    draw: ['流局，鯉魚在充電', '沒事，運氣蓄力中'],
    dice: ['骰子聽我的，旺！', '錦鯉骰，必是好數！'],
    mock: ['亂喊胡，鯉魚都嚇跑了', '衝動不是好運，是傻運'],
    honorBadLuck: ['哎呀，這運氣不太行喔', '字牌連發，鯉魚都幫不了你'],
    flowerLucky: ['花朵朵開，本鯉的福氣分你一點', '這花運，跟我有得拼喔'],
  }},
  { name: '老棋王', emoji: '♟️', style: 'defensive', lines: { // 下棋式精算，滴水不漏
    greet: ['且慢，棋要一步步下', '穩紮穩打，方能致勝'],
    pong: ['碰，此步算過了', '碰，穩健之選'],
    chi: ['吃，順勢佈局', '吃這張，棋路更穩'],
    kong: ['槓，局勢已算清', '槓，穩中求進'],
    flower: ['花，錦上添花罷了', '順手補花，無傷大雅'],
    win: ['將軍，胡牌', '此局，老夫勝出'],
    tsumo: ['自摸，一切盡在計算中', '按部就班，自摸而已'],
    lose: ['一步錯，滿盤輸', '棋差一著，甘拜下風'],
    draw: ['和局，亦是常態', '不輸不贏，穩妥'],
    dice: ['骰數已定，穩住', '此數，可攻可守'],
    mock: ['心急吃不了熱豆腐', '莽撞之舉，不可取'],
    pongpongWarn: ['碰碰碰，此局意在速戰速決。', '棋風剛猛，碰碰胡無誤。'],
    distrustAfterFalseHu: ['此人棋風不正，需多留意。', '詐胡一次，信譽已折損。'],
  }},
  { name: '一色痴', emoji: '🎨', style: 'bigHand', lines: { // 執著清一色、寧缺勿濫
    greet: ['今天，一定要清一色', '雜色免談，純色才美'],
    pong: ['碰？只碰同色的', '同花色，才值得碰'],
    chi: ['吃，維持我的純色大業', '這張補得漂亮'],
    kong: ['槓，同色槓最美', '槓出一片天，同色的'],
    flower: ['花不分色，來者不拒', '花牌，錦上添花'],
    win: ['清一色，這才叫藝術！', '看，純色就是暴力！'],
    tsumo: ['自摸，純色的勝利！', '一色到底，自摸！'],
    lose: ['雜了，可惜這手好牌', '差一點就純色了…'],
    draw: ['流局，純色大業延後', '沒關係，下局繼續追'],
    dice: ['骰子也要有品味', '這數字，有藝術感'],
    mock: ['亂喊胡，毀了我的畫作', '色都沒湊齊喊什麼胡'],
    flushWarn: ['喔？這手該不會是清一色吧…', '同色來同色去，內行的都懂'],
  }},
  { name: '拼場霸', emoji: '💪', style: 'aggressive', lines: { // 氣勢壓人、逢碰必碰
    greet: ['今天這場，我罩！', '誰要跟我拼一下？'],
    pong: ['碰！氣勢不能輸！', '碰下去，別客氣！'],
    chi: ['吃！先搶先贏！', '吃了就是我的！'],
    kong: ['槓！霸氣外露！', '槓落去，展現實力！'],
    flower: ['花也要搶第一', '順便拿花，不吃虧'],
    win: ['霸主駕到，胡了！', '看誰還敢跟我拼！'],
    tsumo: ['自摸！我最強！', '不用等，自己摸贏！'],
    lose: ['哼，這局算你的', '下把討回來！'],
    draw: ['流局，算你們好運', '沒關係，氣勢還在'],
    dice: ['骰子也要聽我的！', '這氣勢，穩了！'],
    mock: ['亂喊胡，氣勢都沒了', '拼過頭也要看牌啊'],
    pongpongWarn: ['喲，全碰？跟我拼氣勢啊', '碰碰胡是吧，看誰先到'],
  }},
  { name: '抓藥仙', emoji: '🌿', style: 'defensive', lines: { // 中藥行老闆，慢工出細活但精準
    greet: ['慢慢來，把脈先', '穩，才是養生之道'],
    pong: ['碰，這味藥剛好', '碰，配方剛剛好'],
    chi: ['吃，補一帖剛好', '吃了，藥性更全'],
    kong: ['槓，藥效加倍', '槓，補齊藥材'],
    flower: ['花，養眼養生', '順手採一朵花'],
    win: ['方子成了，胡牌', '藥到病除，胡啦'],
    tsumo: ['自摸，體內調理好了', '不假外求，自摸'],
    lose: ['藥不對症，可惜', '這帖藥，下錯了'],
    draw: ['流局，療程未完', '慢慢調理，別急'],
    dice: ['骰數如脈象，看穩不穩', '此數，氣血通暢'],
    mock: ['心急藥材會抓錯', '亂胡如亂服藥，傷身'],
    sameTileBadLuck: ['同款藥材連抓兩次，機率不低啊', '這味道，跟上次一模一樣呢'],
    distrustAfterFalseHu: ['亂喊的藥方，以後要多秤三分', '這帖不準，下次得再三確認'],
  }},
  { name: '衝浪弟', emoji: '🏄', style: 'speed', lines: { // 年輕衝動、抓緊每個機會
    greet: ['浪來了，衝就對了！', '準備好接招沒？'],
    pong: ['碰！浪頭抓住了！', '碰，站穩浪板！'],
    chi: ['吃！乘風而起！', '吃了，順著浪走！'],
    kong: ['槓！大浪來了！', '槓，衝上浪尖！'],
    flower: ['花，順便撿個貝殼', '補花，海邊小確幸'],
    win: ['胡了！完美衝浪！', '看我漂亮落地，胡！'],
    tsumo: ['自摸！浪尖上的勝利！', '自己衝出來的，自摸！'],
    lose: ['哇，吃浪了…', '摔了，這浪太猛'],
    draw: ['流局，風平浪靜', '沒浪，休息一下'],
    dice: ['骰子跟浪一樣難測', '這數，浪頭正好！'],
    mock: ['衝過頭會摔的啦', '看錯浪，這下糗了'],
    wantToDraw: ['我的浪呢？都被搶走了啦', '一直碰，浪頭都不給我了！'],
  }},
  { name: '賭神嫂', emoji: '🎰', style: 'gambler', lines: { // 拉霸機式豪賭精神
    greet: ['拉霸機都輸我，來吧', '今天要下重注了'],
    pong: ['碰！全下！', '梭哈精神，碰！'],
    chi: ['吃，小賭怡情', '吃了，繼續加碼'],
    kong: ['槓！All in！', '槓，賭場都嚇到'],
    flower: ['花來了，附贈的籌碼', '中獎啦，花牌！'],
    win: ['莊家通殺，胡牌！', '賭神駕到，收錢！'],
    tsumo: ['自摸！豹子連線！', '中頭獎啦，自摸！'],
    lose: ['唉，這把梭哈失敗', '賭神也有失手時'],
    draw: ['流局，籌碼先收好', '沒開獎，再等等'],
    dice: ['骰子才是我的主場！', '看這手氣，穩贏！'],
    mock: ['亂梭哈是會傾家蕩產的', '賭也要有分寸啦'],
    flowerLucky: ['花開連連，這運勢我要下注', '中獎連莊，發財花啊'],
  }},
  { name: '隱士翁', emoji: '🎋', style: 'bigHand', lines: { // 大隱於市，不動則已一動驚人
    greet: ['老夫深居簡出，今日現身', '不鳴則已，一鳴驚人'],
    pong: ['碰？俗物，勉強為之', '碰，權宜之計'],
    chi: ['吃，暫且將就', '吃了，靜待時機'],
    kong: ['槓，蓄勢待發', '槓，為大局鋪路'],
    flower: ['花，山野間常見之物', '順手拾花'],
    win: ['厚積薄發，胡矣', '大隱於市，一胡驚人'],
    tsumo: ['自摸，天地自有安排', '不爭而得，自摸'],
    lose: ['罷了，順其自然', '此局，隨風而去'],
    draw: ['流局，正合我意', '無為而治，甚好'],
    dice: ['骰數如天意，不可強求', '此數，順應自然'],
    mock: ['心浮氣躁，非隱士所為', '妄動者，必有所失'],
  }},
];

/* 牌背配色（面、深、邊框） */
const BACK_COLORS = {
  green: ['#2b8f5a', '#1c6b41', '#14512f'],
  blue: ['#2b6fb0', '#1c4f86', '#143a63'],
  red: ['#b04a3f', '#8a2f27', '#63201a'],
  purple: ['#7a4fb0', '#5a3786', '#3f2663'],
  night: ['#4a4a55', '#33333c', '#222228'],
  gold: ['#e8c86a', '#c9a227', '#8a6b12'],
  pink: ['#f28fb0', '#d95c8a', '#a83c66'],
  tiffany: ['#5fcfc7', '#0abab5', '#087f7c'],
};
function applyTileBack(key) {
  const c = BACK_COLORS[key] || BACK_COLORS.green;
  const r = document.documentElement.style;
  r.setProperty('--tb1', c[0]);
  r.setProperty('--tb2', c[1]);
  r.setProperty('--tb3', c[2]);
}

function onHostStart() {
  // 讀取房間設定
  const [optDi, optTai] = document.getElementById('opt-stakes').value.split(',').map(Number);
  const optTimerSec = +document.getElementById('opt-timer').value;
  const optAi = document.getElementById('opt-ai').value;
  const optBack = document.getElementById('opt-back').value;
  const optLigu = document.getElementById('opt-ligu').checked;
  const optDiceBonus = document.getElementById('opt-dicebonus').checked;
  const optLeopard = document.getElementById('opt-leopard').value;
  applyTileBack(optBack);

  // 組出 4 個座位（不足補 AI，給創意名字）
  const aiPool = AI_CHARACTERS.slice().sort(() => Math.random() - 0.5);
  const seats = [];
  seatOwners = [];
  for (let i = 0; i < 4; i++) {
    const p = lobbyPlayers[i];
    if (p) {
      seats.push({ id: 'p' + i, name: p.name, isAI: false });
      seatOwners.push({ seat: i, kind: p.kind, peerId: p.peerId });
    } else {
      const prof = aiPool.pop() || { name: '電腦' + (i + 1), emoji: '🤖', style: 'balanced' };
      seats.push({ id: 'ai' + i, name: prof.emoji + prof.name, isAI: true, aiStyle: prof.style || 'balanced' });
      seatOwners.push({ seat: i, kind: 'ai', peerId: null });
    }
  }

  engine = new GameEngine(seats, hostEmit, {
    roundWind: 0, dealer: 0, dealerStreak: 0,
    baseDi: optDi, baseTai: optTai, turnLimitMs: optTimerSec * 1000,
    aiLevel: optAi, ligu: optLigu, diceBonus: optDiceBonus, leopardMode: optLeopard,
  });

  // 通知所有 client 進入遊戲（含牌背顏色設定）
  seatOwners.forEach(o => {
    if (o.kind === 'client') net.sendTo(o.peerId, { type: 'gameStart', yourSeat: o.seat, tileBack: optBack });
  });
  show('game-screen');
  engine.startHand();
}

/** host 端 GameEngine 事件分派 */
function hostEmit(event, payload) {
  if (event === 'state') {
    // 給每個座位個人化視圖
    seatOwners.forEach(o => {
      const view = engine.viewFor(o.seat);
      view.stateMessage = payload.message;
      if (o.kind === 'client') net.sendTo(o.peerId, { type: 'view', view });
      else if (o.kind === 'host') renderView(view);
    });
  } else if (event === 'yourTurn') {
    const o = seatOwners[payload.seat];
    if (o.kind === 'client') net.sendTo(o.peerId, { type: 'yourTurn', tile: payload.tile, actions: payload.actions, kong: payload.kong });
    else if (o.kind === 'host') showTurnActions(payload);
    // AI 由 engine 內部處理
  } else if (event === 'claimOffer') {
    const o = seatOwners[payload.seat];
    if (o.kind === 'client') net.sendTo(o.peerId, { type: 'claimOffer', tile: payload.tile, from: payload.from, options: payload.options });
    else if (o.kind === 'host') showClaimOffer(payload);
  } else if (event === 'rollDiceRequest') {
    const o = seatOwners[payload.seat];
    if (o.kind === 'client') net.sendTo(o.peerId, { type: 'rollDiceRequest' });
    else if (o.kind === 'host') showRollButton();
  } else if (event === 'handOver') {
    seatOwners.forEach(o => {
      if (o.kind === 'client') net.sendTo(o.peerId, { type: 'handOver', payload });
    });
    showHandOver(payload);
  } else if (event === 'gamePaused') {
    seatOwners.forEach(o => {
      if (o.kind === 'client') net.sendTo(o.peerId, { type: 'gamePaused', payload });
    });
    showPauseOverlay(payload);
  } else if (event === 'gameResumed') {
    seatOwners.forEach(o => {
      if (o.kind === 'client') net.sendTo(o.peerId, { type: 'gameResumed', payload });
    });
    hidePauseOverlay();
  }
}

/** 有人斷線：整桌暫停並顯示遮罩；resumed 時關閉。host 自己（若也在玩）
 *  跟 client 共用這兩個函式——client 端由 clientHandleHostMessage 呼叫。 */
function showPauseOverlay(payload) {
  const overlay = document.getElementById('pause-overlay');
  const msg = document.getElementById('pause-msg');
  const name = (payload && payload.name) ? payload.name : '玩家';
  msg.textContent = `${name} 斷線中，等待重新連線…`;
  overlay.style.display = 'flex';
}
function hidePauseOverlay() {
  document.getElementById('pause-overlay').style.display = 'none';
}

function onNextHand() {
  document.getElementById('result-modal').style.display = 'none';
  if (net.isHost && engine) {
    // 莊家在贏家中 → 連莊；流局/詐胡/他家胡 → 換莊
    const dealerWin = !!(lastHandOver && lastHandOver.dealerWin);
    engine.nextHand(dealerWin);
  }
}

/* ============================================================
 * 加入房間（CLIENT）
 * ============================================================ */
function onJoinRoom() {
  myName = (document.getElementById('name-input').value || '玩家').trim().slice(0, 8);
  const code = document.getElementById('join-code-input').value;
  if (!code) { toast('請輸入房號'); return; }
  net.join(code, myName, () => {
    document.getElementById('host-controls').style.display = 'none';
    document.getElementById('room-code-display').textContent = code.toUpperCase();
    show('room-screen');
    toast('已連上房間，等待房主開始…');
    startClientWatchdog();
  }, (err) => {
    toast('加入失敗：' + (err.message || err.type || err));
  });

  net.on('hostMessage', ({ msg }) => clientHandleHostMessage(msg));
  net.on('hostLeft', onHostLeft);
}

/** 定時檢查是否太久沒收到 host 的任何訊息（含 ping）——跟 host 端的心跳
 *  對稱，同樣是因為 PeerJS 的 close 事件不一定會在真實斷線時觸發，不能
 *  只靠它偵測。只在牌局畫面時檢查，且用 reconnectInFlight 避免跟
 *  onHostLeft（實際 close 事件）重複觸發重連。 */
function startClientWatchdog() {
  if (clientWatchdog) return;
  lastHostMsgAt = Date.now();
  clientWatchdog = setInterval(() => {
    if (reconnectInFlight) return;
    const activeScreen = document.querySelector('.screen.active');
    if (!activeScreen || activeScreen.id !== 'game-screen') return;
    saveSession(); // 持續刷新「上次在哪個房間/座位」的時間戳，牌局中重新整理才接得回去
    if (Date.now() - lastHostMsgAt > HEARTBEAT_TIMEOUT_MS) {
      reconnectInFlight = true;
      toast('與房主的連線疑似中斷，正在嘗試重新連線…');
      const roomCode = document.getElementById('room-code-display').textContent;
      rejoinAfterMigration(roomCode);
    }
  }, HEARTBEAT_INTERVAL_MS);
}

/** 房主離線時的處理：遊戲已經開始就直接結束（沒有後端能接手隱藏資訊，
 *  等於作弊或整局重來，範圍外）；還在等待室的話，讓座位號碼最小的
 *  還在線玩家自動接手當新房主，其餘人重新連進同一個房號——每個 client
 *  都用同一份最後收到的名單、同一條規則各自算，理論上會選出同一個人，
 *  不需要額外協商。 */
function onHostLeft() {
  if (reconnectInFlight) return; // watchdog 可能已經先觸發重連，避免重複
  const activeScreen = document.querySelector('.screen.active');
  // 遊戲進行中：無法分辨「房主真的離線」還是「自己網路剛好斷了一下」，
  // 兩者從 client 角度看起來一樣（連線被關閉）——一律當作後者處理，
  // 嘗試用同一個房號重新連回去；如果房主真的離線，重試會全部失敗，
  // 最後才提示遊戲結束（也就順便涵蓋了自己斷線重連的情境）。
  if (activeScreen && activeScreen.id === 'game-screen') {
    reconnectInFlight = true;
    toast('與房主的連線中斷，正在嘗試重新連線…');
    const roomCode = document.getElementById('room-code-display').textContent;
    rejoinAfterMigration(roomCode);
    return;
  }
  if (!activeScreen || activeScreen.id !== 'room-screen') {
    toast('房主已離線，遊戲結束');
    setTimeout(() => location.reload(), 2500);
    return;
  }
  const remaining = lobbyPlayers.filter(p => p && p.kind !== 'host');
  if (!remaining.length) {
    toast('房主已離線，房間已空');
    setTimeout(() => location.reload(), 2500);
    return;
  }
  const electedSeat = Math.min(...remaining.map(p => p.seat));
  const roomCode = document.getElementById('room-code-display').textContent;
  if (mySeat === electedSeat) {
    toast('房主已離線，你被推舉為新房主，重新建立房間中…');
    becomeHostAfterMigration(roomCode);
  } else {
    reconnectInFlight = true;
    toast('房主已離線，正在嘗試重新連線…');
    rejoinAfterMigration(roomCode);
  }
}

function becomeHostAfterMigration(roomCode) {
  const myOldSeat = mySeat;
  // 保留原本名單（扣掉舊房主），其他人的連線都已失效，先暫記占位
  // （peerId:null）等他們自己重連回來再補上真正的連線。
  const preserved = lobbyPlayers.map((p, i) => {
    if (!p || p.kind === 'host') return null;
    return { seat: i, name: p.name, kind: (i === myOldSeat ? 'host' : 'client'), peerId: null };
  });
  net.destroy();
  net = new NetworkManager();
  net.host(myName, () => {
    mySeat = myOldSeat;
    lobbyPlayers = preserved;
    document.getElementById('host-controls').style.display = 'block';
    renderLobby();
    broadcastLobby();
  }, (err) => {
    toast('接手房主失敗，房間結束：' + (err.message || err.type || err));
    setTimeout(() => location.reload(), 2500);
  }, roomCode);
  wireHostHandlers();
}

function rejoinAfterMigration(roomCode) {
  const myOldSeat = mySeat;
  const tryJoin = (attemptsLeft) => {
    net.destroy();
    net = new NetworkManager();
    net.join(roomCode, myName, () => {
      document.getElementById('host-controls').style.display = 'none';
      net.on('hostMessage', ({ msg }) => clientHandleHostMessage(msg));
      net.on('hostLeft', onHostLeft);
      lastHostMsgAt = Date.now();
      reconnectInFlight = false;
      startClientWatchdog();
      saveSession();
      toast('已重新連上房間');
    }, () => {
      if (attemptsLeft > 0) setTimeout(() => tryJoin(attemptsLeft - 1), 1500);
      else {
        reconnectInFlight = false;
        clearSession(); // 房間真的回不去了，別再讓下次重新整理又白試一次
        toast('重新連線失敗，房間已結束');
        setTimeout(() => location.reload(), 2500);
      }
    }, { rejoinSeat: myOldSeat });
  };
  tryJoin(6);
}

function clientHandleHostMessage(msg) {
  lastHostMsgAt = Date.now(); // 任何 host 訊息（含 ping）都算存活證明
  switch (msg.type) {
    case 'ping':
      net.sendToHost({ type: 'pong' });
      break;
    case 'lobby': {
      lobbyPlayers = [null, null, null, null];
      msg.players.forEach(p => { lobbyPlayers[p.seat] = { seat: p.seat, name: p.name, kind: p.isHost ? 'host' : 'client' }; });
      mySeat = msg.yourSeat;
      renderLobby();
      break;
    }
    case 'roomFull':
      toast('房間已滿'); break;
    case 'gameStart':
      mySeat = msg.yourSeat;
      if (msg.tileBack) applyTileBack(msg.tileBack);
      show('game-screen');
      saveSession();
      break;
    case 'view':
      renderView(msg.view);
      break;
    case 'yourTurn':
      showTurnActions(msg);
      break;
    case 'claimOffer':
      showClaimOffer(msg);
      break;
    case 'handOver':
      showHandOver(msg.payload);
      break;
    case 'gamePaused':
      showPauseOverlay(msg.payload);
      break;
    case 'gameResumed':
      hidePauseOverlay();
      break;
    case 'gameEnd':
      clearSession(); // 遊戲結束，不用再自動重連回去
      showFinalResult(msg.payload);
      break;
    case 'rollDiceRequest':
      showRollButton();
      break;
    case 'backToLobby':
      clearSession(); // 回到等待室，不算牌局中，不用再自動重連
      document.getElementById('result-modal').style.display = 'none';
      clearActions();
      show('room-screen');
      renderLobby();
      toast('房主已回到等待室');
      break;
  }
}

/* ---------- 莊家擲骰按鈕 ---------- */
function showRollButton() {
  const bar = document.getElementById('action-bar');
  bar.innerHTML = '';
  bar.style.display = 'flex';
  const hint = document.createElement('span');
  hint.className = 'action-hint';
  hint.textContent = '你是莊家，請擲骰開局 → ';
  bar.appendChild(hint);
  addActionBtn(bar, '🎲 擲骰子', 'win', () => sendAction({ type: 'rollDice' }));
}

/** 送出動作（host 直接呼叫 engine，client 透過網路）
 *  先清掉目前的行動列 UI，再交給 engine；房主端 engine 為同步執行，
 *  若因此動作又輪到自己（例如碰完要出牌），engine 會重新設定行動列，
 *  故清除必須在呼叫 engine「之前」完成，避免把新狀態清掉。 */
function sendAction(action) {
  clearActions();
  if (net.isHost && engine) engine.playerAct(mySeat, action);
  else net.sendToHost({ type: 'action', action });
}
function sendClaim(decision) {
  clearActions();
  if (net.isHost && engine) engine.playerAct(mySeat, decision);
  else net.sendToHost({ type: 'claim', decision });
}

/** 常駐胡牌鈕：跟一般行動列的按鈕不一樣，這是「隨時可按」的獨立動作，
 *  不屬於當下行動列的選項，不能像 sendAction() 那樣先清空行動列——
 *  例如骰子還沒擲、莊家的擲骰按鈕正顯示在行動列時誤觸胡鈕，引擎會直接
 *  no-op（見 declareHuAttempt 開頭的階段判斷），不會有任何後續狀態
 *  改變，行動列就該原封不動留著，不能被清掉。真的成立時（自摸／胡／
 *  詐胡）engine 會觸發 handOver，由 showHandOver() 自己負責清空。 */
function sendHuAttempt() {
  const action = { type: 'declareHu' };
  if (net.isHost && engine) engine.playerAct(mySeat, action);
  else net.sendToHost({ type: 'action', action });
}

/* ============================================================
 * 牌桌渲染
 * ============================================================ */
const SEAT_LABELS = ['bottom', 'right', 'top', 'left']; // 相對自己的方位

function renderView(view) {
  lastView = view;
  document.getElementById('game-screen').dataset.ready = '1';
  const you = view.you;

  // 新局開始（進行中的狀態）時，關閉上一局的結算彈窗（修正 client 端關不掉的問題）
  if (view.phase && view.phase !== 'over') {
    document.getElementById('result-modal').style.display = 'none';
  }

  // 若我原本有待辦動作，但新狀態已不再輪到我行動（例如出牌逾時被自動打牌、
  // 或索取視窗已被他人解決）→ 收掉殘留的行動列與倒數
  if (currentActions && !(view.phase === 'act' && view.turn === you)) clearActions();
  if (currentClaim && view.phase !== 'claim') clearActions();

  // 資訊列
  const winds = ['東', '南', '西', '北'];
  document.getElementById('info-round').textContent = winds[view.roundWind] + '圈';
  document.getElementById('info-wall').textContent = '剩 ' + view.wallLeft + ' 張';
  document.getElementById('info-dealer').textContent = '莊：' + view.seats[view.dealer].name
    + (view.dealerStreak > 0 ? `（連${view.dealerStreak}）` : '');

  // 四個方位：以自己為 bottom，順時針 next=right...
  for (let i = 0; i < 4; i++) {
    const seat = (you + i) % 4;
    const pos = SEAT_LABELS[i];
    renderSeat(view.seats[seat], pos, seat, view);
  }

  // 中央棄牌池
  renderDiscardPool(view);

  // 追蹤最近一次棄牌者（供判斷碰/槓是否跳過摸牌順位；lastDiscard 在吃碰解決後會被清空，
  // 所以只在非空時更新，讓這個值持續到下一次真正的棄牌事件）
  if (view.lastDiscard) lastDiscardFrom = view.lastDiscard.from;

  // ---- 音效觸發 ----
  const totalDiscards = view.seats.reduce((a, s) => a + (s.discards ? s.discards.length : 0), 0);
  const msg = view.stateMessage || '';
  if (msg !== sndPrevMsg) {
    // 報牌：碰／吃／槓（優先於單純打牌聲）
    if (/碰$/.test(msg)) Sound.pong();
    else if (/吃$/.test(msg)) Sound.chi();
    else if (/槓$/.test(msg)) Sound.kong();
    else if (totalDiscards > sndPrevDiscards) Sound.discard();

    // ---- 電腦角色情境對話 ----
    const actor = view.seats.findIndex(s => msg.startsWith(s.name + ' '));
    if (/碰$/.test(msg)) { maybeSpeak(actor, 'pong', .6); trackSkippedDraw(actor); }
    else if (/吃$/.test(msg)) { maybeSpeak(actor, 'chi', .6); trackSkippedDraw(actor); }
    else if (/槓$/.test(msg)) { maybeSpeak(actor, 'kong', .75); trackSkippedDraw(actor); }
    else if (/補花 \d+ 張$/.test(msg)) maybeSpeak(actor, 'flower', .55);
    else if (/摸牌$/.test(msg)) { if (actor >= 0) skipStreak[actor] = 0; } // 正常摸到牌，歸零連續被跳過次數
    else if (msg === '開始新局') {
      // 開局：骰運好的莊家吹噓；其他 AI 隨機寒暄
      if (view.diceBonusName) maybeSpeak(view.dealer, 'dice', .95);
      view.seats.forEach((s, i) => {
        if (s.isAI && i !== view.dealer) setTimeout(() => maybeSpeak(i, 'greet', .3), 300 + i * 500);
      });
    }
    sndPrevMsg = msg;
  } else if (totalDiscards > sndPrevDiscards) {
    Sound.discard();
  }
  sndPrevDiscards = totalDiscards;

  // ---- 觀察局勢的特殊情境對話（猜牌型、猜運氣等） ----
  checkSpecialDialogue(view);
}

function renderSeat(s, pos, seat, view) {
  const area = document.getElementById('seat-' + pos);
  const isTurn = view.turn === seat;
  const isDealer = view.dealer === seat;
  area.classList.toggle('active-turn', isTurn);

  const nameEl = area.querySelector('.seat-name');
  const windCh = (view.eastSeat != null)
    ? '【' + ['東', '南', '西', '北'][(seat - view.eastSeat + 4) % 4] + '】' : '';
  // 過水狀態刻意不提示玩家自己（見設計說明），名字標籤不再顯示過水徽章
  nameEl.textContent = windCh + (isDealer ? '莊 ' : '') + s.name;
  const scoreEl = area.querySelector('.seat-score');
  scoreEl.textContent = (s.score >= 0 ? '+' : '') + s.score;

  // 手牌
  const handEl = area.querySelector('.seat-hand');
  handEl.innerHTML = '';
  if (pos === 'bottom' && s.hand) {
    // 自己：拖曳（或輕點）出牌
    let tiles = s.hand.slice();
    let drawn = null;
    // 剛摸上來的牌：抽離出來放最右邊並發光
    if (view.drawnTile && view.drawnBy === seat && view.turn === seat) {
      const i = tiles.indexOf(view.drawnTile);
      if (i >= 0) drawn = tiles.splice(i, 1)[0];
    }
    const forbidden = s.kuikaeForbidden || [];
    for (const t of tiles) {
      const el = makeTile(t, true);
      if (forbidden.includes(t)) el.classList.add('tile-forbidden');
      attachDragDiscard(el, t);
      handEl.appendChild(el);
    }
    if (drawn) {
      const el = makeTile(drawn, true);
      el.classList.add('just-drawn');
      attachDragDiscard(el, drawn);
      handEl.appendChild(el);
    }
  } else {
    // 別人：牌背（帶序號，讓整排以階梯錯位排成平行四邊形）
    const n = s.handCount != null ? s.handCount : (s.hand ? s.hand.length : 0);
    for (let i = 0; i < n; i++) handEl.appendChild(makeBackTile(pos, i));
  }

  // 亮出的面子（別人的暗槓 hidden=true → 顯示四張牌背）
  const meldEl = area.querySelector('.seat-melds');
  meldEl.innerHTML = '';
  for (const m of s.melds) {
    const g = document.createElement('div');
    g.className = 'meld';
    if (m.hidden) {
      for (let k = 0; k < 4; k++) {
        const b = document.createElement('div');
        b.className = 'tile tile-back meld-back';
        g.appendChild(b);
      }
    } else {
      for (const t of m.tiles) g.appendChild(makeTile(t, false));
      if (m.type === 'kong' && m.concealed) g.classList.add('concealed-kong');
    }
    meldEl.appendChild(g);
  }

  // 花牌
  const flowerEl = area.querySelector('.seat-flowers');
  if (flowerEl) {
    flowerEl.innerHTML = '';
    for (const f of s.flowers) {
      const fl = makeTile(f, false);
      fl.classList.add('flower-tile');
      flowerEl.appendChild(fl);
    }
  }
}

function renderDiscardPool(view) {
  const pool = document.getElementById('discard-pool');
  // 清除棄牌區與中央牌，但保留常駐的骰盅玻璃罩（動畫不被重繪打斷）
  [...pool.children].forEach(c => { if (c.id !== 'dice-glass') c.remove(); });

  // 顯示每家棄牌（依方位分區）；最新打出的那張改放中央放大顯示
  for (let i = 0; i < 4; i++) {
    const seat = (view.you + i) % 4;
    const pos = SEAT_LABELS[i];
    const zone = document.createElement('div');
    zone.className = 'discard-zone discard-' + pos;
    const discards = view.seats[seat].discards;
    const skipLast = view.lastDiscard && view.lastDiscard.from === seat;
    const count = skipLast ? discards.length - 1 : discards.length;
    for (let k = 0; k < count; k++) {
      const tile = makeTile(discards[k], false);
      tile.classList.add('discarded');
      zone.appendChild(tile);
    }
    pool.appendChild(zone);
  }

  // 中央：剛打出的牌（放大，位於骰盅上方）
  const center = document.createElement('div');
  center.className = 'pool-center';
  if (view.lastDiscard) {
    const big = makeTile(view.lastDiscard.tile, false);
    big.classList.add('center-discard');
    // 防洩漏：同一張棄牌重繪（例如有人考慮吃碰後放棄）不重播動畫，
    // 避免多閃一下讓其他人察覺有人能吃碰
    const totalD = view.seats.reduce((a, s) => a + (s.discards ? s.discards.length : 0), 0);
    const key = view.lastDiscard.from + ':' + view.lastDiscard.tile + ':' + totalD;
    if (key === prevCenterKey) big.style.animation = 'none';
    prevCenterKey = key;
    center.appendChild(big);
  }
  pool.appendChild(center);

  updateDiceGlass(view, pool);
}

/* ---------- 中央骰盅：圓形玻璃罩＋擲骰翻滾動畫 ---------- */
let diceRollTimer = null;
function updateDiceGlass(view, pool) {
  const DIE_CH = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  let glass = document.getElementById('dice-glass');
  if (!glass) {
    glass = document.createElement('div');
    glass.id = 'dice-glass';
    glass.innerHTML = '<div class="glass-shine"></div><div class="glass-dice"></div><div class="glass-bonus"></div>';
    pool.appendChild(glass);
  }
  const diceEl = glass.querySelector('.glass-dice');
  const bonusEl = glass.querySelector('.glass-bonus');

  // 尚未擲骰（等莊家）：罩內三顆暗骰待命
  if (!view.dice) {
    if (glass.dataset.state !== 'idle') {
      glass.dataset.state = 'idle';
      glass.dataset.rollId = '';
      clearInterval(diceRollTimer);
      glass.classList.remove('rolling', 'settled');
      diceEl.innerHTML = '<span class="die die-dim">⚀</span><span class="die die-dim">⚂</span><span class="die die-dim">⚄</span>';
      bonusEl.textContent = '';
    }
    return;
  }

  // 同一次擲骰重複渲染（發牌/摸打的畫面更新）→ 不重播動畫
  const rid = String(view.rollId || view.dice.join(','));
  if (glass.dataset.rollId === rid) return;
  glass.dataset.rollId = rid;
  glass.dataset.state = 'rolled';

  // 翻滾動畫：亂數換面約 0.95 秒後定格揭曉
  clearInterval(diceRollTimer);
  glass.classList.remove('settled');
  glass.classList.add('rolling');
  bonusEl.textContent = '';
  diceEl.innerHTML = view.dice.map(() => '<span class="die"></span>').join('');
  const spans = [...diceEl.children];
  const t0 = performance.now();
  diceRollTimer = setInterval(() => {
    spans.forEach(sp => {
      const v = 1 + Math.floor(Math.random() * 6);
      sp.textContent = DIE_CH[v - 1];
      sp.classList.toggle('die-red', v === 1 || v === 4);
    });
    if (performance.now() - t0 > 950) {
      clearInterval(diceRollTimer);
      view.dice.forEach((v, i) => {
        spans[i].textContent = DIE_CH[v - 1];
        spans[i].classList.toggle('die-red', v === 1 || v === 4);
      });
      glass.classList.remove('rolling');
      glass.classList.add('settled');
      Sound.discard();
      if (view.diceBonusName) {
        const parts = [
          view.diceBonusTai > 0 ? `+${view.diceBonusTai}台` : '',
          view.diceBonusTaiMult > 1 ? `台數×${view.diceBonusTaiMult}` : '',
          view.diceBonusMult > 1 ? `籌碼×${view.diceBonusMult}` : '',
        ].filter(Boolean).join('、');
        bonusEl.textContent = view.diceBonusName + (parts ? `（${parts}）` : '');
        if (view.diceBonusName.includes('豹子')) {
          // 豹子：骰盅持續發光＋全螢幕大字閃現，更為醒目（純視覺，避免與胡牌音效混淆）
          glass.classList.add('leopard-glow');
          setTimeout(() => glass.classList.remove('leopard-glow'), 2200);
          showLeopardBanner(view.diceBonusName);
        }
      }
      setTimeout(() => glass.classList.remove('settled'), 500);
    }
  }, 85);
}

/** 豹子（三顆同數）大字閃現橫幅 */
function showLeopardBanner(label) {
  let el = document.getElementById('leopard-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'leopard-banner';
    document.getElementById('game-screen').appendChild(el);
  }
  el.textContent = '豹子！';
  el.title = label;
  el.classList.remove('play'); void el.offsetWidth; el.classList.add('play');
  setTimeout(() => el.classList.remove('play'), 1500);
}

/* ---------- 牌的 DOM ---------- */
function makeTile(t, clickable, onClick) {
  const el = document.createElement('div');
  el.className = 'tile';
  if (isFlower(t)) el.classList.add('tile-flower');
  else if (isHonor(t)) el.classList.add('tile-honor');
  else el.classList.add('tile-' + t[0]);
  el.innerHTML = tileFaceHTML(t);
  el.dataset.tile = t;
  el.title = tileName(t);
  if (clickable) {
    el.classList.add('clickable');
    if (onClick) el.onclick = onClick;
  }
  return el;
}
function makeBackTile(pos, index = 0) {
  const el = document.createElement('div');
  el.className = 'tile tile-back tile-back-' + pos;
  el.style.setProperty('--i', index);
  return el;
}

/* ============================================================
 * 行動 UI
 * ============================================================ */
let hasDiscardedOnce = false; // 出牌提示只在本次連線的第一次打牌時出現
function onClickHandTile(tile) {
  if (!currentActions || !currentActions.discard) return;
  // 剛吃／碰完不能打出的牌（吃碰限制）
  if (lastView) {
    const forbidden = (lastView.seats[mySeat] && lastView.seats[mySeat].kuikaeForbidden) || [];
    if (forbidden.includes(tile)) { toast('剛吃／碰，這張不能打'); return; }
  }
  // 出牌
  hasDiscardedOnce = true;
  sendAction({ type: 'discard', tile });
}

/* ---------- 拖曳打牌 ---------- */
const DRAG_UP_THRESHOLD = 46;  // 向上拖超過這距離即可打出
const TAP_MOVE_TOLERANCE = 5;  // 位移小於此值視為輕點

/** 座標是否落在中央棄牌區（打出區） */
function isOverPlayZone(x, y) {
  const pool = document.getElementById('discard-pool');
  if (!pool) return false;
  const r = pool.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** 讓一張手牌可拖曳打出 */
function attachDragDiscard(el, tile) {
  el.addEventListener('pointerdown', (e) => {
    if (!currentActions || !currentActions.discard) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    let moved = false, willPlay = false;
    const screen = document.getElementById('game-screen');

    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    el.classList.add('dragging');
    screen.classList.add('drag-active');

    const onMove = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (Math.abs(dx) > TAP_MOVE_TOLERANCE || Math.abs(dy) > TAP_MOVE_TOLERANCE) moved = true;
      el.style.transform = `translate(${dx}px, ${dy}px) scale(1.12)`;
      willPlay = isOverPlayZone(ev.clientX, ev.clientY) || dy < -DRAG_UP_THRESHOLD;
      el.classList.toggle('will-play', willPlay);
      const pool = document.getElementById('discard-pool');
      if (pool) pool.classList.toggle('drop-target', willPlay);
    };

    const finish = (ev) => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', finish);
      el.removeEventListener('pointercancel', finish);
      screen.classList.remove('drag-active');
      const pool = document.getElementById('discard-pool');
      if (pool) pool.classList.remove('drop-target');

      const dy = ev.clientY - startY;
      const play = !moved                                   // 輕點即打
        || isOverPlayZone(ev.clientX, ev.clientY)           // 拖到棄牌區
        || dy < -DRAG_UP_THRESHOLD;                         // 往上拖夠遠
      const forbidden = lastView && lastView.seats[mySeat]
        ? (lastView.seats[mySeat].kuikaeForbidden || []) : [];
      const bounceBack = () => {
        el.style.transition = 'transform .15s';
        el.style.transform = '';
        el.classList.remove('dragging', 'will-play');
        setTimeout(() => { el.style.transition = ''; }, 160);
      };

      if (play && forbidden.includes(tile)) {
        toast('剛吃／碰，這張不能打');
        bounceBack();
      } else if (play) {
        onClickHandTile(tile); // 之後 renderView 會重建手牌，這張自然消失
      } else {
        bounceBack(); // 沒拖到位 → 彈回
      }
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
  });
}

function showTurnActions(payload) {
  currentActions = payload.actions;
  Sound.yourTurn();
  // 視覺倒數；真正的逾時自動打牌由 host 端 engine 權威處理（0 = 不計時）
  if (payload.timeLimit) startUiTimer(payload.timeLimit);
  else stopUiTimer();
  const bar = document.getElementById('action-bar');
  bar.innerHTML = '';

  const a = payload.actions;
  // 自摸不提示：玩家須自行判斷並按右下角常駐「胡」鈕
  if (a.concealedKongs && a.concealedKongs.length) {
    for (const t of a.concealedKongs) {
      addActionBtn(bar, '暗槓 ' + tileName(t), 'kong', () => sendAction({ type: 'concealedKong', tile: t }));
    }
  }
  if (a.addKongs && a.addKongs.length) {
    for (const t of a.addKongs) {
      addActionBtn(bar, '加槓 ' + tileName(t), 'kong', () => sendAction({ type: 'addKong', tile: t }));
    }
  }
  // 出牌操作提示：只在本次連線的第一次打牌前顯示一次
  if (!hasDiscardedOnce) {
    const hint = document.createElement('span');
    hint.className = 'action-hint';
    hint.textContent = '👆 拖曳牌到中央打出（或輕點）';
    bar.appendChild(hint);
  }
  // 沒有任何按鈕/提示要顯示時，整條列直接收起來，不留空格子佔位
  bar.style.display = bar.children.length ? 'flex' : 'none';
}

function showClaimOffer(payload) {
  const opt = payload.options;
  // 胡牌永不提示；若（防禦性）沒有任何可見選項就什麼都不顯示
  if (!opt.pong && !opt.kong && !opt.chi) return;
  currentClaim = payload;
  startUiTimer(15); // 吃碰槓 反應倒數（與 host 端 CLAIM_TIMEOUT 一致）
  const bar = document.getElementById('action-bar');
  bar.innerHTML = '';
  bar.style.display = 'flex';

  const tile = payload.tile;
  const label = document.createElement('span');
  label.className = 'action-hint';
  label.textContent = '「' + tileName(tile) + '」→ ';
  bar.appendChild(label);

  if (opt.kong) addActionBtn(bar, '槓', 'kong', () => sendClaim({ action: 'kong' }));
  if (opt.pong) addActionBtn(bar, '碰', 'pong', () => sendClaim({ action: 'pong' }));
  if (opt.chi && opt.chiOptions) {
    for (const combo of opt.chiOptions) {
      addActionBtn(bar, '吃 ' + combo.map(tileName).join(''), 'chi', () => sendClaim({ action: 'chi', chi: combo }));
    }
  }
  addActionBtn(bar, '過', 'pass', () => sendClaim({ action: 'pass' }));
}

function addActionBtn(bar, text, cls, onClick) {
  const b = document.createElement('button');
  b.className = 'action-btn action-' + cls;
  b.textContent = text;
  b.onclick = onClick;
  bar.appendChild(b);
}

function clearActions() {
  currentActions = null;
  currentClaim = null;
  stopUiTimer();
  const bar = document.getElementById('action-bar');
  bar.innerHTML = '';
  bar.style.display = 'none';
}

/* ---------- 每手倒數計時（視覺）----------
 * 用「絕對到期時間」而非每秒遞減的計數器：純遞減計數器在分頁切到背景時
 * 會被瀏覽器節流（setInterval 變慢甚至暫停），回到前景時畫面就會卡在
 * 舊數字、看起來像「計時器沒有跑」。改成每次都用 Date.now() 跟到期時間
 * 反推剩餘秒數，不管中間 interval 被節流幾次，畫面永遠能算出正確剩餘
 * 時間；額外監聽 visibilitychange，切回分頁的當下立刻重繪一次。 */
let uiTimerInterval = null;
let uiTimerDeadline = null;
function paintUiTimer() {
  const el = document.getElementById('info-timer');
  if (!el || uiTimerDeadline == null) return;
  const remain = Math.max(0, Math.ceil((uiTimerDeadline - Date.now()) / 1000));
  el.textContent = '⏱ ' + remain;
  el.classList.toggle('urgent', remain <= 5);
  if (remain <= 0) stopUiTimer();
}
function startUiTimer(seconds) {
  stopUiTimer();
  uiTimerDeadline = Date.now() + Math.round(seconds) * 1000;
  paintUiTimer();
  uiTimerInterval = setInterval(paintUiTimer, 1000);
}
/** 沒有倒數時，計時器格子仍留在上方欄（顯示佔位符號），不整個消失、
 *  避免上方欄版面因為計時器出現/消失而跳動。 */
function stopUiTimer() {
  if (uiTimerInterval) { clearInterval(uiTimerInterval); uiTimerInterval = null; }
  uiTimerDeadline = null;
  const el = document.getElementById('info-timer');
  if (el) { el.textContent = '⏱ -'; el.classList.remove('urgent'); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) paintUiTimer(); });

/* ============================================================
 * 結算畫面
 * ============================================================ */
let lastHandOver = null;

/** 一排小牌的 HTML（亮牌用） */
function tilesRowHTML(tiles, highlightTile) {
  return (tiles || []).map(t =>
    `<div class="tile reveal-tile${t === highlightTile ? ' reveal-win' : ''}" title="${tileName(t)}">${tileFaceHTML(t)}</div>`
  ).join('');
}

/* ---------- 本機遊玩統計（存在這台裝置的 localStorage，不跨裝置/玩家匯總） ----------
 * 記錄「這台裝置看過的每一局」裡：局數、牌桌上任何人達成的大牌型（台數 >= 4 才算
 * 大牌，避免自摸/正花/莊家這種常見小台洗版）、一炮雙響/三響次數。 */
const STATS_KEY = 'mj_stats_v1';
const BIG_HAND_TAI_THRESHOLD = 4;
function loadStats() {
  try {
    const s = JSON.parse(localStorage.getItem(STATS_KEY));
    if (s && typeof s === 'object') return { hands: s.hands || 0, bigHands: s.bigHands || {}, multiShots: s.multiShots || {} };
  } catch (e) { /* 忽略壞資料，視同沒有統計 */ }
  return { hands: 0, bigHands: {}, multiShots: {} };
}
function saveStats(s) {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch (e) { /* 私密瀏覽模式等情況寫入會失敗，忽略即可 */ }
}
function recordStats(payload) {
  const s = loadStats();
  s.hands += 1;
  if (payload.result === 'win') {
    for (const w of (payload.winners || [])) {
      for (const it of (w.score.items || [])) {
        if (it.tai >= BIG_HAND_TAI_THRESHOLD) s.bigHands[it.name] = (s.bigHands[it.name] || 0) + 1;
      }
    }
    if (payload.multiShot) s.multiShots[payload.multiShot] = (s.multiShots[payload.multiShot] || 0) + 1;
  }
  saveStats(s);
}
function renderStats() {
  const s = loadStats();
  const body = document.getElementById('stats-body');
  const bigHandRows = Object.entries(s.bigHands).sort((a, b) => b[1] - a[1]);
  const multiShotRows = Object.entries(s.multiShots).sort((a, b) => b[1] - a[1]);
  let html = `<div class="stats-row"><span>開局次數</span><b>${s.hands}</b></div>`;
  if (bigHandRows.length || multiShotRows.length) {
    for (const [name, count] of bigHandRows) html += `<div class="stats-row"><span>${escapeHtml(name)}</span><b>${count}</b></div>`;
    for (const [name, count] of multiShotRows) html += `<div class="stats-row"><span>${escapeHtml(name)}</span><b>${count}</b></div>`;
  } else {
    html += `<p class="stats-empty">還沒有大牌紀錄，多打幾局吧！</p>`;
  }
  body.innerHTML = html;
}

function showHandOver(payload) {
  lastHandOver = payload;
  recordStats(payload);
  clearActions();
  // ---- 電腦角色勝負對話 ----
  if (payload.result === 'win') {
    (payload.winners || []).forEach(w => maybeSpeak(w.seat, w.selfDraw ? 'tsumo' : 'win', .95));
    if (payload.from != null) maybeSpeak(payload.from, 'lose', .9);
  } else if (payload.result === 'draw' && lastView) {
    const ais = lastView.seats.map((s, i) => s.isAI ? i : -1).filter(i => i >= 0);
    if (ais.length) maybeSpeak(ais[Math.floor(Math.random() * ais.length)], 'draw', .8);
  } else if (payload.result === 'falseHu' && lastView) {
    const ais = lastView.seats.map((s, i) => (s.isAI && i !== payload.offender) ? i : -1).filter(i => i >= 0);
    if (ais.length) maybeSpeak(ais[Math.floor(Math.random() * ais.length)], 'mock', .95);
    maybeCommentOn(payload.offender, 'distrustAfterFalseHu', .5);
  }
  // 胡牌超過 2 台 → 先全螢幕浮現牌型，再進結算
  if (payload.result === 'win') {
    const winners = payload.winners || [];
    const best = winners.reduce((a, w) => (!a || w.score.total > a.score.total) ? w : a, null);
    Sound.hu(winners.length === 1 && winners[0].selfDraw);
    if (best && best.score.total > 2) {
      showWinSplash(payload, best, () => renderHandOverModal(payload));
      return;
    }
  }
  renderHandOverModal(payload);
}

/* ---------- 全螢幕牌型宣告（>2台） ---------- */
let splashTimer = null;
function showWinSplash(payload, winner, done) {
  const el = document.getElementById('win-splash');
  const seatName = (i) => lastView ? lastView.seats[i].name : '玩家' + (i + 1);
  // 取台數最高的前 4 個牌型
  const types = winner.score.items.slice()
    .sort((a, b) => b.tai - a.tai)
    .slice(0, 4);
  el.querySelector('.splash-who').textContent =
    (payload.multiShot ? payload.multiShot + '　' : '') +
    seatName(winner.seat) + (winner.selfDraw ? '　自摸' : '　胡牌');
  el.querySelector('.splash-types').innerHTML = types.map((t, i) =>
    `<div class="splash-type" style="animation-delay:${0.25 + i * 0.32}s">${escapeHtml(t.name)}</div>`).join('');
  const mult = winner.score.multiplier || 1;
  const taiMult = winner.score.taiMultiplier || 1;
  el.querySelector('.splash-tai').textContent =
    `${winner.score.total} 台` +
    (taiMult > 1 ? `（豹子台×${taiMult}）` : '') +
    (mult > 1 ? `　×${mult}` : '');

  el.style.display = 'flex';
  el.classList.remove('splash-play');
  void el.offsetWidth; // 重啟動畫
  el.classList.add('splash-play');

  const finish = () => {
    clearTimeout(splashTimer);
    el.onclick = null;
    el.classList.remove('splash-play');
    el.style.display = 'none';
    done();
  };
  el.onclick = finish;                       // 點擊跳過
  const holdMs = 1600 + types.length * 320;  // 依牌型數量停留
  splashTimer = setTimeout(finish, holdMs);
}

function renderHandOverModal(payload) {
  const modal = document.getElementById('result-modal');
  const body = document.getElementById('result-body');
  const seatName = (i) => lastView ? lastView.seats[i].name : '玩家' + (i + 1);
  const di = payload.baseDi || 30, taiV = payload.baseTai || 10;
  const roundBanner = payload.roundEnding ? '<div class="round-complete-banner">🀄 東南西北一將已完成！</div>' : '';

  if (payload.result === 'draw') {
    Sound.draw_game();
    body.innerHTML = roundBanner + `<h2>流局</h2><p>牌牆摸完，無人胡牌。</p>` + scoreTable(payload.scores);
  } else if (payload.result === 'falseHu') {
    Sound.draw_game();
    const payRows = payload.payments.map(pm =>
      `<li>賠 ${escapeHtml(seatName(pm.to))} <b>${pm.value}</b> 籌碼</li>`).join('');
    // 亮出詐胡者的牌，讓大家能親眼確認牌真的沒成
    const offenderMeldTiles = (payload.melds || []).flatMap(m => m.tiles);
    const offenderReveal = payload.hand
      ? `<div class="reveal-row">${tilesRowHTML(payload.hand)}${offenderMeldTiles.length ? `<span class="reveal-sep">｜</span>${tilesRowHTML(offenderMeldTiles)}` : ''}</div>`
      : '';
    // 過水中仍宣告胡：牌其實已經成了，只是被過水擋下——跟真的沒成牌的
    // 詐胡文案不同，並亮出當初放棄的那張牌／來源讓大家核對這次判定。
    const gs = payload.guoShui;
    const desc = gs
      ? `過水中仍宣告胡牌，依規定算詐胡：${escapeHtml(seatName(payload.offender))} 這輪已經放棄過${gs.from === payload.offender ? '自己摸到的' : ('　' + escapeHtml(seatName(gs.from)) + ' 打出的')}這張牌，打出一張牌前不得再胡。`
      : '牌未成卻宣告胡牌。';
    const guoShuiReveal = (gs && gs.tile) ? `<div class="reveal-row">${tilesRowHTML([gs.tile], gs.tile)}</div>` : '';
    body.innerHTML = roundBanner + `
      <h2>💥 ${escapeHtml(seatName(payload.offender))} 詐胡！</h2>
      <p class="win-way">${desc}依最接近的聽牌（${payload.estTai} 台）賠付各家，並讓出莊位。</p>
      ${guoShuiReveal}
      ${offenderReveal}
      <div class="tai-list"><ul>${payRows}</ul></div>
      ${scoreTable(payload.scores)}
    `;
  } else {
    const winners = payload.winners || [];
    const blocks = winners.map(w => {
      const s = w.score;
      const items = s.items.map(it => `<li>${it.name} <b>${it.tai}</b> 台</li>`).join('');
      const way = w.selfDraw ? '自摸' : ('胡 ' + escapeHtml(seatName(payload.from)) + ' 放的牌');
      const mult = s.multiplier || 1;
      const taiMult = s.taiMultiplier || 1;
      const chips = (di + s.total * taiV) * mult;
      // 非莊家自摸：莊家那份加付莊家/連莊台
      const payNote = w.selfDraw
        ? (s.dealerPay ? `（散家各付 ${s.basePay}、莊家付 <b>${s.dealerPay}</b>）` : '（三家各付）')
        : '';
      const meldTiles = (w.melds || []).flatMap(m => m.tiles);
      return `
        <div class="winner-block">
          <h3>🎉 ${escapeHtml(seatName(w.seat))}　<span class="win-way">${way}</span></h3>
          <div class="reveal-row">${tilesRowHTML(w.hand)}${meldTiles.length ? `<span class="reveal-sep">｜</span>${tilesRowHTML(meldTiles)}` : ''}<span class="reveal-sep">＋</span>${tilesRowHTML([w.winTile], w.winTile)}</div>
          <div class="tai-total">共 ${s.total} 台${taiMult > 1 ? `　<span class="mult">豹子台×${taiMult}</span>` : ''}${mult > 1 ? `　<span class="mult">豹子籌碼×${mult}</span>` : ''}
            <span class="chip-line">底 ${di} + ${s.total}×${taiV}${mult > 1 ? `×${mult}` : ''} = <b>${chips}</b>${payNote}</span></div>
          <ul class="tai-items">${items || '<li>無台（屁胡）</li>'}</ul>
        </div>`;
    }).join('');
    body.innerHTML = roundBanner + `
      ${payload.multiShot ? `<h2 class="multi-shot">🔥 ${payload.multiShot}！${escapeHtml(seatName(payload.from))} 放槍賠多家</h2>` : ''}
      ${blocks}
      ${scoreTable(payload.scores)}
    `;
  }

  // 只有 host 顯示「下一局」「結束遊戲」
  document.getElementById('btn-next').style.display = net.isHost ? 'inline-block' : 'none';
  document.getElementById('btn-end').style.display = net.isHost ? 'inline-block' : 'none';
  document.getElementById('btn-lobby').style.display = 'none';
  const waitMsg = document.getElementById('next-wait-msg');
  if (waitMsg) waitMsg.style.display = net.isHost ? 'none' : 'block';
  modal.style.display = 'flex';
}

/* ---------- 結束遊戲（host 觸發，全員顯示總結算） ---------- */
function endGame() {
  if (!net.isHost || !engine) return;
  const payload = {
    names: engine.seats.map(s => s.name),
    scores: engine.seats.map(s => s.score),
  };
  net.broadcast({ type: 'gameEnd', payload });
  showFinalResult(payload);
}

/* ---------- 回等待室（保留房間與連線，可再開新一場） ---------- */
function backToLobby() {
  document.getElementById('result-modal').style.display = 'none';
  clearActions();
  if (net.isHost) {
    if (engine) engine.destroy(); // 停掉舊局計時器，避免干擾新局
    engine = null; // 下一場重新建局（分數歸零）
    net.broadcast({ type: 'backToLobby' });
  }
  show('room-screen');
  renderLobby();
  toast(net.isHost ? '已回到等待室，可調整設定再開新一場' : '已回到等待室');
}

function showFinalResult(payload) {
  clearActions();
  const modal = document.getElementById('result-modal');
  const body = document.getElementById('result-body');
  const rank = payload.names.map((n, i) => ({ name: n, score: payload.scores[i] }))
    .sort((a, b) => b.score - a.score);
  const medals = ['🥇', '🥈', '🥉', ''];
  const rows = rank.map((r, i) =>
    `<tr><td>${medals[i]} ${escapeHtml(r.name)}</td><td class="${r.score >= 0 ? 'pos' : 'neg'}">${r.score >= 0 ? '+' : ''}${r.score}</td></tr>`).join('');
  body.innerHTML = `
    <h2>🏁 遊戲結束</h2>
    <table class="score-table"><thead><tr><th>名次</th><th>總籌碼</th></tr></thead><tbody>${rows}</tbody></table>
  `;
  document.getElementById('btn-next').style.display = 'none';
  document.getElementById('btn-end').style.display = 'none';
  const waitMsg = document.getElementById('next-wait-msg');
  if (waitMsg) waitMsg.style.display = 'none';
  document.getElementById('btn-lobby').style.display = 'inline-block';
  modal.style.display = 'flex';
}

function scoreTable(scores) {
  if (!lastView) return '';
  let rows = '';
  for (let i = 0; i < 4; i++) {
    const nm = lastView.seats[i].name;
    const sc = scores[i];
    rows += `<tr><td>${escapeHtml(nm)}</td><td class="${sc >= 0 ? 'pos' : 'neg'}">${sc >= 0 ? '+' : ''}${sc}</td></tr>`;
  }
  return `<table class="score-table"><thead><tr><th>玩家</th><th>總分</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* ============================================================
 * 小工具
 * ============================================================ */
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
