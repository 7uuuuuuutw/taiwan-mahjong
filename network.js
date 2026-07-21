/* ============================================================
 * network.js — PeerJS 連線層 (P2P)
 * host 開房並當權威主機；client 連入房間。
 * 用回呼把訊息交給上層（main.js）。
 * 需先載入 PeerJS。
 * ============================================================ */

const ROOM_PREFIX = 'twmj16-'; // 避免與其他 PeerJS 使用者的房號撞號

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
    this.peer = new Peer(id, { debug: 1 });

    this.peer.on('open', () => onReady && onReady(this.roomCode));
    this.peer.on('error', (err) => {
      // 房號被占用 → 換一個重試一次（強制指定房號時不能換，直接回報失敗，
      // 讓呼叫端自己決定要不要重試——通常是舊房主的 id 還沒真的釋放）
      if (err.type === 'unavailable-id' && !forcedRoomCode) {
        this.roomCode = randomRoomCode();
        this.peer = new Peer(ROOM_PREFIX + this.roomCode, { debug: 1 });
        this.peer.on('open', () => onReady && onReady(this.roomCode));
        this.peer.on('connection', (c) => this._onHostConnection(c));
        this.peer.on('error', (e2) => onError && onError(e2));
      } else {
        onError && onError(err);
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
   * 帶上「我原本坐哪一位」（rejoinSeat），讓新房主能把座位還原。 */
  join(roomCode, name, onReady, onError, joinExtra) {
    this.isHost = false;
    this.myName = name;
    this.roomCode = roomCode.trim().toUpperCase();
    this.peer = new Peer({ debug: 1 });
    this.peer.on('open', () => {
      const conn = this.peer.connect(ROOM_PREFIX + this.roomCode, { reliable: true });
      this.hostConn = conn;
      let opened = false;
      conn.on('open', () => {
        opened = true;
        conn.send({ type: 'join', name, ...(joinExtra || {}) });
        onReady && onReady();
      });
      conn.on('data', (msg) => this._fire('hostMessage', { msg }));
      conn.on('close', () => this._fire('hostLeft', {}));
      conn.on('error', (e) => onError && onError(e));
      // 連線逾時
      setTimeout(() => { if (!opened) onError && onError(new Error('連線逾時，請確認房號')); }, 12000);
    });
    this.peer.on('error', (err) => onError && onError(err));
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
