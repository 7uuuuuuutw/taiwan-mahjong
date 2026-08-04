/* ============================================================
 * game.js — 牌局狀態機（權威版，跑在 host）
 * 管理牌牆、回合、吃碰槓胡、結算。
 * 透過 emit(event, payload) 通知外層（UI / 網路）。
 * 依賴 mahjong.js、ai.js。
 *
 * © 2026 7u. All Rights Reserved. 詳見專案根目錄 LICENSE。
 * ============================================================ */

const CLAIM_TIMEOUT_MS = 15000; // 人類玩家反應（吃碰槓胡）逾時自動過水
const TURN_TIME_LIMIT_MS = 20000; // 出牌逾時自動隨機打一張
const WALL_RESERVE = 16; // 牌尾保留 16 張（8 墩）不摸，摸到剩保留區即流局；每開一槓保留區 +1
const HU_GRACE_MS = 9000; // 有人可胡但不提示時的無聲反應窗口（自行按「胡」鈕）
const DICE_SETTLE_MS = 1250; // 擲骰翻滾動畫定格時間，超過後才開始發牌演出
const AI_CLAIM_DELAY_MS = [650, 950]; // 真人打出的牌被電腦吃碰槓前的可見延遲區間
const PAUSE_POLL_MS = 500; // 斷線暫停期間，各計時型動作改用此間隔輪詢是否已恢復
const MEIHUA_MAX_ROUNDS = 3; // 換牌（美麻）最多換 3 輪

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
      guoShuiTile: null, // 過水當下放棄的那張胡牌（結算詐胡時要亮出來）
      guoShuiFrom: null, // 該牌是自摸（=自己座位）還是誰打出的
      meihuaReceived: [], // 換牌（美麻）剛收到的 3 張牌，UI 用來標示區隔；
                          // 打出下一張牌時清空（見 discard()）
      miji: false,        // 咪幾：早期宣告聽牌＋全程不吃碰槓，胡牌加 8 台
      mijiAllowed: null,  // 咪幾宣告當回合允許打出的牌（打出後鎖定，之後只能摸打）
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
    this.paused = false;    // 是否因玩家斷線而暫停
    this.pausedSeat = null; // 暫停中斷線的座位
    // 換牌（美麻）：預設關閉。meihuaTaiFloor 為 0 代表不限台，否則是「起胡
    // 門檻」——牌型台數要達到這個數字才能宣告胡牌，未達門檻視同詐胡，
    // 不是台數上限（曾經誤把「3台」實作成封頂，跟起胡門檻正好相反）。
    this.meihua = !!opts.meihua;
    this.meihuaTaiFloor = opts.meihuaTaiLimit || 0;
    this.meihuaTimer = null;
    this.meihuaDirection = null; // 'up'=傳上家／'down'=傳下家，全局固定
    this.meihuaRound = 0;        // 已完成幾輪換牌
    this.meihuaSelections = {};  // 這一輪，座位 → 選出要換掉的 3 張牌
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
    this.turnTimer = setTimeout(() => {
      if (this.dead) return;
      if (this.paused) { this.armTurnTimer(seat); return; } // 暫停中：重新倒數，等恢復
      this.autoDiscard(seat);
    }, this.turnLimitMs);
  }
  clearTurnTimer() {
    clearTimeout(this.turnTimer);
    this.turnTimer = null;
  }

  /** 斷線暫停：停掉所有計時器，記錄暫停者座位並通知外層彈出提示。
   *  進行中的 AI 動作／索取回應改採輪詢（見 aiSelfAct、openClaimWindow），
   *  暫停期間不會執行、恢復後會自動接續，不會遺失。 */
  pauseGame(seat) {
    // 'over'（結算畫面）不排除：結算畫面停留期間斷線一樣要暫停等對方
    // 回來，否則房主可能在對方沒發現的情況下按「下一局」，把斷線的人
    // 晾在原地。
    if (this.phase === 'idle' || this.paused) return;
    this.paused = true;
    this.pausedSeat = seat;
    if (this.seats[seat]) this.seats[seat].connected = false;
    clearTimeout(this.claimTimer);
    clearTimeout(this.meihuaTimer);
    this.clearTurnTimer();
    this.emit('gamePaused', { seat, name: this.seats[seat] ? this.seats[seat].name : '' });
  }

  /** 斷線者重連：解除暫停，並針對目前階段重新驅動（重送目前該行動的人
   *  的可行動作／重啟逾時計時），讓所有人（含剛重連的人）畫面立即跟上。 */
  resumeGame(seat) {
    // 保險：只有真正暫停中、且座位對得上目前記錄的暫停者才能恢復，避免
    // 呼叫端傳錯座位時誤把別人標成已連線、錯亂暫停狀態。
    if (!this.paused || seat !== this.pausedSeat) return;
    this.paused = false;
    this.pausedSeat = null;
    if (this.seats[seat]) this.seats[seat].connected = true;
    this.emit('gameResumed', { seat });
    if (this.phase === 'act') {
      const p = this.seats[this.turn];
      if (!p.isAI) {
        const actions = this.selfActions(this.turn, this.drawnTile);
        this.armTurnTimer(this.turn);
        this.emit('yourTurn', { seat: this.turn, tile: this.drawnTile, actions, timeLimit: this.turnLimitMs / 1000 });
      }
      // AI 回合的輪詢型 setTimeout 會自行偵測 paused 變 false 後接續，不需額外處理
    } else if (this.phase === 'claim' && this.claimWindow) {
      let anyVisibleHuman = false;
      for (const seatStr of Object.keys(this.claimWindow.eligible)) {
        const s = +seatStr;
        if (this.claimWindow.responses[s] !== undefined) continue; // 已回應過的不用重送
        const p2 = this.seats[s];
        if (p2.isAI) continue; // AI 的輪詢型 setTimeout 會自行接續
        const visible = { ...this.claimWindow.eligible[s] };
        delete visible.hu;
        if (Object.keys(visible).length > 0) {
          anyVisibleHuman = true;
          this.emit('claimOffer', { seat: s, tile: this.claimWindow.tile, from: this.claimWindow.from, options: visible });
        }
      }
      clearTimeout(this.claimTimer);
      this.claimTimer = setTimeout(() => this.forceResolveClaims(),
        anyVisibleHuman ? CLAIM_TIMEOUT_MS : HU_GRACE_MS);
    } else if (this.phase === 'meihua-select') {
      for (const p of this.seats) {
        if (p.isAI || this.meihuaSelections[p.seat]) continue; // AI 的輪詢型 setTimeout 會自行接續
        this.emit('meihuaSelectRequest', { seat: p.seat, timeLimit: this.turnLimitMs / 1000 });
      }
      this.armMeihuaTimer();
    } else if (this.phase === 'meihua-direction' && !this.seats[this.dealer].isAI) {
      this.emit('meihuaDirectionRequest', { seat: this.dealer });
    } else if (this.phase === 'meihua-continue' && !this.seats[this.dealer].isAI) {
      this.emit('meihuaContinueRequest', { seat: this.dealer });
    }
  }
  autoDiscard(seat) {
    if (this.phase !== 'act' || this.turn !== seat) return;
    const p = this.seats[seat];
    // 咪幾中逾時：宣告回合從允許清單挑、之後只能摸打，不能隨機挑
    if (p.miji) {
      if (p.mijiAllowed && p.mijiAllowed.length) return this.discard(seat, p.mijiAllowed[0]);
      if (this.drawnTile) return this.discard(seat, this.drawnTile);
    }
    const pool = p.hand.filter(t => !isFlower(t));
    if (pool.length === 0) return;
    // 逾時隨機打：跟其他打牌路徑一樣要避開吃碰限制的牌，不然隨機挑到剛好
    // 是禁打牌時，discard() 會直接拒絕、這次逾時等於完全沒打成，卡住不動
    // 也沒有重新倒數——真的所有牌都被擋住（極端情況）才退回整包隨機挑。
    const forbidden = p.kuikaeForbidden || [];
    const allowedPool = forbidden.length ? pool.filter(t => !forbidden.includes(t)) : pool;
    const finalPool = allowedPool.length ? allowedPool : pool;
    const tile = finalPool[Math.floor(Math.random() * finalPool.length)];
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
    for (const p of this.seats) {
      p.hand = []; p.melds = []; p.flowers = []; p.discards = [];
      p.guoShui = false; p.guoShuiTile = null; p.guoShuiFrom = null;
      p.meihuaReceived = [];
      p.miji = false; p.mijiAllowed = null;
    }
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

  /** 發牌動畫：各家自莊家起輪流每次抓 4 張（共 4 輪、每家 16 張），
   *  然後莊家「開門」多抓第 17 張，接著才自莊家起依序補花。
   *  純演出、由電腦自動進行，玩法不變。 */
  dealAndBegin() {
    const deck = shuffle(buildDeck(), () => this.rng());
    this.wall = deck;
    this.wallReserve = WALL_RESERVE; // 每局重設保留區（開槓會 +1）
    for (const p of this.seats) { p.hand = []; p.melds = []; p.flowers = []; p.discards = []; p.kuikaeForbidden = null; }
    this.flowerPool = new Set(); // 每局重設「七搶一」的全桌花牌進度追蹤
    this.phase = 'dealing';

    // 抓牌步驟：4 輪 × 4 家，每步抓 4 張
    const steps = [];
    for (let r = 0; r < 4; r++) {
      for (let k = 0; k < 4; k++) steps.push((this.dealer + k) % 4);
    }
    const dealStep = (i) => {
      if (this.dead) return;
      if (i >= steps.length) return this.dealerOpening();
      const seat = steps[i];
      const p = this.seats[seat];
      for (let j = 0; j < 4; j++) p.hand.push(this.drawFront());
      p.hand = sortTiles(p.hand);
      this.emitState(`${p.name} 抓牌（第 ${Math.floor(i / 4) + 1} 輪）`);
      setTimeout(() => dealStep(i + 1), 230);
    };
    dealStep(0);
  }

  /** 開門：四家抓滿 16 張後，莊家多抓第 17 張，之後才開始依序補花 */
  dealerOpening() {
    if (this.dead) return;
    const dealerP = this.seats[this.dealer];
    dealerP.hand.push(this.drawFront());
    dealerP.hand = sortTiles(dealerP.hand);
    this.emitState(`${dealerP.name} 開門`);
    setTimeout(() => this.flowerPhase(0), 700);
  }

  /** 補花演出：自莊家起依序補花，補到花的多停一下 */
  flowerPhase(k) {
    if (this.dead || this.phase === 'over') return; // 七搶一可能在補花途中就把本局結束了
    if (k >= 4) {
      this.turn = this.dealer;
      this.lastDiscard = null;
      this.winner = null;
      this.emitState('開始新局');
      // 換牌（美麻）：補完花、莊家打第一張牌之前，全桌先換牌
      if (this.meihua) this.startMeihua();
      else this.beginDealerAct(); // 莊家開門時已拿第 17 張，直接行動、不再摸牌
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

  /* -------- 換牌（美麻）：補花後、莊家打第一張牌前，全桌先換牌 --------
   * 流程：莊家先選方向（傳上家／傳下家，全局固定不能中途改）→ 第 1 輪
   * 換牌一定會進行（全桌同時各選 3 張換出去）→ 換完問莊家要不要再換一輪
   * （最多到第 3 輪，莊家選「不換」或到達第 3 輪就結束）→ 進入正常開局。 */

  /** 開始換牌：先讓莊家選方向。 */
  startMeihua() {
    this.phase = 'meihua-direction';
    this.meihuaDirection = null;
    this.meihuaRound = 0;
    const dealerP = this.seats[this.dealer];
    this.emitState(`等待莊家 ${dealerP.name} 決定換牌方向`);
    if (dealerP.isAI) {
      setTimeout(() => {
        if (this.dead || this.phase !== 'meihua-direction') return;
        if (this.paused) return; // resumeGame 會依 phase 重新驅動，這裡直接放棄這次排程
        this.chooseMeihuaDirection(this.dealer, Math.random() < 0.5 ? 'up' : 'down');
      }, 900);
    } else {
      this.emit('meihuaDirectionRequest', { seat: this.dealer });
    }
  }

  /** 莊家決定換牌方向：'up'＝傳上家、'down'＝傳下家，全局只問這一次。 */
  chooseMeihuaDirection(seat, direction) {
    if (this.phase !== 'meihua-direction' || seat !== this.dealer) return;
    this.meihuaDirection = (direction === 'up') ? 'up' : 'down';
    this.emitState(`${this.seats[this.dealer].name} 決定換牌：${this.meihuaDirection === 'up' ? '傳上家' : '傳下家'}`);
    this.startMeihuaSelectRound();
  }

  /** 開始一輪換牌選牌：全桌同時各選 3 張要換出去的牌。 */
  startMeihuaSelectRound() {
    this.phase = 'meihua-select';
    this.meihuaSelections = {};
    this.emitState(`換牌第 ${this.meihuaRound + 1} 輪：請選出 3 張要換的牌`);
    for (const p of this.seats) {
      if (p.isAI) {
        const tiles = aiChooseMeihuaTiles(p.hand, p.melds);
        const seat = p.seat;
        setTimeout(() => {
          if (this.dead || this.phase !== 'meihua-select') return;
          if (this.paused) return; // resumeGame 會依 phase 重新驅動，這裡直接放棄這次排程
          this.submitMeihuaSelection(seat, tiles);
        }, 500 + Math.random() * 500);
      } else {
        this.emit('meihuaSelectRequest', { seat: p.seat, timeLimit: this.turnLimitMs / 1000 });
      }
    }
    this.armMeihuaTimer();
  }

  /** 換牌選牌逾時：真人還沒選的，自動隨機選 3 張（電腦一定準時送出，不會逾時）。 */
  armMeihuaTimer() {
    clearTimeout(this.meihuaTimer);
    if (!this.turnLimitMs) return; // 不計時
    this.meihuaTimer = setTimeout(() => {
      if (this.dead || this.phase !== 'meihua-select') return;
      if (this.paused) { this.armMeihuaTimer(); return; } // 暫停中：重新倒數，等恢復
      for (const p of this.seats) {
        if (this.meihuaSelections[p.seat]) continue;
        const pick = p.hand.filter(t => !isFlower(t));
        const tiles = [];
        for (let i = 0; i < 3 && pick.length; i++) {
          tiles.push(pick.splice(Math.floor(this.rng() * pick.length), 1)[0]);
        }
        this.meihuaSelections[p.seat] = tiles;
      }
      this.resolveMeihuaRound();
    }, this.turnLimitMs);
  }

  /** 玩家提交這輪要換出去的 3 張牌；四家都送出後立即結算，不用等逾時。 */
  submitMeihuaSelection(seat, tiles) {
    if (this.phase !== 'meihua-select' || this.meihuaSelections[seat]) return;
    const p = this.seats[seat];
    if (!Array.isArray(tiles) || tiles.length !== 3) return;
    // 驗證這 3 張真的都在手上（各自扣一張，避免同一張牌被拿來湊兩次）
    const check = p.hand.slice();
    for (const t of tiles) {
      const idx = check.indexOf(t);
      if (idx < 0) return; // 有牌不存在/數量對不上，整個提交無效
      check.splice(idx, 1);
    }
    this.meihuaSelections[seat] = tiles;
    if (Object.keys(this.meihuaSelections).length === 4) {
      clearTimeout(this.meihuaTimer);
      this.resolveMeihuaRound();
    }
  }

  /** 結算這一輪換牌：依方向把每家選出的 3 張轉給對應座位，加進對方手牌。 */
  resolveMeihuaRound() {
    const dir = this.meihuaDirection;
    const given = this.meihuaSelections;
    // 先把每家選出的 3 張從手上移除（全部移除完再發，避免先發先扣互相干擾）
    for (const p of this.seats) {
      for (const t of (given[p.seat] || [])) {
        const idx = p.hand.indexOf(t);
        if (idx >= 0) p.hand.splice(idx, 1);
      }
    }
    for (const p of this.seats) {
      // 傳下家：自己收到「上家」傳來的；傳上家則反過來收到「下家」傳來的
      const fromSeat = dir === 'down' ? (p.seat + 3) % 4 : (p.seat + 1) % 4;
      const received = given[fromSeat] || [];
      p.hand.push(...received);
      p.hand = sortTiles(p.hand);
      p.meihuaReceived = received.slice(); // UI 標示用；下次打牌時清空
    }
    this.meihuaRound++;
    this.emitState(`換牌第 ${this.meihuaRound} 輪完成`);
    if (this.meihuaRound >= MEIHUA_MAX_ROUNDS) this.finishMeihua();
    else this.startMeihuaContinuePrompt();
  }

  /** 問莊家要不要再換一輪（第 1 輪一定會換，第 2、3 輪才需要莊家決定）。 */
  startMeihuaContinuePrompt() {
    this.phase = 'meihua-continue';
    const dealerP = this.seats[this.dealer];
    this.emitState(`等待莊家 ${dealerP.name} 決定是否再換一輪`);
    if (dealerP.isAI) {
      setTimeout(() => {
        if (this.dead || this.phase !== 'meihua-continue') return;
        if (this.paused) return;
        // 簡單策略：向聽數還很差就繼續換，牌已經不錯就見好就收
        const hand = dealerP.hand.filter(t => !isFlower(t));
        const swap = estimateShanten(hand, dealerP.melds) > 2;
        this.decideMeihuaContinue(this.dealer, swap);
      }, 900);
    } else {
      this.emit('meihuaContinueRequest', { seat: this.dealer });
    }
  }

  /** 莊家決定是否再換一輪。 */
  decideMeihuaContinue(seat, swap) {
    if (this.phase !== 'meihua-continue' || seat !== this.dealer) return;
    if (swap) this.startMeihuaSelectRound();
    else this.finishMeihua();
  }

  /** 換牌流程結束，進入正常開局（莊家打第一張牌）。 */
  finishMeihua() {
    clearTimeout(this.meihuaTimer);
    this.beginDealerAct();
  }

  /** 開局莊家行動：開門時已拿了第 17 張（補花也已在 flowerPhase 處理過），
   *  不再摸牌，直接進入打牌/自摸/暗槓的行動階段 */
  beginDealerAct() {
    const p = this.seats[this.dealer];
    this.drawnTile = null; // 第17張經補花/理牌後已無從分辨，不特別標示
    this.phase = 'act';
    this.blockTsumoThisDraw = false;
    const actions = this.selfActions(this.dealer, null);
    this.tsumoAvailable = actions.tsumo;
    if (p.isAI) {
      this.aiSelfAct(this.dealer, null, actions);
    } else {
      this.armTurnTimer(this.dealer);
      this.emit('yourTurn', { seat: this.dealer, tile: null, actions, timeLimit: this.turnLimitMs / 1000 });
    }
  }

  /* -------- 摸牌階段 -------- */
  doDrawPhase() {
    if (this.drawableCount() <= 0) return this.drawnGame();
    const seat = this.turn;
    this.drawWithFlowerPause(seat, this.drawFront(), (tile) => {
      const p = this.seats[seat];
      p.hand.push(tile);
      p.hand = sortTiles(p.hand);
      this.drawnTile = tile;
      this.phase = 'act'; // 該玩家要行動（打牌/自摸/暗槓/加槓）
      this.blockTsumoThisDraw = false; // 一般摸牌不受明槓限制

      const actions = this.selfActions(seat, tile);
      this.tsumoAvailable = actions.tsumo; // 供過水判斷（棄自摸）
      this.emitState(`${p.name} 摸牌`);
      if (p.isAI) {
        this.aiSelfAct(seat, tile, actions);
      } else {
        this.armTurnTimer(seat);
        this.emit('yourTurn', { seat, tile, actions, timeLimit: this.turnLimitMs / 1000 });
      }
    });
  }

  /** 摸牌可能連續摸到好幾張花：每摸到一張花，先停頓一下（跟開局補花演出
   *  用一樣的間隔）讓玩家真的看得到自己摸到花了（畫面上會先顯示在花牌
   *  區），才從牌尾補一張繼續摸，直到摸到非花才呼叫 onSettled(tile) 接續
   *  原本該做的事（一般摸牌或槓後補牌，各自進入行動階段的細節不同，交給
   *  呼叫端處理）。tile 是呼叫端已經摸好的第一張（一般摸牌從牌頭摸、
   *  槓後補牌從牌尾摸，起手這張怎麼摸不一樣，之後補花一律從牌尾摸）。 */
  drawWithFlowerPause(seat, tile, onSettled) {
    if (this.dead || this.phase === 'over') return;
    const p = this.seats[seat];
    if (!isFlower(tile)) return onSettled(tile);
    if (this.trackFlowerDraw(seat, tile)) return; // 七搶一觸發，本局已結束
    p.flowers.push(tile);
    p.flowers.sort((a, b) => tileOrder(a) - tileOrder(b));
    this.lastDrawWasKong = true; // 補花後再胡 = 槓上開花性質（花槓上）
    this.emitState(`${p.name} 補花`);
    if (this.drawableCount() <= 0) { this.drawnGame(); return; }
    const drawNext = () => {
      if (this.dead || this.phase === 'over') return;
      if (this.paused) { setTimeout(drawNext, PAUSE_POLL_MS); return; } // 暫停中：等恢復再繼續補
      this.drawWithFlowerPause(seat, this.drawBack(), onSettled);
    };
    setTimeout(drawNext, 650);
  }

  /** 計算摸牌後自己可做的動作 */
  selfActions(seat, tile) {
    const p = this.seats[seat];
    const a = { discard: true, tsumo: false, concealedKongs: [], addKongs: [] };
    // 自摸（過水中、或明槓補牌時不得自摸；換牌限台開啟時還要達到起胡門檻）
    if (!p.guoShui && !this.blockTsumoThisDraw && isWinningHand(p.hand, p.melds, this.winOpts) &&
        this.meetsMeihuaTaiFloor(seat, tile || p.hand[p.hand.length - 1], true, null)) a.tsumo = true;
    // 咪幾宣告後不得再開任何槓（暗槓也算破壞資格，宣告後乾脆完全不提供）
    if (!p.miji) {
      // 暗槓
      a.concealedKongs = findConcealedKongs(p.hand);
      // 加槓（手上有牌與已碰的刻子相同）
      for (const m of p.melds) {
        if (m.type === 'pong' && p.hand.includes(m.tiles[0])) a.addKongs.push(m.tiles[0]);
      }
    }
    // 咪幾宣告資格（見 mijiEligible）：資格成立時給 UI 顯示宣告按鈕
    if (this.mijiEligible(seat)) a.miji = true;
    return a;
  }

  /** 咪幾宣告資格：「全桌任何人」都從未吃碰槓（含暗槓——不只自己，任何
   *  一家有面子就整桌都不能再咪幾）、還沒宣告過、全桌棄牌總數 ≤ 8（大約
   *  各家打兩張內的早期）、且手上 17 張中存在「打出某張後剩 16 張聽牌」
   *  的打法。 */
  mijiEligible(seat) {
    const p = this.seats[seat];
    if (p.miji) return false;
    if (this.seats.some(s => s.melds.length > 0)) return false;
    const totalDiscards = this.seats.reduce((n, s) => n + s.discards.length, 0);
    if (totalDiscards > 8) return false;
    return this.mijiTenpaiDiscards(seat).length > 0;
  }

  /** 咪幾用：手上（含剛摸的第 17 張）打出哪些牌後，剩下 16 張是聽牌。 */
  mijiTenpaiDiscards(seat) {
    const p = this.seats[seat];
    const hand = p.hand.filter(t => !isFlower(t));
    const needMelds = 5 - p.melds.length;
    if (hand.length !== needMelds * 3 + 2) return []; // 必須是「摸完待打」的張數
    const result = [];
    for (const t of new Set(hand)) {
      const rest = hand.slice();
      rest.splice(rest.indexOf(t), 1);
      if (getTingTiles(rest, p.melds, this.winOpts).length > 0) result.push(t);
    }
    return result;
  }

  /** 宣告咪幾：鎖定手牌（這回合只能打「打完仍聽牌」的牌，之後只能摸打），
   *  廣播事件讓所有人看到澎湃動畫。可以多家先後宣告，互不影響。 */
  declareMiji(seat) {
    if (this.phase !== 'act' || this.turn !== seat) return;
    if (!this.mijiEligible(seat)) return;
    const p = this.seats[seat];
    p.miji = true;
    p.mijiAllowed = this.mijiTenpaiDiscards(seat);
    this.emit('mijiDeclared', { seat, name: p.name });
    this.emitState(`${p.name} 咪幾！`);
    // 宣告後仍要打出這回合的牌：真人重新送一次可行動作（槓已被 miji 擋
    // 掉），AI 直接從允許清單挑一張打
    if (p.isAI) {
      const pick = p.mijiAllowed.includes(this.drawnTile) ? this.drawnTile : p.mijiAllowed[0];
      setTimeout(() => {
        if (this.dead || this.phase !== 'act' || this.turn !== seat) return;
        this.discard(seat, pick);
      }, 800);
    } else {
      const actions = this.selfActions(seat, this.drawnTile);
      this.armTurnTimer(seat);
      this.emit('yourTurn', { seat, tile: this.drawnTile, actions, timeLimit: this.turnLimitMs / 1000 });
    }
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
    // 換牌（美麻）三個動作
    if (action.type === 'meihuaDirection') return this.chooseMeihuaDirection(seat, action.direction);
    if (action.type === 'meihuaSelect') return this.submitMeihuaSelection(seat, action.tiles);
    if (action.type === 'meihuaContinue') return this.decideMeihuaContinue(seat, !!action.swap);
    // 咪幾宣告
    if (action.type === 'declareMiji') return this.declareMiji(seat);

    if (this.phase === 'act' && seat === this.turn) {
      this.clearTurnTimer();
      if (action.type === 'discard') return this.discard(seat, action.tile);
      if (action.type === 'tsumo') return this.declareWin(seat, this.drawnTile, true);
      // 咪幾中不得開任何槓（暗槓也算破壞資格）
      if (action.type === 'concealedKong' && !this.seats[seat].miji) return this.doConcealedKong(seat, action.tile);
      if (action.type === 'addKong' && !this.seats[seat].miji) return this.doAddKong(seat, action.tile);
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
    // 吃碰限制：剛吃/碰完，這張是不能打的——但如果手上「所有牌」都被這個
    // 限制擋住（例如吃完面子後只剩兩張一樣的孤張，剛好都是限制牌），玩家
    // 會無牌可打、遊戲卡死不動。這種極端情況下限制讓步、允許照打，總比
    // 卡住整桌不能繼續好；正常情況（手上還有其他能打的牌）限制照樣生效。
    if (p.kuikaeForbidden && p.kuikaeForbidden.includes(tile) &&
        p.hand.some(t => !p.kuikaeForbidden.includes(t))) {
      this.emitState(`${p.name} 剛吃／碰，這張不能打`);
      return;
    }
    // 咪幾鎖定：宣告當回合只能打「打完仍聽牌」的牌（mijiAllowed 清單）；
    // 該回合打完後 mijiAllowed 清空，之後每回合只能摸打（打剛摸到的那張）
    if (p.miji) {
      if (p.mijiAllowed) {
        if (!p.mijiAllowed.includes(tile)) { this.emitState(`${p.name} 咪幾中，這張打出去就不聽了`); return; }
        p.mijiAllowed = null; // 宣告回合的打牌完成，之後進入「只能摸打」狀態
      } else if (this.drawnTile && tile !== this.drawnTile) {
        this.emitState(`${p.name} 咪幾中，只能打剛摸到的牌`);
        return;
      }
    }
    // 過水規則：
    //  - 這次打牌若是「放棄自摸」→ 進入過水（打出一張牌前不得再胡）
    //  - 否則，打出一張牌即解除過水
    const decliningTsumo = (this.turn === seat && this.tsumoAvailable);
    if (decliningTsumo) {
      p.guoShui = true;
      p.guoShuiTile = this.drawnTile; // 放棄自摸的那張（自己摸到的牌）
      p.guoShuiFrom = seat;
    } else if (p.guoShui) {
      p.guoShui = false;
      p.guoShuiTile = null;
      p.guoShuiFrom = null;
    }
    this.tsumoAvailable = false;
    p.kuikaeForbidden = null;
    p.meihuaReceived = []; // 換牌收到的牌只標示到「下一次打牌前」，這裡清空

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
    this.afterKongDraw(seat, false); // 加槓：補牌仍可自摸（槓上開花）
  }

  /** @param fromDiscard 這一槓是不是直接槓別人打出的牌（大明槓）——只有
   *  這種才擋自摸；暗槓與加槓（不論是不是搶槓視窗後才完成）補牌都仍可
   *  合法自摸（槓上開花）。大明槓用的是別人的棄牌湊成槓，補牌完成手牌
   *  不算自己摸胡，所以不能自摸。 */
  afterKongDraw(seat, fromDiscard) {
    // 每開一槓，牌尾保留區 +1（海底往前移一張）
    this.wallReserve += 1;
    // 槓後從牌尾補摸一張
    if (this.drawableCount() <= 0) return this.drawnGame();
    this.drawWithFlowerPause(seat, this.drawBack(), (tile) => {
      const p = this.seats[seat];
      p.hand.push(tile);
      p.hand = sortTiles(p.hand);
      this.drawnTile = tile;
      this.lastDrawWasKong = true;
      this.turn = seat;
      this.phase = 'act';
      // 槓上開花：暗槓／加槓補牌可以自摸；大明槓是用別人的棄牌湊成槓，
      // 補牌完成手牌不算自己摸胡，不能自摸
      this.blockTsumoThisDraw = !!fromDiscard;
      const actions = this.selfActions(seat, tile);
      if (fromDiscard) actions.tsumo = false; // 保險：即使 selfActions 算出能胡也不讓 AI 自動宣告
      this.tsumoAvailable = actions.tsumo;
      this.emitState(`${p.name} 槓`);
      if (p.isAI) this.aiSelfAct(seat, tile, actions);
      else { this.armTurnTimer(seat); this.emit('yourTurn', { seat, tile, actions, kong: true, timeLimit: this.turnLimitMs / 1000 }); }
    });
  }

  /* -------- 開啟索取視窗（吃碰槓胡）-------- */
  openClaimWindow(tile, from, robbing = false, addKongMeld = null) {
    const eligible = {};
    for (let k = 1; k < 4; k++) {
      const seat = (from + k) % 4;
      const p = this.seats[seat];
      const ent = {};
      // 胡（放槍 / 搶槓）；過水中不得胡；換牌限台開啟時還要達到起胡門檻
      if (!p.guoShui && isWinningHand(p.hand.concat([tile]), p.melds, this.winOpts) &&
          this.meetsMeihuaTaiFloor(seat, tile, false, from)) ent.hu = true;
      // 咪幾中不得吃碰槓（只剩胡的資格）
      if (!robbing && !p.miji) {
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
        return this.afterKongDraw(from, false); // 加槓：補牌仍可自摸（槓上開花）
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
          {
            style: p.aiStyle,
            seatDiscards: this.seats.map(s => s.discards),
            // 同上：自己的面子已經由 cleanHand/melds 直接算過，這裡只補別人的
            allMelds: this.seats.map((s, i) => i === seat ? [] : s.melds.filter(m => !(m.type === 'kong' && m.concealed))),
          }, this.aiLevel);
        const [lo, hi] = AI_CLAIM_DELAY_MS;
        const delay = lo + Math.random() * (hi - lo);
        const run = () => {
          if (this.dead) return;
          if (this.paused) { setTimeout(run, PAUSE_POLL_MS); return; } // 暫停中：等恢復再送出反應
          this.submitClaim(seat, decision);
        };
        setTimeout(run, delay);
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
        this.seats[s].guoShuiTile = tile; // 放棄的那張（別家打出的牌）
        this.seats[s].guoShuiFrom = from;
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
      return this.afterKongDraw(from, false); // 加槓：補牌仍可自摸（槓上開花）
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
        return this.afterKongDraw(seat, true); // 大明槓：用別人的棄牌湊成槓，補牌不能自摸
      } else {
        for (let i = 0; i < 2; i++) p.hand.splice(p.hand.indexOf(tile), 1);
        p.melds.push({ type: 'pong', tiles: [tile, tile, tile], from });
        p.hand = sortTiles(p.hand);
        this.turn = seat;
        this.phase = 'act';
        this.drawnTile = null;
        // 碰完不能立刻打出剛碰的那張牌（吃碰限制）
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
      // 吃完不能立刻打出會讓這口吃變得「白吃」的牌（吃碰限制）
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

  /** 吃完後不可立即打出的牌（吃碰限制）：
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
    const run = () => {
      if (this.dead) return;
      if (this.paused) { setTimeout(run, PAUSE_POLL_MS); return; } // 暫停中：等恢復再接續
      if (this.phase !== 'act' || this.turn !== seat) return;
      if (actions.tsumo) return this.declareWin(seat, this.drawnTile, true);
      // 咪幾中：只能摸打（打剛摸到的那張），沒有其他選擇
      if (p.miji && !p.mijiAllowed && this.drawnTile) {
        return this.discard(seat, this.drawnTile);
      }
      // 咪幾宣告資格：電腦一律宣告（8 台加成價值遠大於失去換牌彈性）
      if (actions.miji) return this.declareMiji(seat);
      // 暗槓（有就槓，簡單策略）
      if (actions.concealedKongs && actions.concealedKongs.length) {
        return this.doConcealedKong(seat, actions.concealedKongs[0]);
      }
      if (actions.addKongs && actions.addKongs.length) {
        return this.doAddKong(seat, actions.addKongs[0]);
      }
      const ctx = {
        mySeat: seat,
        seatDiscards: this.seats.map(s => s.discards),
        // 自己的面子已經透過 aiChooseDiscard 的 melds 參數算過一次，這裡
        // 只補「別人的」面子，不然自己面子的牌會被算兩次，導致
        // visibleCounts 誤判成「看到的比實際多」，剩餘張數反而低估。
        // 別家暗槓看不到牌面，也不算進「已知看得到」的統計。
        allMelds: this.seats.map((s, i) => i === seat ? [] : s.melds.filter(m => !(m.type === 'kong' && m.concealed))),
        // 防守用的聽牌危險度：只給「別人」的面子數／花數（自己不算風險）
        dangerInfo: this.seats.map((s, i) => i === seat ? null : { meldCount: s.melds.length, flowerCount: s.flowers.length }),
        style: p.aiStyle, kuikaeForbidden: p.kuikaeForbidden || [],
      };
      let discardTile = aiChooseDiscard(p.hand, p.melds, this.aiLevel, ctx);
      // 安全網：萬一還是選到剛吃/碰不能打的牌，改打手上第一張允許的牌，避免卡住不出牌
      if (p.kuikaeForbidden && p.kuikaeForbidden.includes(discardTile)) {
        const allowed = p.hand.find(t => !p.kuikaeForbidden.includes(t));
        if (allowed) discardTile = allowed;
      }
      this.discard(seat, discardTile);
    };
    setTimeout(run, 1000); // 電腦間隔一秒出牌
  }

  /* -------- 胡牌結算 -------- */

  /** 建立 scoreHand() 需要的 ctx——computeWin() 跟「換牌限台門檻」的預先
   *  試算（meetsMeihuaTaiFloor）共用，避免兩處各寫一份、算法不一致。
   *  自摸時 winTile 已經在 p.hand 裡，要先扣掉才是正確的「胡牌前手牌」。 */
  buildScoreCtx(seat, winTile, selfDraw, loser) {
    const p = this.seats[seat];
    const handMinus = p.hand.slice();
    if (selfDraw) handMinus.splice(handMinus.indexOf(winTile), 1);
    const concealedWin = p.melds.every(m => m.concealed); // 無吃碰明槓
    const east = (this.eastSeat != null) ? this.eastSeat : this.dealer;
    return {
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
      miji: p.miji, // 咪幾：胡牌加 8 台（不與門清重複計算，見 scoreHand）
      diceBonus: this.diceBonus,
      allowLiGu: this.rules.ligu,
    };
  }

  /** 換牌（美麻）限台：這張牌胡下去，「純牌型」台數有沒有達到起胡門檻
   *  （例如「3台」＝至少 3 台才能宣告胡牌，未達門檻的話這張牌就不算能
   *  胡，跟牌型沒成一樣要當詐胡處理）。沒開限台（meihuaTaiFloor 為 0）
   *  一律通過。
   *  門檻「不計入骰子、也不計入莊家」：scoreHand() 本身就會把骰運
   *  （全紅/骰歸等）跟莊家/連莊台直接算進 score.total（分別是運氣加成
   *  跟身分加成，不是牌型本身的價值），這裡刻意把 ctx 的 dealerInvolved
   *  /isDealer/dealerStreak/diceBonus 都清空重算一次「純牌型」台數，
   *  真正結算用的 computeWin() 完全不受影響，兩邊各自獨立計算，不會
   *  互相污染。八仙過海這種固定台數的特殊胡法不受此限。 */
  meetsMeihuaTaiFloor(seat, winTile, selfDraw, loser) {
    if (!this.meihuaTaiFloor) return true;
    const ctx = this.buildScoreCtx(seat, winTile, selfDraw, loser);
    const pureCtx = { ...ctx, dealerInvolved: false, isDealer: false, dealerStreak: 0, diceBonus: null };
    const score = scoreHand(pureCtx);
    return score.baXian || score.total >= this.meihuaTaiFloor;
  }

  /** 計算某家的胡牌台數並結算籌碼（單胡/多胡共用） */
  computeWin(seat, winTile, selfDraw, loser) {
    const ctx = this.buildScoreCtx(seat, winTile, selfDraw, loser);
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
      // ctx.hand 已經是「扣掉胡牌張後的手牌」（selfDraw 時 buildScoreCtx
      // 就扣過了），非自摸時本來就沒加進手牌，兩種情況這裡都不用再扣一次
      hand: selfDraw ? ctx.hand : this.seats[seat].hand.slice(), // 亮牌用（不含胡牌張）
      melds: ctx.melds, flowers: ctx.flowers,
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
   * 付給莊家時再加莊家/連莊台（更包含莊家）。詐胡後換下一家坐莊。
   * @param misTile 誤以為靠這張牌成牌——自摸誤按是剛摸到的那張（已經在
   *   手牌裡），索取階段誤按是別家剛打出、還沒進手牌的那張；呼叫端要在
   *   呼叫這個函式「之前」就把值準備好傳進來，因為函式內部一開始就會把
   *   this.claimWindow／this.drawnTile 都清空。 */
  falseHu(seat, misTile) {
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
    // 若是過水中仍宣告胡（牌其實已經成了，只是被過水擋下）而非真的沒成牌，
    // 把當初放棄的那張牌／來源一併附上，讓大家能核對這次詐胡是怎麼回事。
    const guoShuiInfo = p.guoShui ? { tile: p.guoShuiTile, from: p.guoShuiFrom } : null;
    this.emit('handOver', {
      result: 'falseHu', offender: seat, estTai, payments, guoShui: guoShuiInfo,
      // 亮出詐胡者的牌，讓大家能確認他牌真的沒成；misTile 額外標出他
      // 誤以為靠哪張牌成牌（可能為 null，例如過水詐胡不是靠算錯牌型）
      hand: p.hand.slice(), melds: p.melds, flowers: p.flowers, misTile: misTile || null,
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
      const winTile = this.drawnTile || p.hand[p.hand.length - 1];
      // 換牌限台開啟時，牌型沒達到起胡門檻就當作沒成牌（詐胡），跟牌型
      // 真的沒湊成一樣處理
      if (isWinningHand(p.hand, p.melds, this.winOpts) && this.meetsMeihuaTaiFloor(seat, winTile, true, null)) {
        // 大明槓（吃別人棄牌湊成的槓）補的牌不能自摸；暗槓與加槓都可以
        if (this.blockTsumoThisDraw) { this.emitState(`${p.name} 明槓補牌，此張不能自摸`); return; }
        // 過水中不提示、不攔下——刻意讓玩家自己記得，仍宣告就當詐胡處理
        if (p.guoShui) return this.falseHu(seat, this.drawnTile);
        this.clearTurnTimer();
        return this.declareWin(seat, winTile, true);
      }
      // 自摸誤按：他以為靠剛摸到的這張成牌，實際上沒有（或牌型有成，但
      // 換牌限台開啟時沒達到門檻，一樣視為詐胡）
      return this.falseHu(seat, winTile);
    }
    // 索取階段（別人打牌）：這才是真正「面對一張牌決定要不要胡」的時刻
    if (this.phase === 'claim' && this.claimWindow) {
      const ent = this.claimWindow.eligible[seat];
      if (ent && ent.hu) return this.submitClaim(seat, { action: 'hu' });
      // ent.hu 在過水中本來就不會被標記（見 openClaimWindow），跟真的沒
      // 成牌一樣直接視為詐胡，不額外提示「過水中不能胡」
      // 索取誤按：他以為靠這張別人剛打出的牌成牌，實際上沒有
      return this.falseHu(seat, this.claimWindow.tile);
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
        guoShui: s.guoShui, kuikaeForbidden: s.kuikaeForbidden || [], connected: s.connected,
        meihuaReceived: s.meihuaReceived || [],
        // 咪幾狀態是公開資訊（大家都看得到誰咪幾了）；mijiAllowed（宣告
        // 回合允許打的牌）只跟自己有關，viewFor 會對別人遮掉
        miji: s.miji, mijiAllowed: s.mijiAllowed || null,
      })),
      paused: this.paused, pausedSeat: this.pausedSeat,
    };
  }

  /** 針對某座位的視圖：只顯示自己的手牌；別人的暗槓遮蔽成牌背 */
  viewFor(seat) {
    const snap = this.snapshot();
    snap.you = seat;
    snap.seats = snap.seats.map(s => {
      if (s.seat === seat) return s;
      const { hand, meihuaReceived, mijiAllowed, ...rest } = s;
      const maskedMelds = (s.melds || []).map(m =>
        (m.type === 'kong' && m.concealed)
          ? { type: 'kong', concealed: true, hidden: true, tiles: [] }
          : m
      );
      return { ...rest, hand: null, melds: maskedMelds, meihuaReceived: [], mijiAllowed: null };
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
