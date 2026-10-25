/**
 * The addresses with no page of their own land on the connect guide: the bare
 * `/admin/developers` and the old "MCP & API" settings tab, for anything that
 * reaches them past the redirects in `next.config.mjs`.
 */
import { describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }) }));
vi.mock('next/navigation', () => ({ redirect: nav.redirect }));

import DevelopersIndex from './page';
import OldDeveloperSettings from '../settings/developer/page';

describe('the old developer addresses', () => {
  it('send /admin/developers and /admin/settings/developer to the connect guide', () => {
    expect(() => DevelopersIndex()).toThrow('redirect:/admin/developers/connect');
    expect(() => OldDeveloperSettings()).toThrow('redirect:/admin/developers/connect');
  });
});
