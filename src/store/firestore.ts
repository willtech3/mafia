import { FieldValue, Firestore, Timestamp, type DocumentSnapshot } from '@google-cloud/firestore';
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
 * Firestore (Native mode) store.
 *
 * Layout (see types.ts): rooms/{code} + players/{pid} + actions/{pid}
 * subcollections. Contention design:
 *  - Player ops (vote / night action) transactionally read ONLY the core doc
 *    and the involved player docs, then write the caller's own action doc.
 *    Concurrent player ops touch disjoint docs, so an 80-vote burst never
 *    retries against itself.
 *  - Moderator ops read everything and write the core doc; they may retry a
 *    few times if votes land mid-transaction, which is fine — they're rare.
 *
 * stateVersion = max updateTime (micros) across the docs of a read, so any
 * change to any room doc bumps it. Room docs carry expiresAt for a Firestore
 * TTL policy (cleanup, not correctness).
 */

const ROOM_TTL_MS = 48 * 60 * 60 * 1000;

export class FirestoreRoomStore implements RoomStore {
  constructor(private db: Firestore) {}

  private roomRef(code: string) {
    return this.db.collection('rooms').doc(code);
  }

  async create(state: RoomState): Promise<void> {
    const core = coreFromState(state);
    const batch = this.db.batch();
    batch.create(this.roomRef(state.code), withMeta(core));
    for (const id of Object.keys(state.players)) {
      batch.create(this.roomRef(state.code).collection('players').doc(id), withMeta(playerDocFromState(state, id)));
    }
    try {
      await batch.commit();
    } catch (err) {
      if ((err as { code?: number }).code === 6 /* ALREADY_EXISTS */) {
        throw new GameError('CONFLICT', `Room code ${state.code} is already in use. Try creating a room again.`);
      }
      throw err;
    }
  }

  async load(code: string): Promise<StoredRoom | null> {
    const ref = this.roomRef(code);
    const [coreSnap, playerSnaps, actionSnaps] = await Promise.all([
      ref.get(),
      ref.collection('players').get(),
      ref.collection('actions').get(),
    ]);
    if (!coreSnap.exists) return null;
    let version = micros(coreSnap.updateTime);
    for (const snap of [...playerSnaps.docs, ...actionSnaps.docs]) {
      version = Math.max(version, micros(snap.updateTime));
    }
    const state = assembleState(
      stripMeta(coreSnap.data()) as CoreDoc,
      playerSnaps.docs.map((d) => stripMeta(d.data()) as PlayerDoc),
      actionSnaps.docs.map((d) => actionFromSnap(d)),
    );
    return { state, version };
  }

  async mutate(
    code: string,
    scope: MutateScope,
    fn: (state: RoomState, ctx: MutateCtx) => MutateResult,
  ): Promise<RoomState> {
    const ref = this.roomRef(code);
    return this.db.runTransaction(async (t) => {
      const coreSnap = await t.get(ref);
      if (!coreSnap.exists) {
        throw new GameError('ROOM_NOT_FOUND', `Room ${code} doesn't exist. Check the code, or create a new room.`);
      }
      const core = stripMeta(coreSnap.data()) as CoreDoc;

      let playerDocs: PlayerDoc[];
      let actionDocs: ActionDoc[];
      let readPlayerSnaps = new Map<string, DocumentSnapshot>();
      if (scope.kind === 'full') {
        const [playerSnaps, actionSnaps] = await Promise.all([
          t.get(ref.collection('players')),
          t.get(ref.collection('actions')),
        ]);
        playerDocs = playerSnaps.docs.map((d) => stripMeta(d.data()) as PlayerDoc);
        actionDocs = actionSnaps.docs.map((d) => actionFromSnap(d));
        for (const d of playerSnaps.docs) readPlayerSnaps.set(d.id, d);
      } else {
        const ids = [...new Set(scope.playerIds)];
        const snaps = await Promise.all(ids.map((id) => t.get(ref.collection('players').doc(id))));
        playerDocs = snaps.filter((s) => s.exists).map((s) => stripMeta(s.data()) as PlayerDoc);
        actionDocs = []; // player ops never read others' submissions
      }

      const state = assembleState(core, playerDocs, actionDocs);
      const ctx: MutateCtx = { seq: () => nowMicros() };
      const { next, plan } = fn(state, ctx);

      switch (plan.kind) {
        case 'none':
          break;
        case 'action': {
          const doc = actionDocFromState(next, plan.playerId);
          const actionRef = ref.collection('actions').doc(plan.playerId);
          if (doc) t.set(actionRef, withMeta(doc));
          else t.delete(actionRef);
          break;
        }
        case 'player': {
          t.set(ref.collection('players').doc(plan.playerId), withMeta(playerDocFromState(next, plan.playerId)));
          break;
        }
        case 'core': {
          if (scope.kind !== 'full') throw new Error('core writes require a full scope');
          t.set(ref, withMeta(coreFromState(next)));
          // Player-doc diffs: deletions (lobby kick) and changes (reset, rename).
          for (const [id] of readPlayerSnaps) {
            if (!next.players[id]) t.delete(ref.collection('players').doc(id));
          }
          for (const id of Object.keys(next.players)) {
            const doc = playerDocFromState(next, id);
            const prev = readPlayerSnaps.get(id)?.data() as PlayerDoc | undefined;
            if (!prev || prev.name !== doc.name || prev.spectator !== doc.spectator || prev.subject !== doc.subject) {
              t.set(ref.collection('players').doc(id), withMeta(doc));
            }
          }
          break;
        }
      }
      return next;
    });
  }

  async findFeaturedLobbies(): Promise<string[]> {
    const snaps = await this.db
      .collection('rooms')
      .where('featured', '==', true)
      .where('phase', '==', 'LOBBY')
      .limit(10)
      .get();
    return snaps.docs.map((d) => d.id).sort();
  }

  async putOrphanResponse(id: string, payload: unknown): Promise<void> {
    await this.db
      .collection('elicit')
      .doc(id)
      .set({
        payload: JSON.stringify(payload),
        updatedAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + 60 * 60 * 1000),
      });
  }

  async takeOrphanResponse(id: string): Promise<unknown | null> {
    const ref = this.db.collection('elicit').doc(id);
    // Consume exactly once: read + delete in a transaction so a relayed
    // elicitation response can't be replayed by a second poll/attacker.
    return this.db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) return null;
      const raw = (snap.data() as { payload?: string }).payload;
      t.delete(ref);
      return raw ? (JSON.parse(raw) as unknown) : null;
    });
  }
}

function withMeta<T extends object>(doc: T): T & { updatedAt: FieldValue; expiresAt: Timestamp } {
  return {
    ...doc,
    updatedAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(Date.now() + ROOM_TTL_MS),
  };
}

function stripMeta(data: FirebaseFirestore.DocumentData | undefined): object {
  if (!data) return {};
  const { updatedAt: _u, expiresAt: _e, ...rest } = data;
  return rest;
}

function actionFromSnap(snap: DocumentSnapshot): ActionDoc {
  const doc = stripMeta(snap.data()) as ActionDoc;
  // seq is authoritative from the commit time, not client clocks.
  return { ...doc, seq: micros(snap.updateTime) };
}

function micros(ts: Timestamp | undefined): number {
  if (!ts) return 0;
  return ts.seconds * 1_000_000 + Math.floor(ts.nanoseconds / 1000);
}

function nowMicros(): number {
  return Date.now() * 1000;
}
