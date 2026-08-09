# MAFIA — Demo Runbook

The talk: 80 people, laptops open, each connected to the game through their
own ChatGPT. One projector. Three protocol beats: **MCP Apps**, **elicitation
with graceful fallback**, and **stateless serverless** (we kill the server
mid-game and nobody notices).

---

## 1 · The join slide (show this on screen)

> ## 🏮 Join the village
> 1. Open **ChatGPT** (chatgpt.com — laptop browser)
> 2. Say: **“take me to the mafia game — I’m 〈your first name〉”**
> 3. When ChatGPT asks to use **Mafia**, click **Connect**, then **Always allow**
> 4. Your secret role appears when the game starts. **Tap the card. Tell no one.**
>
> Room code (if asked): **the 4 big letters on this screen** →

Notes for the host:
- The app must already be published to the workspace and enabled for the
  audience group (see README → Publish). Players then find it by name.
- The **“Always allow”** click matters: it stops per-vote confirmation
  prompts. The confirmation card calls the seat key an "Authentication
  secret" — that's ChatGPT's wording for the player token; it's just their
  seat in this room.
- Anyone on Claude instead: Settings → Connectors → the Mafia connector →
  same phrase. (Claude renders the app on phones, too.)

## 2 · Pre-show warmup (T-30 minutes)

```bash
# 1. instances warm + who's serving
curl -s https://<service-url>/health

# 2. full bot smoke game against production — MUST end with DRILL PASSED
npx tsx src/bots/drill.ts --url https://<service-url>/mcp killgame --seats 12

# 3. burst check — 80 votes, zero lost
npx tsx src/bots/drill.ts --url https://<service-url>/mcp burst

# 4. moderator dry run in ChatGPT: create a room, start with bots, bring one
#    dawn, reset. Confirm "Always allow" is set on YOUR account.
npx tsx src/bots/audience.ts --url https://<service-url>/mcp --join <CODE> --bots 6
```

- Projector: open `https://<service-url>/room/<CODE>/board` full-screen,
  after creating the room. F11. Dark stage lighting flatters it.
- Have one phone with Claude + the connector as the mobile fallback demo.
- Keep `gcloud` authenticated for the kill drill (beat 4).

## 3 · On-stage beats

**Beat 0 — Everyone joins (≤ 2 min).** Show the join slide. Create the room
from your ChatGPT: "create a mafia room" → the code lands on the projector
automatically (open the board URL with that code). The lobby fills live on
the projector as people join. Bots on standby if attendance is thin:
`npx tsx src/bots/audience.ts --join <CODE> --bots N`.

**Beat 1 — The role card (MCP Apps).** "start the game." Every laptop now
shows the same tool result rendered differently — that's per-viewer
redaction. Ask the room: "tap your card. If you're mafia... smile normally."
The projector shows only the public board: same server, same tool, three
different views (player / mafia / projector).

**Beat 2 — Night one, two paths (elicitation + fallback).** Night roles act
by tapping the board — or by asking their assistant with no target
("submit my night action"), which raises a **private elicitation picker** in
ChatGPT. Point out both paths land on the same validated write, and clients
without elicitation get taught the tap path — capability negotiation with
graceful degradation.

**Beat 3 — Dawn.** "bring the dawn." Read the narration off the projector
in your best campfire voice. Roles of the dead are public — drama by design.

**Beat 4 — Kill the server (statelessness).** Mid-night-two, on the visible
terminal:

```bash
gcloud run services update mafia-staging --region us-central1 \
  --update-env-vars DRILL_TS=$(date +%s)
```

Every instance is replaced. The projector keeps streaming, votes keep
landing, nobody's role blinks. Explain: zero session state — any replica
serves any request; the game lives in Firestore, reads are projections,
writes are transactions.

**Beat 5 — The vote.** Open voting. The projector's tally bars move live as
80 people tap. Close it. Read the banishment. Repeat night/day once more if
time allows — mafia kills scale (K = alive_mafia/4) so an 80-person room
loses people fast enough to feel dangerous.

**Beat 6 — Victory screen** (or call the game at a cliffhanger and
`reset_room` for the hallway crowd).

## 4 · If something goes sideways

| Symptom | Move |
|---|---|
| A player's chat lost its token / connector wedged | New chat → "rejoin room CODE as 〈exact name〉" — the seat comes back |
| Player says "it says I can't act" | They're dead, or wrong phase — the error text says which; Refresh in the app |
| Moderator chat dies | Any new chat: "join room CODE as 〈moderator name〉" — moderator seat reclaims by exact name |
| ChatGPT connector misbehaves workspace-wide | Claude custom connector is the standby client; the game is fully playable by text |
| Projector board frozen | It reconnects automatically; hard-refresh the browser tab if not |
| Room polluted / wrong state | `reset_room` (same crowd, fresh deal) or create a fresh room |

Deleted/stale rooms clean themselves up (48 h TTL).
