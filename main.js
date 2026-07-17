/* ============================================================
 * main.js — UI 與流程整合
 * 大廳 / 等待室 / 牌桌渲染 / host 編排 / client 顯示
 * 依賴 mahjong.js, ai.js, game.js, network.js
 * ============================================================ */

const net = new NetworkManager();
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
  document.getElementById('btn-create').onclick = onCreateRoom;
  document.getElementById('btn-join').onclick = onJoinRoom;
  document.getElementById('btn-start').onclick = onHostStart;
  document.getElementById('btn-next').onclick = onNextHand;
  document.getElementById('btn-end').onclick = endGame;
  document.getElementById('btn-lobby').onclick = backToLobby;
  // 常駐胡牌鈕：按錯（牌未成）= 詐胡賠付！
  document.getElementById('btn-hu').onclick = () => sendAction({ type: 'declareHu' });
  document.getElementById('btn-copy').onclick = () => {
    const code = document.getElementById('room-code-display').textContent;
    navigator.clipboard && navigator.clipboard.writeText(code);
    toast('已複製房號 ' + code);
  };
  document.getElementById('btn-leave').onclick = () => location.reload();
  document.getElementById('btn-leave2').onclick = () => location.reload();

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
});

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
  const seatEl = document.getElementById('seat-' + SEAT_LABELS[rel]);
  if (!seatEl) return;
  const old = seatEl.querySelector('.speech-bubble');
  if (old) old.remove();
  const b = document.createElement('div');
  b.className = 'speech-bubble bubble-' + SEAT_LABELS[rel];
  b.textContent = text;
  seatEl.appendChild(b);
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

/* ============================================================
 * 開房（HOST）
 * ============================================================ */
function onCreateRoom() {
  myName = (document.getElementById('name-input').value || '玩家').trim().slice(0, 8);
  net.host(myName, (roomCode) => {
    mySeat = 0;
    // 固定 4 格：null = 空位（開局補電腦）。玩家可用 ↑↓ 換到任何位置（含對家）
    lobbyPlayers = [{ seat: 0, name: myName, kind: 'host', peerId: null }, null, null, null];
    document.getElementById('room-code-display').textContent = roomCode;
    document.getElementById('host-controls').style.display = 'block';
    show('room-screen');
    renderLobby();
  }, (err) => {
    toast('開房失敗：' + (err.message || err.type || err));
  });

  // 有 client 連上
  net.on('clientConnected', ({ peerId }) => {
    // 等待對方送 join(name)
  });
  net.on('clientLeft', ({ peerId }) => {
    lobbyPlayers = lobbyPlayers.map(p => (p && p.peerId === peerId) ? null : p);
    renderLobby();
    broadcastLobby();
  });
  net.on('clientMessage', ({ peerId, msg }) => hostHandleClientMessage(peerId, msg));
}

function hostHandleClientMessage(peerId, msg) {
  if (msg.type === 'join') {
    const seat = lobbyPlayers.findIndex(p => !p);
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
  { name: '旺來伯', emoji: '🍍', lines: { // 台語老江湖
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
  { name: '阿花姨', emoji: '🌺', lines: { // 菜市場戰神，愛碎念
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
  }},
  { name: '雀聖', emoji: '🐦', lines: { // 高深莫測的宗師
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
  }},
  { name: '紅中俠', emoji: '🀄', lines: { // 中二武俠
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
  { name: '發財哥', emoji: '💰', lines: { // 滿腦子錢
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
  { name: '骰神', emoji: '🎲', lines: { // 迷信賭徒
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
  }},
  { name: '月光姐', emoji: '🌙', lines: { // 優雅淡定
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
  }},
  { name: '海底撈', emoji: '🎣', lines: { // 釣魚梗大王
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
  }},
  { name: '龜速伯', emoji: '🐢', lines: { // 慢性子
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
  }},
  { name: '小辣椒', emoji: '🌶️', lines: { // 嗆辣直球
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
  }},
];

/* 牌背配色（面、深、邊框） */
const BACK_COLORS = {
  green: ['#2b8f5a', '#1c6b41', '#14512f'],
  blue: ['#2b6fb0', '#1c4f86', '#143a63'],
  red: ['#b04a3f', '#8a2f27', '#63201a'],
  purple: ['#7a4fb0', '#5a3786', '#3f2663'],
  night: ['#4a4a55', '#33333c', '#222228'],
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
      const prof = aiPool.pop() || { name: '電腦' + (i + 1), emoji: '🤖' };
      seats.push({ id: 'ai' + i, name: prof.emoji + prof.name, isAI: true });
      seatOwners.push({ seat: i, kind: 'ai', peerId: null });
    }
  }

  engine = new GameEngine(seats, hostEmit, {
    roundWind: 0, dealer: 0, dealerStreak: 0,
    baseDi: optDi, baseTai: optTai, turnLimitMs: optTimerSec * 1000,
    aiLevel: optAi,
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
  }
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
  }, (err) => {
    toast('加入失敗：' + (err.message || err.type || err));
  });

  net.on('hostMessage', ({ msg }) => clientHandleHostMessage(msg));
  net.on('hostLeft', () => { toast('房主已離線，遊戲結束'); setTimeout(() => location.reload(), 2500); });
}

function clientHandleHostMessage(msg) {
  switch (msg.type) {
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
    case 'gameEnd':
      showFinalResult(msg.payload);
      break;
    case 'rollDiceRequest':
      showRollButton();
      break;
    case 'backToLobby':
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
  if (view.stateMessage) document.getElementById('info-msg').textContent = view.stateMessage;

  // 四個方位：以自己為 bottom，順時針 next=right...
  for (let i = 0; i < 4; i++) {
    const seat = (you + i) % 4;
    const pos = SEAT_LABELS[i];
    renderSeat(view.seats[seat], pos, seat, view);
  }

  // 中央棄牌池
  renderDiscardPool(view);

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
    if (/碰$/.test(msg)) maybeSpeak(actor, 'pong', .6);
    else if (/吃$/.test(msg)) maybeSpeak(actor, 'chi', .6);
    else if (/槓$/.test(msg)) maybeSpeak(actor, 'kong', .75);
    else if (/補花 \d+ 張$/.test(msg)) maybeSpeak(actor, 'flower', .55);
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
}

function renderSeat(s, pos, seat, view) {
  const area = document.getElementById('seat-' + pos);
  const isTurn = view.turn === seat;
  const isDealer = view.dealer === seat;
  area.classList.toggle('active-turn', isTurn);

  const nameEl = area.querySelector('.seat-name');
  const windCh = (view.eastSeat != null)
    ? '【' + ['東', '南', '西', '北'][(seat - view.eastSeat + 4) % 4] + '】' : '';
  const guoShuiBadge = (s.guoShui && pos === 'bottom') ? ' 💧過水' : '';
  nameEl.textContent = windCh + (isDealer ? '莊 ' : '') + s.name + guoShuiBadge;
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
    for (const t of tiles) {
      const el = makeTile(t, true);
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
          view.diceBonusMult > 1 ? `籌碼×${view.diceBonusMult}` : '',
        ].filter(Boolean).join('、');
        bonusEl.textContent = view.diceBonusName + (parts ? `（${parts}）` : '');
      }
      setTimeout(() => glass.classList.remove('settled'), 500);
    }
  }, 85);
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
function onClickHandTile(tile) {
  if (!currentActions || !currentActions.discard) return;
  // 出牌
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

      if (play) {
        onClickHandTile(tile); // 之後 renderView 會重建手牌，這張自然消失
      } else {
        // 沒拖到位 → 彈回
        el.style.transition = 'transform .15s';
        el.style.transform = '';
        el.classList.remove('dragging', 'will-play');
        setTimeout(() => { el.style.transition = ''; }, 160);
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
  bar.style.display = 'flex';

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
  const hint = document.createElement('span');
  hint.className = 'action-hint';
  hint.textContent = '👆 拖曳牌到中央打出（或輕點）';
  bar.appendChild(hint);
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

/* ---------- 每手倒數計時（視覺）---------- */
let uiTimerInterval = null;
function startUiTimer(seconds) {
  stopUiTimer();
  const el = document.getElementById('info-timer');
  if (!el) return;
  let remain = Math.round(seconds);
  const paint = () => {
    el.textContent = '⏱ ' + remain;
    el.style.display = 'inline';
    el.classList.toggle('urgent', remain <= 5);
  };
  paint();
  uiTimerInterval = setInterval(() => {
    remain--;
    if (remain < 0) { stopUiTimer(); return; }
    paint();
  }, 1000);
}
function stopUiTimer() {
  if (uiTimerInterval) { clearInterval(uiTimerInterval); uiTimerInterval = null; }
  const el = document.getElementById('info-timer');
  if (el) { el.style.display = 'none'; el.classList.remove('urgent'); }
}

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

function showHandOver(payload) {
  lastHandOver = payload;
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
  el.querySelector('.splash-tai').textContent =
    `${winner.score.total} 台` + (mult > 1 ? `　×${mult}` : '');

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

  if (payload.result === 'draw') {
    Sound.draw_game();
    body.innerHTML = `<h2>流局</h2><p>牌牆摸完，無人胡牌。</p>` + scoreTable(payload.scores);
  } else if (payload.result === 'falseHu') {
    Sound.draw_game();
    const payRows = payload.payments.map(pm =>
      `<li>賠 ${escapeHtml(seatName(pm.to))} <b>${pm.value}</b> 籌碼</li>`).join('');
    body.innerHTML = `
      <h2>💥 ${escapeHtml(seatName(payload.offender))} 詐胡！</h2>
      <p class="win-way">牌未成卻宣告胡牌，依最接近的聽牌（${payload.estTai} 台）賠付各家，並讓出莊位。</p>
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
          <div class="tai-total">共 ${s.total} 台${mult > 1 ? `　<span class="mult">豹子 ×${mult}</span>` : ''}
            <span class="chip-line">底 ${di} + ${s.total}×${taiV}${mult > 1 ? `×${mult}` : ''} = <b>${chips}</b>${payNote}</span></div>
          <ul class="tai-items">${items || '<li>無台（屁胡）</li>'}</ul>
        </div>`;
    }).join('');
    body.innerHTML = `
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
