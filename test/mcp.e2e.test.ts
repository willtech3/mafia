import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MafiaClient } from '../src/bots/client.js';
import type { Projection } from '../src/game/view.js';
import { createApp } from '../src/server/http.js';
import { MemoryRoomStore } from '../src/store/memory.js';

/**
 * End-to-end over real streamable HTTP with the real MCP SDK client, and the
 * local statelessness drill: TWO independent server apps share ONE store;
 * every player talks to a randomly chosen instance on every call. If any
 * game state ever lived in process memory, this test would fall apart.
 */

let serverA: ServerType;
let serverB: ServerType;
let urlA = '';
let urlB = '';

function listen(app: ReturnType<typeof createApp>): Promise<{ server: ServerType; url: string }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      resolve({ server, url: `http://127.0.0.1:${info.port}/mcp` });
    });
  });
}

beforeAll(async () => {
  const store = new MemoryRoomStore(); // one shared store, two "replicas"
  ({ server: serverA, url: urlA } = await listen(createApp(store)));
  ({ server: serverB, url: urlB } = await listen(createApp(store)));
});

afterAll(() => {
  serverA?.close();
  serverB?.close();
});

function anyInstance(): string {
  return Math.random() < 0.5 ? urlA : urlB;
}

describe('full game over MCP, alternating between two instances', () => {
  it('plays to a town win with correct per-viewer redaction on the wire', async () => {
    const mod = new MafiaClient(anyInstance(), 'mod');
    await mod.connect();
    expect(mod.instructions).toContain('MAFIA');

    const created = await mod.must('create_room', { name: 'Mod' });
    const code = created.projection!.room;
    expect(code).toMatch(/^[A-Z]{4}$/);
    expect(mod.playerToken).toBeTruthy();

    // Six players join; each speaks to a random instance.
    const players: MafiaClient[] = [];
    for (let i = 1; i <= 6; i++) {
      const p = new MafiaClient(anyInstance(), `P${i}`);
      await p.connect();
      // Exercise the blind-join path: no room code given.
      const reply = await p.must('join_room', { name: `P${i}` });
      expect(reply.projection!.room).toBe(code);
      players.push(p);
    }

    const everyone = [mod, ...players];
    await mod.must('start_game', { room: code });

    // Each player learns only their own role over the wire.
    const roles = new Map<string, string>();
    for (const p of everyone) {
      const view = await p.state();
      expect(view.phase).toBe('NIGHT');
      expect(view.you?.role).toBeTruthy();
      roles.set(p.name, view.you!.role!);
      const raw = JSON.stringify(view);
      if (view.you!.role !== 'MAFIA') {
        expect(raw, `${p.name} must not see mafia info`).not.toContain('teammates');
        expect(raw).not.toContain('killsTonight');
      }
    }
    const mafiaBot = everyone.find((p) => roles.get(p.name) === 'MAFIA')!;
    const villagers = everyone.filter((p) => roles.get(p.name) === 'VILLAGER');
    const detectiveBot = everyone.find((p) => roles.get(p.name) === 'DETECTIVE')!;

    // Night 1: mafia kills a villager, detective investigates the mafia.
    const mafiaView = await mafiaBot.state();
    const victimName = villagers[0]!.name === mod.name ? villagers[1]!.name : villagers[0]!.name;
    const victimTile = mafiaView.players.find((t) => t.name === victimName)!;
    await mafiaBot.must('submit_night_action', { room: code, target_player_id: victimTile.id });

    const mafiaSelfId = mafiaView.you!.id;
    await detectiveBot.must('submit_night_action', { room: code, target_player_id: mafiaSelfId });

    // Dead player check later needs the victim's client.
    const victimBot = everyone.find((p) => p.name === victimName)!;

    await mod.must('advance_phase', { room: code }); // -> DAWN
    const dawn = await victimBot.state();
    expect(dawn.phase).toBe('DAWN');
    expect(dawn.you!.alive).toBe(false);
    expect(dawn.reveal, 'dead player becomes omniscient').toBeDefined();

    // The detective got a private result; a villager did not.
    const detView = await detectiveBot.state();
    expect(detView.detective?.results?.[0]?.result).toBe('MAFIA');
    const bystander = everyone.find(
      (p) => roles.get(p.name) === 'VILLAGER' && p.name !== victimName,
    )!;
    const bysView = await bystander.state();
    expect(JSON.stringify(bysView)).not.toContain('"result":"MAFIA"');

    await mod.must('advance_phase', { room: code }); // -> DAY_DISCUSSION
    await mod.must('advance_phase', { room: code }); // -> DAY_VOTE

    // The dead may not vote — and the error teaches.
    const deadVote = await victimBot.call('cast_vote', { room: code, target_player_id: mafiaSelfId });
    expect(deadVote.isError).toBe(true);
    expect(deadVote.text).toContain('dead');

    // Everyone alive votes out the mafia (detective told them, obviously).
    for (const p of everyone) {
      if (p === victimBot || p === mafiaBot) continue;
      await p.must('cast_vote', { room: code, target_player_id: mafiaSelfId });
    }
    const tally = (await mod.state()).vote!;
    expect(tally.tally[0]!.count).toBe(5);

    await mod.must('advance_phase', { room: code }); // -> DUSK: banished
    await mod.must('advance_phase', { room: code }); // -> win check
    const finale = await mod.state();
    expect(finale.phase).toBe('ENDED');
    expect(finale.winner).toBe('TOWN');
    expect(finale.reveal?.players).toHaveLength(7);

    for (const p of everyone) await p.close();
  }, 60_000);

  it('teaches when joining blind with no featured lobby', async () => {
    // All rooms from the previous test have started or ended; a fresh
    // spectator-less store instance isn't used here on purpose — the prior
    // room is ENDED, not LOBBY, so blind join must fail helpfully.
    const stranger = new MafiaClient(anyInstance(), 'stranger');
    await stranger.connect();
    const reply = await stranger.call('join_room', { name: 'Stray' });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain('room code');
    await stranger.close();
  });

  it('rejects a forged player token', async () => {
    const cheat = new MafiaClient(anyInstance(), 'cheat');
    await cheat.connect();
    const reply = await cheat.call('get_state', {
      room: 'PLUM',
      player_token: 'PLUM.p_deadbeef.000000000000000000000000',
    });
    // Forged token silently resolves to nobody -> public view or room-not-found.
    expect(reply.isError).toBe(true);
    expect(reply.text).not.toContain('MAFIA');
    await cheat.close();
  });
});

describe('projection payload stays lean over the wire', () => {
  it('an 80-player room projection fits comfortably', async () => {
    const store = new MemoryRoomStore();
    const { server, url } = await listen(createApp(store));
    const mod = new MafiaClient(url, 'mod80');
    await mod.connect();
    const created = await mod.must('create_room', { name: 'Mod' });
    const code = created.projection!.room;
    // One connection seats 79 more guests anonymously (token never attached,
    // so each join creates a fresh player instead of reporting mod's seat).
    for (let i = 1; i < 80; i++) {
      const r = await mod.call('join_room', { room: code, name: `Guest ${i}` }, { anonymous: true });
      expect(r.isError).toBe(false);
    }
    await mod.must('start_game', { room: code });
    const view = (await mod.state()) as Projection;
    expect(view.players).toHaveLength(80);
    expect(JSON.stringify(view).length).toBeLessThan(12_000);
    await mod.close();
    server.close();
  }, 60_000);
});
