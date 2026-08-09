import { describe } from 'vitest';
import { MemoryRoomStore } from '../src/store/memory.js';
import { storeContract } from './store.contract.js';

describe('MemoryRoomStore', () => {
  storeContract(async () => new MemoryRoomStore());
});
