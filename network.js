/* ============================================================
 * network.js — PeerJS 連線層 (P2P)
 * host 開房並當權威主機；client 連入房間。
 * 用回呼把訊息交給上層（main.js）。
 * 需先載入 PeerJS。
 * ============================================================ */

const ROOM_PREFIX = 'twmj16-'; // 避免與其他 PeerJS 使用者的房號撞號

/* PeerJS 預設只給 STUN（用來探測雙方的公開 IP/連接埠），沒有 TURN
 * 中繼伺服器。多數情況 STUN 就夠兩邊直接打通，但只要任一邊在對稱式
 * NAT（symmetric NAT，常見於部分電信商的行動網路、公司/校園網路、
 * CGNAT）後面，直接連線就是連不通、只能卡到逾時——這是「連線逾時」
 * 回報的真正常見成因，不一定是房號打錯。這裡加一個免費公用 TURN
 * 伺服器（OpenRelay，社群常用的免費方案）當最後備援：能直連還是優先
 * 直連，只有直連真的不通時才會繞經這台中繼伺服器轉發加密過的連線
 * 資料。
 *
 * 額外加了 turns:（TURN over TLS，走 443）：前面 turn:...?transport=tcp
 * 雖然也走 443 連接埠，但底層仍是「看起來像 TCP 卻不是真的 HTTPS」的
 * 流量，遇到會做深度封包檢測的嚴格防火牆（部分公司/校園網路）還是可能
 * 被擋下來直接判定逾時；turns: 是包一層真正的 TLS 交握，流量特徵跟
 * 正常瀏覽 HTTPS 網站沒有差別，能穿透的環境更多，當最後一道備援。
 * 另外多列一台 Google 的 STUN 伺服器，避免單一 STUN 服務忙碌/連不上時
 * 完全沒有備援。 */
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};

class NetworkManager {
  constructor() {
    this.peer = null;
    this.isHost = false;
    this.roomCode = null;
    this.conns = {};      // host 用：peerId -> DataConnection
    this.hostConn = null; // client 用：與 host 的連線
    this.handlers = {};   // event -> fn
    this.myName = '';
  }

  on(event, fn) { this.handlers[event] = fn; }
  _fire(event, payload) { if (this.handlers[event]) this.handlers[event](payload); }

  /* ---------- 開房（host） ----------
   * forcedRoomCode：房主斷線後，接手的人重新聲明同一個房號用（等待室
   * 房主轉移），不指定就正常隨機開新房號。 */
  host(name, onReady, onError, forcedRoomCode) {
    this.isHost = true;
    this.myName = name;
    this.roomCode = forcedRoomCode || randomRoomCode();
    const id = ROOM_PREFIX + this.roomCode;
    this.peer = new Peer(id, { debug: 1, config: ICE_SERVERS });

    // 涵蓋整個開房流程的逾時保護：peer.on('open') 若因連不上 PeerJS 訊號
    // 伺服器而永遠不觸發（訊號伺服器連線卡住時不一定會觸發 error），
    // 開房／房主轉移時接手就會卡死、呼叫端永遠等不到 onReady 或
    // onError，外層的重試/重連流程也就永遠沒有機會執行下一步。
    let settled = false;
    const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn && fn(arg); };
    const timer = setTimeout(() => finish(onError, new Error('開房逾時，請檢查網路連線後再試一次')), 16000);

    this.peer.on('open', () => finish(onReady, this.roomCode));
    this.peer.on('error', (err) => {
      // 房號被占用 → 換一個重試一次（強制指定房號時不能換，直接回報失敗，
      // 讓呼叫端自己決定要不要重試——通常是舊房主的 id 還沒真的釋放）
      if (err.type === 'unavailable-id' && !forcedRoomCode) {
        this.roomCode = randomRoomCode();
        this.peer = new Peer(ROOM_PREFIX + this.roomCode, { debug: 1, config: ICE_SERVERS });
        this.peer.on('open', () => finish(onReady, this.roomCode));
        this.peer.on('connection', (c) => this._onHostConnection(c));
        this.peer.on('error', (e2) => finish(onError, e2));
      } else {
        finish(onError, err);
      }
    });
    this.peer.on('connection', (c) => this._onHostConnection(c));
  }

  _onHostConnection(conn) {
    conn.on('open', () => {
      this.conns[conn.peer] = conn;
      conn.on('data', (msg) => this._fire('clientMessage', { peerId: conn.peer, msg }));
      conn.on('close', () => {
        delete this.conns[conn.peer];
        this._fire('clientLeft', { peerId: conn.peer });
      });
      this._fire('clientConnected', { peerId: conn.peer, conn });
    });
  }

  /** host: 傳給特定 client */
  sendTo(peerId, msg) {
    const c = this.conns[peerId];
    if (c && c.open) c.send(msg);
  }
  /** host: 廣播 */
  broadcast(msg) {
    for (const id in this.conns) this.sendTo(id, msg);
  }

  /* ---------- 加入房間（client） ----------
   * joinExtra：合併進 join 訊息的額外欄位，房主轉移後重新連線時用來
   * 帶上「我原本坐哪一位」（rejoinSeat），讓新房主能把座位還原。
   *
   * 分兩階段嘗試：
   *  1) 正常模式——瀏覽器會依序試直連／STUN／TURN，多數情況這樣就夠了。
   *  2) 若第一階段逾時，改用 iceTransportPolicy:'relay' 強制只走 TURN
   *     中繼，跳過直連／STUN 候選人。這是專門對付「路由器的客戶端隔離
   *     （同一個 Wi-Fi 底下裝置互相看不到）」或某些嚴格防火牆的情況：
   *     這類環境會讓直連候選人乾等沒有回應、拖到逾時，卻不會擋掉「主動
   *     連到外部 TURN 伺服器」這件事——強制只走中繼可以跳過那段注定失敗
   *     的等待，直接用中繼把連線接通。 */
  join(roomCode, name, onReady, onError, joinExtra) {
    this.isHost = false;
    this.myName = name;
    this.roomCode = roomCode.trim().toUpperCase();

    const PHASE1_TIMEOUT_MS = 8000;
    const PHASE2_TIMEOUT_MS = 9000;

    const attempt = (config, timeoutMs, onFail) => {
      let settled = false;
      this.peer = new Peer({ debug: 1, config });
      const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn && fn(arg); };
      const timer = setTimeout(() => finish(onFail, null), timeoutMs);

      this.peer.on('open', () => {
        const conn = this.peer.connect(ROOM_PREFIX + this.roomCode, { reliable: true });
        this.hostConn = conn;
        conn.on('open', () => {
          conn.send({ type: 'join', name, ...(joinExtra || {}) });
          finish(onReady);
        });
        conn.on('data', (msg) => this._fire('hostMessage', { msg }));
        conn.on('close', () => this._fire('hostLeft', {}));
        conn.on('error', (e) => finish(onFail, e));
      });
      this.peer.on('error', (err) => finish(onFail, err));
    };

    attempt(ICE_SERVERS, PHASE1_TIMEOUT_MS, (err) => {
      // 房號打錯這類「明確」錯誤（peer-unavailable）直接回報，不用浪費
      // 時間再試一次強制中繼——那不會讓不存在的房號變存在。
      if (err && err.type && err.type !== 'network' && err.type !== 'server-error') {
        onError && onError(err);
        return;
      }
      try { this.peer && this.peer.destroy(); } catch (e) {}
      attempt({ ...ICE_SERVERS, iceTransportPolicy: 'relay' }, PHASE2_TIMEOUT_MS, (err2) => {
        onError && onError(err2 || new Error('連線逾時——請確認房號是否正確；若房號沒錯，可能是雙方網路環境限制了直接連線，可以換個網路（例如都用同一個 Wi-Fi）再試一次'));
      });
    });
  }

  /** client: 傳給 host */
  sendToHost(msg) {
    if (this.hostConn && this.hostConn.open) this.hostConn.send(msg);
  }

  destroy() {
    try { if (this.peer) this.peer.destroy(); } catch (e) {}
    this.peer = null; this.conns = {}; this.hostConn = null;
  }
}

function randomRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆字元
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
