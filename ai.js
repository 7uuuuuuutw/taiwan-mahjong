/* ============================================================
 * ai.js — 電腦補位邏輯
 * 基本策略：能胡就胡；決定打哪張時，優先留下能組面子/搭子的牌，
 * 打出孤張（無法組面子且無搭子的牌），字牌孤張優先丟。
 * 依賴 mahjong.js 的函式（同一頁面載入）。
 * ============================================================ */

/**
 * AI 決定要打出哪張牌。
 * @param {string[]} hand 暗牌（不含花）
 * @param {object[]} melds 已亮面子
 * @param {string} level 強度：easy(常亂打) / normal(偶有失誤) / hard(全力)
 * @returns {string} 要打出的牌
 */
function aiChooseDiscard(hand, melds, level = 'normal') {
  const tiles = hand.filter(t => !isFlower(t));
  // 依強度加入「失誤率」：直接亂打一張
  const noise = level === 'easy' ? 0.55 : (level === 'normal' ? 0.12 : 0);
  if (noise > 0 && Math.random() < noise) {
    return tiles[Math.floor(Math.random() * tiles.length)];
  }
  // 若打掉某張後仍聽牌，優先選能維持/形成聽牌的打法
  let bestTile = tiles[0];
  let bestScore = -Infinity;

  const uniq = [...new Set(tiles)];
  for (const t of uniq) {
    const rest = removeOne(tiles, t);
    const score = evaluateHand(rest, melds);
    if (score > bestScore) {
      bestScore = score;
      bestTile = t;
    }
  }
  return bestTile;
}

/** 評估一手牌的「好壞」：越接近胡越高 */
function evaluateHand(tiles, melds) {
  const counts = toCounts(tiles);
  let score = 0;

  // 聽牌加大權重
  const needMelds = 5 - melds.length;
  if (tiles.length === needMelds * 3 + 1) {
    const waits = getTingTiles(tiles, melds);
    if (waits.length > 0) score += 1000 + waits.length * 20;
  }

  // 面子與搭子計數
  const { melds: mcount, pairs, partials } = countGroups(counts);
  score += mcount * 100 + pairs * 25 + partials * 15;

  // 孤張扣分（字牌孤張扣更多）
  for (const t in counts) {
    if (counts[t] === 1 && isIsolated(counts, t)) {
      score -= isHonor(t) ? 12 : 6;
    }
  }
  return score;
}

/** 粗略計算面子、對子、搭子數（貪婪） */
function countGroups(countsIn) {
  const counts = { ...countsIn };
  let melds = 0, pairs = 0, partials = 0;

  const keys = () => Object.keys(counts).filter(t => counts[t] > 0)
    .sort((a, b) => tileOrder(a) - tileOrder(b));

  // 先抽刻子與順子
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of keys()) {
      if (counts[t] >= 3) { counts[t] -= 3; melds++; changed = true; break; }
      if (isSuited(t)) {
        const n = parseInt(t.slice(1), 10), s = t[0];
        if (n <= 7 && counts[s + (n + 1)] > 0 && counts[s + (n + 2)] > 0) {
          counts[t]--; counts[s + (n + 1)]--; counts[s + (n + 2)]--;
          melds++; changed = true; break;
        }
      }
    }
  }
  // 抽對子與搭子
  for (const t of keys()) {
    while (counts[t] >= 2) { counts[t] -= 2; pairs++; }
  }
  for (const t of keys()) {
    if (counts[t] > 0 && isSuited(t)) {
      const n = parseInt(t.slice(1), 10), s = t[0];
      if (n <= 8 && counts[s + (n + 1)] > 0) { counts[t]--; counts[s + (n + 1)]--; partials++; }
      else if (n <= 7 && counts[s + (n + 2)] > 0) { counts[t]--; counts[s + (n + 2)]--; partials++; }
    }
  }
  return { melds, pairs, partials };
}

/** 某張牌是否為孤張（附近無同/連牌） */
function isIsolated(counts, t) {
  if (counts[t] >= 2) return false;
  if (!isSuited(t)) return true; // 字牌：僅看是否成對，上面已排除
  const n = parseInt(t.slice(1), 10), s = t[0];
  for (const d of [-2, -1, 1, 2]) {
    const nn = n + d;
    if (nn >= 1 && nn <= 9 && counts[s + nn] > 0) return false;
  }
  return true;
}

function removeOne(arr, t) {
  const i = arr.indexOf(t);
  if (i < 0) return arr.slice();
  const c = arr.slice();
  c.splice(i, 1);
  return c;
}

/**
 * AI 是否要對別人打出的牌做動作（胡 > 槓 > 碰 > 吃 > 過）。
 * 回傳 {action:'hu'|'kong'|'pong'|'chi'|'pass', ...}
 * @param canActions 由主流程算好的可行動作集合
 */
function aiReactToDiscard(hand, melds, tile, canActions, ctx, level = 'normal') {
  // 能胡一定胡（各強度皆同）
  if (canActions.hu) return { action: 'hu' };
  // 簡單模式：一半機率放過吃碰槓機會
  if (level === 'easy' && Math.random() < 0.5) return { action: 'pass' };
  // 明槓：手上三張且已進聽或牌型單純時才槓（此處簡單：有就槓）
  if (canActions.kong) {
    return { action: 'kong' };
  }
  // 碰：碰完仍有進展才碰（避免破壞聽牌）
  if (canActions.pong) {
    const after = removeN(hand, tile, 2);
    const before = evaluateHand(hand.filter(t => !isFlower(t)), melds);
    const newMelds = melds.concat([{ type: 'pong', tiles: [tile, tile, tile] }]);
    const afterScore = evaluateHand(after.filter(t => !isFlower(t)), newMelds);
    if (afterScore >= before - 10) return { action: 'pong' };
  }
  // 吃：僅在能明顯成面子時（下家判斷已在主流程）
  if (canActions.chi && canActions.chiOptions && canActions.chiOptions.length) {
    // 選第一種可吃組合
    return { action: 'chi', chi: canActions.chiOptions[0] };
  }
  return { action: 'pass' };
}

function removeN(arr, t, n) {
  const c = arr.slice();
  for (let i = 0; i < n; i++) {
    const idx = c.indexOf(t);
    if (idx >= 0) c.splice(idx, 1);
  }
  return c;
}
