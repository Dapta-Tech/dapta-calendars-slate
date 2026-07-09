'use client';

import { useState, useTransition } from 'react';
import type { BookingMessages } from '@slate/shared';
import type { EventType } from '@/lib/admin-api';
import { saveEventTypeAction, type ActionResult, type EventTypePayload } from './actions';

type EventTypeMessages = BookingMessages['admin']['eventTypes'];

const FIELD_TYPES = ['text', 'textarea', 'email', 'phone', 'number', 'select', 'checkbox', 'guests'];

interface IntakeField {
  name: string;
  label: string;
  type: string;
  required: boolean;
}

export function EventTypeForm({
  initial,
  schedules = [],
  messages: m,
}: {
  initial?: EventType;
  schedules?: Array<{ id: string; name: string }>;
  messages: EventTypeMessages;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(!!initial);
  const [description, setDescription] = useState(initial?.description ?? '');
  const [lengthMinutes, setLength] = useState(initial?.lengthMinutes ?? 30);
  const [minNotice, setMinNotice] = useState(120);
  const [slotInterval, setSlotInterval] = useState<number | ''>(initial?.lengthMinutes ?? 30);
  const [beforeBuf, setBeforeBuf] = useState(0);
  const [afterBuf, setAfterBuf] = useState(0);
  const [seats, setSeats] = useState<number | ''>(initial?.seatsPerTimeSlot ?? '');
  const [scheduleId, setScheduleId] = useState<string>(initial?.scheduleId ?? '');
  const [requiresConfirmation, setRequiresConf] = useState(initial?.requiresConfirmation ?? false);
  const [hidden, setHidden] = useState(initial?.hidden ?? false);
  const [fields, setFields] = useState<IntakeField[]>(
    (initial?.bookingFields as IntakeField[] | undefined)?.map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      required: !!f.required,
    })) ?? [],
  );
  const [res, setRes] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();

  const onTitle = (v: string) => {
    setTitle(v);
    if (!slugTouched) setSlug(v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
  };

  const save = () =>
    start(async () => {
      const payload: EventTypePayload = {
        id: initial?.id,
        title,
        slug,
        description: description.trim() || null,
        lengthMinutes: Number(lengthMinutes),
        minimumBookingNotice: Number(minNotice),
        slotInterval: slotInterval === '' ? null : Number(slotInterval),
        beforeEventBuffer: Number(beforeBuf),
        afterEventBuffer: Number(afterBuf),
        seatsPerTimeSlot: seats === '' ? null : Number(seats),
        scheduleId: scheduleId || null,
        requiresConfirmation,
        hidden,
        bookingFields: fields.filter((f) => f.name && f.label),
      };
      setRes(await saveEventTypeAction(payload));
    });

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border bg-card p-5">
      <div className="grid grid-cols-2 gap-3">
        <Field label={m.fTitle}>
          <input value={title} onChange={(e) => onTitle(e.target.value)} className={inputCls} />
        </Field>
        <Field label={m.fSlug}>
          <input value={slug} onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }} className={inputCls} />
        </Field>
      </div>
      <Field label={m.fDescription}>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={inputCls} />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label={m.fLength}>
          <input type="number" value={lengthMinutes} onChange={(e) => setLength(Number(e.target.value))} className={inputCls} />
        </Field>
        <Field label={m.fSlotInterval}>
          <input type="number" value={slotInterval} onChange={(e) => setSlotInterval(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls} />
        </Field>
        <Field label={m.fMinNotice}>
          <input type="number" value={minNotice} onChange={(e) => setMinNotice(Number(e.target.value))} className={inputCls} />
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label={m.fBufferBefore}>
          <input type="number" value={beforeBuf} onChange={(e) => setBeforeBuf(Number(e.target.value))} className={inputCls} />
        </Field>
        <Field label={m.fBufferAfter}>
          <input type="number" value={afterBuf} onChange={(e) => setAfterBuf(Number(e.target.value))} className={inputCls} />
        </Field>
        <Field label={m.fSeats}>
          <input type="number" min={1} placeholder="1" value={seats} onChange={(e) => setSeats(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls} />
        </Field>
      </div>
      <Field label={m.fSchedule}>
        <select value={scheduleId} onChange={(e) => setScheduleId(e.target.value)} className={inputCls}>
          <option value="">
            {schedules.length ? m.useDefaultSchedule : m.noSchedules}
          </option>
          {schedules.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>

      <div className="flex gap-6">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={requiresConfirmation} onChange={(e) => setRequiresConf(e.target.checked)} />
          {m.requiresConfirmation}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
          {m.hiddenLabel}
        </label>
      </div>

      {/* Intake questions */}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-muted-foreground">{m.intakeQuestions}</span>
        {fields.map((f, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              placeholder={m.namePlaceholder}
              value={f.name}
              onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, name: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') } : x)))}
              className="w-28 rounded-md border border-input bg-background px-2 py-1 text-sm"
            />
            <input
              placeholder={m.labelPlaceholder}
              value={f.label}
              onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
              className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm"
            />
            <select
              value={f.type}
              onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            >
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={f.required} onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} />
              {m.req}
            </label>
            <button type="button" onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive">×</button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setFields((fs) => [...fs, { name: '', label: '', type: 'text', required: false }])}
          className="self-start rounded-md border border-border px-3 py-1 text-sm text-muted-foreground hover:border-primary"
        >
          {m.addQuestion}
        </button>
      </div>

      {res && !res.ok ? <p className="text-sm text-destructive">{res.message}</p> : null}
      {res?.ok ? <p className="text-sm text-primary">{m.saved}</p> : null}
      <button
        type="button"
        onClick={save}
        disabled={pending || !title || !slug}
        className="self-start rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
      >
        {pending ? m.saving : initial ? m.saveChanges : m.createEventType}
      </button>
    </div>
  );
}

const inputCls = 'rounded-md border border-input bg-background px-3 py-2 w-full';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
