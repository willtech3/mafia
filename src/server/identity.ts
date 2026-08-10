import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Caller identity, fully stateless: no session state, no store lookups.
 *
 * Resolution order (per DECISIONS.md):
 *   1. OAuth subject from the bearer token         (M3 — not yet wired)
 *   2. Signed player token via Authorization: Bearer (bots, Inspector, tests)
 *   3. Signed player token via the optional `player_token` tool argument
 *      (the path for no-auth interactive clients: join_room mints the token,
 *      the model/app passes it back on every later call)
 *
 * Player tokens are HMAC-signed (room code + player id) so any replica can
 * verify them without touching the store.
 */

/**
 * The HMAC key for player tokens. In a deployed context (Cloud Run sets
 * K_REVISION) a missing secret is fatal: booting with the public dev default
 * would let anyone forge a token for any seat, including the moderator's.
 * Terraform wires MAFIA_TOKEN_SECRET from Secret Manager; this is the guard
 * for a hand-rolled `gcloud run deploy` or a misconfigured revision.
 */
const SECRET = (() => {
  const fromEnv = process.env['MAFIA_TOKEN_SECRET'];
  if (fromEnv) return fromEnv;
  if (process.env['K_REVISION'] || process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'MAFIA_TOKEN_SECRET is required in production (K_REVISION/NODE_ENV set) — refusing to boot with the dev default.',
    );
  }
  return 'dev-secret-not-for-production';
})();

export interface PlayerIdentity {
  roomCode: string;
  playerId: string;
}

function sign(roomCode: string, playerId: string): string {
  return createHmac('sha256', SECRET).update(`${roomCode}|${playerId}`).digest('hex').slice(0, 24);
}

export function mintPlayerToken(roomCode: string, playerId: string): string {
  return `${roomCode}.${playerId}.${sign(roomCode, playerId)}`;
}

export function verifyPlayerToken(token: string): PlayerIdentity | null {
  const parts = token.trim().split('.');
  if (parts.length !== 3) return null;
  const [roomCode, playerId, sig] = parts as [string, string, string];
  const expected = sign(roomCode, playerId);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return { roomCode, playerId };
}

/**
 * Resolve who is calling. `bearer` is the Authorization header token (if
 * any); `tokenArg` is the optional player_token tool argument.
 */
export function resolveIdentity(bearer: string | undefined, tokenArg: string | undefined): PlayerIdentity | null {
  for (const candidate of [bearer, tokenArg]) {
    if (!candidate) continue;
    const id = verifyPlayerToken(candidate);
    if (id) return id;
  }
  return null;
}

export function newPlayerId(): string {
  return `p_${randomBytes(6).toString('hex')}`;
}

/** Room codes: 4 letters, no vowels/ambiguous glyphs (no accidental words or 0/O mixups). */
const CODE_ALPHABET = 'BCDFGHJKMNPQRSTVWXZ';

export function newRoomCode(): string {
  let code = '';
  const bytes = randomBytes(4);
  for (let i = 0; i < 4; i++) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return code;
}

export function normalizeRoomCode(raw: string): string {
  return raw.trim().toUpperCase();
}
