import { GameError } from '../game/errors.js';
import type { RoomState } from '../game/types.js';
import {
  assembleState,
  actionDocFromState,
  coreFromState,
  playerDocFromState,
  type ActionDoc,
  type CoreDoc,
  type PlayerDoc,
} from './docs.js';
import type { MutateCtx, MutateResult, MutateScope, RoomStore, StoredRoom } from './types.js';

/**
 * In-memory store for unit tests and local play. Mirrors the Firestore
 * document layout exactly (core / player docs / action docs) so the
 * statelessness and merge semantics under test are the real ones.
 */

interface MemoryRoom {
  core: CoreDoc;
  players: Map<string, PlayerDoc>;
  actions: Map<string, ActionDoc>;
  version: number;
}

export class MemoryRoomStore implements RoomStore {
  private rooms = new Map<string, MemoryRoom>();
  /** One logical clock feeds both event seq and room versions. */
  private clock = 1;
  /** Serializes mutations per room, imitating transaction isolation. */
  private locks = new Map<string, Promise<unknown>>();

  private tick(): number {
    return ++this.clock;
  }

  async create(state: RoomState): Promise<void> {
    const code = state.code;
    if (this.rooms.has(code)) {
      throw new GameError('CONFLICT', `Room code ${code} is already in use. Try creating a room again.`);
    }
    const players = new Map<string, PlayerDoc>();
    for (const id of Object.keys(state.players)) {
      players.set(id, playerDocFromState(state, id));
    }
    this.rooms.set(code, {
      core: structuredClone(coreFromState(state)),
      players,
      actions: new Map(),
      version: this.nextVersion(),
    });
  }

  async load(code: string): Promise<StoredRoom | null> {
    const room = this.rooms.get(code);
    if (!room) return null;
    return {
      state: assembleState(
        structuredClone(room.core),
        [...room.players.values()].map((p) => structuredClone(p)),
        [...room.actions.values()].map((a) => structuredClone(a)),
      ),
      version: room.version,
    };
  }

  async mutate(
    code: string,
    scope: MutateScope,
    fn: (state: RoomState, ctx: MutateCtx) => MutateResult,
  ): Promise<RoomState> {
    const prev = this.locks.get(code) ?? Promise.resolve();
    const run = prev.then(async () => this.mutateLocked(code, scope, fn));
    this.locks.set(code, run.catch(() => undefined));
    return run;
  }

  private async mutateLocked(
    code: string,
    scope: MutateScope,
    fn: (state: RoomState, ctx: MutateCtx) => MutateResult,
  ): Promise<RoomState> {
    const room = this.rooms.get(code);
    if (!room) {
      throw new GameError('ROOM_NOT_FOUND', `Room ${code} doesn't exist. Check the code, or create a new room.`);
    }

    const playerDocs =
      scope.kind === 'full'
        ? [...room.players.values()]
        : scope.playerIds.flatMap((id) => (room.players.has(id) ? [room.players.get(id)!] : []));
    const actionDocs =
      scope.kind === 'full'
        ? [...room.actions.values()]
        : scope.playerIds.flatMap((id) => (room.actions.has(id) ? [room.actions.get(id)!] : []));

    const state = assembleState(
      structuredClone(room.core),
      playerDocs.map((p) => structuredClone(p)),
      actionDocs.map((a) => structuredClone(a)),
    );

    const ctx: MutateCtx = { seq: () => this.tick() };
    const { next, plan } = fn(state, ctx);

    switch (plan.kind) {
      case 'none':
        return next;
      case 'action': {
        const doc = actionDocFromState(next, plan.playerId);
        if (doc) room.actions.set(plan.playerId, structuredClone(doc));
        else room.actions.delete(plan.playerId);
        break;
      }
      case 'player': {
        room.players.set(plan.playerId, structuredClone(playerDocFromState(next, plan.playerId)));
        break;
      }
      case 'core': {
        if (scope.kind !== 'full') throw new Error('core writes require a full scope');
        room.core = structuredClone(coreFromState(next));
        // Player-doc diffs: deletions (lobby kick) and field changes (reset).
        for (const id of [...room.players.keys()]) {
          if (!next.players[id]) room.players.delete(id);
        }
        for (const id of Object.keys(next.players)) {
          const doc = playerDocFromState(next, id);
          const existing = room.players.get(id);
          if (!existing || existing.name !== doc.name || existing.spectator !== doc.spectator || existing.subject !== doc.subject) {
            room.players.set(id, structuredClone(doc));
          }
        }
        break;
      }
    }
    room.version = this.nextVersion();
    return next;
  }

  async findFeaturedLobbies(): Promise<string[]> {
    return [...this.rooms.values()]
      .filter((r) => r.core.featured && r.core.phase === 'LOBBY')
      .map((r) => r.core.code)
      .sort();
  }

  private orphans = new Map<string, unknown>();

  async putOrphanResponse(id: string, payload: unknown): Promise<void> {
    this.orphans.set(id, payload);
  }

  async takeOrphanResponse(id: string): Promise<unknown | null> {
    if (!this.orphans.has(id)) return null;
    const value = this.orphans.get(id)!;
    this.orphans.delete(id); // consume exactly once — no replay
    return value;
  }

  private nextVersion(): number {
    return this.tick();
  }
}
