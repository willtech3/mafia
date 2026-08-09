import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Projection } from '../game/view.js';

/**
 * A scripted MCP player: real SDK client over real streamable HTTP. Used by
 * the e2e tests, the synthetic audience, and the load generator — if it works
 * here, the pipe a human's ChatGPT uses is the same.
 */

export interface ToolReply {
  projection: Projection | null;
  playerToken: string | null;
  text: string;
  isError: boolean;
}

export class MafiaClient {
  private client: Client | null = null;
  playerToken: string | null = null;
  room: string | null = null;

  constructor(
    private url: string,
    readonly name: string,
  ) {}

  async connect(): Promise<void> {
    this.client = new Client({ name: `bot-${this.name}`, version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.url));
    // Cast: the SDK's Transport type trips exactOptionalPropertyTypes (sessionId).
    await this.client.connect(transport as unknown as Parameters<Client['connect']>[0]);
  }

  get instructions(): string | undefined {
    return this.client?.getInstructions();
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  async call(
    tool: string,
    args: Record<string, unknown> = {},
    opts: { anonymous?: boolean } = {},
  ): Promise<ToolReply> {
    if (!this.client) throw new Error('connect() first');
    const withToken =
      !opts.anonymous && this.playerToken && args['player_token'] === undefined
        ? { ...args, player_token: this.playerToken }
        : args;
    const result = (await this.client.callTool({ name: tool, arguments: withToken })) as CallToolResult;
    const sc = (result.structuredContent ?? null) as (Projection & { player_token?: string }) | null;
    const text = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    if (!opts.anonymous) {
      if (sc?.player_token) this.playerToken = sc.player_token;
      if (sc?.room) this.room = sc.room;
    }
    return { projection: sc, playerToken: sc?.player_token ?? null, text, isError: result.isError === true };
  }

  /** Call and throw on isError — for steps the script expects to succeed. */
  async must(tool: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
    const reply = await this.call(tool, args);
    if (reply.isError) {
      throw new Error(`[${this.name}] ${tool} failed: ${reply.text}`);
    }
    return reply;
  }

  async state(): Promise<Projection> {
    if (!this.room) throw new Error('not in a room');
    const reply = await this.must('get_state', { room: this.room });
    return reply.projection!;
  }
}
