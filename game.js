/* ============================================================
 * game.js — 牌局狀態機（權威版，跑在 host）
 * 管理牌牆、回合、吃碰槓胡、結算。
 * 透過 emit(event, payload) 通知外層（UI / 網路）。
 * 依賴 mahjong.js、ai.js。
 * ============================================================ */

const CLAIM_TIMEOUT_MS = 15000; // 人類玩家反應（吃碰槓胡）逾時自動過水
const TURN_TIME_LIMIT_MS = 20000; // 出牌逾時自動隨機打一張
const WALL_RESERVE = 16; // 牌尾保留 16 張（8 墩）不摸，摸到剩保留區即流局；每開一槓保留區 +1
const HU_GRACE_MS = 9000; // 有人可胡但不提示時的無聲反應窗口（自行按「胡」鈕）
const DICE_SETTLE_MS = 1250; // 擲骰翻滾動畫定格時間，超過後才開始發牌演出
const AI_CLAIM_DELAY_MS = [650, 950]; // 真人打出的牌被電腦吃碰槓前的可見延遲區間

class GameEngine {
  /**
   * @param {object[]} seats [{id,name,isAI}] 長度 4，座位 0..3
   * @param {function} emit (event, payload) => void
   * @param {object} opts {roundWind, dealer, dealerStreak, seed}
   */
  constructor(seats, emit, opts = {}) {
    this.seats = seats.map((s, i) => ({
      seat: i, id: s.id, name: s.name, isAI: !!s.isAI, aiStyle: s.aiStyle || 'balanced',
      hand: [], melds: [], flowers: [], discards: [], score: opts.scores ? opts.scores[i] : 0,
      connected: true,
      guoShui: false, // 過水：棄胡後，打出一張牌前不得再胡
    }));
    this.emit = emit;
    this.roundWind = opts.roundWind || 0;   // 0東
    this.dealer = opts.dealer || 0;
    this.dealerStreak = opts.dealerStreak || 0;
    this.baseTai = opts.baseTai || 1;       // 每台幾分
    this.baseDi = opts.baseDi || 1;         // 底
    // 出牌時限（毫秒）；0 = 不計時
    this.turnLimitMs = (opts.turnLimitMs != null) ? opts.turnLimitMs : TURN_TIME_LIMIT_MS;
    this.aiLevel = opts.aiLevel || 'normal'; // 電腦強度 easy/normal/hard
    this.wallReserve = WALL_RESERVE; // 牌尾保留區（每局於 dealAndBegin 重設）
    // 可選規則：哩咕（八對半）與骰子加成，預設皆開啟（維持目前設定）；
    // leopardMode：豹子的效果 — 'chip3'籌碼×3（預設）／'tai3'台數×3
    this.rules = { ligu: opts.ligu !== false, diceBonus: opts.diceBonus !== false, leopardMode: opts.leopardMode || 'chip3' };
    this.winOpts = { allowLiGu: this.rules.ligu }; // 供 isWinningHand/getTingTiles 沿用
    this.rng = mulberry32(opts.seed || (Date.now() >>> 0));
    this.phase = 'idle';
    this.claimWindow = null;
    this.claimTimer = null;
    this.turnTimer = null;
    this.lastDrawWasKong = false;
    this.drawnTile = null;
  }

  /** 銷毀：停掉所有計時器並靜音事件（回等待室時呼叫，避免舊局干擾新局） */
  destroy() {
    this.dead = true;
    clearTimeout(this.claimTimer);
    this.clearTurnTimer();
    this.emit = () => {};
  }

  /* -------- 出牌計時（人類逾時自動隨機打）-------- */
  armTurnTimer(seat) {
    clearTimeout(this.turnTimer);
    if (!this.turnLimitMs) return; // 不計時
    this.turnTimer = setTimeout(() => this.autoDiscard(seat), this.turnLimitMs);
  }
  clearTurnTimer() {
    clearTimeout(this.turnTimer);
    this.turnTimer = null;
  }
  autoDiscard(seat) {
    if (this.phase !== 'act' || this.turn !== seat) return;
    const p = this.seats[seat];
    const pool = p.hand.filter(t => !isFlower(t));
    if (pool.length === 0) return;
    const tile = pool[Math.floor(Math.random() * pool.length)];
    this.discard(seat, tile);
  }

  /* -------- 擲骰（每局開始由莊家擲三顆）--------
   * 骰數和決定東風位（正花「春/梅」對應的座位）；
   * 全紅(皆1或4) +1台；骰歸(等差1) +2台；豹子(三同) 依房間設定為 籌碼×3／台數×3 */
  rollDice() {
    this.rollId = (this.rollId || 0) + 1; // 供前端辨識「新的一次擲骰」以播放翻滾動畫
    const d = () => 1 + Math.floor(this.rng() * 6);
    this.dice = [d(), d(), d()];
    const sum = this.dice[0] + this.dice[1] + this.dice[2];
    // 由莊家起算，依骰數和決定誰坐「東」
    this.eastSeat = (this.dealer + (sum - 1)) % 4;
    const sorted = this.dice.slice().sort((a, b) => a - b);
    // 骰運可累積：例如 111/444 = 全紅 且 豹子
    const names = [];
    let tai = 0, mult = 1, taiMult = 1;
    if (this.dice.every(x => x === 1 || x === 4)) { names.push('全紅'); tai += 1; }
    if (sorted[1] === sorted[0] + 1 && sorted[2] === sorted[1] + 1) { names.push('骰歸'); tai += 2; }
    if (sorted[0] === sorted[2]) {
      names.push('豹子');
      const mode = this.rules.leopardMode || 'chip3';
      if (mode === 'tai3') taiMult *= 3;
      else mult *= 3; // 'chip3'（預設）
    }
    this.diceBonus = (names.length && this.rules.diceBonus) ? { name: names.join('＋'), tai, mult, taiMult } : null;
  }

  /* -------- 開始一局：先由莊家擲骰 -------- */
  startHand() {
    clearTimeout(this.claimTimer);
    this.clearTurnTimer();
    for (const p of this.seats) { p.hand = []; p.melds = []; p.flowers = []; p.discards = []; p.guoShui = false; }
    this.dice = null; this.diceBonus = null;
    this.lastDiscard = null;
    this.winner = null;
    this.drawnTile = null;
    this.phase = 'dice';
    const dealerP = this.seats[this.dealer];
    this.emitState(`等待莊家 ${dealerP.name} 擲骰`);
    if (dealerP.isAI) {
      setTimeout(() => { if (!this.dead && this.phase === 'dice') this.doRollAndDeal(); }, 1000);
    } else {
      this.emit('rollDiceRequest', { seat: this.dealer });
    }
  }

  /** 莊家擲骰 → 發牌開打（先讓玩家看到骰子結果，等翻滾動畫定格後才開始抓牌） */
  doRollAndDeal() {
    this.rollDice();
    this.phase = 'dice-rolled'; // 骰子已定案但尚未發牌，防止此空檔誤觸詐胡
    this.emitState(`${this.seats[this.dealer].name} 擲出骰子`);
    setTimeout(() => { if (!this.dead) this.dealAndBegin(); }, DICE_SETTLE_MS);
  }

  /** 發牌動畫：先讓莊家「開門」抓第一張牌，這張抓完、畫面演出後，
   *  才開始其他玩家（含莊家剩餘的牌）依序補牌抓滿（共 4 輪，每步 4 張），
   *  最後補花。純演出、由電腦自動進行，玩法不變。 */
  dealAndBegin() {
    const deck = shuffle(buildDeck(), () => this.rng());
    this.wall = deck;
    this.wallReserve = WALL_RESERVE; // 每局重設保留區（開槓會 +1）
    for (const p of this.seats) { p.hand = []; p.melds = []; p.flowers = []; p.discards = []; p.kuikaeForbidden = null; }
    this.flowerPool = new Set(); // 每局重設「七搶一」的全桌花牌進度追蹤
    this.phase = 'dealing';

    // 開門：莊家先抓 1 張，讓玩家看到「開門」這個動作獨立演出一拍
    const dealerP = this.seats[this.dealer];
    dealerP.hand.push(this.drawFront());
    this.emitState(`${dealerP.name} 開門`);
    setTimeout(() => this.dealRestAfterOpening(), 320);
  }

  dealRestAfterOpening() {
    if (this.dead) return;
    // 開門後才開始其他家補牌：莊家先前已抓 1 張，這裡補足剩下 3 張湊滿第一輪；
    // 其餘三家與後續 3 輪維持每步 4 張
    const steps = [{ seat: this.dealer, count: 3 }];
    for (let k = 1; k < 4; k++) steps.push({ seat: (this.dealer + k) % 4, count: 4 });
    for (let r = 1; r < 4; r++) {
      for (let k = 0; k < 4; k++) steps.push({ seat: (this.dealer + k) % 4, count: 4 });
    }
    const dealStep = (i) => {
      if (this.dead) return;
      if (i >= steps.length) return this.flowerPhase(0);
      const { seat, count } = steps[i];
      const p = this.seats[seat];
      for (let j = 0; j < count; j++) p.hand.push(this.drawFront());
      p.hand = sortTiles(p.hand);
      this.emitState(`${p.name} 抓牌`);
      setTimeout(() => dealStep(i + 1), 230);
    };
    dealStep(0);
  }

  /** 補花演出：自莊家起依序補花，補到花的多停一下 */
  flowerPhase(k) {
    if (this.dead || this.phase === 'over') return; // 七搶一可能在補花途中就把本局結束了
    if (k >= 4) {
      this.turn = this.dealer;
      this.phase = 'draw';
      this.lastDiscard = null;
      this.winner = null;
      this.emitState('開始新局');
      this.doDrawPhase();
      return;
    }
    const seat = (this.dealer + k) % 4;
    const p = this.seats[seat];
    const before = p.flowers.length;
    this.replaceFlowers(seat);
    if (this.phase === 'over') return; // 補花途中觸發七搶一，不再繼續演出
    p.hand = sortTiles(p.hand);
    const got = p.flowers.length - before;
    this.emitState(got > 0 ? `${p.name} 補花 ${got} 張` : `${p.name} 理牌`);
    setTimeout(() => this.flowerPhase(k + 1), got > 0 ? 650 : 260);
  }

  drawFront() { return this.wall.shift(); }
  drawBack() { return this.wall.pop(); } // 槓/補花從牌尾摸
  /** 可摸張數（扣掉牌尾保留區） */
  drawableCount() { return this.wall.length - this.wallReserve; }

  /** 補花：把手上的花放到 flowers 區，從牌尾補摸，直到沒有花 */
  replaceFlowers(seat) {
    const p = this.seats[seat];
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < p.hand.length; i++) {
        if (isFlower(p.hand[i])) {
          if (this.trackFlowerDraw(seat, p.hand[i])) return; // 七搶一觸發，本局已結束
          p.flowers.push(p.hand[i]);
          p.hand.splice(i, 1);
          if (this.drawableCount() > 0) p.hand.push(this.drawBack());
          changed = true;
          break;
        }
      }
    }
    p.flowers.sort((a, b) => tileOrder(a) - tileOrder(b));
  }

  /** 追蹤全桌花牌抓取進度，並判定「七搶一」：若某家已經持有 7 張花，
   *  這時全桌最後一張（第 8 種）花被別家抓走、準備補花——持有 7 張花的
   *  那家可以直接搶這張花胡牌（不看牌型，固定 8 台，由抓到這張花的人
   *  單獨賠付）。回傳 true 表示已觸發搶花胡牌、本局結束，呼叫端要立刻
   *  return，不能再把這張花加進抓牌者的花牌區（牌已經被搶走了）。 */
  trackFlowerDraw(seat, tile) {
    if (!this.flowerPool) this.flowerPool = new Set();
    const num = parseInt(tile.slice(1), 10);
    if (this.flowerPool.has(num)) return false; // 只有「全新種類」才可能是最後一張
    this.flowerPool.add(num);
    if (this.flowerPool.size === 8) {
      const robberSeat = this.seats.findIndex((p, i) => i !== seat && p.flowers.length === 7);
      if (robberSeat >= 0) {
        this.robFlowerWin(robberSeat, seat, tile);
        return true;
      }
    }
    return false;
  }

  /** 七搶一結算：不看牌型，固定 8 台，由抓到那張花的人（fromSeat）單獨賠付。 */
  robFlowerWin(robberSeat, fromSeat, flowerTile) {
    clearTimeout(this.claimTimer);
    this.clearTurnTimer();
    this.drawnTile = null;
    this.phase = 'over';
    const robber = this.seats[robberSeat];
    const score = { total: 8, items: [{ name: '七搶一', tai: 8 }], multiplier: 1 };
    this.settle(robberSeat, score, false, fromSeat);
    this.winner = { seat: robberSeat, winTile: flowerTile, selfDraw: false, score };
    this.emit('handOver', {
      result: 'win',
      winners: [{
        seat: robberSeat, winTile: flowerTile, selfDraw: false, score,
        hand: robber.hand.slice(), melds: robber.melds, flowers: robber.flowers,
      }],
      from: fromSeat,
      scores: this.seats.map(s => s.score),
      dealerWin: robberSeat === this.dealer,
      roundEnding: this.willCompleteFullRound(robberSeat === this.dealer),
      baseDi: this.baseDi, baseTai: this.baseTai,
    });
    this.emitState(`${robber.name} 七搶一！`);
  }

  /* -------- 摸牌階段 -------- */
  doDrawPhase() {
    if (this.drawableCount() <= 0) return this.drawnGame();
    const p = this.seats[this.turn];
    let tile = this.drawFront();
    // 補花（自摸到花 → 記錄，從牌尾補）
    while (isFlower(tile)) {
      if (this.trackFlowerDraw(this.turn, tile)) return; // 七搶一觸發，本局已結束
      p.flowers.push(tile);
      p.flowers.sort((a, b) => tileOrder(a) - tileOrder(b));
      if (this.drawableCount() <= 0) return this.drawnGame();
      tile = this.drawBack();
      this.lastDrawWasKong = true; // 補花後再胡 = 槓上開花性質（花槓上）
    }
    p.hand.push(tile);
    p.hand = sortTiles(p.hand);
    this.drawnTile = tile;
    this.phase = 'act'; // 該玩家要行動（打牌/自摸/暗槓/加槓）
    this.blockTsumoThisDraw = false; // 一般摸牌不受明槓限制

    const actions = this.selfActions(this.turn, tile);
    this.tsumoAvailable = actions.tsumo; // 供過水判斷（棄自摸）
    this.emitState(`${p.name} 摸牌`);
    if (p.isAI) {
      this.aiSelfAct(this.turn, tile, actions);
    } else {
      this.armTurnTimer(this.turn);
      this.emit('yourTurn', { seat: this.turn, tile, actions, timeLimit: this.turnLimitMs / 1000 });
    }
  }

  /** 計算摸牌後自己可做的動作 */
  selfActions(seat, tile) {
    const p = this.seats[seat];
    const a = { discard: true, tsumo: false, concealedKongs: [], addKongs: [] };
    // 自摸（過水中、或明槓補牌時不得自摸）
    if (!p.guoShui && !this.blockTsumoThisDraw && isWinningHand(p.hand, p.melds, this.winOpts)) a.tsumo = true;
    // 暗槓
    a.concealedKongs = findConcealedKongs(p.hand);
    // 加槓（手上有牌與已碰的刻子相同）
    for (const m of p.melds) {
      if (m.type === 'pong' && p.hand.includes(m.tiles[0])) a.addKongs.push(m.tiles[0]);
    }
    return a;
  }

  /* -------- 玩家行動（來自 UI / AI）-------- */
  playerAct(seat, action) {
    // 莊家擲骰
    if (action.type === 'rollDice') {
      if (this.phase === 'dice' && seat === this.dealer) this.doRollAndDeal();
      return;
    }
    // 常駐胡牌鈕（按錯 = 詐胡）
    if (action.type === 'declareHu') return this.declareHuAttempt(seat);

    if (this.phase === 'act' && seat === this.turn) {
      this.clearTurnTimer();
      if (action.type === 'discard') return this.discard(seat, action.tile);
      if (action.type === 'tsumo') return this.declareWin(seat, this.drawnTile, true);
      if (action.type === 'concealedKong') return this.doConcealedKong(seat, action.tile);
      if (action.type === 'addKong') return this.doAddKong(seat, action.tile);
    }
    if (this.phase === 'claim' && this.claimWindow) {
      return this.submitClaim(seat, action);
    }
  }

  /* -------- 打牌 -------- */
  discard(seat, tile) {
    const p = this.seats[seat];
    const idx = p.hand.indexOf(tile);
    if (idx < 0) return;
    // 喰い替え限制：剛吃/碰完，這張是不能打的
    if (p.kuikaeForbidden && p.kuikaeForbidden.includes(tile)) {
      this.emitState(`${p.name} 剛吃／碰，這張不能打`);
      return;
    }
    // 過水規則：
    //  - 這次打牌若是「放棄自摸」→ 進入過水（打出一張牌前不得再胡）
    //  - 否則，打出一張牌即解除過水
    const decliningTsumo = (this.turn === seat && this.tsumoAvailable);
    if (decliningTsumo) p.guoShui = true;
    else if (p.guoShui) p.guoShui = false;
    this.tsumoAvailable = false;
    p.kuikaeForbidden = null;

    p.hand.splice(idx, 1);
    p.discards.push(tile);
    p.hand = sortTiles(p.hand);
    this.lastDiscard = { tile, from: seat };
    this.lastDrawWasKong = false;
    this.openClaimWindow(tile, seat);
  }

  /* -------- 暗槓 / 加槓 -------- */
  doConcealedKong(seat, tile) {
    const p = this.seats[seat];
    for (let i = 0; i < 4; i++) p.hand.splice(p.hand.indexOf(tile), 1);
    p.melds.push({ type: 'kong', tiles: [tile, tile, tile, tile], concealed: true });
    this.afterKongDraw(seat, false); // 暗槓：補牌仍可自摸（槓上開花）
  }

  doAddKong(seat, tile) {
    const p = this.seats[seat];
    const m = p.melds.find(mm => mm.type === 'pong' && mm.tiles[0] === tile);
    // 搶槓檢查：其他人是否可胡這張
    for (let k = 1; k < 4; k++) {
      const other = (seat + k) % 4;
      const op = this.seats[other];
      if (isWinningHand(op.hand.concat([tile]), op.melds, this.winOpts)) {
        // 允許搶槓
        this.lastDiscard = { tile, from: seat };
        this.robbingKong = true;
        this.openClaimWindow(tile, seat, /*robbing*/ true, m);
        return;
      }
    }
    m.type = 'kong';
    m.tiles = [tile, tile, tile, tile];
    p.hand.splice(p.hand.indexOf(tile), 1);
    this.afterKongDraw(seat, true); // 加槓為明槓：補牌不能自摸
  }

  /** @param isOpenKong 明槓（大明槓／加槓）為 true；暗槓為 false。
   *  明槓補的牌不能自摸（僅暗槓可槓上開花）。 */
  afterKongDraw(seat, isOpenKong) {
    // 每開一槓，牌尾保留區 +1（海底往前移一張）
    this.wallReserve += 1;
    // 槓後從牌尾補摸一張
    if (this.drawableCount() <= 0) return this.drawnGame();
    const p = this.seats[seat];
    let tile = this.drawBack();
    while (isFlower(tile)) {
      if (this.trackFlowerDraw(seat, tile)) return; // 七搶一觸發，本局已結束
      p.flowers.push(tile);
      if (this.drawableCount() <= 0) return this.drawnGame();
      tile = this.drawBack();
    }
    p.hand.push(tile);
    p.hand = sortTiles(p.hand);
    this.drawnTile = tile;
    this.lastDrawWasKong = true;
    this.turn = seat;
    this.phase = 'act';
    this.blockTsumoThisDraw = !!isOpenKong;
    const actions = this.selfActions(seat, tile);
    if (isOpenKong) actions.tsumo = false; // 保險：即使 selfActions 算出能胡也不讓 AI 自動宣告
    this.tsumoAvailable = actions.tsumo;
    this.emitState(`${p.name} 槓`);
    if (p.isAI) this.aiSelfAct(seat, tile, actions);
    else { this.armTurnTimer(seat); this.emit('yourTurn', { seat, tile, actions, kong: true, timeLimit: this.turnLimitMs / 1000 }); }
  }

  /* -------- 開啟索取視窗（吃碰槓胡）-------- */
  openClaimWindow(tile, from, robbing = false, addKongMeld = null) {
    const eligible = {};
    for (let k = 1; k < 4; k++) {
      const seat = (from + k) % 4;
      const p = this.seats[seat];
      const ent = {};
      // 胡（放槍 / 搶槓）；過水中不得胡
      if (!p.guoShui && isWinningHand(p.hand.concat([tile]), p.melds, this.winOpts)) ent.hu = true;
      if (!robbing) {
        if (canPong(p.hand, tile)) ent.pong = true;
        // 禁止「槓上家」：打牌者若是本座位的上家（本座位為打牌者的下家），不得明槓
        const isDiscarderMyUpper = (seat === (from + 1) % 4);
        if (canKong(p.hand, tile) && !isDiscarderMyUpper) ent.kong = true;
        // 只有下家能吃
        if (isDiscarderMyUpper) {
          const opts = canChiOptions(p.hand, tile);
          if (opts.length) { ent.chi = true; ent.chiOptions = opts; }
        }
      }
      if (Object.keys(ent).length) eligible[seat] = ent;
    }

    if (Object.keys(eligible).length === 0) {
      this.robbingKong = false;
      if (robbing && addKongMeld) {
        // 無人搶槓 → 完成加槓
        const p = this.seats[from];
        addKongMeld.type = 'kong';
        addKongMeld.tiles = [tile, tile, tile, tile];
        p.hand.splice(p.hand.indexOf(tile), 1);
        return this.afterKongDraw(from, true); // 加槓：補牌不能自摸
      }
      return this.nextTurn(from);
    }

    this.phase = 'claim';
    this.claimWindow = { tile, from, robbing, addKongMeld, eligible, responses: {} };
    this.emitState('等待其他玩家');

    // AI 回應；人類只收到「吃碰槓」選項——胡牌永不提示，
    // 玩家須自行判斷並按常駐「胡」鈕（declareHuAttempt 會對照內部 eligible）
    // 電腦的吃碰槓一律延遲一下才動作（不分打牌者是真人或電腦），讓那張牌先
    // 真的在畫面中央顯示出來一拍，避免同步瞬間解決導致畫面根本沒機會繪出、
    // 排版跳動的問題
    let anyVisibleHuman = false;
    for (const seatStr of Object.keys(eligible)) {
      const seat = +seatStr;
      const p = this.seats[seat];
      if (p.isAI) {
        const decision = aiReactToDiscard(p.hand, p.melds, tile,
          { hu: eligible[seat].hu, pong: eligible[seat].pong, kong: eligible[seat].kong,
            chi: eligible[seat].chi, chiOptions: eligible[seat].chiOptions },
          { style: p.aiStyle }, this.aiLevel);
        const [lo, hi] = AI_CLAIM_DELAY_MS;
        const delay = lo + Math.random() * (hi - lo);
        setTimeout(() => { if (!this.dead) this.submitClaim(seat, decision); }, delay);
      } else {
        const visible = { ...eligible[seat] };
        delete visible.hu; // 隱藏胡牌提示
        if (Object.keys(visible).length > 0) {
          anyVisibleHuman = true;
          this.emit('claimOffer', { seat, tile, from, options: visible });
        }
        // 只能胡的人：完全不通知，留一段無聲反應窗口
      }
    }
    // 逾時保護：有可見選項照常 15 秒；純胡牌的無聲窗口較短
    clearTimeout(this.claimTimer);
    this.claimTimer = setTimeout(() => this.forceResolveClaims(),
      anyVisibleHuman ? CLAIM_TIMEOUT_MS : HU_GRACE_MS);
  }

  submitClaim(seat, decision) {
    if (!this.claimWindow || !this.claimWindow.eligible[seat]) return;
    this.claimWindow.responses[seat] = decision || { action: 'pass' };
    this.maybeResolveClaims();
  }

  /** 提前結算索取視窗：胡的人不用等吃碰的人決定；碰/槓的人也不用等吃的人決定——
   * 但只要還有「可能胡」的位置沒回應，就必須繼續等（胡可能多家同時成立，一炮
   * 雙響/三響要收齊才能判斷），且碰/槓的優先序（依打牌者順下第 1/2/3 家）也要
   * 先確認沒有更優先的位置還沒表態，才能提前結算。 */
  maybeResolveClaims() {
    const cw = this.claimWindow;
    if (!cw) return;
    const { from, eligible, responses } = cw;
    const eligibleSeats = Object.keys(eligible).map(Number);
    const pending = eligibleSeats.filter(s => !(s in responses));
    if (pending.length === 0) return this.resolveClaims();

    // 還有「可能胡」的位置沒回應 → 必須繼續等（胡的優先序最高，且可多家同胡）
    if (pending.some(s => eligible[s].hu)) return;

    // 所有可能胡的位置都回應了；只要有人選擇胡，其餘吃碰決定已不重要，直接結算
    const anyHu = eligibleSeats.some(s => responses[s] && responses[s].action === 'hu');
    if (anyHu) return this.resolveClaims();

    // 沒人胡。看碰/槓：依打牌者順下第 1/2/3 家的優先序，找出目前最優先、已確定要
    // 碰/槓的位置；只要比它更優先（順序更前）的碰/槓資格位置都已回應，就能提前
    // 結算（不必等吃的人決定，因為碰/槓一定贏過吃）。
    const order = [1, 2, 3].map(k => (from + k) % 4).filter(s => eligible[s]);
    const pongKongIdx = order.findIndex(s => {
      const r = responses[s];
      return r && (r.action === 'pong' || r.action === 'kong');
    });
    if (pongKongIdx >= 0) {
      const higherPriorityPending = order.slice(0, pongKongIdx).some(s =>
        (eligible[s].pong || eligible[s].kong) && !(s in responses));
      if (!higherPriorityPending) return this.resolveClaims();
    }
    // 否則（只剩吃有可能成立，或碰/槓優先序尚未確認）→ 繼續等
  }

  forceResolveClaims() {
    if (!this.claimWindow) return;
    for (const seatStr of Object.keys(this.claimWindow.eligible)) {
      if (!this.claimWindow.responses[seatStr]) {
        this.claimWindow.responses[seatStr] = { action: 'pass' };
      }
    }
    this.resolveClaims();
  }

  resolveClaims() {
    clearTimeout(this.claimTimer);
    const cw = this.claimWindow;
    if (!cw) return;
    const { tile, from, responses, robbing, addKongMeld, eligible } = cw;

    // 過水：可胡卻選擇不胡的人，進入過水狀態
    for (const seatStr of Object.keys(eligible)) {
      const s = +seatStr;
      if (eligible[s].hu && (!responses[s] || responses[s].action !== 'hu')) {
        this.seats[s].guoShui = true;
      }
    }

    // 依優先序：胡 > 槓 > 碰 > 吃
    // 胡可多家同時成立（照出牌順序排列；三家全胡 = 一炮三響）
    const huSeats = [];
    let pongKong = null, chi = null;
    for (let k = 1; k < 4; k++) {
      const seat = (from + k) % 4;
      const r = responses[seat];
      if (!r) continue;
      if (r.action === 'hu') huSeats.push(seat);
      if ((r.action === 'kong' || r.action === 'pong') && !pongKong) pongKong = { seat, r };
      if (r.action === 'chi' && !chi) chi = { seat, r };
    }

    this.claimWindow = null;

    if (huSeats.length > 0) {
      this.robbingKong = robbing;
      // 一炮雙響：僅打牌順序最接近打牌者的那家胡牌（huSeats 已依順下 1/2/3 家排序）；
      // 一炮三響（三家全胡）維持三家都胡
      const finalHuSeats = huSeats.length === 2 ? [huSeats[0]] : huSeats;
      return this.multiWin(finalHuSeats, tile, from);
    }
    this.robbingKong = false;

    // 若原本是加槓且無人搶槓 → 完成加槓
    if (robbing && addKongMeld) {
      const p = this.seats[from];
      addKongMeld.type = 'kong';
      addKongMeld.tiles = [tile, tile, tile, tile];
      p.hand.splice(p.hand.indexOf(tile), 1);
      return this.afterKongDraw(from, true); // 加槓：補牌不能自摸
    }

    if (pongKong) {
      const { seat, r } = pongKong;
      const p = this.seats[seat];
      // 從打牌者的棄牌移除（牌已被拿走，中央大牌也一併清除）
      this.seats[from].discards.pop();
      this.lastDiscard = null;
      if (r.action === 'kong') {
        for (let i = 0; i < 3; i++) p.hand.splice(p.hand.indexOf(tile), 1);
        p.melds.push({ type: 'kong', tiles: [tile, tile, tile, tile], concealed: false });
        this.emitState(`${p.name} 槓`);
        return this.afterKongDraw(seat, true); // 大明槓：補牌不能自摸
      } else {
        for (let i = 0; i < 2; i++) p.hand.splice(p.hand.indexOf(tile), 1);
        p.melds.push({ type: 'pong', tiles: [tile, tile, tile], from });
        p.hand = sortTiles(p.hand);
        this.turn = seat;
        this.phase = 'act';
        this.drawnTile = null;
        // 碰完不能立刻打出剛碰的那張牌（喰い替え限制）
        p.kuikaeForbidden = [tile];
        this.emitState(`${p.name} 碰`);
        // 暗槓只能在「自己摸牌那輪」宣告；碰完立刻要打牌，不提供暗槓選項
        const actions = { discard: true, tsumo: false, concealedKongs: [], addKongs: [] };
        if (p.isAI) this.aiSelfAct(seat, null, actions);
        else { this.armTurnTimer(seat); this.emit('yourTurn', { seat, tile: null, actions, timeLimit: this.turnLimitMs / 1000 }); }
        return;
      }
    }

    if (chi) {
      const { seat, r } = chi;
      const p = this.seats[seat];
      this.seats[from].discards.pop();
      this.lastDiscard = null;
      const use = sortTiles(r.chi); // 兩張手牌
      for (const t of use) p.hand.splice(p.hand.indexOf(t), 1);
      // 被吃的牌放中間（如手上有 3、4 吃 2 → 顯示 3 2 4）
      p.melds.push({ type: 'chi', tiles: [use[0], tile, use[1]], claimed: tile, from });
      p.hand = sortTiles(p.hand);
      this.turn = seat;
      this.phase = 'act';
      this.drawnTile = null;
      // 吃完不能立刻打出會讓這口吃變得「白吃」的牌（喰い替え限制）
      p.kuikaeForbidden = this.computeKuikaeForbidden(tile, use);
      this.emitState(`${p.name} 吃`);
      // 暗槓只能在「自己摸牌那輪」宣告；吃完立刻要打牌，不提供暗槓選項
      const actions = { discard: true, tsumo: false, concealedKongs: [], addKongs: [] };
      if (p.isAI) this.aiSelfAct(seat, null, actions);
      else { this.armTurnTimer(seat); this.emit('yourTurn', { seat, tile: null, actions, timeLimit: this.turnLimitMs / 1000 }); }
      return;
    }

    // 全部過水 → 下一家
    this.nextTurn(from);
  }

  /** 吃完後不可立即打出的牌（喰い替え限制）：
   *  永遠禁止打出剛被吃走的那張牌；若是「邊張」吃（用最小/最大兩張湊成吃），
   *  也禁止打出會讓這口吃等同「白吃」的另一端延伸牌。
   *  例：手牌 2345，吃別人的 2（用 3,4 組成 234）→ 禁打 2、5。 */
  computeKuikaeForbidden(claimedTile, usedTiles) {
    const suit = claimedTile[0];
    const n = parseInt(claimedTile.slice(1), 10);
    const forbidden = new Set([claimedTile]);
    const nums = usedTiles.map(t => parseInt(t.slice(1), 10)).sort((a, b) => a - b);
    if (nums[0] === n + 1 && nums[1] === n + 2) {        // 吃的是最小張（如吃2用3,4組234）
      if (n + 3 <= 9) forbidden.add(suit + (n + 3));      // 禁打上緣延伸牌（如5）
    } else if (nums[0] === n - 2 && nums[1] === n - 1) {  // 吃的是最大張（如吃4用2,3組234）
      if (n - 3 >= 1) forbidden.add(suit + (n - 3));      // 禁打下緣延伸牌
    }
    // 中洞吃（用 n-1, n+1）：僅禁打被吃的牌本身，無額外延伸限制
    return [...forbidden];
  }

  nextTurn(from) {
    this.turn = (from + 1) % 4;
    this.phase = 'draw';
    this.doDrawPhase();
  }

  /* -------- AI 行動 -------- */
  aiSelfAct(seat, tile, actions) {
    const p = this.seats[seat];
    // 延遲一點模擬思考，讓 UI 有動畫感
    setTimeout(() => {
      if (this.dead) return;
      if (this.phase !== 'act' || this.turn !== seat) return;
      if (actions.tsumo) return this.declareWin(seat, this.drawnTile, true);
      // 暗槓（有就槓，簡單策略）
      if (actions.concealedKongs && actions.concealedKongs.length) {
        return this.doConcealedKong(seat, actions.concealedKongs[0]);
      }
      if (actions.addKongs && actions.addKongs.length) {
        return this.doAddKong(seat, actions.addKongs[0]);
      }
      const ctx = { seatDiscards: this.seats.map(s => s.discards), style: p.aiStyle, kuikaeForbidden: p.kuikaeForbidden || [] };
      let discardTile = aiChooseDiscard(p.hand, p.melds, this.aiLevel, ctx);
      // 安全網：萬一還是選到剛吃/碰不能打的牌，改打手上第一張允許的牌，避免卡住不出牌
      if (p.kuikaeForbidden && p.kuikaeForbidden.includes(discardTile)) {
        const allowed = p.hand.find(t => !p.kuikaeForbidden.includes(t));
        if (allowed) discardTile = allowed;
      }
      this.discard(seat, discardTile);
    }, 1000); // 電腦間隔一秒出牌
  }

  /* -------- 胡牌結算 -------- */

  /** 計算某家的胡牌台數並結算籌碼（單胡/多胡共用） */
  computeWin(seat, winTile, selfDraw, loser) {
    const p = this.seats[seat];
    // 自摸時 winTile 已在手上，需扣除一張來當 winTile
    const handMinus = p.hand.slice();
    if (selfDraw) handMinus.splice(handMinus.indexOf(winTile), 1);
    const concealedWin = p.melds.every(m => m.concealed); // 無吃碰明槓
    const east = (this.eastSeat != null) ? this.eastSeat : this.dealer;
    const ctx = {
      hand: handMinus,
      winTile,
      melds: p.melds,
      flowers: p.flowers,
      selfDraw,
      isDealer: seat === this.dealer,
      // 莊家台/連莊台：莊家胡牌「或」莊家放槍時都要算
      dealerInvolved: seat === this.dealer || loser === this.dealer,
      seatWind: (seat - east + 4) % 4, // 風位由骰子決定的東風位起算
      roundWind: this.roundWind,
      dealerStreak: this.dealerStreak,
      robbingKong: !!this.robbingKong,
      kongBloom: this.lastDrawWasKong && selfDraw,
      lastTile: this.drawableCount() <= 0, // 摸到/胡到可摸區最後一張 = 海底/河底
      concealedWin,
      diceBonus: this.diceBonus,
      allowLiGu: this.rules.ligu,
    };
    const score = scoreHand(ctx);
    score.multiplier = (this.diceBonus && this.diceBonus.mult > 1) ? this.diceBonus.mult : 1;
    // 全紅「台數×3」：整手台數（含其餘所有台）一併乘3，再用來算籌碼
    if (this.diceBonus && this.diceBonus.taiMult > 1) {
      score.taiMultiplier = this.diceBonus.taiMult;
      score.total *= this.diceBonus.taiMult;
    }
    // 八仙過海（集滿 8 張花）＝胡三家：不論實際是自摸還是胡別人放的牌，
    // 結算一律比照自摸的三家均付
    this.settle(seat, score, selfDraw || score.baXian, loser);
    return {
      seat, winTile, selfDraw, score,
      hand: selfDraw ? handMinus : p.hand.slice(), // 亮牌用（不含胡牌張）
      melds: p.melds, flowers: p.flowers,
    };
  }

  /** 自摸（單家胡） */
  declareWin(seat, winTile, selfDraw) {
    clearTimeout(this.claimTimer);
    this.clearTurnTimer();
    this.drawnTile = null;
    this.phase = 'over';
    const loser = selfDraw ? null : (this.lastDiscard ? this.lastDiscard.from : null);
    const w = this.computeWin(seat, winTile, selfDraw, loser);
    this.winner = { seat, winTile, selfDraw, score: w.score };
    this.robbingKong = false;
    this.emit('handOver', {
      result: 'win', winners: [w], from: loser,
      scores: this.seats.map(s => s.score),
      dealerWin: seat === this.dealer,
      roundEnding: this.willCompleteFullRound(seat === this.dealer),
      baseDi: this.baseDi, baseTai: this.baseTai,
    });
    this.emitState('本局結束');
  }

  /** 放槍（可能多家同胡；三家全胡 = 一炮三響，放槍者付三家） */
  multiWin(huSeats, tile, from) {
    clearTimeout(this.claimTimer);
    this.clearTurnTimer();
    this.drawnTile = null;
    this.phase = 'over';
    const winners = huSeats.map(seat => this.computeWin(seat, tile, false, from));
    // 連莊判定：莊家在贏家之中
    const dealerWin = huSeats.includes(this.dealer);
    this.winner = { seat: huSeats[0], winTile: tile, selfDraw: false, score: winners[0].score };
    this.robbingKong = false;
    this.emit('handOver', {
      result: 'win', winners, from,
      multiShot: winners.length >= 3 ? '一炮三響' : (winners.length === 2 ? '一炮雙響' : null),
      scores: this.seats.map(s => s.score),
      dealerWin,
      roundEnding: this.willCompleteFullRound(dealerWin),
      baseDi: this.baseDi, baseTai: this.baseTai,
    });
    this.emitState('本局結束');
  }

  /* -------- 詐胡 --------
   * 亂按胡但牌未成：賠給每家「自己最接近胡牌」的點數；
   * 付給莊家時再加莊家/連莊台（更包含莊家）。詐胡後換下一家坐莊。 */
  falseHu(seat) {
    if (this.phase === 'over' || this.phase === 'dice' || this.phase === 'dice-rolled' || this.phase === 'dealing') return;
    clearTimeout(this.claimTimer);
    this.clearTurnTimer();
    this.claimWindow = null;
    this.drawnTile = null;
    this.phase = 'over';
    const p = this.seats[seat];
    const estTai = this.estimateNearestWinTai(seat);
    const dealerExtraTai = 1 + this.dealerStreak * 2;
    const baseValue = this.baseDi + estTai * this.baseTai;
    const payments = [];
    for (const q of this.seats) {
      if (q.seat === seat) continue;
      let v = baseValue;
      // 付給莊家（或詐胡者本身是莊家）→ 加莊家台
      if (q.seat === this.dealer || seat === this.dealer) v += dealerExtraTai * this.baseTai;
      q.score += v;
      p.score -= v;
      payments.push({ to: q.seat, value: v });
    }
    this.winner = null;
    this.falseHuHappened = true;
    this.emit('handOver', {
      result: 'falseHu', offender: seat, estTai, payments,
      scores: this.seats.map(s => s.score),
      dealerWin: false,
      roundEnding: this.willCompleteFullRound(false),
      baseDi: this.baseDi, baseTai: this.baseTai,
    });
    this.emitState(`${p.name} 詐胡！`);
  }

  /** 估算某家「最接近的胡牌」台數（聽牌則取可胡牌中最高台；未聽牌 = 0） */
  estimateNearestWinTai(seat) {
    const p = this.seats[seat];
    const east = (this.eastSeat != null) ? this.eastSeat : this.dealer;
    const baseCtx = {
      melds: p.melds, flowers: p.flowers, selfDraw: false,
      isDealer: seat === this.dealer, dealerInvolved: false,
      seatWind: (seat - east + 4) % 4, roundWind: this.roundWind,
      dealerStreak: 0, concealedWin: p.melds.every(m => m.concealed),
      diceBonus: this.diceBonus, allowLiGu: this.rules.ligu,
    };
    const tryHand = (hand16) => {
      let best = 0;
      for (const w of getTingTiles(hand16, p.melds, this.winOpts)) {
        const s = scoreHand({ ...baseCtx, hand: hand16, winTile: w });
        if (s.total > best) best = s.total;
      }
      return best;
    };
    const hand = p.hand.filter(t => !isFlower(t));
    const needMelds = 5 - p.melds.length;
    if (hand.length === needMelds * 3 + 1) return tryHand(hand);   // 等胡狀態
    if (hand.length === needMelds * 3 + 2) {                       // 剛摸牌：試打每一張
      let best = 0;
      for (const t of new Set(hand)) {
        const rest = hand.slice();
        rest.splice(rest.indexOf(t), 1);
        const v = tryHand(rest);
        if (v > best) best = v;
      }
      return best;
    }
    return 0;
  }

  /** 常駐「胡」鈕的宣告：成牌就胡、過水提示、否則詐胡 */
  declareHuAttempt(seat) {
    if (this.phase === 'over' || this.phase === 'dice' || this.phase === 'dice-rolled' || this.phase === 'dealing') return;
    const p = this.seats[seat];
    // 自己回合（摸牌後）
    if (this.phase === 'act' && this.turn === seat) {
      if (isWinningHand(p.hand, p.melds, this.winOpts)) {
        // 明槓（大明槓／加槓）補的牌不能自摸，僅暗槓可以
        if (this.blockTsumoThisDraw) { this.emitState(`${p.name} 明槓補牌，此張不能自摸`); return; }
        if (p.guoShui) { this.emitState(`${p.name} 過水中，不能自摸`); return; }
        this.clearTurnTimer();
        return this.declareWin(seat, this.drawnTile || p.hand[p.hand.length - 1], true);
      }
      return this.falseHu(seat);
    }
    // 索取階段（別人打牌）：這才是真正「面對一張牌決定要不要胡」的時刻
    if (this.phase === 'claim' && this.claimWindow) {
      const ent = this.claimWindow.eligible[seat];
      if (ent && ent.hu) return this.submitClaim(seat, { action: 'hu' });
      const t = this.claimWindow.tile;
      if (isWinningHand(p.hand.concat([t]), p.melds, this.winOpts)) {
        this.emitState(`${p.name} 過水中，不能胡`);
        return;
      }
      return this.falseHu(seat);
    }
    // 其他時機（不是你的回合、也沒有正在等你決定的牌）：
    // 例如反應窗口已過、輪到別家——此時按胡鈕不處罰，只提示，
    // 避免因為看不到提示、反應晚一點就被誤判詐胡
    this.emitState(`${p.name} 目前沒有可以宣告的胡牌`);
  }

  /** 莊家額外台數（莊家 1 台 + 連莊 2n 台） */
  dealerExtraTai() { return 1 + this.dealerStreak * 2; }

  /** 這局結束後，若莊家不連莊、且目前正好是北圈(roundWind===3)的北家(3)在坐莊，
   *  代表東南西北一將剛好在這局結束後打完一整圈。 */
  willCompleteFullRound(dealerWin) {
    return !dealerWin && this.dealer === 3 && this.roundWind === 3;
  }

  /** 分數結算：(底 + 台×台值) × 骰運倍數（豹子×3）
   * 自摸三家各付；非莊家自摸時，莊家那份要多付「莊家+連莊」台。
   * 放槍一家付（若莊家胡或莊家放槍，台數已含莊家/連莊台）。 */
  settle(winner, score, selfDraw, loser) {
    const mult = score.multiplier || 1;
    if (selfDraw) {
      if (winner === this.dealer) {
        // 莊家自摸：台數已含莊家/連莊台，三家均付
        const value = (this.baseDi + score.total * this.baseTai) * mult;
        for (const p of this.seats) {
          if (p.seat === winner) p.score += value * 3;
          else p.score -= value;
        }
      } else {
        // 非莊家自摸：兩散家付基本值，莊家加付莊家/連莊台
        const baseValue = (this.baseDi + score.total * this.baseTai) * mult;
        const dealerValue = (this.baseDi + (score.total + this.dealerExtraTai()) * this.baseTai) * mult;
        score.dealerPay = dealerValue; // 供結算畫面顯示
        score.basePay = baseValue;
        for (const p of this.seats) {
          if (p.seat === winner) p.score += baseValue * 2 + dealerValue;
          else if (p.seat === this.dealer) p.score -= dealerValue;
          else p.score -= baseValue;
        }
      }
    } else {
      const value = (this.baseDi + score.total * this.baseTai) * mult;
      this.seats[winner].score += value;
      if (loser != null) this.seats[loser].score -= value;
    }
  }

  drawnGame() {
    clearTimeout(this.claimTimer);
    this.clearTurnTimer();
    this.drawnTile = null;
    this.phase = 'over';
    this.winner = null;
    this.emit('handOver', {
      result: 'draw',
      hands: this.seats.map(s => ({ hand: s.hand, melds: s.melds, flowers: s.flowers })),
      scores: this.seats.map(s => s.score),
      dealerWin: true, // 流局莊家續莊並算連莊
      baseDi: this.baseDi, baseTai: this.baseTai,
    });
    this.emitState('流局');
  }

  /** 進入下一局（莊家連莊 / 換莊） */
  nextHand(dealerWin) {
    if (dealerWin) {
      this.dealerStreak += 1;
    } else {
      this.dealer = (this.dealer + 1) % 4;
      this.dealerStreak = 0;
      if (this.dealer === 0) this.roundWind = (this.roundWind + 1) % 4;
    }
    this.startHand();
  }

  /* -------- 對外狀態 -------- */
  emitState(msg) {
    this.emit('state', { snapshot: this.snapshot(), message: msg });
  }

  /** 完整快照（host 內部用）；送給各家時再遮蔽 */
  snapshot() {
    return {
      phase: this.phase,
      turn: this.turn,
      dealer: this.dealer,
      roundWind: this.roundWind,
      dealerStreak: this.dealerStreak,
      wallLeft: this.wall ? Math.max(0, this.drawableCount()) : 0, // 顯示「可摸張數」
      lastDiscard: this.lastDiscard,
      dice: this.dice || null,
      rollId: this.rollId || 0,
      diceBonusName: this.diceBonus ? this.diceBonus.name : null,
      diceBonusTai: this.diceBonus ? this.diceBonus.tai : 0,
      diceBonusMult: this.diceBonus ? this.diceBonus.mult : 1,
      diceBonusTaiMult: this.diceBonus ? (this.diceBonus.taiMult || 1) : 1,
      eastSeat: (this.eastSeat != null) ? this.eastSeat : this.dealer,
      baseDi: this.baseDi, baseTai: this.baseTai,
      // 剛摸上來的牌（僅在該玩家要行動、且是真的摸牌而非吃碰時）
      drawnTile: (this.phase === 'act' && this.drawnTile) ? this.drawnTile : null,
      drawnBy: this.turn,
      seats: this.seats.map(s => ({
        seat: s.seat, name: s.name, isAI: s.isAI,
        handCount: s.hand.length, hand: s.hand,
        melds: s.melds, flowers: s.flowers, discards: s.discards, score: s.score,
        guoShui: s.guoShui, kuikaeForbidden: s.kuikaeForbidden || [],
      })),
    };
  }

  /** 針對某座位的視圖：只顯示自己的手牌；別人的暗槓遮蔽成牌背 */
  viewFor(seat) {
    const snap = this.snapshot();
    snap.you = seat;
    snap.seats = snap.seats.map(s => {
      if (s.seat === seat) return s;
      const { hand, ...rest } = s;
      const maskedMelds = (s.melds || []).map(m =>
        (m.type === 'kong' && m.concealed)
          ? { type: 'kong', concealed: true, hidden: true, tiles: [] }
          : m
      );
      return { ...rest, hand: null, melds: maskedMelds };
    });
    return snap;
  }
}

/** 種子亂數，讓同一局可重現（若日後需要） */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
