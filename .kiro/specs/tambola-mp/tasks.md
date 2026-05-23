# Tambola MP — Implementation Tasks

- [x] 1. Project scaffold (package.json, vite.config, vercel.json, .env, .gitignore, manifest)

- [x] 2. Lift assets from existing Tambola (icons, images, all 95 sound files including 90 number announcements)

- [x] 3. Source modules
  - [x] firebase-config.js (anonymous auth, env-driven)
  - [x] firebase-sync.js (tambola-mp-rooms namespace, 20-player support, claim request/resolve flow, TV-host record)
  - [x] ticket-generator.js (lifted unchanged)
  - [x] claim-validator.js (5 patterns: top/middle/bottom line, corners, full house — no Early Five)
  - [x] game-engine.js (createGameState, drawNumber, awardClaim, evaluateClaim, getCalledSet, reconstructFromFirebase)
  - [x] sound-manager.js (initAudio with role flag — TV gets number-buffer preload, phone skips)
  - [x] platform-ui.js (showScreen, showToast, confirmModal)
  - [x] qr.js (dependency-free QR svg, alphanumeric, versions 1-10)
  - [x] tv-controller.js (TV-host: home → create → lobby → game → results, autocall timer, claim resolution)
  - [x] phone-controller.js (phone: join → lobby → game → results, manual & auto cut, claim submission)
  - [x] main.js (entry: home + role selection, session restore, SW registration)

- [x] 4. HTML + CSS
  - [x] index.html (single SPA, all screens for TV + phone + home + results + modals + update toast)
  - [x] style.css (phone styles + TV styles, scoped via body[data-mode])

- [x] 5. Service worker (public/sw.js — tambola-mp-v1, network-first HTML/JS/CSS, cache-first assets, all 90 number files precached)

- [x] 6. Vite single-entry config

- [x] 7. Build verification — `npm install` + `npm run build` succeed
  - 27 modules transformed
  - dist/index.html 11.77 kB
  - dist/assets/index.css 15.4 kB (gzip 3.68 kB)
  - dist/assets/index.js 36.8 kB (gzip 11.88 kB)
  - dist/assets/firebase.js 231.7 kB (gzip 68.87 kB)

- [x] 8. README.md with deployment notes and Firebase rule snippet
