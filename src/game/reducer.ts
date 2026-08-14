import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  alivePlayers,
  killsPerNight,
  type DeathRecord,
  type Faction,
  type NightAction,
  type Player,
  type RoomState,
} from './types.js';
import { assignRoles } from './roles.js';
import { fail } from './errors.js';
import {
  narrateDawn,
  narrateDusk,
  narrateKick,
  narrateStart,
  narrateWin,
} from './narration.js';

/**
 * Pure reducer: apply(state, event) -> new state. Throws GameError with a
 * player-friendly message on any invalid action. No Date.now, no Math.random —
 * time, sequence numbers, and seeds always arrive inside the event.
 */

export type GameEvent =
  | { type: 'JOIN'; playerId: string; name: string; seq: number; subject?: string }
  | { type: 'START'; byPlayerId: string }
  | { type: 'NIGHT_ACTION'; playerId: string; targetId: string; seq: number }
  | { type: 'VOTE'; playerId: string; targetId: string; seq: number }
  | { type: 'ADVANCE'; byPlayerId: string }
  | { type: 'KICK'; byPlayerId: string; targetId: string }
  | { type: 'RESET'; byPlayerId: string; seed: string };

const MAX_NARRATION_ENTRIES = 60;

export function initialRoom(args: {
  code: string;
  moderatorId: string;
  moderatorName: string;
  seed: string;
  nowMs: number;
  featured?: boolean;
  subject?: string;
}): RoomState {
  const moderator: Player = {
    id: args.moderatorId,
    name: args.moderatorName,
    role: null,
    alive: true,
    isModerator: true,
    spectator: false,
    joinedSeq: 0,
    ...(args.subject ? { subject: args.subject } : {}),
  };
  return {
    code: args.code,
    phase: 'LOBBY',
    round: 0,
    generation: 0,
    players: { [moderator.id]: moderator },
    actions: {},
    votes: {},
    investigations: [],
    narration: [],
    deaths: [],
    winner: null,
    featured: args.featured ?? true,
    moderatorId: args.moderatorId,
    rngSeed: args.seed,
    createdAtMs: args.nowMs,
  };
}

export function apply(state: RoomState, event: GameEvent): RoomState {
  switch (event.type) {
    case 'JOIN':
      return applyJoin(state, event);
    case 'START':
      return applyStart(state, event);
    case 'NIGHT_ACTION':
      return applyNightAction(state, event);
    case 'VOTE':
      return applyVote(state, event);
    case 'ADVANCE':
      return applyAdvance(state, event);
    case 'KICK':
      return applyKick(state, event);
    case 'RESET':
      return applyReset(state, event);
  }
}

// ---------------------------------------------------------------------------
// helpers

function requireModerator(state: RoomState, playerId: string, doing: string): void {
  if (state.moderatorId !== playerId) {
    fail('NOT_MODERATOR', `Only the moderator can ${doing}. Ask the person who created the room.`);
  }
}

function requirePlayer(state: RoomState, playerId: string): Player {
  const p = state.players[playerId];
  if (!p) {
    fail(
      'NOT_IN_ROOM',
      `You haven't joined room ${state.code} yet. Say "join the mafia game" or use join_room first.`,
    );
  }
  return p;
}

function requireLivingActor(state: RoomState, playerId: string): Player {
  const p = requirePlayer(state, playerId);
  if (p.spectator) {
    fail(
      'SPECTATOR',
      'You joined after the game started, so you are watching this round. You can act in the next game after the moderator resets the room.',
    );
  }
  if (!p.alive) {
    fail(
      'DEAD_PLAYER',
      'You are out of the game — the dead cannot act. Enjoy the show: you can now see everything, including everyone’s secret roles.',
    );
  }
  return p;
}

export function sanitizeName(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 30);
}

/** MAFIA wins at parity; TOWN wins when no mafia remain. Null while undecided. */
export function checkWinner(state: RoomState): Faction | null {
  const living = alivePlayers(state);
  if (living.length === 0) return null; // pathological (everyone kicked); no winner
  const mafia = living.filter((p) => p.role === 'MAFIA').length;
  if (mafia === 0) return 'TOWN';
  if (mafia >= living.length - mafia) return 'MAFIA';
  return null;
}

function pushNarration(state: RoomState, at: RoomState['narration'][number]['at'], text: string): void {
  state.narration.push({ round: state.round, at, text });
  if (state.narration.length > MAX_NARRATION_ENTRIES) {
    state.narration.splice(0, state.narration.length - MAX_NARRATION_ENTRIES);
  }
}

function clone(state: RoomState): RoomState {
  return structuredClone(state);
}

function endGame(state: RoomState, winner: Faction): void {
  state.winner = winner;
  state.phase = 'ENDED';
  state.actions = {};
  state.votes = {};
  pushNarration(state, 'END', narrateWin(state.rngSeed, winner));
}

// ---------------------------------------------------------------------------
// events

function applyJoin(
  state: RoomState,
  event: { playerId: string; name: string; seq: number; subject?: string },
): RoomState {
  const name = sanitizeName(event.name);
  if (name.length === 0) {
    fail('BAD_TARGET', 'That name is empty. Tell me a display name to use, e.g. "join as Sam".');
  }
  const next = clone(state);
  const existing = next.players[event.playerId];
  if (existing) {
    existing.name = uniqueDisplayName(next, name, existing.id); // idempotent re-join / rename
    if (event.subject) existing.subject = event.subject;
    return next;
  }
  const inLobby = next.phase === 'LOBBY';
  const seatedCount = Object.values(next.players).filter((p) => !p.spectator).length;
  const roomFull = seatedCount >= MAX_PLAYERS;
  const spectator = !inLobby || roomFull;
  next.players[event.playerId] = {
    id: event.playerId,
    name: uniqueDisplayName(next, name, event.playerId),
    role: null,
    alive: true,
    isModerator: false,
    spectator,
    joinedSeq: event.seq,
    ...(event.subject ? { subject: event.subject } : {}),
  };
  return next;
}

/**
 * Make a display name unique within the room by suffixing "(2)", "(3)"...
 * Runs inside the reducer (full state, inside the store transaction), so two
 * novices both named "Sam" get "Sam" and "Sam (2)" rather than a collision.
 * `exceptId` lets an existing seat keep its own name on rename.
 */
export function uniqueDisplayName(state: RoomState, desired: string, exceptId: string): string {
  const taken = new Set(
    Object.values(state.players)
      .filter((p) => p.id !== exceptId)
      .map((p) => p.name.toLowerCase()),
  );
  if (!taken.has(desired.toLowerCase())) return desired;
  for (let n = 2; n < 200; n++) {
    // Trim the BASE so the counter always survives the 30-char name cap —
    // slicing the whole candidate would chop the digit off long names and
    // make every n collapse to the same string (defeating the loop).
    const suffix = ` (${n})`;
    const candidate = `${desired.slice(0, 30 - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return desired; // pathological; accept a dup rather than loop forever
}

function applyStart(state: RoomState, event: { byPlayerId: string }): RoomState {
  requireModerator(state, event.byPlayerId, 'start the game');
  if (state.phase !== 'LOBBY') {
    fail(
      'ALREADY_STARTED',
      'The game is already running. Use advance_phase to move it forward, or reset_room to start over.',
    );
  }
  const ids = Object.values(state.players)
    .filter((p) => !p.spectator)
    .map((p) => p.id);
  if (ids.length < MIN_PLAYERS) {
    fail(
      'NOT_ENOUGH_PLAYERS',
      `You need at least ${MIN_PLAYERS} players to start — the lobby has ${ids.length}. Ask more people to join, then try again.`,
    );
  }
  if (ids.length > MAX_PLAYERS) {
    fail('TOO_MANY_PLAYERS', `Rooms hold at most ${MAX_PLAYERS} players.`);
  }
  const next = clone(state);
  const assignment = assignRoles(ids, `${next.rngSeed}:${next.generation}`);
  for (const [id, role] of assignment) {
    const p = next.players[id]!;
    p.role = role;
    p.alive = true;
  }
  next.round = 1;
  next.phase = 'NIGHT';
  pushNarration(next, 'START', narrateStart(next.rngSeed, next.code));
  return next;
}

function applyNightAction(
  state: RoomState,
  event: { playerId: string; targetId: string; seq: number },
): RoomState {
  if (state.phase !== 'NIGHT') {
    const hint =
      state.phase === 'DAY_VOTE'
        ? 'It is daytime — use cast_vote to vote instead.'
        : 'Night actions are only possible at night. Tap Refresh (or call get_state) to see the current phase.';
    fail('WRONG_PHASE', `You can't do that right now. ${hint}`);
  }
  const actor = requireLivingActor(state, event.playerId);
  const kind =
    actor.role === 'MAFIA'
      ? 'KILL'
      : actor.role === 'DOCTOR'
        ? 'PROTECT'
        : actor.role === 'DETECTIVE'
          ? 'INVESTIGATE'
          : null;
  if (kind === null) {
    fail(
      'WRONG_ROLE',
      'Villagers sleep through the night — you have no night action. Wait for the moderator to bring the dawn, then discuss and vote.',
    );
  }
  const target = state.players[event.targetId];
  if (!target || target.spectator || target.role === null) {
    fail('BAD_TARGET', 'That person is not in the game. Pick one of the players shown in the app.');
  }
  if (!target.alive) {
    fail('BAD_TARGET', `${target.name} is already dead. Pick a living player.`);
  }
  if (event.targetId === actor.id && actor.role === 'MAFIA') {
    fail('BAD_TARGET', 'You can’t target yourself. Choose someone else in the village.');
  }
  if (event.targetId === actor.id && actor.role === 'DETECTIVE') {
    fail('BAD_TARGET', 'You already know your own role — investigate someone else.');
  }
  const next = clone(state);
  // Last-write-wins until the moderator closes the phase.
  next.actions[actor.id] = { playerId: actor.id, kind, targetId: event.targetId, seq: event.seq };
  return next;
}

function applyVote(state: RoomState, event: { playerId: string; targetId: string; seq: number }): RoomState {
  if (state.phase !== 'DAY_VOTE') {
    const hint =
      state.phase === 'DAY_DISCUSSION'
        ? 'Discussion is still open — the moderator will open voting shortly.'
        : state.phase === 'NIGHT'
          ? 'You can’t vote at night. If you have a night role, use the app (or submit_night_action) to choose a target.'
          : 'Tap Refresh (or call get_state) to see the current phase.';
    fail('WRONG_PHASE', `Voting isn’t open right now. ${hint}`);
  }
  const voter = requireLivingActor(state, event.playerId);
  if (event.targetId !== 'ABSTAIN') {
    const target = state.players[event.targetId];
    if (!target || target.spectator || target.role === null) {
      fail('BAD_TARGET', 'That person is not in the game. Pick one of the players shown in the app.');
    }
    if (!target.alive) {
      fail('BAD_TARGET', `${target.name} is already dead — you can only vote for the living.`);
    }
  }
  const next = clone(state);
  next.votes[voter.id] = { playerId: voter.id, targetId: event.targetId, seq: event.seq };
  return next;
}

function applyAdvance(state: RoomState, event: { byPlayerId: string }): RoomState {
  requireModerator(state, event.byPlayerId, 'advance the phase');
  switch (state.phase) {
    case 'LOBBY':
      fail('WRONG_PHASE', 'The game hasn’t started yet. Use start_game once everyone has joined.');
      break;
    case 'NIGHT':
      return resolveNight(state);
    case 'DAWN': {
      const next = clone(state);
      const winner = checkWinner(next);
      if (winner) {
        endGame(next, winner);
      } else {
        next.phase = 'DAY_DISCUSSION';
      }
      return next;
    }
    case 'DAY_DISCUSSION': {
      const next = clone(state);
      next.phase = 'DAY_VOTE';
      next.votes = {};
      return next;
    }
    case 'DAY_VOTE':
      return resolveVotes(state);
    case 'DUSK': {
      const next = clone(state);
      const winner = checkWinner(next);
      if (winner) {
        endGame(next, winner);
      } else {
        next.phase = 'NIGHT';
        next.round += 1;
        next.actions = {};
      }
      return next;
    }
    case 'ENDED':
      fail('GAME_OVER', 'The game is over. Use reset_room to bring everyone back to the lobby for another round.');
  }
}

/** NIGHT -> DAWN: apply kills (minus saves), record investigations, narrate. */
function resolveNight(state: RoomState): RoomState {
  const next = clone(state);

  // Only actions from currently-living, correctly-roled players count.
  const valid = Object.values(next.actions).filter((a) => {
    const actor = next.players[a.playerId];
    if (!actor || !actor.alive || actor.spectator) return false;
    const expected =
      actor.role === 'MAFIA' ? 'KILL' : actor.role === 'DOCTOR' ? 'PROTECT' : actor.role === 'DETECTIVE' ? 'INVESTIGATE' : null;
    return a.kind === expected;
  });

  const kills = valid.filter((a) => a.kind === 'KILL');
  const protects = valid.filter((a) => a.kind === 'PROTECT');
  const investigations = valid.filter((a) => a.kind === 'INVESTIGATE');

  const aliveMafia = alivePlayers(next).filter((p) => p.role === 'MAFIA').length;
  const k = killsPerNight(aliveMafia);
  const victims = pickVictims(kills, k).filter((id) => next.players[id]?.alive);

  const protectedIds = new Set(protects.map((a) => a.targetId));

  const killed: DeathRecord[] = [];
  let savedCount = 0;
  for (const victimId of victims) {
    if (protectedIds.has(victimId)) {
      savedCount += 1;
      continue;
    }
    const victim = next.players[victimId]!;
    victim.alive = false;
    const record: DeathRecord = {
      playerId: victim.id,
      name: victim.name,
      role: victim.role!,
      round: next.round,
      cause: 'MAFIA',
    };
    killed.push(record);
    next.deaths.push(record);
  }

  for (const inv of investigations) {
    const target = next.players[inv.targetId];
    if (!target || target.role === null) continue;
    next.investigations.push({
      detectiveId: inv.playerId,
      targetId: inv.targetId,
      targetName: target.name,
      result: target.role === 'MAFIA' ? 'MAFIA' : 'NOT MAFIA',
      round: next.round,
    });
  }

  pushNarration(next, 'DAWN', narrateDawn(next.rngSeed, next.round, killed, savedCount));
  next.actions = {};
  next.phase = 'DAWN';
  return next;
}

/**
 * The mafia team's victims: top-K targets by plurality among mafia submissions.
 * Ties broken by most recent submission (higher seq ranks first).
 */
export function pickVictims(kills: readonly NightAction[], k: number): string[] {
  const byTarget = new Map<string, { count: number; lastSeq: number }>();
  for (const a of kills) {
    const t = byTarget.get(a.targetId) ?? { count: 0, lastSeq: -1 };
    t.count += 1;
    t.lastSeq = Math.max(t.lastSeq, a.seq);
    byTarget.set(a.targetId, t);
  }
  return [...byTarget.entries()]
    .sort((a, b) => b[1].count - a[1].count || b[1].lastSeq - a[1].lastSeq)
    .slice(0, k)
    .map(([id]) => id);
}

/** DAY_VOTE -> DUSK: plurality is banished; tie or no votes = no elimination. */
function resolveVotes(state: RoomState): RoomState {
  const next = clone(state);

  const valid = Object.values(next.votes).filter((v) => {
    const voter = next.players[v.playerId];
    return voter && voter.alive && !voter.spectator && voter.role !== null;
  });

  const tally = new Map<string, number>();
  for (const v of valid) {
    if (v.targetId === 'ABSTAIN') continue;
    if (!next.players[v.targetId]?.alive) continue;
    tally.set(v.targetId, (tally.get(v.targetId) ?? 0) + 1);
  }

  let banished: DeathRecord | null = null;
  let tie = false;
  if (tally.size > 0) {
    const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    const [topId, topCount] = sorted[0]!;
    tie = sorted.length > 1 && sorted[1]![1] === topCount;
    if (!tie) {
      const victim = next.players[topId]!;
      victim.alive = false;
      banished = {
        playerId: victim.id,
        name: victim.name,
        role: victim.role!,
        round: next.round,
        cause: 'BANISHED',
      };
      next.deaths.push(banished);
    }
  }

  pushNarration(next, 'DUSK', narrateDusk(next.rngSeed, next.round, banished, tie));
  next.votes = {};
  next.phase = 'DUSK';
  return next;
}

function applyKick(state: RoomState, event: { byPlayerId: string; targetId: string }): RoomState {
  requireModerator(state, event.byPlayerId, 'kick players');
  if (event.targetId === state.moderatorId) {
    fail('BAD_TARGET', 'You are the moderator — you can’t kick yourself.');
  }
  const target = state.players[event.targetId];
  if (!target) {
    fail('BAD_TARGET', 'No such player in this room. Check the player list with get_state.');
  }
  const next = clone(state);
  const t = next.players[event.targetId]!;

  // Lobby members and spectators are simply removed; they can rejoin.
  if (t.role === null) {
    delete next.players[event.targetId];
    return next;
  }

  if (!t.alive) {
    fail('BAD_TARGET', `${t.name} is already out of the game.`);
  }

  // Mid-game: treated as a death without role-based effects.
  t.alive = false;
  const record: DeathRecord = {
    playerId: t.id,
    name: t.name,
    role: t.role,
    round: next.round,
    cause: 'KICKED',
  };
  next.deaths.push(record);
  delete next.actions[t.id];
  delete next.votes[t.id];
  pushNarration(next, 'KICK', narrateKick(next.rngSeed, next.round, t.name, t.role));

  // A kick can hand either side the win (e.g. last mafia kicked); settle it now.
  if (next.phase !== 'ENDED') {
    const winner = checkWinner(next);
    if (winner) endGame(next, winner);
  }
  return next;
}

function applyReset(state: RoomState, event: { byPlayerId: string; seed: string }): RoomState {
  requireModerator(state, event.byPlayerId, 'reset the room');
  const next = clone(state);
  // Deal spectators in, but never above MAX_PLAYERS — otherwise start_game
  // refuses and the encore (the reason we reset) cannot begin. Earliest
  // joiners keep seats; overflow stays watching.
  const ordered = Object.values(next.players).sort((a, b) => a.joinedSeq - b.joinedSeq);
  let seated = 0;
  for (const p of ordered) {
    p.role = null;
    p.alive = true;
    p.spectator = seated >= MAX_PLAYERS;
    if (!p.spectator) seated += 1;
  }
  next.phase = 'LOBBY';
  next.round = 0;
  next.generation += 1;
  next.actions = {};
  next.votes = {};
  next.investigations = [];
  next.deaths = [];
  next.narration = [];
  next.winner = null;
  next.rngSeed = event.seed;
  return next;
}
