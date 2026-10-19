import { describe, expect, it } from 'vitest';
import { getMessages } from '@slate/shared';
import { manageFailureCopy, manageFailureIsRetryable } from './manage-failure';

describe('what the manage page says when a reschedule or cancel did not go through', () => {
  for (const locale of ['en', 'es'] as const) {
    const m = getMessages(locale);
    it(`says it from the code, in the visitor's language (${locale})`, () => {
      expect(manageFailureCopy({ status: 429, error: 'RATE_LIMITED' }, m)).toBe(m.trouble.actionBusy);
      expect(manageFailureCopy({ status: 409, error: 'CALENDAR_UNAVAILABLE' }, m)).toBe(m.trouble.actionCalendar);
      expect(manageFailureCopy({ status: 409, error: 'SLOT_TAKEN' }, m)).toBe(m.trouble.actionTaken);
      expect(manageFailureCopy({ status: 400, error: 'INVALID_SLOT' }, m)).toBe(m.trouble.actionUnavailable);
      expect(manageFailureCopy({ status: 403, error: 'FORBIDDEN' }, m)).toBe(m.trouble.actionLinkDead);
      expect(manageFailureCopy({ status: 410, error: 'GONE' }, m)).toBe(m.manage.cannotChange);
      expect(manageFailureCopy({ error: 'NO_TIME' }, m)).toBe(m.trouble.pickTime);
      expect(manageFailureCopy({ status: 500 }, m)).toBe(m.trouble.actionFailed);
    });
  }

  it('busy and an unreadable calendar keep the chosen time (retry by pressing again); a taken time does not', () => {
    expect(manageFailureIsRetryable({ status: 429 })).toBe(true);
    expect(manageFailureIsRetryable({ status: 409, error: 'CALENDAR_UNAVAILABLE' })).toBe(true);
    expect(manageFailureIsRetryable({ status: 409, error: 'SLOT_TAKEN' })).toBe(false);
  });
});
