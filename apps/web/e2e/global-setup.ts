import { E2E } from './stack';

/**
 * Fixtures the seed does not make, created through the real admin API (the
 * local auth provider picks the host from `x-slate-email`), so they exist the
 * same way on SQLite and Postgres:
 *
 *  - Jordan Lee gets several event types, so their profile lists them, and one
 *    of them requires the host's confirmation (a pending booking).
 *  - Alex Rivera keeps exactly one, so their profile opens straight onto it,
 *    and it meets on a conferencing link, so a booking asks the calendar for a room.
 */
export default async function globalSetup(): Promise<void> {
  const asAlex = { 'content-type': 'application/json', 'x-slate-email': 'alex@example.com' };
  const alexTypes = (await (await fetch(`${E2E.api}/v1/event-types`, { headers: asAlex })).json()) as Array<{
    id: string;
    slug: string;
  }>;
  const intro = alexTypes.find((t) => t.slug === 'intro-call');
  if (!intro) throw new Error('setup: the seeded intro-call is missing');
  const patched = await fetch(`${E2E.api}/v1/event-types/${intro.id}`, {
    method: 'PATCH',
    headers: asAlex,
    body: JSON.stringify({ location: { kind: 'conferencing' } }),
  });
  if (!patched.ok) throw new Error(`setup: intro-call location -> ${patched.status} ${await patched.text()}`);

  const asJordan = { 'content-type': 'application/json', 'x-slate-email': 'jordan@example.com' };
  const schedules = (await (await fetch(`${E2E.api}/v1/schedules`, { headers: asJordan })).json()) as Array<{
    id: string;
  }>;
  const scheduleId = schedules[0]?.id;
  const types = [
    { slug: 'quick-chat', title: 'Quick Chat', lengthMinutes: 15 },
    { slug: 'deep-dive', title: 'Deep Dive', lengthMinutes: 60 },
    { slug: 'by-request', title: 'By Request', lengthMinutes: 30, requiresConfirmation: true },
  ];
  for (const t of types) {
    const r = await fetch(`${E2E.api}/v1/event-types`, {
      method: 'POST',
      headers: asJordan,
      body: JSON.stringify({ ...t, scheduleId, minimumBookingNotice: 0 }),
    });
    if (!r.ok && r.status !== 409) throw new Error(`setup: ${t.slug} -> ${r.status} ${await r.text()}`);
  }
}
