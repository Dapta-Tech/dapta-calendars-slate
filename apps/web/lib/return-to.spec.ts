import { describe, expect, it } from 'vitest';
import { adminBookingPath } from '@slate/shared';
import { firstParam, RETURN_TO_PARAM, safeReturnTo, withReturnTo } from './return-to';

const UID = '6f1c2a9e-1b7d-4c55-9a0e-3d2f8b7c4e10';

describe('safeReturnTo: only a dashboard page of this app', () => {
  it('keeps a dashboard path and its query', () => {
    expect(safeReturnTo(adminBookingPath(UID))).toBe(`/admin/bookings/${UID}`);
    expect(safeReturnTo('/admin')).toBe('/admin');
    expect(safeReturnTo('/admin/bookings?status=pending')).toBe('/admin/bookings?status=pending');
    // Encoding a legitimate path carries is kept as written.
    expect(safeReturnTo('/admin/bookings/a%20b')).toBe('/admin/bookings/a%20b');
  });

  it('drops the fragment, and the flight parameter Next adds to its own requests', () => {
    expect(safeReturnTo('/admin/bookings#booking-x')).toBe('/admin/bookings');
    expect(safeReturnTo(`/admin/bookings/${UID}?_rsc=1x2y3`)).toBe(`/admin/bookings/${UID}`);
    expect(safeReturnTo('/admin/bookings?status=pending&_rsc=a')).toBe('/admin/bookings?status=pending');
  });

  it.each([
    // Another origin, written every way a browser accepts one.
    '//evil.com',
    '///evil.com',
    'https://evil.com',
    'http://evil.com/admin',
    'javascript:alert(1)',
    'evil.com/admin',
    'admin/bookings',
    // Backslashes: browsers read `/\` as `//`.
    '/\\evil.com',
    '/\\\\evil.com',
    '\\\\evil.com',
    '/admin\\..\\..\\evil.com',
    // Control characters: the URL parser drops tabs and newlines.
    '/\t/evil.com',
    '/\n/evil.com',
    '\t//evil.com',
    ' //evil.com',
    // Encoded variants, one layer or several.
    '%2F%2Fevil.com',
    '/%2F%2Fevil.com',
    '/%2fevil.com',
    '/%5Cevil.com',
    '/%5cevil.com',
    '/%09/evil.com',
    '/%0a/evil.com',
    '/%252F%252Fevil.com',
    '/%25252F%25252Fevil.com',
    '%252F%252Fevil.com',
    '/%E0%A4%A',
    // Same origin, but not a dashboard page: the auth routes, the public pages.
    '/',
    '/login',
    '/api/auth/logout',
    '/api/auth/login?next=/admin',
    '/administrator',
    '/acme/alex-rivera/intro-call',
    // Dot segments are judged by where they land.
    '/admin/../api/auth/logout',
    '/admin/%2e%2e/api/auth/logout',
    '/admin/%2E%2E/%2E%2E/evil.com',
    // ...including when the slashes are encoded, so the parser keeps the
    // traversal inside one segment but a decoding proxy would not.
    '/admin/%2e%2e%2fapi%2fauth%2flogout',
    '/admin/..%2fapi%2fauth%2flogout',
    '/admin/..%252fapi%252fauth%252flogout',
    '/admin/bookings/..%2F..%2Fapi',
  ])('rejects %j', (raw) => {
    expect(safeReturnTo(raw)).toBeNull();
  });

  it('rejects whatever is not a reasonable string', () => {
    for (const raw of [undefined, null, '', 42, {}, ['/admin'], `/admin/${'a'.repeat(2048)}`]) {
      expect(safeReturnTo(raw), String(raw)).toBeNull();
    }
  });

  it('is idempotent, so re-reading at every hop never changes the answer', () => {
    for (const raw of ['/admin/bookings/x?a=1&_rsc=2', '/admin/./bookings', '/admin/bookings/a%20b']) {
      const once = safeReturnTo(raw);
      expect(safeReturnTo(once)).toBe(once);
    }
  });
});

describe('withReturnTo', () => {
  it('appends a safe target as one encoded parameter', () => {
    const path = adminBookingPath(UID);
    expect(withReturnTo('/login', path)).toBe(`/login?${RETURN_TO_PARAM}=${encodeURIComponent(path)}`);
    expect(withReturnTo('/login?signedout=1', path)).toBe(
      `/login?signedout=1&${RETURN_TO_PARAM}=${encodeURIComponent(path)}`,
    );
    // And it reads back as the same target.
    const back = new URL(withReturnTo('/login', path), 'http://x.test').searchParams.get(RETURN_TO_PARAM);
    expect(safeReturnTo(back)).toBe(path);
  });

  it('leaves the path alone when there is no safe target', () => {
    expect(withReturnTo('/login', null)).toBe('/login');
    expect(withReturnTo('/login?signedout=1', '//evil.com')).toBe('/login?signedout=1');
  });
});

describe('firstParam', () => {
  it('takes a single value and refuses a repeated one', () => {
    expect(firstParam('/admin')).toBe('/admin');
    expect(firstParam(['/admin', '//evil.com'])).toBeUndefined();
    expect(firstParam(undefined)).toBeUndefined();
  });
});
