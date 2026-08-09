import type { DeathRecord, Faction, Role } from './types.js';
import { pick, rngFrom } from './rng.js';

/**
 * Server-generated narration: deterministic templates with light seeded
 * variation. This text is the authoritative account of events — the model
 * may embellish tone but never facts. Keep names and roles exact.
 */

const ROLE_LABEL: Record<Role, string> = {
  MAFIA: 'Mafia',
  DOCTOR: 'the Doctor',
  DETECTIVE: 'a Detective',
  VILLAGER: 'a Villager',
};

const START_TEMPLATES = [
  'Lanterns gutter out one by one. The village of {code} sleeps — but not everyone dreams. Night 1 begins.',
  'The church bell tolls once. Shutters close across {code}. Somewhere in the dark, plans are being made. Night 1 begins.',
  'A cold wind snuffs the last candle in {code}. The first night falls.',
];

const KILL_TEMPLATES = [
  '{name} was found at first light by the old well. They were {role}.',
  'The morning fog lifts to reveal {name}, cold and still. They were {role}.',
  '{name} never answered their door this morning. They were {role}.',
  'A scream at dawn — {name} is gone. They were {role}.',
];

const NO_DEATH_TEMPLATES = [
  'Dawn breaks, and against all odds, every villager answers the morning bell. No one died last night.',
  'The sun rises on an unharmed village. Not a soul was lost in the night.',
];

const SAVE_TEMPLATES_ONE = [
  'Bandages in the gutter, a door left ajar — a doctor foiled an attack in the night.',
  'There was blood on someone’s doorstep this morning, but no body. A doctor was faster than the knife.',
];

const SAVE_TEMPLATES_MANY = [
  'It was a long night for the doctors — {n} attacks were foiled before sunrise.',
  'Steady hands were busy in the dark: {n} lives were quietly saved tonight.',
];

const BANISH_TEMPLATES = [
  'The town has spoken. {name} is dragged to the gates and cast out — they were {role}.',
  'By a show of hands, {name} is banished from the village. They were {role}.',
  'The vote falls hard on {name}. As they leave, the truth comes out: they were {role}.',
];

const TIE_TEMPLATES = [
  'The vote is deadlocked. Fingers point in every direction, and in the end, no one is banished.',
  'Shouting, accusations, chaos — but no agreement. The town banishes no one today.',
];

const NO_VOTE_TEMPLATES = [
  'The square falls silent. Nobody could bring themselves to point a finger. No one is banished.',
];

const KICK_TEMPLATES = [
  '{name} has wandered off into the woods and is out of the game. They were {role}.',
  '{name} left the village abruptly. They were {role}.',
];

const KICK_LOBBY_TEMPLATES = ['{name} was shown out of the lobby by the moderator.'];

const MAFIA_WIN_TEMPLATES = [
  'When the villagers wake, the town hall is already draped in black. The village belongs to the Mafia now — the Mafia win.',
  'Too few remain to resist. The Mafia step out of the shadows and take the village. The Mafia win.',
];

const TOWN_WIN_TEMPLATES = [
  'The last conspirator is unmasked. Bells ring across the village — the Town wins!',
  'With the final Mafia member exposed, peace returns at last. The Town wins!',
];

function fillRole(template: string, name: string, role: Role): string {
  return template.replaceAll('{name}', name).replaceAll('{role}', ROLE_LABEL[role]);
}

export function narrateStart(seed: string, code: string): string {
  return pick(START_TEMPLATES, rngFrom(seed, 'start')).replaceAll('{code}', code);
}

export function narrateDawn(
  seed: string,
  round: number,
  killed: readonly DeathRecord[],
  savedCount: number,
): string {
  const rand = rngFrom(seed, 'dawn', round);
  const parts: string[] = [];
  if (killed.length === 0) {
    parts.push(pick(NO_DEATH_TEMPLATES, rand));
  } else {
    for (const d of killed) {
      parts.push(fillRole(pick(KILL_TEMPLATES, rand), d.name, d.role));
    }
  }
  if (savedCount === 1) {
    parts.push(pick(SAVE_TEMPLATES_ONE, rand));
  } else if (savedCount > 1) {
    parts.push(pick(SAVE_TEMPLATES_MANY, rand).replaceAll('{n}', String(savedCount)));
  }
  return parts.join(' ');
}

export function narrateDusk(seed: string, round: number, banished: DeathRecord | null, tie: boolean): string {
  const rand = rngFrom(seed, 'dusk', round);
  if (banished) return fillRole(pick(BANISH_TEMPLATES, rand), banished.name, banished.role);
  return pick(tie ? TIE_TEMPLATES : NO_VOTE_TEMPLATES, rand);
}

export function narrateKick(seed: string, round: number, name: string, role: Role | null): string {
  const rand = rngFrom(seed, 'kick', round, name);
  if (role === null) return pick(KICK_LOBBY_TEMPLATES, rand).replaceAll('{name}', name);
  return fillRole(pick(KICK_TEMPLATES, rand), name, role);
}

export function narrateWin(seed: string, winner: Faction): string {
  const rand = rngFrom(seed, 'win');
  return pick(winner === 'MAFIA' ? MAFIA_WIN_TEMPLATES : TOWN_WIN_TEMPLATES, rand);
}
