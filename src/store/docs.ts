import type { NightAction, Role, RoomState, Vote } from '../game/types.js';
import { phaseKey } from './types.js';

/**
 * Document shapes shared by the memory and Firestore stores, plus pure
 * assembly/disassembly between them and the reducer's RoomState.
 */

export interface CoreDoc {
  code: string;
  phase: RoomState['phase'];
  round: number;
  generation: number;
  /** role + alive per seated player; written only by moderator operations. */
  seats: Record<string, { role: Role; alive: boolean }>;
  investigations: RoomState['investigations'];
  narration: RoomState['narration'];
  deaths: RoomState['deaths'];
  winner: RoomState['winner'];
  featured: boolean;
  moderatorId: string;
  rngSeed: string;
  createdAtMs: number;
}

export interface PlayerDoc {
  id: string;
  name: string;
  joinedSeq: number;
  spectator: boolean;
}

export interface ActionDoc {
  playerId: string;
  /** generation:round:N|V — stale docs simply never match and are ignored. */
  phaseKey: string;
  kind: 'KILL' | 'PROTECT' | 'INVESTIGATE' | 'VOTE';
  targetId: string;
  /** Store-assigned monotonic sequence (micros); LWW + kill tie-breaks. */
  seq: number;
}

export function coreFromState(state: RoomState): CoreDoc {
  const seats: CoreDoc['seats'] = {};
  for (const p of Object.values(state.players)) {
    if (p.role !== null) seats[p.id] = { role: p.role, alive: p.alive };
  }
  return {
    code: state.code,
    phase: state.phase,
    round: state.round,
    generation: state.generation,
    seats,
    investigations: state.investigations,
    narration: state.narration,
    deaths: state.deaths,
    winner: state.winner,
    featured: state.featured,
    moderatorId: state.moderatorId,
    rngSeed: state.rngSeed,
    createdAtMs: state.createdAtMs,
  };
}

export function playerDocFromState(state: RoomState, playerId: string): PlayerDoc {
  const p = state.players[playerId];
  if (!p) throw new Error(`player ${playerId} not in state`);
  return { id: p.id, name: p.name, joinedSeq: p.joinedSeq, spectator: p.spectator };
}

/** The player's current submission as a persistable action doc, if any. */
export function actionDocFromState(state: RoomState, playerId: string): ActionDoc | null {
  const key = phaseKey(state);
  if (!key) return null;
  const night = state.actions[playerId];
  if (night) return { playerId, phaseKey: key, kind: night.kind, targetId: night.targetId, seq: night.seq };
  const vote = state.votes[playerId];
  if (vote) return { playerId, phaseKey: key, kind: 'VOTE', targetId: vote.targetId, seq: vote.seq };
  return null;
}

/**
 * Rebuild a RoomState from documents. `playerDocs` may be a subset (partial
 * mutation scopes); action docs whose phaseKey does not match the core's
 * current phase are ignored.
 */
export function assembleState(core: CoreDoc, playerDocs: PlayerDoc[], actionDocs: ActionDoc[]): RoomState {
  const players: RoomState['players'] = {};
  for (const doc of playerDocs) {
    const seat = core.seats[doc.id];
    players[doc.id] = {
      id: doc.id,
      name: doc.name,
      joinedSeq: doc.joinedSeq,
      spectator: doc.spectator,
      isModerator: doc.id === core.moderatorId,
      role: seat?.role ?? null,
      alive: seat?.alive ?? true,
    };
  }

  const state: RoomState = {
    code: core.code,
    phase: core.phase,
    round: core.round,
    generation: core.generation,
    players,
    actions: {},
    votes: {},
    investigations: core.investigations,
    narration: core.narration,
    deaths: core.deaths,
    winner: core.winner,
    featured: core.featured,
    moderatorId: core.moderatorId,
    rngSeed: core.rngSeed,
    createdAtMs: core.createdAtMs,
  };

  const key = phaseKey(state);
  if (key) {
    for (const doc of actionDocs) {
      if (doc.phaseKey !== key) continue;
      if (doc.kind === 'VOTE') {
        const vote: Vote = { playerId: doc.playerId, targetId: doc.targetId, seq: doc.seq };
        state.votes[doc.playerId] = vote;
      } else {
        const action: NightAction = {
          playerId: doc.playerId,
          kind: doc.kind,
          targetId: doc.targetId,
          seq: doc.seq,
        };
        state.actions[doc.playerId] = action;
      }
    }
  }
  return state;
}
