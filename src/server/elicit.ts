import { randomInt } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitResultSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { RoomStore } from '../store/types.js';

/**
 * Elicitation for the stateless 2025-11-25 era.
 *
 * The request goes out via extra.sendRequest so it rides the original POST's
 * SSE stream (the SDK relates it automatically). The client's answer comes
 * back as a bare JSON-RPC response POST which may land on ANY replica: the
 * receiving replica parks unmatched responses in the store (see http.ts),
 * and we race the SDK's own promise against a store poll. We also assign a
 * unique request id (instead of the per-connection counter, which restarts
 * at 0 on every stateless request) so cross-replica correlation is exact.
 *
 * Clients that don't support elicitation (Claude today) reject or ignore the
 * request; both settle as 'unavailable' and callers fall back to the app tap
 * path. Two paths, one validated write.
 */

export type ElicitOutcome =
  | { kind: 'accept'; content: Record<string, unknown> }
  | { kind: 'declined' }
  | { kind: 'unavailable'; reason: string };

/** Minimal structural slice of the SDK's RequestHandlerExtra we rely on. */
export interface ElicitCapableExtra {
  sendRequest: (
    request: { method: string; params: Record<string, unknown> },
    resultSchema: typeof ElicitResultSchema,
    options?: { timeout?: number },
  ) => Promise<ElicitResult>;
}

const POLL_MS = 500;

export async function elicitForm(opts: {
  server: McpServer;
  extra: ElicitCapableExtra;
  store: RoomStore;
  message: string;
  requestedSchema: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<ElicitOutcome> {
  const timeoutMs = opts.timeoutMs ?? 90_000;

  // Unguessable JSON-RPC id (~48 bits of entropy, safe-integer range). The
  // relay parks unmatched responses by this id, so a guessable id would let an
  // attacker POST a forged elicitation answer (a night kill / doctor save /
  // detective probe) into a victim's open picker. Each stateless request gets
  // its own McpServer, so this id only needs to be unguessable, not globally
  // unique. Combined with delete-on-take in the store, replay is closed too.
  const uniqueId = randomInt(1, 281_474_976_710_655);
  (opts.server.server as unknown as { _requestMessageId: number })._requestMessageId = uniqueId;

  let settled = false;

  const direct = (async (): Promise<ElicitOutcome> => {
    try {
      const result = await opts.extra.sendRequest(
        {
          method: 'elicitation/create',
          params: { message: opts.message, requestedSchema: opts.requestedSchema },
        },
        ElicitResultSchema,
        { timeout: timeoutMs },
      );
      return outcomeFromResult(result);
    } catch (err) {
      if (settled) return { kind: 'unavailable', reason: 'lost race' }; // ignored
      return { kind: 'unavailable', reason: (err as Error).message ?? 'client rejected elicitation' };
    }
  })();

  const relayed = (async (): Promise<ElicitOutcome> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !settled) {
      await sleep(POLL_MS);
      try {
        const orphan = (await opts.store.takeOrphanResponse(String(uniqueId))) as {
          result?: unknown;
          error?: unknown;
        } | null;
        if (orphan?.result) {
          const parsed = ElicitResultSchema.safeParse(orphan.result);
          if (parsed.success) return outcomeFromResult(parsed.data);
          return { kind: 'unavailable', reason: 'malformed relayed response' };
        }
        if (orphan?.error) {
          return { kind: 'unavailable', reason: 'client rejected elicitation' };
        }
      } catch {
        // store hiccup — keep polling
      }
    }
    return { kind: 'unavailable', reason: 'timed out' };
  })();

  const outcome = await Promise.race([direct, relayed]);
  settled = true;
  return outcome;
}

function outcomeFromResult(result: ElicitResult): ElicitOutcome {
  if (result.action === 'accept') {
    return { kind: 'accept', content: (result.content ?? {}) as Record<string, unknown> };
  }
  return { kind: 'declined' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Titled single-select enum schema for form elicitation. */
export function targetEnumSchema(
  title: string,
  options: { id: string; name: string }[],
): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        title,
        oneOf: options.map((o) => ({ const: o.id, title: o.name })),
      },
    },
    required: ['target'],
  };
}
