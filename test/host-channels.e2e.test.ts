import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MafiaClient } from '../src/bots/client.js';
import { createApp } from '../src/server/http.js';
import { MemoryRoomStore } from '../src/store/memory.js';

/**
 * What a model can actually work with, per host.
 *
 * Hosts show their model only ONE half of a tool result: the `content` text
 * (claude.ai) or the `structuredContent` (Claude Code / Agent SDK). These
 * tests play from each half alone, and cover the two dead ends that came out
 * of that: a silently anonymous view when the seat key is dropped, and a
 * tied/empty vote that could not be closed on a host that never answers
 * elicitation.
 */

let server: ServerType;
let url = '';

beforeAll(async () => {
  const app = createApp(new MemoryRoomStore());
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      url = `http://127.0.0.1:${info.port}/mcp`;
      resolve();
    });
  });
});

afterAll(() => server?.close());

async function startedRoom(n = 6) {
  const mod = new MafiaClient(url, 'mod');
  await mod.connect();
  const code = (await mod.must('create_room', { name: 'Mod', featured: false })).projection!.room;
  const everyone = [mod];
  for (let i = 1; i < n; i++) {
    const p = new MafiaClient(url, `P${i}`);
    await p.connect();
    await p.must('join_room', { room: code, name: `P${i}` });
    everyone.push(p);
  }
  await mod.must('start_game', { room: code });
  return { code, mod, everyone };
}

/**
 * A host that never answers server->client requests: one tools/call POST, read
 * the SSE stream to the end, ignore any elicitation/create on it.
 */
async function silentHostCall(name: string, args: Record<string, unknown>) {
  const started = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const messages = (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as { id?: number; method?: string; result?: Record<string, unknown> });
  const result = messages.find((m) => m.id === 1 && m.result)!.result as {
    content: { text: string }[];
    structuredContent?: { phase?: string; message?: string };
    isError?: boolean;
  };
  return {
    ms: Date.now() - started,
    elicited: messages.some((m) => m.method === 'elicitation/create'),
    text: result.content[0]!.text,
    structured: result.structuredContent,
    isError: result.isError === true,
  };
}

describe('the text half of a result is enough to play from', () => {
  it('tells each player their own role, who is alive, and nothing they should not know', async () => {
    const { code, everyone } = await startedRoom(7);
    const names = ['Mod', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'];
    const mafiaNames: string[] = [];
    const replies = [];
    for (const p of everyone) {
      const reply = await p.must('get_state', { room: code });
      replies.push(reply);
      if (reply.projection!.you!.role === 'MAFIA') mafiaNames.push(reply.projection!.you!.name);
    }
    for (const reply of replies) {
      const you = reply.projection!.you!;
      // Own role, by name, in the text.
      expect(reply.text).toMatch(new RegExp(`You: ${you.name} — your secret role is ${you.role}, alive`));
      // Everyone who can be named as a target.
      const aliveLine = reply.text.split('\n').find((l) => l.startsWith('Alive (7): '))!;
      for (const name of names) expect(aliveLine).toContain(name);
      // The text must not widen what the projection already exposes.
      if (you.role === 'MAFIA') {
        for (const mate of mafiaNames.filter((m) => m !== you.name)) expect(reply.text).toContain(mate);
        expect(reply.text).toContain('Private — your fellow mafia');
      } else {
        expect(reply.text).not.toContain('Private —');
        expect(reply.text).not.toContain('fellow mafia');
      }
      expect(reply.text).not.toContain('All roles');
    }
    for (const p of everyone) await p.close();
  });

  it('carries narration, deaths, and the detective’s private result', async () => {
    const { code, mod, everyone } = await startedRoom(6);
    const views = await Promise.all(everyone.map((p) => p.state()));
    const mafia = everyone[views.findIndex((v) => v.you!.role === 'MAFIA')]!;
    const detective = everyone[views.findIndex((v) => v.you!.role === 'DETECTIVE')]!;
    const mafiaName = views.find((v) => v.you!.role === 'MAFIA')!.you!.name;
    const victim = views.find((v) => v.you!.role === 'VILLAGER')!.you!;

    // Name-based targeting: all a text-only model has is names.
    await mafia.must('submit_night_action', { room: code, target_player_id: victim.name });
    const picked = await detective.must('submit_night_action', { room: code, target_player_id: mafiaName });
    expect(picked.text).toContain(`Private — your night target: ${mafiaName}`);

    const dawn = await mod.must('advance_phase', { room: code });
    expect(dawn.text).toContain('Latest narration: ');
    expect(dawn.text).toContain(dawn.projection!.narration.at(-1)!.text);
    expect(dawn.text).toMatch(new RegExp(`Out \\(1\\): ${victim.name} \\(Villager, killed at night\\)`));

    const result = await detective.must('get_state', { room: code });
    expect(result.text).toContain(`Private — your investigations: Night 1: ${mafiaName} is MAFIA`);
    // ...and only the detective's text has it.
    const other = await mafia.must('get_state', { room: code });
    expect(other.text).not.toContain('your investigations');

    // The dead see everything — in text too.
    const ghost = everyone.find((p) => p.name === victim.name || (victim.name === 'Mod' && p.name === 'mod'))!;
    const beyond = await ghost.must('get_state', { room: code });
    expect(beyond.text).toContain('All roles (you can see them because you are out)');
    for (const p of everyone) await p.close();
  });
});

describe('the structured half of a result is enough to play from', () => {
  it('carries the lead sentence as `message`', async () => {
    const mod = new MafiaClient(url, 'mod');
    await mod.connect();
    const created = await mod.must('create_room', { name: 'Mod', featured: false });
    const structured = created.projection as unknown as { message?: string; room: string };
    expect(structured.message).toContain(`Share the code ${structured.room}`);
    await mod.close();
  });
});

describe('a dropped or mangled seat key is called out, not silently ignored', () => {
  it('explains the public view instead of looking like "you are not in this game"', async () => {
    const { code, mod, everyone } = await startedRoom(5);
    const token = mod.playerToken!;

    const none = await mod.call('get_state', { room: code }, { anonymous: true });
    expect(none.projection!.you).toBeNull();
    expect(none.text).toContain('no player_token was passed');
    expect(none.text).toContain('do NOT join again');
    expect((none.projection as unknown as { message: string }).message).toContain('no player_token was passed');

    const mangled = await mod.call('get_state', { room: code, player_token: token.slice(0, -2) }, { anonymous: true });
    expect(mangled.projection!.you).toBeNull();
    expect(mangled.text).toContain('not valid');

    const good = await mod.call('get_state', { room: code, player_token: token });
    expect(good.projection!.you).not.toBeNull();
    expect(good.text).not.toContain('Public view only');
    for (const p of everyone) await p.close();
  });
});

describe('closing a vote that banishes nobody, on a host that never answers elicitation', () => {
  it('does not dead-end: explains, then closes on an explicit confirmation', async () => {
    const { code, mod, everyone } = await startedRoom(5);
    for (let i = 0; i < 3; i++) await mod.must('advance_phase', { room: code }); // -> DAY_VOTE, no votes
    const token = mod.playerToken!;

    // Chat path, no confirmation yet: the vote must stay open (never close
    // silently), but the reply has to say why and how to go on.
    const first = await silentHostCall('advance_phase', { room: code, player_token: token });
    expect(first.elicited).toBe(true);
    expect(first.structured!.phase).toBe('DAY_VOTE');
    expect(first.text).toContain('no votes have been cast');
    expect(first.structured!.message).toContain('no votes have been cast');
    const expected = JSON.parse(/expected set to (\{.*?\})/.exec(first.text)![1]!) as Record<string, unknown>;
    expect(expected).toMatchObject({ phase: 'DAY_VOTE', voteOutcome: 'none' });

    // The confirmation it spelled out closes the vote — without asking again.
    const second = await silentHostCall('advance_phase', { room: code, player_token: token, expected });
    expect(second.elicited).toBe(false);
    expect(second.ms).toBeLessThan(5_000);
    expect(second.structured!.phase).toBe('DUSK');
    for (const p of everyone) await p.close();
  }, 40_000);

  it('still refuses when the confirmed "nobody" is no longer the outcome', async () => {
    const { code, mod, everyone } = await startedRoom(5);
    for (let i = 0; i < 3; i++) await mod.must('advance_phase', { room: code });
    const expected = (await mod.state()).phaseConfirmation!;
    expect(expected.voteOutcome).toBe('none');
    const target = (await everyone[2]!.state()).you!.id;
    await everyone[1]!.must('cast_vote', { room: code, target_player_id: target });

    const stale = await silentHostCall('advance_phase', { room: code, player_token: mod.playerToken!, expected });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('outcome changed');
    expect((await mod.state()).phase).toBe('DAY_VOTE');
    for (const p of everyone) await p.close();
  });
});
