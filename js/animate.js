// Flight engine: fixed-position clones in #fx-layer, FLIP-correct rect→rect
// transitions. Every animation returns a Promise; reduced-motion resolves
// instantly.

import { TIMING } from './constants.js';

const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

export function prefersReduced() {
  return reducedQuery.matches;
}

const layer = () => document.getElementById('fx-layer');

export function sleep(ms) {
  if (prefersReduced()) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

function settle(el, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    el.addEventListener('transitionend', (e) => {
      if (e.target === el) finish();
    });
    // transitionend can be swallowed on tab blur — always race a timeout
    setTimeout(finish, ms + 140);
  });
}

// from/to: DOMRects. front/back: builders returning card elements.
// flip: 'none' (face up whole way) | 'reveal' (back→face mid-flight) |
//       'back' (face down whole way)
export async function fly({
  from,
  to,
  front,
  back,
  flip = 'none',
  ms = TIMING.FLY_MS,
  fromRot = 0,
  toRot = 0,
}) {
  if (prefersReduced()) return;
  const w = from.width;
  const h = from.height;
  const k = to.width / w || 1;

  const wrap = document.createElement('div');
  wrap.className = 'fx-card';
  wrap.style.width = `${w}px`;
  wrap.style.height = `${h}px`;

  const flipper = document.createElement('div');
  flipper.className = 'fx-flip';
  const f = front();
  f.classList.add('fx-face', 'fx-face--front');
  f.style.fontSize = `${w / 10}px`;
  const b = back();
  b.classList.add('fx-face', 'fx-face--back');
  b.style.fontSize = `${w / 10}px`;
  flipper.append(f, b);
  wrap.appendChild(flipper);

  if (flip === 'reveal' || flip === 'back') {
    flipper.style.transform = 'rotateY(180deg)';
  }

  const x0 = from.left + w / 2 - w / 2;
  const y0 = from.top + h / 2 - h / 2;
  const x1 = to.left + to.width / 2 - w / 2;
  const y1 = to.top + to.height / 2 - h / 2;

  wrap.style.transform = `translate(${x0}px, ${y0}px) rotate(${fromRot}deg)`;
  layer().appendChild(wrap);
  void wrap.offsetWidth; // commit start frame

  wrap.style.transition = `transform ${ms}ms var(--ease-throw)`;
  wrap.style.transform = `translate(${x1}px, ${y1}px) rotate(${toRot}deg) scale(${k})`;
  if (flip === 'reveal') {
    flipper.style.transition = `transform ${Math.round(ms * 0.7)}ms ease ${Math.round(ms * 0.15)}ms`;
    flipper.style.transform = 'rotateY(0deg)';
  }

  await settle(wrap, ms);
  wrap.remove();
}

export function unoFlash(text, colorCss) {
  if (prefersReduced()) return;
  const el = document.createElement('div');
  el.className = 'uno-flash';
  if (colorCss) el.style.setProperty('--c', colorCss);
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  layer().appendChild(el);
  setTimeout(() => el.remove(), 1100);
}

export function confetti(colors, count = 64) {
  if (prefersReduced()) return;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const c = document.createElement('i');
    c.className = 'confetto';
    c.style.setProperty('--x', `${Math.random() * 100}vw`);
    c.style.setProperty('--c', colors[i % colors.length]);
    c.style.setProperty('--d', `${Math.random() * 0.8}s`);
    c.style.setProperty('--t', `${2.2 + Math.random() * 1.6}s`);
    frag.appendChild(c);
  }
  layer().appendChild(frag);
  setTimeout(() => {
    layer()
      .querySelectorAll('.confetto')
      .forEach((el) => el.remove());
  }, 5200);
}

export function winRing(x, y) {
  if (prefersReduced()) return;
  const el = document.createElement('div');
  el.className = 'win-ring';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  layer().appendChild(el);
  setTimeout(() => el.remove(), 1000);
}
