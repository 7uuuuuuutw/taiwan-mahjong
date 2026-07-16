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
});

// 音效用：追蹤狀態變化以觸發對應聲音
let sndPrevDiscards = 0;
let sndPrevMsg = '';

/* ============================================================
 * 開房（HOST）
 * ============================================================ */
function onCreateRoom() {
  myName = (document.getElementById('name-input').value || '玩家').trim().slice(0, 8);
  net.host(myName, (roomCode) => {
    mySeat = 0;
    lobbyPlayers = [{ seat: 0, name: myName, kind: 'host', peerId: null }];
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
    lobbyPlayers = lobbyPlayers.filter(p => p.peerId !== peerId);
    reindexSeats();
    renderLobby();
    broadcastLobby();
  });
  net.on('clientMessage', ({ peerId, msg }) => hostHandleClientMessage(peerId, msg));
}

function hostHandleClientMessage(peerId, msg) {
  if (msg.type === 'join') {
    if (lobbyPlayers.length >= 4) {
      net.sendTo(peerId, { type: 'roomFull' });
      return;
    }
    const seat = lobbyPlayers.length;
    lobbyPlayers.push({ seat, name: (msg.name || '玩家').slice(0, 8), kind: 'client', peerId });
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
  lobbyPlayers.forEach((p, i) => p.seat = i);
}

function broadcastLobby() {
  lobbyPlayers.forEach(p => {
    if (p.kind === 'client') {
      net.sendTo(p.peerId, {
        type: 'lobby',
        players: lobbyPlayers.map(x => ({ seat: x.seat, name: x.name, isHost: x.kind === 'host' })),
        yourSeat: p.seat,
      });
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
      // host 可調整座位順序
      if (net.isHost) {
        const ctrl = document.createElement('span');
        ctrl.className = 'slot-ctrl';
        if (i > 0) {
          const up = document.createElement('button');
          up.className = 'mini-btn'; up.textContent = '↑';
          up.onclick = () => moveSeat(i, i - 1);
          ctrl.appendChild(up);
        }
        if (i < lobbyPlayers.length - 1) {
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

/** host 調整座位順序 */
function moveSeat(a, b) {
  if (!net.isHost || !lobbyPlayers[a] || !lobbyPlayers[b]) return;
  [lobbyPlayers[a], lobbyPlayers[b]] = [lobbyPlayers[b], lobbyPlayers[a]];
  reindexSeats();
  // 更新自己的座位號
  const me = lobbyPlayers.find(p => p.kind === 'host');
  if (me) mySeat = me.seat;
  renderLobby();
  broadcastLobby();
}

/* ---------- HOST 開始遊戲 ---------- */
const AI_PROFILES = [
  { name: '旺來伯', emoji: '🍍' }, { name: '阿花姨', emoji: '🌺' },
  { name: '雀聖', emoji: '🐦' }, { name: '紅中俠', emoji: '🀄' },
  { name: '發財哥', emoji: '💰' }, { name: '骰神', emoji: '🎲' },
  { name: '月光姐', emoji: '🌙' }, { name: '海底撈', emoji: '🎣' },
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
  const aiPool = AI_PROFILES.slice().sort(() => Math.random() - 0.5);
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
    case 'lobby':
      lobbyPlayers = msg.players.map(p => ({ seat: p.seat, name: p.name, kind: p.isHost ? 'host' : 'client' }));
      mySeat = msg.yourSeat;
      renderLobby();
      break;
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
    // 別人：牌背
    const n = s.handCount != null ? s.handCount : (s.hand ? s.hand.length : 0);
    for (let i = 0; i < n; i++) handEl.appendChild(makeBackTile(pos));
  }

  // 亮出的面子
  const meldEl = area.querySelector('.seat-melds');
  meldEl.innerHTML = '';
  for (const m of s.melds) {
    const g = document.createElement('div');
    g.className = 'meld';
    for (const t of m.tiles) g.appendChild(makeTile(t, false));
    if (m.type === 'kong' && m.concealed) g.classList.add('concealed-kong');
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
  pool.innerHTML = '';
  // 顯示每家棄牌（依方位分區）
  for (let i = 0; i < 4; i++) {
    const seat = (view.you + i) % 4;
    const pos = SEAT_LABELS[i];
    const zone = document.createElement('div');
    zone.className = 'discard-zone discard-' + pos;
    for (const t of view.seats[seat].discards) {
      const tile = makeTile(t, false);
      tile.classList.add('discarded');
      zone.appendChild(tile);
    }
    // 標記最後打出的牌
    if (view.lastDiscard && view.lastDiscard.from === seat && zone.lastChild) {
      zone.lastChild.classList.add('just-discarded');
    }
    pool.appendChild(zone);
  }

  // 中央三顆骰子（每局開始由莊家擲，決定東風位與骰運）
  if (view.dice) {
    const DIE_CH = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    const area = document.createElement('div');
    area.className = 'dice-area';
    area.innerHTML = '<div class="dice-row">' + view.dice.map(d =>
      `<span class="die ${d === 1 || d === 4 ? 'die-red' : ''}">${DIE_CH[d - 1]}</span>`).join('') + '</div>'
      + (view.diceBonusName ? `<div class="dice-bonus">${view.diceBonusName}${
          view.diceBonusName === '豹子' ? '（籌碼×3）' : view.diceBonusName === '骰歸' ? '（+2台）' : '（+1台）'
        }</div>` : '');
    pool.appendChild(area);
  }
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
function makeBackTile(pos) {
  const el = document.createElement('div');
  el.className = 'tile tile-back tile-back-' + pos;
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
  if (a.tsumo) addActionBtn(bar, '自摸胡 🎉', 'win', () => sendAction({ type: 'tsumo' }));
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
  currentClaim = payload;
  startUiTimer(15); // 吃碰槓胡 反應倒數（與 host 端 CLAIM_TIMEOUT 一致）
  const opt = payload.options;
  const bar = document.getElementById('action-bar');
  bar.innerHTML = '';
  bar.style.display = 'flex';

  const tile = payload.tile;
  const label = document.createElement('span');
  label.className = 'action-hint';
  label.textContent = '「' + tileName(tile) + '」→ ';
  bar.appendChild(label);

  if (opt.hu) addActionBtn(bar, '胡 🎉', 'win', () => sendClaim({ action: 'hu' }));
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
  const modal = document.getElementById('result-modal');
  const body = document.getElementById('result-body');
  lastHandOver = payload;
  clearActions();
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
    Sound.hu(winners.length === 1 && winners[0].selfDraw);
    const blocks = winners.map(w => {
      const s = w.score;
      const items = s.items.map(it => `<li>${it.name} <b>${it.tai}</b> 台</li>`).join('');
      const way = w.selfDraw ? '自摸' : ('胡 ' + escapeHtml(seatName(payload.from)) + ' 放的牌');
      const mult = s.multiplier || 1;
      const chips = (di + s.total * taiV) * mult;
      const meldTiles = (w.melds || []).flatMap(m => m.tiles);
      return `
        <div class="winner-block">
          <h3>🎉 ${escapeHtml(seatName(w.seat))}　<span class="win-way">${way}</span></h3>
          <div class="reveal-row">${tilesRowHTML(w.hand)}${meldTiles.length ? `<span class="reveal-sep">｜</span>${tilesRowHTML(meldTiles)}` : ''}<span class="reveal-sep">＋</span>${tilesRowHTML([w.winTile], w.winTile)}</div>
          <div class="tai-total">共 ${s.total} 台${mult > 1 ? `　<span class="mult">豹子 ×${mult}</span>` : ''}
            <span class="chip-line">底 ${di} + ${s.total}×${taiV}${mult > 1 ? `×${mult}` : ''} = <b>${chips}</b>${w.selfDraw ? '（三家各付）' : ''}</span></div>
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
