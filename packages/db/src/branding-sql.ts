import { sql, type Db } from './client';
import { jsonParam } from './repository';

export interface BrandingPatch {
  displayName?: string | null;
  avatarUrl?: string | null;
  coverUrl?: string | null;
  brandColor?: string | null;
  layout?: string | null;
  style?: Record<string, unknown>;
}

/**
 * The UPDATE a studio save is, as a statement rather than a call, so it can run
 * inside the same transaction as the backup an applied look keeps
 * (`brand-backup.ts`). Null when the patch sets nothing.
 */
export function brandingUpdateSql(db: Db, memberId: string, patch: BrandingPatch) {
  const sets: ReturnType<typeof sql>[] = [];
  if ('displayName' in patch) sets.push(sql`display_name = ${patch.displayName ?? null}`);
  if ('avatarUrl' in patch) sets.push(sql`avatar_url = ${patch.avatarUrl ?? null}`);
  if ('coverUrl' in patch) sets.push(sql`cover_url = ${patch.coverUrl ?? null}`);
  if ('brandColor' in patch) sets.push(sql`brand_color = ${patch.brandColor ?? null}`);
  if ('layout' in patch) sets.push(sql`layout = ${patch.layout ?? null}`);
  if ('style' in patch) sets.push(sql`booking_page_style = ${jsonParam(db, patch.style ?? null)}`);
  if (sets.length === 0) return null;
  const assignments = sets.reduce((acc, cur, i) => (i === 0 ? cur : sql`${acc}, ${cur}`));
  return sql`UPDATE member SET ${assignments} WHERE id = ${memberId}`;
}
