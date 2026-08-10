import { App } from '@modelcontextprotocol/ext-apps';

/**
 * The Mafia town board, role card, and victory screen. One iframe, three
 * views, switched by the projection in structuredContent. All game writes
 * go through app.callServerTool -> the same validated tools the model uses.
 */

// Lite mirror of the server's Projection (src/game/view.ts).
interface Tile {
  id: string;
  name: string;
  alive: boolean;
  isModerator?: boolean;
  role?: string;
  cause?: string;
  votes?: number;
}
interface Projection {
  room: string;
  phase: 'LOBBY' | 'NIGHT' | 'DAWN' | 'DAY_DISCUSSION' | 'DAY_VOTE' | 'DUSK' | 'ENDED';
  round: number;
  stateVersion: number;
  winner: 'MAFIA' | 'TOWN' | null;
  you: {
    id: string;
    name: string;
    alive: boolean;
    isModerator: boolean;
    spectator: boolean;
    role: string | null;
    nightTarget?: { id: string; name: string };
    vote?: { targetId: string; targetName?: string };
  } | null;
  players: Tile[];
  aliveCount: number;
  seatedCount: number;
  lobbyCount: number;
  spectatorCount: number;
  narration: { round: number; at: string; text: string }[];
  mafia?: {
    teammates: { id: string; name: string; alive: boolean }[];
    killsTonight: number;
    tally: { targetId: string; targetName: string; count: number }[];
  };
  detective?: { results: { targetName: string; result: string; round: number }[] };
  doctor?: { protecting?: { id: string; name: string } };
  vote?: { tally: { targetId: string; targetName: string; count: number }[]; abstains: number; votesCast: number };
  reveal?: { players: { id: string; name: string; role: string; alive: boolean }[] };
  next_step_hint: string;
  player_token?: string;
}

const ROLE_ART: Record<string, { icon: string; cls: string; label: string; flavor: string }> = {
  MAFIA: {
    icon: '🔪',
    cls: 'mafia',
    label: 'Mafia',
    flavor: 'You know the others. They know you. Smile in daylight — and leave no witnesses at night.',
  },
  DOCTOR: {
    icon: '🩺',
    cls: 'doctor',
    label: 'Doctor',
    flavor: 'Each night, one life is in your hands. It may even be your own.',
  },
  DETECTIVE: {
    icon: '🔍',
    cls: 'detective',
    label: 'Detective',
    flavor: 'Every dawn brings you one truth. Spend it wisely — and tell no one how you know.',
  },
  VILLAGER: {
    icon: '🌾',
    cls: 'villager',
    label: 'Villager',
    flavor: 'No powers. No secrets. Only your wits, your neighbors, and your vote.',
  },
};

const PHASE_META: Record<Projection['phase'], { icon: string; label: (r: number) => string; day?: boolean }> = {
  LOBBY: { icon: '🏮', label: () => 'Lobby' },
  NIGHT: { icon: '🌙', label: (r) => `Night ${r}` },
  DAWN: { icon: '🌅', label: (r) => `Dawn ${r}`, day: true },
  DAY_DISCUSSION: { icon: '☀️', label: (r) => `Day ${r} · discussion`, day: true },
  DAY_VOTE: { icon: '🗳️', label: (r) => `Day ${r} · voting`, day: true },
  DUSK: { icon: '🌆', label: (r) => `Dusk ${r}`, day: true },
  ENDED: { icon: '🏆', label: () => 'Game over' },
};

// ---------------------------------------------------------------------------
// state

let proj: Projection | null = null;
let playerToken: string | null = null;
let room: string | null = null;
let busy = false;
let veilVisible = false; // only dim the board for user-initiated calls, not background polls
let filterText = '';
let autoPoll = false;
let autoPollTimer: number | null = null;
let roleSeen = false;
let roleCardOpen = false;
let cardFlipped = false;
let narrationOpen = false;
let fallenOpen: boolean | null = null; // null = default (open when few dead / reveal)
let sheet:
  | { title: string; detail: string; confirmLabel: string; danger?: boolean; phaseAt: string; action: () => Promise<void> }
  | null = null;

const root = document.getElementById('app')!;

const app = new App({ name: 'Mafia', version: '0.2.0' });

app.ontoolresult = (result) => {
  const sc = (result as { structuredContent?: unknown }).structuredContent as Projection | undefined;
  // Require phase, not just room: a partial payload (e.g. an error surface
  // that happens to carry a room code) must never reach render(), which
  // dereferences PHASE_META[phase].
  if (sc && typeof sc === 'object' && 'room' in sc && 'phase' in sc) setProjection(sc);
};

app
  .connect()
  .then(() => render())
  .catch((err) => {
    console.error('connect failed', err);
    render();
  });

// ---------------------------------------------------------------------------
// data flow

function setProjection(next: Projection): void {
  const prev = proj;
  proj = next;
  if (prev && (prev.room !== next.room || prev.phase !== next.phase)) {
    filterText = '';
    roleCardOpen = false; // a lingering reveal never outlives its phase
    sheet = null; // a confirm captured in the old phase must not fire in the new one
    fallenOpen = null;
  }
  room = next.room;
  if (next.player_token) playerToken = next.player_token;
  if (!next.you?.role) roleSeen = false; // lobby / reset / spectator
  // Auto-open the reveal exactly once, at the moment roles exist: Night 1.
  // Later renders (fresh iframes mid-game) rely on the Role button instead.
  if (next.you?.role && next.phase === 'NIGHT' && next.round === 1 && !roleSeen && prev?.phase !== 'NIGHT') {
    roleCardOpen = true;
    cardFlipped = false;
  }
  render();
}

const CALL_TIMEOUT_MS = 15_000;

async function call(
  tool: string,
  args: Record<string, unknown> = {},
  okMsg?: string,
  opts: { background?: boolean } = {},
): Promise<void> {
  if (busy) return;
  busy = true;
  veilVisible = !opts.background; // background autopolls never dim/block the board
  render();
  try {
    const merged: Record<string, unknown> = { ...args };
    if (room && merged['room'] === undefined) merged['room'] = room;
    if (playerToken && merged['player_token'] === undefined) merged['player_token'] = playerToken;
    // Race the bridge against a timeout so a host that never settles the
    // promise (backgrounded phone, host hiccup) can't leave the app bricked
    // with busy stuck true forever.
    const result = (await Promise.race([
      app.callServerTool({ name: tool, arguments: merged }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), CALL_TIMEOUT_MS)),
    ])) as { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: unknown };
    if (result.isError) {
      toast(result.content?.find((c) => c.type === 'text')?.text ?? 'That didn’t work — try Refresh.');
    } else {
      const sc = result.structuredContent as Projection | undefined;
      if (sc && 'room' in (sc as object) && 'phase' in (sc as object)) {
        proj = null; // force re-render even if stateVersion matched
        setProjection(sc);
      }
      if (okMsg) toast(okMsg, true);
    }
  } catch (err) {
    console.error(tool, err);
    if (!opts.background) toast('The village didn’t answer. Tap Refresh to try again.');
  } finally {
    busy = false;
    veilVisible = false;
    render();
  }
}

function refresh(opts: { background?: boolean } = {}): void {
  if (room) void call('get_state', {}, undefined, opts);
}

function setAutoPoll(on: boolean): void {
  autoPoll = on;
  if (autoPollTimer !== null) {
    clearInterval(autoPollTimer);
    autoPollTimer = null;
  }
  if (on) {
    autoPollTimer = window.setInterval(() => {
      // Don't poll while a sheet is open or the player is typing in the filter —
      // a re-render would blow away the sheet / the input focus.
      const typing = document.activeElement?.classList.contains('filter');
      if (!busy && !sheet && !typing && document.visibilityState === 'visible') refresh({ background: true });
    }, 10_000);
  }
  render();
}

// ---------------------------------------------------------------------------
// dom helpers

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

function btn(label: string, cls: string, onclick: () => void, disabled = false): HTMLButtonElement {
  const b = h('button', { class: `btn ${cls}` }, label);
  b.disabled = disabled || busy;
  b.onclick = onclick;
  return b;
}

let toastTimer: number | null = null;
function toast(message: string, ok = false): void {
  // Append to document.body, NOT the #app root — render() wipes root on every
  // call, which would destroy the toast before it ever painted. Body + fixed
  // positioning (see .toast in styles.css) keeps feedback visible.
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = h('div', { class: `toast${ok ? ' ok' : ''}` }, message);
  document.body.append(el);
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), ok ? 2600 : 5200);
}

function avatarFor(name: string, dead = false): HTMLElement {
  let hash = 5381;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) + hash + name.charCodeAt(i)) | 0;
  const hue = ((hash % 360) + 360) % 360;
  const el = h('div', { class: 'avatar' }, dead ? '🪦' : initials(name));
  el.style.background = dead
    ? 'rgba(255,255,255,0.08)'
    : `linear-gradient(160deg, hsl(${hue} 45% 46%), hsl(${(hue + 40) % 360} 50% 30%))`;
  return el;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  // Iterate by code point, not UTF-16 unit, so an emoji-first name
  // ("🎃 Pumpkin King") yields a whole glyph, not a broken surrogate half.
  const first = (s: string) => [...s][0] ?? '';
  const chars =
    parts.length >= 2
      ? first(parts[0]!) + first(parts[parts.length - 1]!)
      : [...name].slice(0, 2).join('');
  return chars.toUpperCase();
}

// ---------------------------------------------------------------------------
// interaction rules

type TargetMode = { kind: 'vote' } | { kind: 'night'; role: string } | null;

function targetMode(p: Projection): TargetMode {
  const you = p.you;
  if (!you || !you.alive || you.spectator || !you.role) return null;
  if (p.phase === 'DAY_VOTE') return { kind: 'vote' };
  if (p.phase === 'NIGHT' && you.role !== 'VILLAGER') return { kind: 'night', role: you.role };
  return null;
}

function canTarget(p: Projection, tile: Tile, mode: TargetMode): boolean {
  if (!mode || !tile.alive || busy) return false;
  if (tile.id === p.you!.id) {
    if (mode.kind === 'vote') return false; // no self-lynching from the UI
    return mode.role === 'DOCTOR';
  }
  return true;
}

function pickTarget(p: Projection, tile: Tile, mode: NonNullable<TargetMode>): void {
  if (mode.kind === 'vote') {
    sheet = {
      title: `Vote to banish ${tile.name}?`,
      detail: 'You can change your vote until the moderator closes it.',
      confirmLabel: '🗳️ Cast vote',
      phaseAt: p.phase,
      action: () => call('cast_vote', { target_player_id: tile.id }, `Your vote: ${tile.name}`),
    };
  } else {
    const copy: Record<string, [string, string, string]> = {
      MAFIA: [`Mark ${tile.name} for tonight?`, 'The family votes; the most-marked fall at dawn.', '🔪 Mark them'],
      DOCTOR: [`Protect ${tile.name} tonight?`, 'If the mafia come for them, you will be there first.', '🩺 Protect'],
      DETECTIVE: [`Investigate ${tile.name}?`, 'The truth arrives with the dawn — for your eyes only.', '🔍 Investigate'],
    };
    const [title, detail, confirmLabel] = copy[mode.role]!;
    sheet = {
      title,
      detail,
      confirmLabel,
      phaseAt: p.phase,
      action: () => call('submit_night_action', { target_player_id: tile.id }, 'Locked in — you can still change it before dawn.'),
    };
  }
  render();
}

interface ModAction {
  label: string;
  detail: string;
  tool: string;
  danger?: boolean;
  disabled?: boolean;
  note?: string;
}

function moderatorAction(p: Projection): ModAction | null {
  if (!p.you?.isModerator) return null;
  switch (p.phase) {
    case 'LOBBY': {
      const enough = p.lobbyCount >= 5;
      return {
        label: '🎬 Start the game',
        detail: `Deal secret roles to ${p.lobbyCount} players and begin Night 1.`,
        tool: 'start_game',
        disabled: !enough,
        note: enough ? `${p.lobbyCount} players ready` : `${p.lobbyCount}/5 players — need at least 5`,
      };
    }
    case 'NIGHT':
      return { label: '🌅 Bring the dawn', detail: 'Close the night and resolve what happened in the dark.', tool: 'advance_phase', danger: true };
    case 'DAWN':
      return { label: '🏘️ Open discussion', detail: 'Let the accusations begin.', tool: 'advance_phase' };
    case 'DAY_DISCUSSION':
      return { label: '🗳️ Open the vote', detail: 'Time to point fingers for real.', tool: 'advance_phase' };
    case 'DAY_VOTE':
      return { label: '🔒 Close the vote', detail: 'Count the hands and banish the chosen. This cannot be undone.', tool: 'advance_phase', danger: true };
    case 'DUSK':
      return { label: '🌙 Night falls', detail: 'Send the village back to sleep… some for the last time.', tool: 'advance_phase', danger: true };
    case 'ENDED':
      return { label: '🔄 Play again', detail: 'Same crowd, fresh roles, back to the lobby.', tool: 'reset_room', danger: true };
  }
}

// ---------------------------------------------------------------------------
// render

function render(): void {
  // Preserve filter focus/caret across the full rebuild (autopoll + host
  // pushes re-render while the player may be mid-word searching 80 names).
  const active = document.activeElement;
  const refocusFilter = active instanceof HTMLInputElement && active.classList.contains('filter');
  const caret = refocusFilter ? active.selectionStart : null;

  root.textContent = '';
  const day = proj && PHASE_META[proj.phase]?.day && proj.phase !== 'ENDED';
  root.className = `app${day ? ' day' : ''}${proj?.phase === 'ENDED' ? ' ended' : ''}`;
  if (!proj) {
    root.append(
      h(
        'div',
        { class: 'empty' },
        '🏮 The village sleeps. Say “take me to the mafia game” to join — or “rejoin room CODE as your name” if you were already playing.',
      ),
    );
    return;
  }
  const p = proj;

  if (p.phase === 'ENDED') {
    renderTop(p);
    renderVictory(p);
  } else if (p.phase === 'LOBBY') {
    renderTop(p);
    renderLobby(p);
  } else {
    renderTop(p);
    renderBoard(p);
  }

  renderModBar(p);

  if (roleCardOpen && p.you?.role && p.phase !== 'LOBBY' && p.phase !== 'ENDED') renderRoleCard(p);
  if (sheet) renderSheet();
  if (busy && veilVisible) root.append(h('div', { class: 'busyveil' }));

  if (refocusFilter) {
    const again = root.querySelector<HTMLInputElement>('.filter');
    if (again) {
      again.focus();
      if (caret !== null) again.setSelectionRange(caret, caret);
    }
  }
}

function renderTop(p: Projection): void {
  const meta = PHASE_META[p.phase];
  const bar = h('div', { class: 'topbar' });
  bar.append(
    h('span', { class: `pill phase${meta.day ? ' day' : ''}` }, `${meta.icon} `, h('strong', {}, meta.label(p.round))),
    h('span', { class: 'pill code', title: 'Room code' }, p.room),
    h('span', { class: 'pill' }, p.phase === 'LOBBY' ? `🏮 ${p.lobbyCount}` : `❤️ ${p.aliveCount}/${p.seatedCount}`),
    h('span', { class: 'spacer' }),
  );

  // Role card is meaningful only while a game is in progress (not lobby, and
  // not ENDED where the victory screen already reveals everyone).
  if (p.you?.role && p.phase !== 'LOBBY' && p.phase !== 'ENDED') {
    const roleBtn = h('button', { class: 'iconbtn', title: 'Show my role card' }, ROLE_ART[p.you.role]?.icon ?? '🎭', ' Role');
    roleBtn.onclick = () => {
      roleCardOpen = true;
      cardFlipped = true;
      render();
    };
    bar.append(roleBtn);
  }

  const pollBtn = h('button', { class: `iconbtn${autoPoll ? ' on' : ''}`, title: 'Auto-refresh every 10 seconds' }, autoPoll ? '⏱ Auto ✓' : '⏱ Auto');
  pollBtn.onclick = () => setAutoPoll(!autoPoll);

  const refreshBtn = h('button', { class: 'iconbtn', title: 'Refresh now' }, busy ? h('span', { class: 'spin' }, '↻') : '↻', ' Refresh');
  refreshBtn.onclick = () => refresh();
  (refreshBtn as HTMLButtonElement).disabled = busy;

  bar.append(pollBtn, refreshBtn);
  root.append(bar);
}

function renderNarration(p: Projection): void {
  if (p.narration.length === 0) return;
  const latest = p.narration[p.narration.length - 1]!;
  const box = h('div', { class: 'narration' }, h('div', { class: 'latest' }, latest.text));
  if (p.narration.length > 1) {
    const details = h('details', { open: narrationOpen }, h('summary', {}, `📜 The story so far (${p.narration.length - 1})`));
    (details as HTMLDetailsElement).ontoggle = () => {
      narrationOpen = (details as HTMLDetailsElement).open;
    };
    for (const entry of p.narration.slice(0, -1).reverse()) {
      details.append(h('div', { class: 'old' }, entry.text));
    }
    box.append(details);
  }
  root.append(box);
}

function renderPrompt(p: Projection): void {
  const mode = targetMode(p);
  let icon = 'ℹ️';
  let text = p.next_step_hint;
  let actionable = false;

  if (mode?.kind === 'night') {
    actionable = true;
    const already = p.you?.nightTarget;
    if (mode.role === 'MAFIA') {
      icon = '🔪';
      text = already ? `Marked: ${already.name}. Tap another villager to change.` : 'Choose your victim — tap a villager below.';
    } else if (mode.role === 'DOCTOR') {
      icon = '🩺';
      text = already ? `Protecting: ${already.name}. Tap someone else to change.` : 'Choose someone to protect tonight (you may pick yourself).';
    } else {
      icon = '🔍';
      text = already ? `Investigating: ${already.name}. The result comes at dawn.` : 'Choose someone to investigate — tap a player below.';
    }
  } else if (mode?.kind === 'vote') {
    actionable = true;
    icon = '🗳️';
    text = p.you?.vote
      ? p.you.vote.targetId === 'ABSTAIN'
        ? 'You are abstaining. Tap a player to vote instead.'
        : `Your vote: ${p.you.vote.targetName}. Tap another player to change it.`
      : 'Tap a player to vote them out — or abstain.';
  }

  const row = h('div', { class: `prompt${actionable ? ' actionable' : ''}` }, h('span', { class: 'ico' }, icon), h('span', {}, text));

  if (mode?.kind === 'vote') {
    const abstain = h('button', { class: 'iconbtn' }, '🤷 Abstain');
    abstain.onclick = () => {
      sheet = {
        title: 'Abstain from this vote?',
        detail: 'Sometimes silence is a strategy too.',
        confirmLabel: '🤷 Abstain',
        phaseAt: p.phase,
        action: () => call('cast_vote', { target_player_id: 'abstain' }, 'You are abstaining.'),
      };
      render();
    };
    row.append(abstain);
  }
  root.append(row);
}

function renderPrivatePanels(p: Projection): void {
  if (p.mafia) {
    const panel = h('div', { class: 'private' }, h('h4', {}, `🔪 The family · ${p.mafia.killsTonight} kill${p.mafia.killsTonight > 1 ? 's' : ''} tonight`));
    const row = h('div', { class: 'row' });
    if (p.mafia.teammates.length === 0) {
      row.append(h('span', { class: 'chip' }, 'You work alone.'));
    } else {
      for (const mate of p.mafia.teammates) {
        row.append(h('span', { class: 'chip' }, `${mate.alive ? '🕴️' : '🪦'} ${mate.name}`));
      }
    }
    panel.append(row);
    if (p.phase === 'NIGHT' && p.mafia.tally.length > 0) {
      const tallyRow = h('div', { class: 'row', style: 'margin-top:6px' });
      for (const t of p.mafia.tally) {
        tallyRow.append(h('span', { class: 'chip hot' }, `🎯 ${t.targetName} ×${t.count}`));
      }
      panel.append(tallyRow);
    }
    root.append(panel);
  }

  if (p.detective && p.detective.results.length > 0) {
    const panel = h('div', { class: 'private' }, h('h4', {}, '🔍 Your case file'));
    const row = h('div', { class: 'row' });
    for (const res of p.detective.results) {
      row.append(
        h('span', { class: `chip${res.result === 'MAFIA' ? ' hot' : ''}` }, `Night ${res.round}: ${res.targetName} — ${res.result === 'MAFIA' ? '🚨 MAFIA' : '✅ not mafia'}`),
      );
    }
    panel.append(row);
    root.append(panel);
  }

  if (p.reveal && p.phase !== 'ENDED' && p.you && (!p.you.alive || p.you.spectator)) {
    const panel = h('div', { class: 'private' }, h('h4', {}, '👻 Spectator sight — everyone’s true face'));
    const row = h('div', { class: 'row' });
    for (const r of p.reveal.players) {
      row.append(h('span', { class: `chip${r.role === 'MAFIA' ? ' hot' : ''}` }, `${ROLE_ART[r.role]?.icon ?? ''} ${r.name}`));
    }
    panel.append(row);
    root.append(panel);
  }
}

function renderLobby(p: Projection): void {
  root.append(
    h(
      'div',
      { class: 'empty' },
      `🏮 ${p.lobbyCount} villager${p.lobbyCount === 1 ? '' : 's'} gathered by lantern light.`,
      h('br'),
      p.you?.isModerator
        ? 'Share the room code out loud — start when everyone is in.'
        : 'Wait for the moderator to start the game.',
    ),
  );
  renderGrid(p, { headline: 'In the lobby' });
}

function renderBoard(p: Projection): void {
  renderNarration(p);
  renderPrompt(p);
  renderPrivatePanels(p);
  renderGrid(p, { headline: 'The village' });
}

function renderVictory(p: Projection): void {
  const winner = p.winner ?? 'TOWN';
  const box = h('div', { class: 'victory' });
  box.append(
    h('div', { class: 'trophy' }, winner === 'MAFIA' ? '🔪' : '🌾'),
    h('h2', { class: winner === 'MAFIA' ? 'mafia' : 'town' }, winner === 'MAFIA' ? 'The Mafia win' : 'The Town wins'),
    h('div', { class: 'sub' }, `${p.round} round${p.round === 1 ? '' : 's'} of paranoia · ${p.aliveCount} of ${p.seatedCount} still standing`),
  );
  root.append(box);
  if (p.narration.length > 0) renderNarration(p);
  renderGrid(p, { headline: 'Everyone, unmasked', reveal: true });
}

interface GridOpts {
  headline: string;
  reveal?: boolean;
}

function renderGrid(p: Projection, opts: GridOpts): void {
  const wrap = h('div', { class: 'gridwrap' });
  const mode = targetMode(p);
  const revealRoles = new Map<string, string>();
  if (p.reveal) for (const r of p.reveal.players) revealRoles.set(r.id, r.role);

  const showFilter = p.players.length > 24;
  const alive = p.players.filter((t) => t.alive);
  const dead = p.players.filter((t) => !t.alive);
  const query = showFilter ? filterText.trim().toLowerCase() : '';
  const match = (t: Tile) => query === '' || t.name.toLowerCase().includes(query);

  wrap.append(
    h('div', { class: 'gridhead' }, h('h3', {}, opts.headline), h('span', { class: 'count' }, `${alive.length} alive${dead.length ? ` · ${dead.length} gone` : ''}`)),
  );

  if (showFilter) {
    const input = h('input', { class: 'filter', placeholder: '🔎 Find a villager…', value: filterText });
    input.oninput = () => {
      filterText = input.value;
      const focusPos = input.selectionStart;
      render();
      const again = root.querySelector<HTMLInputElement>('.filter');
      if (again) {
        again.focus();
        if (focusPos !== null) again.setSelectionRange(focusPos, focusPos);
      }
    };
    wrap.append(input);
  }

  const grid = h('div', { class: `grid${p.players.length > 40 ? ' compact' : ''}` });
  for (const tile of alive.filter(match)) grid.append(renderTile(p, tile, mode, revealRoles, opts));
  wrap.append(grid);

  if (dead.length > 0) {
    // Remember the player's expand/collapse choice across re-renders (autopoll
    // otherwise snaps the list shut under their finger every 10s).
    const open = fallenOpen ?? (opts.reveal || dead.length <= 6);
    const fallen = h('details', { class: 'fallen', open }, h('summary', {}, `🪦 The fallen (${dead.length})`));
    (fallen as HTMLDetailsElement).ontoggle = () => {
      fallenOpen = (fallen as HTMLDetailsElement).open;
    };
    const deadGrid = h('div', { class: `grid${p.players.length > 40 ? ' compact' : ''}` });
    for (const tile of dead.filter(match)) deadGrid.append(renderTile(p, tile, null, revealRoles, opts));
    fallen.append(deadGrid);
    wrap.append(fallen);
  }

  root.append(wrap);
}

function renderTile(p: Projection, tile: Tile, mode: TargetMode, revealRoles: Map<string, string>, opts: GridOpts): HTMLElement {
  const me = p.you?.id === tile.id;
  const tappable = canTarget(p, tile, mode);
  const picked =
    (p.you?.nightTarget?.id === tile.id && p.phase === 'NIGHT') ||
    (p.you?.vote?.targetId === tile.id && p.phase === 'DAY_VOTE');

  const el = h('div', {
    class: `tile${tile.alive ? '' : ' dead'}${me ? ' me' : ''}${tappable ? ' tappable' : ''}${picked ? ' picked' : ''}`,
    role: tappable ? 'button' : undefined,
    tabindex: tappable ? '0' : undefined,
  });

  if (tile.isModerator) el.append(h('span', { class: 'crown', title: 'Moderator' }, '👑'));
  el.append(avatarFor(tile.name, !tile.alive));
  const isTeammate = p.mafia?.teammates.some((m) => m.id === tile.id) ?? false;
  el.append(h('div', { class: 'tname' }, me ? `${tile.name} (you)` : isTeammate ? `🕴️ ${tile.name}` : tile.name));

  const role = tile.role ?? revealRoles.get(tile.id) ?? (opts.reveal ? undefined : undefined);
  if (role) {
    el.append(h('div', { class: 'tsub role' }, `${ROLE_ART[role]?.icon ?? ''} ${ROLE_ART[role]?.label ?? role}`));
  } else if (!tile.alive) {
    el.append(h('div', { class: 'tsub' }, 'gone'));
  }

  if (p.phase === 'DAY_VOTE' && tile.alive) {
    el.append(h('span', { class: `badge${!tile.votes ? ' zero' : ''}` }, String(tile.votes ?? 0)));
  }
  if (picked) el.append(h('span', { class: 'mark' }, '🎯'));

  if (tappable && mode) {
    const go = () => pickTarget(p, tile, mode);
    el.onclick = go;
    el.onkeydown = (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        go();
      }
    };
  }
  return el;
}

function renderModBar(p: Projection): void {
  const action = moderatorAction(p);
  const bar = h('div', { class: 'modbar' });
  if (action) {
    bar.append(
      btn(action.label, action.danger ? 'danger' : 'primary', () => {
        sheet = {
          title: action.label.replace(/^\S+\s/, ''),
          detail: action.detail,
          confirmLabel: action.label,
          danger: action.danger ?? false,
          phaseAt: p.phase,
          action: () => call(action.tool, {}),
        };
        render();
      }, action.disabled),
      h('span', { class: 'note' }, action.note ?? '👑 You are the moderator — you set the pace.'),
    );
    root.append(bar);
  } else if (p.you && !p.you.isModerator && p.phase !== 'ENDED' && !p.you.alive && !p.you.spectator) {
    bar.append(h('span', { class: 'note' }, '👻 You are dead — but now you see everything.'));
    root.append(bar);
  }
}

function renderRoleCard(p: Projection): void {
  const you = p.you!;
  const art = ROLE_ART[you.role!] ?? ROLE_ART['VILLAGER']!;
  const wrap = h('div', { class: `rolewrap${cardFlipped ? ' revealed' : ''}` });

  const card = h('div', { class: `rolecard${cardFlipped ? ' flipped' : ''}` });
  const inner = h('div', { class: 'inner' });

  inner.append(
    h(
      'div',
      { class: 'face back' },
      h('div', { class: 'emblem' }, '🏮'),
      h('div', { class: 't' }, `${you.name}, your fate is sealed inside.`),
      h('div', { class: 'tap' }, 'tap to reveal'),
    ),
  );

  const front = h(
    'div',
    { class: `face front ${art.cls}` },
    h('div', { class: 'icon' }, art.icon),
    h('div', { class: 'rname' }, art.label),
    h('div', { class: 'flavor' }, art.flavor),
  );
  if (you.role === 'MAFIA' && p.mafia) {
    const mates = p.mafia.teammates.map((m) => m.name);
    front.append(
      h(
        'div',
        { class: 'mates' },
        mates.length > 0 ? h('span', {}, 'Your family: ', h('b', {}, mates.join(', '))) : 'You work alone.',
        p.mafia.killsTonight > 1 ? h('div', {}, `The family strikes ${p.mafia.killsTonight} times each night.`) : null,
      ),
    );
  }
  inner.append(front);
  card.append(inner);
  card.onclick = () => {
    if (!cardFlipped) {
      cardFlipped = true;
      render();
    }
  };

  const cont = btn('Enter the village →', 'primary continue', () => {
    roleCardOpen = false;
    roleSeen = true;
    render();
  });
  cont.classList.add('continue');

  wrap.append(card, cont, h('div', { class: 'hintline' }, 'Keep it secret. Keep your phone close.'));
  root.append(wrap);
}

function renderSheet(): void {
  if (!sheet) return;
  const current = sheet;
  const close = () => {
    sheet = null;
    render();
  };
  const veil = h('div', { class: 'sheetveil' });
  veil.onclick = (ev) => {
    if (ev.target === veil) close();
  };
  veil.onkeydown = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  };
  const box = h(
    'div',
    { class: 'sheet' },
    h('div', { class: 'q' }, current.title),
    h('div', { class: 'd' }, current.detail),
  );
  const btns = h('div', { class: 'btns' });
  const confirmBtn = btn(current.confirmLabel, current.danger ? 'danger' : 'primary', () => {
    sheet = null;
    // Guard against phase drift: if the world moved on while this sheet was
    // open (moderator advanced via chat, autopoll landed), don't fire a stale
    // action into the wrong phase.
    if (proj && proj.phase !== current.phaseAt) {
      render();
      toast('The game moved on — that action no longer applies.');
      return;
    }
    void current.action();
  });
  btns.append(
    btn('Cancel', 'ghost', close),
    confirmBtn,
  );
  box.append(btns);
  veil.append(box);
  root.append(veil);
  confirmBtn.focus(); // keyboard/switch users land on the confirm, not 80 tiles away
}
