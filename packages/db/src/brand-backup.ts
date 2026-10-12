/**
 * One step of undo for a look applied to a host's booking page.
 *
 * A host's page renders from their OWN stored branding (`member.brand_color` and
 * `member.booking_page_style`) and from nothing else. Applying a look, whether
 * the studio's one-click "new look" or the workspace brand kit, is therefore a
 * SNAPSHOT written into those two columns, never a live link: editing the kit
 * later never moves a live page by surprise.
 *
 * Before the first apply, what was stored is kept in `member.brand_backup` with
 * the time in `member.brand_applied_at`, so "Revert" can put it back once. A
 * second apply before a revert keeps the FIRST backup: it is the host's own
 * look, and re-applying must not turn the backup into an applied look (the rule
 * the sibling product's brand kit follows).
 *
 * Revert restores only the LOOK: the accent and the ten style axes. Everything
 * else in the style object (bio, landing switch, default event, event order) is
 * the host's content and keeps whatever it is now. When nothing but the look
 * changed since the apply, the stored value comes back exactly as it was.
 */
import { sql, type Db } from './client';
import { jsonParam, parseJsonColumn } from './repository';

/** What applied the look the backup undoes. */
export type BrandApplySource = 'new-look' | 'kit';

/** The style keys that make up a look: the ten axes, no content. */
export const LOOK_STYLE_KEYS = [
  'template',
  'cardStyle',
  'corners',
  'buttons',
  'density',
  'font',
  'slotLayout',
  'dayGroup',
  'slotSelect',
  'theme',
] as const;

interface StoredBackup {
  source: BrandApplySource;
  brandColor: string | null;
  style: Record<string, unknown> | null;
}

export interface BrandBackupState {
  source: BrandApplySource;
  /** Epoch ms of the last apply. */
  appliedAt: number;
}

interface BrandingRow {
  brand_color: string | null;
  booking_page_style: unknown;
  brand_backup: unknown;
  brand_applied_at: number | string | null;
}

const asObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

async function readRow(db: Db, memberId: string): Promise<BrandingRow | undefined> {
  return db.get<BrandingRow>(
    sql`SELECT brand_color, booking_page_style, brand_backup, brand_applied_at
        FROM member WHERE id = ${memberId} LIMIT 1`,
  );
}

function parseBackup(raw: unknown): StoredBackup | null {
  const b = asObject(parseJsonColumn<unknown>(raw, null));
  if (!b) return null;
  const source = b.source === 'kit' ? 'kit' : b.source === 'new-look' ? 'new-look' : null;
  if (!source) return null;
  return {
    source,
    brandColor: typeof b.brandColor === 'string' ? b.brandColor : null,
    style: asObject(b.style),
  };
}

/** Whether there is a look to revert, what applied it and when. */
export async function getBrandBackupState(db: Db, memberId: string): Promise<BrandBackupState | null> {
  const row = await readRow(db, memberId);
  if (!row || row.brand_applied_at == null) return null;
  const backup = parseBackup(row.brand_backup);
  if (!backup) return null;
  return { source: backup.source, appliedAt: Number(row.brand_applied_at) };
}

/**
 * Keep what is stored now as the backup, before an apply writes over it. Call
 * it BEFORE the write. Keeps an existing backup (see the module note) and only
 * moves the source and the time to this apply.
 */
export async function snapshotBranding(db: Db, memberId: string, source: BrandApplySource): Promise<void> {
  const row = await readRow(db, memberId);
  if (!row) return;
  const existing = parseBackup(row.brand_backup);
  const backup: StoredBackup = existing
    ? { ...existing, source }
    : {
        source,
        brandColor: row.brand_color ?? null,
        style: asObject(parseJsonColumn<unknown>(row.booking_page_style, null)),
      };
  await db.run(
    sql`UPDATE member SET brand_backup = ${jsonParam(db, backup)}, brand_applied_at = ${Date.now()}
        WHERE id = ${memberId}`,
  );
}

/**
 * Put the look back as it was before the last apply, once. Returns false when
 * there was nothing to revert.
 */
export async function revertBranding(db: Db, memberId: string): Promise<boolean> {
  const row = await readRow(db, memberId);
  if (!row) return false;
  const backup = parseBackup(row.brand_backup);
  if (!backup) return false;

  const current = asObject(parseJsonColumn<unknown>(row.booking_page_style, null)) ?? {};
  const before = backup.style ?? {};
  const isLook = (k: string) => (LOOK_STYLE_KEYS as readonly string[]).includes(k);

  // The backup's own object, in its own key order, with the host's CONTENT
  // keys as they are now: when only the look changed since the apply, this is
  // the stored value exactly; when the host also edited their bio, it keeps
  // the edit. A content key the apply's write left out comes back as it was.
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(before)) {
    next[k] = !isLook(k) && k in current ? current[k] : v;
  }
  for (const [k, v] of Object.entries(current)) {
    if (!isLook(k) && !(k in next)) next[k] = v;
  }
  const style = backup.style === null && Object.keys(next).length === 0 ? null : next;

  await db.run(
    sql`UPDATE member
        SET brand_color = ${backup.brandColor},
            booking_page_style = ${jsonParam(db, style)},
            brand_backup = NULL,
            brand_applied_at = NULL
        WHERE id = ${memberId}`,
  );
  return true;
}
