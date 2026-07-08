'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import type { EventType } from '@/lib/admin-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createHostBookingAction } from './actions';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export function HostBookingForm({
  accountCode,
  handle,
  eventTypes,
}: {
  accountCode: string;
  handle: string;
  eventTypes: EventType[];
}) {
  const [slug, setSlug] = useState(eventTypes[0]?.slug ?? '');
  const [mode, setMode] = useState<'slots' | 'any'>('slots');
  const [slots, setSlots] = useState<string[]>([]);
  const [startUtc, setStartUtc] = useState('');
  const [customLocal, setCustomLocal] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [tz, setTz] = useState('America/New_York');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ ok: boolean; uid?: string; message?: string } | null>(null);
  const [pending, startT] = useTransition();

  const event = eventTypes.find((e) => e.slug === slug);
  const fields = (event?.bookingFields ?? []) as Array<{ name: string; label: string; type: string; required: boolean }>;

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
  }, [mode, slug, accountCode, handle]);

  const submit = () =>
    startT(async () => {
      const start = mode === 'any' ? (customLocal ? new Date(customLocal).toISOString() : '') : startUtc;
      if (!start) return setResult({ ok: false, message: 'Pick a time.' });
      const r = await createHostBookingAction({
        handle,
        slug,
        startUtc: start,
        attendee: { name, email, timeZone: tz },
        answers: Object.keys(answers).length ? answers : undefined,
      });
      setResult(r);
    });

  if (result?.ok) {
    return (
      <div className="rounded-md border border-border bg-card p-6">
        <h2 className="mb-2 text-xl font-semibold">Booking created</h2>
        <p className="mb-4 text-sm text-muted-foreground">The attendee has been notified.</p>
        <Link href="/admin/bookings" className="text-sm text-primary underline underline-offset-4">
          ← Back to bookings
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border bg-card p-6">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Event type</span>
        <select value={slug} onChange={(e) => setSlug(e.target.value)} className="rounded-md border border-input bg-background px-3 py-2">
          {eventTypes.map((et) => (
            <option key={et.slug} value={et.slug}>
              {et.title} · {et.lengthMinutes} min
            </option>
          ))}
        </select>
      </label>

      <div className="flex gap-2 text-sm">
        <Button variant={mode === 'slots' ? 'default' : 'outline'} size="sm" onClick={() => setMode('slots')}>
          From available slots
        </Button>
        <Button variant={mode === 'any' ? 'default' : 'outline'} size="sm" onClick={() => setMode('any')}>
          Any time (outside availability)
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
          {slots.length === 0 ? <span className="col-span-full text-sm text-muted-foreground">No slots in range.</span> : null}
        </div>
      ) : (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Date & time (host timezone)</span>
          <Input type="datetime-local" value={customLocal} onChange={(e) => setCustomLocal(e.target.value)} />
        </label>
      )}

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Attendee name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Attendee email</span>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Attendee timezone</span>
        <Input value={tz} onChange={(e) => setTz(e.target.value)} />
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

      {result && !result.ok ? <p className="text-sm text-destructive">{result.message}</p> : null}
      <Button onClick={submit} disabled={pending || !name || !email} className="self-start">
        {pending ? 'Creating…' : 'Create booking'}
      </Button>
    </div>
  );
}
