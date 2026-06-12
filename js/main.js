// Controller: the single dispatch path into the engine, AI pacing, and the
// timed UNO catch windows. busy-flag serialization + clear-all-timers after
// every dispatch means stale timers can never act on a stale state; the
// engine throwing on illegal actions is the last line of defense.

import { createMatch, apply, IllegalActionError } from './engine.js';
import { makeView, chooseAction } from './ai.js';
import { createRng } from './rng.js';
import { AI_TUNING, TIMING } from './constants.js';
import * as ui from './ui.js';

let state = null;
let busy = false;
let timers = [];

const aiRng = createRng((Math.random() * 0xffffffff) >>> 0);
const rand = (a, b) => a + Math.random() * (b - a);

function later(fn, ms) {
  timers.push(setTimeout(fn, ms));
}

function clearTimers() {
  timers.forEach(clearTimeout);
  timers = [];
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
      // Stale timer or late click — drop it and re-arm the loop.
      scheduleNext();
      return false;
    }
    throw e;
  }
  state = result.state;
  try {
    await ui.playEvents(result.events, state);
  } finally {
    busy = false;
  }
  scheduleNext();
  return true;
}

function scheduleNext() {
  clearTimers();
  const s = state;
  if (!s || s.phase === 'round-over' || s.phase === 'match-over') return;

  const v = s.uno.vulnerable;

  // A forgetful AI may notice and rescue itself before anyone pounces.
  if (v !== null && v !== 0 && Math.random() < TIMING.AI_SELF_RESCUE_PROB) {
    later(
      () => dispatch({ type: 'callUno', player: v }),
      TIMING.AI_SELF_RESCUE_AT + rand(0, 600),
    );
  }

  const actor = actorOf(s);
  if (actor === 0) {
    if (s.phase === 'awaiting-play-drawn') {
      later(() => dispatch({ type: 'keepDrawn', player: 0 }), TIMING.AUTO_KEEP_MS);
    }
    return; // human acts through the UI
  }

  let delay = rand(TIMING.AI_THINK_MIN, TIMING.AI_THINK_MAX);
  if (v === 0) {
    // Give the human a real window to press UNO — and a real risk.
    delay = Math.max(delay, TIMING.HUMAN_UNO_GRACE);
    if (Math.random() < TIMING.CATCH_PROB) {
      const catcher = 1 + Math.floor(Math.random() * (s.players.length - 1));
      later(
        () => dispatch({ type: 'catchUno', player: catcher, target: 0 }),
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
  if (actor === 0) return;
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

function startMatch() {
  clearTimers();
  const seed = (Date.now() ^ ((Math.random() * 0xffffffff) | 0)) >>> 0;
  const { state: s, events } = createMatch(seed);
  state = s;
  busy = true;
  ui.playEvents(events, state).finally(() => {
    busy = false;
    scheduleNext();
  });
}

ui.init({
  onStart: startMatch,
  onPlayCard: (id) => dispatch({ type: 'playCard', player: 0, cardId: id }),
  onDraw: () => dispatch({ type: 'drawCard', player: 0 }),
  onPlayDrawn: () => dispatch({ type: 'playDrawn', player: 0 }),
  onKeepDrawn: () => dispatch({ type: 'keepDrawn', player: 0 }),
  onChooseColor: (color) => dispatch({ type: 'chooseColor', player: 0, color }),
  onUno: () => dispatch({ type: 'callUno', player: 0 }),
  onCatch: () => {
    const t = state?.uno.vulnerable;
    if (t !== null && t !== undefined && t !== 0) {
      dispatch({ type: 'catchUno', player: 0, target: t });
    }
  },
  onNextRound: () => dispatch({ type: 'startNextRound' }),
  onNewMatch: () => dispatch({ type: 'newMatch' }),
});

ui.showStartScreen();
