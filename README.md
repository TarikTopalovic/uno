# UNO // Neon Arcade

A fully playable UNO card game in the browser — solo against three AI
opponents, or **online with friends**. Official rules, first to 500 points.

**Play it:** https://tariktopalovic.github.io/uno/

Vanilla HTML/CSS/JS. No build step, no server.

## Play with friends

1. One player clicks **HOST ROOM** and shares the 5-letter room code.
2. Friends open the same URL, enter the code, and hit **JOIN ROOM** (2–4
   players; empty seats are filled by AI).
3. Host starts the game. If someone disconnects, an AI takes their seat.

Multiplayer is peer-to-peer (WebRTC via PeerJS) — the host's browser runs
the authoritative game engine, guests receive a redacted state so nobody
can peek at hands through devtools. No accounts, no server, no port
forwarding.

### "Connecting…" fails / friends can't join

Direct peer-to-peer needs at least one side on a friendly NAT. STUN
(included) covers most home Wi-Fi, but CGNAT, mobile carriers, and
corporate networks often block it — the game will tell you when that's
the case. The fix is a TURN relay, and free ones exist but need a
(free) account because public no-signup relays all died:

1. Sign up at https://www.expressturn.com (free, 1000 GB/month) and copy
   your username + password from the dashboard.
2. Either paste them into `TURN_SERVERS` in `js/net.js`, or test without
   redeploying by adding to the URL (both players):

   ```
   ?turn=turn:relay1.expressturn.com:3478,turns:relay1.expressturn.com:443?transport=tcp|USERNAME|PASSWORD
   ```

   Add `&relay` to force relay-only mode when testing.

Card-game traffic is a few KB/minute, so the free quota is effectively
unlimited.

## Rules implemented

- Official 108-card deck, 7-card deal, full starter-flip rules
  (including Wild Draw Four reshuffle-and-reflip)
- Match by color, number, or symbol; Wild Draw Four only legal with no
  matching-color card in hand (enforced — illegal cards are dimmed)
- Draw one if stuck; play the drawn card or keep it
- UNO call at two cards — forget it and the AIs can catch you (+2 cards);
  they sometimes forget too, so catch them right back
- Skip / Reverse / Draw Two / Wilds, draw-pile reshuffling, round scoring
  (numbers face value, actions 20, wilds 50), match to 500

## Run locally

```sh
python -m http.server 8420
# open http://localhost:8420
```

(Any static server works — ES modules just can't load from `file://`.)

## Tests

The rules engine is a pure, deterministic state machine, fully separated
from the DOM, and is verified headlessly:

```sh
node --test test/unit.test.js   # 32 scenario tests, one per rules edge case
node test/simulate.js 10000     # 10,000 full AI-vs-AI matches, invariants
                                # checked after every action + illegal-action
                                # fuzzing + determinism replay
```
