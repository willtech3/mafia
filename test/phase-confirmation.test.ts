import { describe, expect, it } from 'vitest';
import { apply, phaseConfirmation } from '../src/game/reducer.js';
import { advance, makeGame, quietNightToVote, vote } from './helpers.js';

function expectGameError(fn: () => unknown, code: string): void {
  expect(fn).toThrowError(expect.objectContaining({ code }));
}

describe('atomic phase confirmations', () => {
  it('rejects a changed banishment after the moderator confirmed an empty vote', () => {
    const state = quietNightToVote(makeGame(7));
    const expected = phaseConfirmation(state);
    const changed = vote(state, 'p1', 'p2');
    expectGameError(() => apply(changed, { type: 'ADVANCE', byPlayerId: 'p0', expected }), 'CONFLICT');
    expect(changed.phase).toBe('DAY_VOTE');
    expect(changed.players.p2?.alive).toBe(true);
  });

  it('allows more votes for the same confirmed outcome', () => {
    const state = vote(quietNightToVote(makeGame(7)), 'p1', 'p2');
    const changed = vote(state, 'p3', 'p2');
    const result = apply(changed, { type: 'ADVANCE', byPlayerId: 'p0', expected: phaseConfirmation(state) });
    expect(result.players.p2?.alive).toBe(false);
  });

  it('rejects a repeated advance and a confirmation from a previous game', () => {
    const state = makeGame(7);
    const expected = phaseConfirmation(state);
    expectGameError(() => apply(advance(state), { type: 'ADVANCE', byPlayerId: 'p0', expected }), 'CONFLICT');
    const reset = apply(state, { type: 'RESET', byPlayerId: 'p0', seed: 'next-game' });
    const restarted = apply(reset, { type: 'START', byPlayerId: 'p0' });
    expectGameError(() => apply(restarted, { type: 'ADVANCE', byPlayerId: 'p0', expected }), 'CONFLICT');
  });
});
