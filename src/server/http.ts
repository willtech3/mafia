import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { RoomStore } from '../store/types.js';
import { registerBoardRoutes } from './board.js';
import { looksLikeJwt, oidcFromEnv, type OidcVerifier } from './oidc.js';
import { buildServer, SERVER_INFO } from './tools.js';

/**
 * Stateless streamable-HTTP MCP endpoint: a fresh McpServer + transport per
 * request, no session ids ever minted. Any replica can serve any request —
 * all state lives in the room store.
 */
export function createApp(store: RoomStore, opts: { oidc?: OidcVerifier | null } = {}): Hono {
  const app = new Hono();
  const verifier = opts.oidc !== undefined ? opts.oidc : oidcFromEnv();

  app.use(
    '/mcp',
    cors({
      origin: (origin) => origin, // reflect; auth is bearer-token based, no cookies
      allowHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Mcp-Protocol-Version', 'Last-Event-ID'],
      exposeHeaders: ['Mcp-Session-Id', 'Mcp-Protocol-Version'],
      maxAge: 86400,
    }),
  );

  app.get('/health', (c) =>
    c.json({ ok: true, server: SERVER_INFO.name, version: SERVER_INFO.version, instance: INSTANCE_ID }),
  );

  registerBoardRoutes(app, store);

  app.all('/mcp', async (c) => {
    const authHeader = c.req.header('authorization');
    const bearer = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
    const oidc = bearer && verifier && looksLikeJwt(bearer) ? await verifier.verify(bearer) : null;
    const server = buildServer(store, bearer, oidc);
    // No options: session management disabled entirely (stateless mode).
    const transport = new WebStandardStreamableHTTPServerTransport();
    await server.connect(transport);
    // Elicitation relay: a bare JSON-RPC *response* landing here may belong
    // to an elicitation awaited on another replica. Park a copy in the store
    // before normal handling (same-replica handling still wins the race).
    const forward = transport.onmessage?.bind(transport);
    transport.onmessage = (message, extra) => {
      const m = message as { id?: number | string; method?: string };
      if (m.id !== undefined && m.method === undefined) {
        void store.putOrphanResponse(String(m.id), message).catch(() => undefined);
      }
      forward?.(message, extra);
    };
    const response = await transport.handleRequest(c.req.raw);
    // Surface which instance served the request — used by the kill-an-instance demo.
    const headers = new Headers(response.headers);
    headers.set('X-Mafia-Instance', INSTANCE_ID);
    return new Response(response.body, { status: response.status, headers });
  });

  return app;
}

/** Random per-process id; lets tests and the demo prove multi-instance serving. */
export const INSTANCE_ID = `${process.env['K_REVISION'] ?? 'local'}-${Math.random().toString(36).slice(2, 8)}`;
