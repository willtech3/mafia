import { MafiaClient } from './client.js';
import type { Projection } from '../game/view.js';

/**
 * Staging reliability drills — run against the REAL deployment:
 *
 *   tsx src/bots/drill.ts --url https://.../mcp burst     # 80-seat burst vote, zero lost votes
 *   tsx src/bots/drill.ts --url https://.../mcp soak      # sustained autopoll while a game runs
 *   tsx src/bots/drill.ts --url https://.../mcp killgame  # full game meant to span a revision kill
 *
 * Exit code 0 only if every assertion holds.
 */

const SEATS = Number(argOf('--seats') ?? 80);

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const URL_ = argOf('--url') ?? 'http://localhost:8080/mcp';
const MODE = process.argv.find((a) => ['burst', 'soak', 'killgame'].includes(a)) ?? 'burst';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function seatRoom(n: number): Promise<{ mod: MafiaClient; bots: MafiaClient[]; code: string }> {
  const mod = new MafiaClient(URL_, 'drill-mod');
  await mod.connect();
  const created = await mod.must('create_room', { name: 'Drill Moderator', featured: false });
  const code = created.projection!.room;
  console.log(`room ${code}: seating ${n - 1} bots...`);
  const bots: MafiaClient[] = [];
  // Join in waves of 10 to be polite to the connection pool, not the server.
  for (let wave = 0; wave < Math.ceil((n - 1) / 10); wave++) {
    const batch = Array.from({ length: Math.min(10, n - 1 - wave * 10) }, (_, k) => {
      const idx = wave * 10 + k + 1;
      return (async () => {
        const bot = new MafiaClient(URL_, `D${idx}`);
        await bot.connect();
        await bot.must('join_room', { room: code, name: `Drill ${String(idx).padStart(2, '0')}` });
        bots.push(bot);
      })();
    });
    await Promise.all(batch);
  }
  const state = await mod.state();
  assert(state.lobbyCount === n, `lobby has ${state.lobbyCount}, expected ${n}`);
  return { mod, bots, code };
}

function assert(cond: boolean, message: string): void {
  if (!cond) {
    console.error(`ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`ok: ${message}`);
}

async function toVotePhase(mod: MafiaClient, code: string): Promise<void> {
  await mod.must('start_game', { room: code });
  await mod.must('advance_phase', { room: code }); // NIGHT -> DAWN (no actions)
  await mod.must('advance_phase', { room: code }); // -> DAY_DISCUSSION
  await mod.must('advance_phase', { room: code }); // -> DAY_VOTE
}

/** All seats vote inside a ~5 second window; zero may be lost. */
async function burst(): Promise<void> {
  const { mod, bots, code } = await seatRoom(SEATS);
  await toVotePhase(mod, code);
  const view = await mod.state();
  const living = view.players.filter((p) => p.alive);
  console.log(`burst: ${living.length} living players voting concurrently...`);

  const everyone = [mod, ...bots];
  const t0 = Date.now();
  const results = await Promise.all(
    everyone.map((client, i) =>
      client
        .call('cast_vote', { room: code, target_player_id: living[(i + 1) % living.length]!.id })
        .then((r) => ({ ok: !r.isError, text: r.text }))
        .catch((err) => ({ ok: false, text: String(err) })),
    ),
  );
  const elapsed = Date.now() - t0;
  const failed = results.filter((r) => !r.ok);
  for (const f of failed.slice(0, 5)) console.error('vote failed:', f.text);

  const after = await mod.state();
  console.log(`burst: ${elapsed}ms for ${everyone.length} votes; votesCast=${after.vote?.votesCast}`);
  assert(failed.length === 0, `all ${everyone.length} votes accepted`);
  assert(after.vote?.votesCast === everyone.length, `zero lost votes (${after.vote?.votesCast}/${everyone.length})`);
  assert(elapsed < 30_000, `burst completed in ${elapsed}ms`);
  await teardown(mod, bots, code);
}

/** Everyone autopolls every ~3s for a minute while votes trickle in. */
async function soak(): Promise<void> {
  const { mod, bots, code } = await seatRoom(SEATS);
  await toVotePhase(mod, code);
  const everyone = [mod, ...bots];
  const view = await mod.state();
  const living = view.players.filter((p) => p.alive);

  console.log('soak: 60s of polling + vote churn...');
  let polls = 0;
  let pollErrors = 0;
  const stopAt = Date.now() + 60_000;
  await Promise.all(
    everyone.map(async (client, i) => {
      while (Date.now() < stopAt) {
        try {
          const s = await client.state();
          polls++;
          if (Math.random() < 0.15 && s.you?.alive) {
            await client.call('cast_vote', { room: code, target_player_id: living[Math.floor(Math.random() * living.length)]!.id });
          }
        } catch {
          pollErrors++;
        }
        await sleep(2000 + Math.random() * 2000);
      }
    }),
  );
  console.log(`soak: ${polls} polls, ${pollErrors} errors`);
  assert(pollErrors === 0, `zero poll errors across ${polls} polls`);
  await teardown(mod, bots, code);
}

/**
 * Full bot game paced slowly enough to survive a mid-game revision rollout.
 * Run `gcloud run services update ... --update-env-vars DRILL=x` while this
 * runs; the game must complete anyway and report every instance id seen.
 */
async function killgame(): Promise<void> {
  const { mod, bots, code } = await seatRoom(SEATS);
  await mod.must('start_game', { room: code });
  console.log(`killgame: room ${code} started — kill an instance / roll a revision NOW.`);
  console.log('killgame: pacing one full phase cycle every ~12s until the game ends.');

  const t0 = Date.now();
  const pace: Record<string, number> = { NIGHT: 6000, DAWN: 1500, DAY_DISCUSSION: 1500, DAY_VOTE: 6000, DUSK: 1500 };
  for (;;) {
    const view: Projection = await mod.state();
    if (view.phase === 'ENDED') {
      console.log(`killgame: ${view.winner} wins after round ${view.round}, ${Math.round((Date.now() - t0) / 1000)}s`);
      break;
    }
    if (Date.now() - t0 > 15 * 60_000) {
      assert(false, 'game finished within 15 minutes');
    }
    // Bots act like the audience harness: night actions + votes.
    await Promise.all(
      [mod, ...bots].map(async (client) => {
        try {
          const s = await client.state();
          const you = s.you;
          if (!you?.alive) return;
          if (s.phase === 'NIGHT' && you.role && you.role !== 'VILLAGER' && !you.nightTarget) {
            const targets = s.players.filter((p) => p.alive && (p.id !== you.id || you.role === 'DOCTOR'));
            const t = targets[Math.floor(Math.random() * targets.length)];
            if (t) await client.call('submit_night_action', { room: code, target_player_id: t.id });
          } else if (s.phase === 'DAY_VOTE' && !you.vote) {
            const targets = s.players.filter((p) => p.alive && p.id !== you.id);
            const t = targets[Math.floor(Math.random() * targets.length)];
            if (t) await client.call('cast_vote', { room: code, target_player_id: t.id });
          }
        } catch {
          /* transient errors are the point of the drill; state() retries next loop */
        }
      }),
    );
    await sleep(pace[view.phase] ?? 2000);
    const adv = await mod.call('advance_phase', { room: code });
    if (adv.isError) console.log(`advance deferred: ${adv.text}`);
    else console.log(`-> ${adv.projection!.phase} (${adv.projection!.aliveCount} alive)`);
  }
  await teardown(mod, bots, code);
}

async function teardown(mod: MafiaClient, bots: MafiaClient[], code: string): Promise<void> {
  console.log(`drill on ${code} complete.`);
  await Promise.allSettled([mod, ...bots].map((c) => c.close()));
}

const runners: Record<string, () => Promise<void>> = { burst, soak, killgame };
runners[MODE]!()
  .then(() => {
    console.log('DRILL PASSED');
    process.exit(0);
  })
  .catch((err) => {
    console.error('DRILL FAILED', err);
    process.exit(1);
  });
