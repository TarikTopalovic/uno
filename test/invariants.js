import { ALL_IDS, card } from '../js/deck.js';
import { COLORS, PHASES } from '../js/constants.js';

const ALL_SET = new Set(ALL_IDS);

class InvariantError extends Error {}

function check(cond, msg) {
  if (!cond) throw new InvariantError(`invariant violated: ${msg}`);
}

export function checkInvariants(state) {
  const n = state.players.length;
  const zones = [...state.hands.flat(), ...state.drawPile, ...state.discardPile];

  // Card conservation: exactly the 108 deck ids, no dup, no loss.
  check(zones.length === ALL_IDS.length, `card count ${zones.length} != ${ALL_IDS.length}`);
  const seen = new Set(zones);
  check(seen.size === zones.length, 'duplicate card id across zones');
  for (const id of zones) check(ALL_SET.has(id), `unknown card id ${id}`);

  check(state.discardPile.length >= 1, 'discard pile empty');
  check(PHASES.includes(state.phase), `unknown phase ${state.phase}`);
  check(
    Number.isInteger(state.currentPlayer) && state.currentPlayer >= 0 && state.currentPlayer < n,
    `bad currentPlayer ${state.currentPlayer}`,
  );
  check(state.direction === 1 || state.direction === -1, `bad direction ${state.direction}`);

  // activeColor coherence: non-wild top card dictates the active color.
  const topCard = card(state.discardPile[state.discardPile.length - 1]);
  if (topCard.color !== null) {
    check(state.activeColor === topCard.color, 'activeColor != non-wild top card color');
  } else {
    const colorPending =
      state.phase === 'awaiting-color' ||
      state.phase === 'awaiting-initial-color' ||
      state.phase === 'round-over' ||
      state.phase === 'match-over';
    check(
      COLORS.includes(state.activeColor) || (state.activeColor === null && colorPending),
      `bad activeColor ${state.activeColor} with wild on top in phase ${state.phase}`,
    );
  }

  // UNO vulnerability only ever points at a player holding exactly 1 card.
  if (state.uno.vulnerable !== null) {
    check(
      state.hands[state.uno.vulnerable].length === 1,
      `vulnerable player has ${state.hands[state.uno.vulnerable].length} cards`,
    );
  }

  if (state.phase === 'awaiting-play-drawn') {
    check(
      state.hands[state.currentPlayer].includes(state.drawnCardId),
      'drawnCardId not in current hand',
    );
  }
  if (state.phase === 'awaiting-color' || state.phase === 'awaiting-initial-color') {
    check(
      state.colorChooser !== null && state.colorChooser >= 0 && state.colorChooser < n,
      'colorChooser missing in color phase',
    );
  }

  for (const h of state.hands) {
    for (const id of h) check(typeof id === 'string', `bad hand entry ${id}`);
  }

  // Termination watchdog.
  check(state.turnCount < 3000, `round exceeded 3000 turns`);
}
