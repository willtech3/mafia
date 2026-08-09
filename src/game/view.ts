import {
  alivePlayers,
  killsPerNight,
  seatedPlayers,
  type DeathCause,
  type Faction,
  type Phase,
  type Player,
  type Role,
  type RoomState,
} from './types.js';

/**
 * viewFor(state, viewerId): the ONLY way game state leaves the server.
 * Everything in the returned object is visible to that player AND their model,
 * so redaction happens here and nowhere else. Treat leaks as P0 bugs.
 *
 * Visibility rules:
 *  - Living players: own role, public board, own pending submission,
 *    role-private blocks (mafia teammates + tally, detective results, doctor target).
 *  - Vote tallies during DAY_VOTE are public as counts; who-voted-for-whom is not.
 *  - Dead seated players: full unredacted state (deliberate spectator perk).
 *  - Late-join spectators: public board only (they are in the physical room —
 *    no secrets until the game ends).
 *  - ENDED: full reveal for everyone.
 */

const NARRATION_LIMIT = 8;

export interface PlayerTile {
  id: string;
  name: string;
  alive: boolean;
  isModerator?: boolean;
  /** Public only once dead (house rule: roles reveal on death) or at game end. */
  role?: Role;
  cause?: DeathCause;
  /** Vote count badge, present during DAY_VOTE. */
  votes?: number;
}

export interface Projection {
  room: string;
  phase: Phase;
  round: number;
  stateVersion: number;
  winner: Faction | null;
  featured: boolean;
  you: {
    id: string;
    name: string;
    alive: boolean;
    isModerator: boolean;
    spectator: boolean;
    role: Role | null;
    /** Your own pending night target (name shown back to you). */
    nightTarget?: { id: string; name: string };
    /** Your own pending vote. */
    vote?: { targetId: string; targetName?: string };
  } | null;
  players: PlayerTile[];
  aliveCount: number;
  seatedCount: number;
  lobbyCount: number;
  spectatorCount: number;
  narration: { round: number; at: string; text: string }[];
  /** Living mafia only. */
  mafia?: {
    teammates: { id: string; name: string; alive: boolean }[];
    killsTonight: number;
    tally: { targetId: string; targetName: string; count: number }[];
  };
  /** The detective's own results only. */
  detective?: {
    results: { targetId: string; targetName: string; result: 'MAFIA' | 'NOT MAFIA'; round: number }[];
  };
  /** The doctor's own current protect target only. */
  doctor?: { protecting?: { id: string; name: string } };
  /** Public during DAY_VOTE: counts only. */
  vote?: {
    tally: { targetId: string; targetName: string; count: number }[];
    abstains: number;
    votesCast: number;
    aliveCount: number;
  };
  /** Full role reveal: dead spectators mid-game, everyone at ENDED. */
  reveal?: {
    players: { id: string; name: string; role: Role; alive: boolean }[];
    nightActions?: { playerName: string; kind: string; targetName: string }[];
    votes?: { voterName: string; targetName: string }[];
    investigations?: { detectiveName: string; targetName: string; result: string; round: number }[];
  };
  next_step_hint: string;
}

export function viewFor(state: RoomState, viewerId: string | null, stateVersion: number): Projection {
  const viewer = viewerId ? (state.players[viewerId] ?? null) : null;
  const seated = seatedPlayers(state);
  const living = alivePlayers(state);
  const inGame = state.phase !== 'LOBBY';

  const gameOver = state.phase === 'ENDED';
  const deadSeatedViewer = viewer !== null && viewer.role !== null && !viewer.alive;
  const omniscient = gameOver || deadSeatedViewer;

  // Public board: seated players during a game, lobby members otherwise.
  const boardPlayers = (inGame ? seated : Object.values(state.players).filter((p) => !p.spectator)).sort(
    (a, b) => Number(b.alive) - Number(a.alive) || a.joinedSeq - b.joinedSeq,
  );

  const voteCounts = publicVoteCounts(state);

  const players: PlayerTile[] = boardPlayers.map((p) => {
    const tile: PlayerTile = { id: p.id, name: p.name, alive: p.alive };
    if (p.isModerator) tile.isModerator = true;
    if (p.role !== null && (!p.alive || gameOver)) {
      tile.role = p.role;
      const death = state.deaths.find((d) => d.playerId === p.id);
      if (death) tile.cause = death.cause;
    }
    if (state.phase === 'DAY_VOTE') tile.votes = voteCounts.get(p.id) ?? 0;
    return tile;
  });

  const projection: Projection = {
    room: state.code,
    phase: state.phase,
    round: state.round,
    stateVersion,
    winner: state.winner,
    featured: state.featured,
    you: viewer && buildYou(state, viewer),
    players,
    aliveCount: living.length,
    seatedCount: seated.length,
    lobbyCount: Object.values(state.players).filter((p) => !p.spectator).length,
    spectatorCount: Object.values(state.players).filter((p) => p.spectator).length,
    narration: state.narration.slice(-NARRATION_LIMIT),
    next_step_hint: '',
  };

  if (state.phase === 'DAY_VOTE') {
    const valid = Object.values(state.votes).filter((v) => state.players[v.playerId]?.alive);
    projection.vote = {
      tally: [...voteCounts.entries()]
        .map(([targetId, count]) => ({
          targetId,
          targetName: state.players[targetId]?.name ?? '?',
          count,
        }))
        .sort((a, b) => b.count - a.count),
      abstains: valid.filter((v) => v.targetId === 'ABSTAIN').length,
      votesCast: valid.length,
      aliveCount: living.length,
    };
  }

  // Role-private blocks for LIVING role-holders only (the dead get `reveal` instead).
  if (viewer && viewer.alive && viewer.role !== null && !gameOver) {
    if (viewer.role === 'MAFIA') {
      const aliveMafiaCount = living.filter((p) => p.role === 'MAFIA').length;
      projection.mafia = {
        teammates: seated
          .filter((p) => p.role === 'MAFIA' && p.id !== viewer.id)
          .map((p) => ({ id: p.id, name: p.name, alive: p.alive })),
        killsTonight: killsPerNight(aliveMafiaCount),
        tally: mafiaTally(state),
      };
    }
    if (viewer.role === 'DETECTIVE') {
      projection.detective = {
        results: state.investigations
          .filter((inv) => inv.detectiveId === viewer.id)
          .map((inv) => ({
            targetId: inv.targetId,
            targetName: inv.targetName,
            result: inv.result,
            round: inv.round,
          })),
      };
    }
    if (viewer.role === 'DOCTOR') {
      const action = state.actions[viewer.id];
      projection.doctor = {};
      if (action && state.phase === 'NIGHT') {
        const target = state.players[action.targetId];
        if (target) projection.doctor.protecting = { id: target.id, name: target.name };
      }
    }
  }

  if (omniscient) {
    projection.reveal = buildReveal(state);
  }

  projection.next_step_hint = nextStepHint(state, viewer);
  return projection;
}

function buildYou(state: RoomState, viewer: Player): NonNullable<Projection['you']> {
  const you: NonNullable<Projection['you']> = {
    id: viewer.id,
    name: viewer.name,
    alive: viewer.alive,
    isModerator: viewer.isModerator,
    spectator: viewer.spectator,
    role: viewer.role,
  };
  const action = state.actions[viewer.id];
  if (action && state.phase === 'NIGHT') {
    const target = state.players[action.targetId];
    if (target) you.nightTarget = { id: target.id, name: target.name };
  }
  const vote = state.votes[viewer.id];
  if (vote && state.phase === 'DAY_VOTE') {
    you.vote =
      vote.targetId === 'ABSTAIN'
        ? { targetId: 'ABSTAIN' }
        : { targetId: vote.targetId, targetName: state.players[vote.targetId]?.name ?? '?' };
  }
  return you;
}

function publicVoteCounts(state: RoomState): Map<string, number> {
  const counts = new Map<string, number>();
  if (state.phase !== 'DAY_VOTE') return counts;
  for (const v of Object.values(state.votes)) {
    const voter = state.players[v.playerId];
    if (!voter?.alive || voter.spectator) continue;
    if (v.targetId === 'ABSTAIN') continue;
    if (!state.players[v.targetId]?.alive) continue;
    counts.set(v.targetId, (counts.get(v.targetId) ?? 0) + 1);
  }
  return counts;
}

function mafiaTally(state: RoomState): { targetId: string; targetName: string; count: number }[] {
  if (state.phase !== 'NIGHT') return [];
  const counts = new Map<string, number>();
  for (const a of Object.values(state.actions)) {
    if (a.kind !== 'KILL') continue;
    const actor = state.players[a.playerId];
    if (!actor?.alive || actor.role !== 'MAFIA') continue;
    counts.set(a.targetId, (counts.get(a.targetId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([targetId, count]) => ({
      targetId,
      targetName: state.players[targetId]?.name ?? '?',
      count,
    }))
    .sort((a, b) => b.count - a.count);
}

function buildReveal(state: RoomState): NonNullable<Projection['reveal']> {
  const reveal: NonNullable<Projection['reveal']> = {
    players: seatedPlayers(state).map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role!,
      alive: p.alive,
    })),
  };
  if (state.phase !== 'ENDED') {
    reveal.nightActions = Object.values(state.actions).map((a) => ({
      playerName: state.players[a.playerId]?.name ?? '?',
      kind: a.kind,
      targetName: state.players[a.targetId]?.name ?? '?',
    }));
    reveal.votes = Object.values(state.votes).map((v) => ({
      voterName: state.players[v.playerId]?.name ?? '?',
      targetName: v.targetId === 'ABSTAIN' ? '(abstain)' : (state.players[v.targetId]?.name ?? '?'),
    }));
  }
  reveal.investigations = state.investigations.map((inv) => ({
    detectiveName: state.players[inv.detectiveId]?.name ?? '?',
    targetName: inv.targetName,
    result: inv.result,
    round: inv.round,
  }));
  return reveal;
}

// ---------------------------------------------------------------------------

function nextStepHint(state: RoomState, viewer: Player | null): string {
  if (!viewer) {
    return state.phase === 'LOBBY'
      ? 'A game is forming — use join_room to take a seat.'
      : 'A game is in progress. You can join as a spectator with join_room, or wait for the next game.';
  }

  if (viewer.spectator) {
    return state.phase === 'ENDED'
      ? 'Game over. When the moderator resets the room you will be dealt into the next game.'
      : 'You are watching this game as a spectator. You will be dealt in when the room resets for a new game.';
  }

  const mod = viewer.isModerator;
  const dead = state.phase !== 'LOBBY' && viewer.role !== null && !viewer.alive;

  switch (state.phase) {
    case 'LOBBY': {
      const count = Object.values(state.players).filter((p) => !p.spectator).length;
      return mod
        ? `${count} in the lobby. When everyone has joined (5–80), use start_game.`
        : 'You are in the lobby — wait for the moderator to start the game.';
    }
    case 'NIGHT': {
      if (dead) return deadHint(mod);
      const nightRoles = alivePlayers(state).filter((p) => p.role !== 'VILLAGER');
      const acted = nightRoles.filter((p) => state.actions[p.id]).length;
      if (mod && viewer.role === 'VILLAGER') {
        return `Night ${state.round}: ${acted} of ${nightRoles.length} night actions are in. Use advance_phase to bring the dawn.`;
      }
      const yourAction = state.actions[viewer.id];
      switch (viewer.role) {
        case 'MAFIA':
          return yourAction
            ? `Your target is locked in — you can change it until dawn.${modSuffix(mod, acted, nightRoles.length)}`
            : `It’s night — open the app and choose a victim.${modSuffix(mod, acted, nightRoles.length)}`;
        case 'DOCTOR':
          return yourAction
            ? `You are protecting your chosen player — you can change it until dawn.${modSuffix(mod, acted, nightRoles.length)}`
            : `It’s night — open the app and choose someone to protect (you may protect yourself).${modSuffix(mod, acted, nightRoles.length)}`;
        case 'DETECTIVE':
          return yourAction
            ? `Your investigation is set — the result arrives at dawn.${modSuffix(mod, acted, nightRoles.length)}`
            : `It’s night — open the app and choose someone to investigate.${modSuffix(mod, acted, nightRoles.length)}`;
        default:
          return 'It’s night — villagers are asleep. Sit tight until dawn.';
      }
    }
    case 'DAWN':
      if (dead) return deadHint(mod);
      return mod
        ? 'Dawn has broken — read the narration aloud, then advance_phase to open discussion.'
        : 'Dawn has broken — check the narration to see what happened, then discuss out loud.';
    case 'DAY_DISCUSSION':
      if (dead) return deadHint(mod);
      return mod
        ? 'Discussion is open — when the room is ready, advance_phase to open voting.'
        : 'Discuss out loud: who seems suspicious? The moderator will open voting soon.';
    case 'DAY_VOTE': {
      if (dead) return deadHint(mod);
      const yourVote = state.votes[viewer.id];
      const base = yourVote
        ? 'Your vote is in — you can change it until the moderator closes voting.'
        : 'Voting is open — tap a player in the app to vote (or vote to abstain).';
      return mod ? `${base} Use advance_phase to close the vote.` : base;
    }
    case 'DUSK':
      if (dead) return deadHint(mod);
      return mod
        ? 'The votes are counted — read the narration aloud, then advance_phase to continue.'
        : 'The votes are counted — see the narration for who was banished. Night falls soon.';
    case 'ENDED':
      return mod
        ? `Game over — the ${state.winner === 'MAFIA' ? 'Mafia' : 'Town'} won. Use reset_room to play again with the same group.`
        : `Game over — the ${state.winner === 'MAFIA' ? 'Mafia' : 'Town'} won. Ask the moderator to reset the room to play again.`;
  }
}

function deadHint(mod: boolean): string {
  return mod
    ? 'You are dead, but still the moderator — keep advancing phases. You can also see everything now.'
    : 'You are out of the game — but now you can see everyone’s secret roles. Enjoy the show.';
}

function modSuffix(mod: boolean, acted: number, total: number): string {
  return mod ? ` (Moderator: ${acted}/${total} night actions in — advance_phase when ready.)` : '';
}
