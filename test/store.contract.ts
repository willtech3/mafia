import { expect, it } from 'vitest';
import { GameError } from '../src/game/errors.js';
import { initialRoom } from '../src/game/reducer.js';
import type { RoomState } from '../src/game/types.js';
import { runEvent } from '../src/store/engine.js';
import type { RoomStore } from '../src/store/types.js';

/**
 * Contract suite run against every RoomStore implementation (memory always,
 * Firestore when the emulator is up). Uses runEvent so the scope/plan mapping
 * is exercised exactly as production will.
 */

let codeCounter = 0;

export function storeContract(makeStore: () => Promise<RoomStore>): void {
  async function freshRoom(store: RoomStore, n: number): Promise<string> {
    const code = `C${String(codeCounter++).padStart(3, '0')}`;
    await store.create(
      initialRoom({ code, moderatorId: 'p0', moderatorName: 'P00', seed: `s-${code}`, nowMs: Date.now() }),
    );
    for (let i = 1; i < n; i++) {
      await runEvent(store, code, { type: 'JOIN', playerId: `p${i}`, name: `P${String(i).padStart(2, '0')}`, seq: 0 });
    }
    return code;
  }

  function livingByRole(state: RoomState, role: string) {
    return Object.values(state.players).filter((p) => p.role === role && p.alive);
  }

  it('create + load roundtrip; duplicate code rejected', async () => {
    const store = await makeStore();
    const code = await freshRoom(store, 3);
    const loaded = await store.load(code);
    expect(loaded).not.toBeNull();
    expect(Object.keys(loaded!.state.players)).toHaveLength(3);
    expect(loaded!.state.phase).toBe('LOBBY');
    await expect(
      store.create(initialRoom({ code, moderatorId: 'x', moderatorName: 'X', seed: 's', nowMs: 0 })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await store.load('NOPE')).toBeNull();
  });

  it('plays a full night + vote cycle through runEvent', async () => {
    const store = await makeStore();
    const code = await freshRoom(store, 7);
    await runEvent(store, code, { type: 'START', byPlayerId: 'p0' });

    let { state } = (await store.load(code))!;
    expect(state.phase).toBe('NIGHT');
    const mafia = livingByRole(state, 'MAFIA')[0]!;
    const doctor = livingByRole(state, 'DOCTOR')[0]!;
    const victim = livingByRole(state, 'VILLAGER')[0]!;

    await runEvent(store, code, { type: 'NIGHT_ACTION', playerId: mafia.id, targetId: victim.id, seq: 0 });
    await runEvent(store, code, { type: 'NIGHT_ACTION', playerId: doctor.id, targetId: doctor.id, seq: 0 });

    state = (await store.load(code))!.state;
    expect(state.actions[mafia.id]?.targetId).toBe(victim.id);
    expect(state.actions[doctor.id]?.kind).toBe('PROTECT');

    await runEvent(store, code, { type: 'ADVANCE', byPlayerId: 'p0' }); // -> DAWN
    state = (await store.load(code))!.state;
    expect(state.phase).toBe('DAWN');
    expect(state.players[victim.id]?.alive).toBe(false);
    expect(Object.keys(state.actions)).toHaveLength(0); // action docs stale now

    await runEvent(store, code, { type: 'ADVANCE', byPlayerId: 'p0' }); // -> DAY_DISCUSSION
    await runEvent(store, code, { type: 'ADVANCE', byPlayerId: 'p0' }); // -> DAY_VOTE
    state = (await store.load(code))!.state;
    const voters = Object.values(state.players).filter((p) => p.alive);
    for (const v of voters) {
      await runEvent(store, code, { type: 'VOTE', playerId: v.id, targetId: mafia.id, seq: 0 });
    }
    state = (await store.load(code))!.state;
    expect(Object.keys(state.votes)).toHaveLength(voters.length);

    await runEvent(store, code, { type: 'ADVANCE', byPlayerId: 'p0' }); // -> DUSK
    state = (await store.load(code))!.state;
    expect(state.players[mafia.id]?.alive).toBe(false);

    await runEvent(store, code, { type: 'ADVANCE', byPlayerId: 'p0' }); // win check
    state = (await store.load(code))!.state;
    expect(state.phase).toBe('ENDED');
    expect(state.winner).toBe('TOWN');
  });

  it('rejected events leave the room untouched', async () => {
    const store = await makeStore();
    const code = await freshRoom(store, 5);
    const before = (await store.load(code))!;
    await expect(runEvent(store, code, { type: 'START', byPlayerId: 'p1' })).rejects.toBeInstanceOf(GameError);
    await expect(
      runEvent(store, code, { type: 'VOTE', playerId: 'p1', targetId: 'p2', seq: 0 }),
    ).rejects.toBeInstanceOf(GameError);
    const after = (await store.load(code))!;
    expect(after.state).toEqual(before.state);
    expect(after.version).toBe(before.version);
  });

  it('missing room surfaces ROOM_NOT_FOUND', async () => {
    const store = await makeStore();
    await expect(runEvent(store, 'ZZZZ', { type: 'ADVANCE', byPlayerId: 'p0' })).rejects.toMatchObject({
      code: 'ROOM_NOT_FOUND',
    });
  });

  it('last write wins when a player changes their vote', async () => {
    const store = await makeStore();
    const code = await freshRoom(store, 5);
    await runEvent(store, code, { type: 'START', byPlayerId: 'p0' });
    await runEvent(store, code, { type: 'ADVANCE', byPlayerId: 'p0' });
    await runEvent(store, code, { type: 'ADVANCE', byPlayerId: 'p0' });
    await runEvent(store, code, { type: 'ADVANCE', byPlayerId: 'p0' });
    const { state } = (await store.load(code))!;
    expect(state.phase).toBe('DAY_VOTE');
    const [a, b, c] = Object.values(state.players).filter((p) => p.alive);
    await runEvent(store, code, { type: 'VOTE', playerId: a!.id, targetId: b!.id, seq: 0 });
    await runEvent(store, code, { type: 'VOTE', playerId: a!.id, targetId: c!.id, seq: 0 });
    const after = (await store.load(code))!.state;
    expect(after.votes[a!.id]?.targetId).toBe(c!.id);
    expect(Object.keys(after.votes)).toHaveLength(1);
  });

  it('a full-room vote burst loses zero votes', async () => {
    const store = await makeStore();
    const n = 80;
    const code = await freshRoom(store, n);
    await runEvent(store, code, { type: 'START', byPlayerId: 'p0' });
    await runEvent(store, code, { type: 'ADVANCE', byPlayerId: 'p0' }); // DAWN (no actions)
    await runEvent(store, code, { type: 'ADVANCE', byPlayerId: 'p0' }); // DAY_DISCUSSION
    await runEvent(store, code, { type: 'ADVANCE', byPlayerId: 'p0' }); // DAY_VOTE

    const { state } = (await store.load(code))!;
    const living = Object.values(state.players).filter((p) => p.alive);
    expect(living).toHaveLength(n);
    // Everyone votes at once; each voter picks a target deterministically.
    await Promise.all(
      living.map((voter, i) =>
        runEvent(store, code, {
          type: 'VOTE',
          playerId: voter.id,
          targetId: living[(i + 1) % living.length]!.id,
          seq: 0,
        }),
      ),
    );
    const after = (await store.load(code))!.state;
    expect(Object.keys(after.votes)).toHaveLength(n);
  }, 120_000);

  it('version increases on every write and stays put on reads', async () => {
    const store = await makeStore();
    const code = await freshRoom(store, 5);
    const v1 = (await store.load(code))!.version;
    const v1again = (await store.load(code))!.version;
    expect(v1again).toBe(v1);
    await runEvent(store, code, { type: 'START', byPlayerId: 'p0' });
    const v2 = (await store.load(code))!.version;
    expect(v2).toBeGreaterThan(v1);
    const { state } = (await store.load(code))!;
    const mafia = livingByRole(state, 'MAFIA')[0]!;
    const target = Object.values(state.players).find((p) => p.alive && p.id !== mafia.id)!;
    await runEvent(store, code, { type: 'NIGHT_ACTION', playerId: mafia.id, targetId: target.id, seq: 0 });
    const v3 = (await store.load(code))!.version;
    expect(v3).toBeGreaterThan(v2);
  });

  it('findFeaturedLobbies lists only featured lobbies', async () => {
    const store = await makeStore();
    const a = await freshRoom(store, 5);
    const b = await freshRoom(store, 6);
    await runEvent(store, b, { type: 'START', byPlayerId: 'p0' });
    const lobbies = await store.findFeaturedLobbies();
    expect(lobbies).toContain(a);
    expect(lobbies).not.toContain(b);
  });

  it('reset makes stale action docs invisible (generation bump)', async () => {
    const store = await makeStore();
    const code = await freshRoom(store, 5);
    await runEvent(store, code, { type: 'START', byPlayerId: 'p0' });
    let { state } = (await store.load(code))!;
    const mafia = livingByRole(state, 'MAFIA')[0]!;
    const target = Object.values(state.players).find((p) => p.alive && p.id !== mafia.id)!;
    await runEvent(store, code, { type: 'NIGHT_ACTION', playerId: mafia.id, targetId: target.id, seq: 0 });
    await runEvent(store, code, { type: 'RESET', byPlayerId: 'p0', seed: 'fresh' });
    await runEvent(store, code, { type: 'START', byPlayerId: 'p0' });
    state = (await store.load(code))!.state;
    expect(state.phase).toBe('NIGHT');
    // Old action doc still exists physically but must not be assembled.
    expect(Object.keys(state.actions)).toHaveLength(0);
  });
}
