// Scenario tests — one per rules edge case. Run: node --test test/unit.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ALL_IDS, CARDS, card } from '../js/deck.js';
import {
  createMatch,
  apply,
  dealRound,
  createTestState,
  IllegalActionError,
} from '../js/engine.js';
import { isPlayable, wild4Allowed, cardScore, nextPlayerIndex } from '../js/rules.js';
import { checkInvariants } from './invariants.js';

const ev = (events, type) => events.filter((e) => e.type === type);
const has = (events, type) => ev(events, type).length > 0;

// Deck where `starterId` is flipped after dealing 28 cards (4 players x 7).
function deckWithStarter(starterId) {
  const rest = ALL_IDS.filter((id) => id !== starterId);
  return [...rest.slice(0, 79), starterId, ...rest.slice(79)];
}

function freshState() {
  return createMatch(7).state; // dealer 3, first player 0
}

// ---------------------------------------------------------------- deck

test('deck has exactly the official 108-card composition', () => {
  assert.equal(ALL_IDS.length, 108);
  assert.equal(new Set(ALL_IDS).size, 108);
  for (const color of ['red', 'yellow', 'green', 'blue']) {
    const ofColor = [...CARDS.values()].filter((c) => c.color === color);
    assert.equal(ofColor.length, 25);
    assert.equal(ofColor.filter((c) => c.kind === 'number' && c.value === 0).length, 1);
    for (let v = 1; v <= 9; v++) {
      assert.equal(ofColor.filter((c) => c.kind === 'number' && c.value === v).length, 2);
    }
    for (const kind of ['skip', 'reverse', 'draw2']) {
      assert.equal(ofColor.filter((c) => c.kind === kind).length, 2);
    }
  }
  assert.equal([...CARDS.values()].filter((c) => c.kind === 'wild').length, 4);
  assert.equal([...CARDS.values()].filter((c) => c.kind === 'wild4').length, 4);
});

// ------------------------------------------------------- initial flips

test('initial flip: number — left of dealer starts, color active', () => {
  const s = freshState();
  const events = dealRound(s, deckWithStarter('r-5-a'));
  checkInvariants(s);
  assert.equal(s.phase, 'awaiting-play');
  assert.equal(s.currentPlayer, 0);
  assert.equal(s.activeColor, 'red');
  assert.equal(s.discardPile.at(-1), 'r-5-a');
  assert.ok(has(events, 'turnStarted'));
});

test('initial flip: skip — first player skipped', () => {
  const s = freshState();
  const events = dealRound(s, deckWithStarter('g-skip-a'));
  checkInvariants(s);
  assert.equal(s.currentPlayer, 1);
  assert.deepEqual(ev(events, 'skipped')[0], { type: 'skipped', player: 0 });
});

test('initial flip: reverse — direction flips, dealer plays first', () => {
  const s = freshState();
  dealRound(s, deckWithStarter('b-reverse-a'));
  checkInvariants(s);
  assert.equal(s.direction, -1);
  assert.equal(s.currentPlayer, 3); // dealer
});

test('initial flip: draw2 — first player draws 2 and is skipped', () => {
  const s = freshState();
  const events = dealRound(s, deckWithStarter('y-draw2-a'));
  checkInvariants(s);
  assert.equal(s.hands[0].length, 9);
  assert.equal(s.currentPlayer, 1);
  assert.equal(ev(events, 'cardsDrawn')[0].cardIds.length, 2);
});

test('initial flip: wild — first player chooses color, then plays', () => {
  const s = freshState();
  const events = dealRound(s, deckWithStarter('w-wild-a'));
  checkInvariants(s);
  assert.equal(s.phase, 'awaiting-initial-color');
  assert.equal(s.colorChooser, 0);
  assert.equal(s.activeColor, null);
  assert.ok(has(events, 'colorRequired'));
  const r = apply(s, { type: 'chooseColor', player: 0, color: 'blue' });
  checkInvariants(r.state);
  assert.equal(r.state.phase, 'awaiting-play');
  assert.equal(r.state.currentPlayer, 0); // chooser still plays first
  assert.equal(r.state.activeColor, 'blue');
});

test('initial flip: wild4 — returned to pile, reshuffled, reflipped', () => {
  const s = freshState();
  const events = dealRound(s, deckWithStarter('w-wild4-a'));
  checkInvariants(s);
  assert.notEqual(card(s.discardPile.at(-1)).kind, 'wild4');
  assert.ok(has(events, 'reshuffled'));
});

// ---------------------------------------------------------- legality

test('legality: color, number, and symbol matching', () => {
  const hand = ['b-7-a', 'g-3-a', 'r-skip-a', 'y-9-a'];
  // top red 7, active red
  assert.ok(isPlayable('b-7-a', 'r-7-a', 'red', hand)); // number match
  assert.ok(isPlayable('r-skip-a', 'r-7-a', 'red', hand)); // color match
  assert.ok(!isPlayable('g-3-a', 'r-7-a', 'red', hand)); // no match
  // symbol match across colors
  assert.ok(isPlayable('g-skip-a', 'r-skip-b', 'red', ['g-skip-a']));
  // wild always
  assert.ok(isPlayable('w-wild-a', 'r-7-a', 'red', hand));
});

test('legality after wild: only chosen color matters, no symbol match vs wild', () => {
  const hand = ['b-2-a', 'r-2-a'];
  assert.ok(isPlayable('b-2-a', 'w-wild-a', 'blue', hand));
  assert.ok(!isPlayable('r-2-a', 'w-wild-a', 'blue', hand));
});

test('wild4 restriction: blocked by matching color, not by matching number', () => {
  // holding a red card while red is active -> wild4 illegal
  assert.ok(!wild4Allowed(['w-wild4-a', 'r-3-a'], 'red'));
  // holding only a blue 7 (number match vs red 7 top) -> wild4 still legal
  assert.ok(wild4Allowed(['w-wild4-a', 'b-7-a'], 'red'));
  // other wilds never block
  assert.ok(wild4Allowed(['w-wild4-a', 'w-wild-a'], 'red'));

  const s = createTestState({
    hands: [['w-wild4-a', 'r-3-a', 'b-9-a'], ['g-1-a'], ['g-2-a'], ['g-4-a']],
    discardPile: ['r-7-a'],
    currentPlayer: 0,
  });
  assert.throws(
    () => apply(s, { type: 'playCard', player: 0, cardId: 'w-wild4-a' }),
    IllegalActionError,
  );
  const s2 = createTestState({
    hands: [['w-wild4-a', 'g-3-a', 'b-9-a'], ['g-1-a'], ['g-2-a'], ['g-4-a']],
    discardPile: ['r-7-a'],
    currentPlayer: 0,
  });
  const r = apply(s2, { type: 'playCard', player: 0, cardId: 'w-wild4-a' });
  checkInvariants(r.state);
  assert.equal(r.state.phase, 'awaiting-color');
  assert.equal(r.state.hands[1].length, 5); // victim drew 4
});

test('wild4 + chooseColor: victim is skipped after color choice', () => {
  const s = createTestState({
    hands: [['w-wild4-a', 'g-3-a'], ['g-1-a', 'g-5-a'], ['g-2-a'], ['g-4-a']],
    discardPile: ['r-7-a'],
    currentPlayer: 0,
  });
  let r = apply(s, { type: 'playCard', player: 0, cardId: 'w-wild4-a' });
  r = apply(r.state, { type: 'chooseColor', player: 0, color: 'green' });
  checkInvariants(r.state);
  assert.equal(r.state.activeColor, 'green');
  assert.equal(r.state.currentPlayer, 2); // player 1 skipped
});

// --------------------------------------------------------- draw rules

test('draw: playable drawn card may be played, prior cards locked', () => {
  const s = createTestState({
    hands: [['g-3-a', 'b-9-a'], ['g-1-a'], ['g-2-a'], ['g-4-a']],
    discardPile: ['r-7-a'],
    drawPileTop: ['r-2-a'], // drawn card matches red
    currentPlayer: 0,
  });
  let r = apply(s, { type: 'drawCard', player: 0 });
  checkInvariants(r.state);
  assert.equal(r.state.phase, 'awaiting-play-drawn');
  assert.equal(r.state.drawnCardId, 'r-2-a');
  // prior hand cards are locked
  assert.throws(
    () => apply(r.state, { type: 'playCard', player: 0, cardId: 'g-3-a' }),
    IllegalActionError,
  );
  r = apply(r.state, { type: 'playDrawn', player: 0 });
  checkInvariants(r.state);
  assert.equal(r.state.discardPile.at(-1), 'r-2-a');
  assert.equal(r.state.currentPlayer, 1);
});

test('draw: keepDrawn passes the turn', () => {
  const s = createTestState({
    hands: [['g-3-a', 'b-9-a'], ['g-1-a'], ['g-2-a'], ['g-4-a']],
    discardPile: ['r-7-a'],
    drawPileTop: ['r-2-a'],
    currentPlayer: 0,
  });
  let r = apply(s, { type: 'drawCard', player: 0 });
  r = apply(r.state, { type: 'keepDrawn', player: 0 });
  checkInvariants(r.state);
  assert.equal(r.state.currentPlayer, 1);
  assert.ok(r.state.hands[0].includes('r-2-a'));
});

test('draw: unplayable drawn card auto-passes the turn', () => {
  const s = createTestState({
    hands: [['g-3-a'], ['g-1-a'], ['g-2-a'], ['g-4-a']],
    discardPile: ['r-7-a'],
    drawPileTop: ['b-2-a'], // no match vs red 7
    currentPlayer: 0,
  });
  const r = apply(s, { type: 'drawCard', player: 0 });
  checkInvariants(r.state);
  assert.equal(r.state.phase, 'awaiting-play');
  assert.equal(r.state.currentPlayer, 1);
});

// ----------------------------------------------- reshuffle / exhaustion

test('reshuffle mid-Draw-Two: discard recycles, wild keeps no color', () => {
  // Build full coverage by hand: p0 plays draw2, draw pile has exactly 1 card.
  const p0 = ['r-draw2-a', 'r-9-a'];
  const others = ['g-1-a', 'g-2-a', 'g-4-a'];
  const drawTop = ['b-2-a'];
  const fixed = new Set([...p0, ...others, ...drawTop]);
  // every remaining card goes under the discard top (w-wild-a among them)
  const bottom = ALL_IDS.filter((id) => !fixed.has(id) && id !== 'r-7-a');
  const s = createTestState({
    hands: [p0, [others[0]], [others[1]], [others[2]]],
    discardPile: [...bottom, 'r-7-a'],
    drawPileTop: drawTop,
    currentPlayer: 0,
  });
  assert.equal(s.drawPile.length, 1);
  const r = apply(s, { type: 'playCard', player: 0, cardId: 'r-draw2-a' });
  checkInvariants(r.state);
  assert.ok(has(r.events, 'reshuffled'));
  assert.equal(r.state.hands[1].length, 3); // victim 1 + 2
  assert.equal(r.state.discardPile.length, 1);
  assert.equal(r.state.discardPile[0], 'r-draw2-a');
  assert.ok(r.state.drawPile.includes('w-wild-a')); // recycled wild
  assert.equal(card('w-wild-a').color, null); // carries no stale color
  assert.equal(r.state.activeColor, 'red');
  assert.equal(r.state.currentPlayer, 2); // victim skipped
});

test('both piles dry: draws skip, full stalled cycle ends the round', () => {
  // all 108 cards in hands except a single discard card
  const discard = ['r-7-a'];
  const rest = ALL_IDS.filter((id) => id !== 'r-7-a'); // 107
  const hands = [rest.slice(0, 27), rest.slice(27, 54), rest.slice(54, 81), rest.slice(81)];
  let s = createTestState({ hands, discardPile: discard, currentPlayer: 0 });
  assert.equal(s.drawPile.length, 0);
  let stalledOver = false;
  for (let i = 0; i < 4; i++) {
    const r = apply(s, { type: 'drawCard', player: s.currentPlayer });
    checkInvariants(r.state);
    assert.ok(has(r.events, 'drawSkipped'));
    s = r.state;
    if (has(r.events, 'roundOver')) {
      assert.ok(ev(r.events, 'roundOver')[0].stalled);
      stalledOver = true;
      break;
    }
  }
  assert.ok(stalledOver, 'round must end stalled after a full dry cycle');
});

// ----------------------------------------------------------- winning

test('win with Draw Two as last card: victim still draws, round over', () => {
  const s = createTestState({
    hands: [['r-draw2-a'], ['g-1-a'], ['g-2-a'], ['g-4-a']],
    discardPile: ['r-7-a'],
    currentPlayer: 0,
  });
  const r = apply(s, { type: 'playCard', player: 0, cardId: 'r-draw2-a' });
  checkInvariants(r.state);
  assert.equal(r.state.phase, 'round-over');
  assert.equal(r.state.roundWinner, 0);
  assert.equal(r.state.hands[1].length, 3); // drew 2 before round ended
  const expected =
    r.state.hands[1].reduce((a, id) => a + cardScore(id), 0) +
    cardScore('g-2-a') +
    cardScore('g-4-a');
  assert.equal(r.state.scores[0], expected);
});

test('win with Wild Draw Four as last card: no color choice, victim draws 4', () => {
  const s = createTestState({
    hands: [['w-wild4-a'], ['g-1-a'], ['g-2-a'], ['g-4-a']],
    discardPile: ['r-7-a'],
    currentPlayer: 0,
  });
  const r = apply(s, { type: 'playCard', player: 0, cardId: 'w-wild4-a' });
  checkInvariants(r.state);
  assert.equal(r.state.phase, 'round-over');
  assert.ok(!has(r.events, 'colorRequired'));
  assert.equal(r.state.hands[1].length, 5);
});

test('win with plain Wild as last card: round over immediately', () => {
  const s = createTestState({
    hands: [['w-wild-a'], ['g-1-a'], ['g-2-a'], ['g-4-a']],
    discardPile: ['r-7-a'],
    currentPlayer: 0,
  });
  const r = apply(s, { type: 'playCard', player: 0, cardId: 'w-wild-a' });
  checkInvariants(r.state);
  assert.equal(r.state.phase, 'round-over');
  assert.ok(!has(r.events, 'colorRequired'));
});

test('match ends at 500 and newMatch resets', () => {
  const s = createTestState({
    hands: [['r-draw2-a'], ['w-wild4-a', 'w-wild4-b'], ['b-skip-a'], ['g-4-a']],
    discardPile: ['r-7-a'],
    currentPlayer: 0,
    scores: [480, 0, 0, 0],
  });
  const r = apply(s, { type: 'playCard', player: 0, cardId: 'r-draw2-a' });
  checkInvariants(r.state);
  assert.equal(r.state.phase, 'match-over');
  assert.equal(r.state.matchWinner, 0);
  assert.throws(() => apply(r.state, { type: 'startNextRound' }), IllegalActionError);
  const m = apply(r.state, { type: 'newMatch' });
  checkInvariants(m.state);
  assert.deepEqual(m.state.scores, [0, 0, 0, 0]);
  assert.equal(m.state.matchWinner, null);
});

// --------------------------------------------------------------- UNO

function unoSetup() {
  return createTestState({
    hands: [['r-1-a', 'r-2-a'], ['g-1-a', 'g-2-b'], ['g-2-a'], ['g-4-a']],
    discardPile: ['r-7-a'],
    currentPlayer: 0,
  });
}

test('uno: declare at 2 cards, play to 1 — safe', () => {
  let r = apply(unoSetup(), { type: 'callUno', player: 0 });
  assert.ok(has(r.events, 'unoArmed'));
  r = apply(r.state, { type: 'playCard', player: 0, cardId: 'r-1-a' });
  checkInvariants(r.state);
  assert.ok(has(r.events, 'unoDeclared'));
  assert.equal(r.state.uno.vulnerable, null);
});

test('uno: no declaration -> vulnerable; catch costs 2 cards', () => {
  let r = apply(unoSetup(), { type: 'playCard', player: 0, cardId: 'r-1-a' });
  assert.equal(r.state.uno.vulnerable, 0);
  r = apply(r.state, { type: 'catchUno', player: 2, target: 0 });
  checkInvariants(r.state);
  assert.equal(r.state.uno.vulnerable, null);
  assert.equal(r.state.hands[0].length, 3); // 1 + 2 penalty
  assert.equal(r.state.currentPlayer, 1); // turn order untouched
});

test('uno: window closes when the next player acts', () => {
  let r = apply(unoSetup(), { type: 'playCard', player: 0, cardId: 'r-1-a' });
  assert.equal(r.state.uno.vulnerable, 0);
  r = apply(r.state, { type: 'drawCard', player: 1 });
  checkInvariants(r.state);
  assert.ok(has(r.events, 'unoWindowClosed'));
  assert.equal(r.state.uno.vulnerable, null);
  // too late now
  assert.throws(() => apply(r.state, { type: 'catchUno', player: 2, target: 0 }), IllegalActionError);
});

test('uno: vulnerable player can self-rescue with a late call', () => {
  let r = apply(unoSetup(), { type: 'playCard', player: 0, cardId: 'r-1-a' });
  r = apply(r.state, { type: 'callUno', player: 0 });
  checkInvariants(r.state);
  assert.ok(has(r.events, 'unoDeclared'));
  assert.equal(r.state.uno.vulnerable, null);
});

test('uno: illegal calls and catches throw', () => {
  const s = createTestState({
    hands: [['r-1-a', 'r-2-a', 'r-3-a', 'r-4-a', 'r-5-a'], ['g-1-a'], ['g-2-a'], ['g-4-a']],
    discardPile: ['r-7-a'],
    currentPlayer: 0,
  });
  assert.throws(() => apply(s, { type: 'callUno', player: 0 }), IllegalActionError); // 5 cards
  assert.throws(() => apply(s, { type: 'catchUno', player: 2, target: 1 }), IllegalActionError); // not vulnerable
});

// ---------------------------------------------------- reverse / 2 players

test('reverse flips direction with 4 players', () => {
  const s = createTestState({
    hands: [['r-reverse-a', 'r-2-a'], ['g-1-a'], ['g-2-a'], ['g-4-a']],
    discardPile: ['r-7-a'],
    currentPlayer: 0,
  });
  const r = apply(s, { type: 'playCard', player: 0, cardId: 'r-reverse-a' });
  checkInvariants(r.state);
  assert.equal(r.state.direction, -1);
  assert.equal(r.state.currentPlayer, 3);
});

test('reverse acts as skip with 2 players', () => {
  const s = createTestState({
    playerNames: ['YOU', 'NOVA'],
    hands: [['r-reverse-a', 'r-2-a'], ['g-1-a', 'g-2-a']],
    discardPile: ['r-7-a'],
    currentPlayer: 0,
  });
  const r = apply(s, { type: 'playCard', player: 0, cardId: 'r-reverse-a' });
  checkInvariants(r.state);
  assert.ok(has(r.events, 'skipped'));
  assert.equal(r.state.currentPlayer, 0); // plays again
});

// ------------------------------------------------------------ guards

test('turn and ownership guards throw', () => {
  const s = unoSetup();
  assert.throws(() => apply(s, { type: 'playCard', player: 1, cardId: 'g-1-a' }), IllegalActionError);
  assert.throws(() => apply(s, { type: 'playCard', player: 0, cardId: 'g-1-a' }), IllegalActionError);
  assert.throws(() => apply(s, { type: 'drawCard', player: 2 }), IllegalActionError);
  assert.throws(() => apply(s, { type: 'chooseColor', player: 0, color: 'red' }), IllegalActionError);
  assert.throws(() => apply(s, { type: 'nonsense' }), IllegalActionError);
});

test('apply never mutates its input (success and failure)', () => {
  const s = unoSetup();
  const before = JSON.stringify(s);
  apply(s, { type: 'playCard', player: 0, cardId: 'r-1-a' });
  assert.equal(JSON.stringify(s), before);
  try {
    apply(s, { type: 'playCard', player: 1, cardId: 'g-1-a' });
  } catch {
    /* expected */
  }
  assert.equal(JSON.stringify(s), before);
});

test('scoring table: number face value, actions 20, wilds 50', () => {
  assert.equal(cardScore('r-0-a'), 0);
  assert.equal(cardScore('b-9-b'), 9);
  assert.equal(cardScore('g-skip-a'), 20);
  assert.equal(cardScore('y-reverse-b'), 20);
  assert.equal(cardScore('r-draw2-a'), 20);
  assert.equal(cardScore('w-wild-a'), 50);
  assert.equal(cardScore('w-wild4-c'), 50);
});

test('createMatch is deterministic per seed', () => {
  const a = createMatch(123);
  const b = createMatch(123);
  assert.equal(JSON.stringify(a.state), JSON.stringify(b.state));
  assert.notEqual(JSON.stringify(createMatch(124).state), JSON.stringify(a.state));
});

test('nextPlayerIndex wraps in both directions', () => {
  assert.equal(nextPlayerIndex(3, 1, 4), 0);
  assert.equal(nextPlayerIndex(0, -1, 4), 3);
  assert.equal(nextPlayerIndex(1, 1, 2), 0);
});
