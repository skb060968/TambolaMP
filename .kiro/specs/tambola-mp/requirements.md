# Tambola MP — Requirements

## Overview

Tambola MP is a "TV + phones" party version of Tambola (Housie / Indian Bingo). All players gather in one physical room and watch a single big screen. One device opens the game URL on the TV browser and creates the room — that device is the **TV-host**, the authoritative game server. Every player (including the person who set up the TV) joins from their **phone** with a 4-letter room code or by scanning the QR code shown on the TV. The TV speaks the called numbers, runs the caller, validates claims, and shows global game state. Each phone holds one ticket and personal controls.

## User Roles

- **TV-host** — first device to open the URL on the big screen and tap "Play on TV", then "Create Room". One per room. Acts as authoritative host: draws numbers, validates claims, manages round lifecycle. Holds no ticket.
- **Player** — every other device (phone). Holds one Tambola ticket and personal controls (mark, claim, autocut, mute). The same human who launched the TV also joins from their own phone as a player.

There is no separate "spectator" role. Anyone with the code joins as a player.

## Core Requirements

### R1 — Home screen and role selection
- R1.1 The same URL serves both views. On load, the device shows the Home screen with two large buttons:
  - **"📺 Play on TV (Host)"** — for the device opening the game on the big screen.
  - **"📱 Join as Player"** — for phones joining the room.
- R1.2 The TV button takes the user to a Create-Room form (name + emoji). On submit, the device becomes the TV-host of a new room.
- R1.3 The Player button takes the user to a Join-Room form (room code + name + emoji). On submit, the device joins as a player.
- R1.4 Choosing TV vs Player is explicit (two buttons), not auto-detected. A laptop, tablet, or actual TV can all be the TV-host equally well.

### R2 — Room creation (TV)
- R2.1 TV generates a 4-letter room code (charset `ABCDEFGHJKLMNPQRSTUVWXYZ`, no digits, no I/O).
- R2.2 The TV-host's record is stored under the room as `meta.host = { name, emoji, uid }`. The host has no ticket and no `player_N` slot.
- R2.3 TV lobby shows: huge room code, QR code that encodes `https://<origin>/?code=ABCD&action=join`, and a live list of joined players.
- R2.4 Start Round button on TV becomes active when at least one player has joined.
- R2.5 If the TV-host closes the browser tab, the room enters a "Host Disconnected" state and is deleted after 60 seconds. Phones see "Host left, returning to Home" and clean up.

### R3 — Player join (phone)
- R3.1 Phone enters code, name, emoji on Join form.
- R3.2 If the QR code is scanned, the code is pre-filled from the URL `?code=` parameter.
- R3.3 Lobby on phone shows: room code, list of joined players (with name + emoji + "(you)" for self), and "Waiting for host to start..." text.
- R3.4 **Maximum 20 players per room.** Joins past 20 are rejected with toast "Room is full (20)".
- R3.5 Player can leave the lobby (Leave button removes their slot from Firebase).
- R3.6 Live updates: when any player joins or leaves, every device's lobby list updates instantly.

### R4 — Tickets
- R4.1 At round start, the TV-host's device generates one valid Tambola ticket per joined player.
- R4.2 Tickets are written to Firebase under `tambola-mp-rooms/{code}/tickets/player_N` as serialized strings (existing format).
- R4.3 Each phone shows only that player's ticket (3×9 grid).
- R4.4 The TV shows a strip of mini-tickets — one per player — each labeled with the player's name + emoji. The strip auto-arranges in 1-2 rows depending on player count (≤10 = single row, 11-20 = two rows).
- R4.5 Ticket cell appearance: the number, struck-through when marked, dimmed when struck. Cells with value 0 (blanks) are visually empty.

### R5 — Drawing numbers (TV-driven)
- R5.1 TV's device runs the draw logic: random pick from remaining pool of 1-90.
- R5.2 Each draw writes to Firebase: appends to `drawnNumbers` array, updates `currentNumber`.
- R5.3 TV speaks the number aloud (Hindi/Indian rank speech files lifted from existing Tambola).
- R5.4 TV layout while active:
  - **Center-left caller**: animated ball with current number, surrounded by a "Last 5: …" strip.
  - **Right number grid**: 9-column × 10-row grid 1-90 with called numbers highlighted.
  - **Bottom mini-ticket strip**: per-player 3×9 mini-tickets labeled with name+emoji, struck cells dimmed; pattern badges appear next to the player's mini-ticket as they win.
- R5.5 Phone shows: a small "called: NN" indicator, plays a soft chime if not muted, strikes the number on the player's ticket if autocut is on.
- R5.6 Auto-call mode: TV-host can enable a 3 / 5 / 8-second auto-draw timer.
- R5.7 Manual mode: TV-host taps "Next Number" to draw.
- R5.8 Pause: TV-host can toggle auto-call off mid-game.

### R6 — Manual and auto cutting (per phone)
- R6.1 Each phone has an "Auto-cut" toggle.
- R6.2 Auto-cut on: when a number is called and exists on that player's ticket, the cell is automatically struck.
- R6.3 Auto-cut off: player taps a ticket cell to strike it. The tap must match a called number; otherwise it shakes briefly (no penalty, just visual rejection).
- R6.4 Auto-cut state is per-player and persists in localStorage (`tambola_mp_autocut`).

### R7 — Claims and validation
- R7.1 Patterns supported: **Top Line** (row 0), **Middle Line** (row 1), **Bottom Line** (row 2), **4 Corners** (first and last numbered cells of rows 0 and 2), **Full House** (all 15 numbers).
- R7.2 Each pattern has at most one winner per round (first valid claim wins; subsequent are rejected).
- R7.3 Phone shows 5 claim buttons. Tapping submits a claim request to Firebase: `claimRequests/{requestId} = { pattern, playerIndex, ts }`.
- R7.4 The TV-host watches `claimRequests`. For each new request:
  - Validates against authoritative state (player's ticket + actual called numbers).
  - Valid → writes `claims/{pattern} = { won: true, winner, wonAt, playerName, patternLabel }` and removes the request.
  - Invalid → writes `claimResults/{requestId} = { valid: false, reason }`. The phone watches its own request and shows an error toast on rejection.
- R7.5 TV shows a winner banner that animates in: "🏆 [name] won [pattern]!" with confetti burst. Banner auto-dismisses after 3 seconds.
- R7.6 Phone shows the same banner, sized for mobile.
- R7.7 No penalty for invalid claims (friendly party game).

### R8 — Round end
- R8.1 Round ends when Full House is won OR TV-host taps "End Round".
- R8.2 Results screen on every device shows: list of pattern winners (or "—" if not won), per-player stats (numbers struck, claims won).
- R8.3 Results screen has "Play Again" (TV-host: starts a new round with fresh tickets, same players) and "Home" (leaves the room).
- R8.4 Non-host phones see "Waiting for host to start new round" until TV-host taps Play Again.

### R9 — Sound
- R9.1 TV plays the called number aloud using the 90 number audio files plus a draw chime.
- R9.2 TV has a mute toggle in the corner.
- R9.3 Phones play soft draw chime, claim ding, win sound, error sound. Phones do **not** speak the number aloud (TV is the announcer).
- R9.4 Each phone has its own mute toggle, independent of the TV.

### R10 — Connectivity and resilience
- R10.1 Every join writes a `connected: true` flag and uses `onDisconnect` to mark `connected: false` on drop.
- R10.2 If a player phone disconnects, their slot is preserved (they can refresh and rejoin via session). Their mini-ticket on the TV shows a dim "disconnected" overlay.
- R10.3 If the TV-host disconnects, the room is deleted after 60 seconds. Phones show a "TV disconnected" overlay and return to Home automatically.
- R10.4 Session persistence: phones save `{ roomCode, playerIndex, role: 'player' }` in localStorage so a refresh rejoins automatically. The TV-host saves `{ roomCode, role: 'tv' }` so a TV browser refresh re-attaches as the same host.

### R11 — UI patterns (consistent with the rest of the workspace)
- R11.1 Custom modals for prompts and confirms (no `prompt()` / `confirm()`).
- R11.2 Back buttons on every setup/lobby screen.
- R11.3 BOM-free UTF-8 source files.
- R11.4 Idempotent listener wiring (`_wired` flag pattern).
- R11.5 `_resultsShown` guard so results render exactly once.
- R11.6 Listener cleanup on screen exit.
- R11.7 LocalStorage for session persistence (not sessionStorage).
- R11.8 Service worker `tambola-mp-v1`, network-first for HTML/JS/CSS, cache-first for assets.

## Non-functional requirements

- **Mobile-first phones, TV-friendly host view.** Phone styles target 360-414px portrait. TV styles target 1280-3840px landscape.
- **Single URL, single SPA.** No separate `display.html` — the same `index.html` serves both phone and TV layouts via runtime role selection on the Home screen.
- **Low bandwidth.** One Firebase write per draw, one per claim. No per-tick state.
- **Fast first paint.** Vite + lazy Firebase chunk. SW precaches the 90 number audio files plus core assets.
- **No build-time secrets in client code.** `.env` Firebase config is public-style as in the rest of the workspace.

## Out of scope (for v1)

- TV remote keyboard navigation
- Multiple TV displays per room
- Per-player auto-call settings (only the TV-host controls the timer)
- Tournament mode / penalty for invalid claims
- Internationalization (English UI, Indian-Hindi number announcements only)
