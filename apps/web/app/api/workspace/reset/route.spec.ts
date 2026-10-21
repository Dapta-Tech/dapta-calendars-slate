import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

let chosen: string | null = null;
const clearWorkspace = vi.fn(async () => {
  chosen = null;
});
vi.mock('@/lib/workspace', () => ({
  chosenWorkspace: async () => chosen,
  clearWorkspace: () => clearWorkspace(),
}));

import { GET } from './route';

const call = (query: string) => GET(new NextRequest(`https://calendar.example.com/api/workspace/reset${query}`));
const location = (res: Response) => {
  const url = new URL(res.headers.get('location')!);
  return url.pathname + url.search;
};

describe('the workspace reset route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chosen = 'acct_gone';
  });

  it('clears the refused workspace and goes back to the page', async () => {
    expect(location(await call('?w=acct_gone&next=%2Fadmin%2Fbookings'))).toBe('/admin/bookings');
    expect(clearWorkspace).toHaveBeenCalled();
  });

  it('keeps a newer choice, and ignores a link that does not name the current one', async () => {
    chosen = 'acct_newer';
    expect(location(await call('?w=acct_gone'))).toBe('/admin');
    await call('');
    expect(clearWorkspace).not.toHaveBeenCalled();
  });

  it('never goes back anywhere but a dashboard page', async () => {
    expect(location(await call('?w=acct_gone&next=https%3A%2F%2Fevil.example'))).toBe('/admin');
  });
});
