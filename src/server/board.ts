import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { viewFor } from '../game/view.js';
import type { RoomStore } from '../store/types.js';
import { normalizeRoomCode } from './identity.js';

/**
 * The projector board: GET /room/{code}/board — a read-only, public-view
 * page meant for the big screen in the room. Server-sent events (outside
 * MCP) push the public projection whenever the room changes. With 80
 * players, this shared screen is the anchor that keeps the room in sync.
 */

const POLL_MS = 4000;
const MAX_STREAM_MS = 90 * 60 * 1000;

export function registerBoardRoutes(app: Hono, store: RoomStore): void {
  app.get('/room/:code/board', (c) => {
    const code = normalizeRoomCode(c.req.param('code'));
    return c.html(boardHtml(code));
  });

  app.get('/room/:code/board/events', (c) => {
    const code = normalizeRoomCode(c.req.param('code'));
    return streamSSE(c, async (stream) => {
      const started = Date.now();
      let lastVersion = -1;
      let lastBeat = 0;
      while (!stream.aborted && Date.now() - started < MAX_STREAM_MS) {
        try {
          const stored = await store.load(code);
          if (!stored) {
            await stream.writeSSE({ event: 'gone', data: '{}' });
            break;
          }
          if (stored.version !== lastVersion) {
            lastVersion = stored.version;
            const projection = viewFor(stored.state, null, stored.version);
            await stream.writeSSE({ event: 'state', data: JSON.stringify(projection) });
          } else if (Date.now() - lastBeat > 15_000) {
            lastBeat = Date.now();
            await stream.writeSSE({ event: 'beat', data: String(Date.now()) });
          }
        } catch (err) {
          console.error('board stream error', err);
        }
        await stream.sleep(POLL_MS);
      }
    });
  });
}

function boardHtml(code: string): string {
  // Self-contained big-screen page. Keep everything inline; no CDNs.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MAFIA · ${escapeHtml(code)}</title>
<style>
:root {
  --bg: #0e0b1a; --bg2: #171233; --panel: rgba(255,255,255,.05); --line: rgba(255,255,255,.1);
  --ink: #ece7dd; --muted: #a49bc0; --faint: #6f678c;
  --lantern: #f5a83c; --lantern-deep: #d98324; --blood: #e05252; --moon: #93aede;
  --serif: Georgia, 'Times New Roman', serif;
  --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  font-family: var(--sans); color: var(--ink); overflow: hidden;
  background:
    radial-gradient(1600px 700px at 18% -12%, rgba(147,174,222,.10), transparent 60%),
    radial-gradient(1300px 600px at 85% -5%, rgba(245,168,60,.08), transparent 55%),
    linear-gradient(180deg, var(--bg2), var(--bg) 55%);
}
.stars { position: fixed; inset: 0; pointer-events: none; opacity: .7; }
.stars::before, .stars::after {
  content: ''; position: absolute; width: 2px; height: 2px; border-radius: 50%;
  background: transparent;
  box-shadow: 8vw 12vh #fff8, 22vw 6vh #fff5, 37vw 18vh #fff7, 52vw 4vh #fff6, 66vw 15vh #fff8,
              81vw 9vh #fff5, 93vw 20vh #fff7, 15vw 28vh #fff4, 45vw 30vh #fff5, 74vw 26vh #fff4,
              5vw 40vh #fff3, 60vw 38vh #fff4, 88vw 42vh #fff3, 30vw 44vh #fff3;
  animation: twinkle 5s ease-in-out infinite alternate;
}
.stars::after { transform: translate(3vw, 2vh) scale(.7); animation-delay: 2.4s; }
@keyframes twinkle { from { opacity: .35; } to { opacity: 1; } }

.wrap { position: relative; height: 100%; display: flex; flex-direction: column; padding: 2.2vh 2.4vw; gap: 1.6vh; }

header { display: flex; align-items: center; gap: 1.6vw; }
.brand { font-family: var(--serif); letter-spacing: .35em; font-size: clamp(16px, 2vh, 26px); color: var(--muted); }
.brand b { color: var(--lantern); }
.phase {
  flex: 1; text-align: center; font-family: var(--serif);
  font-size: clamp(26px, 5.2vh, 64px); letter-spacing: .04em;
  text-shadow: 0 0 30px rgba(147,174,222,.25);
  transition: color .6s;
}
.phase.day { text-shadow: 0 0 30px rgba(245,168,60,.35); }
.codebox { text-align: right; }
.codebox .lbl { font-size: clamp(10px, 1.4vh, 14px); color: var(--faint); letter-spacing: .25em; }
.codebox .code {
  font-size: clamp(30px, 6vh, 72px); font-weight: 800; letter-spacing: .18em;
  color: var(--lantern); text-shadow: 0 0 34px rgba(245,168,60,.4); line-height: 1;
}

main { flex: 1; display: grid; grid-template-columns: 1fr minmax(320px, 28vw); gap: 1.8vw; min-height: 0; }

.wall { overflow: hidden; display: flex; flex-direction: column; min-height: 0; }
.wallgrid { flex: 1; display: grid; gap: .8vh; align-content: start; padding-top: 1.6vh;
  grid-template-columns: repeat(auto-fill, minmax(var(--tile, 120px), 1fr)); overflow-x: hidden; overflow-y: auto; }
.tile {
  border: 1px solid var(--line); border-radius: 12px; background: var(--panel);
  display: flex; flex-direction: column; align-items: center; gap: .6vh;
  padding: 1vh .4vw .8vh; position: relative; transition: opacity .5s, filter .5s;
}
.tile.dead { opacity: .42; filter: saturate(.3); }
.tile.dead .av { background: rgba(255,255,255,.08) !important; }
.av {
  width: clamp(30px, 4.6vh, 56px); height: clamp(30px, 4.6vh, 56px); border-radius: 50%;
  display: flex; align-items: center; justify-content: center; font-weight: 700;
  font-size: clamp(12px, 1.9vh, 22px); color: #fffd; text-shadow: 0 1px 2px #0007; flex: none;
}
.nm { font-size: clamp(11px, 1.7vh, 18px); max-width: 96%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rl { font-size: clamp(9px, 1.3vh, 14px); color: var(--blood); font-weight: 600; margin-top: -.4vh; }
.crown { position: absolute; top: -1vh; left: .2vw; font-size: clamp(12px, 2vh, 20px); transform: rotate(-16deg); }
.votes {
  position: absolute; top: -1vh; right: -.3vw; min-width: clamp(18px, 2.8vh, 30px); height: clamp(18px, 2.8vh, 30px);
  border-radius: 999px; background: var(--lantern); color: #241503; font-weight: 800;
  display: flex; align-items: center; justify-content: center; font-size: clamp(11px, 1.8vh, 18px);
  padding: 0 .3vw; box-shadow: 0 2px 8px #0006; transition: transform .25s;
}
.votes.bump { transform: scale(1.35); }

aside { display: flex; flex-direction: column; gap: 1.6vh; min-height: 0; }
.narration {
  background: linear-gradient(180deg, rgba(245,168,60,.10), rgba(245,168,60,.03));
  border: 1px solid rgba(245,168,60,.25); border-radius: 16px; padding: 2vh 1.4vw;
  font-family: var(--serif); flex: none;
}
.narration .latest { font-size: clamp(16px, 2.6vh, 30px); line-height: 1.5; }
.narration .latest::first-letter { font-size: 1.6em; color: var(--lantern); }
.tally { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 1.6vh 1.2vw; display: none; }
.tally h3 { font-size: clamp(11px, 1.6vh, 16px); color: var(--moon); letter-spacing: .2em; margin-bottom: 1vh; }
.bar { margin-bottom: 1vh; }
.bar .who { display: flex; justify-content: space-between; font-size: clamp(12px, 2vh, 20px); margin-bottom: .4vh; }
.bar .track { height: clamp(8px, 1.4vh, 16px); background: rgba(0,0,0,.35); border-radius: 999px; overflow: hidden; }
.bar .fill { height: 100%; background: linear-gradient(90deg, var(--lantern), var(--lantern-deep)); border-radius: 999px; transition: width .6s cubic-bezier(.2,.8,.2,1); }
.history { flex: 1; overflow: hidden; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 1.4vh 1.2vw; }
.history h3 { font-size: clamp(11px, 1.6vh, 16px); color: var(--faint); letter-spacing: .2em; margin-bottom: 1vh; }
.history .item { font-family: var(--serif); color: var(--muted); font-size: clamp(12px, 1.9vh, 19px); padding: .5vh 0; border-bottom: 1px dashed rgba(255,255,255,.07); }

.joincard {
  background: var(--panel); border: 1px dashed rgba(147,174,222,.4); border-radius: 16px;
  padding: 2vh 1.4vw; text-align: center;
}
.joincard .how { color: var(--muted); font-size: clamp(13px, 2vh, 20px); line-height: 1.6; }
.joincard .how b { color: var(--ink); }
.joincard .cnt { font-size: clamp(22px, 4vh, 44px); color: var(--lantern); font-weight: 800; margin-top: .6vh; }

footer { display: flex; align-items: center; gap: 1.2vw; color: var(--faint); font-size: clamp(11px, 1.6vh, 15px); }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #e05252; transition: background .3s; }
.dot.ok { background: #86c07e; }
footer .spacer { flex: 1; }

.splash {
  position: fixed; inset: 0; display: none; align-items: center; justify-content: center; flex-direction: column;
  gap: 2vh; z-index: 20; backdrop-filter: blur(3px); text-align: center; pointer-events: none;
}
/* Play the moment, then fade away so the unmasked wall (everyone's true
   role) gets the projector — that reveal is the room's favorite part. */
.splash.show {
  display: flex;
  animation: splashin .8s cubic-bezier(.2,.9,.3,1), splashfade 1.8s ease 7s forwards;
}
@keyframes splashin { from { opacity: 0; transform: scale(.94); } }
@keyframes splashfade { to { opacity: 0; visibility: hidden; } }
.splash.town { background: radial-gradient(60vw 60vh at 50% 45%, rgba(245,168,60,.28), rgba(14,11,26,.94) 70%); }
.splash.mafia { background: radial-gradient(60vw 60vh at 50% 45%, rgba(224,82,82,.30), rgba(14,11,26,.95) 70%); }
.splash .icon { font-size: clamp(60px, 14vh, 150px); filter: drop-shadow(0 0 40px rgba(245,168,60,.5)); }
.splash h1 { font-family: var(--serif); font-size: clamp(40px, 9vh, 110px); letter-spacing: .05em; }
.splash.town h1 { color: var(--lantern); } .splash.mafia h1 { color: #f08c8c; }
.splash .sub { color: var(--muted); font-size: clamp(16px, 2.6vh, 28px); }
</style>
</head>
<body>
<div class="stars"></div>
<div class="wrap">
  <header>
    <div class="brand">M A F I <b>A</b></div>
    <div class="phase" id="phase">connecting…</div>
    <div class="codebox"><div class="lbl">ROOM</div><div class="code">${escapeHtml(code)}</div></div>
  </header>
  <main>
    <section class="wall"><div class="wallgrid" id="grid"></div></section>
    <aside>
      <div class="narration" id="narr" style="display:none"><div class="latest" id="narrLatest"></div></div>
      <div class="joincard" id="join" style="display:none">
        <div class="how">Open <b>ChatGPT</b> · find <b>Mafia Game</b> · say<br/><b>“join the mafia game as &lt;your name&gt;”</b></div>
        <div class="cnt" id="joinCount"></div>
      </div>
      <div class="tally" id="tally"><h3>THE VOTE</h3><div id="bars"></div></div>
      <div class="history" id="history" style="display:none"><h3>THE STORY SO FAR</h3><div id="items"></div></div>
    </aside>
  </main>
  <footer>
    <div class="dot" id="dot"></div><div id="status">waiting for the village…</div>
    <div class="spacer"></div><div id="alive"></div>
  </footer>
</div>
<div class="splash" id="splash"><div class="icon" id="sIcon"></div><h1 id="sTitle"></h1><div class="sub" id="sSub"></div></div>
<script>
const PHASE = {
  LOBBY: ['🏮', 'The lobby is open', false],
  NIGHT: ['🌙', 'Night', false],
  DAWN: ['🌅', 'Dawn', true],
  DAY_DISCUSSION: ['☀️', 'The town debates', true],
  DAY_VOTE: ['🗳️', 'The town votes', true],
  DUSK: ['🌆', 'Dusk', true],
  ENDED: ['🏆', 'Game over', true],
};
const ROLE = { MAFIA: '🔪 Mafia', DOCTOR: '🩺 Doctor', DETECTIVE: '🔍 Detective', VILLAGER: '🌾 Villager' };
const $ = (id) => document.getElementById(id);
let prevVotes = {};

function hue(name) { let h = 5381; for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0; return ((h % 360) + 360) % 360; }
function graphemes(s, n) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const out = [];
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)) {
      out.push(segment);
      if (out.length >= n) break;
    }
    return out.join('');
  }
  return [...s].slice(0, n).join('');
}
function initials(name) {
  // Grapheme clusters, not UTF-16 units or lone code points: skin-tone
  // modifiers and ZWJ sequences stay intact on the projector.
  const p = name.trim().split(/\\s+/);
  const two = p.length > 1 ? graphemes(p[0], 1) + graphemes(p[p.length - 1], 1) : graphemes(name, 2);
  return two.toUpperCase();
}

/** Shrink --tile until n tiles fit the wall, so 80 names stay on a 720p projector. */
function fitTileMin(n) {
  const grid = $('grid');
  const w = Math.max(1, grid.clientWidth);
  const h = Math.max(1, grid.clientHeight);
  const gap = Math.max(6, Math.round(h * 0.008));
  let minW = n > 60 ? 96 : n > 40 ? 110 : n > 20 ? 128 : 150;
  const tileH = () => minW * 0.55 + 36;
  while (minW > 56) {
    const cols = Math.max(1, Math.floor((w + gap) / (minW + gap)));
    const rows = Math.ceil(n / cols);
    if (rows * (tileH() + gap) <= h + 2) break;
    minW -= 4;
  }
  return Math.max(56, minW) + 'px';
}

let lastState = null;
let splashShown = false;
function render(p) {
  lastState = p;
  const [icon, label, day] = PHASE[p.phase] ?? ['?', p.phase, false];
  $('phase').textContent = icon + '  ' + (p.phase === 'NIGHT' || p.phase === 'DAWN' || p.phase === 'DUSK' ? label + ' ' + p.round : label);
  $('phase').classList.toggle('day', !!day);
  const watch = p.spectatorCount > 0 ? ' · ' + p.spectatorCount + ' watching' : '';
  $('alive').textContent = p.phase === 'LOBBY' ? p.lobbyCount + ' in the lobby' + watch : p.aliveCount + ' of ' + p.seatedCount + ' alive · round ' + p.round;

  // tiles — size adapts to player count AND the visible wall
  const n = p.players.length || 1;
  const grid = $('grid');
  grid.style.setProperty('--tile', fitTileMin(n));
  grid.textContent = '';
  const reveal = {};
  (p.reveal?.players ?? []).forEach((r) => (reveal[r.id] = r.role));
  for (const t of p.players) {
    const el = document.createElement('div');
    el.className = 'tile' + (t.alive ? '' : ' dead');
    const av = document.createElement('div');
    av.className = 'av';
    av.textContent = t.alive ? initials(t.name) : '🪦';
    if (t.alive) av.style.background = 'linear-gradient(160deg, hsl(' + hue(t.name) + ' 45% 46%), hsl(' + ((hue(t.name) + 40) % 360) + ' 50% 30%))';
    el.append(av);
    if (t.isModerator) { const c = document.createElement('span'); c.className = 'crown'; c.textContent = '👑'; el.append(c); }
    const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = t.name; el.append(nm);
    const role = t.role ?? reveal[t.id];
    if (role) { const r = document.createElement('div'); r.className = 'rl'; r.textContent = ROLE[role] ?? role; el.append(r); }
    if (p.phase === 'DAY_VOTE' && t.alive && t.votes > 0) {
      const v = document.createElement('span'); v.className = 'votes'; v.textContent = t.votes;
      if (prevVotes[t.id] !== t.votes) { v.classList.add('bump'); setTimeout(() => v.classList.remove('bump'), 260); }
      el.append(v);
    }
    grid.append(el);
  }
  prevVotes = {}; p.players.forEach((t) => (prevVotes[t.id] = t.votes));

  // narration + history
  const hasNarr = p.narration.length > 0;
  $('narr').style.display = hasNarr ? '' : 'none';
  if (hasNarr) $('narrLatest').textContent = p.narration[p.narration.length - 1].text;
  const hist = p.narration.slice(0, -1).reverse();
  $('history').style.display = hist.length ? '' : 'none';
  $('items').textContent = '';
  for (const h of hist.slice(0, 6)) { const d = document.createElement('div'); d.className = 'item'; d.textContent = h.text; $('items').append(d); }

  // lobby join card
  $('join').style.display = p.phase === 'LOBBY' ? '' : 'none';
  if (p.phase === 'LOBBY') {
    $('joinCount').textContent = p.lobbyCount + ' villagers seated' + (p.spectatorCount > 0 ? ' · ' + p.spectatorCount + ' watching' : '');
  }

  // vote tally bars
  const tallyOn = p.phase === 'DAY_VOTE' && p.vote && p.vote.tally.length > 0;
  $('tally').style.display = tallyOn ? 'block' : 'none';
  if (tallyOn) {
    const max = Math.max(...p.vote.tally.map((t) => t.count), 1);
    $('bars').textContent = '';
    for (const t of p.vote.tally.slice(0, 6)) {
      const b = document.createElement('div'); b.className = 'bar';
      const who = document.createElement('div'); who.className = 'who';
      who.innerHTML = '<span></span><b></b>';
      who.firstChild.textContent = t.targetName; who.lastChild.textContent = t.count;
      const track = document.createElement('div'); track.className = 'track';
      const fill = document.createElement('div'); fill.className = 'fill'; fill.style.width = Math.round((t.count / max) * 100) + '%';
      track.append(fill); b.append(who, track); $('bars').append(b);
    }
  }

  // victory splash — set the class only on the transition into ENDED, so
  // later renders (resize, lobby joins) don't restart the fade animation
  const splash = $('splash');
  if (p.phase === 'ENDED' && p.winner) {
    if (!splashShown) {
      splashShown = true;
      splash.className = 'splash show ' + (p.winner === 'MAFIA' ? 'mafia' : 'town');
      $('sIcon').textContent = p.winner === 'MAFIA' ? '🔪' : '🌾';
      $('sTitle').textContent = p.winner === 'MAFIA' ? 'The Mafia win' : 'The Town wins';
      $('sSub').textContent = p.round + ' rounds of paranoia · ' + p.aliveCount + ' of ' + p.seatedCount + ' still standing';
    }
  } else {
    splashShown = false;
    splash.className = 'splash';
  }
  $('status').textContent = 'live';
}

window.addEventListener('resize', () => { if (lastState) render(lastState); });

let gone = false;
const src = new EventSource(location.pathname + '/events');
src.addEventListener('state', (ev) => { $('dot').classList.add('ok'); render(JSON.parse(ev.data)); });
src.addEventListener('beat', () => $('dot').classList.add('ok'));
src.addEventListener('gone', () => {
  gone = true;
  src.close();
  $('status').textContent = 'room not found';
  $('phase').textContent = 'room not found';
  $('dot').classList.remove('ok');
});
src.onerror = () => {
  if (gone) return;
  $('dot').classList.remove('ok');
  $('status').textContent = 'reconnecting…';
};
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
