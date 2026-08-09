import { Firestore } from '@google-cloud/firestore';
import { describe } from 'vitest';
import { FirestoreRoomStore } from '../src/store/firestore.js';
import { storeContract } from './store.contract.js';

/**
 * Runs the same contract against the real Firestore client pointed at the
 * emulator. Start it with `npm run emulator` (Docker), then:
 *   FIRESTORE_EMULATOR_HOST=localhost:8899 npx vitest run test/store.firestore.test.ts
 */

const emulator = process.env['FIRESTORE_EMULATOR_HOST'];

describe.skipIf(!emulator)('FirestoreRoomStore (emulator)', () => {
  storeContract(async () => {
    const db = new Firestore({ projectId: 'mafia-emulator-test' });
    return new FirestoreRoomStore(db);
  });
});
