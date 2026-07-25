/* ============================================================
 * ai.js — 電腦補位邏輯
 * 核心：以「向聽數」（shanten，離聽牌還差幾步）＋「進張數」（ukeire，
 * 能改善牌型的牌種數）評分，越接近胡牌分數越高。
 * hard 等級再加一層：進張數更精準的搭子選擇、以及基礎防守
 * （優先打出別家棄過的安全牌）。
 * 每個電腦角色再帶一種「偏好打法」（style），影響碰吃寬容度、
 * 求快／求穩／求大牌／防守／賭性的傾向，讓不同角色玩起來有差異。
 * 依賴 mahjong.js 的函式（同一頁面載入）。
 * ============================================================ */

/**
 * 依偏好打法回傳一組行為參數。
 * claimLenient：碰／吃容忍度（加到舊制分數門檻，越大越願意碰吃）
 * shantenSlack：hard 等級碰／吃允許向聽數變差的幅度（0=不能變差）
 * ukeireWeight：出牌時進張數的權重
 * safeWeight：出牌時「別家已棄過」安全牌的加分權重
 * flushBias：出牌時，打出「非優勢花色」牌的加分（追一色用）
 * gamblerNoise：出牌評分額外加入的隨機擾動幅度
 */
function styleParams(style) {
  switch (style) {
    case 'aggressive': return { claimLenient: 30, shantenSlack: 1, ukeireWeight: 8, safeWeight: 2, flushBias: 0, gamblerNoise: 0 };
    case 'speed': return { claimLenient: 25, shantenSlack: 1, ukeireWeight: 14, safeWeight: 2, flushBias: 0, gamblerNoise: 0 };
    case 'defensive': return { claimLenient: -5, shantenSlack: 0, ukeireWeight: 8, safeWeight: 14, flushBias: 0, gamblerNoise: 0 };
    case 'bigHand': return { claimLenient: -20, shantenSlack: -1, ukeireWeight: 6, safeWeight: 4, flushBias: 10, gamblerNoise: 0 };
    case 'gambler': return { claimLenient: 20, shantenSlack: 1, ukeireWeight: 8, safeWeight: 2, flushBias: 0, gamblerNoise: 26 };
    default: return { claimLenient: 0, shantenSlack: 0, ukeireWeight: 8, safeWeight: 4, flushBias: 0, gamblerNoise: 0 };
  }
}

/**
 * AI 決定要打出哪張牌。
 * @param {string[]} hand 暗牌（不含花）
 * @param {object[]} melds 已亮面子
 * @param {string} level 強度：easy(常亂打) / normal(偶有失誤) / hard(全力＋防守)
 * @param {object} ctx 可選：{ seatDiscards: string[][], style, kuikaeForbidden } 各家棄牌、
 *   本家偏好打法、剛吃/碰完這輪不能打的牌（吃碰限制）
 * @returns {string} 要打出的牌
 */
function aiChooseDiscard(hand, melds, level = 'normal', ctx = null) {
  const allTiles = hand.filter(t => !isFlower(t));
  // 剛吃/碰完的限制牌：從候選中直接排除，不能因為它分數高就選它
  // （若排除後空了——理論上不會發生，因為最多禁2張——就退回完整手牌避免卡死）
  const forbidden = (ctx && ctx.kuikaeForbidden) || [];
  const filtered = forbidden.length ? allTiles.filter(t => !forbidden.includes(t)) : allTiles;
  const tiles = filtered.length ? filtered : allTiles;

  // 依強度加入「失誤率」：直接亂打一張（仍只從允許的候選裡選）
  const noise = level === 'easy' ? 0.55 : (level === 'normal' ? 0.12 : 0);
  if (noise > 0 && Math.random() < noise) {
    return tiles[Math.floor(Math.random() * tiles.length)];
  }

  const sp = styleParams(ctx && ctx.style);
  const levelMult = level === 'hard' ? 1 : (level === 'normal' ? 0.5 : 0.25);
  const safeTiles = (ctx && ctx.seatDiscards) ? safeTileSet(ctx.seatDiscards) : null;
  const majoritySuit = dominantSuit(tiles);
  // 剩餘張數統計，只在還沒打出候選牌前算一次（打哪張候選都不影響「看得
  // 到多少」，那些牌本來就已知，只是換個地方放）——hard 等級才用，
  // easy/normal 維持原本單純數種類的權重，難度落差更明顯。
  const visCounts = level === 'hard' ? visibleCounts(tiles, melds, ctx) : null;

  let bestTile = tiles[0];
  let bestScore = -Infinity;
  const uniq = [...new Set(tiles)];
  for (const t of uniq) {
    const rest = removeOne(tiles, t);
    let score = handScore(rest, melds);
    // 進張「期望值」：不是單純數能改善牌型的牌有幾種，是把每種有效牌
    // 實際還剩幾張（根據公開資訊統計）加總、除以 4 正規化——同樣能讓
    // 向聽數進步，剩 4 張沒人碰過的牌跟只剩 0 張的牌，期望值天差地遠。
    score += ukeireCount(rest, melds, visCounts) * sp.ukeireWeight * levelMult;
    // 防守：hard 等級改用「放槍期望值」（各家聽牌危險度 × 潛在台數權重，
    // 現物＝過水規則下對該家保證安全則不計），比單純「有人棄過就安全」
    // 更能反映機率；easy/normal 維持原本的簡單二分安全判斷。
    if (level === 'hard' && ctx && ctx.dangerInfo) {
      score -= (dealInRisk(t, ctx.mySeat, ctx) / 3) * sp.safeWeight * levelMult;
    } else if (safeTiles && safeTiles.has(t)) {
      score += sp.safeWeight * levelMult;
    }
    // 追一色：打出非優勢花色的牌加分
    if (sp.flushBias && majoritySuit && isSuited(t) && t[0] !== majoritySuit) score += sp.flushBias;
    // 賭性：加入隨機擾動，偶爾出人意表
    if (sp.gamblerNoise) score += (Math.random() - 0.5) * sp.gamblerNoise * levelMult;
    if (score > bestScore) { bestScore = score; bestTile = t; }
  }
  return bestTile;
}

/** 各家「聽牌危險度」粗估：只看公開資訊——已亮面子數。面子亮得越多，
 *  代表暗牌越少、離聽牌越近，愈危險。台灣麻將沒有立直宣告可以直接看，
 *  這是能拿到的最直接聽牌訊號（5 面子＋1 對子的牌型，亮滿 4 組面子
 *  基本上就只差最後一組＋對子，幾乎等同聽牌）。 */
const DANGER_BY_MELDS = [0.12, 0.25, 0.45, 0.7, 0.95];
function meldDanger(meldCount) {
  return DANGER_BY_MELDS[Math.min(meldCount, DANGER_BY_MELDS.length - 1)];
}

/** 潛在台數權重的粗估代理：花牌收越多，胡了台數通常越高，放槍的期望
 *  損失也跟著放大——不用真的去猜牌型，用花數當簡單代理就好。 */
function valueWeight(flowerCount) {
  return 1 + Math.min(flowerCount, 8) * 0.06;
}

/** 打出某張牌的「放槍期望值」風險：對每一家分別算「聽牌危險度 × 潛在
 *  台數權重」再加總；若這張牌是該家自己棄過的（現物，過水規則下保證
 *  不會放槍給他），那一家就不計風險。比「只要有人棄過就算安全」更貼近
 *  期望值——對聽牌機率高、可能台數大的對手更小心，面子還很少的對手
 *  就不必過度保守。 */
function dealInRisk(tile, mySeat, ctx) {
  if (!ctx || !ctx.dangerInfo) return 0;
  let risk = 0;
  ctx.dangerInfo.forEach((info, i) => {
    if (i === mySeat || !info) return;
    const discardedByThem = ctx.seatDiscards && ctx.seatDiscards[i] && ctx.seatDiscards[i].includes(tile);
    if (discardedByThem) return;
    risk += meldDanger(info.meldCount) * valueWeight(info.flowerCount);
  });
  return risk;
}

/** 別家棄過的牌集合（供防守使用） */
function safeTileSet(seatDiscards) {
  const set = new Set();
  for (const pile of seatDiscards) for (const t of pile) set.add(t);
  return set;
}

/** 統計每一種牌「已知看得到」的張數：自己的手牌／面子、全桌棄牌、全桌
 *  已亮面子（別家暗槓看不到牌面，不計入）。花色字牌每種固定 4 張，
 *  這是後面估算「還剩幾張活著」的統計依據——公開資訊，不偷看別人暗牌。 */
function visibleCounts(hand, melds, ctx) {
  const counts = {};
  const add = (t) => { if (t && !isFlower(t)) counts[t] = (counts[t] || 0) + 1; };
  hand.forEach(add);
  (melds || []).forEach(m => m.tiles.forEach(add));
  if (ctx) {
    if (ctx.allMelds) ctx.allMelds.forEach(ms => (ms || []).forEach(m => m.tiles.forEach(add)));
    if (ctx.seatDiscards) ctx.seatDiscards.forEach(pile => (pile || []).forEach(add));
  }
  return counts;
}

/** 某張牌目前還剩幾張「活著」（可能摸到、不在任何人已知的牌堆裡）：
 *  4 減掉看得到的張數，最少 0。 */
function liveCount(tile, visCounts) {
  return Math.max(0, 4 - (visCounts[tile] || 0));
}

/** 手牌中數量最多的花色（m/p/s），供「追一色」風格判斷優勢花色 */
function dominantSuit(tiles) {
  const count = { m: 0, p: 0, s: 0 };
  for (const t of tiles) if (isSuited(t)) count[t[0]]++;
  let best = null, bestN = 0;
  for (const s of ['m', 'p', 's']) if (count[s] > bestN) { bestN = count[s]; best = s; }
  return best;
}

/** 評估一手牌的「好壞」：向聽數為主，牌型完整度為輔 */
function handScore(tiles, melds) {
  const shanten = estimateShanten(tiles, melds);
  // 向聽每少 1，分數大幅提升（確保永遠優先縮短向聽）
  let score = (6 - shanten) * 200;

  const counts = toCounts(tiles);
  const { melds: mcount, pairs, partials } = countGroups(counts);
  score += mcount * 40 + pairs * 12 + partials * 8;

  // 孤張扣分（字牌孤張扣更多）
  for (const t in counts) {
    if (counts[t] === 1 && isIsolated(counts, t)) {
      score -= isHonor(t) ? 12 : 6;
    }
  }
  return score;
}

/** 舊名沿用（其餘程式碼相容）：向聽已達聽牌時回傳含加成分數 */
function evaluateHand(tiles, melds) {
  const needMelds = 5 - melds.length;
  let score = handScore(tiles, melds);
  if (tiles.length === needMelds * 3 + 1) {
    const waits = getTingTiles(tiles, melds);
    if (waits.length > 0) score += 1000 + waits.length * 20;
  }
  return score;
}

/**
 * 估算向聽數（shanten）：離「聽牌」還差幾步，0 = 已聽牌，-1 = 已胡。
 * 嘗試每一種可能的對子錨點，取最佳拆解（面子、搭子、對子）。
 */
function estimateShanten(hand, melds) {
  const tiles = hand.filter(t => !isFlower(t));
  const meldsNeeded = 5 - melds.length;
  const best = bestDecomposition(tiles, meldsNeeded);
  const usedPartials = Math.min(best.partials, Math.max(0, meldsNeeded - best.melds));
  let shanten = 2 * (meldsNeeded - best.melds) - usedPartials - best.hasPair;
  return Math.max(shanten, -1);
}

/** 找出「面子＋搭子／額外對子＋對子眼」的最佳組合（貪婪＋窮舉對子錨點） */
function bestDecomposition(tiles, meldsNeeded) {
  const baseCounts = toCounts(tiles);
  const tryPair = (pairTile) => {
    const c = { ...baseCounts };
    let hasPair = 0;
    if (pairTile) { c[pairTile] -= 2; hasPair = 1; }
    const { melds, pairs, partials } = countGroups(c);
    // 多出來的對子也能當作搭子（等成刻子），但不超過還需要的面子數
    const effectivePartials = Math.min(partials + pairs, Math.max(0, meldsNeeded - melds));
    return { melds, partials: effectivePartials, hasPair, rank: melds * 2 + effectivePartials + hasPair };
  };
  let best = tryPair(null);
  for (const t of Object.keys(baseCounts)) {
    if (baseCounts[t] >= 2) {
      const r = tryPair(t);
      if (r.rank > best.rank) best = r;
    }
  }
  return best;
}

/** 進張數：摸到哪些「種」牌能讓向聽數再降低。
 *  有給 visCounts（各牌已知看得到的張數）時改成統計加權：每種有效牌
 *  依「還剩幾張活著」（liveCount，最多 4）算分再除以 4 正規化，反映
 *  真實機率——同樣能讓向聽數進步，剩 4 張沒人碰過的牌權重是 1，只剩
 *  1 張快被摸光的牌權重只有 0.25，不再一視同仁。沒給 visCounts（例如
 *  easy/normal 難度）就退回原本單純數種類，維持原本的難度落差。 */
function ukeireCount(tiles, melds, visCounts) {
  const base = estimateShanten(tiles, melds);
  if (base < 0) return 0;
  let count = 0;
  for (const t of allTileTypes()) {
    if (tiles.filter(x => x === t).length >= 4) continue; // 四張都在手上不可能再摸到
    if (estimateShanten(tiles.concat([t]), melds) < base) {
      count += visCounts ? liveCount(t, visCounts) / 4 : 1;
    }
  }
  return count;
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

  const cleanHand = hand.filter(t => !isFlower(t));
  const sp = styleParams(ctx && ctx.style);

  if (level === 'hard') {
    // hard：碰／槓／吃依偏好打法的向聽容忍度判斷，吃則從所有選項中挑
    // 「進張期望值」最高的（用公開資訊統計剩餘張數加權，不是單純數種類）
    const beforeShanten = estimateShanten(cleanHand, melds);
    const visCounts = visibleCounts(cleanHand, melds, ctx);

    if (canActions.kong) {
      // 明槓一律用手上其他 3 張（不改變花色張數，向聽不會變差），直接開
      return { action: 'kong' };
    }
    if (canActions.pong) {
      const after = removeN(cleanHand, tile, 2);
      const newMelds = melds.concat([{ type: 'pong', tiles: [tile, tile, tile] }]);
      const afterShanten = estimateShanten(after, newMelds);
      if (afterShanten <= beforeShanten + sp.shantenSlack) return { action: 'pong' };
    }
    if (canActions.chi && canActions.chiOptions && canActions.chiOptions.length) {
      const beforeUkeire = ukeireCount(cleanHand, melds, visCounts);
      let bestCombo = null, bestShanten = Infinity, bestUkeire = -1;
      for (const combo of canActions.chiOptions) {
        const after = removeN(removeOne(cleanHand, combo[0]), combo[1], 1);
        const newMelds = melds.concat([{ type: 'chi', tiles: [combo[0], tile, combo[1]] }]);
        const sh = estimateShanten(after, newMelds);
        const uk = sh <= beforeShanten ? ukeireCount(after, newMelds, visCounts) : -1;
        if (sh < bestShanten || (sh === bestShanten && uk > bestUkeire)) {
          bestShanten = sh; bestUkeire = uk; bestCombo = combo;
        }
      }
      // 吃一定要真的有幫助：向聽數變好，或向聽數打平但進張變多——否則就是
      // 拆掉手上現成的搭子/順子去吃一口毫無進展的牌（例如手上已有 6,7,8
      // 完整一組，卻拆開 6,7 去吃別人的 5，湊出一口公開的 5,6,7，剩下的 8
      // 變成孤張還得馬上打掉），平白洩漏手牌資訊、浪費一次出牌機會，卻
      // 什麼都沒換到。向聽數真的變差（各風格的容忍度）仍然照舊允許，那是
      // 刻意為了搶快/搶台數的取捨，跟這種「打平卻零收穫」的情況不一樣。
      const noOpTie = bestShanten === beforeShanten && bestUkeire <= beforeUkeire;
      if (bestCombo && !noOpTie && bestShanten <= beforeShanten + sp.shantenSlack) return { action: 'chi', chi: bestCombo };
    }
    return { action: 'pass' };
  }

  // 明槓：手上三張且已進聽或牌型單純時才槓（此處簡單：有就槓）
  if (canActions.kong) {
    return { action: 'kong' };
  }
  // 碰：碰完仍有進展才碰（避免破壞聽牌），容忍度依偏好打法調整
  if (canActions.pong) {
    const after = removeN(hand, tile, 2);
    const before = evaluateHand(cleanHand, melds);
    const newMelds = melds.concat([{ type: 'pong', tiles: [tile, tile, tile] }]);
    const afterScore = evaluateHand(after.filter(t => !isFlower(t)), newMelds);
    if (afterScore >= before - 10 + sp.claimLenient) return { action: 'pong' };
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
