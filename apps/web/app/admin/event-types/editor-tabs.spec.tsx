// @vitest-environment jsdom
/**
 * The tabbed event-type editor: four tabs that share one unsaved draft, the
 * Advanced settings disclosure, duration chips, required marks, and the
 * guidance a save gives — the first error's tab opens and its field takes
 * focus, every error is listed with its tab, each tab counts its own, and an
 * API refusal that names a field points at it. Also the unsaved-changes
 * question on the back link, and the read-only AI Agents tab.
 */
import { act, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessages, type Locale } from '@slate/shared';
import type { CrmPropertyCatalog } from '@slate/types';
import type { EventType } from '@/lib/admin-api';

const push = vi.fn();
vi.mock('next/link', () => ({
  default: ({
    children,
    ...rest
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => <a {...rest}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock('@/components/toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), toast: vi.fn() }),
}));
vi.mock('./actions', () => ({
  listOneOffLinksAction: vi.fn(async () => ({ ok: true, links: [] })),
  mintOneOffLinkAction: vi.fn(),
  revokeOneOffLinkAction: vi.fn(),
  saveEventTypeAction: vi.fn(),
  refreshCrmPropertiesAction: vi.fn(),
}));

import { saveEventTypeAction, type EventTypePayload } from './actions';
import { EventTypeForm } from './event-type-form';

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  vi.mocked(saveEventTypeAction).mockReset().mockResolvedValue({ ok: true });
  push.mockReset();
  window.history.replaceState(null, '', '/admin/event-types/et-1');
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const event = (over: Partial<EventType> = {}): EventType => ({
  id: 'et-1',
  memberId: 'mem-1',
  teamId: null,
  slug: 'intro',
  title: 'Intro',
  description: null,
  lengthMinutes: 30,
  location: null,
  hidden: false,
  minimumBookingNotice: 120,
  beforeEventBuffer: 0,
  afterEventBuffer: 0,
  slotInterval: 30,
  schedulingType: null,
  requiresConfirmation: false,
  preventDuplicateBookings: false,
  seatsPerTimeSlot: null,
  bookingFields: [],
  reminders: [],
  hostMemberIds: [],
  hosts: [],
  scheduleId: null,
  conflictCalendarIds: [],
  destinationCalendarId: null,
  crmPropertyMappings: null,
  ...over,
});

const CRM: CrmPropertyCatalog = { provider: 'hubspot', connected: true, properties: [], fetchedAt: null, reason: null };

async function mount(
  initial: EventType | undefined,
  opts: { locale?: Locale; tracking?: boolean; crm?: boolean; mcpUrl?: string | null } = {},
) {
  const locale = opts.locale ?? 'en';
  const msgs = getMessages(locale);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <EventTypeForm
        initial={initial}
        messages={msgs.admin.eventTypes}
        locationLabels={msgs.location}
        backHref="/admin/event-types"
        backLabel="Events"
        heading={initial?.title ?? 'New event'}
        locale={locale}
        trackingEnabled={opts.tracking ?? false}
        crmCatalog={opts.crm ? CRM : undefined}
        mcpUrl={opts.mcpUrl}
      />,
    ),
  );
  return container;
}

const m = getMessages('en').admin.eventTypes;
const tabs = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const tabNamed = (el: HTMLElement, name: string) => tabs(el).find((t) => t.textContent?.startsWith(name))!;
const activeTab = (el: HTMLElement) => el.querySelector('[role="tab"][aria-selected="true"]')!.textContent;
const byId = <T extends HTMLElement = HTMLInputElement>(el: HTMLElement, id: string) => el.querySelector<T>(`#${id}`)!;
const click = (b: HTMLElement) => act(async () => b.click());
async function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const save = (el: HTMLElement) => click(el.querySelector<HTMLButtonElement>('button[type="submit"]')!);
const saved = () => vi.mocked(saveEventTypeAction).mock.lastCall?.[0] as EventTypePayload | undefined;
const summary = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-testid="et-error-summary"]');

describe('tabs', () => {
  it('shows General, Reminders, CRM Connection and AI Agents, in that order, General first', async () => {
    const el = await mount(undefined, { crm: true });
    expect(tabs(el).map((t) => t.textContent)).toEqual(['General', 'Reminders', 'CRM Connection', 'AI Agents']);
    expect(activeTab(el)).toBe('General');
  });

  it('hides CRM Connection when there is no CRM and no tracking', async () => {
    const el = await mount(event());
    expect(tabs(el).map((t) => t.textContent)).toEqual(['General', 'Reminders', 'AI Agents']);
  });

  it('shows CRM Connection for tracking alone', async () => {
    const el = await mount(event(), { tracking: true });
    expect(tabs(el).map((t) => t.textContent)).toContain('CRM Connection');
  });

  it('opens the tab named in the URL, and writes the tab it switches to', async () => {
    window.history.replaceState(null, '', '/admin/event-types/et-1?tab=reminders');
    const el = await mount(event());
    expect(activeTab(el)).toBe('Reminders');
    await click(tabNamed(el, 'AI Agents'));
    expect(window.location.search).toBe('?tab=agents');
    await click(tabNamed(el, 'General'));
    expect(window.location.search).toBe('');
  });

  it('keeps unsaved input across tab switches', async () => {
    const el = await mount(event());
    await typeInto(byId(el, 'et-title'), 'Renamed call');
    await click(tabNamed(el, 'Reminders'));
    await click(tabNamed(el, 'General'));
    expect(byId(el, 'et-title').value).toBe('Renamed call');
    await save(el);
    expect(saved()?.title).toBe('Renamed call');
  });
});

describe('Advanced settings', () => {
  const toggle = (el: HTMLElement) =>
    [...el.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((b) =>
      b.textContent?.startsWith(m.editor.advanced.title),
    )!;

  it('is collapsed on create and says the settings are the defaults', async () => {
    const el = await mount(undefined);
    expect(toggle(el).getAttribute('aria-expanded')).toBe('false');
    expect(toggle(el).textContent).toContain(m.editor.advanced.allDefault);
    // Collapsed, its fields still exist (a save can open it and focus one).
    expect(byId(el, 'et-buffer-before')).not.toBeNull();
  });

  it('opens on an event with advanced values, and the collapsed summary names them', async () => {
    const el = await mount(event({ beforeEventBuffer: 10, bookingWindowDays: 30 }));
    expect(toggle(el).getAttribute('aria-expanded')).toBe('true');
    await click(toggle(el));
    expect(toggle(el).textContent).toContain('10 min before · up to 30 days ahead');
  });

  it('opens and focuses the field when a save finds an error inside it', async () => {
    const el = await mount(event());
    await typeInto(byId(el, 'et-seats'), '0');
    await save(el);
    expect(saveEventTypeAction).not.toHaveBeenCalled();
    expect(toggle(el).getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(byId(el, 'et-seats'));
    expect(byId(el, 'et-seats').getAttribute('aria-invalid')).toBe('true');
  });
});

describe('duration', () => {
  it('a preset is one click, and the slot interval follows it while it matched', async () => {
    const el = await mount(event());
    const chip = [...el.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(
      (b) => b.textContent === '45 min',
    )!;
    await click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    await save(el);
    expect(saved()?.lengthMinutes).toBe(45);
    expect(saved()?.slotInterval).toBe(45);
  });

  it('a stored length that is not a preset opens on Custom and saves unchanged', async () => {
    const el = await mount(event({ lengthMinutes: 25, slotInterval: 25 }));
    const custom = [...el.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(
      (b) => b.textContent === m.editor.duration.custom,
    )!;
    expect(custom.getAttribute('aria-pressed')).toBe('true');
    expect(byId(el, 'et-duration').value).toBe('25');
    await save(el);
    expect(saved()?.lengthMinutes).toBe(25);
  });
});

describe('required fields and guidance', () => {
  it('marks Title, Event link and Duration as required, once, with a legend', async () => {
    const el = await mount(undefined);
    expect(el.textContent).toContain(m.editor.requiredLegend);
    const titleLabel = byId(el, 'et-title').closest('label')!;
    expect(titleLabel.textContent).toContain('*');
    expect(titleLabel.textContent).toContain(`(${m.editor.required})`);
    expect(byId(el, 'et-slug').closest('label')!.textContent).toContain(m.editor.slugLabel);
    expect(el.querySelector('fieldset legend')!.textContent).toContain('*');
  });

  it('a location kind that needs a detail makes the detail required', async () => {
    const el = await mount(event({ location: { kind: 'in_person', detail: null } }));
    expect(byId(el, 'et-location-detail').closest('label')!.textContent).toContain('*');
    await save(el);
    expect(saveEventTypeAction).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(byId(el, 'et-location-detail'));
  });

  it('shows no error while typing for the first time, then after the field is left', async () => {
    const el = await mount(undefined);
    const title = byId(el, 'et-title');
    await typeInto(title, 'x');
    await typeInto(title, '');
    expect(title.getAttribute('aria-invalid')).toBeNull();
    await act(async () => title.dispatchEvent(new FocusEvent('blur')));
    await act(async () => title.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(title.getAttribute('aria-invalid')).toBe('true');
  });

  it('Save stays enabled; a save from AI Agents with no title opens General and focuses Title', async () => {
    const el = await mount(undefined);
    await click(tabNamed(el, 'AI Agents'));
    const submit = el.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(false);
    await save(el);
    expect(saveEventTypeAction).not.toHaveBeenCalled();
    expect(activeTab(el)).toContain('General');
    expect(document.activeElement).toBe(byId(el, 'et-title'));
    expect(byId(el, 'et-title-error').textContent).toBe(m.editor.errors.titleRequired);
    expect(summary(el)!.getAttribute('role')).toBe('alert');
  });

  it('lists errors from two tabs with their names, counts them per tab, and each item goes to its field', async () => {
    const el = await mount(event({ title: '' }), { tracking: true });
    await click(tabNamed(el, 'CRM Connection'));
    await typeInto(byId(el, 'et-tracking-metaPixelId'), 'not-a-pixel');
    await save(el);
    const items = [...summary(el)!.querySelectorAll('button')].map((b) => b.textContent);
    expect(items).toEqual([`General: ${m.editor.errors.titleRequired}`, `CRM Connection: ${m.editor.errors.trackingInvalid}`]);
    expect(tabNamed(el, 'General').textContent).toContain('1');
    expect(tabNamed(el, 'General').textContent).toContain(m.editor.tabErrorsOne);
    expect(tabNamed(el, 'CRM Connection').textContent).toContain('1');
    await click([...summary(el)!.querySelectorAll('button')][1]!);
    expect(activeTab(el)).toContain('CRM Connection');
    expect(document.activeElement).toBe(byId(el, 'et-tracking-metaPixelId'));
  });

  it('a valid save is sent as before', async () => {
    const el = await mount(event());
    await save(el);
    expect(saveEventTypeAction).toHaveBeenCalledTimes(1);
    expect(summary(el)).toBeNull();
  });
});

describe('API refusals that name a field', () => {
  it('a taken link points at the link field', async () => {
    vi.mocked(saveEventTypeAction).mockResolvedValueOnce({ ok: false, code: 'SLUG_TAKEN', message: 'That slug is already in use.' });
    const el = await mount(undefined);
    await typeInto(byId(el, 'et-title'), 'Intro');
    await click(tabNamed(el, 'Reminders'));
    await save(el);
    expect(activeTab(el)).toContain('General');
    expect(document.activeElement).toBe(byId(el, 'et-slug'));
    expect(byId(el, 'et-slug-error').textContent).toBe(m.editor.errors.slugTaken);
    expect(summary(el)!.textContent).toContain(`General: ${m.editor.errors.slugTaken}`);
  });

  it('a rejected reminder template opens Reminders at that field', async () => {
    const reminders = [{ id: 'r1', kind: 'reminder' as const, enabled: true, leadMinutes: 60, subject: '{{nope}}', body: null }];
    vi.mocked(saveEventTypeAction).mockResolvedValueOnce({
      ok: false,
      code: 'INVALID_TEMPLATE',
      message: 'Reminder 1 subject: unknown variable {{nope}}',
      issues: [{ field: 'subject', reminderId: 'r1', message: 'Unknown variable {{nope}}' }],
    });
    const el = await mount(event({ reminders }));
    await save(el);
    expect(activeTab(el)).toContain('Reminders');
    expect(document.activeElement).toBe(byId(el, 'et-reminder-r1-subject'));
    expect(summary(el)!.textContent).toContain('Reminders: Unknown variable {{nope}}');
  });

  it('a refusal about no field shows as text in the summary', async () => {
    vi.mocked(saveEventTypeAction).mockResolvedValueOnce({ ok: false, message: 'Service unavailable' });
    const el = await mount(event());
    await save(el);
    expect(summary(el)!.textContent).toContain('Service unavailable');
  });
});

describe('unsaved changes', () => {
  const back = (el: HTMLElement) => el.querySelector<HTMLAnchorElement>('a[href="/admin/event-types"]')!;
  const dialogButton = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);

  it('leaves at once when nothing changed', async () => {
    const el = await mount(event());
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => back(el).dispatchEvent(evt));
    expect(evt.defaultPrevented).toBe(false);
    expect(dialogButton(m.editor.unsaved.confirm)).toBeUndefined();
  });

  it('asks before leaving with changes; Keep editing stays, Discard leaves', async () => {
    const el = await mount(event());
    await typeInto(byId(el, 'et-title'), 'Changed');
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => back(el).dispatchEvent(evt));
    expect(evt.defaultPrevented).toBe(true);
    await click(dialogButton(m.editor.unsaved.cancel)!);
    expect(push).not.toHaveBeenCalled();
    expect(byId(el, 'et-title').value).toBe('Changed');
    await act(async () => back(el).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    await click(dialogButton(m.editor.unsaved.confirm)!);
    expect(push).toHaveBeenCalledWith('/admin/event-types');
  });
});

describe('AI Agents tab', () => {
  it('a saved event shows its ID, a prompt naming it, and the MCP address', async () => {
    const el = await mount(event(), { mcpUrl: 'https://mcp.example.test/mcp' });
    const panel = el.querySelector<HTMLElement>('#et-panel-agents')!;
    expect(panel.textContent).toContain('et-1');
    expect(panel.textContent).toContain(m.editor.agents.prompt.replace('{title}', 'Intro'));
    expect(panel.textContent).toContain('https://mcp.example.test/mcp');
    expect(panel.querySelector('a')!.getAttribute('href')).toBe('/admin/developers/connect');
  });

  it('a new event says the ID comes after the first save; no MCP address says so', async () => {
    const el = await mount(undefined, { mcpUrl: null });
    const panel = el.querySelector<HTMLElement>('#et-panel-agents')!;
    expect(panel.textContent).toContain(m.editor.agents.eventIdPending);
    expect(panel.textContent).toContain(m.editor.agents.mcpUnavailable);
  });

  it('is in Spanish on a Spanish editor', async () => {
    const es = getMessages('es').admin.eventTypes.editor;
    const el = await mount(event(), { locale: 'es' });
    expect(tabs(el).map((t) => t.textContent)).toEqual([es.tabs.general, es.tabs.reminders, es.tabs.agents]);
    expect(el.querySelector('#et-panel-agents')!.textContent).toContain(es.agents.title);
  });
});
