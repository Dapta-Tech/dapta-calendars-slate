import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, seed, sql, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { brandingWriteSchema } from '@slate/types';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { AdminService } from './admin.service';

/**
 * The studio's "Use the new look", through the service the controller calls:
 * a save marked `backupAs: 'new-look'` keeps what was stored, an ordinary save
 * does not, and the marker itself is never written onto the branding.
 */
describe('studio save with the new look', () => {
  let db: Db;
  let admin: AdminService;
  let principal: { accountId: string; memberId: string; role: 'owner' };

  const stored = () =>
    db.get<{ brand_color: string | null; booking_page_style: string | null }>(
      sql`SELECT brand_color, booking_page_style FROM member WHERE id = ${principal.memberId}`,
    );

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    admin = new AdminService(
      db,
      new CalendarEffects(new DisabledCalendarProvider(), db),
      new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db),
    );
    const accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    const memberId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    principal = { accountId, memberId, role: 'owner' };
  });

  const save = (body: unknown) => {
    const { backupAs, ...patch } = brandingWriteSchema.parse(body);
    return admin.updateBranding(principal, patch, backupAs);
  };

  it('keeps the previous look on a new-look save, and Revert brings it back', async () => {
    const before = await stored();
    await save({
      brandColor: '#1a1a1c',
      style: { template: 'split', theme: 'light', bio: 'Book a time with me.' },
      backupAs: 'new-look',
    });
    const after = await stored();
    expect(after!.brand_color).toBe('#1a1a1c');
    expect(after!.booking_page_style).not.toContain('backupAs');
    expect((await admin.brandBackupState(principal))?.source).toBe('new-look');

    expect(await admin.revertBranding(principal)).toBe(true);
    expect(await stored()).toEqual(before);
    expect(await admin.brandBackupState(principal)).toBeNull();
    expect(await admin.revertBranding(principal)).toBe(false);
  });

  it('keeps no backup on an ordinary save', async () => {
    await save({ brandColor: '#2f6fed' });
    expect(await admin.brandBackupState(principal)).toBeNull();
  });

  it('refuses a marker it does not know', () => {
    expect(() => brandingWriteSchema.parse({ backupAs: 'anything' })).toThrow();
  });
});
