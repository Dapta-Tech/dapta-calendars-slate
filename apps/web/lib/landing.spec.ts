import { describe, it, expect } from 'vitest';
import { getMessages } from '@slate/shared';
import { describeLanding, landingTarget, wantsProfile } from './landing';

/**
 * Where a host's link goes. A host with ONE event type is sent straight to it
 * (the profile would be a list of one); "Always show my profile" and
 * `?landing=1` keep the profile; a chosen default still wins.
 */
describe('landingTarget', () => {
  const one = ['intro'];
  const two = ['intro', 'review'];

  it('sends a host with one event type straight to it, whatever the studio saved', () => {
    expect(landingTarget({ style: null, eventSlugs: one })).toEqual({ kind: 'event', slug: 'intro', reason: 'only-event' });
    // Every studio save writes `landingEnabled: true`; that is not a choice.
    expect(landingTarget({ style: { landingEnabled: true }, eventSlugs: one }).kind).toBe('event');
  });

  it('keeps the profile when the host asks for it, or the visitor asks with ?landing=1', () => {
    expect(landingTarget({ style: { showProfile: true }, eventSlugs: one })).toEqual({ kind: 'profile' });
    expect(landingTarget({ style: null, eventSlugs: one, forceProfile: true })).toEqual({ kind: 'profile' });
  });

  it('shows the profile for two or none, and honours a chosen default', () => {
    expect(landingTarget({ style: null, eventSlugs: two })).toEqual({ kind: 'profile' });
    expect(landingTarget({ style: null, eventSlugs: [] })).toEqual({ kind: 'profile' });
    expect(
      landingTarget({ style: { landingEnabled: false, defaultEventSlug: 'review' }, eventSlugs: two }),
    ).toEqual({ kind: 'event', slug: 'review', reason: 'chosen' });
    // A chosen default that no longer exists falls back to the rules above.
    expect(landingTarget({ style: { landingEnabled: false, defaultEventSlug: 'gone' }, eventSlugs: two }).kind).toBe(
      'profile',
    );
  });

  it('reads ?landing=1', () => {
    expect(wantsProfile({ landing: '1' })).toBe(true);
    expect(wantsProfile({ landing: ['true'] })).toBe(true);
    expect(wantsProfile({})).toBe(false);
  });
});

describe("the studio's sentence says what the visitor gets", () => {
  const events = [{ slug: 'intro', title: 'Intro call' }];
  for (const locale of ['en', 'es'] as const) {
    const m = getMessages(locale).admin.studio;
    it(locale, () => {
      expect(describeLanding(landingTarget({ style: null, eventSlugs: ['intro'] }), events, m)).toBe(
        m.linkOpensEvent.replace('{event}', 'Intro call'),
      );
      expect(describeLanding(landingTarget({ style: { showProfile: true }, eventSlugs: ['intro'] }), events, m)).toBe(
        m.linkOpensProfile,
      );
    });
  }
});
