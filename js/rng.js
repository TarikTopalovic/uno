// Seeded PRNG (mulberry32). State is a plain object so it survives
// structuredClone and serializes with the game state.

export function createRng(seed) {
  return { s: seed >>> 0 };
}

export function nextFloat(rng) {
  rng.s = (rng.s + 0x6d2b79f5) | 0;
  let t = rng.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function nextInt(rng, n) {
  return Math.floor(nextFloat(rng) * n);
}

export function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = nextInt(rng, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
