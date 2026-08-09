/**
 * Core game state types. Everything here is plain JSON-serializable data.
 * The reducer in reducer.ts is the only writer; the store layer persists
 * slices of this shape into separate Firestore documents (see store/).
 */

export type Role = 'MAFIA' | 'DOCTOR' | 'DETECTIVE' | 'VILLAGER';

export type Phase =
  | 'LOBBY'
  | 'NIGHT'
  | 'DAWN'
  | 'DAY_DISCUSSION'
  | 'DAY_VOTE'
  | 'DUSK'
  | 'ENDED';

export type Faction = 'MAFIA' | 'TOWN';

export type DeathCause = 'MAFIA' | 'BANISHED' | 'KICKED';

export interface Player {
  id: string;
  name: string;
  /** Assigned at start_game; null in lobby and for spectators. */
  role: Role | null;
  alive: boolean;
  isModerator: boolean;
  /** Joined after the game started; watches but never acts. */
  spectator: boolean;
  /** Join order, for stable display sorting. */
  joinedSeq: number;
}

/** A night submission. `kind` is derived from the submitter's role, never from input. */
export interface NightAction {
  playerId: string;
  kind: 'KILL' | 'PROTECT' | 'INVESTIGATE';
  targetId: string;
  /** Monotonic per room; assigned by the store. Used for last-write-wins and kill tie-breaks. */
  seq: number;
}

export interface Vote {
  playerId: string;
  /** 'ABSTAIN' or a living player's id. */
  targetId: string;
  seq: number;
}

export interface DeathRecord {
  playerId: string;
  name: string;
  role: Role;
  round: number;
  cause: DeathCause;
}

export interface Investigation {
  detectiveId: string;
  targetId: string;
  targetName: string;
  result: 'MAFIA' | 'NOT MAFIA';
  round: number;
}

export interface NarrationEntry {
  round: number;
  /** Which beat produced it. */
  at: 'START' | 'DAWN' | 'DUSK' | 'KICK' | 'END';
  text: string;
}

export interface RoomState {
  code: string;
  phase: Phase;
  /** Night counter. 0 in lobby, 1 during/after the first night. */
  round: number;
  /** Bumped on reset_room so stale action docs from a previous game are ignored. */
  generation: number;
  players: Record<string, Player>;
  /** Current-phase night actions, keyed by playerId. Cleared on phase resolution. */
  actions: Record<string, NightAction>;
  /** Current-phase votes, keyed by playerId. Cleared on phase resolution. */
  votes: Record<string, Vote>;
  /** Private detective results; only ever shown to their own detective (or spectators/game end). */
  investigations: Investigation[];
  narration: NarrationEntry[];
  deaths: DeathRecord[];
  winner: Faction | null;
  featured: boolean;
  moderatorId: string;
  /** Seed for deterministic role shuffle + narration variation. */
  rngSeed: string;
  createdAtMs: number;
}

export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 80;

/** Number of currently living, role-holding players. */
export function alivePlayers(state: RoomState): Player[] {
  return Object.values(state.players).filter((p) => p.alive && !p.spectator && p.role !== null);
}

export function aliveByRole(state: RoomState, role: Role): Player[] {
  return alivePlayers(state).filter((p) => p.role === role);
}

/** Kills the mafia team makes per night: keeps an 80-person game moving. */
export function killsPerNight(aliveMafia: number): number {
  return Math.max(1, Math.floor(aliveMafia / 4));
}

/** Players seated in the game (assigned a role at start), dead or alive. */
export function seatedPlayers(state: RoomState): Player[] {
  return Object.values(state.players).filter((p) => p.role !== null);
}
