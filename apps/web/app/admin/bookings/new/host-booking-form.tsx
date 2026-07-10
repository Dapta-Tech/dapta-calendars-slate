'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { commonTimeZones, type BookingMessages } from '@slate/shared';
import type { EventType } from '@/lib/admin-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createHostBookingAction } from './actions';

type BookingsMessages = BookingMessages['admin']['bookings'];

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** Interpret a `datetime-local` wall-clock in a SPECIFIC timezone (the attendee's),
 *  not the host browser's — DST-safe two-pass. */
function wallClockToUtc(local: string, tz: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return new Date(local).toISOString();
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const naive = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  const offsetAt = (ms: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(ms));
    const g = Object.fromEntries(parts.map((p) => [p.type, p.value])) as Record<string, string>;
    return Date.UTC(+g.year!, +g.month! - 1, +g.day!, +g.hour!, +g.minute!, +g.second!) - ms;
  };
  let ms = naive - offsetAt(naive);
  ms = naive - offsetAt(ms);
  return new Date(ms).toISOString();
}

export function HostBookingForm({
  accountCode,
  handle,
  eventTypes,
  messages: m,
}: {
  accountCode: string;
  handle: string;
  eventTypes: EventType[];
  messages: BookingsMessages;
}) {
  // Only offer bookable (non-hidden) events.
  const bookable = useMemo(() => eventTypes.filter((e) => !e.hidden), [eventTypes]);
  const [slug, setSlug] = useState(bookable[0]?.slug ?? '');
  const [mode, setMode] = useState<'slots' | 'any'>('slots');
  const [slots, setSlots] = useState<string[]>([]);
  const [startUtc, setStartUtc] = useState('');
  const [customLocal, setCustomLocal] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [tz, setTz] = useState('America/New_York');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ ok: boolean; uid?: string; message?: string; status?: number } | null>(null);
  const [pending, startT] = useTransition();

  const event = bookable.find((e) => e.slug === slug);
  const fields = (event?.bookingFields ?? []) as Array<{ name: string; label: string; type: string; required: boolean }>;

  // `reloadKey` bumps to force a slots refetch after a 409 (the picked slot was
  // just taken) so the stale/taken time drops out and the user can really retry.
  const [reloadKey, setReloadKey] = useState(0);

  // Load available slots for the chosen event (slots mode).
  useEffect(() => {
    if (mode !== 'slots' || !slug) return;
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 21 * 86_400_000).toISOString();
    fetch(`${API}/v1/availability?accountCode=${accountCode}&handle=${handle}&slug=${slug}&from=${from}&to=${to}`, {
      cache: 'no-store',
    })
      .then((r) => (r.ok ? r.json() : { slots: [] }))
      .then((j: { slots?: { startUtc: string }[] }) => setSlots((j.slots ?? []).map((s) => s.startUtc)))
      .catch(() => setSlots([]));
    setStartUtc('');
  }, [mode, slug, accountCode, handle, reloadKey]);

  const submit = () =>
    startT(async () => {
      const start = mode === 'any' ? (customLocal ? wallClockToUtc(customLocal, tz) : '') : startUtc;
      if (!start) return setResult({ ok: false, message: m.pickTime });
      const r = await createHostBookingAction({
        handle,
        slug,
        startUtc: start,
        attendee: { name, email, timeZone: tz },
        answers: Object.keys(answers).length ? answers : undefined,
      });
      setResult(r);
      // Slot just taken → drop the stale selection and refetch a fresh list so
      // "pick another slot" is actionable, not a dead end.
      if (!r.ok && r.status === 409 && mode === 'slots') {
        setStartUtc('');
        setReloadKey((k) => k + 1);
      }
    });

  if (result?.ok) {
    return (
      <div className="rounded-md border border-border bg-card p-6">
        <h2 className="mb-2 text-xl font-semibold">{m.createdTitle}</h2>
        <p className="mb-4 text-sm text-muted-foreground">{m.createdNote}</p>
        <Link href="/admin/bookings" className="text-sm text-primary underline underline-offset-4">
          {m.backToBookings}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border bg-card p-6">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{m.eventType}</span>
        <select value={slug} onChange={(e) => setSlug(e.target.value)} className="rounded-md border border-input bg-background px-3 py-2">
          {bookable.map((et) => (
            <option key={et.slug} value={et.slug}>
              {et.title} · {et.lengthMinutes} min
            </option>
          ))}
        </select>
      </label>

      <div className="flex gap-2 text-sm">
        <Button variant={mode === 'slots' ? 'default' : 'outline'} size="sm" onClick={() => setMode('slots')}>
          {m.fromSlots}
        </Button>
        <Button variant={mode === 'any' ? 'default' : 'outline'} size="sm" onClick={() => setMode('any')}>
          {m.anyTime}
        </Button>
      </div>

      {mode === 'slots' ? (
        <div className="grid max-h-56 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
          {slots.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStartUtc(s)}
              aria-pressed={startUtc === s}
              className={
                'rounded-md border px-2 py-2 text-xs ' +
                (startUtc === s ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:border-primary')
              }
            >
              {new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(s))}
            </button>
          ))}
          {slots.length === 0 ? <span className="col-span-full text-sm text-muted-foreground">{m.noSlotsRange}</span> : null}
        </div>
      ) : (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{m.dateTimeHost}</span>
          <Input type="datetime-local" value={customLocal} onChange={(e) => setCustomLocal(e.target.value)} />
        </label>
      )}

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{m.attendeeName}</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{m.attendeeEmail}</span>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{m.attendeeTimezone}</span>
        <select
          value={tz}
          onChange={(e) => setTz(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          {commonTimeZones(tz).map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </label>

      {fields.map((f) => (
        <label key={f.name} className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">
            {f.label}
            {f.required ? ' *' : ''}
          </span>
          <Input
            required={f.required}
            value={answers[f.name] ?? ''}
            onChange={(e) => setAnswers((a) => ({ ...a, [f.name]: e.target.value }))}
          />
        </label>
      ))}

      {result && !result.ok ? (
        <p className="text-sm text-destructive">{result.status === 409 ? m.slotTaken : result.message}</p>
      ) : null}
      <Button onClick={submit} disabled={pending || !name || !email} className="self-start">
        {pending ? m.creating : m.createBooking}
      </Button>
    </div>
  );
}
