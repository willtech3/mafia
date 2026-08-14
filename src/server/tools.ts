import { createHash, randomBytes } from 'node:crypto';
import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { APP_HTML } from './apphtml.generated.js';
import { GameError } from '../game/errors.js';
import { initialRoom, sanitizeName } from '../game/reducer.js';
import type { Phase, RoomState } from '../game/types.js';
import { viewFor, type Projection } from '../game/view.js';
import { runEvent } from '../store/engine.js';
import type { RoomStore } from '../store/types.js';
import { elicitForm, targetEnumSchema, type ElicitCapableExtra } from './elicit.js';
import type { OidcIdentity } from './oidc.js';
import {
  mintPlayerToken,
  newPlayerId,
  newRoomCode,
  normalizeRoomCode,
  resolveIdentity,
  type PlayerIdentity,
} from './identity.js';
import { RULES_TEXT, SERVER_INSTRUCTIONS } from './instructions.js';

/**
 * The ten contract tools. Every handler follows the same shape:
 * resolve identity -> validate + apply through the store transaction ->
 * re-read fresh state -> project through viewFor -> respond with a short
 * text line (including next_step_hint) plus the full projection in
 * structuredContent. GameErrors surface verbatim — they are written for
 * players, not developers.
 */

export const SERVER_INFO = { name: 'mafia', version: '0.3.0' } as const;

/** The one MCP App resource: role card, town board, victory screen. */
export const APP_URI = 'ui://mafia/app.html';

/**
 * Tool→UI association, with the deprecated flat key and ChatGPT's
 * compatibility alias included so every host era finds it.
 */
function uiMeta(): Record<string, unknown> {
  return {
    ui: { resourceUri: APP_URI },
    'ui/resourceUri': APP_URI,
    'openai/outputTemplate': APP_URI,
    'openai/widgetAccessible': true,
  };
}

/**
 * Loose but honest output schema shared by all tools (ChatGPT surfaces it and
 * nags when absent). Every field optional so error-adjacent results and the
 * bare how_to_play response validate too.
 */
const PROJECTION_OUTPUT = {
  room: z.string().optional(),
  phase: z.string().optional(),
  round: z.number().optional(),
  stateVersion: z.number().optional(),
  winner: z.string().nullable().optional(),
  featured: z.boolean().optional(),
  you: z.record(z.unknown()).nullable().optional(),
  players: z.array(z.record(z.unknown())).optional(),
  aliveCount: z.number().optional(),
  seatedCount: z.number().optional(),
  lobbyCount: z.number().optional(),
  spectatorCount: z.number().optional(),
  narration: z.array(z.record(z.unknown())).optional(),
  mafia: z.record(z.unknown()).optional(),
  detective: z.record(z.unknown()).optional(),
  doctor: z.record(z.unknown()).optional(),
  vote: z.record(z.unknown()).optional(),
  reveal: z.record(z.unknown()).optional(),
  next_step_hint: z.string().optional(),
  player_token: z.string().optional(),
};

/** Claude requires a hash-derived dedicated sandbox origin for app iframes. */
function claudeUiDomain(): string {
  const serverUrl = process.env['MAFIA_PUBLIC_URL'] ?? 'https://mafia-staging-1022738355193.us-central1.run.app/mcp';
  return `${createHash('sha256').update(serverUrl).digest('hex').slice(0, 32)}.claudemcpcontent.com`;
}

interface ToolCtx {
  store: RoomStore;
  bearer: string | undefined;
  /** Verified SSO identity, when the request carried a valid JWT. */
  oidc: OidcIdentity | null;
}

const roomArg = z
  .string()
  .describe('The 4-letter room code, e.g. "PLUM". Get it from the moderator or the projector screen.');

const tokenArg = z
  .string()
  .optional()
  .describe(
    'Your player token from create_room/join_room. Pass it on every call so the server knows who you are (not needed if the connection itself is signed in).',
  );

function phaseLabel(phase: Phase, round: number): string {
  switch (phase) {
    case 'LOBBY':
      return 'Lobby';
    case 'NIGHT':
      return `Night ${round}`;
    case 'DAWN':
      return `Dawn ${round}`;
    case 'DAY_DISCUSSION':
      return `Day ${round} — discussion`;
    case 'DAY_VOTE':
      return `Day ${round} — voting`;
    case 'DUSK':
      return `Dusk ${round}`;
    case 'ENDED':
      return 'Game over';
  }
}

function resultFor(projection: Projection, lead?: string): CallToolResult {
  const header = `Room ${projection.room} · ${phaseLabel(projection.phase, projection.round)} · ${projection.aliveCount} alive`;
  const lines = [lead, header, projection.next_step_hint].filter(Boolean);
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: projection as unknown as Record<string, unknown>,
  };
}

function errorResult(err: unknown): CallToolResult {
  if (err instanceof GameError) {
    return { isError: true, content: [{ type: 'text', text: err.message }] };
  }
  console.error('unexpected tool error', err);
  return {
    isError: true,
    content: [{ type: 'text', text: 'Something went wrong on the game server. Try again in a moment.' }],
  };
}

function fail(code: ConstructorParameters<typeof GameError>[0], message: string): never {
  throw new GameError(code, message);
}

async function loadRoom(ctx: ToolCtx, code: string): Promise<{ state: RoomState; version: number }> {
  const stored = await ctx.store.load(code);
  if (!stored) {
    fail(
      'ROOM_NOT_FOUND',
      `There's no room with code ${code}. Double-check the code with your host, or use join_room with no code to find the open game.`,
    );
  }
  return stored;
}

/** Fresh full read -> per-viewer projection. The only way results are built. */
async function project(
  ctx: ToolCtx,
  code: string,
  playerId: string | null,
  lead?: string,
  opts: { includeSeatKey?: boolean; preloaded?: { state: RoomState; version: number } } = {},
): Promise<CallToolResult> {
  // Read-only tools pass the state they already loaded so the hottest paths
  // (get_state, how_to_play) don't load the room twice per call.
  const { state, version } = opts.preloaded ?? (await loadRoom(ctx, code));
  const result = resultFor(viewFor(state, playerId, version), lead);
  // The viewer's own seat key rides along so the app (and a token-less chat)
  // can act without a separate join. Same trust domain as the projection.
  if (playerId && state.players[playerId]) {
    const token = mintPlayerToken(code, playerId);
    (result.structuredContent as Record<string, unknown>)['player_token'] = token;
    if (opts.includeSeatKey) {
      // Some hosts (Claude) hide structuredContent from the model, so the
      // seat key must appear in text once for the model to pass it later.
      const text = (result.content[0] as { text: string }).text;
      result.content = [
        { type: 'text', text: `${text}\n[player_token: ${token} — pass this on every later call for this room]` },
      ];
    }
  }
  return result;
}

function identity(ctx: ToolCtx, tokenFromArgs: string | undefined, roomCode: string): PlayerIdentity {
  const id = resolveIdentity(ctx.bearer, tokenFromArgs);
  if (!id) {
    fail(
      'NOT_IN_ROOM',
      `I don't know who you are in room ${roomCode} yet. Use join_room first (it gives you a player token), and pass that token as player_token.`,
    );
  }
  if (id.roomCode !== roomCode) {
    fail(
      'NOT_IN_ROOM',
      `Your player token is for room ${id.roomCode}, not ${roomCode}. Use join_room to join ${roomCode}, or double-check the room code.`,
    );
  }
  return id;
}

/** Seat lookup by verified SSO subject; falls back to the token path. */
async function identityFor(ctx: ToolCtx, tokenFromArgs: string | undefined, code: string): Promise<PlayerIdentity> {
  if (ctx.oidc) {
    const { state } = await loadRoom(ctx, code);
    const seat = Object.values(state.players).find((p) => p.subject === ctx.oidc!.subject);
    if (seat) return { roomCode: code, playerId: seat.id };
    if (!resolveIdentity(ctx.bearer, tokenFromArgs)) {
      fail('NOT_IN_ROOM', `You're signed in but haven't joined room ${code} yet — use join_room first.`);
    }
  }
  return identity(ctx, tokenFromArgs, code);
}

/**
 * Resolve the viewer from an ALREADY-LOADED state (no store read) — tolerant:
 * null viewer for read-only tools. Read-only tools load the room once and pass
 * that state here, avoiding a second full-room read on the hottest paths.
 */
function viewerFromState(ctx: ToolCtx, tokenFromArgs: string | undefined, code: string, state: RoomState): string | null {
  if (ctx.oidc) {
    const seat = Object.values(state.players).find((p) => p.subject === ctx.oidc!.subject);
    if (seat) return seat.id;
  }
  const id = resolveIdentity(ctx.bearer, tokenFromArgs);
  return id?.roomCode === code ? id.playerId : null;
}

/** Accept a player id or a (unique, case-insensitive) player name. */
function resolveTarget(state: RoomState, raw: string, forWhat: string): string {
  const trimmed = raw.trim();
  if (state.players[trimmed]) return trimmed;
  const lower = trimmed.toLowerCase();
  const byName = Object.values(state.players).filter((p) => p.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0]!.id;
  if (byName.length > 1) {
    // List the candidate ids inline — on Claude the model can't read
    // structuredContent, so "check get_state for ids" would dead-end.
    const options = byName.map((p) => `${p.name} (${p.id})`).join(', ');
    fail(
      'BAD_TARGET',
      `More than one player is named "${trimmed}": ${options}. Tell me the exact id ${forWhat}, or tap them on the game panel.`,
    );
  }
  fail(
    'BAD_TARGET',
    `I can't find "${trimmed}" in this room. Check the player list with get_state and use the exact name or id ${forWhat}.`,
  );
}

async function resolveRoomCode(ctx: ToolCtx, room: string | undefined): Promise<string> {
  if (room && room.trim().length > 0) return normalizeRoomCode(room);
  const lobbies = await ctx.store.findFeaturedLobbies();
  if (lobbies.length === 1) return lobbies[0]!;
  if (lobbies.length === 0) {
    // Deliberately does NOT suggest create_room: a game already on the big
    // screen has left LOBBY, so latecomers must join it by its 4-letter code
    // (as spectators). Steering novices to create_room here spawns stray
    // featured lobbies and a wrong-room cascade.
    fail(
      'NO_FEATURED_ROOM',
      'No open lobby to join right now. If a game is already up on the big screen, tell me its 4-letter room code to watch it. (Only create your own room if you are the one hosting.)',
    );
  }
  fail(
    'MANY_FEATURED_ROOMS',
    `Several games are open right now: ${lobbies.join(', ')}. Ask your host which code is yours, then join with join_room and that code.`,
  );
}

export function buildServer(store: RoomStore, bearer?: string, oidc?: OidcIdentity | null): McpServer {
  const ctx: ToolCtx = { store, bearer, oidc: oidc ?? null };
  const server = new McpServer(SERVER_INFO, {
    instructions: SERVER_INSTRUCTIONS,
  });

  registerAppResource(
    server,
    'Mafia game board',
    APP_URI,
    {
      mimeType: RESOURCE_MIME_TYPE,
      description: 'Role card, town board with tap-to-vote, and victory screen for the Mafia party game.',
      _meta: {
        ui: {
          prefersBorder: false,
          domain: claudeUiDomain(),
          csp: { connectDomains: [], resourceDomains: [] },
        },
      },
    },
    async () => ({
      contents: [{ uri: APP_URI, mimeType: RESOURCE_MIME_TYPE, text: APP_HTML }],
    }),
  );

  server.registerTool(
    'create_room',
    {
      title: 'Create a Mafia room',
      description:
        'Create a new Mafia game room. You become the moderator: you will start the game and move it between phases. Returns the 4-letter room code to share with the room.',
      inputSchema: {
        name: z.string().optional().describe('Your display name (shown to other players).'),
        featured: z
          .boolean()
          .optional()
          .describe('Featured rooms are discoverable by join_room without a code. Default true.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: uiMeta(),
      outputSchema: PROJECTION_OUTPUT,
    },
    async ({ name, featured }) => {
      try {
        const displayName = sanitizeName(name ?? ctx.oidc?.name ?? 'The Moderator');
        const moderatorId = newPlayerId();
        let code = '';
        for (let attempt = 0; ; attempt++) {
          code = newRoomCode();
          try {
            await store.create(
              initialRoom({
                code,
                moderatorId,
                moderatorName: displayName || 'The Moderator',
                seed: randomBytes(8).toString('hex'),
                nowMs: Date.now(),
                featured: featured ?? true,
                ...(ctx.oidc ? { subject: ctx.oidc.subject } : {}),
              }),
            );
            break;
          } catch (err) {
            if (err instanceof GameError && err.code === 'CONFLICT' && attempt < 4) continue;
            throw err;
          }
        }
        return await project(
          ctx,
          code,
          moderatorId,
          `Room created! Share the code ${code} out loud so everyone can join.`,
          { includeSeatKey: true },
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'join_room',
    {
      title: 'Join the Mafia game',
      description:
        'Join a Mafia room as a player. If you don\'t know the room code, call it with no code — it finds the open game automatically. Returns your player token; pass it on later calls.',
      inputSchema: {
        room: roomArg.optional().describe('The 4-letter room code. Omit it to join the open featured game.'),
        name: z.string().optional().describe('Your display name (shown to other players).'),
        player_token: tokenArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: uiMeta(),
      outputSchema: PROJECTION_OUTPUT,
    },
    async ({ room, name, player_token }) => {
      try {
        const code = await resolveRoomCode(ctx, room);
        const stored = await loadRoom(ctx, code);
        const { state } = stored;

        // Signed-in players: the seat is bound to their stable SSO subject.
        if (ctx.oidc) {
          const seat = Object.values(state.players).find((p) => p.subject === ctx.oidc!.subject);
          if (seat) {
            if (name && sanitizeName(name) && sanitizeName(name) !== seat.name) {
              await runEvent(store, code, { type: 'JOIN', playerId: seat.id, name, seq: 0, subject: ctx.oidc.subject });
            }
            return await project(ctx, code, seat.id, `Welcome back, ${seat.name} — this seat is yours.`, { includeSeatKey: true });
          }
        }

        // Already seated on this connection? Just report state (rename if asked).
        const existing = resolveIdentity(ctx.bearer, player_token);
        if (existing && existing.roomCode === code && state.players[existing.playerId]) {
          if (name && sanitizeName(name)) {
            await runEvent(store, code, { type: 'JOIN', playerId: existing.playerId, name, seq: 0 });
          }
          return await project(ctx, code, existing.playerId, 'You are already in this room.', { includeSeatKey: true });
        }

        const displayName = sanitizeName(name ?? ctx.oidc?.name ?? '');
        if (!displayName) {
          // Not an error — a normal "what's your name?" turn (a red failed-tool
          // chip on someone's first interaction is a bad first impression).
          // Return the FULL public projection (viewer null), not a stub: hosts
          // render the app iframe from structuredContent, and a projection
          // without phase/players would crash the board on a first-run user.
          return await project(
            ctx,
            code,
            null,
            `Room ${code} found! What display name should I seat you under? For example: "join as Sam".`,
            { preloaded: stored },
          );
        }

        // SECURITY: we never hand back an existing seat based on a public
        // display name — names are visible to everyone (board + projector), so
        // reclaiming by name would leak that seat's secret role and mint its
        // token to a stranger. A token-less same-name joiner always gets a NEW
        // seat; the reducer disambiguates the display name ("Sam" -> "Sam (2)").
        // Legitimate reconnects come from the SSO subject (bound above) or the
        // player_token the client already holds (handled above).
        const playerId = newPlayerId();
        await runEvent(store, code, {
          type: 'JOIN',
          playerId,
          name: displayName,
          seq: 0,
          ...(ctx.oidc ? { subject: ctx.oidc.subject } : {}),
        });
        return await project(ctx, code, playerId, `Welcome to room ${code}, ${displayName}!`, { includeSeatKey: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_state',
    {
      title: 'Refresh the game state',
      description:
        'Read the current state of the game: phase, living players, vote tallies, narration, and your own private information. Read-only and always safe to call.',
      inputSchema: { room: roomArg, player_token: tokenArg },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: uiMeta(),
      outputSchema: PROJECTION_OUTPUT,
    },
    async ({ room, player_token }) => {
      try {
        const code = normalizeRoomCode(room);
        const stored = await loadRoom(ctx, code);
        const viewer = viewerFromState(ctx, player_token, code, stored.state);
        return await project(ctx, code, viewer, undefined, { preloaded: stored });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'how_to_play',
    {
      title: 'How to play Mafia',
      description:
        'The 30-second rules of the game, plus where the caller currently stands if they give a room code. Read-only; call this for anyone new.',
      inputSchema: { room: roomArg.optional(), player_token: tokenArg },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: uiMeta(),
      outputSchema: PROJECTION_OUTPUT,
    },
    async ({ room, player_token }) => {
      try {
        if (!room) {
          return {
            content: [
              {
                type: 'text',
                text: `${RULES_TEXT}\n\nNext step: use join_room to take a seat (no code needed if a game is open).`,
              },
            ],
            structuredContent: { next_step_hint: 'Use join_room to take a seat — no code needed if a game is open.' },
          };
        }
        const code = normalizeRoomCode(room);
        const { state, version } = await loadRoom(ctx, code);
        const viewer = viewerFromState(ctx, player_token, code, state);
        const projection = viewFor(state, viewer, version);
        return {
          content: [{ type: 'text', text: `${RULES_TEXT}\n\nYour current situation: ${projection.next_step_hint}` }],
          structuredContent: projection as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'start_game',
    {
      title: 'Start the game',
      description:
        'Moderator only: deal secret roles to everyone in the lobby and begin Night 1. Needs 5–80 players.',
      inputSchema: { room: roomArg, player_token: tokenArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      _meta: uiMeta(),
      outputSchema: PROJECTION_OUTPUT,
    },
    async ({ room, player_token }) => {
      try {
        const code = normalizeRoomCode(room);
        const id = await identityFor(ctx, player_token, code);
        await runEvent(store, code, { type: 'START', byPlayerId: id.playerId });
        return await project(ctx, code, id.playerId, 'The game has begun — roles are dealt, night falls.');
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'submit_night_action',
    {
      title: 'Choose your night target',
      description:
        'At night: mafia pick a victim, doctors pick someone to protect, detectives pick someone to investigate. The server knows your role — just name the target. Omit the target to be asked privately (a picker appears if your app supports it). You can change your choice until dawn.',
      inputSchema: {
        room: roomArg,
        target_player_id: z
          .string()
          .optional()
          .describe('The target: a player id (preferred) or their exact display name. Omit to be prompted privately.'),
        player_token: tokenArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: uiMeta(),
      outputSchema: PROJECTION_OUTPUT,
    },
    async ({ room, target_player_id, player_token }, extra) => {
      try {
        const code = normalizeRoomCode(room);
        const id = await identityFor(ctx, player_token, code);
        const { state } = await loadRoom(ctx, code);

        let targetId: string;
        if (target_player_id && target_player_id.trim().length > 0) {
          targetId = resolveTarget(state, target_player_id, 'as your night target');
        } else {
          // Private picker path: elicit the choice from the human directly.
          const me = state.players[id.playerId];
          const role = me?.role;
          if (!me || !me.alive || state.phase !== 'NIGHT' || !role || role === 'VILLAGER') {
            // Let the reducer produce its usual teaching error.
            await runEvent(store, code, { type: 'NIGHT_ACTION', playerId: id.playerId, targetId: 'nobody', seq: 0 });
            return await project(ctx, code, id.playerId);
          }
          const options = Object.values(state.players)
            .filter((p) => p.alive && !p.spectator && p.role !== null)
            .filter((p) => (p.id === me.id ? role === 'DOCTOR' : true))
            .map((p) => ({ id: p.id, name: p.id === me.id ? `${p.name} (yourself)` : p.name }));
          const prompts: Record<string, [string, string]> = {
            MAFIA: ['Mafia — choose your victim', 'The family strikes at dawn. Pick tonight’s target.'],
            DOCTOR: ['Doctor — choose who to protect', 'One life is in your hands tonight (you may pick yourself).'],
            DETECTIVE: ['Detective — choose who to investigate', 'The truth arrives at dawn, for your eyes only.'],
          };
          const [title, message] = prompts[role]!;
          const outcome = await elicitForm({
            server,
            extra: extra as unknown as ElicitCapableExtra,
            store,
            message,
            requestedSchema: targetEnumSchema(title, options),
            // Short: if a client neither supports nor cleanly rejects
            // elicitation, fall back to the tap path fast rather than stalling
            // the tool call past the host's timeout on stage.
            timeoutMs: 20_000,
          });
          if (outcome.kind === 'declined') {
            return await project(ctx, code, id.playerId, 'No action recorded — the night is still young.');
          }
          if (outcome.kind === 'unavailable') {
            // Not an error: hand back the live board so the player can tap
            // their target there (and the panel renders instead of a blank).
            return await project(
              ctx,
              code,
              id.playerId,
              'This chat can’t show the private picker, so nothing was chosen for you. Tap your target on the game panel below — or tell me a name and I’ll pass it along.',
            );
          }
          const chosen = String(outcome.content['target'] ?? '');
          if (!options.some((o) => o.id === chosen)) {
            fail('BAD_TARGET', 'That choice is no longer valid — tap Refresh in the app and pick again.');
          }
          targetId = chosen;
        }

        await runEvent(store, code, { type: 'NIGHT_ACTION', playerId: id.playerId, targetId, seq: 0 });
        return await project(ctx, code, id.playerId, 'Your night action is in.');
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'cast_vote',
    {
      title: 'Vote to banish',
      description:
        'During the day vote: vote to banish a player, or pass "abstain". You can change your vote until the moderator closes voting.',
      inputSchema: {
        room: roomArg,
        target_player_id: z
          .string()
          .describe('Who to banish: a player id (preferred) or exact display name, or "abstain".'),
        player_token: tokenArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: uiMeta(),
      outputSchema: PROJECTION_OUTPUT,
    },
    async ({ room, target_player_id, player_token }) => {
      try {
        const code = normalizeRoomCode(room);
        const id = await identityFor(ctx, player_token, code);
        let targetId: string;
        if (target_player_id.trim().toLowerCase() === 'abstain') {
          targetId = 'ABSTAIN';
        } else {
          const { state } = await loadRoom(ctx, code);
          targetId = resolveTarget(state, target_player_id, 'to vote for them');
        }
        await runEvent(store, code, { type: 'VOTE', playerId: id.playerId, targetId, seq: 0 });
        return await project(
          ctx,
          code,
          id.playerId,
          targetId === 'ABSTAIN' ? 'You are abstaining.' : 'Your vote is in.',
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'advance_phase',
    {
      title: 'Advance to the next phase',
      description:
        'Moderator only: close the current phase and move the game forward (night → dawn → discussion → vote → dusk → night...). This resolves pending actions and cannot be undone.',
      inputSchema: { room: roomArg, player_token: tokenArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      _meta: uiMeta(),
      outputSchema: PROJECTION_OUTPUT,
    },
    async ({ room, player_token }, extra) => {
      try {
        const code = normalizeRoomCode(room);
        const id = await identityFor(ctx, player_token, code);

        // Closing a vote that banishes NOBODY (tie / no votes) is surprising —
        // confirm with the moderator when their client supports elicitation.
        // The normal leader-banished path never double-confirms.
        const before = await loadRoom(ctx, code);
        if (before.state.phase === 'DAY_VOTE' && before.state.moderatorId === id.playerId) {
          const view = viewFor(before.state, id.playerId, before.version);
          const tally = view.vote?.tally ?? [];
          const tie = tally.length >= 2 && tally[0]!.count === tally[1]!.count;
          if (tally.length === 0 || tie) {
            const outcome = await elicitForm({
              server,
              extra: extra as unknown as ElicitCapableExtra,
              store,
              message:
                tally.length === 0
                  ? `${(view.vote?.votesCast ?? 0) > 0 ? 'Every vote so far is an abstain' : 'No votes have been cast'} — closing now banishes no one. Close the vote anyway?`
                  : `The vote is tied (${tally[0]!.targetName} and ${tally[1]!.targetName}) — closing now banishes no one. Close the vote anyway?`,
              requestedSchema: {
                type: 'object',
                properties: { confirm: { type: 'boolean', title: 'Close the vote', default: true } },
                required: ['confirm'],
              },
              // Must settle before the app's 15s call timeout (main.ts
              // CALL_TIMEOUT_MS), or an app-originated close of a tie/empty
              // vote would show a false error while the server still succeeds.
              // The app already shows its own confirm sheet, so a short server
              // window here only matters for the chat path.
              timeoutMs: 12_000,
            });
            if (outcome.kind === 'declined' || (outcome.kind === 'accept' && outcome.content['confirm'] === false)) {
              return await project(ctx, code, id.playerId, 'The vote stays open.');
            }
            // accept or unavailable -> proceed (the app confirm sheet already guarded this).
          }
        }

        await runEvent(store, code, { type: 'ADVANCE', byPlayerId: id.playerId });
        const result = await project(ctx, code, id.playerId);
        // Lead with the freshest narration so the moderator can read it aloud.
        const projection = result.structuredContent as unknown as Projection;
        const latest = projection.narration.at(-1);
        if (latest && (projection.phase === 'DAWN' || projection.phase === 'DUSK' || projection.phase === 'ENDED')) {
          result.content = [{ type: 'text', text: `${latest.text}\n\n${(result.content[0] as { text: string }).text}` }];
        }
        return result;
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'kick_player',
    {
      title: 'Kick a player',
      description:
        'Moderator only: remove an unresponsive player. In the lobby they leave entirely; mid-game they are treated as dead (their role is revealed).',
      inputSchema: {
        room: roomArg,
        player_id: z.string().describe('The player to remove: player id (preferred) or exact display name.'),
        player_token: tokenArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      _meta: uiMeta(),
      outputSchema: PROJECTION_OUTPUT,
    },
    async ({ room, player_id, player_token }) => {
      try {
        const code = normalizeRoomCode(room);
        const id = await identityFor(ctx, player_token, code);
        const { state } = await loadRoom(ctx, code);
        const targetId = resolveTarget(state, player_id, 'to kick them');
        await runEvent(store, code, { type: 'KICK', byPlayerId: id.playerId, targetId });
        return await project(ctx, code, id.playerId, 'Player removed.');
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'reset_room',
    {
      title: 'Reset the room',
      description:
        'Moderator only: end the current game and return everyone (including spectators) to the lobby for a fresh game with new roles.',
      inputSchema: { room: roomArg, player_token: tokenArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      _meta: uiMeta(),
      outputSchema: PROJECTION_OUTPUT,
    },
    async ({ room, player_token }) => {
      try {
        const code = normalizeRoomCode(room);
        const id = await identityFor(ctx, player_token, code);
        await runEvent(store, code, {
          type: 'RESET',
          byPlayerId: id.playerId,
          seed: randomBytes(8).toString('hex'),
        });
        return await project(ctx, code, id.playerId, 'The room is back in the lobby — same crowd, fresh deal.');
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}
