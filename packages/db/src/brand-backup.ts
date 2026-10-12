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
import type { SQL } from 'drizzle-orm';
import { sql, type Db } from './client';
import { jsonParam, parseJsonColumn } from './repository';
import { brandingUpdateSql, type BrandingPatch } from './branding-sql';

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
  return db.get<BrandingRow>(sql`SELECT ${ROW_COLUMNS} FROM member WHERE id = ${memberId} LIMIT 1`);
}

const ROW_COLUMNS = sql.raw('brand_color, booking_page_style, brand_backup, brand_applied_at');

/**
 * Read the member's branding, decide, and write, as ONE transaction with the
 * row held: SQLite's synchronous transaction, Postgres `SELECT ... FOR UPDATE`.
 * An apply (backup, then the new look) and a revert (restore, then clear the
 * backup) each read the row and write it twice; run as separate statements, a
 * revert landing between an apply's backup and its write would leave the new
 * look live with nothing to revert to. `decide` returns the statements to run
 * for what it read, or null to write nothing. Answers whether it wrote.
 */
async function lockedBrandingWrite(
  db: Db,
  memberId: string,
  decide: (row: BrandingRow) => SQL[] | null,
): Promise<boolean> {
  if (db.dialect === 'sqlite') {
    const native = db.sqlite!;
    return native.txn(() => {
      const row = native.drizzle.get<BrandingRow>(
        sql`SELECT ${ROW_COLUMNS} FROM member WHERE id = ${memberId} LIMIT 1`,
      );
      const statements = row ? decide(row) : null;
      if (!statements) return false;
      for (const stmt of statements) native.drizzle.run(stmt);
      return true;
    });
  }
  return db.pg!.drizzle.transaction(async (tx) => {
    const rows = (await tx.execute(
      sql`SELECT ${ROW_COLUMNS} FROM member WHERE id = ${memberId} LIMIT 1 FOR UPDATE`,
    )) as unknown as BrandingRow[];
    const statements = rows[0] ? decide(rows[0]) : null;
    if (!statements) return false;
    for (const stmt of statements) await tx.execute(stmt);
    return true;
  });
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

/** The statement that keeps `row` as the backup (or keeps the first one). */
function snapshotSql(db: Db, memberId: string, row: BrandingRow, source: BrandApplySource): SQL {
  const existing = parseBackup(row.brand_backup);
  const backup: StoredBackup = existing
    ? { ...existing, source }
    : {
        source,
        brandColor: row.brand_color ?? null,
        style: asObject(parseJsonColumn<unknown>(row.booking_page_style, null)),
      };
  return sql`UPDATE member SET brand_backup = ${jsonParam(db, backup)}, brand_applied_at = ${Date.now()}
      WHERE id = ${memberId}`;
}

/**
 * Keep what is stored now as the backup, on its own. Keeps an existing backup
 * (see the module note) and only moves the source and the time to this apply.
 * An apply that also writes the look uses `applyLook` instead, which does both
 * in one transaction.
 */
export async function snapshotBranding(db: Db, memberId: string, source: BrandApplySource): Promise<void> {
  await lockedBrandingWrite(db, memberId, (row) => [snapshotSql(db, memberId, row, source)]);
}

/**
 * Apply a look: keep the backup and write the branding in one transaction.
 * `patch` is computed from the row as read under the lock (a kit merges over
 * what is stored; the studio's new look is a whole save). Returns false, and
 * writes nothing, when `patch` returns null or the member does not exist.
 */
export async function applyLook(
  db: Db,
  memberId: string,
  source: BrandApplySource,
  patch: (current: { brandColor: string | null; style: Record<string, unknown> | null }) => BrandingPatch | null,
): Promise<boolean> {
  return lockedBrandingWrite(db, memberId, (row) => {
    const next = patch({
      brandColor: row.brand_color ?? null,
      style: asObject(parseJsonColumn<unknown>(row.booking_page_style, null)),
    });
    if (!next) return null;
    const write = brandingUpdateSql(db, memberId, next);
    return write ? [snapshotSql(db, memberId, row, source), write] : [snapshotSql(db, memberId, row, source)];
  });
}

/**
 * Put the look back as it was before the last apply, once. Returns false when
 * there was nothing to revert.
 */
export async function revertBranding(db: Db, memberId: string): Promise<boolean> {
  return lockedBrandingWrite(db, memberId, (row) => {
    const backup = parseBackup(row.brand_backup);
    if (!backup) return null;

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

    return [
      sql`UPDATE member
          SET brand_color = ${backup.brandColor},
              booking_page_style = ${jsonParam(db, style)},
              brand_backup = NULL,
              brand_applied_at = NULL
          WHERE id = ${memberId}`,
    ];
  });
}
