import { serve, type ServerType } from '@hono/node-server';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MafiaClient } from '../src/bots/client.js';
import { makeVerifier } from '../src/server/oidc.js';
import { createApp } from '../src/server/http.js';
import { MemoryRoomStore } from '../src/store/memory.js';

/**
 * OAuth resource-server path: identity from a verified JWT subject.
 * Seats bind to subjects — reconnects are automatic, names can't be stolen,
 * and the subject itself never leaks into any projection.
 */

const ISSUER = 'https://sso.example.test';
const AUDIENCE = 'mafia-staging';

let server: ServerType;
let url = '';
let signKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

async function jwtFor(subject: string, name: string): Promise<string> {
  return new SignJWT({ name })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(signKey);
}

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  signKey = privateKey;
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'RS256' }] });
  const app = createApp(new MemoryRoomStore(), { oidc: makeVerifier(jwks, ISSUER, AUDIENCE) });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      url = `http://127.0.0.1:${info.port}/mcp`;
      resolve();
    });
  });
});

afterAll(() => server?.close());

describe('SSO identity', () => {
  it('binds seats to subjects: create, reconnect without tokens, no name theft', async () => {
    const aliceJwt = await jwtFor('sso|alice', 'Alice Lane');

    // Alice creates a room — no explicit name; SSO name fills in.
    const alice = new MafiaClient(url, 'alice', { headers: { authorization: `Bearer ${aliceJwt}` } });
    await alice.connect();
    const created = await alice.must('create_room', { featured: false });
    const code = created.projection!.room;
    expect(created.projection!.you!.name).toBe('Alice Lane');
    const aliceSeatId = created.projection!.you!.id;

    // A brand-new connection with the same JWT and NO player token is Alice.
    const alice2 = new MafiaClient(url, 'alice2', { headers: { authorization: `Bearer ${aliceJwt}` } });
    await alice2.connect();
    const state = await alice2.must('get_state', { room: code });
    expect(state.projection!.you?.id).toBe(aliceSeatId);
    expect(state.projection!.you?.isModerator).toBe(true);

    // join_room with the same subject reports the existing seat.
    const rejoin = await alice2.must('join_room', { room: code });
    expect(rejoin.projection!.you!.id).toBe(aliceSeatId);
    expect(rejoin.text).toContain('yours');

    // Bob joins via SSO too.
    const bobJwt = await jwtFor('sso|bob', 'Bob');
    const bob = new MafiaClient(url, 'bob', { headers: { authorization: `Bearer ${bobJwt}` } });
    await bob.connect();
    const bobJoin = await bob.must('join_room', { room: code });
    expect(bobJoin.projection!.you!.name).toBe('Bob');

    // An anonymous chancer cannot steal Bob's subject-bound seat by name.
    const thief = new MafiaClient(url, 'thief');
    await thief.connect();
    const theft = await thief.call('join_room', { room: code, name: 'Bob' });
    expect(theft.isError).toBe(true);
    expect(theft.text).toContain('taken');

    // The SSO subject never appears in any projection.
    for (const reply of [state, rejoin, bobJoin]) {
      expect(JSON.stringify(reply.projection)).not.toContain('sso|');
    }

    // A garbage/foreign JWT quietly falls back to anonymous (public view).
    const forged = new MafiaClient(url, 'forged', {
      headers: { authorization: `Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.AAAA` },
    });
    await forged.connect();
    const publicView = await forged.must('get_state', { room: code });
    expect(publicView.projection!.you).toBeNull();

    for (const c of [alice, alice2, bob, thief, forged]) await c.close();
  }, 30_000);
});
