import type { Role } from './types.js';
import { rngFrom, shuffle } from './rng.js';

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export interface RoleCounts {
  MAFIA: number;
  DOCTOR: number;
  DETECTIVE: number;
  VILLAGER: number;
}

/**
 * Final rulings from the spec:
 *   mafia      = max(1, round(n/6))
 *   detectives = clamp(floor(n/15), 1, 3)
 *   doctors    = clamp(floor(n/15), 0, 3), but at least 1 once n >= 6 (0 at n = 5)
 */
export function roleCounts(n: number): RoleCounts {
  const mafia = Math.max(1, Math.round(n / 6));
  const detectives = clamp(Math.floor(n / 15), 1, 3);
  let doctors = clamp(Math.floor(n / 15), 0, 3);
  if (n >= 6 && doctors === 0) doctors = 1;
  const villagers = n - mafia - detectives - doctors;
  if (villagers < 0) {
    throw new Error(`role counts exceed player count at n=${n}`);
  }
  return { MAFIA: mafia, DOCTOR: doctors, DETECTIVE: detectives, VILLAGER: villagers };
}

/** Deterministically assign roles to player ids using the room seed. */
export function assignRoles(playerIds: readonly string[], seed: string): Map<string, Role> {
  const counts = roleCounts(playerIds.length);
  const deck: Role[] = [
    ...Array<Role>(counts.MAFIA).fill('MAFIA'),
    ...Array<Role>(counts.DOCTOR).fill('DOCTOR'),
    ...Array<Role>(counts.DETECTIVE).fill('DETECTIVE'),
    ...Array<Role>(counts.VILLAGER).fill('VILLAGER'),
  ];
  // Shuffle the ids (sorted first so assignment is independent of join order).
  const ids = shuffle([...playerIds].sort(), rngFrom('roles', seed));
  const assignment = new Map<string, Role>();
  ids.forEach((id, i) => assignment.set(id, deck[i]!));
  return assignment;
}
