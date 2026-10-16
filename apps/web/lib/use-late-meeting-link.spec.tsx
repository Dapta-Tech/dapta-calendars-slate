// @vitest-environment jsdom
/**
 * F5: the confirmation screen's calendar file of an online meeting. The room is
 * minted after the booking answers, so the screen asks for the link until it
 * exists, a bounded number of times.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BookingView } from '@slate/types';
import { awaitsMeetingLink, manageTokenOf, useLateMeetingLink } from './use-late-meeting-link';

const confirmedOnline = {
  uid: 'bk_1',
  status: 'accepted',
  locationKind: 'conferencing',
  meetingUrl: null,
  manageUrl: 'http://localhost:3000/manage/bk_1?token=tok_1',
} as unknown as BookingView;

describe('which booking waits for a link', () => {
  it('a confirmed online meeting with a manage link and no room yet', () => {
    expect(awaitsMeetingLink(confirmedOnline)).toBe(true);
  });
  it('not a request, not another kind of place, not one that has its link', () => {
    expect(awaitsMeetingLink({ ...confirmedOnline, status: 'pending' })).toBe(false);
    expect(
      awaitsMeetingLink({ ...confirmedOnline, locationKind: 'in_person' } as BookingView),
    ).toBe(false);
    expect(
      awaitsMeetingLink({ ...confirmedOnline, meetingUrl: 'https://meet.example.test/x' }),
    ).toBe(false);
    expect(awaitsMeetingLink({ ...confirmedOnline, manageUrl: undefined })).toBe(false);
    expect(awaitsMeetingLink(null)).toBe(false);
  });
  it('reads the token from an absolute or a relative manage link', () => {
    expect(manageTokenOf('https://a.example/manage/x?token=abc')).toBe('abc');
    expect(manageTokenOf('/manage/x?token=def')).toBe('def');
    expect(manageTokenOf('/manage/x')).toBeNull();
  });
});

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
  vi.useRealTimers();
});

function Probe(props: {
  booking: BookingView | null;
  fetchLink: (uid: string, token: string) => Promise<string | null>;
}) {
  const link = useLateMeetingLink(props.booking, props.fetchLink, [10, 10, 10]);
  return <output>{link ?? 'none'}</output>;
}

async function mount(
  booking: BookingView | null,
  fetchLink: (uid: string, token: string) => Promise<string | null>,
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Probe booking={booking} fetchLink={fetchLink} />));
}

const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe('useLateMeetingLink', () => {
  it('asks until the link exists, then stops', async () => {
    vi.useFakeTimers();
    const fetchLink = vi
      .fn<(uid: string, token: string) => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('https://meet.example.test/evt_1');
    await mount(confirmedOnline, fetchLink);
    expect(container!.textContent).toBe('none');
    await tick(10);
    expect(container!.textContent).toBe('none');
    await tick(10);
    expect(container!.textContent).toBe('https://meet.example.test/evt_1');
    await tick(100);
    expect(fetchLink).toHaveBeenCalledTimes(2);
    expect(fetchLink).toHaveBeenCalledWith('bk_1', 'tok_1');
  });

  it('gives up after its last try, and survives a failed one', async () => {
    vi.useFakeTimers();
    const fetchLink = vi
      .fn<(uid: string, token: string) => Promise<string | null>>()
      .mockRejectedValue(new Error('down'));
    await mount(confirmedOnline, fetchLink);
    await tick(1_000);
    expect(fetchLink).toHaveBeenCalledTimes(3);
    expect(container!.textContent).toBe('none');
  });

  it('never asks for a booking that has nothing to wait for', async () => {
    vi.useFakeTimers();
    const fetchLink = vi.fn<(uid: string, token: string) => Promise<string | null>>();
    await mount({ ...confirmedOnline, status: 'pending' }, fetchLink);
    await tick(1_000);
    expect(fetchLink).not.toHaveBeenCalled();
  });
});
