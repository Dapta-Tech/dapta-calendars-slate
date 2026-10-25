// @vitest-environment jsdom
/**
 * The connector guide, driven like a person would: a tab per app in the
 * dForms order, the animated walkthrough full width above the numbered steps
 * (each app redrawn in code, or a CLI replay), the step playing lit and named
 * in the frame, this product as the connector, a meeting found and booked at
 * the end, and the URL alone everywhere.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessages, type Locale } from '@slate/shared';
import { fillMessages } from '@/lib/fill-messages';
import { mcpSnippets } from '@/lib/mcp-connect';
import { CONNECTOR_NAME } from '@/lib/product-name';
import { APP_KEY, ConnectGuide } from './connect-guide';
import { CONNECT_VARS } from './connect-vars';
import { WALK_DURATIONS } from './walkthrough';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const URL_ = 'https://mcp.calendar.example.com/mcp';
const LISTING = 'https://claude.ai/directory/acme-calendars';
const APPS = ['claude', 'chatgpt', 'claude-code', 'codex', 'cursor', 'openclaw', 'hermes'] as const;

let root: Root;
let host: HTMLDivElement;
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);

/** The connect copy as the page hands it over: names filled in on the server. */
const copy = (locale: Locale = 'en') => fillMessages(getMessages(locale).admin.connect, CONNECT_VARS);

function motion(reduce: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: reduce && q.includes('reduce'),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

async function mount(locale: Locale = 'en', directory: string | null = null) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<ConnectGuide m={copy(locale)} snippets={mcpSnippets(URL_, directory)} />));
}
const pick = (app: string) => act(async () => $(`[data-testid="mcp-app-${app}"]`)!.click());
const walk = () => $('[data-testid="mcp-walkthrough"]')!;
const lit = () => [...document.querySelectorAll('[data-testid="mcp-step"]')].findIndex((li) => li.hasAttribute('data-active'));
const stepButton = (i: number) => document.querySelectorAll('[data-testid="mcp-step"]')[i]!.querySelector<HTMLElement>('button')!;

function asPhone(): () => void {
  const ua = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
  Object.defineProperty(window.navigator, 'userAgent', {
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile Safari',
    configurable: true,
  });
  return () => {
    if (ua) Object.defineProperty(window.navigator, 'userAgent', ua);
    else delete (window.navigator as { userAgent?: string }).userAgent;
  };
}

beforeEach(() => {
  window.localStorage.clear();
  motion(false);
  // The tab strip scrolls the picked tab into view; jsdom has no layout.
  Element.prototype.scrollIntoView = () => {};
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('ConnectGuide', () => {
  it('orders the apps Claude, ChatGPT, Claude Code, Codex, Cursor, OpenClaw, Hermes, each with its official mark', async () => {
    await mount();
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((b) => b.getAttribute('data-testid'));
    expect(tabs).toEqual(APPS.map((a) => `mcp-app-${a}`));
    for (const app of APPS) expect($(`[data-testid="mcp-app-${app}"] svg[data-agent="${app}"]`)).not.toBeNull();
    expect($('[data-testid="mcp-app-claude"]')!.getAttribute('aria-selected')).toBe('true');
  });

  it('opens with the recommended card: the pill and three benefits, the third one saying who can connect', async () => {
    await mount();
    const c = copy();
    expect($('[data-testid="mcp-connect-recommended"]')!.textContent).toBe(c.recommended);
    expect($('[data-testid="mcp-connect-recommended"]')!.className).toContain('pill-pulse');
    const benefits = [...document.querySelectorAll('[data-testid="mcp-connect-benefits"] li')].map((li) => li.textContent);
    expect(benefits).toEqual([c.benefits.noKey, c.benefits.workspaces, c.benefits.access].map((b) => `${b.title}${b.body}`));
    expect($('[data-testid="mcp-connect-tip"]')!.textContent).toContain('switch to');
  });

  it('moves between the tabs with the arrows, Home and End, focus following', async () => {
    await mount();
    const strip = $('[data-testid="mcp-app-tabs"]')!;
    const key = (k: string) =>
      act(async () => void strip.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
    await key('ArrowRight');
    expect(document.activeElement).toBe($('[data-testid="mcp-app-chatgpt"]'));
    expect($('[data-testid="mcp-app-panel"]')!.dataset.app).toBe('chatgpt');
    await key('End');
    expect(document.activeElement).toBe($('[data-testid="mcp-app-hermes"]'));
    await key('ArrowRight');
    expect(document.activeElement).toBe($('[data-testid="mcp-app-claude"]'));
    await key('ArrowLeft');
    expect(document.activeElement).toBe($('[data-testid="mcp-app-hermes"]'));
    await key('Home');
    expect($('[data-testid="mcp-app-claude"]')!.getAttribute('aria-selected')).toBe('true');
    expect($('[data-testid="mcp-app-claude"]')!.tabIndex).toBe(0);
    expect($('[data-testid="mcp-app-chatgpt"]')!.tabIndex).toBe(-1);
  });

  it('puts the walkthrough above the steps, full width', async () => {
    await mount();
    const panel = $('[data-testid="mcp-app-panel"]')!;
    const media = panel.querySelector('[data-testid="mcp-walkthrough"]')!;
    const steps = panel.querySelector('[data-testid="mcp-steps-claude"]')!;
    expect(media.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(media.parentElement!.className).not.toMatch(/grid-cols/);
  });

  it('animates every app in code, with no video or image anywhere, and names the step in the frame', async () => {
    await mount('es');
    const es = copy('es');
    for (const app of APPS) {
      await pick(app);
      expect(host.querySelector('video, img')).toBeNull();
      expect(walk().dataset.kind).toBe(['claude', 'chatgpt', 'cursor'].includes(app) ? 'app' : 'terminal');
    }
    await pick('claude');
    expect(walk().textContent).toContain(es.apps.claude.steps[0]!.title);
  });

  it('draws this product as the connector in every app frame, never Dapta, and ends on the meeting it booked', async () => {
    await mount();
    const seen: string[] = [];
    for (const app of ['claude', 'chatgpt', 'cursor'] as const) {
      await pick(app);
      for (let i = 0; i < WALK_DURATIONS[app].length; i++) {
        await act(async () => stepButton(i).click());
        expect(walk().dataset.step).toBe(String(i));
        const text = walk().textContent ?? '';
        expect(text, `${app} ${i}`).not.toMatch(/Dapta/i);
        seen.push(text);
      }
      // The last frame: the open times, then the meeting, booked.
      const a = copy().walkthrough.answer;
      const last = seen.at(-1)!;
      expect(last, app).toContain(a.found);
      expect(last, app).toContain(a.meeting);
      expect(last, app).toContain(a.booked);
    }
    const all = seen.join(' ');
    expect(all).toContain(CONNECTOR_NAME);
    expect(all).toContain(URL_);
    // Real tools, from the MCP catalog.
    expect(all).toContain('find_available_slots');
    expect(all).toContain('book_meeting');
    // The neutral sign-in: email, then the code.
    const s = copy().walkthrough.signIn;
    expect(all).toContain(s.title);
    expect(all).toContain(s.checkEmail);
  });

  it('replays each CLI with the dcal server: its commands, then the meeting found and booked', async () => {
    await mount();
    const a = copy().walkthrough.answer;
    for (const app of ['claude-code', 'codex', 'openclaw', 'hermes'] as const) {
      await pick(app);
      const last = WALK_DURATIONS[app].length - 1;
      await act(async () => stepButton(last).click());
      const text = walk().textContent ?? '';
      expect(text, app).toMatch(/dcal.{0,3}find_available_slots/);
      expect(text, app).toMatch(/dcal.{0,3}book_meeting/);
      expect(text, app).toContain(a.meeting);
      expect(text, app).not.toMatch(/Dapta/i);
    }
  });

  it('types the booking request in the animation, and offers a read-only first request to copy', async () => {
    await mount();
    const c = copy();
    expect(c.prompt).not.toBe(c.walkthrough.prompt);
    const last = WALK_DURATIONS.claude.length - 1;
    await act(async () => stepButton(last).click());
    expect(walk().textContent).toContain(c.walkthrough.prompt);
    expect($('[data-testid="mcp-prompt"]')!.textContent).toContain(c.prompt);
    expect(c.prompt).toContain(CONNECTOR_NAME);
  });

  it('gives each terminal app its commands, with the URL alone', async () => {
    await mount();
    await pick('claude-code');
    expect(walk().dataset.kind).toBe('terminal');
    expect($('[data-testid="mcp-claude-code-command"]')!.textContent).toContain(`claude mcp add --transport http --scope user dcal ${URL_}`);
    await pick('codex');
    expect($('[data-testid="mcp-codex-add"]')!.textContent).toContain(`codex mcp add dcal --url ${URL_}`);
    expect($('[data-testid="mcp-codex-login"]')!.textContent).toContain('codex mcp login dcal');
    await pick('openclaw');
    expect($('[data-testid="mcp-openclaw-set"]')!.textContent).toContain(
      `openclaw mcp set dcal '{"url":"${URL_}","transport":"streamable-http","auth":"oauth"}'`,
    );
    expect($('[data-testid="mcp-openclaw-login"]')!.textContent).toContain('openclaw mcp login dcal');
    await pick('hermes');
    expect($('[data-testid="mcp-hermes-config"]')!.textContent).toContain(`url: "${URL_}"`);
    expect($('[data-testid="mcp-hermes-login"]')!.textContent).toContain('hermes mcp login dcal');
    await pick('cursor');
    expect($('[data-testid="mcp-cursor-deeplink"]')!.getAttribute('href')).toMatch(
      /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=dcal&config=/,
    );
  });

  it('never shows a key, a key variable or the identity provider on any tab', async () => {
    await mount();
    for (const app of APPS) {
      await pick(app);
      expect(host.textContent).not.toMatch(/DAPTA_CALENDARS_API_KEY|Bearer|dcl_[A-Za-z0-9]|Dapta|WorkOS|AuthKit/);
    }
  });

  it('loops a walkthrough one frame per step, lights it, and jumps on a click', async () => {
    vi.useFakeTimers();
    try {
      await mount();
      const d = WALK_DURATIONS.claude;
      expect(walk().dataset.step).toBe('0');
      expect(lit()).toBe(0);
      await act(async () => void vi.advanceTimersByTime(d[0]!));
      expect(walk().dataset.step).toBe('1');
      expect(lit()).toBe(1);
      for (const ms of d.slice(1)) await act(async () => void vi.advanceTimersByTime(ms));
      expect(walk().dataset.step).toBe('0');
      await act(async () => stepButton(2).click());
      expect(walk().dataset.step).toBe('2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes a paused step for what was left of it, so the frame and the progress bar stay together', async () => {
    vi.useFakeTimers();
    try {
      await mount();
      const d = WALK_DURATIONS.claude;
      await act(async () => void vi.advanceTimersByTime(d[0]! - 1000));
      await act(async () => $('[data-testid="mcp-walkthrough-toggle"]')!.click());
      await act(async () => void vi.advanceTimersByTime(30000));
      expect(walk().dataset.step).toBe('0');
      await act(async () => $('[data-testid="mcp-walkthrough-toggle"]')!.click());
      await act(async () => void vi.advanceTimersByTime(1000));
      expect(walk().dataset.step).toBe('1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the pause button one way, pressed while paused', async () => {
    await mount();
    const toggle = $('[data-testid="mcp-walkthrough-toggle"]')!;
    expect(toggle.getAttribute('aria-label')).toBe(copy().media.pause);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-label')).toBe(copy().media.pause);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('pauses only on a click, on the frame or the button, never on the pointer passing over', async () => {
    vi.useFakeTimers();
    try {
      await mount();
      await pick('claude-code');
      const stage = walk().querySelector<HTMLElement>('[role="img"]')!;
      const d = WALK_DURATIONS['claude-code'];
      await act(async () => void stage.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
      await act(async () => void vi.advanceTimersByTime(d[0]!));
      expect(walk().dataset.step).toBe('1');
      await act(async () => stage.click());
      await act(async () => void vi.advanceTimersByTime(20000));
      expect(walk().dataset.step).toBe('1');
      expect($('[data-testid="mcp-walkthrough-toggle"]')!.getAttribute('aria-pressed')).toBe('true');
      await act(async () => $('[data-testid="mcp-walkthrough-toggle"]')!.click());
      await act(async () => void vi.advanceTimersByTime(d[1]!));
      expect(walk().dataset.step).toBe('2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens each app from its first step, fitted to a computer', async () => {
    await mount();
    expect($('[data-testid="mcp-open-claude"]')!.getAttribute('href')).toBe('https://claude.ai/customize/connectors');
    expect($('[data-testid="mcp-open-claude"]')!.getAttribute('target')).toBe('_blank');
    expect($('[data-testid="mcp-open-claude"]')!.getAttribute('rel')).toBe('noopener noreferrer');
    expect($('[data-testid="mcp-open-claude-desktop"]')!.getAttribute('href')).toBe('claude://claude.ai/new');
    await pick('chatgpt');
    expect($('[data-testid="mcp-open-chatgpt"]')!.getAttribute('href')).toBe('https://chatgpt.com/');
    await pick('cursor');
    expect($('[data-testid="mcp-cursor-deeplink"]')).not.toBeNull();
    for (const [app, id, code] of [
      ['claude-code', 'mcp-claude-code-command', `claude mcp add --transport http --scope user dcal ${URL_}`],
      ['codex', 'mcp-codex-add', `codex mcp add dcal --url ${URL_}`],
    ] as const) {
      await pick(app);
      const writeText = vi.fn(async () => undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      await act(async () => $(`[data-testid="${id}-big-copy"]`)!.click());
      expect(writeText).toHaveBeenCalledWith(code);
      expect($(`[data-testid="${id}-big-copy"]`)!.dataset.state).toBe('copied');
    }
    expect($('[data-testid="mcp-phone-note"]')).toBeNull();
  });

  it('says so when the clipboard refuses a copy, on the small buttons and the big one', async () => {
    await mount();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
      configurable: true,
    });
    await act(async () => $('[data-testid="mcp-url-copy"]')!.click());
    expect($('[data-testid="mcp-url-copy"]')!.dataset.state).toBe('failed');
    expect($('[data-testid="mcp-url-copy"] [aria-live]')!.textContent).toBe(copy().copyFailed);
    // The button keeps its name: what it copies.
    expect($('[data-testid="mcp-url-copy"]')!.getAttribute('aria-label')).toBe(copy().copyUrl);
    await pick('codex');
    await act(async () => $('[data-testid="mcp-codex-add-big-copy"]')!.click());
    expect($('[data-testid="mcp-codex-add-big-copy"]')!.dataset.state).toBe('failed');
    expect($('[data-testid="mcp-codex-add-big-copy"] [aria-live]')!.textContent).toBe(copy().copyFailed);
  });

  it('announces a copy once: the live region empties again instead of going back to "Copy"', async () => {
    vi.useFakeTimers();
    try {
      await mount();
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
      await act(async () => $('[data-testid="mcp-url-copy"]')!.click());
      expect($('[data-testid="mcp-url-copy"] [aria-live]')!.textContent).toBe(copy().copied);
      await act(async () => void vi.advanceTimersByTime(2000));
      expect($('[data-testid="mcp-url-copy"] [aria-live]')!.textContent).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no placeholder unfilled on any tab, and says a link opens a new tab', async () => {
    await mount();
    for (const app of APPS) {
      await pick(app);
      for (let i = 0; i < WALK_DURATIONS[app].length; i++) {
        await act(async () => stepButton(i).click());
        expect(host.textContent, `${app} ${i}`).not.toMatch(/\{(product|server|count|app|url|n)\}/);
      }
    }
    await pick('claude');
    expect($('[data-testid="mcp-open-claude"] .sr-only')!.textContent).toContain(copy().open.newTab);
  });

  it('on a phone, keeps the web links and swaps what needs a computer for a note', async () => {
    const restore = asPhone();
    try {
      await mount();
      expect($('[data-testid="mcp-open-claude"]')).not.toBeNull();
      expect($('[data-testid="mcp-open-claude-desktop"]')).toBeNull();
      await pick('chatgpt');
      expect($('[data-testid="mcp-open-chatgpt"]')).not.toBeNull();
      await pick('cursor');
      expect($('[data-testid="mcp-cursor-deeplink"]')).toBeNull();
      expect($('[data-testid="mcp-phone-note"]')!.textContent).toBe('Open this page on your computer to connect Cursor.');
      // The configuration stays, to copy on the computer later.
      expect($('[data-testid="mcp-cursor-json"]')).not.toBeNull();
      await pick('codex');
      expect($('[data-testid="mcp-codex-add-big-copy"]')).toBeNull();
      expect($('[data-testid="mcp-phone-note"]')!.textContent).toContain('Codex');
      await pick('hermes');
      expect($('[data-testid="mcp-hermes-config-big-copy"]')).toBeNull();
      expect($('[data-testid="mcp-hermes-config"]')).not.toBeNull();
    } finally {
      restore();
    }
  });

  it('shows the finished last frame and lights no step with reduced motion', async () => {
    motion(true);
    await mount();
    await pick('openclaw');
    expect(walk().dataset.step).toBe(String(WALK_DURATIONS.openclaw.length - 1));
    expect(lit()).toBe(-1);
    expect($('[data-testid="mcp-walkthrough-toggle"]')).toBeNull();
  });

  it('remembers the picked app in this browser, and ignores a stored value it does not know', async () => {
    await mount();
    await pick('cursor');
    expect(window.localStorage.getItem(APP_KEY)).toBe('cursor');
    expect(APP_KEY).toBe('dcal.mcp.app');
    await act(async () => root.unmount());
    host.remove();
    await mount();
    expect($('[data-testid="mcp-app-cursor"]')!.getAttribute('aria-selected')).toBe('true');
    await act(async () => root.unmount());
    host.remove();
    window.localStorage.setItem(APP_KEY, 'gemini');
    await mount();
    expect($('[data-testid="mcp-app-claude"]')!.getAttribute('aria-selected')).toBe('true');
  });
});

describe('ConnectGuide with a Claude directory listing', () => {
  const steps = (app: string) =>
    [...document.querySelectorAll(`[data-testid="mcp-steps-${app}"] [data-testid="mcp-step"] h3`)].map((h) => h.textContent);

  it('without a listing (the hosted MCP today): the custom connector is Claude\'s path, and Claude Code gets the note', async () => {
    await mount();
    const c = copy();
    expect(steps('claude')).toEqual(c.apps.claude.steps.map((s) => s.title));
    expect($('[data-testid="mcp-claude-directory"]')).toBeNull();
    expect($('[data-testid="mcp-claude-fallback"]')).toBeNull();
    expect($('[data-testid="mcp-open-claude"]')).not.toBeNull();
    expect($('[data-testid="mcp-url"]')!.textContent).toContain(URL_);
    await pick('claude-code');
    expect($('[data-testid="mcp-claude-code-directory"]')).toBeNull();
    expect($('[data-testid="mcp-steps-note"]')!.textContent).toContain('/mcp');
  });

  it('with a listing: starts Claude at it, in a new tab, with the custom connector folded under the steps', async () => {
    await mount('en', LISTING);
    const d = copy().apps.claudeDirectory;
    expect(steps('claude')).toEqual(d.steps.map((s) => s.title));
    const link = $('[data-testid="mcp-claude-directory"]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(LISTING);
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    // The custom connector path is still there, closed, with the URL to paste.
    const fallback = $('[data-testid="mcp-claude-fallback"]') as HTMLDetailsElement;
    expect(fallback.open).toBe(false);
    expect(fallback.textContent).toContain(d.fallbackTitle);
    expect(fallback.querySelector('[data-testid="mcp-url"]')!.textContent).toContain(URL_);
    expect($('[data-testid="mcp-open-claude"]')).toBeNull();
  });

  it('with a listing: draws it in the walkthrough, one frame per step, this product and never Dapta', async () => {
    await mount('es', LISTING);
    const d = copy('es').apps.claudeDirectory;
    expect(d.steps).toHaveLength(WALK_DURATIONS.claude.length);
    const seen: string[] = [];
    for (let i = 0; i < WALK_DURATIONS.claude.length; i++) {
      await act(async () => stepButton(i).click());
      expect(walk().textContent).toContain(d.steps[i]!.title);
      expect(walk().textContent).not.toMatch(/Dapta/i);
      seen.push(walk().textContent ?? '');
    }
    expect(seen[0]).toContain(CONNECTOR_NAME);
    expect(seen[1]).toContain('claude.ai/directory/acme-calendars');
    expect(seen[1]).toContain('Connect');
    expect(seen.join(' ')).not.toContain('Add custom connector');
  });

  it('with a listing: tells Claude Code it may already have the connector, with the way to the listing, in place of the note', async () => {
    await mount('en', LISTING);
    await pick('claude-code');
    const c = copy().apps.claudeCode;
    const card = $('[data-testid="mcp-claude-code-directory"]')!;
    expect(card.textContent).toContain(c.directoryTitle);
    expect(card.querySelector('a')!.getAttribute('href')).toBe(LISTING);
    expect(steps('claude-code')).toEqual(c.steps.map((s) => s.title));
    expect($('[data-testid="mcp-steps-note"]')).toBeNull();
  });

  it('with a listing: keeps the listing button on a phone, where claude.ai opens too', async () => {
    const restore = asPhone();
    try {
      await mount('en', LISTING);
      expect($('[data-testid="mcp-claude-directory"]')).not.toBeNull();
      await pick('claude-code');
      expect($('[data-testid="mcp-phone-note"]')).not.toBeNull();
      expect($('[data-testid="mcp-claude-code-directory"] a')).not.toBeNull();
    } finally {
      restore();
    }
  });
});
