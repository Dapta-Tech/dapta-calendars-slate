// @vitest-environment jsdom
/**
 * The booking page's time zone control, driven the way a visitor drives it:
 * open it, type, arrow, Enter, Escape. And the event panel's two pieces of
 * life that only show under a browser's layout: "Show more" past four lines,
 * and the host's zone said as theirs.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getMessages } from '@slate/shared';
import { ZonePicker } from './zone-picker';
import { EventPanel } from './booking-page-parts';

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no layout engine; `scrollIntoView` is a no-op there.
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

function mount(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

function key(el: Element, k: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
}

function type(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ZonePicker', () => {
  const open = (onChange = vi.fn(), value = 'America/Bogota', locale = 'en') => {
    const c = mount(<ZonePicker id="tz" value={value} onChange={onChange} locale={locale} ariaLabel="Time zone" />);
    const trigger = c.querySelector<HTMLButtonElement>('#tz')!;
    act(() => trigger.click());
    const search = c.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    return { c, trigger, search, onChange };
  };

  it('opens on the search field, the shown zone pinned first and marked by ink, not a slab', () => {
    const { c, search } = open();
    expect(document.activeElement).toBe(search);
    expect(search.className).toBe('bp-input');
    const rows = [...c.querySelectorAll('[role="option"]')];
    expect(rows[0]!.textContent).toContain('America/Bogota');
    expect(rows[0]!.getAttribute('aria-selected')).toBe('true');
    expect(rows[0]!.querySelector('.bp-zone-mark svg')).not.toBeNull();
    // Every offset is a figure on the row, and the admin's slab never appears.
    expect(rows[0]!.querySelector('.bp-zone-row-offset')!.textContent).toMatch(/^GMT/);
    expect(c.innerHTML).not.toMatch(/bg-primary|text-primary-foreground/);
    expect(c.querySelector('.bp-zone-group')!.textContent).toBe(getMessages('en').bookingPage.zoneCurrent);
  });

  it('filters as the visitor types, then arrows and Enter choose', () => {
    const { c, search, onChange, trigger } = open();
    type(search, 'tokyo');
    const rows = [...c.querySelectorAll('[role="option"]')];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => /tokyo/i.test(r.textContent ?? ''))).toBe(true);
    expect(c.querySelector('.bp-zone-group')).toBeNull();
    key(search, 'Enter');
    expect(onChange).toHaveBeenCalledWith('Asia/Tokyo');
    expect(c.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('walks the list with the arrows and marks the cursor row', () => {
    const { c, search, onChange } = open();
    key(search, 'ArrowDown');
    key(search, 'ArrowDown');
    const active = c.querySelector('[data-active="true"]')!;
    expect(search.getAttribute('aria-activedescendant')).toBe(active.id);
    key(search, 'ArrowUp');
    key(search, 'Enter');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape without choosing, and the Escape stops there', () => {
    const outer = vi.fn();
    window.addEventListener('keydown', outer);
    const { c, search, onChange, trigger } = open();
    key(search, 'Escape');
    window.removeEventListener('keydown', outer);
    expect(onChange).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
    expect(c.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('says it has nothing when nothing matches, in the visitor language', () => {
    const { c, search } = open(vi.fn(), 'America/Bogota', 'es');
    type(search, 'zzzz');
    expect(c.querySelector('.bp-zone-empty')!.textContent).toBe(getMessages('es').tzPicker.noResults);
  });
});

describe('EventPanel', () => {
  const m = getMessages('en');
  const panel = (description: string) => (
    <EventPanel
      m={m}
      hostName="Riley Chen"
      eventTitle="Intro call"
      description={description}
      lengthMinutes={30}
      location={{ kind: 'conferencing' }}
      locationLabel="Online meeting"
      timeZoneLabel="America/New York"
    />
  );

  it('says whose zone it is, and draws the location with its icon', () => {
    const c = mount(panel('Short.'));
    expect(c.textContent).toContain("America/New York, the host's time");
    expect(c.textContent).toContain('Online meeting');
  });

  it('offers "Show more" only when the description runs past its four lines', () => {
    const c = mount(panel('Short.'));
    expect(c.querySelector('.bp-description .bp-link')).toBeNull();

    act(() => root!.unmount());
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(80);
    const long = mount(panel('A long agenda.\n'.repeat(12)));
    const toggle = long.querySelector<HTMLButtonElement>('.bp-description .bp-link')!;
    expect(toggle.textContent).toBe(m.bookingPage.descriptionMore);
    act(() => toggle.click());
    expect(long.querySelector('.bp-description-text')!.getAttribute('data-expanded')).toBe('true');
    expect(long.querySelector('.bp-description .bp-link')!.textContent).toBe(m.bookingPage.descriptionLess);
  });
});
