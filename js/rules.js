import { card } from './deck.js';

export function nextPlayerIndex(current, direction, playerCount = 4) {
  return (current + direction + playerCount) % playerCount;
}

// Official Wild Draw Four restriction: legal only when the hand holds no
// card matching the active COLOR (matching numbers/symbols don't block it).
export function wild4Allowed(handIds, activeColor) {
  return !handIds.some((id) => card(id).color === activeColor);
}

export function isPlayable(cardId, topCardId, activeColor, handIds) {
  const c = card(cardId);
  const top = card(topCardId);
  if (c.kind === 'wild') return true;
  if (c.kind === 'wild4') return wild4Allowed(handIds, activeColor);
  if (c.color === activeColor) return true;
  if (c.kind === 'number') return top.kind === 'number' && top.value === c.value;
  return c.kind === top.kind;
}

export function cardScore(cardId) {
  const c = card(cardId);
  if (c.kind === 'number') return c.value;
  if (c.kind === 'wild' || c.kind === 'wild4') return 50;
  return 20;
}

export function handScore(handIds) {
  return handIds.reduce((sum, id) => sum + cardScore(id), 0);
}
