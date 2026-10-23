// @vitest-environment jsdom
/**
 * Every error boundary reports the error it shows, under its own name, once,
 * and keeps a real Retry (R22). What a report sends, and when it sends
 * nothing, is `captureError`'s (lib/analytics/port.spec.ts).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import RootError from './error';
import AdminError from './admin/error';
import PublicError from './[accountCode]/error';
import GlobalError from './global-error';

const captureError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/analytics/port', () => ({ captureError }));
vi.mock('./globals.css', () => ({}));

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
  captureError.mockReset();
  vi.restoreAllMocks();
});

async function mount(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
}

type SegmentBoundary = ComponentType<{ error: Error; reset: () => void }>;

describe('segment error boundaries', () => {
  it.each([
    ['app/error.tsx', RootError as SegmentBoundary, 'root'],
    ['app/admin/error.tsx', AdminError as SegmentBoundary, 'dashboard'],
    ['app/[accountCode]/error.tsx', PublicError as SegmentBoundary, 'booking_page'],
  ])('%s reports what it shows as %s, and its Retry resets', async (_file, Boundary, name) => {
    const error = new Error('render failed');
    const reset = vi.fn();
    await mount(<Boundary error={error} reset={reset} />);
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError).toHaveBeenCalledWith(error, name);
    const retry = container!.querySelector('button')!;
    act(() => retry.click());
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('app/global-error.tsx', () => {
  it('brings its own document, reports as global, and its Retry asks the server again', async () => {
    // It renders <html>, which React flags inside a test container.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = Object.assign(new Error('root layout failed'), { digest: 'd1' });
    const retry = vi.fn();
    await mount(<GlobalError error={error} retry={retry} />);
    expect(captureError).toHaveBeenCalledWith(error, 'global');
    expect(container!.querySelector('h1')?.textContent).toBe('This page didn’t load');
    const button = container!.querySelector('button')!;
    expect(button.textContent).toBe('Try again');
    act(() => button.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
