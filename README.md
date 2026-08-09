# MAFIA — an MCP App party game

Mafia (Werewolf) as a remote MCP server for up to **80 players in one room**,
each connected through their own ChatGPT or Claude. Stateless on Cloud Run —
any replica serves any request; killing an instance mid-game is a demo beat,
not an outage.

**Status: feature-complete.** Core loop, MCP App UI (role card, town board,
victory screen), elicitation with cross-replica answer relay, projector
board, OAuth identity, staging drills (80-seat burst, soak, kill-instance)
— all verified against the live deployment and real clients. `DECISIONS.md`
records every divergence and judgment call; `DEMO_RUNBOOK.md` runs the show.

## Layout

```
src/game/     pure rules: reducer, roles, narration, viewFor (redaction)
src/store/    RoomStore interface; memory + Firestore implementations
src/server/   MCP tools, identity, stateless streamable-HTTP wiring (Hono)
src/bots/     scripted MCP clients: synthetic audience + smoke driver
test/         unit, redaction, store contract, e2e-over-HTTP, fuzz
infra/        Terraform: Cloud Run, AR, Secret Manager, WIF for CI, TTLs
```

Architecture rules that everything else obeys:

1. **Zero server-side session state.** Fresh `McpServer` + transport per
   request, no session ids. All state in the room store.
2. **`viewFor(state, playerId)` is the only exit for game state.** Redaction
   bugs are P0; `test/redaction.test.ts` hunts for them.
3. **The model narrates; the server decides.** Tool results carry
   `next_step_hint` and server-generated narration; models are instructed
   never to invent facts.
4. **Every write is validated in a transaction** against the current phase,
   role, and liveness. One action per player per phase, last write wins.

## Local dev

```bash
npm ci
npm test                 # unit + redaction + store contract + e2e + 2k-game fuzz
npm run fuzz             # the full 10,000-game invariant sweep (~2.5 min)

# run the server on the in-memory store
MAFIA_STORE=memory PORT=8080 npx tsx src/server/main.ts

# ...or against the Firestore emulator (Docker):
npm run emulator &                      # port 8899
FIRESTORE_EMULATOR_HOST=localhost:8899 npx tsx src/server/main.ts

# a complete self-driving game (bot moderator + N bots):
npx tsx src/bots/audience.ts --url http://localhost:8080/mcp --smoke 12

# 77 bots joining your room as the audience:
npx tsx src/bots/audience.ts --url http://localhost:8080/mcp --join PLUM --bots 77
```

Firestore emulator tests only run when the emulator env var is set:

```bash
FIRESTORE_EMULATOR_HOST=localhost:8899 npx vitest run test/store.firestore.test.ts
```

## Deploy (Terraform + GitHub Actions — no click-ops)

Pushes to `main` run `.github/workflows/deploy.yml`: build image → push to
Artifact Registry → `terraform apply` → smoke game against the live service.
CI authenticates via Workload Identity Federation (no SA keys). Repo
variables required: `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOYER_SA`
(values are Terraform outputs).

One-time bootstrap from a laptop (already done for staging):

```bash
gcloud storage buckets create gs://virtual-library-mcp-tfstate --location=us-central1 --uniform-bucket-level-access
cd infra && terraform init
terraform apply -target=google_project_service.apis -target=google_artifact_registry_repository.mafia -var image=dummy
docker build --platform linux/amd64 -t <repo>/server:bootstrap . && docker push <repo>/server:bootstrap
terraform apply -var image=<repo>/server:bootstrap
```

Staging: `https://mafia-staging-1022738355193.us-central1.run.app/mcp`
(health: `/health` — note Cloud Run's frontend swallows `/healthz`).

## Connect a client

**MCP Inspector**

```bash
npx @modelcontextprotocol/inspector
```

Transport: Streamable HTTP → URL `<server>/mcp`. Checklist:

- [ ] `initialize` shows server `mafia` with instructions
- [ ] `tools/list` shows exactly 10 tools; `get_state`/`how_to_play` are
      annotated read-only
- [ ] `create_room` returns a code + `player_token` in `structuredContent`
- [ ] Paste the token into `player_token` on `start_game` → needs 5 players
      (error should read like a sentence a player understands)
- [ ] `join_room` with no arguments from a second Inspector tab finds the
      featured room
- [ ] Dead-player and wrong-phase actions come back as teaching errors

**ChatGPT (developer mode)** — Settings → Apps & Connectors → Advanced →
Developer mode (Business/Enterprise/Edu for write tools) → Create app →
URL `<server>/mcp`, auth: none. Then in a chat, enable the connector and say
"take me to the mafia game."

**Claude (custom connector)** — Settings → Connectors → Add custom connector →
URL `<server>/mcp`, no auth. Works on claude.ai web and mobile.

## The projector board

`GET /room/{code}/board` — a self-contained big-screen page (SSE, public
view only): live lobby, narration, vote tally bars, victory splash. This is
the room's shared anchor; put it on the projector.

## Elicitation (ChatGPT)

`submit_night_action` without a target raises a private picker via MCP
elicitation (enum of legal targets). Clients without elicitation (Claude
custom connectors today) get a teaching error pointing at the app's tap
path — two paths, one validated write. Closing a vote that would banish
nobody (tie / no votes) asks the moderator accept/decline the same way.
Answers that land on the wrong replica are relayed through the store —
elicitation survives multi-instance round-robin (tested).

## Playing a game (text-only flow)

1. Moderator: "create a mafia room" → share the 4-letter code out loud.
2. Everyone: "join the mafia game as <name>" (no code needed — featured room).
3. Moderator: `start_game`, then `advance_phase` to pace
   night → dawn → discussion → vote → dusk → night...
4. Night roles act via `submit_night_action`; day votes via `cast_vote`;
   `get_state` refreshes; every result says what to do next.

## Identity

Resolution order per request:
1. **OAuth subject** — `Authorization: Bearer <JWT>` verified against
   `MAFIA_OIDC_ISSUER` / `MAFIA_OIDC_JWKS_URL` / `MAFIA_OIDC_AUDIENCE`.
   Seats bind to the stable subject: reconnects are automatic and names
   can't be stolen. (This is the resource-server half; the authorization
   server / connector OAuth flow is configured against the workspace IdP —
   see DECISIONS.md #35.)
2. **Player token** — `create_room`/`join_room` mint an HMAC-signed
   `player_token`; passed as the tool argument (interactive clients) or as
   `Authorization: Bearer` (bots, Inspector, load tests).
3. Lost token, no SSO: `join_room` with the same name reclaims the seat
   (anonymous seats only — subject-bound seats never reclaim by name).

## Reliability drills (run them against the real deployment)

```bash
npx tsx src/bots/drill.ts --url <server>/mcp burst          # 80 votes ≤5s, zero lost
npx tsx src/bots/drill.ts --url <server>/mcp soak           # 60s autopoll churn, zero errors
npx tsx src/bots/drill.ts --url <server>/mcp killgame       # full game across a revision roll
# mid-killgame, replace every instance:
gcloud run services update mafia-staging --region us-central1 --update-env-vars DRILL_TS=$(date +%s)
```

## Publish

**ChatGPT (Enterprise workspace)** — keep the connector in developer-mode
drafts while iterating (published apps freeze a tool snapshot only admins
refresh). To publish: workspace admin → Settings → Apps → create from the
`/mcp` URL → Scan tools → Create → Publish, then "Configure Access" to the
audience group. Tool schemas are frozen as of v0.3.0 precisely so this scan
never needs a refresh mid-conference.

**Claude (custom connector)** — Settings → Connectors → Add custom
connector → `<server>/mcp`, no auth. Works on web, Desktop, iOS/Android
(apps render on mobile). The board resource carries the Claude sandbox
`ui.domain` derived from `MAFIA_PUBLIC_URL` — set that env var (Terraform)
if the service URL ever changes.
