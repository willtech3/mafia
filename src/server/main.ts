import { serve } from '@hono/node-server';
import { Firestore } from '@google-cloud/firestore';
import { FirestoreRoomStore } from '../store/firestore.js';
import { MemoryRoomStore } from '../store/memory.js';
import type { RoomStore } from '../store/types.js';
import { createApp, INSTANCE_ID } from './http.js';

/**
 * Entry point. Store selection:
 *   MAFIA_STORE=memory     in-process store (single instance dev only)
 *   default                Firestore — real GCP or the emulator when
 *                          FIRESTORE_EMULATOR_HOST is set
 */
function makeStore(): RoomStore {
  if (process.env['MAFIA_STORE'] === 'memory') {
    console.warn('Using in-memory store: single instance only, state lost on restart.');
    return new MemoryRoomStore();
  }
  const projectId =
    process.env['FIRESTORE_PROJECT_ID'] ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? undefined;
  const db = projectId ? new Firestore({ projectId }) : new Firestore();
  return new FirestoreRoomStore(db);
}

const port = Number(process.env['PORT'] ?? 8080);
const app = createApp(makeStore());

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`mafia mcp server ${INSTANCE_ID} listening on :${info.port} (endpoint /mcp)`);
});
