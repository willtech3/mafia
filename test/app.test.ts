/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { viewFor } from '../src/game/view.js';
import { makeGame, makeLobby, quietNightToVote, vote } from './helpers.js';

const script = transformSync(readFileSync('src/app/main.ts', 'utf8').replace("import { App } from '@modelcontextprotocol/ext-apps';", 'const App = (globalThis as any).__TestApp;'), { loader: 'ts', format: 'iife' }).code;
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function mount(onCall = vi.fn()) {
  vi.useFakeTimers();
  const { window, document } = parseHTML('<html><body><div id="app"></div></body></html>');
  let client: any;
  class App {
    ontoolresult: any;
    constructor() { client = this; }
    connect() { return Promise.resolve(); }
    callServerTool(args: unknown) { return onCall(args); }
  }
  let active: any = document.body;
  Object.defineProperty(document, 'activeElement', { get: () => active });
  window.HTMLElement.prototype.focus = function() { active = this; };
  Object.assign(window, { __TestApp: App, setTimeout, clearTimeout, setInterval, clearInterval, Intl });
  vm.runInContext(script, vm.createContext(window as unknown as vm.Context));
  return { document, onCall, push: (structuredContent: unknown) => client.ontoolresult({ structuredContent }) };
}
function click(el: Element | null) { if (!el) throw Error('Missing button'); (el as HTMLElement).click(); }
function button(document: Document, label: string) { return [...document.querySelectorAll('button')].find(b => b.textContent?.includes(label))!; }
afterEach(() => vi.useRealTimers());

describe('Mafia app regressions', () => {
  it('renders rules even when there is no room projection', async () => {
    const h = mount(); await flush();
    h.push({ rules: 'Night: choose a private target.\nDay: debate and vote.' });
    expect(h.document.querySelector('h2')?.textContent).toBe('How to play Mafia');
    expect(h.document.querySelector('.rules')?.textContent).toContain('Day: debate and vote.');
    expect(h.document.body.textContent).not.toContain('Say “take me');
  });

  it('refreshes by default, retains the board on failure, and retries', async () => {
    const projection = viewFor(makeLobby(5), 'p0', 1);
    const call = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue({ structuredContent: projection });
    const h = mount(call); h.push(projection); await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(call).toHaveBeenCalledTimes(1);
    expect(h.document.querySelector('.sync-status')?.textContent).toContain('Retrying');
    expect(h.document.body.textContent).toContain('5 villagers');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(call).toHaveBeenCalledTimes(2);
    expect(h.document.querySelector('.sync-status')?.textContent).toContain('Live');
  });

  it('conceals the role, supports a button reveal, and retains modal focus on updates', async () => {
    const state = makeGame(7);
    const h = mount(); h.push(viewFor(state, 'p0', 1)); await flush();
    const card = h.document.querySelector<HTMLButtonElement>('button.rolecard')!;
    expect(card.getAttribute('aria-label')).toBe('Reveal your role');
    expect(h.document.querySelector('.face.front')?.getAttribute('aria-hidden')).toBe('true');
    expect(button(h.document, 'Enter the village').disabled).toBe(true);
    click(card);
    const enter = button(h.document, 'Enter the village');
    enter.focus(); h.push(viewFor(state, 'p0', 2));
    expect(h.document.activeElement?.textContent).toContain('Enter the village');
    click(button(h.document, 'Enter the village'));
    expect(button(h.document, 'Role').textContent).toBe('🎭 Role');
  });

  it('does not close voting after a refresh changes the promised result', async () => {
    const state = quietNightToVote(makeGame(7));
    const changed = vote(state, 'p1', 'p2');
    const call = vi.fn().mockResolvedValue({ structuredContent: viewFor(changed, 'p0', 2) });
    const h = mount(call); h.push(viewFor(state, 'p0', 1)); await flush();
    click(button(h.document, 'Close the vote'));
    click(h.document.querySelector('.sheet .btn.primary, .sheet .btn.danger'));
    await flush();
    expect(call.mock.calls.map(c => c[0].name)).toEqual(['get_state']);
    expect(h.document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(h.document.body.textContent).toContain('The tally changed');
  });
});

it('ignores an old room response after the host switches rooms', async () => {
  let resolve!: (result: unknown) => void;
  const h = mount(vi.fn().mockImplementation(() => new Promise(r => { resolve = r; })));
  const old = viewFor(makeLobby(5), 'p0', 1);
  h.push(old); await flush();
  click(button(h.document, 'Refresh'));
  h.push({ ...old, room: 'NEXT' });
  resolve({ structuredContent: { ...old, stateVersion: 2 } });
  await flush();
  expect(h.document.querySelector('[title="Room code"]')?.textContent ?? h.document.body.textContent).toContain('NEXT');
});
