// Incremental keyed DOM sync + event-to-animation bridge. Never re-renders
// the whole table; reconciles by card id so in-flight transitions survive.

import { card } from './deck.js';
import { COLORS, TIMING } from './constants.js';
import { isPlayable } from './rules.js';
import * as fx from './animate.js';

let dom = {};
let handlers = {};
let toastCount = 0;

const COLOR_CSS = Object.fromEntries(COLORS.map((c) => [c, `var(--neon-${c})`]));
const cap = (s) => s[0].toUpperCase() + s.slice(1);

export function cardLabel(id) {
  const c = card(id);
  const color = c.color ? cap(c.color) : '';
  switch (c.kind) {
    case 'number':
      return `${color} ${c.value}`;
    case 'skip':
      return `${color} Skip`;
    case 'reverse':
      return `${color} Reverse`;
    case 'draw2':
      return `${color} Draw Two`;
    case 'wild':
      return 'Wild';
    default:
      return 'Wild Draw Four';
  }
}

function svgUse(sym) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#${sym}"/></svg>`;
}

function faceHTML(c) {
  let corner;
  let center;
  switch (c.kind) {
    case 'number':
      corner = String(c.value);
      center = `<span class="card__big">${c.value}</span>`;
      break;
    case 'skip':
      corner = svgUse('sym-skip');
      center = `<span class="card__big card__big--sym">${svgUse('sym-skip')}</span>`;
      break;
    case 'reverse':
      corner = svgUse('sym-reverse');
      center = `<span class="card__big card__big--sym">${svgUse('sym-reverse')}</span>`;
      break;
    case 'draw2':
      corner = '+2';
      center = `<span class="card__big card__big--sym">${svgUse('sym-draw2')}</span>`;
      break;
    case 'wild':
      corner = '<span class="mini-wild"></span>';
      center = '<span class="card__wild"></span>';
      break;
    default: // wild4
      corner = '+4';
      center = `<span class="card__big card__big--sym">${svgUse('sym-draw4')}</span>`;
  }
  const cb = c.color ? `<span class="card__cb">${c.color[0].toUpperCase()}</span>` : '';
  return `<span class="card__swoosh"></span>
    <span class="card__idx card__idx--tl">${corner}</span>
    ${center}
    <span class="card__idx card__idx--br">${corner}</span>
    ${cb}`;
}

export function cardEl(id, { button = false } = {}) {
  const c = card(id);
  const el = document.createElement(button ? 'button' : 'div');
  if (button) el.type = 'button';
  el.className = 'card';
  el.dataset.id = id;
  el.dataset.color = c.color ?? 'wild';
  el.setAttribute('aria-label', cardLabel(id));
  el.innerHTML = faceHTML(c);
  return el;
}

export function backEl() {
  const el = document.createElement('div');
  el.className = 'card card--back';
  el.innerHTML = '<span class="card__swoosh"></span><span class="card__backlogo">UNO</span>';
  return el;
}

// Deterministic per-card scatter so the discard pile looks organic but
// re-renders identically.
function hash(str) {
  let h = 2166136261;
  for (const ch of str) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function scatter(id) {
  const h = hash(id);
  return {
    x: ((h & 0xff) / 255 - 0.5) * 22,
    y: (((h >> 8) & 0xff) / 255 - 0.5) * 16,
    r: (((h >> 16) & 0xff) / 255 - 0.5) * 30,
  };
}

const rect = (el) => el.getBoundingClientRect();

function oppZone(p) {
  return document.querySelector(`.opp-hand[data-opp="${p}"]`);
}

function seatEl(p) {
  return document.querySelector(`.seat[data-seat="${p}"]`);
}

function sideRot(p) {
  return p === 1 ? 90 : p === 3 ? -90 : 0;
}

function playerName(state, p) {
  return state.players[p].name;
}

// ------------------------------------------------------------------ toasts

export function toast(html, colorCss) {
  const el = document.createElement('div');
  el.className = 'toast';
  if (colorCss) el.style.setProperty('--c', colorCss);
  el.innerHTML = `<span class="dot"></span><span>${html}</span>`;
  dom.toasts.appendChild(el);
  while (dom.toasts.children.length > 3) dom.toasts.firstChild.remove();
  toastCount++;
  setTimeout(() => el.remove(), 3500);
}

function toastCard(prefix, cardId) {
  const c = card(cardId);
  const colorCss = c.color ? COLOR_CSS[c.color] : 'var(--glow)';
  toast(`${prefix} <b>${cardLabel(cardId)}</b>`, colorCss);
}

// ----------------------------------------------------------------- discard

function pushDiscard(id) {
  const el = cardEl(id);
  el.classList.add('discard-card');
  const sc = scatter(id);
  el.style.setProperty('--sx', `${sc.x}px`);
  el.style.setProperty('--sy', `${sc.y}px`);
  el.style.setProperty('--sr', `${sc.r}deg`);
  dom.discard.appendChild(el);
  while (dom.discard.children.length > 8) dom.discard.firstChild.remove();
}

function ensureDiscardTop(state) {
  const topId = state.discardPile[state.discardPile.length - 1];
  if (!topId) return;
  const last = dom.discard.lastElementChild;
  if (!last || last.dataset.id !== topId) pushDiscard(topId);
}

// -------------------------------------------------------------------- hand

function syncHand(state) {
  const ids = state.hands[0];
  const existing = new Map([...dom.hand.children].map((el) => [el.dataset.id, el]));
  for (const [id, el] of existing) {
    if (!ids.includes(id)) el.remove();
  }
  for (const id of ids) {
    if (!existing.has(id)) dom.hand.appendChild(cardEl(id, { button: true }));
  }
  const els = [...dom.hand.children];
  els.forEach((el, i) => {
    el.style.setProperty('--i', i);
    el.style.setProperty('--n', els.length);
  });

  const myTurn =
    state.currentPlayer === 0 &&
    (state.phase === 'awaiting-play' || state.phase === 'awaiting-play-drawn');
  dom.hand.classList.toggle('is-turn', myTurn);
  dom.hand.classList.toggle('is-locked', !myTurn);

  const topId = state.discardPile[state.discardPile.length - 1];
  for (const el of els) {
    let playable = false;
    if (myTurn && state.phase === 'awaiting-play') {
      playable = isPlayable(el.dataset.id, topId, state.activeColor, ids);
    } else if (myTurn && state.phase === 'awaiting-play-drawn') {
      playable = el.dataset.id === state.drawnCardId;
    }
    el.classList.toggle('is-playable', playable);
    el.classList.toggle(
      'is-drawn',
      state.phase === 'awaiting-play-drawn' && el.dataset.id === state.drawnCardId,
    );
  }
}

function syncOppHand(p, count) {
  const zone = oppZone(p);
  const want = Math.min(count, 7);
  while (zone.children.length > want) zone.lastChild.remove();
  while (zone.children.length < want) zone.appendChild(backEl());
}

// -------------------------------------------------------------------- sync

export function sync(state) {
  const n = state.players.length;
  for (let p = 0; p < n; p++) {
    const scoreEl = document.querySelector(`[data-score="${p}"]`);
    if (scoreEl) scoreEl.textContent = state.scores[p];
    if (p > 0) {
      const countEl = document.querySelector(`[data-count="${p}"]`);
      if (countEl) countEl.textContent = state.hands[p].length;
      syncOppHand(p, state.hands[p].length);
    }
  }

  const over = state.phase === 'round-over' || state.phase === 'match-over';
  const actor =
    state.phase === 'awaiting-color' || state.phase === 'awaiting-initial-color'
      ? state.colorChooser
      : state.currentPlayer;
  document.querySelectorAll('.seat').forEach((el) => {
    el.classList.toggle('is-active', !over && Number(el.dataset.seat) === actor);
  });

  syncHand(state);
  ensureDiscardTop(state);

  dom.drawPile.classList.toggle(
    'is-clickable',
    state.phase === 'awaiting-play' && state.currentPlayer === 0,
  );

  dom.colorDot.style.setProperty(
    '--cd',
    state.activeColor ? COLOR_CSS[state.activeColor] : 'transparent',
  );

  const armable =
    state.currentPlayer === 0 &&
    state.hands[0].length === 2 &&
    !state.uno.declared[0] &&
    (state.phase === 'awaiting-play' || state.phase === 'awaiting-play-drawn');
  dom.unoBtn.classList.toggle('is-armed', armable);
  dom.unoBtn.classList.toggle('is-urgent', state.uno.vulnerable === 0);

  dom.catchBtn.hidden = !(state.uno.vulnerable !== null && state.uno.vulnerable !== 0);

  if (!(state.phase === 'awaiting-play-drawn' && state.currentPlayer === 0)) {
    hideDrawnPrompt();
  }
  if (
    !(
      (state.phase === 'awaiting-color' || state.phase === 'awaiting-initial-color') &&
      state.colorChooser === 0
    )
  ) {
    dom.picker.hidden = true;
  }
}

// --------------------------------------------------------- drawn prompt

function showDrawnPrompt() {
  dom.drawnPrompt.hidden = false;
  const bar = dom.drawnPrompt.querySelector('.drawn-prompt__bar');
  const fresh = bar.cloneNode(); // restart the drain animation
  bar.replaceWith(fresh);
}

function hideDrawnPrompt() {
  dom.drawnPrompt.hidden = true;
}

// ----------------------------------------------------------- event handlers

const HANDLERS = {
  async roundDealt(ev, state) {
    hideOverlay();
    dom.discard.innerHTML = '';
    dom.hand.innerHTML = '';
    for (let p = 1; p < state.players.length; p++) syncOppHand(p, 0);

    const n = state.players.length;
    const first = (ev.dealer + 1) % n;
    const order = [];
    for (let r = 0; r < ev.hands[0].length || r < 7; r++) {
      if (r >= 7) break;
      for (let k = 0; k < n; k++) order.push((first + k) % n);
    }
    const fromR = rect(dom.drawPile);
    const flights = order.map((p, i) =>
      fx
        .sleep(i * TIMING.DEAL_STAGGER_MS)
        .then(() =>
          fx.fly({
            from: fromR,
            to: rect(p === 0 ? dom.hand : oppZone(p)),
            front: backEl,
            back: backEl,
            flip: 'back',
            ms: 360,
            toRot: sideRot(p),
          }),
        ),
    );
    await Promise.all(flights);
  },

  async starterFlipped(ev) {
    await fx.fly({
      from: rect(dom.drawPile),
      to: rect(dom.discard),
      front: () => cardEl(ev.cardId),
      back: backEl,
      flip: 'reveal',
      toRot: scatter(ev.cardId).r,
    });
    pushDiscard(ev.cardId);
  },

  async cardPlayed(ev, state) {
    const sc = scatter(ev.cardId);
    const toR = rect(dom.discard);
    if (ev.player === 0) {
      const el = dom.hand.querySelector(`[data-id="${CSS.escape(ev.cardId)}"]`);
      const fromR = el ? rect(el) : rect(dom.hand);
      el?.remove();
      await fx.fly({
        from: fromR,
        to: toR,
        front: () => cardEl(ev.cardId),
        back: backEl,
        toRot: sc.r,
      });
    } else {
      toastCard(`${playerName(state, ev.player)} plays`, ev.cardId);
      await fx.fly({
        from: rect(oppZone(ev.player)),
        to: toR,
        front: () => cardEl(ev.cardId),
        back: backEl,
        flip: 'reveal',
        fromRot: sideRot(ev.player),
        toRot: sc.r,
      });
    }
    pushDiscard(ev.cardId);
  },

  async cardsDrawn(ev, state) {
    if (ev.reason === 'draw2' || ev.reason === 'wild4') {
      toast(
        `${playerName(state, ev.player)} draws ${ev.cardIds.length}`,
        'var(--neon-red)',
      );
    } else if (ev.reason === 'uno-penalty') {
      toast(`${playerName(state, ev.player)} caught — +2 cards`, 'var(--neon-yellow)');
    }
    for (const id of ev.cardIds) {
      if (ev.player === 0) {
        await fx.fly({
          from: rect(dom.drawPile),
          to: rect(dom.hand),
          front: () => cardEl(id),
          back: backEl,
          flip: 'reveal',
          ms: 340,
        });
        if (!dom.hand.querySelector(`[data-id="${CSS.escape(id)}"]`)) {
          dom.hand.appendChild(cardEl(id, { button: true }));
        }
      } else {
        await fx.fly({
          from: rect(dom.drawPile),
          to: rect(oppZone(ev.player)),
          front: backEl,
          back: backEl,
          flip: 'back',
          ms: 300,
          toRot: sideRot(ev.player),
        });
        syncOppHand(ev.player, Math.min(state.hands[ev.player].length, 7));
      }
    }
  },

  async drawnPlayable(ev) {
    if (ev.player === 0) showDrawnPrompt();
  },

  async keptDrawn() {
    hideDrawnPrompt();
  },

  async colorRequired(ev) {
    if (ev.player === 0) dom.picker.hidden = false;
  },

  async colorChosen(ev, state) {
    dom.picker.hidden = true;
    toast(
      `${playerName(state, ev.player)} picks <b>${cap(ev.color)}</b>`,
      COLOR_CSS[ev.color],
    );
  },

  async directionChanged(ev) {
    dom.ring.classList.remove('burst');
    void dom.ring.offsetWidth;
    dom.ring.classList.add('burst');
    setTimeout(() => dom.ring.classList.remove('burst'), 750);
    dom.ring.classList.toggle('is-ccw', ev.direction === -1);
    toast('Direction reversed', 'var(--glow)');
  },

  async skipped(ev, state) {
    toast(`${playerName(state, ev.player)} is skipped`, 'var(--glow)');
  },

  async reshuffled(ev) {
    if (ev.reason === 'pile-empty') toast('Discard pile reshuffled into the deck');
  },

  async drawSkipped() {
    toast('No cards left to draw — turn passes');
  },

  async turnPassed(ev, state) {
    if (ev.player !== 0) toast(`${playerName(state, ev.player)} passes`);
  },

  async unoArmed(ev, state) {
    if (ev.player !== 0) {
      toast(`${playerName(state, ev.player)} calls <b>UNO</b>!`, 'var(--neon-red)');
    }
  },

  async unoDeclared(ev, state) {
    fx.unoFlash('UNO!', ev.player === 0 ? 'var(--glow)' : 'var(--neon-red)');
    toast(`${playerName(state, ev.player)} — <b>UNO!</b>`, 'var(--neon-red)');
    await fx.sleep(350);
  },

  async unoVulnerable(ev, state) {
    if (ev.player === 0) {
      toast('One card left — press <b>UNO!</b> before you get caught', 'var(--neon-red)');
    } else {
      toast(
        `${playerName(state, ev.player)} forgot to call UNO — <b>CATCH</b> them!`,
        'var(--neon-yellow)',
      );
    }
  },

  async unoCaught(ev, state) {
    fx.unoFlash('CAUGHT!', 'var(--neon-yellow)');
    toast(
      `${playerName(state, ev.catcher)} catches ${playerName(state, ev.target)}!`,
      'var(--neon-yellow)',
    );
    await fx.sleep(400);
  },

  async roundOver(ev, state) {
    const seat = seatEl(ev.winner);
    if (seat) {
      const r = rect(seat);
      fx.winRing(r.left + r.width / 2, r.top + r.height / 2);
    }
    if (ev.winner === 0) {
      fx.confetti(Object.values(COLOR_CSS).concat('var(--glow)'));
    }
    await fx.sleep(800);
    if (state.matchWinner === null) showRoundOver(ev, state);
  },

  async matchOver(ev, state) {
    fx.confetti(Object.values(COLOR_CSS).concat('var(--glow)'));
    await fx.sleep(600);
    showMatchOver(ev, state);
  },
};

export async function playEvents(events, state) {
  for (const ev of events) {
    const fn = HANDLERS[ev.type];
    if (fn) await fn(ev, state);
  }
  sync(state);
}

// ---------------------------------------------------------------- overlays

function scoreTable(state, winner) {
  const rows = state.players
    .map(
      (pl, i) =>
        `<tr class="${i === winner ? 'is-winner' : ''}"><td>${pl.name}</td><td>${state.scores[i]}</td></tr>`,
    )
    .join('');
  return `<table class="overlay__scores">${rows}</table>`;
}

function showOverlay(html) {
  dom.overlay.innerHTML = `<div class="overlay__panel">${html}</div>`;
  dom.overlay.hidden = false;
}

export function hideOverlay() {
  dom.overlay.hidden = true;
}

export function showStartScreen() {
  showOverlay(`
    <h1 class="overlay__title">UNO<br><em>NEON ARCADE</em></h1>
    <p class="overlay__sub">You vs Nova · Vex · Echo — first to 500</p>
    <button class="cta" id="startBtn" type="button">DEAL ME IN</button>
  `);
  dom.overlay.querySelector('#startBtn').addEventListener('click', handlers.onStart);
}

function showRoundOver(ev, state) {
  showOverlay(`
    <h1 class="overlay__title">${playerName(state, ev.winner)} <em>WINS THE ROUND</em></h1>
    <p class="overlay__sub">+${ev.points} points${ev.stalled ? ' · stalemate — lowest hand wins' : ''}</p>
    ${scoreTable(state, ev.winner)}
    <button class="cta" id="nextRoundBtn" type="button">NEXT ROUND</button>
  `);
  dom.overlay
    .querySelector('#nextRoundBtn')
    .addEventListener('click', handlers.onNextRound);
}

function showMatchOver(ev, state) {
  showOverlay(`
    <h1 class="overlay__title">${playerName(state, ev.winner)} <em>WINS THE MATCH</em></h1>
    <p class="overlay__sub">first to 500 — final standings</p>
    ${scoreTable(state, ev.winner)}
    <button class="cta" id="newMatchBtn" type="button">PLAY AGAIN</button>
  `);
  dom.overlay
    .querySelector('#newMatchBtn')
    .addEventListener('click', handlers.onNewMatch);
}

// -------------------------------------------------------------------- init

export function init(h) {
  handlers = h;
  dom = {
    hand: document.getElementById('hand'),
    discard: document.getElementById('discard'),
    drawPile: document.getElementById('drawPile'),
    ring: document.getElementById('ring'),
    colorDot: document.getElementById('colorDot'),
    unoBtn: document.getElementById('unoBtn'),
    catchBtn: document.getElementById('catchBtn'),
    drawnPrompt: document.getElementById('drawnPrompt'),
    picker: document.getElementById('picker'),
    toasts: document.getElementById('toasts'),
    overlay: document.getElementById('overlay'),
  };

  dom.hand.addEventListener('click', (e) => {
    const el = e.target.closest('.card');
    if (!el || !dom.hand.classList.contains('is-turn')) return;
    if (el.classList.contains('is-playable')) {
      if (el.classList.contains('is-drawn')) handlers.onPlayDrawn();
      else handlers.onPlayCard(el.dataset.id);
    } else {
      el.classList.remove('shake');
      void el.offsetWidth;
      el.classList.add('shake');
      toast(`Can't play <b>${cardLabel(el.dataset.id)}</b> right now`);
    }
  });

  dom.drawPile.addEventListener('click', () => {
    if (dom.drawPile.classList.contains('is-clickable')) handlers.onDraw();
  });

  dom.unoBtn.addEventListener('click', handlers.onUno);
  dom.catchBtn.addEventListener('click', handlers.onCatch);
  document.getElementById('playDrawnBtn').addEventListener('click', handlers.onPlayDrawn);
  document.getElementById('keepDrawnBtn').addEventListener('click', handlers.onKeepDrawn);

  dom.picker.querySelectorAll('button[data-color]').forEach((btn) => {
    btn.addEventListener('click', () => handlers.onChooseColor(btn.dataset.color));
  });
}
