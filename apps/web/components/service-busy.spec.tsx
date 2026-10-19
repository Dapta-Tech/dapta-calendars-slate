// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getMessages } from '@slate/shared';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { BUSY_AUTO_RETRIES, ServiceBusy } from './service-busy';

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

function mount(retryAfterMs: number, onRetry: () => void, locale: 'en' | 'es' = 'en') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<ServiceBusy copy={getMessages(locale).trouble} retryAfterMs={retryAfterMs} onRetry={onRetry} />));
  return container;
}

describe('the busy notice (a 429 the page could not be served through)', () => {
  it('says the service is busy, not that something broke, and counts down to its own retry', () => {
    const el = mount(4_000, vi.fn());
    const copy = getMessages('en').trouble;
    expect(el.querySelector('h1')!.textContent).toBe(copy.busyTitle);
    expect(el.textContent).toContain(copy.busyBody);
    expect(el.querySelector('[role="status"]')!.textContent).toMatch(/Trying again in \d+ s\./);
    expect(el.textContent).not.toMatch(/went wrong|didn.t load/i);
  });

  it('retries on its own after Retry-After (never sooner), a bounded number of times', () => {
    const retry = vi.fn();
    const el = mount(4_000, retry);
    act(() => vi.advanceTimersByTime(3_900));
    expect(retry).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1_100)); // 4 s plus up to 25% jitter
    expect(retry).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 40; i++) act(() => vi.advanceTimersByTime(5_000));
    expect(retry).toHaveBeenCalledTimes(BUSY_AUTO_RETRIES);
    expect(el.textContent).toContain(getMessages('en').trouble.busyStill);
  });

  it('never retries sooner than a second, even when told 0', () => {
    const retry = vi.fn();
    mount(0, retry);
    act(() => vi.advanceTimersByTime(990));
    expect(retry).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(300));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('the Try again button asks at once', () => {
    const retry = vi.fn();
    const el = mount(10_000, retry, 'es');
    const button = el.querySelector('button')!;
    expect(button.textContent).toBe(getMessages('es').trouble.tryAgain);
    act(() => button.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
