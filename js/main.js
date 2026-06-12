// Controller. Three modes sharing one UI:
//  - solo: local engine, 3 AI seats
//  - host: local engine is authoritative; guests' actions arrive over WebRTC,
//          every accepted action is broadcast back as redacted events+state
//  - guest: render-only mirror; sends actions, never runs the engine
// Single dispatch path with a busy flag; all timers cleared after every
// dispatch; the engine throwing on illegal actions is the last line of
// defense against stale timers and late clicks.

import { createMatch, apply, IllegalActionError } from './engine.js';
import { makeView, chooseAction } from './ai.js';
import { createRng } from './rng.js';
import { AI_TUNING, TIMING, PLAYER_NAMES } from './constants.js';
import * as ui from './ui.js';
import { hostRoom, joinRoom } from './net.js';

const rand = (a, b) => a + Math.random() * (b - a);
const REMOTE_TYPES = new Set([
  'playCard',
  'drawCard',
  'playDrawn',
  'keepDrawn',
  'chooseColor',
  'callUno',
  'catchUno',
]);

// ------------------------------------------------------------- redaction

const HIDDEN = 'hidden';

function redactState(s, seat) {
  return {
    ...s,
    hands: s.hands.map((h, i) => (i === seat ? h : h.map(() => HIDDEN))),
    drawPile: s.drawPile.map(() => HIDDEN),
    drawnCardId: s.currentPlayer === seat ? s.drawnCardId : null,
    actionLog: [],
    rng: { s: 0 },
  };
}

function redactEvents(events, seat) {
  return events.map((ev) => {
    if (ev.type === 'cardsDrawn' && ev.player !== seat) {
      return { ...ev, cardIds: ev.cardIds.map(() => HIDDEN) };
    }
    if (ev.type === 'roundDealt') {
      return { ...ev, hands: ev.hands.map((h, i) => (i === seat ? h : h.map(() => HIDDEN))) };
    }
    if (ev.type === 'drawnPlayable' && ev.player !== seat) {
      return { ...ev, cardId: HIDDEN };
    }
    return ev;
  });
}

// ---------------------------------------------------------- host session
// roomCode === null -> solo. guests: Map<seat, {conn, name}> (host-mode).

function makeHostSession({ roomCode = null, hostName = 'YOU', guests = new Map() } = {}) {
  let state = null;
  let busy = false;
  let timers = [];
  const remoteQueue = [];
  const aiRng = createRng((Math.random() * 0xffffffff) >>> 0);

  const humanSet = () => new Set([0, ...guests.keys()]);
  const aiSeats = () => [0, 1, 2, 3].filter((p) => !humanSet().has(p));

  function later(fn, ms) {
    timers.push(setTimeout(fn, ms));
  }

  function clearTimers() {
    timers.forEach(clearTimeout);
    timers = [];
  }

  function broadcast(events) {
    for (const [seat, g] of guests) {
      try {
        g.conn.send({
          t: 'step',
          events: redactEvents(events, seat),
          state: redactState(state, seat),
        });
      } catch {
        /* connection died; onLeave will clean up */
      }
    }
  }

  function actorOf(s) {
    return s.phase === 'awaiting-color' || s.phase === 'awaiting-initial-color'
      ? s.colorChooser
      : s.currentPlayer;
  }

  async function dispatch(action) {
    if (busy || !state) return false;
    busy = true;
    let result;
    try {
      result = apply(state, action);
    } catch (e) {
      busy = false;
      if (e instanceof IllegalActionError) {
        if (!drainRemote()) scheduleNext();
        return false;
      }
      throw e;
    }
    state = result.state;
    broadcast(result.events); // guests animate in parallel with the host
    try {
      await ui.playEvents(result.events, state);
    } finally {
      busy = false;
    }
    if (!drainRemote()) scheduleNext();
    return true;
  }

  function drainRemote() {
    const action = remoteQueue.shift();
    if (!action) return false;
    dispatch(action);
    return true;
  }

  function scheduleNext() {
    clearTimers();
    const s = state;
    if (!s || s.phase === 'round-over' || s.phase === 'match-over') return;

    const humans = humanSet();
    const v = s.uno.vulnerable;

    // A forgetful AI may notice and rescue itself before anyone pounces.
    if (v !== null && !humans.has(v) && Math.random() < TIMING.AI_SELF_RESCUE_PROB) {
      later(
        () => dispatch({ type: 'callUno', player: v }),
        TIMING.AI_SELF_RESCUE_AT + rand(0, 600),
      );
    }

    const actor = actorOf(s);
    if (humans.has(actor)) {
      // humans act through their UI; keep the game moving on the drawn-card
      // prompt either way
      if (s.phase === 'awaiting-play-drawn') {
        later(() => dispatch({ type: 'keepDrawn', player: actor }), TIMING.AUTO_KEEP_MS);
      }
      return;
    }

    let delay = rand(TIMING.AI_THINK_MIN, TIMING.AI_THINK_MAX);
    if (v !== null && humans.has(v)) {
      // give the vulnerable human a real window to press UNO — and a risk
      delay = Math.max(delay, TIMING.HUMAN_UNO_GRACE);
      const pool = aiSeats().filter((p) => p !== v);
      if (pool.length && Math.random() < TIMING.CATCH_PROB) {
        const catcher = pool[Math.floor(Math.random() * pool.length)];
        later(
          () => dispatch({ type: 'catchUno', player: catcher, target: v }),
          rand(TIMING.CATCH_MIN, TIMING.CATCH_MAX),
        );
      }
    }
    later(aiAct, delay);
  }

  async function aiAct() {
    const s = state;
    if (!s || s.phase === 'round-over' || s.phase === 'match-over') return;
    const actor = actorOf(s);
    if (humanSet().has(actor)) return;
    if (
      s.phase === 'awaiting-play' &&
      s.hands[actor].length === 2 &&
      !s.uno.declared[actor] &&
      Math.random() < AI_TUNING.DECLARE_UNO_PROB
    ) {
      await dispatch({ type: 'callUno', player: actor });
      return; // dispatch's scheduleNext queues the actual play
    }
    await dispatch(chooseAction(makeView(s, actor), aiRng));
  }

  function start() {
    clearTimers();
    const names = [hostName.toUpperCase(), null, null, null];
    const aiNames = PLAYER_NAMES.slice(1);
    for (const [seat, g] of guests) names[seat] = g.name.toUpperCase() || `P${seat + 1}`;
    for (let p = 1; p < 4; p++) if (!names[p]) names[p] = aiNames.shift();

    const seed = (Date.now() ^ ((Math.random() * 0xffffffff) | 0)) >>> 0;
    const { state: s, events } = createMatch(seed, names);
    state = s;
    for (const [seat, g] of guests) {
      g.conn.send({
        t: 'start',
        seat,
        names,
        events: redactEvents(events, seat),
        state: redactState(state, seat),
      });
    }
    ui.setPerspective(0, names);
    busy = true;
    ui.playEvents(events, state).finally(() => {
      busy = false;
      if (!drainRemote()) scheduleNext();
    });
  }

  return {
    isDriver: true,
    act(partial) {
      dispatch({ ...partial, player: partial.player ?? 0 });
    },
    catchTarget() {
      return state?.uno.vulnerable;
    },
    nextRound() {
      dispatch({ type: 'startNextRound' });
    },
    newMatch() {
      dispatch({ type: 'newMatch' });
    },
    start,
    acceptRemote(seat, action) {
      if (!action || !REMOTE_TYPES.has(action.type)) return;
      if (action.player !== seat) return; // no spoofing other seats
      remoteQueue.push(action);
      if (!busy) drainRemote();
    },
    guestLeft(seat, name) {
      ui.toast(`${name} disconnected — AI takes over`, 'var(--neon-yellow)');
      if (!busy) scheduleNext();
    },
    started: () => state !== null,
    roomCode,
  };
}

// --------------------------------------------------------- guest session

function makeGuestSession(code, name) {
  let conn = null;
  let seat = null;
  let lastState = null;
  let chain = Promise.resolve();

  ui.lobbyError('connecting…');

  function enqueue(events, state) {
    lastState = state;
    chain = chain
      .then(() => ui.playEvents(events, state))
      .catch((e) => console.error(e));
  }

  joinRoom(code, name, {
    onStatus(msg) {
      ui.lobbyError(msg);
    },
    onMessage(msg) {
      if (!msg) return;
      if (msg.t === 'lobby') ui.showGuestLobby(code, msg.names);
      else if (msg.t === 'full') ui.lobbyError('room is full');
      else if (msg.t === 'started') ui.lobbyError('that game already started');
      else if (msg.t === 'start') {
        seat = msg.seat;
        ui.setPerspective(seat, msg.names);
        enqueue(msg.events, msg.state);
      } else if (msg.t === 'step') {
        enqueue(msg.events, msg.state);
      }
    },
    onClose() {
      ui.showFatal('the host left the room');
    },
  })
    .then((c) => {
      conn = c;
    })
    .catch((e) => ui.lobbyError(String(e.message ?? e)));

  function send(partial) {
    if (conn && seat !== null) {
      conn.send({ t: 'act', action: { ...partial, player: seat } });
    }
  }

  return {
    isDriver: false,
    act: send,
    catchTarget() {
      return lastState?.uno.vulnerable;
    },
    nextRound() {},
    newMatch() {},
  };
}

// ------------------------------------------------------------ mode router

let session = null;

async function hostOnline(name) {
  const guests = new Map();
  let hostApi = null;

  function lobbyNames() {
    return [name.toUpperCase(), ...[...guests.values()].map((g) => g.name.toUpperCase())];
  }

  function refreshLobby() {
    ui.showHostLobby(hostApi.roomCode, lobbyNames(), guests.size >= 1);
    for (const [, g] of guests) {
      try {
        g.conn.send({ t: 'lobby', names: lobbyNames() });
      } catch {
        /* ignore */
      }
    }
  }

  try {
    const { code } = await hostRoom({
      onStatus(msg) {
        ui.lobbyError(msg);
      },
      onJoin(conn, guestName) {
        const started = hostApi?.started() ?? false;
        if (started || guests.size >= 3) {
          conn.send({ t: started ? 'started' : 'full' });
          setTimeout(() => conn.close(), 300);
          return;
        }
        let seat = 1;
        while (guests.has(seat)) seat++;
        conn.seat = seat;
        guests.set(seat, { conn, name: (guestName || `P${seat + 1}`).slice(0, 12) });
        refreshLobby();
      },
      onData(conn, msg) {
        if (msg?.t === 'act') hostApi?.acceptRemote(conn.seat, msg.action);
      },
      onLeave(conn) {
        const seat = conn.seat;
        if (seat === undefined || !guests.has(seat)) return;
        const g = guests.get(seat);
        guests.delete(seat);
        if (hostApi?.started()) hostApi.guestLeft(seat, g.name);
        else if (hostApi) refreshLobby();
      },
    });
    hostApi = makeHostSession({ roomCode: code, hostName: name, guests });
    session = hostApi;
    refreshLobby();
  } catch (e) {
    ui.lobbyError(`could not open a room: ${e.message ?? e}`);
  }
}

ui.init({
  onStart: () => {
    session = makeHostSession();
    session.start();
  },
  onHost: (name) => hostOnline(name),
  onJoin: (code, name) => {
    session = makeGuestSession(code, name);
  },
  onLobbyStart: () => session?.start?.(),
  isDriver: () => session?.isDriver ?? true,
  onPlayCard: (id) => session?.act({ type: 'playCard', cardId: id }),
  onDraw: () => session?.act({ type: 'drawCard' }),
  onPlayDrawn: () => session?.act({ type: 'playDrawn' }),
  onKeepDrawn: () => session?.act({ type: 'keepDrawn' }),
  onChooseColor: (color) => session?.act({ type: 'chooseColor', color }),
  onUno: () => session?.act({ type: 'callUno' }),
  onCatch: () => {
    const t = session?.catchTarget();
    if (t !== null && t !== undefined) session.act({ type: 'catchUno', target: t });
  },
  onNextRound: () => session?.nextRound(),
  onNewMatch: () => session?.newMatch(),
});

ui.showStartScreen();

// Old browsers (pre-2023) miss the CSS this game leans on — warn instead of
// rendering garbage silently.
if (
  !CSS.supports('color', 'color-mix(in oklch, red 50%, black)') ||
  !CSS.supports('width', 'calc(cos(0deg) * 1px)')
) {
  ui.lobbyError('your browser is too old for this game — update it if things look broken');
}
