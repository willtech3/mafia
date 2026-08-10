import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MafiaClient } from '../src/bots/client.js';
import { createApp } from '../src/server/http.js';
import { MemoryRoomStore } from '../src/store/memory.js';

/**
 * Regression tests for the critique-round-1 security fixes:
 *  - a public display name can NEVER hand back another seat's token or
 *    secret role (the P0 seat-hijack / role-leak),
 *  - duplicate novice names get disambiguated instead of colliding.
 */

let server: ServerType;
let url = '';

beforeAll(async () => {
  const store = new MemoryRoomStore();
  await new Promise<void>((resolve) => {
    server = serve({ fetch: createApp(store).fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      url = `http://127.0.0.1:${info.port}/mcp`;
      resolve();
    });
  });
});

afterAll(() => server?.close());

describe('name-based seat hijack is impossible', () => {
  it('a stranger joining with an existing name gets a NEW seat, not the victim role/token', async () => {
    const mod = new MafiaClient(url, 'mod');
    await mod.connect();
    const code = (await mod.must('create_room', { name: 'Mod' })).projection!.room;

    const victim = new MafiaClient(url, 'victim');
    await victim.connect();
    const vJoin = await victim.must('join_room', { room: code, name: 'Sam' });
    const victimSeatId = vJoin.projection!.you!.id;
    const victimToken = victim.playerToken;

    // Start so the victim holds a secret role.
    for (let i = 0; i < 3; i++) {
      const filler = new MafiaClient(url, `F${i}`);
      await filler.connect();
      await filler.must('join_room', { room: code, name: `Filler ${i}` });
    }
    await mod.must('start_game', { room: code });
    const victimRole = (await victim.state()).you!.role;
    expect(victimRole).toBeTruthy();

    // Attacker: fresh connection, no token, claims the public name "Sam".
    const attacker = new MafiaClient(url, 'attacker');
    await attacker.connect();
    const steal = await attacker.call('join_room', { room: code, name: 'Sam' });

    // Post-start joiner becomes a spectator on a DIFFERENT seat — never the victim's.
    expect(steal.isError).toBe(false);
    expect(steal.projection!.you!.id).not.toBe(victimSeatId);
    expect(steal.projection!.you!.spectator).toBe(true);
    expect(steal.projection!.you!.role).toBeNull();
    // The minted token is the attacker's own spectator seat, not the victim's.
    expect(steal.playerToken).not.toBe(victimToken);
    // A late-join spectator gets the PUBLIC view only — no role reveal at all.
    expect(steal.projection!.reveal).toBeUndefined();

    // The victim's own token still resolves to the victim, unharmed.
    const recheck = await victim.must('get_state', { room: code });
    expect(recheck.projection!.you!.id).toBe(victimSeatId);
    expect(recheck.projection!.you!.role).toBe(victimRole);

    await Promise.all([mod, victim, attacker].map((c) => c.close()));
  }, 30_000);

  it('a name-less join returns a full RENDERABLE public projection (no crash payload, no secrets)', async () => {
    const mod = new MafiaClient(url, 'mod3');
    await mod.connect();
    const code = (await mod.must('create_room', { name: 'Mod' })).projection!.room;

    const curious = new MafiaClient(url, 'curious');
    await curious.connect();
    const ask = await curious.call('join_room', { room: code });

    // A friendly ask, not a red error chip.
    expect(ask.isError).toBe(false);
    expect(ask.text).toContain('display name');
    // The app iframe renders structuredContent: it must be a complete public
    // projection (phase present), with no seat, token, or private blocks.
    expect(ask.projection!.phase).toBe('LOBBY');
    expect(Array.isArray(ask.projection!.players)).toBe(true);
    expect(ask.projection!.you ?? null).toBeNull();
    expect((ask.projection as unknown as Record<string, unknown>)['player_token']).toBeUndefined();
    expect(ask.projection!.mafia).toBeUndefined();

    await Promise.all([mod, curious].map((c) => c.close()));
  }, 30_000);

  it('30-char names (the sanitize cap) still disambiguate instead of colliding', async () => {
    const mod = new MafiaClient(url, 'mod4');
    await mod.connect();
    const code = (await mod.must('create_room', { name: 'Mod' })).projection!.room;

    const long = 'X'.repeat(30); // sanitizeName caps at 30
    const a = new MafiaClient(url, 'la');
    await a.connect();
    const b = new MafiaClient(url, 'lb');
    await b.connect();
    const ja = await a.must('join_room', { room: code, name: long });
    const jb = await b.must('join_room', { room: code, name: long });

    expect(ja.projection!.you!.name).toBe(long);
    const second = jb.projection!.you!.name;
    expect(second).not.toBe(long); // the counter must survive the 30-char cap
    expect(second.length).toBeLessThanOrEqual(30);
    expect(second).toMatch(/\(\d+\)$/);

    await Promise.all([mod, a, b].map((c) => c.close()));
  }, 30_000);

  it('two novices with the same name both get seats (disambiguated)', async () => {
    const mod = new MafiaClient(url, 'mod2');
    await mod.connect();
    const code = (await mod.must('create_room', { name: 'Mod' })).projection!.room;

    const a = new MafiaClient(url, 'a');
    await a.connect();
    const b = new MafiaClient(url, 'b');
    await b.connect();
    const ja = await a.must('join_room', { room: code, name: 'Alex' });
    const jb = await b.must('join_room', { room: code, name: 'Alex' });

    expect(ja.projection!.you!.id).not.toBe(jb.projection!.you!.id);
    expect(ja.projection!.you!.name).toBe('Alex');
    expect(jb.projection!.you!.name).toMatch(/^Alex \(\d\)$/);
    // Lobby holds both (mod + 2), nobody was silently merged.
    expect(jb.projection!.lobbyCount).toBe(3);

    await Promise.all([mod, a, b].map((c) => c.close()));
  }, 30_000);
});
