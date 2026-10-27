import { describe, expect, it, vi } from 'vitest';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getMessages } from '@slate/shared';

// A client navigation is the one thing a plain anchor is not: marked here so
// the markup says which kind each row is.
vi.mock('next/link', () => ({
  default: ({ children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a data-client-navigation="" {...rest}>
      {children}
    </a>
  ),
}));

import { ProfileView } from '@/components/profile-view';

/**
 * An event that loads the host's own tags opens as a full page load from the
 * profile, so its tags live only in its own document; every other event keeps
 * the client navigation.
 */
describe('ProfileView rows and the host’s own tags', () => {
  it('opens a tracked event as a full page load and the rest as client navigations', () => {
    const html = renderToStaticMarkup(
      <ProfileView
        m={getMessages('en')}
        name="Riley Chen"
        events={[
          { slug: 'tracked', title: 'Tracked', description: null, lengthMinutes: 30, tracking: { metaPixelId: '42' } },
          { slug: 'plain', title: 'Plain', description: null, lengthMinutes: 15, tracking: null },
          { slug: 'blank', title: 'Blank', description: null, lengthMinutes: 15, tracking: { gtmId: '  ' } },
        ]}
        hrefFor={(slug) => `/northwind/riley-chen/${slug}`}
        emptyText="None"
      />,
    );
    expect(html).toContain('<a href="/northwind/riley-chen/tracked" class="bp-event-row">');
    expect(html).toContain('<a data-client-navigation="" href="/northwind/riley-chen/plain" class="bp-event-row">');
    expect(html).toContain('<a data-client-navigation="" href="/northwind/riley-chen/blank" class="bp-event-row">');
  });
});
