/* ============================================================
 * tiles.js — 牌面繪製
 * 用 SVG 把牌畫成接近真實麻將的樣子：
 *   筒 → 圓點  /  索 → 竹  /  萬 → 數字＋萬  /  字、花 → 字元
 * 提供 tileFaceHTML(tile) 回傳放進 .tile 內的 HTML 字串。
 * ============================================================ */

const CN_NUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/* 顏色（主色 / 深邊 / 亮面） */
const COL = {
  blue: { main: '#2166b0', rim: '#123f70', hi: '#5fa0e0' },
  green: { main: '#1f8a4c', rim: '#0f4a2b', hi: '#5cc585' },
  red: { main: '#c0392b', rim: '#7d2018', hi: '#e77b70' },
};

/* ---------- 各數字的位置版型（viewBox 0 0 100 132）---------- */
/* 回傳中心點陣列 [ [cx,cy], ... ] */
function pipLayout(n) {
  const L = {
    1: [[50, 66]],
    2: [[50, 40], [50, 92]],
    3: [[30, 32], [50, 66], [70, 100]],
    4: [[34, 40], [66, 40], [34, 92], [66, 92]],
    5: [[32, 36], [68, 36], [50, 66], [32, 96], [68, 96]],
    6: [[34, 34], [66, 34], [34, 66], [66, 66], [34, 98], [66, 98]],
    7: [[30, 26], [50, 34], [70, 42], [34, 78], [66, 78], [34, 106], [66, 106]],
    8: [[34, 26], [66, 26], [34, 54], [66, 54], [34, 82], [66, 82], [34, 110], [66, 110]],
    9: [[30, 34], [50, 34], [70, 34], [30, 66], [50, 66], [70, 66], [30, 98], [50, 98], [70, 98]],
  };
  return L[n] || [];
}

/* 各數字筒的顏色配置（近似真牌的傳統配色） */
const DOT_COLORS = {
  2: ['green', 'blue'],
  3: ['blue', 'green', 'red'],
  4: ['green', 'green', 'blue', 'blue'],
  5: ['green', 'blue', 'red', 'blue', 'green'],
  6: ['green', 'green', 'red', 'red', 'blue', 'blue'],
  7: ['red', 'red', 'red', 'green', 'green', 'blue', 'blue'],
  8: ['blue', 'blue', 'blue', 'blue', 'green', 'green', 'green', 'green'],
  9: ['blue', 'blue', 'blue', 'green', 'green', 'green', 'red', 'red', 'red'],
};

/* ---------- 筒：立體錢幣圓點 ---------- */
function coin(cx, cy, r, key) {
  const c = COL[key];
  return `
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${c.rim}"/>
    <circle cx="${cx}" cy="${cy}" r="${(r * 0.86).toFixed(1)}" fill="${c.main}"/>
    <circle cx="${cx}" cy="${cy}" r="${(r * 0.46).toFixed(1)}" fill="#f7f4ea"/>
    <circle cx="${cx}" cy="${cy}" r="${(r * 0.26).toFixed(1)}" fill="${c.main}"/>
    <circle cx="${(cx - r * 0.3).toFixed(1)}" cy="${(cy - r * 0.3).toFixed(1)}" r="${(r * 0.16).toFixed(1)}" fill="rgba(255,255,255,.5)"/>`;
}

/* 一筒：華麗大錢幣（多重彩環） */
function bigCoin() {
  const cx = 50, cy = 66;
  let petals = '';
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const px = cx + Math.cos(a) * 21, py = cy + Math.sin(a) * 21;
    petals += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.6" fill="${COL.green.main}"/>`;
  }
  return `
    ${petals}
    <circle cx="${cx}" cy="${cy}" r="16.5" fill="${COL.blue.rim}"/>
    <circle cx="${cx}" cy="${cy}" r="15" fill="${COL.blue.main}"/>
    <circle cx="${cx}" cy="${cy}" r="11" fill="#f7f4ea"/>
    <circle cx="${cx}" cy="${cy}" r="9" fill="${COL.red.main}"/>
    <circle cx="${cx}" cy="${cy}" r="4.5" fill="#f7f4ea"/>
    <circle cx="${cx}" cy="${cy}" r="2.4" fill="${COL.green.main}"/>`;
}

function dotsSVG(n) {
  if (n === 1) return svgWrap(bigCoin());
  const pts = pipLayout(n);
  const r = n <= 5 ? 15 : 13;
  const cols = DOT_COLORS[n] || [];
  let body = '';
  pts.forEach((p, i) => { body += coin(p[0], p[1], r, cols[i] || 'blue'); });
  return svgWrap(body);
}

/* ---------- 索：立體竹節（可旋轉、換色，八索 M 形用） ---------- */
function bambooStick(cx, cy, h, angle = 0, color = 'green') {
  const w = 12;
  const x = cx - w / 2, y = cy - h / 2;
  const g = COL[color] || COL.green;
  const segH = h / 3;
  // 三節束腰竹：每節上下端外擴、中間內縮，交界處有節環
  const seg = (sy) => `
    <path d="M ${(x + 1).toFixed(1)} ${sy.toFixed(1)}
             C ${(x + 3).toFixed(1)} ${(sy + segH * 0.35).toFixed(1)} ${(x + 3).toFixed(1)} ${(sy + segH * 0.65).toFixed(1)} ${(x + 1).toFixed(1)} ${(sy + segH).toFixed(1)}
             L ${(x + w - 1).toFixed(1)} ${(sy + segH).toFixed(1)}
             C ${(x + w - 3).toFixed(1)} ${(sy + segH * 0.65).toFixed(1)} ${(x + w - 3).toFixed(1)} ${(sy + segH * 0.35).toFixed(1)} ${(x + w - 1).toFixed(1)} ${sy.toFixed(1)} Z"
      fill="${g.main}" stroke="${g.rim}" stroke-width="1.2"/>`;
  let body = '';
  for (let i = 0; i < 3; i++) body += seg(y + i * segH);
  body += `<line x1="${x}" y1="${(y + segH).toFixed(1)}" x2="${x + w}" y2="${(y + segH).toFixed(1)}" stroke="${g.rim}" stroke-width="1.8"/>`;
  body += `<line x1="${x}" y1="${(y + 2 * segH).toFixed(1)}" x2="${x + w}" y2="${(y + 2 * segH).toFixed(1)}" stroke="${g.rim}" stroke-width="1.8"/>`;
  body += `<rect x="${(x + 2).toFixed(1)}" y="${(y + 2).toFixed(1)}" width="2" height="${(h - 4).toFixed(1)}" rx="1" fill="${g.hi}" opacity=".5"/>`;
  body += `<circle cx="${cx}" cy="${(y - 1.5).toFixed(1)}" r="2.3" fill="${COL.red.main}"/>`;
  if (angle) return `<g transform="rotate(${angle} ${cx} ${cy})">${body}</g>`;
  return body;
}

/* 一索：鳥（孔雀風格） */
function birdSVG() {
  const g = COL.green, r = COL.red, b = COL.blue;
  return svgWrap(`
    <path d="M50 88 C30 96 24 118 30 128 C34 116 44 108 50 104 Z" fill="${g.main}"/>
    <path d="M50 88 C50 100 50 116 50 128 C56 116 56 104 54 96 Z" fill="${b.main}"/>
    <path d="M50 88 C70 96 76 118 70 128 C66 116 56 108 50 104 Z" fill="${g.main}"/>
    <circle cx="35" cy="120" r="3.2" fill="${r.main}"/>
    <circle cx="65" cy="120" r="3.2" fill="${b.main}"/>
    <ellipse cx="50" cy="72" rx="17" ry="22" fill="${g.main}" stroke="${g.rim}" stroke-width="1.6"/>
    <path d="M50 54 q-14 4 -16 20 q10 -12 18 -12 Z" fill="${g.hi}" opacity=".6"/>
    <circle cx="50" cy="43" r="10" fill="${g.main}" stroke="${g.rim}" stroke-width="1.4"/>
    <path d="M50 33 q3 -10 1 -18 q6 6 5 14 Z" fill="${r.main}"/>
    <circle cx="46" cy="41" r="2.6" fill="#fff"/><circle cx="46" cy="41" r="1.2" fill="#111"/>
    <path d="M40 45 l-11 -2 l10 6 Z" fill="${r.main}"/>
    <path d="M50 90 l-4 14 l8 0 Z" fill="${b.main}" opacity=".8"/>`);
}

/* 八索：兩個 M 形（上下各 4 支，外直內斜） */
function bambooEight() {
  const h = 26;
  const mShape = (cy) => {
    // M：兩側直立、中間兩支向內傾（頂端相靠）
    return bambooStick(26, cy, h, 0, 'green')
      + bambooStick(42, cy + 4, h, 22, 'blue')
      + bambooStick(58, cy + 4, h, -22, 'blue')
      + bambooStick(74, cy, h, 0, 'green');
  };
  return mShape(34) + mShape(96);
}

function bambooSVG(n) {
  if (n === 1) return birdSVG();
  if (n === 8) return svgWrap(bambooEight());
  const pts = pipLayout(n);
  const h = n <= 5 ? 34 : 27;
  const cols = DOT_COLORS[n] || [];
  let body = '';
  pts.forEach((p, i) => { body += bambooStick(p[0], p[1], h, 0, cols[i] || 'green'); });
  return svgWrap(body);
}

function svgWrap(inner) {
  return `<svg class="tile-svg" viewBox="0 0 100 132" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}

/* ---------- 萬：數字（上）＋ 萬（下） ---------- */
function wanFaceHTML(n) {
  return `<div class="wan-face">
      <span class="wan-num">${CN_NUM[n]}</span>
      <span class="wan-char">萬</span>
    </div>`;
}

/* ---------- 字牌 ---------- */
function honorFaceHTML(t) {
  const n = parseInt(t.slice(1), 10); // 1東2南3西4北5中6發7白
  if (n === 7) {
    // 白板：藍色方框
    return `<div class="honor-face bai"><div class="bai-frame"></div></div>`;
  }
  const chars = ['', '東', '南', '西', '北', '中', '發', '白'];
  const cls = n === 5 ? 'h-red' : (n === 6 ? 'h-green' : 'h-blue');
  return `<div class="honor-face ${cls}">${chars[n]}</div>`;
}

/* ---------- 花牌（左上角標數字 1-4，如真牌） ---------- */
function flowerFaceHTML(t) {
  const n = parseInt(t.slice(1), 10); // 1春2夏3秋4冬5梅6蘭7竹8菊
  const chars = ['', '春', '夏', '秋', '冬', '梅', '蘭', '竹', '菊'];
  const col = n <= 4 ? 'f-season' : 'f-plant';
  const num = n <= 4 ? n : n - 4;    // 春夏秋冬=1234、梅蘭竹菊=1234
  return `<div class="flower-face ${col}"><span class="flower-num">${num}</span>${chars[n]}</div>`;
}

/* ---------- 對外主函式 ---------- */
function tileFaceHTML(t) {
  const k = t[0];
  const n = parseInt(t.slice(1), 10);
  if (k === 'p') return dotsSVG(n);
  if (k === 's') return bambooSVG(n);
  if (k === 'm') return wanFaceHTML(n);
  if (k === 'z') return honorFaceHTML(t);
  if (k === 'f') return flowerFaceHTML(t);
  return tileName(t);
}
