// PeerJS wrapper: WebRTC data channels with free public signaling.
// Host is authoritative; guests only ever exchange JSON messages.
//
// NAT traversal: STUN below handles most home networks. Strict NATs
// (CGNAT, corporate, some mobile carriers) need a TURN relay. Fill
// TURN_SERVERS with credentials from a free relay account (e.g.
// expressturn.com — free tier, creds are safe to embed client-side),
// or pass them at runtime via the URL:
//   ?turn=turn:host:3478,turns:host:443?transport=tcp|username|credential
// Add &relay to force TURN-only (for testing the relay path).

const PEERJS_SRC = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
const PREFIX = 'uno-neon-';

const TURN_SERVERS = [
  // { urls: ['turn:relay1.expressturn.com:3478', 'turns:relay1.expressturn.com:443?transport=tcp'],
  //   username: '...', credential: '...' },
];

function turnFromUrl() {
  const raw = new URLSearchParams(window.location.search).get('turn');
  if (!raw) return [];
  const [urls, username, credential] = raw.split('|');
  if (!urls || !username || !credential) return [];
  return [{ urls: urls.split(','), username, credential }];
}

function peerOptions() {
  const turn = [...TURN_SERVERS, ...turnFromUrl()];
  const config = {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
      ...turn,
    ],
  };
  if (new URLSearchParams(window.location.search).has('relay') && turn.length) {
    config.iceTransportPolicy = 'relay';
  }
  return { config };
}

export function hasTurn() {
  return TURN_SERVERS.length > 0 || turnFromUrl().length > 0;
}

let peerJsLoaded = null;

function ensurePeerJs() {
  if (window.Peer) return Promise.resolve();
  if (!peerJsLoaded) {
    peerJsLoaded = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PEERJS_SRC;
      s.onload = resolve;
      s.onerror = () => reject(new Error('could not load PeerJS (network/adblock?)'));
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

// Watches the underlying RTCPeerConnection and reports unrecoverable ICE
// failure — the "our networks can't reach each other" case that otherwise
// looks like an infinite hang.
function watchIce(conn, onTrouble) {
  let reported = false;
  const timer = setInterval(() => {
    const pc = conn.peerConnection;
    if (!pc) return;
    const st = pc.iceConnectionState;
    if ((st === 'failed' || st === 'closed') && !reported) {
      reported = true;
      clearInterval(timer);
      onTrouble(st);
    }
    if (st === 'connected' || st === 'completed') clearInterval(timer);
  }, 800);
  conn.on('close', () => clearInterval(timer));
  setTimeout(() => clearInterval(timer), 60000);
}

export const NO_ROUTE_MSG = hasTurn()
  ? 'connection failed even via relay — try a different network'
  : 'your networks block direct peer-to-peer connections — a TURN relay is needed (see README)';

// Resolves with { code, peer }. cb: { onJoin(conn, name), onData(conn, msg),
// onLeave(conn), onStatus(msg) }. conn.seat is attached by the host session.
export async function hostRoom(cb) {
  cb.onStatus?.('contacting signaling server…');
  await ensurePeerJs();
  return new Promise((resolve, reject) => {
    const code = randomCode();
    const peer = new window.Peer(PREFIX + code, peerOptions());
    let opened = false;
    peer.on('open', () => {
      opened = true;
      resolve({ code, peer });
    });
    peer.on('error', (e) => {
      if (!opened) reject(new Error(`signaling failed: ${e.type ?? e}`));
    });
    setTimeout(() => {
      if (!opened) reject(new Error('signaling server unreachable — try again'));
    }, 15000);
    peer.on('connection', (conn) => {
      watchIce(conn, () => cb.onLeave(conn));
      conn.on('data', (msg) => {
        if (msg && msg.t === 'hello') cb.onJoin(conn, String(msg.name ?? ''));
        else cb.onData(conn, msg);
      });
      conn.on('close', () => cb.onLeave(conn));
      conn.on('error', () => cb.onLeave(conn));
    });
  });
}

// Resolves with the open DataConnection. cb: { onMessage(msg), onClose(),
// onStatus(msg) }.
export async function joinRoom(code, name, cb) {
  cb.onStatus?.('contacting signaling server…');
  await ensurePeerJs();
  return new Promise((resolve, reject) => {
    const peer = new window.Peer(peerOptions());
    let settled = false;
    const fail = (msg) => {
      if (!settled) {
        settled = true;
        reject(new Error(msg));
      }
    };
    peer.on('error', (e) => {
      if (e?.type === 'peer-unavailable') fail('room not found — check the code');
      else fail(`connection error: ${e?.type ?? e}`);
    });
    const signalingTimeout = setTimeout(
      () => fail('signaling server unreachable — try again'),
      15000,
    );
    peer.on('open', () => {
      clearTimeout(signalingTimeout);
      cb.onStatus?.('room found — connecting to host…');
      const conn = peer.connect(PREFIX + code.trim().toUpperCase(), { reliable: true });
      watchIce(conn, () => {
        if (!settled) fail(NO_ROUTE_MSG);
        else cb.onClose();
      });
      conn.on('open', () => {
        settled = true;
        conn.send({ t: 'hello', name });
        resolve(conn);
      });
      conn.on('data', (msg) => cb.onMessage(msg));
      conn.on('error', () => fail('connection to host failed'));
      conn.on('close', () => {
        if (settled) cb.onClose();
      });
      setTimeout(() => fail(NO_ROUTE_MSG), 25000);
    });
  });
}
