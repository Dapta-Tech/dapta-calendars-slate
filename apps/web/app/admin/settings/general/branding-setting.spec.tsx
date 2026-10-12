// @vitest-environment jsdom
/**
 * Settings → General, "Show Dapta branding on my pages": the three states a
 * host can be in (on, off while paying, off but lapsed), the account that is
 * not paying, and a member's read-only view, in English and Spanish. Clicking
 * the switch stores the choice through the server action.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getMessages } from '@slate/shared';

const actions = vi.hoisted(() => ({ saveBrandingAction: vi.fn() }));
vi.mock('./actions', () => actions);

import { BrandingSetting, brandingMode, type BrandingState } from './branding-setting';

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
  vi.clearAllMocks();
});

const PLATFORM = 'https://platform.example.test/';

function mount(initial: BrandingState, opts: { canEdit?: boolean; locale?: 'en' | 'es'; platformUrl?: string | null } = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <BrandingSetting
        initial={initial}
        canEdit={opts.canEdit ?? true}
        platformUrl={opts.platformUrl === undefined ? PLATFORM : opts.platformUrl}
        messages={getMessages(opts.locale ?? 'en').admin.brandingSetting}
      />,
    ),
  );
  const sw = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  const chip = container.querySelector('[data-testid="branding-chip"]')!;
  return { el: container, sw, chip };
}

const ON: BrandingState = { hideBranding: false, canHide: true, showing: true };
const OFF: BrandingState = { hideBranding: true, canHide: true, showing: false };
const LAPSED: BrandingState = { hideBranding: true, canHide: false, showing: true };
const NOT_PAYING: BrandingState = { hideBranding: false, canHide: false, showing: true };

describe('brandingMode', () => {
  it('names the three states', () => {
    expect(brandingMode(ON)).toBe('on');
    expect(brandingMode(NOT_PAYING)).toBe('on');
    expect(brandingMode(OFF)).toBe('off');
    expect(brandingMode(LAPSED)).toBe('lapsed');
  });
});

describe('BrandingSetting', () => {
  const en = getMessages('en').admin.brandingSetting;
  const es = getMessages('es').admin.brandingSetting;

  it('on (the default), for a paying owner: the switch is on and usable', () => {
    const { sw, chip, el } = mount(ON);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.disabled).toBe(false);
    expect(sw.getAttribute('aria-label')).toBe(en.switchLabel);
    expect(chip.textContent).toBe(en.chipShowing);
    expect(el.querySelector('[data-testid="branding-included"]')).toBeNull();
    expect(el.querySelector('[data-testid="branding-lapsed"]')).toBeNull();
  });

  it('off while paying: the switch is off and usable, the chip says hidden', () => {
    const { sw, chip } = mount(OFF);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.disabled).toBe(false);
    expect(chip.textContent).toBe(en.chipHidden);
    expect(chip.getAttribute('data-status')).toBe('confirmed');
  });

  it('off but lapsed: the stored choice shows greyed, with the sentence that the branding is back', () => {
    const { sw, chip, el } = mount(LAPSED);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.disabled).toBe(true);
    expect(chip.textContent).toBe(en.chipShowingAgain);
    expect(chip.getAttribute('data-status')).toBe('pending');
    expect(el.querySelector('[data-testid="branding-lapsed"]')!.textContent).toBe(
      'Your Dapta AI subscription ended, the branding is showing again',
    );
  });

  it('not paying: the switch is disabled, with the included sentence linked to the Dapta AI app', () => {
    const { sw, el } = mount(NOT_PAYING);
    expect(sw.disabled).toBe(true);
    const link = el.querySelector<HTMLAnchorElement>('[data-testid="branding-included"] a')!;
    expect(link.textContent).toBe('Included with your Dapta AI subscription');
    expect(link.getAttribute('href')).toBe(PLATFORM);
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('with no platform URL configured, the sentence stands without a link', () => {
    const { el } = mount(NOT_PAYING, { platformUrl: null });
    const note = el.querySelector('[data-testid="branding-included"]')!;
    expect(note.querySelector('a')).toBeNull();
    expect(note.textContent).toBe(en.included);
  });

  it('a member reads it and cannot change it', () => {
    const { sw, el } = mount(ON, { canEdit: false });
    expect(sw.disabled).toBe(true);
    expect(el.textContent).toContain(en.membersReadOnly);
  });

  it('speaks Spanish', () => {
    const { el, chip } = mount(LAPSED, { locale: 'es' });
    expect(el.textContent).toContain('Marca de Dapta');
    expect(el.textContent).toContain('Tu suscripción de Dapta AI terminó, la marca se muestra de nuevo');
    expect(chip.textContent).toBe(es.chipShowingAgain);
    act(() => root!.unmount());
    const second = mount(NOT_PAYING, { locale: 'es' });
    expect(second.el.textContent).toContain('Incluido con tu suscripción de Dapta AI');
  });

  it('turning it off stores the choice and shows the new state', async () => {
    actions.saveBrandingAction.mockResolvedValue({ ok: true, branding: OFF });
    const { sw, chip } = mount(ON);
    await act(async () => sw.click());
    expect(actions.saveBrandingAction).toHaveBeenCalledWith(true);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(chip.textContent).toBe(en.chipHidden);
  });

  it('a refused save leaves the switch where it was', async () => {
    actions.saveBrandingAction.mockResolvedValue({ ok: false });
    const { sw } = mount(ON);
    await act(async () => sw.click());
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });
});
