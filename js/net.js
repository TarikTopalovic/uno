// PeerJS wrapper: WebRTC data channels with free public signaling.
// Host is authoritative; guests only ever exchange JSON messages.

const PEERJS_SRC = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
const PREFIX = 'uno-neon-';

let peerJsLoaded = null;

function ensurePeerJs() {
  if (window.Peer) return Promise.resolve();
  if (!peerJsLoaded) {
    peerJsLoaded = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PEERJS_SRC;
      s.onload = resolve;
      s.onerror = () => reject(new Error('could not load PeerJS'));
      document.head.appendChild(s);
    });
  }
  return peerJsLoaded;
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Resolves with { code, peer }. cb: { onJoin(conn, name), onData(conn, msg),
// onLeave(conn) }. conn.seat is attached by the host session.
export async function hostRoom(cb) {
  await ensurePeerJs();
  return new Promise((resolve, reject) => {
    const code = randomCode();
    const peer = new window.Peer(PREFIX + code);
    peer.on('open', () => resolve({ code, peer }));
    peer.on('error', (e) => reject(e));
    peer.on('connection', (conn) => {
      conn.on('data', (msg) => {
        if (msg && msg.t === 'hello') cb.onJoin(conn, String(msg.name ?? ''));
        else cb.onData(conn, msg);
      });
      conn.on('close', () => cb.onLeave(conn));
      conn.on('error', () => cb.onLeave(conn));
    });
  });
}

// Resolves with the open DataConnection. cb: { onMessage(msg), onClose() }.
export async function joinRoom(code, name, cb) {
  await ensurePeerJs();
  return new Promise((resolve, reject) => {
    const peer = new window.Peer();
    const fail = (e) => reject(new Error(e?.type === 'peer-unavailable' ? 'room not found' : String(e)));
    peer.on('error', fail);
    peer.on('open', () => {
      const conn = peer.connect(PREFIX + code.trim().toUpperCase(), { reliable: true });
      conn.on('open', () => {
        conn.send({ t: 'hello', name });
        resolve(conn);
      });
      conn.on('data', (msg) => cb.onMessage(msg));
      conn.on('close', () => cb.onClose());
    });
    setTimeout(() => fail({ type: 'peer-unavailable' }), 12000);
  });
}
