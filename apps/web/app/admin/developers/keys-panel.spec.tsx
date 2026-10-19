// @vitest-environment jsdom
/**
 * MCP, Connect and keys: the three-step guide above the key list. A step is
 * done from what the page can know (a working key; a key used, or an app signed
 * in), the guide's Create and the list's Create open the same dialog, and only
 * one of them shows at a time (R30: one create action per screen).
 */
import { act, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getMessages } from '@slate/shared';
import type { ApiKeyRow } from '@/lib/admin-api';

vi.mock('next/link', () => ({
  default: ({ children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock('./actions', () => ({
  createApiKeyAction: vi.fn(),
  revokeApiKeyAction: vi.fn(),
  createWebhookAction: vi.fn(),
  deleteWebhookAction: vi.fn(),
  pingWebhookAction: vi.fn(),
  webhookDeliveriesAction: vi.fn(),
  toggleWebhookAction: vi.fn(),
  revokeConnectedAppAction: vi.fn(),
}));

import { createApiKeyAction } from './actions';
import type { ConnectSnippets } from './connect-agent';
import { isWorkingKey, KeysPanel } from './keys-panel';

const NOW = Date.UTC(2026, 9, 19, 12);
const DAY = 86_400_000;
const m = getMessages('en').admin.developer;
const SNIPPETS: ConnectSnippets = {
  mcpUrl: 'https://calendar.example.test/mcp',
  cursorDeeplink: 'cursor://anysphere.cursor-deeplink/mcp/install?name=x&config=e30',
  cursorJson: '{}',
  claudeCode: 'claude mcp add',
  codexToml: '[mcp_servers]',
  exportKey: 'export DAPTA_CALENDARS_API_KEY="dcl_your_key_here"',
  header: 'Authorization: Bearer $DAPTA_CALENDARS_API_KEY',
  claudeConnector: 'https://claude.ai/settings/connectors',
};

const key = (over: Partial<ApiKeyRow> = {}): ApiKeyRow => ({
  id: 'k1',
  name: 'Cursor',
  prefix: 'dcl_ab',
  last4: 'wxyz',
  revoked_at_ms: null,
  scopes: ['availability:read'],
  eventTypeIds: [],
  expiresAt: null,
  lastUsedAt: null,
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(
  opts: {
    keys?: ApiKeyRow[];
    appsConnected?: boolean;
    snippets?: ConnectSnippets | null;
    mcpAvailable?: boolean;
    skillAvailable?: boolean;
  } = {},
) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <KeysPanel
        keys={opts.keys ?? []}
        eventTypes={[]}
        now={NOW}
        mcpAvailable={opts.mcpAvailable ?? true}
        snippets={opts.snippets === undefined ? SNIPPETS : opts.snippets}
        oauth={false}
        external={false}
        appsConnected={opts.appsConnected ?? false}
        productName="Dapta Calendars"
        docsLabel="API docs"
        skillAvailable={opts.skillAvailable ?? true}
        messages={m}
        locale="en"
      />,
    ),
  );
  return host;
}

const step = (el: HTMLElement, id: 'key' | 'agent' | 'try') => el.querySelector<HTMLElement>(`[data-testid="setup-step-${id}"]`)!;
const createButtons = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('button')).filter((b) => b.textContent === m.createKey);

describe('isWorkingKey', () => {
  it('is a key that is neither revoked nor past its expiry', () => {
    expect(isWorkingKey(key(), NOW)).toBe(true);
    expect(isWorkingKey(key({ expiresAt: NOW + DAY }), NOW)).toBe(true);
    expect(isWorkingKey(key({ revoked_at_ms: NOW - DAY }), NOW)).toBe(false);
    expect(isWorkingKey(key({ expiresAt: NOW - DAY }), NOW)).toBe(false);
  });
});

describe('KeysPanel', () => {
  it('with no key: step 1 holds the one Create, and it opens the key dialog', async () => {
    const el = await mount();
    expect(step(el, 'key').hasAttribute('data-done')).toBe(false);
    expect(step(el, 'key').textContent).toContain(m.guideKeyBody);
    // One create action on the screen: the guide's, not the list's as well.
    expect(createButtons(el)).toHaveLength(1);
    expect(createButtons(el)[0]!.closest('[data-testid="setup-step-key"]')).not.toBeNull();

    await act(async () => el.querySelector<HTMLButtonElement>('[data-testid="setup-create-key"]')!.click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain(m.scopesLead);
  });

  it('brings a key made from step 1 into view and focus: it is shown once, below the guide', async () => {
    vi.mocked(createApiKeyAction).mockResolvedValue({ plaintext: 'dcl_test_once' });
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const el = await mount();
    await act(async () => el.querySelector<HTMLButtonElement>('[data-testid="setup-create-key"]')!.click());

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const name = dialog.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Cursor');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const create = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === m.createKey)!;
    await act(async () => create.click());

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const reveal = el.querySelector<HTMLElement>('[data-testid="api-key-reveal"]')!;
    expect(reveal.textContent).toContain('dcl_test_once');
    expect(document.activeElement).toBe(reveal);
    expect(scrolled.mock.contexts[0]).toBe(reveal);
  });

  it('with a working key: step 1 is done and the list keeps the one Create', async () => {
    const el = await mount({ keys: [key()] });
    expect(step(el, 'key').hasAttribute('data-done')).toBe(true);
    expect(step(el, 'key').textContent).toContain(m.guideKeyDone);
    expect(step(el, 'key').querySelector('.sr-only')!.textContent).toContain(m.guideStepDone);
    expect(el.querySelector('[data-testid="setup-create-key"]')).toBeNull();
    expect(createButtons(el)).toHaveLength(1);
    expect(createButtons(el)[0]!.closest('[data-testid="setup-guide"]')).toBeNull();
  });

  it('does not count a revoked or expired key as having one', async () => {
    const el = await mount({ keys: [key({ revoked_at_ms: NOW - DAY }), key({ id: 'k2', expiresAt: NOW - DAY })] });
    expect(step(el, 'key').hasAttribute('data-done')).toBe(false);
    expect(el.querySelector('[data-testid="setup-create-key"]')).not.toBeNull();
  });

  it('marks step 2 done once a working key has been used, or an app has signed in', async () => {
    let el = await mount({ keys: [key()] });
    expect(step(el, 'agent').hasAttribute('data-done')).toBe(false);
    expect(step(el, 'agent').textContent).toContain(m.guideAgentBody);
    act(() => root?.unmount());
    host?.remove();

    el = await mount({ keys: [key({ lastUsedAt: NOW - DAY })] });
    expect(step(el, 'agent').hasAttribute('data-done')).toBe(true);
    expect(step(el, 'agent').textContent).toContain(m.guideAgentDone);
    act(() => root?.unmount());
    host?.remove();

    // A revoked key that was used once says nothing about today.
    el = await mount({ keys: [key({ lastUsedAt: NOW - DAY, revoked_at_ms: NOW })] });
    expect(step(el, 'agent').hasAttribute('data-done')).toBe(false);
    act(() => root?.unmount());
    host?.remove();

    el = await mount({ appsConnected: true });
    expect(step(el, 'agent').hasAttribute('data-done')).toBe(true);
  });

  it('puts the agent tabs in step 2, with the deployment’s MCP address', async () => {
    const el = await mount();
    const agent = step(el, 'agent');
    expect(agent.querySelector('[role="tablist"]')).not.toBeNull();
    expect(agent.textContent).toContain(SNIPPETS.mcpUrl);
  });

  it('with MCP off: one sentence, no steps, no address, and the list keeps the one Create', async () => {
    const el = await mount({ mcpAvailable: false, snippets: null });
    const guide = el.querySelector<HTMLElement>('[data-testid="setup-guide"]')!;
    expect(guide.getAttribute('data-mcp')).toBe('off');
    expect(guide.querySelector('h2')!.textContent).toBe(m.connectTitle);
    expect(guide.textContent).toContain(m.mcpUnavailable);
    expect(guide.querySelector('ol')).toBeNull();
    expect(guide.querySelector('[role="tablist"]')).toBeNull();
    expect(el.textContent).not.toContain(SNIPPETS.mcpUrl);
    expect(createButtons(el)).toHaveLength(1);
    expect(createButtons(el)[0]!.closest('[data-testid="setup-guide"]')).toBeNull();
  });

  it('says so in step 2 when the deployment has no public MCP address', async () => {
    const el = await mount({ snippets: null });
    expect(step(el, 'agent').textContent).toContain(m.mcpUrlMissing);
  });

  it('gives step 3 a prompt naming the product, and links what each tool needs', async () => {
    const el = await mount();
    const tryIt = step(el, 'try');
    expect(tryIt.querySelector('code')!.textContent).toBe(
      'Use the Dapta Calendars MCP to tell me which workspace you are connected to and what you are allowed to do there.',
    );
    expect(tryIt.querySelector('a')!.getAttribute('href')).toBe('/admin/developers/docs');
    // Step 3 is never "done": the page cannot know an agent was asked something.
    expect(tryIt.hasAttribute('data-done')).toBe(false);
  });

  it('closes the guide with the skill download, for an agent without MCP', async () => {
    const el = await mount();
    const guide = el.querySelector<HTMLElement>('[data-testid="setup-guide"]')!;
    const skill = guide.querySelector<HTMLElement>('[data-testid="setup-skill"]')!;
    // Under the three steps, the last thing in the guide's card.
    expect(guide.lastElementChild).toBe(skill);
    expect(skill.querySelector('h3')!.textContent).toBe(m.guideSkillTitle);
    expect(skill.textContent).toContain(
      'Download the skill: a zip that teaches any agent with a terminal to use the Dapta Calendars API with the same key.',
    );
    // A button that fetches the zip (skill-download.spec.tsx has its states), not a bare link.
    const download = skill.querySelector<HTMLButtonElement>('button[data-testid="setup-skill-download"]')!;
    expect(download.textContent).toBe(m.guideSkillButton);
    expect(skill.querySelector('a')).toBeNull();
    expect(skill.querySelector('[data-testid="setup-skill-unavailable"]')).toBeNull();
  });

  it('says the skill is not available instead of offering a download that would fail', async () => {
    const el = await mount({ skillAvailable: false });
    const skill = el.querySelector<HTMLElement>('[data-testid="setup-skill"]')!;
    expect(skill.querySelector('[data-testid="setup-skill-download"]')).toBeNull();
    expect(skill.querySelector('button, a')).toBeNull();
    expect(skill.querySelector('[data-testid="setup-skill-unavailable"]')!.textContent).toBe(m.guideSkillUnavailable);
  });
});
