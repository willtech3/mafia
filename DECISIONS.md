# DECISIONS

Every place where reality differed from the project brief, plus judgment calls.
Updated through Milestone 1 (2026-08-09).

## Protocol reality (verified against official sources, 2026-08-09)

1. **The 2026-07-28 MCP revision is real but unshippable today.** It exists as
   described (stateless core, no initialize handshake, no `Mcp-Session-Id`,
   MRTR-based elicitation via `resultType: "input_required"` + `requestState`,
   mandatory `server/discover`). However: the TypeScript SDK v1 line
   (1.30.0, latest on npm) tops out at protocol **2025-11-25**, the MCP Apps
   helper package `@modelcontextprotocol/ext-apps` (1.7.5) peer-depends on the
   v1 SDK, and neither ChatGPT nor Claude speaks 2026-07-28 yet (Claude's
   connector docs support auth specs through 2025-11-25; ChatGPT's docs still
   reference the 2025-06-18 initialize lifecycle). **Decision: target the
   2025-11-25 era on SDK 1.30.0 + ext-apps 1.7.5.** The stateless architecture
   is unaffected — we simply never mint a session id. MRTR/`requestState` is
   the future migration target, not the shipping design.
   - Corollary: server `instructions` live on the initialize response in this
     era (the brief was right for the era we ship; in 2026-07-28 they move to
     `server/discover`).

2. **SDK v2 exists** (`@modelcontextprotocol/server` / `@modelcontextprotocol/client`,
   Standard Schema instead of zod shapes) and implements 2026-07-28. Not used:
   ext-apps (required for MCP Apps in M2) targets the v1 line. Revisit only if
   clients adopt 2026-07-28 before the conference.

3. **"Apps SDK" is now the "Plugins" docs** at developers.openai.com/plugins.
   ChatGPT natively supports the open MCP Apps standard (`_meta.ui.resourceUri`,
   `ui://` resources, mimeType `text/html;profile=mcp-app`);
   `openai/outputTemplate` and `window.openai` survive as compatibility
   aliases. The ext-apps `registerAppTool`/`registerAppResource` helpers emit
   metadata for both ChatGPT and Claude — M2 builds on those.

4. **Claude custom connectors do NOT support elicitation** (official supported
   features: tools, prompts, resources only). ChatGPT documents elicitation as
   supported. **Decision: elicitation is a ChatGPT-only progressive
   enhancement (M3), gated on `getClientCapabilities()?.elicitation?.form`;
   the app tap path is the primary input for everything.** This matches the
   brief's fallback requirement — it's just mandatory rather than optional on
   Claude. Two extra constraints for M3: elicitation only flows in SSE
   response mode (not `enableJsonResponse`), and mid-call elicitation from a
   stateless multi-replica deployment has an unresolved response-routing risk
   (the elicitation response POST may land on a different replica than the one
   holding the pending promise). M3 will test on a single instance first; if
   it breaks across replicas, elicitation stays a single-instance demo beat or
   is dropped — the game does not depend on it.

5. **ChatGPT MCP Apps render on web only (no mobile).** Confirmed with the
   user: the audience is laptops at a tech talk, so this is a non-issue.
   Claude renders MCP Apps on iOS/Android too, which remains the tested
   phone fallback.

6. **ChatGPT write actions are a Business/Enterprise/Edu beta** (Pro gets
   read/fetch only in developer mode). The planned enterprise workspace is the
   right vehicle. Also: publishing to a workspace freezes a tool-schema
   snapshot that only an admin refresh updates — **keep the connector in
   developer-mode drafts until M4 freeze.** Agent mode won't use custom apps.

7. **No published per-user MCP rate limits** on either client. Relevant hard
   limits: Claude caps tool results ~150k chars (our 80-player projection is
   ~8KB) and 300s timeouts. Anthropic egress range 160.79.104.0/21 if IP
   allowlisting ever matters.

8. **"SCIM group" gating is not what OpenAI documents** — Enterprise/Edu
   admins gate apps to *groups* via RBAC ("Configure Access"); whether those
   groups are SCIM-synced is an org detail, not an API concept. The publish
   flow in M4 docs will say "enable for the target group."

## Architecture judgment calls

9. **Identity without sessions.** Stateless streamable HTTP means no session
   ids ever, so anonymous identity cannot ride the transport. Resolution
   order: OAuth subject (M3) → `Authorization: Bearer <player-token>` (bots,
   Inspector, load tests) → **optional `player_token` argument on tools** —
   this last one is the only channel available to no-auth interactive clients,
   and is a deliberate deviation from "implement exactly these tools."
   join_room/create_room mint an HMAC-signed token (verifiable on any replica,
   no store lookup); server instructions tell the model to pass it back, and
   the M2 app will embed it in tool calls from the board. Trade-off: the token
   transits the model's context. Accepted: it's a low-stakes party-game seat
   key, scoped to one room, and OAuth replaces it in production.

10. **Reconnect = rejoin by name.** If a no-auth player loses their token
    (new chat), `join_room` with the same display name hands back that seat.
    This means names are claimable in no-auth mode (seat stealing). Accepted
    for dev/testing; OAuth mode (M3) binds seats to stable subjects instead.

11. **Firestore layout & contention.** `rooms/{code}` (core, written only by
    moderator ops), `rooms/{code}/players/{pid}` (join-time), and
    `rooms/{code}/actions/{pid}` (votes and night actions, one doc per player,
    tagged `generation:round:N|V` so stale docs are inert without deletes).
    Player-action transactions read ONLY the core doc + involved player docs
    and write only the caller's action doc — concurrent votes touch disjoint
    docs and never invalidate each other (verified: 80-vote burst, zero lost,
    memory + emulator). Kill tie-breaks ("most recent submission") use
    Firestore commit micros as the authoritative `seq`; `stateVersion` =
    max updateTime micros across room docs (monotonic per room modulo
    Firestore clock, which is TrueTime-backed).

12. **Phases.** DAWN and DUSK are real, moderator-paced phases (dramatic
    beats), resolution happens on the advance *into* them, win-check on the
    advance *out*. "Majority is eliminated" is implemented as **plurality of
    votes cast** (top count; tie → nobody), because a strict >50% rule stalls
    80-person rooms. Kick runs an immediate win-check (kicking the last mafia
    should not require a full day cycle to end the game).

13. **Moderator is also a player** (dealt a role). If they die they keep
    moderating — dead moderators see everything (spectator perk) and still
    advance phases. Kicking yourself is blocked.

14. **Doctor saves are announced without naming the target** ("a doctor foiled
    an attack") — drama without leaking the doctor's choice.

15. **Late-join spectators get the PUBLIC view only** while a game runs. The
    brief gives dead players full omniscience (implemented) but late joiners
    never earned it by dying, and they're standing in the same room as
    the players; they get the reveal at game end. Lobby overflow past 80 also
    becomes a spectator instead of an error.

16. **Narration seeds.** All randomness (role deal, narration variation) comes
    from a per-room seed; reset issues a fresh seed so a rematch gets a fresh
    deal. The reducer is 100% pure — time, seq, and seeds arrive in events.

## Stack & ops

17. **Node 24 locally, Node 22 in the container** (engines >=22). No code
    differences observed.

18. **zod pinned to v3.25+** (SDK 1.30.0 peer-accepts `^3.25 || ^4`).

19. **Google Frontend reserves `/healthz` on run.app domains** and never
    forwards it to the container (legacy convention). Health endpoint is
    `/health`.

20. **Deployment is Terraform + GitHub Actions only** (user directive:
    no click-ops). The very first staging deploy was imperative
    (`gcloud run deploy`) to prove the pipe fast; it is recorded here, was
    immediately imported into Terraform (`infra/imports.tf`), and every
    subsequent deploy flows through `.github/workflows/deploy.yml`
    (build+push image → `terraform apply`). CI authenticates via Workload
    Identity Federation — no service-account keys. One wrinkle hit on the
    way: new-style GCP projects don't grant the default compute SA Cloud
    Build permissions, so `gcloud run deploy --source` failed; moot under
    the final docker-build-in-CI design.

21. **Staging lives in project `virtual-library-mcp`** (the only configured
    gcloud project on this machine). Collections are distinct (`rooms/*`),
    but a dedicated project is recommended before the conference —
    the Terraform stack re-points with one variable.

22. **`min-instances=2`** as specified (kill-drill realism + no cold starts).
    Note: this bills ~2 idle instances 24/7 until torn down.

23. **Room lifecycle:** rooms carry `expiresAt` (+48h, refreshed on write);
    Firestore TTL policies (Terraform-managed) garbage-collect stale rooms.
    TTL is cleanup, not game logic.

24. **In-memory store mirrors the document semantics exactly** (same
    core/player/action doc model, same merge rules) so the contract suite and
    statelessness tests exercise production semantics without the emulator.

## Real-ChatGPT findings (M1 e2e session, 2026-08-09, ChatGPT Pro web)

27. **The full loop works in real ChatGPT web against staging**: "take me to
    the mafia game" → blind join_room → teaching error (no lobby) → the model
    self-corrected to create_room → shared code → start_game with 6 bots →
    private role reveal → night (bot mafia killed the human!) → advance →
    dawn narration relayed with dramatic flair but exact facts →
    dead-moderator flow worked. Write tools executed fine on this Pro
    account despite docs saying full MCP writes are a Business+/Enterprise
    beta — treat as rollout variance, still plan on Enterprise for the talk.

28. **ChatGPT labels `player_token` an "Authentication secret"** in the write
    confirmation card ("Sharing data includes: Authentication secret —
    player token"). Harmless but scary-sounding; the runbook will tell
    players to hit "Always allow" once. OAuth (M3) removes tokens and the
    wording entirely.

29. **Dev-mode connector bindings are conversation-fragile**: clicking
    "Always allow" mid-call produced a spurious "Resource not found" and the
    connector then showed as disabled *for that conversation* (server logs:
    all 200s, nothing wrong server-side). Recovery that provably works: new
    chat + `join_room` with your exact display name to reclaim the seat.
    Demo insurance: moderator should set "Always allow" on advance_phase
    BEFORE the show, in a warm conversation.

30. **The model names players from its own memory** — it created the room as
    "Will" (from ChatGPT's stored user profile), so a later "rejoin as The
    Moderator" made a spectator instead of reclaiming. Fine once understood
    (rejoin with the exact original name), but M2's app should display "You
    are: <name>" prominently so players always know their seat name.

## M2 findings (app live in real ChatGPT, 2026-08-09)

31. **The full M2 loop was verified in production ChatGPT web**, driven both
    by automation and by Will playing an entire 7-seat game to a Town win
    through the app alone: lobby → in-app Start → card-flip role reveal →
    night board → in-app dawn → death/role reveal → discussion → tap-to-vote
    with confirm sheet → dusk → victory screen with full unmasking. Widget-
    initiated tool calls (start_game, advance_phase, cast_vote) execute
    through the bridge without chat round-trips.

32. **ChatGPT dev-mode tool scans are frozen per connector instance** —
    after adding `_meta.ui` the app did not render until the connector was
    recreated (disconnect deletes it; the old name stays reserved, hence the
    staging connector is called "Mafia Game"). Expect a scan refresh (or
    admin refresh once workspace-published) after every tool-metadata change.

33. **Hints must address the human, not the model.** Moderator hints
    originally read "Use advance_phase to bring the dawn" — imperative
    tool-call phrasing that a model eager to help will happily execute (the
    first live test already showed the model self-driving create_room after
    a failed blind join). All moderator hints now speak to the person ("you
    can bring the dawn from the app"), and server instructions add a hard
    rule: pacing tools only on explicit human request, never chained.

34. Cosmetics fixed from live testing: lobby header showed "❤️ 0" (alive
    counts only exist once roles are dealt) — lobby now shows "🏮 N".
    The app resource weighs ~330 KB (bundled ext-apps SDK); acceptable
    (one-time resources/read, cached by hosts) but a hand-rolled bridge
    could cut it ~10x if ever needed.

## Testing notes

25. Fuzz: 10,000 random full games across n = 5, 6, 7, 12, 40, 80 — all
    invariants hold (one winner, win condition genuinely true, dead never act,
    role conservation, termination well under the phase budget; avg 6.6
    rounds). Under fully random play mafia win ~65% — expected for random
    town behavior, not a balance verdict; per-round drama is tuned by K.

26. The e2e suite drives full games through the real MCP SDK client over
    streamable HTTP against two server instances sharing one store, with every
    call hitting a random instance — the local statelessness drill. Staging
    multi-instance + kill-drill lands in M3.
