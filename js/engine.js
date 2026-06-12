// Pure, time-free UNO rules engine. apply(state, action) -> { state, events }.
// Never mutates its input; illegal actions throw IllegalActionError.
// No DOM, no timers, no Math.random — all randomness flows through state.rng.

import { ALL_IDS, card } from './deck.js';
import { COLORS, HAND_SIZE, TARGET_SCORE, UNO_PENALTY, PLAYER_NAMES } from './constants.js';
import { createRng, shuffle } from './rng.js';
import { isPlayable, nextPlayerIndex, handScore } from './rules.js';

export class IllegalActionError extends Error {}

function fail(msg) {
  throw new IllegalActionError(msg);
}

function top(s) {
  return s.discardPile[s.discardPile.length - 1];
}

function playerCount(s) {
  return s.players.length;
}

export function createMatch(seed, playerNames = PLAYER_NAMES) {
  const state = {
    players: playerNames.map((name, i) => ({ name, isHuman: i === 0 })),
    hands: playerNames.map(() => []),
    drawPile: [],
    discardPile: [],
    currentPlayer: 0,
    direction: 1,
    activeColor: null,
    phase: 'round-over',
    colorChooser: null,
    drawnCardId: null,
    uno: { declared: playerNames.map(() => false), vulnerable: null },
    dealer: playerNames.length - 1, // human sits left of dealer -> acts first in round 1
    scores: playerNames.map(() => 0),
    roundWinner: null,
    matchWinner: null,
    rng: createRng(seed),
    actionLog: [],
    turnCount: 0,
    stalledTurns: 0,
  };
  const events = dealRound(state);
  return { state, events };
}

// Mutating internal helper (also exported for unit tests with deckOverride).
export function dealRound(state, deckOverride = null) {
  const events = [];
  const n = playerCount(state);
  state.hands = state.players.map(() => []);
  state.drawPile = deckOverride ? deckOverride.slice() : shuffle(ALL_IDS.slice(), state.rng);
  state.discardPile = [];
  state.direction = 1;
  state.activeColor = null;
  state.colorChooser = null;
  state.drawnCardId = null;
  state.uno = { declared: state.players.map(() => false), vulnerable: null };
  state.roundWinner = null;
  state.turnCount = 0;
  state.stalledTurns = 0;
  state.phase = 'awaiting-play';

  const first = nextPlayerIndex(state.dealer, 1, n);
  for (let r = 0; r < HAND_SIZE; r++) {
    for (let k = 0; k < n; k++) {
      const p = (first + k) % n;
      state.hands[p].push(state.drawPile.pop());
    }
  }
  events.push({
    type: 'roundDealt',
    dealer: state.dealer,
    hands: state.hands.map((h) => h.slice()),
  });

  // Flip the starter; a Wild Draw Four goes back in and we reshuffle-reflip.
  let starter = state.drawPile.pop();
  while (card(starter).kind === 'wild4') {
    state.drawPile.push(starter);
    shuffle(state.drawPile, state.rng);
    starter = state.drawPile.pop();
    events.push({ type: 'reshuffled', reason: 'wild4-start' });
  }
  state.discardPile.push(starter);
  events.push({ type: 'starterFlipped', cardId: starter });

  const sc = card(starter);
  state.currentPlayer = first;
  state.activeColor = sc.color; // null when the starter is a Wild

  switch (sc.kind) {
    case 'skip':
      events.push({ type: 'skipped', player: first });
      state.currentPlayer = nextPlayerIndex(first, state.direction, n);
      break;
    case 'reverse':
      state.direction = -1;
      events.push({ type: 'directionChanged', direction: -1 });
      state.currentPlayer = state.dealer;
      break;
    case 'draw2':
      drawCards(state, first, 2, 'draw2', events);
      events.push({ type: 'skipped', player: first });
      state.currentPlayer = nextPlayerIndex(first, state.direction, n);
      break;
    case 'wild':
      state.phase = 'awaiting-initial-color';
      state.colorChooser = first;
      events.push({ type: 'colorRequired', player: first });
      break;
  }

  if (state.phase === 'awaiting-play') {
    events.push({ type: 'turnStarted', player: state.currentPlayer });
  }
  return events;
}

// Single choke point for every card a player receives.
function drawOne(state, player, events) {
  if (state.drawPile.length === 0) {
    if (state.discardPile.length <= 1) return null;
    const topCard = state.discardPile.pop();
    state.drawPile = state.discardPile;
    state.discardPile = [topCard];
    shuffle(state.drawPile, state.rng);
    events.push({ type: 'reshuffled', reason: 'pile-empty' });
  }
  const id = state.drawPile.pop();
  state.hands[player].push(id);
  state.uno.declared[player] = false; // must re-declare after hand grows
  if (state.uno.vulnerable === player) state.uno.vulnerable = null;
  return id;
}

function drawCards(state, player, n, reason, events) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = drawOne(state, player, events);
    if (id === null) {
      events.push({ type: 'drawSkipped', player, remaining: n - i });
      break;
    }
    ids.push(id);
  }
  if (ids.length) events.push({ type: 'cardsDrawn', player, cardIds: ids, reason });
  return ids;
}

// Official window: vulnerability survives until the next player begins
// their turn. Any turn action by someone other than the vulnerable player
// closes it.
function clearStaleVulnerability(s, actor, events) {
  if (s.uno.vulnerable !== null && s.uno.vulnerable !== actor) {
    events.push({ type: 'unoWindowClosed', player: s.uno.vulnerable });
    s.uno.vulnerable = null;
  }
}

function advanceTurn(s, fromPlayer, skipNext, events) {
  const n = playerCount(s);
  let next = nextPlayerIndex(fromPlayer, s.direction, n);
  if (skipNext) next = nextPlayerIndex(next, s.direction, n);
  s.currentPlayer = next;
  s.turnCount++;
  events.push({ type: 'turnStarted', player: next });
}

function endRound(s, winner, events, stalled = false) {
  const points = s.hands.reduce(
    (sum, h, i) => (i === winner ? sum : sum + handScore(h)),
    0,
  );
  s.scores[winner] += points;
  s.roundWinner = winner;
  s.uno.vulnerable = null;
  s.drawnCardId = null;
  s.colorChooser = null;
  s.phase = 'round-over';
  events.push({ type: 'roundOver', winner, points, scores: s.scores.slice(), stalled });
  if (s.scores[winner] >= TARGET_SCORE) {
    s.matchWinner = winner;
    s.phase = 'match-over';
    events.push({ type: 'matchOver', winner, scores: s.scores.slice() });
  }
}

// Pathological deadlock: a full cycle of players each passed with no card
// to draw (both piles dry). Lowest hand value takes the round.
function endRoundStalled(s, events) {
  let winner = 0;
  let best = Infinity;
  for (let i = 0; i < playerCount(s); i++) {
    const v = handScore(s.hands[i]);
    if (v < best) {
      best = v;
      winner = i;
    }
  }
  endRound(s, winner, events, true);
}

// Shared by playCard and playDrawn after their own validation.
function playCardCore(s, player, cardId, events) {
  const n = playerCount(s);
  const hand = s.hands[player];
  hand.splice(hand.indexOf(cardId), 1);
  s.discardPile.push(cardId);
  s.drawnCardId = null;
  s.stalledTurns = 0;
  const c = card(cardId);
  s.activeColor = c.color; // null for wilds until chooseColor
  events.push({ type: 'cardPlayed', player, cardId });

  if (hand.length === 1) {
    if (s.uno.declared[player]) {
      s.uno.declared[player] = false;
      events.push({ type: 'unoDeclared', player });
    } else {
      s.uno.vulnerable = player;
      events.push({ type: 'unoVulnerable', player });
    }
  }

  const victim = nextPlayerIndex(player, s.direction, n);
  let skipVictim = false;
  switch (c.kind) {
    case 'reverse':
      if (n === 2) {
        skipVictim = true;
        events.push({ type: 'skipped', player: victim });
      } else {
        s.direction = -s.direction;
        events.push({ type: 'directionChanged', direction: s.direction });
      }
      break;
    case 'skip':
      skipVictim = true;
      events.push({ type: 'skipped', player: victim });
      break;
    case 'draw2':
      drawCards(s, victim, 2, 'draw2', events);
      skipVictim = true;
      events.push({ type: 'skipped', player: victim });
      break;
    case 'wild4':
      drawCards(s, victim, 4, 'wild4', events);
      skipVictim = true;
      events.push({ type: 'skipped', player: victim });
      break;
  }

  if (hand.length === 0) {
    // Round over immediately; a winning wild never needs a color.
    endRound(s, player, events);
    return;
  }

  if (c.kind === 'wild' || c.kind === 'wild4') {
    s.phase = 'awaiting-color';
    s.colorChooser = player;
    events.push({ type: 'colorRequired', player });
    return; // turn advances in chooseColor (wild4 skip derived from top card)
  }

  advanceTurn(s, player, skipVictim, events);
}

function doPlayCard(s, action, events) {
  if (s.phase !== 'awaiting-play') fail(`cannot play a card in phase ${s.phase}`);
  if (action.player !== s.currentPlayer) fail('not your turn');
  const hand = s.hands[action.player];
  if (!hand.includes(action.cardId)) fail('card not in hand');
  if (!isPlayable(action.cardId, top(s), s.activeColor, hand)) fail('card not playable');
  clearStaleVulnerability(s, action.player, events);
  playCardCore(s, action.player, action.cardId, events);
}

function doDrawCard(s, action, events) {
  if (s.phase !== 'awaiting-play') fail(`cannot draw in phase ${s.phase}`);
  if (action.player !== s.currentPlayer) fail('not your turn');
  clearStaleVulnerability(s, action.player, events);
  const ids = drawCards(s, action.player, 1, 'turn', events);
  if (ids.length === 0) {
    s.stalledTurns++;
    events.push({ type: 'turnPassed', player: action.player });
    if (s.stalledTurns >= playerCount(s)) {
      endRoundStalled(s, events);
      return;
    }
    advanceTurn(s, action.player, false, events);
    return;
  }
  s.stalledTurns = 0;
  const id = ids[0];
  if (isPlayable(id, top(s), s.activeColor, s.hands[action.player])) {
    s.phase = 'awaiting-play-drawn';
    s.drawnCardId = id;
    events.push({ type: 'drawnPlayable', player: action.player, cardId: id });
  } else {
    events.push({ type: 'turnPassed', player: action.player });
    advanceTurn(s, action.player, false, events);
  }
}

function doPlayDrawn(s, action, events) {
  if (s.phase !== 'awaiting-play-drawn') fail(`cannot play drawn card in phase ${s.phase}`);
  if (action.player !== s.currentPlayer) fail('not your turn');
  const id = s.drawnCardId;
  s.phase = 'awaiting-play';
  playCardCore(s, action.player, id, events);
}

function doKeepDrawn(s, action, events) {
  if (s.phase !== 'awaiting-play-drawn') fail(`cannot keep drawn card in phase ${s.phase}`);
  if (action.player !== s.currentPlayer) fail('not your turn');
  s.drawnCardId = null;
  s.phase = 'awaiting-play';
  events.push({ type: 'keptDrawn', player: action.player });
  advanceTurn(s, action.player, false, events);
}

function doChooseColor(s, action, events) {
  if (s.phase !== 'awaiting-color' && s.phase !== 'awaiting-initial-color') {
    fail(`cannot choose color in phase ${s.phase}`);
  }
  if (action.player !== s.colorChooser) fail('not the color chooser');
  if (!COLORS.includes(action.color)) fail(`invalid color ${action.color}`);
  s.activeColor = action.color;
  events.push({ type: 'colorChosen', player: action.player, color: action.color });

  if (s.phase === 'awaiting-initial-color') {
    s.phase = 'awaiting-play';
    s.colorChooser = null;
    events.push({ type: 'turnStarted', player: s.currentPlayer });
    return;
  }
  const skipNext = card(top(s)).kind === 'wild4';
  s.phase = 'awaiting-play';
  s.colorChooser = null;
  advanceTurn(s, action.player, skipNext, events);
}

function doCallUno(s, action, events) {
  const p = action.player;
  if (s.uno.vulnerable === p) {
    s.uno.vulnerable = null;
    s.uno.declared[p] = false;
    events.push({ type: 'unoDeclared', player: p });
    return;
  }
  const onTurn =
    s.currentPlayer === p &&
    (s.phase === 'awaiting-play' || s.phase === 'awaiting-play-drawn');
  if (onTurn && s.hands[p].length === 2) {
    if (s.uno.declared[p]) fail('uno already declared');
    s.uno.declared[p] = true;
    events.push({ type: 'unoArmed', player: p });
    return;
  }
  fail('cannot call uno now');
}

function doCatchUno(s, action, events) {
  const t = action.target;
  if (s.uno.vulnerable !== t) fail('target is not vulnerable');
  if (action.player === t) fail('cannot catch yourself');
  s.uno.vulnerable = null;
  events.push({ type: 'unoCaught', catcher: action.player, target: t });
  drawCards(s, t, UNO_PENALTY, 'uno-penalty', events);
}

function doStartNextRound(s, events) {
  if (s.phase !== 'round-over') fail(`cannot start next round in phase ${s.phase}`);
  s.dealer = nextPlayerIndex(s.dealer, 1, playerCount(s));
  events.push(...dealRound(s));
}

function doNewMatch(s, events) {
  if (s.phase !== 'match-over') fail(`cannot start new match in phase ${s.phase}`);
  s.scores = s.players.map(() => 0);
  s.matchWinner = null;
  s.dealer = playerCount(s) - 1;
  events.push(...dealRound(s));
}

// Manual clone — every leaf is primitive; actionLog entries are immutable
// once pushed, so sharing them across clones is safe and keeps apply() O(n)
// instead of structuredClone's O(n * log length).
function cloneState(s) {
  return {
    ...s,
    players: s.players.map((p) => ({ ...p })),
    hands: s.hands.map((h) => h.slice()),
    drawPile: s.drawPile.slice(),
    discardPile: s.discardPile.slice(),
    uno: { declared: s.uno.declared.slice(), vulnerable: s.uno.vulnerable },
    scores: s.scores.slice(),
    rng: { s: s.rng.s },
    actionLog: s.actionLog.slice(),
  };
}

export function apply(state, action) {
  const s = cloneState(state);
  const events = [];
  s.actionLog.push({
    type: action.type,
    player: action.player ?? null,
    cardId: action.cardId ?? null,
    color: action.color ?? null,
    target: action.target ?? null,
  });
  switch (action.type) {
    case 'playCard':
      doPlayCard(s, action, events);
      break;
    case 'drawCard':
      doDrawCard(s, action, events);
      break;
    case 'playDrawn':
      doPlayDrawn(s, action, events);
      break;
    case 'keepDrawn':
      doKeepDrawn(s, action, events);
      break;
    case 'chooseColor':
      doChooseColor(s, action, events);
      break;
    case 'callUno':
      doCallUno(s, action, events);
      break;
    case 'catchUno':
      doCatchUno(s, action, events);
      break;
    case 'startNextRound':
      doStartNextRound(s, events);
      break;
    case 'newMatch':
      doNewMatch(s, events);
      break;
    default:
      fail(`unknown action type: ${action.type}`);
  }
  return { state: s, events };
}

// Test-only fixture builder. Unused cards go to the draw pile so the
// 108-card conservation invariant holds. fixture.drawPileTop lists cards
// drawn first (index 0 = first card drawn).
export function createTestState(fix) {
  const names = fix.playerNames ?? PLAYER_NAMES.slice(0, fix.hands.length);
  if (names.length !== fix.hands.length) throw new Error('hands/names mismatch');
  const placed = [...fix.hands.flat(), ...(fix.discardPile ?? []), ...(fix.drawPileTop ?? [])];
  for (const id of placed) card(id);
  if (new Set(placed).size !== placed.length) {
    throw new Error('duplicate card in fixture');
  }
  const placedSet = new Set(placed);
  const rest = ALL_IDS.filter((id) => !placedSet.has(id));
  const drawPile = [...rest, ...(fix.drawPileTop ?? []).slice().reverse()];
  const discardPile = (fix.discardPile ?? []).slice();
  if (discardPile.length === 0) throw new Error('fixture needs a discard pile');
  const topCard = card(discardPile[discardPile.length - 1]);
  return {
    players: names.map((name, i) => ({ name, isHuman: i === 0 })),
    hands: fix.hands.map((h) => h.slice()),
    drawPile,
    discardPile,
    currentPlayer: fix.currentPlayer ?? 0,
    direction: fix.direction ?? 1,
    activeColor: fix.activeColor ?? topCard.color,
    phase: fix.phase ?? 'awaiting-play',
    colorChooser: fix.colorChooser ?? null,
    drawnCardId: fix.drawnCardId ?? null,
    uno: fix.uno ?? { declared: names.map(() => false), vulnerable: null },
    dealer: fix.dealer ?? names.length - 1,
    scores: fix.scores ?? names.map(() => 0),
    roundWinner: null,
    matchWinner: null,
    rng: createRng(fix.seed ?? 1),
    actionLog: [],
    turnCount: 0,
    stalledTurns: fix.stalledTurns ?? 0,
  };
}
