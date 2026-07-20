/* ============================================================
 * mahjong.js — 台灣 16 張麻將 規則引擎
 * 牌組 / 發牌 / 胡牌判斷 / 聽牌 / 台數計算
 * 純函式，不依賴 DOM 或網路，host 與 client 共用。
 * ============================================================ */

/* ---------- 牌的表示法 ----------
 * 每張牌用字串表示：
 *   m1..m9  萬 (characters)
 *   p1..p9  筒 (dots)
 *   s1..s9  條 (bamboo)
 *   z1..z7  字牌: 1東 2南 3西 4北 5中 6發 7白
 *   f1..f8  花牌: 1春 2夏 3秋 4冬 5梅 6蘭 7竹 8菊
 */

const SUITS = ['m', 'p', 's'];
const HONOR_NAMES = ['東', '南', '西', '北', '中', '發', '白'];
const FLOWER_NAMES = ['春', '夏', '秋', '冬', '梅', '蘭', '竹', '菊'];
const SUIT_NAMES = { m: '萬', p: '筒', s: '條' };
const WINDS = ['東', '南', '西', '北']; // 座位風 / 圈風順序

/** 建立一副完整 144 張牌 */
function buildDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (let n = 1; n <= 9; n++) {
      for (let i = 0; i < 4; i++) deck.push(s + n);
    }
  }
  for (let n = 1; n <= 7; n++) {
    for (let i = 0; i < 4; i++) deck.push('z' + n);
  }
  for (let n = 1; n <= 8; n++) deck.push('f' + n); // 花牌各一張
  return deck;
}

/** Fisher–Yates 洗牌（可帶入亂數函式，方便同步） */
function shuffle(deck, rng = Math.random) {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 是否為花牌 */
function isFlower(t) { return t[0] === 'f'; }
/** 是否為字牌 */
function isHonor(t) { return t[0] === 'z'; }
/** 是否為序數牌（可組順子） */
function isSuited(t) { return SUITS.includes(t[0]); }

/** 中文牌面 */
function tileName(t) {
  if (!t) return '';
  const k = t[0];
  const n = parseInt(t.slice(1), 10);
  if (k === 'z') return HONOR_NAMES[n - 1];
  if (k === 'f') return FLOWER_NAMES[n - 1];
  return n + SUIT_NAMES[k];
}

/** 排序用權重 */
function tileOrder(t) {
  const orderKey = { m: 0, p: 1, s: 2, z: 3, f: 4 };
  return orderKey[t[0]] * 100 + parseInt(t.slice(1), 10);
}

/** 排序一手牌 */
function sortTiles(tiles) {
  return tiles.slice().sort((a, b) => tileOrder(a) - tileOrder(b));
}

/* ---------- 計數工具 ---------- */

/** 將牌陣列轉成 {tile: count} */
function toCounts(tiles) {
  const c = {};
  for (const t of tiles) c[t] = (c[t] || 0) + 1;
  return c;
}

/** 從陣列各移除一張指定牌；缺任一張則回傳 null */
function removeTilesOnce(arr, tiles) {
  const out = arr.slice();
  for (const t of tiles) {
    const i = out.indexOf(t);
    if (i < 0) return null;
    out.splice(i, 1);
  }
  return out;
}

/** counts 轉回排序後的牌陣列 */
function countsToTiles(counts) {
  const out = [];
  for (const t in counts) for (let i = 0; i < counts[t]; i++) out.push(t);
  return sortTiles(out);
}

/* ============================================================
 * 胡牌判斷
 * 手牌（暗牌）+ 已亮出的面子(melds) 必須組成 5 面子 + 1 對
 * 傳入的 tiles 為「暗牌含胡的那張」，需為 3k+2 張
 * ============================================================ */

/** 能否把 counts（3n 張）全部拆成面子（刻子或順子） */
function canFormAllMelds(counts) {
  const keys = Object.keys(counts).filter(t => counts[t] > 0);
  if (keys.length === 0) return true;
  // 取權重最小的一張牌
  keys.sort((a, b) => tileOrder(a) - tileOrder(b));
  const t = keys[0];

  // 試刻子
  if (counts[t] >= 3) {
    counts[t] -= 3;
    if (canFormAllMelds(counts)) { counts[t] += 3; return true; }
    counts[t] += 3;
  }
  // 試順子（僅序數牌，且不跨花色/邊界）
  if (isSuited(t)) {
    const suit = t[0];
    const n = parseInt(t.slice(1), 10);
    if (n <= 7) {
      const t1 = suit + (n + 1), t2 = suit + (n + 2);
      if (counts[t1] > 0 && counts[t2] > 0) {
        counts[t] -= 1; counts[t1] -= 1; counts[t2] -= 1;
        if (canFormAllMelds(counts)) { counts[t] += 1; counts[t1] += 1; counts[t2] += 1; return true; }
        counts[t] += 1; counts[t1] += 1; counts[t2] += 1;
      }
    }
  }
  return false;
}

/**
 * 判斷 tiles(暗牌，3k+2 張) 能否組成 k 面子 + 1 對子。
 * 回傳 true / false。
 */
function canWinConcealed(tiles) {
  const counts = toCounts(tiles.filter(t => !isFlower(t)));
  const total = countsToTiles(counts).length;
  if (total % 3 !== 2) return false;
  // 嘗試每一種對子
  const keys = Object.keys(counts);
  for (const t of keys) {
    if (counts[t] >= 2) {
      counts[t] -= 2;
      if (canFormAllMelds(counts)) { counts[t] += 2; return true; }
      counts[t] += 2;
    }
  }
  return false;
}

/**
 * 哩咕（八對半）：門清 17 張 = 7 對 + 1 刻。
 * 條件：無亮出面子；同一種牌 4 張視為兩對。
 */
function isLiGu(hand, melds = []) {
  if ((melds || []).length > 0) return false; // 不可有碰/吃/槓
  const tiles = hand.filter(t => !isFlower(t));
  if (tiles.length !== 17) return false;
  const counts = toCounts(tiles);
  let tripleCount = 0;
  for (const t in counts) {
    const c = counts[t];
    if (c === 3) tripleCount++;
    else if (c !== 2 && c !== 4) return false; // 單張/其他 → 不成
  }
  return tripleCount === 1;
}

/**
 * 完整胡牌判斷：暗牌 + 亮出面子。
 * hand: 暗牌陣列（含剛拿到/胡的那張，不含花）
 * melds: 已亮面子陣列 [{type:'pong'|'chi'|'kong', tiles:[...]}]
 * 需要暗牌拆成 (5 - melds數) 個面子 + 1 對；或門清哩咕（八對半）
 */
function isWinningHand(hand, melds = [], opts = {}) {
  const concealed = hand.filter(t => !isFlower(t));
  const needMelds = 5 - melds.length;
  if (needMelds < 0) return false;
  // 暗牌張數必須是 needMelds*3 + 2
  if (concealed.length !== needMelds * 3 + 2) return false;
  if (canWinConcealed(concealed)) return true;
  if (opts.allowLiGu === false) return false;
  return isLiGu(hand, melds);
}

/**
 * 找出一組胡牌的拆解結果（面子 + 對子），供台數計算使用。
 * 回傳 { pair: tile, melds: [{type:'pong'|'chi', tiles:[...]}] } 或 null
 */
function decomposeWin(tiles) {
  const counts = toCounts(tiles.filter(t => !isFlower(t)));
  const keys = Object.keys(counts);
  for (const p of keys) {
    if (counts[p] >= 2) {
      counts[p] -= 2;
      const melds = [];
      if (extractMelds(counts, melds)) {
        counts[p] += 2;
        return { pair: p, melds };
      }
      counts[p] += 2;
    }
  }
  return null;
}

function extractMelds(counts, melds) {
  const keys = Object.keys(counts).filter(t => counts[t] > 0);
  if (keys.length === 0) return true;
  keys.sort((a, b) => tileOrder(a) - tileOrder(b));
  const t = keys[0];
  if (counts[t] >= 3) {
    counts[t] -= 3;
    melds.push({ type: 'pong', tiles: [t, t, t] });
    if (extractMelds(counts, melds)) return true;
    melds.pop();
    counts[t] += 3;
  }
  if (isSuited(t)) {
    const suit = t[0];
    const n = parseInt(t.slice(1), 10);
    if (n <= 7) {
      const t1 = suit + (n + 1), t2 = suit + (n + 2);
      if (counts[t1] > 0 && counts[t2] > 0) {
        counts[t] -= 1; counts[t1] -= 1; counts[t2] -= 1;
        melds.push({ type: 'chi', tiles: [t, t1, t2] });
        if (extractMelds(counts, melds)) return true;
        melds.pop();
        counts[t] += 1; counts[t1] += 1; counts[t2] += 1;
      }
    }
  }
  return false;
}

/* ============================================================
 * 聽牌判斷
 * ============================================================ */

/** 全部可能牌種（不含花） */
function allTileTypes() {
  const out = [];
  for (const s of SUITS) for (let n = 1; n <= 9; n++) out.push(s + n);
  for (let n = 1; n <= 7; n++) out.push('z' + n);
  return out;
}

/**
 * 回傳聽哪些牌（暗牌張數需為 3k+1）。
 * hand: 暗牌（不含花），melds: 已亮面子
 * 回傳可胡的牌陣列（可能為空 = 未聽牌）
 */
function getTingTiles(hand, melds = [], opts = {}) {
  const concealed = hand.filter(t => !isFlower(t));
  const needMelds = 5 - melds.length;
  if (concealed.length !== needMelds * 3 + 1) return [];
  const waits = [];
  for (const t of allTileTypes()) {
    // 一種牌最多 4 張，超過不可能
    const already = concealed.filter(x => x === t).length
      + melds.reduce((a, m) => a + m.tiles.filter(x => x === t).length, 0);
    if (already >= 4) continue;
    if (isWinningHand(concealed.concat([t]), melds, opts)) waits.push(t);
  }
  return waits;
}

/** 是否已聽牌 */
function isTing(hand, melds = []) {
  return getTingTiles(hand, melds).length > 0;
}

/* ============================================================
 * 吃 / 碰 / 槓 可行性判斷
 * ============================================================ */

/** 可否碰（手上有 2 張同牌） */
function canPong(hand, tile) {
  return hand.filter(t => t === tile).length >= 2;
}

/** 可否明槓（手上有 3 張同牌） */
function canKong(hand, tile) {
  return hand.filter(t => t === tile).length >= 3;
}

/**
 * 可否吃，回傳所有可吃的組合（每組是需從手上拿出的兩張）。
 * 僅下家可吃，且限序數牌。
 */
function canChiOptions(hand, tile) {
  if (!isSuited(tile)) return [];
  const suit = tile[0];
  const n = parseInt(tile.slice(1), 10);
  const has = (x) => hand.includes(suit + x);
  const opts = [];
  // tile 當順子最小張: tile, n+1, n+2
  if (n <= 7 && has(n + 1) && has(n + 2)) opts.push([suit + (n + 1), suit + (n + 2)]);
  // tile 當中張: n-1, tile, n+1
  if (n >= 2 && n <= 8 && has(n - 1) && has(n + 1)) opts.push([suit + (n - 1), suit + (n + 1)]);
  // tile 當最大張: n-2, n-1, tile
  if (n >= 3 && has(n - 1) && has(n - 2)) opts.push([suit + (n - 2), suit + (n - 1)]);
  return opts;
}

/** 暗槓：手上有 4 張同牌 */
function findConcealedKongs(hand) {
  const counts = toCounts(hand.filter(t => !isFlower(t)));
  return Object.keys(counts).filter(t => counts[t] === 4);
}

/* ============================================================
 * 台數計算
 * ctx: {
 *   hand: 暗牌(不含胡牌張),  winTile: 胡的那張,
 *   melds: 亮出面子,  flowers: 花牌陣列,
 *   selfDraw: 是否自摸,  isDealer: 莊家,
 *   seatWind: 座位風(0=東..3=北), roundWind: 圈風(0=東..),
 *   dealerStreak: 連莊次數,
 *   robbingKong: 搶槓, kongBloom: 槓上開花,
 *   lastTile: 海底/河底(最後一張), concealedWin: 門清(無亮面子且非碰吃)
 * }
 * 回傳 { total: 台數, items: [{name, tai}] }
 * ============================================================ */
function scoreHand(ctx) {
  const items = [];
  const add = (name, tai) => { if (tai > 0) items.push({ name, tai }); };

  const fullHand = ctx.hand.concat([ctx.winTile]);
  const decomp = decomposeWin(fullHand);
  // 把亮出面子也納入完整結構分析
  const allMelds = (ctx.melds || []).map(m => ({
    type: m.type === 'kong' ? 'pong' : m.type, // 槓在型態分析上視為刻子
    tiles: m.tiles.slice(0, 3),
    exposed: true,
    kong: m.type === 'kong',
    concealed: m.concealed || false,
  }));
  let pair = null;
  let handMelds = [];
  if (decomp) {
    pair = decomp.pair;
    handMelds = decomp.melds.map(m => ({ ...m, exposed: false }));
  }
  const structMelds = allMelds.concat(handMelds);

  const flowers = ctx.flowers || [];
  const concealedWin = ctx.concealedWin; // 門清（無吃碰明槓）

  /* --- 哩咕（八對半：7對+1刻，門清限定；本身不再計門清台） --- */
  const liGu = ctx.allowLiGu !== false && isLiGu(fullHand, ctx.melds || []);
  if (liGu) add('哩咕(八對半)', 8);

  /* --- 基本 --- */
  if (ctx.selfDraw) add('自摸', 1);
  if (concealedWin && !liGu) {
    if (ctx.selfDraw) add('門清自摸', 2);
    else add('門清', 1);
  }

  /* --- 莊家 / 連莊 ---
   * 莊家「胡牌」或「放槍」時都計莊家台；連莊 n 次再加 2n 台（共 2n+1） */
  const dealerInvolved = (ctx.dealerInvolved != null) ? ctx.dealerInvolved : ctx.isDealer;
  if (dealerInvolved) {
    add('莊家', 1);
    if (ctx.dealerStreak && ctx.dealerStreak > 0) {
      add(`連${ctx.dealerStreak}拉${ctx.dealerStreak}`, ctx.dealerStreak * 2);
    }
  }

  /* --- 骰運（開局莊家擲骰） --- */
  if (ctx.diceBonus && ctx.diceBonus.tai > 0) add('骰運·' + ctx.diceBonus.name, ctx.diceBonus.tai);

  /* --- 聽牌型分析（平胡/中洞/邊張/單吊 共用）--- */
  const winWaits = getTingTiles(ctx.hand, ctx.melds || [], { allowLiGu: ctx.allowLiGu !== false });

  /* --- 花牌：只算「正花」（對應自己門風的花） ---
   * 門風 0東→春(f1)梅(f5)，1南→夏(f2)蘭(f6)，2西→秋(f3)竹(f7)，3北→冬(f4)菊(f8) */
  const seatFlowerA = ctx.seatWind + 1;         // 正花(四季)
  const seatFlowerB = ctx.seatWind + 5;         // 正花(四君子)
  let flowerTai = 0;
  for (const f of flowers) {
    const num = parseInt(f.slice(1), 10);
    if (num === seatFlowerA || num === seatFlowerB) flowerTai += 1;
  }
  add('正花', flowerTai);

  /* --- 八仙過海：集滿全部 8 張花（不分正花偏花）。結算比照自摸胡三家，
   *  由呼叫端依 score.baXian 覆寫 settle() 的付款方式。
   *  （七搶一是另一種獨立的搶花特殊胡牌，不看牌型、固定 8 台、由抓到
   *  那張花的人單獨賠付，直接在 game.js 的 robFlowerWin() 結算，
   *  不經過這個函式。） --- */
  const baXian = new Set(flowers.map(f => parseInt(f.slice(1), 10))).size === 8;
  if (baXian) add('八仙過海', 8);

  /* --- 牌型台數（需成功拆牌） --- */
  if (decomp) {
    // 花色分析
    const suitsUsed = new Set();
    let hasHonor = false;
    for (const t of fullHand.filter(x => !isFlower(x))) {
      if (isHonor(t)) hasHonor = true; else suitsUsed.add(t[0]);
    }
    for (const m of allMelds) {
      for (const t of m.tiles) {
        if (isHonor(t)) hasHonor = true; else if (isSuited(t)) suitsUsed.add(t[0]);
      }
    }
    if (suitsUsed.size === 0 && hasHonor) {
      add('字一色', 16);
    } else if (suitsUsed.size === 1 && !hasHonor) {
      add('清一色', 8);
    } else if (suitsUsed.size === 1 && hasHonor) {
      add('混一色', 4);
    }

    // 面子型態
    const allStruct = structMelds;
    const triplets = allStruct.filter(m => m.type === 'pong');
    const sequences = allStruct.filter(m => m.type === 'chi');

    if (sequences.length === 0) {
      add('碰碰胡', 4);
    }
    // 平胡：全順子、無字牌、無花牌，且聽雙頭以上（中洞/邊張/單吊不算）
    if (triplets.length === 0 && !hasHonor && flowers.length === 0 && winWaits.length >= 2 && !liGu) {
      add('平胡', 2);
    }

    // 暗刻數量（三暗刻 / 四暗刻 / 五暗刻）
    let concealedTriplets = 0;
    for (const m of handMelds) if (m.type === 'pong') concealedTriplets++;
    // 暗槓也算暗刻
    for (const m of allMelds) if (m.kong && m.concealed) concealedTriplets++;
    // 胡別人放的牌時，胡牌張所組成的那一刻算「明刻」，不計入暗刻
    if (!ctx.selfDraw) {
      const winPong = handMelds.find(m => m.type === 'pong' && m.tiles[0] === ctx.winTile);
      if (winPong) concealedTriplets = Math.max(0, concealedTriplets - 1);
    }
    if (concealedTriplets === 5) add('五暗刻', 8);
    else if (concealedTriplets === 4) add('四暗刻', 5);
    else if (concealedTriplets === 3) add('三暗刻', 2);

    // 三元牌（中發白）刻子
    const dragonPongs = triplets.filter(m => ['z5', 'z6', 'z7'].includes(m.tiles[0]));
    const dragonSet = new Set(dragonPongs.map(m => m.tiles[0]));
    if (dragonSet.size === 3) add('大三元', 8);
    else if (dragonSet.size === 2 && ['z5', 'z6', 'z7'].includes(pair)) add('小三元', 4);
    else {
      for (const d of dragonSet) add('三元牌(' + tileName(d) + ')', 1);
    }

    // 風牌刻子：圈風、門風各一台
    const windPongs = triplets.filter(m => ['z1', 'z2', 'z3', 'z4'].includes(m.tiles[0]));
    for (const m of windPongs) {
      const w = parseInt(m.tiles[0].slice(1), 10) - 1; // 0..3
      if (w === ctx.roundWind) add('圈風(' + WINDS[w] + ')', 1);
      if (w === ctx.seatWind) add('門風(' + WINDS[w] + ')', 1);
    }

    // 大四喜 / 小四喜
    const windSet = new Set(windPongs.map(m => m.tiles[0]));
    if (windSet.size === 4) add('大四喜', 16);
    else if (windSet.size === 3 && ['z1', 'z2', 'z3', 'z4'].includes(pair)) add('小四喜', 8);

    // 槓相關台數
    const kongs = allMelds.filter(m => m.kong);
    if (kongs.length === 4) add('四槓', 16);
    else if (kongs.length === 3) add('三槓', 4);
  }

  /* --- 聽牌型：中洞 / 邊張 / 單吊（各 1 台，需獨聽；哩咕的單吊照算） --- */
  if ((decomp || liGu) && winWaits.length === 1 && winWaits[0] === ctx.winTile) {
    let added = false;
    if (decomp && isSuited(ctx.winTile)) {
      const suit = ctx.winTile[0];
      const n = parseInt(ctx.winTile.slice(1), 10);
      const dummyMeld = { type: 'chi', tiles: [] }; // 佔一個面子名額
      const restWins = (a, b) => {
        const rest = removeTilesOnce(ctx.hand, [suit + a, suit + b]);
        return rest && isWinningHand(rest, (ctx.melds || []).concat([dummyMeld]));
      };
      if (n >= 2 && n <= 8 && restWins(n - 1, n + 1)) { add('中洞', 1); added = true; }
      else if (n === 3 && restWins(1, 2)) { add('邊張', 1); added = true; }
      else if (n === 7 && restWins(8, 9)) { add('邊張', 1); added = true; }
    }
    // 單吊：胡牌張作將（眼）——標準型為其餘暗牌全成面子；
    // 哩咕型為手上恰有一張胡牌張（湊成第 7 對）
    if (!added) {
      const rest = removeTilesOnce(ctx.hand, [ctx.winTile]);
      const standardDiao = rest && canFormAllMelds(toCounts(rest.filter(t => !isFlower(t))));
      const liGuDiao = liGu && ctx.hand.filter(t => t === ctx.winTile).length === 1;
      if (standardDiao || liGuDiao) add('單吊', 1);
    }
  }

  /* --- 特殊胡法 --- */
  if (ctx.robbingKong) add('搶槓', 1);
  if (ctx.kongBloom) add('槓上開花', 1);
  if (ctx.lastTile) {
    if (ctx.selfDraw) add('海底撈月', 1);
    else add('河底撈魚', 1);
  }

  /* --- 全求人 / 湊一色等 --- */
  // 全求人：全部靠吃碰槓（無暗牌面子），且單吊放槓胡
  if (!ctx.selfDraw && (ctx.melds || []).length === 5 && !concealedWin) {
    add('全求人', 2);
  }

  const total = items.reduce((a, x) => a + x.tai, 0);
  return { total, items, baXian };
}
