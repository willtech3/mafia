import type { Projection } from '../game/view.js';

/**
 * A plain-text rendering of a projection, for the tool result's `content`.
 *
 * Hosts disagree about which half of a tool result the MODEL gets to read:
 * some show it only `content` text (claude.ai), some only `structuredContent`
 * (Claude Code and the Agent SDK). So each half has to stand on its own. A
 * model that reads only the text must still be able to tell its player their
 * role, who is alive, what just happened, and whom they can name as a target
 * — otherwise it can only say "look at the panel", or worse, guess.
 *
 * Built ONLY from the projection (i.e. after viewFor's redaction), never from
 * RoomState, so it cannot reveal anything structuredContent does not already.
 */

const ROLE_LABEL: Record<string, string> = {
  MAFIA: 'Mafia',
  DOCTOR: 'Doctor',
  DETECTIVE: 'Detective',
  VILLAGER: 'Villager',
};

const CAUSE_LABEL: Record<string, string> = {
  MAFIA: 'killed at night',
  BANISHED: 'banished',
  KICKED: 'removed',
};

function role(r: string): string {
  return ROLE_LABEL[r] ?? r;
}

export function describeProjection(p: Projection): string[] {
  const lines: string[] = [];

  const latest = p.narration.at(-1);
  if (latest) lines.push(`Latest narration: ${latest.text}`);

  const you = p.you;
  if (!you) {
    lines.push('You: not seated — this is the public view.');
  } else {
    const bits: string[] = [];
    if (you.spectator) bits.push('watching as a spectator');
    else if (you.role) bits.push(`your secret role is ${role(you.role).toUpperCase()}`, you.alive ? 'alive' : 'dead');
    else bits.push('seated, no role dealt yet');
    if (you.isModerator) bits.push('you are the moderator');
    lines.push(`You: ${you.name} — ${bits.join(', ')}`);
  }

  if (p.phase === 'LOBBY') {
    const watching = p.spectatorCount > 0 ? ` (+${p.spectatorCount} watching)` : '';
    lines.push(`In the lobby (${p.players.length})${watching}: ${p.players.map((t) => t.name).join(', ')}`);
  } else {
    const alive = p.players.filter((t) => t.alive);
    const out = p.players.filter((t) => !t.alive);
    lines.push(`Alive (${alive.length}): ${alive.map((t) => t.name).join(', ') || 'nobody'}`);
    if (out.length > 0) {
      const described = out.map((t) => {
        const detail = [t.role ? role(t.role) : null, t.cause ? CAUSE_LABEL[t.cause] : null].filter(Boolean).join(', ');
        return detail ? `${t.name} (${detail})` : t.name;
      });
      lines.push(`Out (${out.length}): ${described.join(', ')}`);
    }
  }

  if (p.mafia) {
    const mates = p.mafia.teammates.map((m) => (m.alive ? m.name : `${m.name} (dead)`));
    lines.push(
      `Private — your fellow mafia: ${mates.join(', ') || 'none, you work alone'}. The family makes ${p.mafia.killsTonight} kill${p.mafia.killsTonight === 1 ? '' : 's'} per night.`,
    );
    if (p.mafia.tally.length > 0) {
      lines.push(`Private — family marks so far: ${p.mafia.tally.map((t) => `${t.targetName} ×${t.count}`).join(', ')}`);
    }
  }
  if (p.detective && p.detective.results.length > 0) {
    lines.push(
      `Private — your investigations: ${p.detective.results.map((r) => `Night ${r.round}: ${r.targetName} is ${r.result}`).join('; ')}`,
    );
  }
  if (you?.nightTarget) lines.push(`Private — your night target: ${you.nightTarget.name} (changeable until dawn)`);

  if (p.nightProgress) {
    lines.push(`Night actions in: ${p.nightProgress.submitted} of ${p.nightProgress.total}`);
  }

  if (p.vote) {
    const tally = p.vote.tally.map((t) => `${t.targetName} ${t.count}`).join(', ') || 'no votes against anyone';
    const abstains = p.vote.abstains > 0 ? `; ${p.vote.abstains} abstaining` : '';
    lines.push(`Votes so far: ${tally}${abstains} (${p.vote.votesCast} of ${p.vote.aliveCount} have voted)`);
    if (you?.vote) lines.push(`Your vote: ${you.vote.targetId === 'ABSTAIN' ? 'abstain' : (you.vote.targetName ?? '?')}`);
  }

  if (p.reveal) {
    lines.push(`All roles${p.phase === 'ENDED' ? '' : ' (you can see them because you are out)'}: ${p.reveal.players.map((r) => `${r.name} ${role(r.role)}`).join(', ')}`);
  }

  return lines;
}
