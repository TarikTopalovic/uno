// Pure AI. Operates on a redacted view (own hand + opponents' counts only)
// so it structurally cannot cheat. Deterministic given (view, rng).

import { card } from './deck.js';
import { isPlayable, nextPlayerIndex, cardScore } from './rules.js';
import { COLORS, AI_TUNING } from './constants.js';
import { nextFloat, nextInt } from './rng.js';

export function makeView(state, player) {
  return {
    self: player,
    hand: state.hands[player].slice(),
    counts: state.hands.map((h) => h.length),
    topCardId: state.discardPile[state.discardPile.length - 1],
    activeColor: state.activeColor,
    direction: state.direction,
    phase: state.phase,
    drawnCardId: state.drawnCardId,
    playerCount: state.players.length,
  };
}

function bestColor(handIds, rng) {
  const counts = Object.fromEntries(COLORS.map((c) => [c, 0]));
  for (const id of handIds) {
    const c = card(id);
    if (c.color) counts[c.color]++;
  }
  const max = Math.max(...COLORS.map((c) => counts[c]));
  const best = COLORS.filter((c) => counts[c] === max);
  return best[nextInt(rng, best.length)];
}

function scoreMove(cardId, view) {
  const W = AI_TUNING.WEIGHTS;
  const c = card(cardId);
  let score = cardScore(cardId) * W.shed;

  if (c.color) {
    const run = view.hand.filter((id) => id !== cardId && card(id).color === c.color).length;
    score += run * W.colorRun;
  }

  const next = nextPlayerIndex(view.self, view.direction, view.playerCount);
  if (view.counts[next] <= AI_TUNING.THREAT_HAND) {
    if (c.kind === 'draw2') score += W.draw2Threat;
    else if (c.kind === 'skip') score += W.skipThreat;
    else if (c.kind === 'wild4') score += W.wild4Threat;
    else if (c.kind === 'reverse') score += W.reverseThreat;
  }

  if (c.kind === 'wild') score += W.wildHold;
  if (c.kind === 'wild4') score += W.wild4Hold;
  return score;
}

export function chooseAction(view, rng) {
  const p = view.self;

  if (view.phase === 'awaiting-color' || view.phase === 'awaiting-initial-color') {
    return { type: 'chooseColor', player: p, color: bestColor(view.hand, rng) };
  }
  if (view.phase === 'awaiting-play-drawn') {
    // AI only draws voluntarily when stuck — the drawn card is its only out.
    return { type: 'playDrawn', player: p };
  }

  const legal = view.hand.filter((id) =>
    isPlayable(id, view.topCardId, view.activeColor, view.hand),
  );
  if (legal.length === 0) return { type: 'drawCard', player: p };

  const scored = legal.map((id) => ({ id, score: scoreMove(id, view) }));
  const best = Math.max(...scored.map((m) => m.score));
  const contenders = scored.filter((m) => m.score >= best - AI_TUNING.EPSILON);
  const pick = contenders[nextInt(rng, contenders.length)];
  return { type: 'playCard', player: p, cardId: pick.id };
}

export function shouldDeclareUno(rng) {
  return nextFloat(rng) < AI_TUNING.DECLARE_UNO_PROB;
}
