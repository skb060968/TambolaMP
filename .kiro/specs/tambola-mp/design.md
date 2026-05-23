# Tambola MP — Design

## Architecture

Single SPA at `index.html`. The Home screen offers two role buttons:

- **📺 Play on TV (Host)** — sets `role = 'tv'`, shows TV layout, creates a room when submitted.
- **📱 Join as Player** — sets `role = 'player'`, shows phone layout, joins a room.

A `<body>` data attribute (`data-mode="tv"` / `data-mode="phone"`) drives CSS. Once a role is selected, the relevant module wires its own flow:

- `tv-controller.js` — draws numbers, validates claims, manages round lifecycle, renders the TV layout.
- `phone-controller.js` — handles ticket marking, claim submission, mute, autocut, renders the phone layout.

Both controllers observe the same Firebase room node `tambola-mp-rooms/{code}` but render different UI from the same data. The TV is the single writer for `game/drawnNumbers`, `game/currentNumber`, `claims/*`, and `meta/status`. Phones write only `marks/player_N` and `claimRequests/*`.

```
                    Firebase RTDB
        tambola-mp-rooms/{roomCode}
              │      │      │
       ┌──────┘      │      └──────────┐
       ▼             ▼                 ▼
  TV-host         Player phones       Player phones
  (writes        (subscribe,         …
   draws,          mark, claim
   resolves       request)
   claims)
```

## Firebase data shape

```
tambola-mp-rooms/
  {roomCode}/
    meta:
      host:
        name: string
        emoji: string
        uid: string
        connected: boolean
      status: 'lobby' | 'active' | 'ended'
      createdAt: number
      updatedAt: number
    players:
      player_0: { name, emoji, uid, connected }
      player_1: { name, emoji, uid, connected }
      ...
      player_19: ...
    tickets:
      player_0: 'serialized ticket string'
      ...
    game:
      drawnNumbers: number[]
      currentNumber: number | null
      drawIndex: number
      autoCallSpeed: number | null   # seconds, null = manual
      paused: boolean
      claims:
        topLine:    { won, winner, wonAt, playerName, patternLabel }
        middleLine: ...
        bottomLine: ...
        corners:    ...
        fullHouse:  ...
    marks:
      player_0: number[]   # numbers struck on this player's ticket
      ...
    claimRequests:
      {requestId}: { pattern, playerIndex, ts }
    claimResults:
      {requestId}: { valid: false, reason }   # only invalid results write here; valid claims live in claims/*
    ready:
      player_0: true | 'left'
      ...
```

## Module layout

```
Tambola MP/
├── index.html              # single SPA entry
├── style.css               # phone + tv layouts, scoped via body[data-mode]
├── public/
│   ├── manifest.json
│   ├── sw.js               # cache name "tambola-mp-v1"
│   ├── icons/
│   ├── images/
│   └── sounds/             # draw, mark, claim, win, error + numbers/1-90.mp3
└── src/
    ├── firebase-config.js          # shared Firebase project
    ├── firebase-sync.js            # tambola-mp-rooms/ namespace, 20-player support
    ├── ticket-generator.js         # standard Tambola ticket generation
    ├── claim-validator.js          # 5 patterns
    ├── game-engine.js              # state, draw, claimable patterns
    ├── sound-manager.js            # init(role), playSound, speakNumber, mute
    ├── platform-ui.js              # showScreen, showToast, confirmModal
    ├── qr.js                       # dependency-free QR svg
    ├── tv-controller.js            # TV-host flow + render
    ├── phone-controller.js         # phone flow + render
    └── main.js                     # entry: home screen, role selection, role-dispatch
```

## Screens

All screens share `index.html`. Visible based on `data-mode` and the active screen id.

**Common screens (both modes):**
1. `#home` — title, two role buttons (TV / Player).

**TV-mode screens (`data-mode="tv"`):**
2. `#tv-create` — host name + emoji form, Create Room button, Back.
3. `#tv-lobby` — huge room code + QR, player list, Start Round button, mute, leave.
4. `#tv-game` — caller ball, called grid, mini-ticket strip, host controls (next/auto/pause/end), winner banner overlay.
5. `#tv-results` — winner cards per pattern, Play Again, Close Room.

**Phone-mode screens (`data-mode="phone"`):**
2. `#phone-join` — code input (auto-filled from `?code=` if present), name, emoji, Join, Back.
3. `#phone-lobby` — room code, players list, "Waiting for host", Leave.
4. `#phone-game` — small called badge + last 3 calls, ticket grid, claim row, autocut + mute toggles.
5. `#phone-results` — winners list, Play Again (host's responsibility), Home.

## Game flow

### TV draws a number
```
tv user taps "Next Number" (or auto-call timer fires)
  │
  ▼
tv engine: drawNumber(state) → { number, newState }
  │
  ▼
firebase write: append to drawnNumbers, update currentNumber, drawIndex
  │
  ▼
all clients receive onValue update
  │
  ├─► TV: speak number, animate ball, highlight on grid, light up cells in mini-tickets
  └─► Phones: chime, update called badge, auto-strike if autocut on
```

### Player makes a claim
```
phone taps "Top Line"
  │
  ▼
phone writes: claimRequests/{requestId} = { pattern, playerIndex, ts }
  │
  ▼
TV onValue picks up the new request
  │
  ▼
TV validates: validateClaim(ticket, marked, calledSet, pattern)
  │
  ├─► valid → write claims/{pattern} = { won: true, winner, wonAt, playerName, patternLabel }
  │           and remove the request
  │
  └─► invalid → write claimResults/{requestId} = { valid: false, reason }
                phone watches its own request id, shows toast, clears request
```

This guarantees no race condition: only the TV-host resolves claims; phones never write to `claims`. The first valid claim writes the winner; subsequent claims for the same pattern hit the "already won" branch and get the invalid response.

## TV layout (active game)

```
┌─────────────────────────────────────────────────────┐
│  🐍 Tambola MP            mute🔇  pause⏸  end⏹     │  ← header bar
├──────────────────────┬──────────────────────────────┤
│                      │   1  2  3  4  5  6  7  8  9 │
│       🟡             │  10 11 12 13 14 15 16 17 18 │
│       42             │  …                          │
│                      │                              │ ← called grid
│   Last 5: 7,…        │  82 83 84 85 86 87 88 89 90 │
├──────────────────────┴──────────────────────────────┤
│ [Pat 🎫] [Sam 🎫] [Asha 🎫] [Raj 🎫] [Meera 🎫]    │ ← mini ticket strip
│ [Vik 🎫] [Tara 🎫] …                                │
└─────────────────────────────────────────────────────┘
```

Mini-tickets render as compact 3×9 grids. Names truncate. As pattern wins happen, a small badge appears on the winner's mini-ticket.

## Phone layout (active game)

```
┌──────────────────┐
│ Tambola MP       │
│ Called: 42       │
│ Last 3: 7,12,42  │
├──────────────────┤
│   ┌────────────┐ │
│   │ 3×9 ticket │ │  big enough to tap
│   │ grid       │ │
│   └────────────┘ │
│ [Top][Mid][Bot]  │
│ [Crn][Full]      │  claim row
│ ☐ Auto-cut  ☐ 🔇 │
└──────────────────┘
```

## Service worker (tambola-mp-v1)

Same approach as the rest of the workspace:
- Network-first for `.js`, `.css`, `/index.html`, `/assets/*`.
- Cache-first for `/images/*`, `/icons/*`, `/sounds/*` (including all 90 number files).
- `SKIP_WAITING` postMessage support for hot reload.

## Session persistence

- Key: `tambola_mp_session`
- Phone: `{ roomCode, playerIndex, role: 'phone' }`
- TV: `{ roomCode, role: 'tv' }`
- On boot, the saved session is restored if the room still exists. If status is `ended` or the room is gone, the session is cleared and Home is shown.

## Listener cleanup

Each controller exposes `cleanup()` which unsubscribes its `onValue` and clears any timers (auto-call, banner). Cleanup runs:
- When a player leaves the lobby.
- When the TV-host closes the room.
- When the page unloads (`beforeunload`).
- When switching screens that no longer need the listener.

## Build and deploy

- Vite single-entry build (no multi-entry needed since one HTML).
- Vercel framework "Vite", build command `npm run build`, output `dist`.
- `.env` shared with the rest of the workspace.
- **Firebase rules need a `tambola-mp-rooms` block.** User must add this before live testing:

  ```json
  "tambola-mp-rooms": {
    ".read": "auth != null",
    ".write": "auth != null"
  }
  ```
