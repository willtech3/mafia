import { describe, expect, it } from 'vitest';
import { apply } from '../src/game/reducer.js';
import type { Role, RoomState } from '../src/game/types.js';
import { viewFor, type Projection } from '../src/game/view.js';
import { advance, byRole, living, makeGame, makeLobby, nextSeq, nightAction, quietNightToVote, vote } from './helpers.js';

/**
 * Redaction is the game's security model: anything in a projection is visible
 * to that player AND their model. These tests hunt for forbidden strings and
 * forbidden structure in the wrong viewer's projection.
 */

function json(p: Projection): string {
  return JSON.stringify(p);
}

/** Collect every (id, role) pair that appears anywhere in the projection. */
function visibleRoleAssignments(p: Projection): Map<string, Role> {
  const out = new Map<string, Role>();
  for (const tile of p.players) if (tile.role) out.set(tile.id, tile.role);
  if (p.you?.role && p.you.id) out.set(p.you.id, p.you.role);
  for (const r of p.reveal?.players ?? []) out.set(r.id, r.role);
  // Mafia teammates are implicit MAFIA assignments.
  for (const t of p.mafia?.teammates ?? []) out.set(t.id, 'MAFIA');
  return out;
}

describe('living-player redaction during NIGHT', () => {
  // 12 players -> 2 mafia, so teammate visibility is exercised.
  function nightScene() {
    let s = makeGame(12, 'redaction-seed');
    const [m1, m2] = byRole(s, 'MAFIA');
    const doctor = byRole(s, 'DOCTOR')[0]!;
    const detective = byRole(s, 'DETECTIVE')[0]!;
    const villagers = byRole(s, 'VILLAGER');
    s = nightAction(s, m1!.id, villagers[0]!.id);
    s = nightAction(s, m2!.id, villagers[1]!.id);
    s = nightAction(s, doctor.id, villagers[0]!.id);
    s = nightAction(s, detective.id, m1!.id);
    return { s, m1: m1!, m2: m2!, doctor, detective, villagers };
  }

  it('a villager sees no roles, no targets, no tallies', () => {
    const { s, m1, m2, doctor, villagers } = nightScene();
    const viewer = villagers[2]!;
    const p = viewFor(s, viewer.id, 1);
    const roles = visibleRoleAssignments(p);
    expect([...roles.keys()]).toEqual([viewer.id]);
    expect(p.mafia).toBeUndefined();
    expect(p.detective).toBeUndefined();
    expect(p.doctor).toBeUndefined();
    expect(p.reveal).toBeUndefined();
    const text = json(p);
    // No hint of who the mafia are or whom anyone targeted.
    expect(text).not.toContain('teammates');
    expect(text).not.toContain('nightTarget');
    expect(text).not.toContain('protecting');
    expect(text).not.toContain('killsTonight');
    // The doctor's and mafia's secret choices never appear as target references.
    expect(text).not.toContain(`"targetId":"${villagers[0]!.id}"`);
    expect(text).not.toContain(`"targetId":"${villagers[1]!.id}"`);
    // Sanity: roles of m1/m2/doctor aren't attached to their entries anywhere.
    for (const secret of [m1.id, m2.id, doctor.id]) {
      expect(roles.has(secret)).toBe(false);
    }
  });

  it('a mafia member sees teammates and the team tally, but not doctor/detective picks', () => {
    const { s, m1, m2, doctor, detective, villagers } = nightScene();
    const p = viewFor(s, m1.id, 1);
    expect(p.you?.role).toBe('MAFIA');
    expect(p.mafia?.teammates).toEqual([{ id: m2.id, name: m2.name, alive: true }]);
    expect(p.mafia?.tally.map((t) => t.targetId).sort()).toEqual(
      [villagers[0]!.id, villagers[1]!.id].sort(),
    );
    const text = json(p);
    expect(text).not.toContain('protecting');
    expect(text).not.toContain('INVESTIGATE');
    // Doctor and detective identities are hidden from mafia.
    const roles = visibleRoleAssignments(p);
    expect(roles.has(doctor.id)).toBe(false);
    expect(roles.has(detective.id)).toBe(false);
  });

  it('the doctor sees only their own protect target', () => {
    const { s, doctor, villagers, m1 } = nightScene();
    const p = viewFor(s, doctor.id, 1);
    expect(p.doctor?.protecting?.id).toBe(villagers[0]!.id);
    expect(p.mafia).toBeUndefined();
    const roles = visibleRoleAssignments(p);
    expect([...roles.keys()]).toEqual([doctor.id]);
    // The mafia tally must not leak to the doctor even though their target overlaps.
    expect(json(p)).not.toContain('tally');
    expect(roles.has(m1.id)).toBe(false);
  });

  it('the detective sees pending investigation only as their own night target', () => {
    const { s, detective, m1 } = nightScene();
    const p = viewFor(s, detective.id, 1);
    expect(p.you?.nightTarget?.id).toBe(m1.id);
    expect(p.detective?.results).toEqual([]); // no result until dawn
    const roles = visibleRoleAssignments(p);
    expect([...roles.keys()]).toEqual([detective.id]);
  });
});

describe('detective results after dawn', () => {
  function dawnScene() {
    let s = makeGame(12, 'redaction-seed');
    const detective = byRole(s, 'DETECTIVE')[0]!;
    const m1 = byRole(s, 'MAFIA')[0]!;
    s = nightAction(s, detective.id, m1.id);
    s = advance(s); // DAWN
    return { s, detective, m1 };
  }

  it('the detective sees their result', () => {
    const { s, detective, m1 } = dawnScene();
    const p = viewFor(s, detective.id, 1);
    expect(p.detective?.results).toEqual([
      { targetId: m1.id, targetName: m1.name, result: 'MAFIA', round: 1 },
    ]);
  });

  it('nobody else sees the result — not even the investigated mafia', () => {
    const { s, detective, m1 } = dawnScene();
    for (const p of Object.values(s.players)) {
      if (p.id === detective.id || !p.alive) continue;
      const proj = viewFor(s, p.id, 1);
      const text = json(proj);
      expect(proj.detective, `viewer ${p.id}`).toBeUndefined();
      expect(text, `viewer ${p.id}`).not.toContain('NOT MAFIA');
      expect(text, `viewer ${p.id}`).not.toContain('"result"');
    }
    // And the mafia target doesn't learn they were investigated.
    const mafiaView = json(viewFor(s, m1.id, 1));
    expect(mafiaView).not.toContain('"INVESTIGATE"');
  });
});

describe('death, spectators, and game end', () => {
  it('a dead player becomes omniscient (deliberate spectator perk)', () => {
    let s = makeGame(12, 'redaction-seed');
    const m1 = byRole(s, 'MAFIA')[0]!;
    const victim = byRole(s, 'VILLAGER').find((p) => !p.isModerator)!;
    s = nightAction(s, m1.id, victim.id);
    s = advance(s); // victim dies at dawn
    const p = viewFor(s, victim.id, 1);
    expect(p.reveal).toBeDefined();
    expect(p.reveal!.players.find((r) => r.id === m1.id)?.role).toBe('MAFIA');
    expect(p.next_step_hint).toContain('out of the game');
  });

  it('dead players are publicly revealed on the board (house rule)', () => {
    let s = makeGame(12, 'redaction-seed');
    const m1 = byRole(s, 'MAFIA')[0]!;
    const victim = byRole(s, 'VILLAGER')[0]!;
    s = nightAction(s, m1.id, victim.id);
    s = advance(s);
    const anyLiving = living(s).find((p) => p.id !== victim.id)!;
    const p = viewFor(s, anyLiving.id, 1);
    const tile = p.players.find((t) => t.id === victim.id)!;
    expect(tile.role).toBe('VILLAGER');
    expect(tile.alive).toBe(false);
  });

  it('a late-join spectator gets the public view only while the game runs', () => {
    let s = makeGame(12, 'redaction-seed');
    s = apply(s, { type: 'JOIN', playerId: 'late', name: 'Latey', seq: nextSeq() });
    const p = viewFor(s, 'late', 1);
    expect(p.reveal).toBeUndefined();
    expect(p.mafia).toBeUndefined();
    const roles = visibleRoleAssignments(p);
    expect(roles.size).toBe(0);
    expect(p.you?.spectator).toBe(true);
  });

  it('a lobby-overflow spectator is told the room is full, not that reset will seat them', () => {
    let s = makeLobby(80);
    s = apply(s, { type: 'JOIN', playerId: 'p81', name: 'Overflow', seq: nextSeq() });
    const p = viewFor(s, 'p81', 1);
    expect(p.you?.spectator).toBe(true);
    expect(p.players.some((t) => t.id === 'p81')).toBe(false);
    expect(p.next_step_hint.toLowerCase()).toContain('full');
    expect(p.next_step_hint.toLowerCase()).not.toContain('you will be dealt in when the room resets');
  });

  it('at ENDED everyone sees the full reveal', () => {
    let s = quietNightToVote(makeGame(5, 'redaction-seed'));
    const mafia = byRole(s, 'MAFIA')[0]!;
    for (const p of living(s).filter((p) => p.id !== mafia.id)) s = vote(s, p.id, mafia.id);
    s = advance(s);
    s = advance(s);
    expect(s.phase).toBe('ENDED');
    for (const player of Object.values(s.players)) {
      const proj = viewFor(s, player.id, 1);
      expect(proj.reveal?.players).toHaveLength(5);
      expect(proj.winner).toBe('TOWN');
    }
  });
});

describe('vote privacy', () => {
  it('tallies are public counts; who-voted-for-whom is not exposed to the living', () => {
    let s = quietNightToVote(makeGame(7, 'redaction-seed'));
    const [a, b] = living(s);
    s = vote(s, a!.id, b!.id);
    const other = living(s).find((p) => p.id !== a!.id && p.id !== b!.id)!;
    const p = viewFor(s, other.id, 1);
    expect(p.vote?.tally).toEqual([{ targetId: b!.id, targetName: b!.name, count: 1 }]);
    const text = json(p);
    expect(text).not.toContain('voterName');
    // The voter's own view shows their vote back to them.
    const voterView = viewFor(s, a!.id, 1);
    expect(voterView.you?.vote?.targetId).toBe(b!.id);
  });
});

describe('projection stays lean at 80 players', () => {
  it('carries tiles and tallies, not history', () => {
    let s = makeGame(80, 'big-seed');
    const mafias = byRole(s, 'MAFIA');
    for (const m of mafias) s = nightAction(s, m.id, byRole(s, 'VILLAGER')[0]!.id);
    const p = viewFor(s, mafias[0]!.id, 1);
    expect(p.players).toHaveLength(80);
    expect(p.narration.length).toBeLessThanOrEqual(8);
    const bytes = JSON.stringify(p).length;
    expect(bytes).toBeLessThan(12_000);
  });
});

describe('snapshot: one projection per role at night (fixed seed)', () => {
  it('matches the reviewed shape', () => {
    let s = makeGame(7, 'snapshot-seed');
    const mafia = byRole(s, 'MAFIA')[0]!;
    const villager = byRole(s, 'VILLAGER')[0]!;
    s = nightAction(s, mafia.id, villager.id);
    const stable = (state: RoomState, id: string) => viewFor(state, id, 42);
    expect(stable(s, mafia.id)).toMatchSnapshot('mafia-night');
    expect(stable(s, villager.id)).toMatchSnapshot('villager-night');
    expect(stable(s, byRole(s, 'DOCTOR')[0]!.id)).toMatchSnapshot('doctor-night');
    expect(stable(s, byRole(s, 'DETECTIVE')[0]!.id)).toMatchSnapshot('detective-night');
  });
});
