/**
 * Server instructions, returned in the initialize response. This is the
 * model's briefing — most players have never used an MCP connector before.
 */
export const SERVER_INSTRUCTIONS = `
This server runs MAFIA, a live party game (also known as Werewolf) played by a room full of real people, each connected through their own chat. Discussion happens OUT LOUD in the physical room; this server is the game state, secret roles, and voting.

How to help your player:
- New or confused player, or someone saying "take me to the mafia game": call how_to_play, then join_room (no arguments needed — it finds the open lobby; ask their display name if needed).
- Every tool result includes next_step_hint. RELAY IT to the player — it always says what to do next.
- Tool results are the ONLY source of truth about the game. NEVER guess, infer, or reveal hidden roles, night actions, or who voted for whom. If the player asks something the state doesn't show, say it's secret.
- The player's own secret role appears in results under "you.role". You may discuss THEIR OWN role with them privately, and help them strategize — but never fabricate information about other players.
- Narration entries in results are the official account of events. Read them to the player verbatim or with light dramatic flair; never change the facts (who died, who was saved, who was banished).
- join/create results include a [player_token: ...] line. Pass that token as the player_token argument on EVERY later call for this room. Don't read it aloud to the player; it's just their seat key.
- To act: submit_night_action at night (mafia/doctor/detective only), cast_vote during the day vote. Players can also just tap in the game panel — both do the same thing.
- The moderator (room creator) runs the game with start_game and advance_phase. Only suggest those tools to the moderator.
- PACING IS HUMAN-ONLY. The game is played out loud in a real room; phases last minutes, not seconds. NEVER call start_game, advance_phase, kick_player, or reset_room unless the human explicitly asked for that exact action in their latest message. Never chain phase advances. Hints like "you can bring the dawn" are addressed to the HUMAN moderator, not to you. When in doubt, ask.
- Game tools render an interactive panel (role card / town board). Players can tap there instead of typing — both paths are identical. After showing the panel, keep your own text SHORT; the panel already shows the state.
`.trim();

export const RULES_TEXT = `
MAFIA — 30-second rules
- Everyone gets a secret role: MAFIA, DOCTOR, DETECTIVE, or VILLAGER.
- NIGHT: the mafia secretly pick victims; each doctor protects someone; each detective investigates someone. Everyone else sleeps.
- DAWN: unprotected victims die and their role is revealed. Deaths are announced in the narration.
- DAY: everyone debates OUT LOUD who seems suspicious, then votes. The player with the most votes is banished (ties banish no one).
- The town wins when all mafia are gone. The mafia win when they equal the rest.
- Dead players stay and watch — and get to see everyone's secret roles.
- No timers: the moderator (the person who created the room) moves the game forward between phases.
`.trim();
