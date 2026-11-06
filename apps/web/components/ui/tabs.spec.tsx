// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TabPanel, Tabs } from './tabs';

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
});

const ITEMS = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta', badge: 2, badgeLabel: '2 fields need attention' },
  { id: 'c', label: 'Gamma' },
] as const;

function Harness() {
  const [active, setActive] = useState<'a' | 'b' | 'c'>('a');
  return (
    <>
      <Tabs items={ITEMS} active={active} onChange={setActive} idPrefix="t" label="Settings" />
      {ITEMS.map((t) => (
        <TabPanel key={t.id} id={t.id} idPrefix="t" active={active === t.id}>
          <input aria-label={`${t.label} field`} />
        </TabPanel>
      ))}
    </>
  );
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Harness />));
  return container;
}

const tabs = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const key = (el: Element, k: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });

describe('Tabs', () => {
  it('wires tabs to panels and keeps only the selected tab in the Tab order', async () => {
    const el = await mount();
    const [a, b] = tabs(el);
    expect(el.querySelector('[role="tablist"]')!.getAttribute('aria-label')).toBe('Settings');
    expect(a!.getAttribute('aria-selected')).toBe('true');
    expect(a!.tabIndex).toBe(0);
    expect(b!.tabIndex).toBe(-1);
    const panel = el.querySelector<HTMLElement>(`#${a!.getAttribute('aria-controls')}`)!;
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(a!.id);
    expect(panel.hidden).toBe(false);
    // Hidden panels stay mounted: their fields exist and can be focused by id.
    expect(el.querySelectorAll('input')).toHaveLength(3);
  });

  it('moves with the arrow keys, Home and End, wrapping at the ends', async () => {
    const el = await mount();
    const list = el.querySelector('[role="tablist"]')!;
    await key(list, 'ArrowRight');
    expect(tabs(el)[1]!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs(el)[1]);
    await key(list, 'End');
    expect(tabs(el)[2]!.getAttribute('aria-selected')).toBe('true');
    await key(list, 'ArrowRight');
    expect(tabs(el)[0]!.getAttribute('aria-selected')).toBe('true');
    await key(list, 'ArrowLeft');
    expect(tabs(el)[2]!.getAttribute('aria-selected')).toBe('true');
    await key(list, 'Home');
    expect(tabs(el)[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('shows a badge with an accessible meaning, and switches panels on click', async () => {
    const el = await mount();
    const b = tabs(el)[1]!;
    expect(b.textContent).toContain('2');
    expect(b.textContent).toContain('2 fields need attention');
    await act(async () => b.click());
    expect(el.querySelector<HTMLElement>('#t-panel-b')!.hidden).toBe(false);
    expect(el.querySelector<HTMLElement>('#t-panel-a')!.hidden).toBe(true);
  });
});
