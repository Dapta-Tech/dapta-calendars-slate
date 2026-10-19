// @vitest-environment jsdom
/**
 * The app switcher's rows follow the deployment. The suite URLs are inlined at
 * build time, so each case sets the environment and imports the component
 * fresh: what a build with that environment would ship.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getMessages } from '@slate/shared';

const messages = getMessages('en').admin.common.switcher;
const NAMES = ['NEXT_PUBLIC_PLATFORM_URL', 'NEXT_PUBLIC_FORMS_URL'] as const;
const saved = Object.fromEntries(NAMES.map((k) => [k, process.env[k]]));

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  for (const k of NAMES) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Render the switcher as a build with this environment would, and open it. */
async function openSwitcher(env: Partial<Record<(typeof NAMES)[number], string>>) {
  for (const k of NAMES) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  vi.resetModules();
  const { AppSwitcher } = await import('./app-switcher');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<AppSwitcher messages={messages} />));
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  if (trigger) await act(async () => trigger.click());
  return container;
}

function formsRow(el: HTMLElement): HTMLElement | undefined {
  return [...el.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((r) =>
    r.textContent?.includes(messages.forms),
  );
}

describe('AppSwitcher', () => {
  it('links Forms, in a new tab and tagged, when the deployment says where it is', async () => {
    const el = await openSwitcher({
      NEXT_PUBLIC_PLATFORM_URL: 'https://platform.example.test',
      NEXT_PUBLIC_FORMS_URL: 'https://forms.example.test/',
    });
    const row = formsRow(el)!;
    expect(row.tagName).toBe('A');
    expect(row.getAttribute('aria-disabled')).toBeNull();
    expect(row.getAttribute('target')).toBe('_blank');
    expect(row.getAttribute('rel')).toBe('noopener noreferrer');
    const href = new URL(row.getAttribute('href')!);
    expect(href.origin).toBe('https://forms.example.test');
    expect(href.searchParams.get('utm_source')).toBe('calendars');
    expect(href.searchParams.get('utm_medium')).toBe('app_switcher');
    expect(el.textContent).not.toContain(messages.comingSoon);
  });

  it('says "Coming soon" for Forms only when no Forms URL is set', async () => {
    const el = await openSwitcher({ NEXT_PUBLIC_PLATFORM_URL: 'https://platform.example.test' });
    const row = formsRow(el)!;
    expect(row.tagName).toBe('SPAN');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.getAttribute('href')).toBeNull();
    expect(row.textContent).toContain(messages.comingSoon);
  });

  it('opens with Forms alone when there is no platform to link', async () => {
    const el = await openSwitcher({ NEXT_PUBLIC_FORMS_URL: 'https://forms.example.test' });
    expect(formsRow(el)?.tagName).toBe('A');
    expect(el.textContent).not.toContain('Dapta AI');
  });

  it('renders nothing on a build with no suite at all', async () => {
    const el = await openSwitcher({});
    expect(el.innerHTML).toBe('');
  });
});
