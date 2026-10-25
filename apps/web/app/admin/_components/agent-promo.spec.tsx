// @vitest-environment jsdom
/**
 * The home's "Connect your agent" banner and card: both lead to the connect
 * guide, the banner stays put, the card's typing loop runs on the dForms
 * card's beat and holds still with reduced motion, and every tool chip under
 * an answer is a real tool of the MCP.
 */
import { act, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessages, type Locale } from '@slate/shared';
import { fillMessages } from '@/lib/fill-messages';
import { CONNECTOR_NAME } from '@/lib/product-name';
import { servedTools } from '@/lib/test/mcp-catalog';
import { CONNECT_VARS } from '../developers/connect-vars';

vi.mock('next/link', () => ({
  default: ({ children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));

import { AgentBanner } from './agent-banner';
import { AgentCard, CARD_TOOLS } from './agent-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const home = (l: Locale = 'en') => getMessages(l).admin.home;
const card = (l: Locale = 'en') => fillMessages(home(l).agentCard, CONNECT_VARS);
let root: Root;
let host: HTMLDivElement;
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);

function motion(reduce: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: reduce && q.includes('reduce'),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

async function mount(node: ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(node));
}

beforeEach(() => {
  motion(false);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('AgentBanner', () => {
  it('says what it is for, shows every app logo once to a screen reader, and links to the guide', async () => {
    await mount(<AgentBanner m={home().agentBanner} />);
    expect(host.textContent).toContain(home().agentBanner.title);
    expect($('[data-testid="home-agent-banner-cta"]')!.getAttribute('href')).toBe('/admin/developers/connect');
    const lists = host.querySelectorAll('[data-testid="home-agent-marquee"] ul');
    expect(lists).toHaveLength(2);
    expect(lists[1]!.getAttribute('aria-hidden')).toBe('true');
    expect(lists[0]!.querySelectorAll('svg[data-agent]')).toHaveLength(7);
  });

  it('cannot be closed', async () => {
    await mount(<AgentBanner m={home().agentBanner} />);
    expect($('[data-testid="home-agent-banner-dismiss"]')).toBeNull();
  });
});

describe('AgentCard', () => {
  it('opens on the first prompt, answered, with the guide one click away', async () => {
    await mount(<AgentCard m={card()} />);
    const demo = $('[data-testid="home-agent-demo"]')!;
    expect(demo.textContent).toContain(card().prompts[0]);
    expect(demo.textContent).toContain(card().done);
    expect(demo.dataset.app).toBe('claude');
    expect($('[data-testid="home-agent-card-cta"]')!.getAttribute('href')).toBe('/admin/developers/connect');
  });

  it('names the product, not a placeholder', async () => {
    await mount(<AgentCard m={card()} />);
    expect(host.textContent).not.toMatch(/\{(product|server|count)\}/);
    expect(host.textContent).toContain(`${CONNECTOR_NAME} MCP`);
  });

  it('chips only real MCP tools, one list per prompt in both languages', async () => {
    const served = new Set(servedTools());
    expect(served.size).toBeGreaterThanOrEqual(17);
    for (const tools of CARD_TOOLS) for (const tool of tools) expect(served.has(tool), tool).toBe(true);
    for (const l of ['en', 'es'] as const) expect(card(l).prompts).toHaveLength(CARD_TOOLS.length);
    await mount(<AgentCard m={card()} />);
    const chips = [...host.querySelectorAll('[data-testid="home-agent-tool"]')].map((c) => c.textContent);
    expect(chips).toEqual(CARD_TOOLS[0]!.map((tool) => `dcal · ${tool}`));
  });

  it('erases, then types the next prompt in the next app, with that prompt\'s tools', async () => {
    vi.useFakeTimers();
    try {
      await mount(<AgentCard m={card()} />);
      const demo = () => $('[data-testid="home-agent-demo"]')!;
      for (let i = 0; i < 400 && demo().dataset.phase !== 'typing'; i++) {
        await act(async () => void vi.advanceTimersByTime(100));
      }
      expect(demo().dataset.app).toBe('chatgpt');
      for (let i = 0; i < 400 && demo().dataset.phase === 'typing'; i++) {
        await act(async () => void vi.advanceTimersByTime(40));
      }
      expect(demo().textContent).toContain(card().prompts[1]);
      expect(demo().dataset.phase).toBe('done');
      const chips = [...host.querySelectorAll('[data-testid="home-agent-tool"]')].map((c) => c.textContent);
      expect(chips).toEqual(CARD_TOOLS[1]!.map((tool) => `dcal · ${tool}`));
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives every app its turn, Hermes included, though there are fewer prompts than apps', async () => {
    vi.useFakeTimers();
    try {
      await mount(<AgentCard m={card()} />);
      const demo = () => $('[data-testid="home-agent-demo"]')!;
      const seen = new Set([demo().dataset.app]);
      for (let i = 0; i < 2000 && seen.size < 7; i++) {
        await act(async () => void vi.advanceTimersByTime(100));
        seen.add(demo().dataset.app);
      }
      expect([...seen].sort()).toEqual(['chatgpt', 'claude', 'claude-code', 'codex', 'cursor', 'hermes', 'openclaw']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds still from the keyboard: a real pause button, pressed while paused', async () => {
    vi.useFakeTimers();
    try {
      await mount(<AgentCard m={card()} />);
      const toggle = $('[data-testid="home-agent-demo-toggle"]')!;
      expect(toggle.tagName).toBe('BUTTON');
      expect(toggle.getAttribute('aria-label')).toBe(card().pause);
      await act(async () => toggle.click());
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      expect($('[data-testid="home-agent-demo"]')!.dataset.paused).toBe('true');
      await act(async () => void vi.advanceTimersByTime(30000));
      expect($('[data-testid="home-agent-demo"]')!.dataset.app).toBe('claude');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives every prompt the same time on screen, whatever its length', async () => {
    vi.useFakeTimers();
    try {
      await mount(<AgentCard m={card()} />);
      const demo = () => $('[data-testid="home-agent-demo"]')!;
      const starts: number[] = [];
      let elapsed = 0;
      let last = demo().dataset.app;
      while (starts.length < 4 && elapsed < 60000) {
        await act(async () => void vi.advanceTimersByTime(50));
        elapsed += 50;
        if (demo().dataset.app !== last) {
          last = demo().dataset.app;
          starts.push(elapsed);
        }
      }
      const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
      expect(gaps.length).toBe(3);
      for (const g of gaps) expect(Math.abs(g - gaps[0]!)).toBeLessThanOrEqual(150);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses only on a click, never when the pointer passes over', async () => {
    vi.useFakeTimers();
    try {
      await mount(<AgentCard m={card()} />);
      const demo = () => $('[data-testid="home-agent-demo"]')!;
      await act(async () => void demo().dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
      for (let i = 0; i < 200 && demo().dataset.app === 'claude'; i++) await act(async () => void vi.advanceTimersByTime(100));
      expect(demo().dataset.app).toBe('chatgpt');
      await act(async () => demo().click());
      expect(demo().dataset.paused).toBe('true');
      const before = demo().textContent;
      await act(async () => void vi.advanceTimersByTime(30000));
      expect(demo().dataset.app).toBe('chatgpt');
      expect(demo().textContent).toBe(before);
      await act(async () => demo().click());
      expect(demo().dataset.paused).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds still on the first prompt with reduced motion', async () => {
    motion(true);
    vi.useFakeTimers();
    try {
      await mount(<AgentCard m={card()} />);
      await act(async () => void vi.advanceTimersByTime(30000));
      const demo = $('[data-testid="home-agent-demo"]')!;
      expect(demo.dataset.app).toBe('claude');
      expect(demo.textContent).toContain(card().prompts[0]);
      expect(demo.textContent).toContain(card().done);
    } finally {
      vi.useRealTimers();
    }
  });

  it('speaks Spanish with the Spanish catalog', async () => {
    const es = card('es');
    await mount(<AgentCard m={es} />);
    expect(host.textContent).toContain(es.title);
    expect(host.textContent).toContain(es.prompts[0]);
    expect(host.textContent).toContain(es.done);
  });
});
