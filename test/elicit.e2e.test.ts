import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MafiaClient } from '../src/bots/client.js';
import { elicitForm } from '../src/server/elicit.js';
import { createApp } from '../src/server/http.js';
import { MemoryRoomStore } from '../src/store/memory.js';

/**
 * Elicitation, all four paths: accept (same instance), accept (response
 * relayed via the OTHER instance — the stateless multi-replica drill),
 * decline, and unsupported-client fallback. Plus the orphan-response relay
 * endpoint itself.
 */

let store: MemoryRoomStore;
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
  store = new MemoryRoomStore();
  ({ server: serverA, url: urlA } = await listen(createApp(store)));
  ({ server: serverB, url: urlB } = await listen(createApp(store)));
});

afterAll(() => {
  serverA?.close();
  serverB?.close();
});

/**
 * Room in NIGHT with a known mafia client attached. Every player client is
 * built with `mafiaOpts` (the elicit handler / cross-fetch), so whichever seat
 * is dealt MAFIA already has the capability — no name-reclaim needed (name
 * reclaim is deliberately impossible now; see security.e2e.test.ts).
 */
async function nightRoom(mafiaOpts: ConstructorParameters<typeof MafiaClient>[2]) {
  const mod = new MafiaClient(urlA, 'mod', mafiaOpts);
  await mod.connect();
  const created = await mod.must('create_room', { name: 'Mod', featured: false });
  const code = created.projection!.room;
  const players: MafiaClient[] = [];
  for (let i = 1; i <= 6; i++) {
    const p = new MafiaClient(urlA, `P${i}`, mafiaOpts);
    await p.connect();
    await p.must('join_room', { room: code, name: `P${i}` });
    players.push(p);
  }
  await mod.must('start_game', { room: code });
  const everyone = [mod, ...players];
  let mafia: MafiaClient | undefined;
  for (const p of everyone) {
    const view = await p.state();
    if (view.you?.role === 'MAFIA') mafia = p;
  }
  if (!mafia) throw new Error('no mafia found');
  return { code, mod, mafia, everyone };
}

describe('night-action elicitation', () => {
  it('accepts a choice made through the private picker (same instance)', async () => {
    let sawPrompt = '';
    const { code, mafia } = await nightRoom({
      onElicit: (params) => {
        sawPrompt = params.message;
        const schema = params.requestedSchema as {
          properties: { target: { oneOf: { const: string; title: string }[] } };
        };
        const options = schema.properties.target.oneOf;
        expect(options.length).toBeGreaterThanOrEqual(5); // everyone alive but self
        expect(options.some((o) => o.title.includes('(yourself)'))).toBe(false); // mafia can't self-target
        return { action: 'accept', content: { target: options[0]!.const } };
      },
    });
    const reply = await mafia.must('submit_night_action', { room: code });
    expect(sawPrompt).toContain('target');
    expect(reply.projection!.you!.nightTarget).toBeDefined();
    expect(reply.text).toContain('night action is in');
  });

  it('relays the answer across instances (response lands on the other replica)', async () => {
    // Route bare JSON-RPC *responses* to instance B while everything else
    // goes to instance A — the exact failure mode of a round-robin LB.
    const crossFetch: typeof fetch = async (input, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      const isBareResponse = body.includes('"result"') && !body.includes('"method"');
      const target = isBareResponse ? urlB : (input as URL | string);
      return fetch(target as string, init);
    };
    const { code, mafia } = await nightRoom({
      onElicit: (params) => {
        const schema = params.requestedSchema as {
          properties: { target: { oneOf: { const: string }[] } };
        };
        return { action: 'accept', content: { target: schema.properties.target.oneOf[0]!.const } };
      },
      fetch: crossFetch,
    });
    const reply = await mafia.must('submit_night_action', { room: code });
    expect(reply.projection!.you!.nightTarget).toBeDefined();
  }, 30_000);

  it('records nothing when the player declines', async () => {
    const { code, mafia } = await nightRoom({ onElicit: () => ({ action: 'decline' }) });
    const reply = await mafia.must('submit_night_action', { room: code });
    expect(reply.text).toContain('No action recorded');
    expect(reply.projection!.you!.nightTarget).toBeUndefined();
  });

  it('teaches the tap fallback when the client cannot elicit', async () => {
    const { code, mafia } = await nightRoom({}); // no elicitation capability
    const reply = await mafia.call('submit_night_action', { room: code });
    expect(reply.isError).toBe(false); // live board rides along for tapping
    expect(reply.text).toContain('Tap your target');
    expect(reply.projection!.you!.nightTarget).toBeUndefined();
  }, 30_000);

  it('still validates explicit targets exactly as before', async () => {
    const { code, mafia, everyone } = await nightRoom({});
    const view = await mafia.state();
    const victim = view.players.find((t) => t.id !== view.you!.id && t.alive)!;
    const reply = await mafia.must('submit_night_action', { room: code, target_player_id: victim.id });
    expect(reply.projection!.you!.nightTarget?.id).toBe(victim.id);
    for (const p of everyone) await p.close();
  });
});

describe('orphan response relay', () => {
  it('parks bare JSON-RPC responses arriving at any instance', async () => {
    const response = await fetch(urlB, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 987654321, result: { action: 'accept', content: { target: 'x' } } }),
    });
    expect(response.status).toBeLessThan(300);
    const parked = (await store.takeOrphanResponse('987654321')) as { result?: { action?: string } } | null;
    expect(parked?.result?.action).toBe('accept');
  });
});

describe('vote-close confirmation (tie / empty vote only)', () => {
  it('keeps the vote open when the moderator declines', async () => {
    const mod = new MafiaClient(urlA, 'mod2', { onElicit: () => ({ action: 'decline' }) });
    await mod.connect();
    const created = await mod.must('create_room', { name: 'Mod2', featured: false });
    const code = created.projection!.room;
    for (let i = 1; i <= 4; i++) {
      const p = new MafiaClient(urlA, `Q${i}`);
      await p.connect();
      await p.must('join_room', { room: code, name: `Q${i}` });
      await p.close();
    }
    await mod.must('start_game', { room: code });
    await mod.must('advance_phase', { room: code }); // -> DAWN
    await mod.must('advance_phase', { room: code }); // -> DAY_DISCUSSION
    await mod.must('advance_phase', { room: code }); // -> DAY_VOTE
    // No votes cast: closing would banish nobody -> confirmation -> decline.
    const reply = await mod.must('advance_phase', { room: code });
    expect(reply.text).toContain('vote stays open');
    expect(reply.projection!.phase).toBe('DAY_VOTE');
    await mod.close();
  }, 30_000);
});

describe('vote-close race and failed confirmation', () => {
  it('refuses to banish someone when the accepted warning promised no banishment', async () => {
    let voter: MafiaClient;
    let target = '';
    let code = '';
    const setup = await nightRoom({ onElicit: async () => {
      await voter.must('cast_vote', { room: code, target_player_id: target });
      return { action: 'accept', content: { confirm: true } };
    } });
    code = setup.code;
    voter = setup.everyone[1]!;
    target = (await setup.everyone[2]!.state()).you!.id;
    for (let i = 0; i < 3; i++) await setup.mod.must('advance_phase', { room: code });
    const result = await setup.mod.call('advance_phase', { room: code });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('outcome changed');
    const state = await setup.mod.state();
    expect(state.phase).toBe('DAY_VOTE');
    expect(state.players.find(p => p.id === target)?.alive).toBe(true);
    for (const p of setup.everyone) await p.close();
  });

  it('keeps voting open when a capable client fails to answer', async () => {
    const setup = await nightRoom({ onElicit: () => { throw new Error('Connection interrupted'); } });
    for (let i = 0; i < 3; i++) await setup.mod.must('advance_phase', { room: setup.code });
    const result = await setup.mod.must('advance_phase', { room: setup.code });
    expect(result.projection!.phase).toBe('DAY_VOTE');
    expect(result.text).toContain('vote stays open');
    for (const p of setup.everyone) await p.close();
  });
});
