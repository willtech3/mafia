import { apply, initialRoom, type GameEvent } from '../src/game/reducer.js';
import type { Player, Role, RoomState } from '../src/game/types.js';

let seq = 1000;
export function nextSeq(): number {
  return ++seq;
}

/** Lobby with n players p0..p{n-1}; p0 is the moderator. */
export function makeLobby(n: number, seed = 'test-seed'): RoomState {
  let state = initialRoom({
    code: 'TEST',
    moderatorId: 'p0',
    moderatorName: 'P00',
    seed,
    nowMs: 1_700_000_000_000,
  });
  for (let i = 1; i < n; i++) {
    state = apply(state, {
      type: 'JOIN',
      playerId: `p${i}`,
      name: `P${String(i).padStart(2, '0')}`,
      seq: nextSeq(),
    });
  }
  return state;
}

/** Started game (phase NIGHT, round 1). */
export function makeGame(n: number, seed = 'test-seed'): RoomState {
  return apply(makeLobby(n, seed), { type: 'START', byPlayerId: 'p0' });
}

/** Deterministically search seeds until the started game satisfies a predicate. */
export function makeGameSuchThat(n: number, pred: (s: RoomState) => boolean): RoomState {
  for (let i = 0; i < 200; i++) {
    const s = makeGame(n, `search-${i}`);
    if (pred(s)) return s;
  }
  throw new Error('no seed satisfies predicate');
}

export function byRole(state: RoomState, role: Role): Player[] {
  return Object.values(state.players)
    .filter((p) => p.role === role)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function living(state: RoomState): Player[] {
  return Object.values(state.players).filter((p) => p.alive && p.role !== null);
}

export function ev(state: RoomState, event: GameEvent): RoomState {
  return apply(state, event);
}

export function nightAction(state: RoomState, playerId: string, targetId: string): RoomState {
  return apply(state, { type: 'NIGHT_ACTION', playerId, targetId, seq: nextSeq() });
}

export function vote(state: RoomState, playerId: string, targetId: string): RoomState {
  return apply(state, { type: 'VOTE', playerId, targetId, seq: nextSeq() });
}

export function advance(state: RoomState): RoomState {
  return apply(state, { type: 'ADVANCE', byPlayerId: state.moderatorId });
}

/** Advance through NIGHT so nothing happens: no night actions submitted. */
export function quietNightToVote(state: RoomState): RoomState {
  let s = state;
  if (s.phase === 'NIGHT') s = advance(s); // -> DAWN
  if (s.phase === 'DAWN') s = advance(s); // -> DAY_DISCUSSION (or ENDED)
  if (s.phase === 'DAY_DISCUSSION') s = advance(s); // -> DAY_VOTE
  return s;
}
