# Tambola MP

A "TV + phones" party version of Tambola (Housie / Indian Bingo). Everyone gathers in one room, one device opens the URL on a TV/big screen and creates the room — that device runs the caller and shows the live game state. Every player joins from their phone with a 4-letter room code or by scanning the QR code on the TV.

## Roles

- **TV-host** — first device to open the URL on the big screen, taps "📺 Play on TV", names themselves, and creates the room. Acts as the authoritative game server: draws numbers, validates claims, manages the round. Holds no ticket.
- **Player** — every other device (phones), including the human who set up the TV. Each gets one Tambola ticket. Tap to mark numbers (or enable Auto-cut), tap pattern buttons to claim.

## Patterns supported

- **Top Line** — full first row
- **Middle Line** — full second row
- **Bottom Line** — full third row
- **4 Corners** — first and last numbered cells of rows 1 and 3
- **Full House** — all 15 numbers (ends the round)

## Stack

- Vite + Vanilla JS (no framework)
- Firebase Realtime Database (shared with the rest of the workspace)
- PWA with service worker `tambola-mp-v1`
- Single SPA: same `index.html` serves both TV and phone via runtime role selection

## Local development

```bash
npm install
npm run dev
```

The dev server opens on a phone-friendly localhost URL. Open it on a desktop browser, click "Play on TV" to test the TV layout. Open the same URL in a phone browser (or the Vite "Network" URL on a real phone) and click "Join as Player".

## Build

```bash
npm run build
```

Produces `dist/` with single `index.html` plus hashed `assets/`.

## Deploy

- Vercel project pointing at this folder (separate from other workspace projects).
- Build command: `npm run build`
- Output directory: `dist`
- Framework preset: Vite

## Firebase rule

Add this block to your existing rules file (sibling to `snl-rooms`, `tambola-rooms`, etc.):

```json
"tambola-mp-rooms": {
  ".read": "auth != null",
  ".write": "auth != null"
}
```

## Project structure

```
Tambola MP/
├── index.html              # single SPA — Home → TV/Phone branches
├── style.css
├── public/
│   ├── manifest.json
│   ├── sw.js               # tambola-mp-v1
│   ├── icons/
│   ├── images/
│   └── sounds/             # 5 chimes + 1.mp3..90.mp3 number announcements
└── src/
    ├── firebase-config.js
    ├── firebase-sync.js    # tambola-mp-rooms namespace, 20-player support
    ├── ticket-generator.js
    ├── claim-validator.js  # 5 patterns
    ├── game-engine.js
    ├── sound-manager.js
    ├── platform-ui.js
    ├── qr.js               # dependency-free QR generator
    ├── tv-controller.js
    ├── phone-controller.js
    └── main.js
```

## Notes

- Up to **20 players** per room.
- 4-letter room codes (charset `ABCDEFGHJKLMNPQRSTUVWXYZ` — no digits, no I/O).
- Phones do NOT speak called numbers — the TV is the announcer. Phones get a soft chime + visual badge.
- Auto-cut and mute are per-phone, persisted in localStorage.
- TV controls: manual Next Number, or Auto Call at 3 / 5 / 8 second intervals.
- Round ends when Full House is won OR the TV-host taps End.
