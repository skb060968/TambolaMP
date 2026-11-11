import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AccessToken } from 'livekit-server-sdk';

/**
 * Vercel serverless function: mints a short-lived LiveKit access token for the
 * Tambola voice feature (phone players only; the TV host has no voice).
 *
 * Security:
 * 1. The caller must present a valid Firebase anonymous ID token
 *    (Authorization: Bearer <idToken>), verified with jose against Google's
 *    public keys and this app's Firebase project (issuer/audience).
 * 2. The caller must own the requested seat: the Realtime Database is read
 *    through its REST API with the caller's own ID token, and
 *    `<ROOM_NODE>/<code>/players/<identity>/uid` must equal the caller's uid.
 *    Without this, anyone who knew a room code could listen in, or reuse a
 *    real player's identity and kick them out of voice.
 * The LiveKit token is scoped to a per-game namespaced room (`<game>-<code>`).
 *
 * Required Vercel env (server-side, NOT VITE_):
 *   LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
 *   FIREBASE_DATABASE_URL (or VITE_FIREBASE_DATABASE_URL, if exposed to functions)
 * Optional: FIREBASE_PROJECT_ID (defaults to this app's project).
 */

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'skb-games';
const ROOM_NODE = 'tambola-mp-rooms';   // = src/firebase-sync.js ROOM_PATH
const ROOM_RE = /^[A-HJ-NP-Z]{4}$/;
// 20 seats (MAX_PLAYERS) → player_0..player_19.
const IDENTITY_RE = /^player_(?:[0-9]|1[0-9])$/;
const GAME_RE = /^[a-z][a-z0-9-]{1,15}$/;
const MEMBERSHIP_TIMEOUT_MS = 5000;

const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
);

function sanitizeName(value) {
  return String(value || 'Player').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 16) || 'Player';
}

function databaseUrl() {
  return String(process.env.FIREBASE_DATABASE_URL || process.env.VITE_FIREBASE_DATABASE_URL || '')
    .trim().replace(/\/+$/, '');
}

/** Reads the uid that owns `identity` in room `code`, as the caller (rules apply). */
async function seatOwner(dbUrl, code, identity, idToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEMBERSHIP_TIMEOUT_MS);
  try {
    const url = `${dbUrl}/${ROOM_NODE}/${code}/players/${identity}/uid.json?auth=${encodeURIComponent(idToken)}`;
    const response = await fetch(url, { signal: controller.signal });
    if (response.status !== 200) throw new Error(`membership-http-${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method-not-allowed' });
    return;
  }
  try {
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const dbUrl = databaseUrl();
    if (!apiKey || !apiSecret || !dbUrl) {
      res.status(500).json({ error: 'voice-not-configured' });
      return;
    }

    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) {
      res.status(401).json({ error: 'missing-token' });
      return;
    }

    let uid;
    try {
      const { payload } = await jwtVerify(idToken, JWKS, {
        issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
        audience: FIREBASE_PROJECT_ID,
      });
      uid = payload.sub;
      if (!uid) throw new Error('no-subject');
    } catch (_) {
      res.status(401).json({ error: 'invalid-token' });
      return;
    }

    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    } catch (_) {
      res.status(400).json({ error: 'invalid-body' });
      return;
    }
    body = body || {};
    const code = String(body.room || '').toUpperCase();
    const game = String(body.game || '').toLowerCase();
    const identity = String(body.identity || '');
    if (!ROOM_RE.test(code) || !GAME_RE.test(game) || !IDENTITY_RE.test(identity)) {
      res.status(400).json({ error: 'invalid-room-or-identity' });
      return;
    }

    let owner;
    try {
      owner = await seatOwner(dbUrl, code, identity, idToken);
    } catch (_) {
      res.status(503).json({ error: 'membership-check-failed' });
      return;
    }
    if (owner !== uid) {
      res.status(403).json({ error: 'not-in-room' });
      return;
    }

    const room = `${game}-${code}`;

    const token = new AccessToken(apiKey, apiSecret, {
      identity,
      name: sanitizeName(body.name),
      ttl: '2h',
      metadata: JSON.stringify({ uid }),
    });
    token.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });

    const jwt = await token.toJwt();
    res.status(200).json({ token: jwt });
  } catch (error) {
    res.status(500).json({ error: 'token-failed' });
  }
}
