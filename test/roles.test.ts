import { describe, expect, it } from 'vitest';
import { assignRoles, roleCounts } from '../src/game/roles.js';
import { killsPerNight } from '../src/game/types.js';

describe('roleCounts', () => {
  it('matches the spec formulas at the required sizes', () => {
    // mafia = max(1, round(n/6)); detectives = clamp(floor(n/15), 1, 3);
    // doctors = clamp(floor(n/15), 0, 3) with at least 1 once n >= 6 (0 at n = 5)
    expect(roleCounts(5)).toEqual({ MAFIA: 1, DOCTOR: 0, DETECTIVE: 1, VILLAGER: 3 });
    expect(roleCounts(6)).toEqual({ MAFIA: 1, DOCTOR: 1, DETECTIVE: 1, VILLAGER: 3 });
    expect(roleCounts(7)).toEqual({ MAFIA: 1, DOCTOR: 1, DETECTIVE: 1, VILLAGER: 4 });
    expect(roleCounts(12)).toEqual({ MAFIA: 2, DOCTOR: 1, DETECTIVE: 1, VILLAGER: 8 });
    expect(roleCounts(40)).toEqual({ MAFIA: 7, DOCTOR: 2, DETECTIVE: 2, VILLAGER: 29 });
    expect(roleCounts(80)).toEqual({ MAFIA: 13, DOCTOR: 3, DETECTIVE: 3, VILLAGER: 61 });
  });

  it('sums to n and never goes negative for every legal size', () => {
    for (let n = 5; n <= 80; n++) {
      const c = roleCounts(n);
      expect(c.MAFIA + c.DOCTOR + c.DETECTIVE + c.VILLAGER).toBe(n);
      expect(c.VILLAGER).toBeGreaterThanOrEqual(0);
      expect(c.MAFIA).toBeGreaterThanOrEqual(1);
      expect(c.DETECTIVE).toBeGreaterThanOrEqual(1);
      if (n >= 6) expect(c.DOCTOR).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps mafia a strict minority at start for every legal size', () => {
    for (let n = 5; n <= 80; n++) {
      const c = roleCounts(n);
      expect(c.MAFIA).toBeLessThan(n - c.MAFIA);
    }
  });
});

describe('killsPerNight', () => {
  it('is max(1, floor(aliveMafia/4))', () => {
    expect(killsPerNight(1)).toBe(1);
    expect(killsPerNight(3)).toBe(1);
    expect(killsPerNight(4)).toBe(1);
    expect(killsPerNight(7)).toBe(1);
    expect(killsPerNight(8)).toBe(2);
    expect(killsPerNight(13)).toBe(3);
  });
});

describe('assignRoles', () => {
  const ids = Array.from({ length: 12 }, (_, i) => `p${i}`);

  it('deals exactly the computed counts', () => {
    const assignment = assignRoles(ids, 'seed-a');
    const tally = { MAFIA: 0, DOCTOR: 0, DETECTIVE: 0, VILLAGER: 0 };
    for (const role of assignment.values()) tally[role]++;
    expect(tally).toEqual(roleCounts(12));
  });

  it('is deterministic for the same seed and independent of join order', () => {
    const a = assignRoles(ids, 'seed-a');
    const b = assignRoles([...ids].reverse(), 'seed-a');
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });

  it('differs across seeds (with overwhelming probability)', () => {
    const a = assignRoles(ids, 'seed-a');
    const b = assignRoles(ids, 'seed-b');
    const same = ids.every((id) => a.get(id) === b.get(id));
    expect(same).toBe(false);
  });
});
