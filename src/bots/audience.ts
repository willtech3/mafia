import type { Projection } from '../game/view.js';
import { MafiaClient } from './client.js';

/**
 * Synthetic audience: N scripted players that join, act at night, and vote
 * plausibly. Doubles as the load generator, and with --smoke it drives a
 * complete game by itself (bot moderator included) — the pre-demo warmup
 * check against staging.
 *
 * Usage:
 *   tsx src/bots/audience.ts --url http://localhost:8080/mcp --join PLUM --bots 77
 *   tsx src/bots/audience.ts --url http://localhost:8080/mcp --smoke 20
 */

interface Args {
  url: string;
  join: string | undefined;
  bots: number;
  smoke: boolean;
  pollMs: number;
  featured: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const smokeCount = get('--smoke');
  return {
    url: get('--url') ?? 'http://localhost:8080/mcp',
    join: get('--join'),
    bots: Number(smokeCount ?? get('--bots') ?? 10),
    smoke: smokeCount !== undefined,
    pollMs: Number(get('--poll-ms') ?? 3000),
    featured: argv.includes('--featured'),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms: number) => ms * (0.5 + Math.random());

function pickRandom<T>(items: T[]): T | undefined {
  return items[Math.floor(Math.random() * items.length)];
}

/** One poll step for a player bot: act if the phase asks for it. */
async function botStep(bot: MafiaClient, view: Projection): Promise<void> {
  const you = view.you;
  if (!you || !you.alive || you.spectator) return;

  if (view.phase === 'NIGHT' && you.role && you.role !== 'VILLAGER' && !you.nightTarget) {
    const teammates = new Set((view.mafia?.teammates ?? []).map((t) => t.id));
    const candidates = view.players.filter((p) => {
      if (!p.alive) return false;
      if (p.id === you.id) return you.role === 'DOCTOR';
      if (you.role === 'MAFIA' && teammates.has(p.id)) return false;
      return true;
    });
    const target = pickRandom(candidates);
    if (target) {
      await bot.call('submit_night_action', { room: view.room, target_player_id: target.id });
    }
    return;
  }

  if (view.phase === 'DAY_VOTE' && !you.vote) {
    if (Math.random() < 0.08) {
      await bot.call('cast_vote', { room: view.room, target_player_id: 'abstain' });
      return;
    }
    const living = view.players.filter((p) => p.alive && p.id !== you.id);
    // Bandwagon: mostly pile onto the current leader, sometimes go rogue.
    const leader = view.vote?.tally?.[0];
    const target =
      leader && leader.targetId !== you.id && Math.random() < 0.6
        ? living.find((p) => p.id === leader.targetId)
        : pickRandom(living);
    if (target) {
      await bot.call('cast_vote', { room: view.room, target_player_id: target.id });
    }
  }
}

async function runBot(args: Args, index: number, room: string): Promise<void> {
  const name = `Bot ${String(index).padStart(2, '0')}`;
  const bot = new MafiaClient(args.url, name);
  await bot.connect();
  const joined = await bot.call('join_room', { room, name });
  if (joined.isError) {
    console.error(`${name} could not join: ${joined.text}`);
    await bot.close();
    return;
  }
  for (;;) {
    await sleep(jitter(args.pollMs));
    try {
      const view = await bot.state();
      if (view.phase === 'ENDED') break;
      await botStep(bot, view);
    } catch (err) {
      console.error(`${name}: ${(err as Error).message}`);
    }
  }
  await bot.close();
}

/** Bot moderator that drives a complete game with paced advances. */
async function runSmoke(args: Args): Promise<void> {
  const mod = new MafiaClient(args.url, 'smoke-mod');
  await mod.connect();
  const created = await mod.must('create_room', { name: 'Smoke Moderator', featured: args.featured });
  const room = created.projection!.room;
  console.log(`smoke: room ${room}, seating ${args.bots} bots...`);

  const bots = Array.from({ length: args.bots }, (_, i) => runBot({ ...args, pollMs: 1500 }, i + 1, room));

  // Wait for everyone to be seated, then deal.
  for (;;) {
    await sleep(1000);
    const view = await mod.state();
    if (view.lobbyCount >= args.bots + 1) break;
  }
  await mod.must('start_game', { room });
  console.log('smoke: game started');

  const paceMs: Record<string, number> = {
    NIGHT: 6000,
    DAWN: 1500,
    DAY_DISCUSSION: 2500,
    DAY_VOTE: 7000,
    DUSK: 1500,
  };
  for (;;) {
    const view = await mod.state();
    if (view.phase === 'ENDED') {
      console.log(`smoke: ${view.winner} wins after round ${view.round}. Narration tail:`);
      for (const n of view.narration.slice(-3)) console.log(`  ${n.text}`);
      break;
    }
    await sleep(paceMs[view.phase] ?? 2000);
    const advanced = await mod.call('advance_phase', { room });
    if (advanced.isError) console.error(`smoke: advance failed: ${advanced.text}`);
    else console.log(`smoke: -> ${advanced.projection!.phase} (${advanced.projection!.aliveCount} alive)`);
  }

  await Promise.allSettled(bots);
  await mod.close();
  console.log('smoke: done');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.smoke) {
    await runSmoke(args);
    return;
  }
  if (!args.join) {
    console.error('need --join CODE (or --smoke N). See file header for usage.');
    process.exit(1);
  }
  console.log(`audience: ${args.bots} bots joining ${args.join} at ${args.url}`);
  await Promise.allSettled(
    Array.from({ length: args.bots }, (_, i) => runBot(args, i + 1, args.join!)),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
