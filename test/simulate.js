// Headless fuzz harness: N complete AI-vs-AI matches with invariants
// checked after EVERY action, plus illegal-action fuzzing and determinism
// replay. Usage: node test/simulate.js [matches]

import { createMatch, apply, IllegalActionError } from '../js/engine.js';
import { makeView, chooseAction, shouldDeclareUno } from '../js/ai.js';
import { createRng, nextFloat, nextInt } from '../js/rng.js';
import { handScore } from '../js/rules.js';
import { checkInvariants } from './invariants.js';

const N = Number.parseInt(process.argv[2] ?? '1000', 10);
const MAX_ACTIONS_PER_MATCH = 100000;
const MAX_ROUNDS_PER_MATCH = 200;

let totalActions = 0;
let totalRounds = 0;
let stalledRounds = 0;
let reshuffles = 0;
let fuzzChecks = 0;
let catches = 0;

function projection(state) {
  // Compact state fingerprint (excludes actionLog) for purity checks.
  return JSON.stringify({
    hands: state.hands,
    drawPile: state.drawPile,
    discardPile: state.discardPile,
    currentPlayer: state.currentPlayer,
    direction: state.direction,
    activeColor: state.activeColor,
    phase: state.phase,
    colorChooser: state.colorChooser,
    drawnCardId: state.drawnCardId,
    uno: state.uno,
    dealer: state.dealer,
    scores: state.scores,
    rng: state.rng,
    turnCount: state.turnCount,
    stalledTurns: state.stalledTurns,
  });
}

function fuzzIllegal(state, simRng) {
  fuzzChecks++;
  const before = projection(state);
  const wrongPlayer = (state.currentPlayer + 1) % state.players.length;
  const candidates = [
    { type: 'playCard', player: wrongPlayer, cardId: state.hands[wrongPlayer][0] },
    { type: 'drawCard', player: wrongPlayer },
    { type: 'chooseColor', player: state.currentPlayer, color: 'red' },
    { type: 'catchUno', player: 0, target: (state.uno.vulnerable === null ? 1 : (state.uno.vulnerable + 1) % 4) },
    { type: 'playCard', player: state.currentPlayer, cardId: 'r-0-a-bogus' },
    { type: 'startNextRound' },
    { type: 'bogusAction' },
  ];
  const action = candidates[nextInt(simRng, candidates.length)];
  // Skip combos that could accidentally be legal.
  if (action.type === 'chooseColor' && (state.phase === 'awaiting-color' || state.phase === 'awaiting-initial-color')) return;
  if (action.type === 'startNextRound' && state.phase === 'round-over') return;
  if (action.type === 'playCard' && action.cardId === undefined) return;
  let threw = false;
  try {
    apply(state, action);
  } catch (e) {
    if (!(e instanceof IllegalActionError)) throw e;
    threw = true;
  }
  if (!threw) throw new Error(`fuzz: illegal action did not throw: ${JSON.stringify(action)}`);
  if (projection(state) !== before) throw new Error('fuzz: state mutated by rejected action');
}

function step(state, simRng) {
  // Returns { state, events } after one driver decision.
  // 1. Occasionally exercise the UNO catch/self-rescue paths.
  if (state.uno.vulnerable !== null) {
    const r = nextFloat(simRng);
    if (r < 0.4) {
      return apply(state, { type: 'callUno', player: state.uno.vulnerable });
    }
    if (r < 0.7) {
      let catcher = nextInt(simRng, state.players.length);
      if (catcher === state.uno.vulnerable) catcher = (catcher + 1) % state.players.length;
      catches++;
      return apply(state, { type: 'catchUno', player: catcher, target: state.uno.vulnerable });
    }
  }
  if (state.phase === 'round-over') {
    return apply(state, { type: 'startNextRound' });
  }
  const actor =
    state.phase === 'awaiting-color' || state.phase === 'awaiting-initial-color'
      ? state.colorChooser
      : state.currentPlayer;
  // 2. Declare UNO at 2 cards (90% of the time), like the live controller does.
  if (
    state.phase === 'awaiting-play' &&
    state.hands[actor].length === 2 &&
    !state.uno.declared[actor] &&
    shouldDeclareUno(simRng)
  ) {
    return apply(state, { type: 'callUno', player: actor });
  }
  return apply(state, chooseAction(makeView(state, actor), simRng));
}

function runMatch(seed, collectLog = false) {
  const simRng = createRng((seed * 2654435761) >>> 0);
  let { state } = createMatch(seed);
  checkInvariants(state);
  let actions = 0;
  let rounds = 1;
  while (state.phase !== 'match-over') {
    if (++actions > MAX_ACTIONS_PER_MATCH) throw new Error(`match ${seed}: action limit exceeded`);
    const preScores = state.scores.slice();
    if (actions % 37 === 0) fuzzIllegal(state, simRng);
    const result = step(state, simRng);
    state = result.state;
    checkInvariants(state);
    for (const ev of result.events) {
      if (ev.type === 'reshuffled') reshuffles++;
      if (ev.type === 'roundOver') {
        rounds++;
        totalRounds++;
        if (ev.stalled) stalledRounds++;
        if (rounds > MAX_ROUNDS_PER_MATCH) throw new Error(`match ${seed}: round limit exceeded`);
        // Independent score verification.
        const expected = state.hands.reduce(
          (sum, h, i) => (i === ev.winner ? sum : sum + handScore(h)),
          0,
        );
        if (ev.points !== expected) {
          throw new Error(`match ${seed}: roundOver points ${ev.points} != recomputed ${expected}`);
        }
        if (state.scores[ev.winner] - preScores[ev.winner] !== ev.points) {
          throw new Error(`match ${seed}: score delta mismatch`);
        }
      }
    }
  }
  totalActions += actions;
  return collectLog ? JSON.stringify({ log: state.actionLog, fin: projection(state) }) : null;
}

console.log(`simulating ${N} full matches...`);
const t0 = process.hrtime.bigint();
for (let seed = 0; seed < N; seed++) {
  runMatch(seed);
  if ((seed + 1) % 1000 === 0) console.log(`  ${seed + 1}/${N} ok`);
}

// Determinism: same seed twice -> byte-identical action log + final state.
const replaySeeds = Math.min(N, 25);
for (let seed = 0; seed < replaySeeds; seed++) {
  const a = runMatch(seed, true);
  const b = runMatch(seed, true);
  if (a !== b) throw new Error(`determinism violated for seed ${seed}`);
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

console.log(`\nALL GREEN`);
console.log(`  matches:        ${N} (+${replaySeeds * 2} determinism replays)`);
console.log(`  rounds:         ${totalRounds} (${stalledRounds} stalled deadlocks)`);
console.log(`  actions:        ${totalActions}`);
console.log(`  reshuffles:     ${reshuffles}`);
console.log(`  uno catches:    ${catches}`);
console.log(`  fuzz checks:    ${fuzzChecks} (all rejected cleanly)`);
console.log(`  time:           ${ms.toFixed(0)}ms`);
