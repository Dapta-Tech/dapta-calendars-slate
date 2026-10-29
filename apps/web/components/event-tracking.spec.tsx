// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { EventTracking } from '@/components/event-tracking';
import { resetTrackingForTests } from '@/lib/event-tracking';

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
  const w = window as unknown as Record<string, unknown>;
  delete w['dataLayer'];
  delete w['fbq'];
  delete w['_fbq'];
  document.head.innerHTML = '';
  resetTrackingForTests();
});

const mount = async (tracking: Parameters<typeof EventTracking>[0]['tracking'], hostScriptsOrigin: string | null = null) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<EventTracking tracking={tracking} hostScriptsOrigin={hostScriptsOrigin} />));
};

describe('EventTracking', () => {
  it('renders no markup and starts no tag for an event without ids', async () => {
    expect(renderToStaticMarkup(<EventTracking tracking={null} hostScriptsOrigin={null} />)).toBe('');
    expect(renderToStaticMarkup(<EventTracking tracking={{ gtmId: '  ' }} hostScriptsOrigin={null} />)).toBe('');
    await mount(null);
    expect(document.head.querySelectorAll('script')).toHaveLength(0);
  });

  it('server-renders only the noscript fallbacks, their ids encoded', () => {
    const html = renderToStaticMarkup(<EventTracking tracking={{ gtmId: 'GTM-AB12', metaPixelId: '424242424242', hubspotTrackingId: '7' }} hostScriptsOrigin={null} />);
    expect(html).toContain('<noscript data-testid="tracking-gtm-noscript">');
    expect(html).toContain('https://www.googletagmanager.com/ns.html?id=GTM-AB12');
    expect(html).toContain('<noscript data-testid="tracking-meta-pixel-noscript">');
    expect(html).toContain('https://www.facebook.com/tr?id=424242424242&amp;ev=PageView&amp;noscript=1');
    expect(html).not.toContain('<script');
  });

  it('starts the tags after hydration', async () => {
    await mount({ gtmId: 'GTM-AB12', hubspotTrackingId: '7' });
    const srcs = [...document.head.querySelectorAll('script')].map((s) => s.src);
    expect(srcs).toEqual(['https://www.googletagmanager.com/gtm.js?id=GTM-AB12', 'https://js.hs-scripts.com/7.js']);
  });

  it('with a booking host of its own, starts GTM, GA4 and HubSpot only on that origin; Meta and PostHog anywhere', async () => {
    await mount({ gtmId: 'GTM-AB12', hubspotTrackingId: '7', metaPixelId: '424242424242' }, 'https://book.example.com');
    const offOrigin = [...document.head.querySelectorAll('script')].map((s) => s.src);
    expect(offOrigin).toEqual(['https://connect.facebook.net/en_US/fbevents.js']);
  });

  it('on the booking origin itself, starts them all', async () => {
    await mount({ gtmId: 'GTM-AB12', hubspotTrackingId: '7' }, window.location.origin);
    const srcs = [...document.head.querySelectorAll('script')].map((s) => s.src);
    expect(srcs).toEqual(['https://www.googletagmanager.com/gtm.js?id=GTM-AB12', 'https://js.hs-scripts.com/7.js']);
  });
});

