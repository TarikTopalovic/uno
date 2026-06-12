import { COLORS } from './constants.js';

// 108-card official deck, built programmatically. Cards are frozen and
// referenced everywhere by id; game state never holds card objects.

const COPIES = 'abcd';
const list = [];

function add(color, kind, value, copy) {
  const colorKey = color ? color[0] : 'w';
  const kindKey = kind === 'number' ? String(value) : kind;
  list.push(
    Object.freeze({
      id: `${colorKey}-${kindKey}-${copy}`,
      color,
      kind,
      value,
    }),
  );
}

for (const color of COLORS) {
  add(color, 'number', 0, 'a');
  for (let v = 1; v <= 9; v++) {
    add(color, 'number', v, 'a');
    add(color, 'number', v, 'b');
  }
  for (const kind of ['skip', 'reverse', 'draw2']) {
    add(color, kind, null, 'a');
    add(color, kind, null, 'b');
  }
}
for (let i = 0; i < 4; i++) {
  add(null, 'wild', null, COPIES[i]);
  add(null, 'wild4', null, COPIES[i]);
}

export const CARDS = new Map(list.map((c) => [c.id, c]));
export const ALL_IDS = Object.freeze(list.map((c) => c.id));

if (CARDS.size !== 108 || ALL_IDS.length !== 108) {
  throw new Error(`deck must have 108 unique cards, got ${CARDS.size}`);
}

export function card(id) {
  const c = CARDS.get(id);
  if (!c) throw new Error(`unknown card id: ${id}`);
  return c;
}
