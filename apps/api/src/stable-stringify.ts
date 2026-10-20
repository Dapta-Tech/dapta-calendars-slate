/**
 * JSON with sorted keys, so equal requests hash equally whatever their key
 * order. The one serializer behind every idempotency request hash: the `/v2`
 * booking create (stored on the booking), and the `/v2` cancel, reschedule and
 * add-guests calls and the MCP door (both stored in `api_idempotency`).
 *
 * A property whose value is `undefined` is left out, so `{ a: 1, b: undefined }`
 * and `{ a: 1 }` are the same request. Only `undefined` is: unlike
 * `JSON.stringify`, a property whose value is a function or a symbol still comes
 * out as `"k":undefined`, an array element that is `undefined` as an empty slot
 * (`[1,,2]`), and a `Date` as `{}`. No caller passes any of these.
 *
 * Stored hashes are compared against this output on every retry, so the output
 * must never change for a value a caller can pass: keep the comparator
 * (`localeCompare`), the separators and the escaping exactly as they are.
 * `localeCompare` follows the runtime's default ICU locale (en-US in CI, and
 * under `LANG=C`), which orders keys a caller chooses (`metadata`,
 * `bookingFieldsResponses`). `stable-stringify.spec.ts` pins all of this against
 * the copies this replaced, so a locale change fails there first.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
