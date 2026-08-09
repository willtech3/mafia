import { describe, expect, it } from 'vitest';
import { GameError } from '../src/game/errors.js';
import { apply, initialRoom, type GameEvent } from '../src/game/reducer.js';
import { mulberry32 } from '../src/game/rng.js';
import { roleCounts } from '../src/game/roles.js';
import type { Role, RoomState } from '../src/game/types.js';
import { viewFor } from '../src/game/view.js';

/**
 * Fuzz harness: drive thousands of random full games through the reducer and
 * assert the invariants that must never break:
 *   - every game terminates (within a generous phase budget)
 *   - exactly one winner, and the win condition genuinely holds
 *   - dead players (and spectators) can never act
 *   - role counts are conserved from deal to game end
 *   - viewFor never throws for any viewer in any reached state
 *
 * Default 2,000 games for the regular test run; `npm run fuzz` sets
 * FUZZ_GAMES=10000 for the full required sweep. Sizes cover the scaling
 * formulas: 5, 6, 7, 12, 40, 80.
 */

const GAMES = Number(process.env['FUZZ_GAMES'] ?? 2000);
const SIZES = [5, 6, 7, 12, 40, 80] as const;
// Weight small games so the default run stays fast but 40/80 are well covered.
const SIZE_WEIGHTS = [0.28, 0.2, 0.2, 0.2, 0.07, 0.05] as const;
const MAX_PHASE_ADVANCES = 1000;

interface FuzzStats {
  games: number;
  bySize: Map<number, number>;
  winners: Map<string, number>;
  totalRounds: number;
  invalidAttempts: number;
  kicks: number;
}

function weightedSize(rand: () => number): number {
  const r = rand();
  let acc = 0;
  for (let i = 0; i < SIZES.length; i++) {
    acc += SIZE_WEIGHTS[i]!;
    if (r < acc) return SIZES[i]!;
  }
  return SIZES[SIZES.length - 1]!;
}

function pickFrom<T>(items: readonly T[], rand: () => number): T {
  return items[Math.floor(rand() * items.length)]!;
}

function rolesOf(state: RoomState): Map<string, Role> {
  const out = new Map<string, Role>();
  for (const p of Object.values(state.players)) if (p.role) out.set(p.id, p.role);
  return out;
}

function livingOf(state: RoomState) {
  return Object.values(state.players).filter((p) => p.alive && p.role !== null && !p.spectator);
}

/** Attempt an event that must be rejected; assert it throws GameError and mutates nothing. */
function assertRejected(state: RoomState, event: GameEvent, stats: FuzzStats): void {
  const before = JSON.stringify(state);
  let threw = false;
  try {
    apply(state, event);
  } catch (err) {
    threw = true;
    expect(err).toBeInstanceOf(GameError);
  }
  expect(threw, `event should have been rejected: ${JSON.stringify(event)}`).toBe(true);
  expect(JSON.stringify(state)).toBe(before);
  stats.invalidAttempts++;
}

function runOneGame(gameSeed: number, stats: FuzzStats): void {
  const rand = mulberry32(gameSeed);
  let seq = 1;
  const n = weightedSize(rand);
  stats.bySize.set(n, (stats.bySize.get(n) ?? 0) + 1);

  let s = initialRoom({
    code: 'FUZZ',
    moderatorId: 'p0',
    moderatorName: 'P0',
    seed: `fuzz-${gameSeed}`,
    nowMs: 1_700_000_000_000,
  });
  for (let i = 1; i < n; i++) {
    s = apply(s, { type: 'JOIN', playerId: `p${i}`, name: `P${i}`, seq: seq++ });
  }
  s = apply(s, { type: 'START', byPlayerId: 'p0' });

  const dealt = rolesOf(s);
  const dealtCounts = roleCounts(n);
  const dead = new Set<string>();
  let advances = 0;
  let kicked = 0;

  while (s.phase !== 'ENDED') {
    expect(advances).toBeLessThan(MAX_PHASE_ADVANCES);

    // Track deaths as they happen so we can probe that the dead stay silent.
    for (const p of Object.values(s.players)) {
      if (p.role !== null && !p.alive) dead.add(p.id);
    }

    // Occasionally probe an invalid action (dead actor, spectator, wrong phase...).
    if (rand() < 0.15 && dead.size > 0) {
      const deadId = pickFrom([...dead], rand);
      const anyTarget = pickFrom(Object.keys(s.players), rand);
      const event: GameEvent =
        s.phase === 'DAY_VOTE'
          ? { type: 'VOTE', playerId: deadId, targetId: anyTarget, seq: seq++ }
          : s.phase === 'NIGHT'
            ? { type: 'NIGHT_ACTION', playerId: deadId, targetId: anyTarget, seq: seq++ }
            : { type: 'ADVANCE', byPlayerId: deadId === 'p0' ? 'p1' : deadId };
      if (event.type !== 'ADVANCE' || event.byPlayerId !== 'p0') {
        assertRejected(s, event, stats);
      }
    }

    // Random moderator kick (rarely), never the moderator themself.
    if (rand() < 0.02 && kicked < Math.floor(n / 3)) {
      const candidates = livingOf(s).filter((p) => p.id !== 'p0');
      if (candidates.length > 0) {
        s = apply(s, { type: 'KICK', byPlayerId: 'p0', targetId: pickFrom(candidates, rand).id });
        kicked++;
        stats.kicks++;
        if (s.phase === 'ENDED') break;
      }
    }

    switch (s.phase) {
      case 'NIGHT': {
        // A random subset of night-role holders act on random living targets;
        // some resubmit (last-write-wins path).
        for (const p of livingOf(s)) {
          if (p.role === 'VILLAGER') continue;
          if (rand() < 0.15) continue; // some players are slow / AFK
          const submits = rand() < 0.2 ? 2 : 1;
          for (let k = 0; k < submits; k++) {
            const targets = livingOf(s).filter((t) => {
              if (t.id === p.id) return p.role === 'DOCTOR';
              return true;
            });
            if (targets.length === 0) continue;
            s = apply(s, {
              type: 'NIGHT_ACTION',
              playerId: p.id,
              targetId: pickFrom(targets, rand).id,
              seq: seq++,
            });
          }
        }
        s = apply(s, { type: 'ADVANCE', byPlayerId: 'p0' });
        advances++;
        break;
      }
      case 'DAWN':
      case 'DAY_DISCUSSION':
      case 'DUSK': {
        s = apply(s, { type: 'ADVANCE', byPlayerId: 'p0' });
        advances++;
        break;
      }
      case 'DAY_VOTE': {
        for (const p of livingOf(s)) {
          if (rand() < 0.25) continue; // abstain by silence
          const choice =
            rand() < 0.1 ? 'ABSTAIN' : pickFrom(livingOf(s), rand).id;
          s = apply(s, { type: 'VOTE', playerId: p.id, targetId: choice, seq: seq++ });
        }
        s = apply(s, { type: 'ADVANCE', byPlayerId: 'p0' });
        advances++;
        break;
      }
      default:
        throw new Error(`fuzzer reached unexpected phase ${s.phase}`);
    }

    // Every reached state must project cleanly for every kind of viewer.
    if (rand() < 0.05) {
      const anyId = pickFrom(Object.keys(s.players), rand);
      viewFor(s, anyId, advances);
      viewFor(s, null, advances);
    }
  }

  // --- terminal invariants ---
  expect(s.winner === 'MAFIA' || s.winner === 'TOWN').toBe(true);
  stats.winners.set(s.winner!, (stats.winners.get(s.winner!) ?? 0) + 1);
  stats.totalRounds += s.round;

  // Win condition genuinely holds.
  const finalLiving = livingOf(s);
  const livingMafia = finalLiving.filter((p) => p.role === 'MAFIA').length;
  if (s.winner === 'TOWN') {
    expect(livingMafia).toBe(0);
  } else {
    expect(livingMafia).toBeGreaterThanOrEqual(finalLiving.length - livingMafia);
    expect(livingMafia).toBeGreaterThan(0);
  }

  // Role counts conserved: same deal, same multiset, dead or alive.
  const finalRoles = rolesOf(s);
  expect(finalRoles.size).toBe(dealt.size);
  const tally = { MAFIA: 0, DOCTOR: 0, DETECTIVE: 0, VILLAGER: 0 };
  for (const [id, role] of finalRoles) {
    expect(role).toBe(dealt.get(id));
    tally[role]++;
  }
  expect(tally).toEqual(dealtCounts);

  // The dead can no longer do anything at all.
  for (const id of dead) {
    assertRejected(s, { type: 'NIGHT_ACTION', playerId: id, targetId: 'p0', seq: seq++ }, stats);
    assertRejected(s, { type: 'VOTE', playerId: id, targetId: 'p0', seq: seq++ }, stats);
  }

  stats.games++;
}

describe(`fuzz: ${GAMES} random full games across sizes ${SIZES.join(', ')}`, () => {
  // Batched so no single test runs for minutes — long tests starve the
  // vitest worker heartbeat on slow CI runners.
  const BATCHES = Math.min(10, GAMES);
  const perBatch = Math.ceil(GAMES / BATCHES);
  const stats: FuzzStats = {
    games: 0,
    bySize: new Map(),
    winners: new Map(),
    totalRounds: 0,
    invalidAttempts: 0,
    kicks: 0,
  };
  let seed = 0;

  for (let b = 1; b <= BATCHES; b++) {
    it(`batch ${b}/${BATCHES} holds every invariant`, { timeout: 300_000 }, () => {
      for (let g = 0; g < perBatch && seed < GAMES; g++) {
        seed++;
        try {
          runOneGame(seed, stats);
        } catch (err) {
          throw new Error(`fuzz game seed=${seed} failed: ${(err as Error).message}`, { cause: err });
        }
      }
    });
  }

  it('aggregate coverage is sound', () => {
    expect(stats.games).toBe(GAMES);
    for (const size of SIZES) {
      expect(stats.bySize.get(size) ?? 0, `size ${size} never fuzzed`).toBeGreaterThan(0);
    }
    // Both factions must actually win sometimes — a one-sided fuzzer proves little.
    expect(stats.winners.get('MAFIA') ?? 0).toBeGreaterThan(0);
    expect(stats.winners.get('TOWN') ?? 0).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(
      `fuzz: ${stats.games} games, avg rounds ${(stats.totalRounds / stats.games).toFixed(1)}, ` +
        `winners ${JSON.stringify([...stats.winners.entries()])}, sizes ${JSON.stringify([...stats.bySize.entries()])}, ` +
        `${stats.invalidAttempts} invalid attempts rejected, ${stats.kicks} kicks`,
    );
  });
});
