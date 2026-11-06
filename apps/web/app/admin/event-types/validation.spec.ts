import { describe, expect, it } from 'vitest';
import { getMessages } from '@slate/shared';
import { initialDraft, type EventTypeDraft } from './draft';
import { trackingKeysShown } from './sections/tracking';
import { FIELD_IDS, errorCounts, firstError, validateDraft } from './validation';

const m = getMessages('en').admin.eventTypes;
const e = m.editor.errors;
const valid: EventTypeDraft = { ...initialDraft({ crmProvider: null }), title: 'Intro', slug: 'intro' };
const check = (over: Partial<EventTypeDraft>, tracking = false) =>
  validateDraft({ ...valid, ...over }, { m, trackingEnabled: tracking, trackingKeys: trackingKeysShown(false) });
const only = (over: Partial<EventTypeDraft>, tracking = false) =>
  check(over, tracking).map(({ fieldId, tab, section, message }) => ({ fieldId, tab, section, message }));

describe('validateDraft', () => {
  it('a complete new event has no errors', () => {
    expect(check({})).toEqual([]);
  });

  it('title and event link are required (blank counts as empty)', () => {
    expect(only({ title: '  ', slug: '' })).toEqual([
      { fieldId: FIELD_IDS.title, tab: 'general', section: undefined, message: e.titleRequired },
      { fieldId: FIELD_IDS.slug, tab: 'general', section: undefined, message: e.slugRequired },
    ]);
  });

  it('duration is a whole number of minutes from 1 to 1440', () => {
    for (const bad of [0, 1441, 12.5, Number.NaN]) {
      expect(only({ lengthMinutes: bad }).map((x) => x.fieldId)).toEqual([FIELD_IDS.duration]);
    }
    expect(check({ lengthMinutes: 1440 })).toEqual([]);
  });

  it('every location kind but conferencing needs its detail', () => {
    expect(only({ locationKind: 'phone', locationDetail: ' ' })[0]).toMatchObject({
      fieldId: FIELD_IDS.locationDetail,
      message: e.locationDetailRequired,
    });
    expect(check({ locationKind: 'conferencing', locationDetail: '' })).toEqual([]);
    expect(check({ locationKind: 'in_person', locationDetail: 'Calle 1' })).toEqual([]);
  });

  it('minimum notice is 0 or more whole minutes', () => {
    expect(only({ minNotice: -1 })[0]?.message).toBe(e.minNoticeInvalid);
    expect(check({ minNotice: 0 })).toEqual([]);
  });

  it('a reserved question name is an error on that question', () => {
    const fields = [{ name: 'email', label: 'Email again', type: 'email', required: false }];
    expect(only({ fields })[0]).toMatchObject({ fieldId: FIELD_IDS.questionName(0), message: m.reservedWarning });
  });

  it('a redirect must be an https address', () => {
    expect(only({ redirectUrl: 'http://example.com' })[0]).toMatchObject({
      fieldId: FIELD_IDS.redirectUrl,
      message: m.successRedirect.invalid,
    });
    expect(check({ redirectUrl: 'https://example.com/thanks' })).toEqual([]);
  });

  it('advanced fields are flagged with their section, so a save can open it', () => {
    const errs = only({ beforeBuf: -5, afterBuf: Number.NaN, seats: 0, windowDays: 731, slotInterval: 0 });
    expect(errs.map((x) => [x.fieldId, x.section])).toEqual([
      [FIELD_IDS.beforeBuf, 'advanced'],
      [FIELD_IDS.afterBuf, 'advanced'],
      [FIELD_IDS.seats, 'advanced'],
      [FIELD_IDS.windowDays, 'advanced'],
      [FIELD_IDS.slotInterval, 'advanced'],
    ]);
    expect(errs[3]!.message).toBe(m.bookingWindow.invalid.replace('{max}', '730'));
    // Empty means "none" for seats, window and interval.
    expect(check({ seats: '', windowDays: '', slotInterval: '' })).toEqual([]);
  });

  it('tracking ids are checked only when tracking is shown, and belong to CRM Connection', () => {
    const trackingDraft = { ...valid.trackingDraft, metaPixelId: 'not-a-pixel' };
    expect(check({ trackingDraft })).toEqual([]);
    expect(only({ trackingDraft }, true)).toEqual([
      { fieldId: FIELD_IDS.tracking('metaPixelId'), tab: 'crm', section: undefined, message: e.trackingInvalid },
    ]);
  });
});

describe('errorCounts and firstError', () => {
  it('counts per tab and finds the first error in tab order', () => {
    const errs = check({ title: '', trackingDraft: { ...valid.trackingDraft, metaPixelId: 'x' } }, true);
    expect(errorCounts(errs)).toEqual({ general: 1, reminders: 0, crm: 1, agents: 0 });
    expect(firstError([...errs].reverse())?.fieldId).toBe(FIELD_IDS.title);
  });
});
