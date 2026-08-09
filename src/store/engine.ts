import { apply, type GameEvent } from '../game/reducer.js';
import type { RoomState } from '../game/types.js';
import type { MutateScope, MutationPlan, RoomStore } from './types.js';

/**
 * Glue between tool handlers and the store: picks the narrowest read scope
 * and the smallest write plan for each event type, then runs the pure
 * reducer inside the store's transaction.
 */

function scopeFor(event: GameEvent): MutateScope {
  switch (event.type) {
    case 'NIGHT_ACTION':
      return { kind: 'partial', playerIds: [event.playerId, event.targetId] };
    case 'VOTE':
      return event.targetId === 'ABSTAIN'
        ? { kind: 'partial', playerIds: [event.playerId] }
        : { kind: 'partial', playerIds: [event.playerId, event.targetId] };
    // JOIN needs the seat count; moderator ops need everything.
    default:
      return { kind: 'full' };
  }
}

function planFor(event: GameEvent): MutationPlan {
  switch (event.type) {
    case 'JOIN':
      return { kind: 'player', playerId: event.playerId };
    case 'NIGHT_ACTION':
      return { kind: 'action', playerId: event.playerId };
    case 'VOTE':
      return { kind: 'action', playerId: event.playerId };
    default:
      return { kind: 'core' };
  }
}

/**
 * Validate + apply one event atomically. Returns the post-event state as the
 * reducer saw it (possibly partial for player ops — callers wanting a fresh
 * full view should store.load afterwards).
 */
export async function runEvent(store: RoomStore, code: string, event: GameEvent): Promise<RoomState> {
  return store.mutate(code, scopeFor(event), (state, ctx) => {
    // Store-assigned sequence numbers keep the reducer pure and make
    // last-write-wins / tie-breaks consistent across replicas.
    const stamped: GameEvent =
      event.type === 'JOIN' || event.type === 'NIGHT_ACTION' || event.type === 'VOTE'
        ? { ...event, seq: ctx.seq() }
        : event;
    return { next: apply(state, stamped), plan: planFor(event) };
  });
}
