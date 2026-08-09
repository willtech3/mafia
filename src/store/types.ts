import type { RoomState } from '../game/types.js';

/**
 * Room persistence behind an interface: an in-memory implementation for unit
 * tests and a Firestore implementation for real deployments. Both present the
 * same document semantics:
 *
 *   rooms/{code}            core state: phase, round, seats (role+alive),
 *                           narration, deaths, investigations, winner...
 *                           written ONLY by moderator operations.
 *   rooms/{code}/players/*  one doc per player (name, joinedSeq, spectator);
 *                           written by that player at join (reset touches all).
 *   rooms/{code}/actions/*  one doc per player holding their CURRENT
 *                           submission (vote or night action), tagged with a
 *                           phaseKey; stale docs are ignored, never deleted.
 *
 * This layout is why 80 players can vote in a burst without contention: each
 * player's transaction reads the core doc (unchanged during a phase) and
 * writes only their own action doc.
 */

/** Which documents a mutation needs to read before validating. */
export type MutateScope =
  | { kind: 'full' } // moderator ops + join: core, all players, all actions
  | { kind: 'partial'; playerIds: string[] }; // player ops: core + named player docs only

/** What the mutation wants persisted after the reducer ran. */
export type MutationPlan =
  /** Persist everything: core doc + any player-doc diffs (start/advance/kick/reset). */
  | { kind: 'core' }
  /** Persist a single player doc (join). */
  | { kind: 'player'; playerId: string }
  /** Persist a single action doc — the player's current vote or night action. */
  | { kind: 'action'; playerId: string }
  /** Nothing changed. */
  | { kind: 'none' };

export interface MutateResult {
  next: RoomState;
  plan: MutationPlan;
}

export interface StoredRoom {
  state: RoomState;
  /**
   * Monotonically increasing per room; bumps whenever any room document
   * changes. Derived from document update times (Firestore) or a logical
   * counter (memory).
   */
  version: number;
}

export interface MutateCtx {
  /** Monotonic-enough sequence source for event seq / joinedSeq. */
  seq(): number;
}

export interface RoomStore {
  /** Create a new room. Rejects with GameError CONFLICT if the code is taken. */
  create(state: RoomState): Promise<void>;

  /** Read a room. Null if it does not exist. */
  load(code: string): Promise<StoredRoom | null>;

  /**
   * Atomically read (per scope), validate + reduce (fn), and persist (plan).
   * fn receives an assembled RoomState. With a partial scope the state
   * contains only the named players — reducers for player actions must not
   * touch anyone else. GameErrors thrown by fn propagate unchanged and leave
   * the room untouched.
   */
  mutate(code: string, scope: MutateScope, fn: (state: RoomState, ctx: MutateCtx) => MutateResult): Promise<RoomState>;

  /** Room codes of featured rooms currently in LOBBY (for blind join_room). */
  findFeaturedLobbies(): Promise<string[]>;
}

/** Actions and votes are tagged so stale docs from earlier phases are inert. */
export function phaseKey(state: Pick<RoomState, 'generation' | 'round' | 'phase'>): string | null {
  if (state.phase === 'NIGHT') return `${state.generation}:${state.round}:N`;
  if (state.phase === 'DAY_VOTE') return `${state.generation}:${state.round}:V`;
  return null;
}
