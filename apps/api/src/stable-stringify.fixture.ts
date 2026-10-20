/**
 * The three copies of `stableStringify` that `./stable-stringify` replaced,
 * frozen exactly as they were on `develop` up to ace0b31 (only the MCP copy's
 * `export` keyword is dropped), for specs only. Every request hash stored before
 * the shared helper existed was made by one of these, so the specs check the
 * shared helper against them. Never edit them: they are the record.
 */

/** From `apps/api/src/cal-v2.service.ts` (the `/v2` booking create hash). */
export const legacyCalV2Stringify = (() => {
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
  return stableStringify;
})();

/** From `apps/api/src/cal-v2-pilot.service.ts` (the `/v2` cancel, reschedule and add-guests hash). */
export const legacyPilotStringify = (() => {
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
  return stableStringify;
})();

/** From `apps/api/src/mcp/support.ts` (the MCP `book_meeting` hash). */
export const legacyMcpStringify = (() => {
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
  return stableStringify;
})();

export const LEGACY_STRINGIFIERS = {
  'cal-v2.service.ts': legacyCalV2Stringify,
  'cal-v2-pilot.service.ts': legacyPilotStringify,
  'mcp/support.ts': legacyMcpStringify,
} as const;
