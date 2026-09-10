'use client';

import { useRef, useState, useTransition } from 'react';
import type { BookingMessages, Locale } from '@slate/shared';
import { FieldHelp } from '@/components/field-help';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormHeader } from '@/components/ui/page-header';
import { TimeZoneSelect } from '@/components/ui/timezone-select';
import { createTeamFullAction } from '../actions';

type TeamsMessages = BookingMessages['admin']['teams'];

/** Read an image File as a size/type-validated data URL (offline-safe, no host). */
function readImageFile(file: File, onOk: (dataUrl: string) => void, onErr: (msg: string) => void, m: TeamsMessages) {
  if (!file.type.startsWith('image/')) return onErr(m.imageInvalidType);
  if (file.size > 1_000_000) return onErr(m.imageTooLarge);
  const reader = new FileReader();
  reader.onload = () => onOk(String(reader.result));
  reader.onerror = () => onErr(m.imageReadError);
  reader.readAsDataURL(file);
}

export function CreateTeamForm({
  messages: m,
  defaultTimeZone,
  accountCode,
  backHref,
  backLabel,
  heading,
  locale,
}: {
  messages: TeamsMessages;
  defaultTimeZone: string;
  accountCode: string;
  backHref: string;
  backLabel: string;
  heading: string;
  /** Active admin locale — the timezone picker's own copy. */
  locale?: Locale;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [bio, setBio] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [timeZone, setTimeZone] = useState(defaultTimeZone);
  const [err, setErr] = useState<string | null>(null);
  const [imgErr, setImgErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const onName = (v: string) => {
    setName(v);
    if (!slugTouched) setSlug(v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
  };

  const submit = () =>
    start(async () => {
      setErr(null);
      const r = await createTeamFullAction({
        name: name.trim(),
        slug: slug.trim(),
        bio: bio.trim() || null,
        logoUrl: logoUrl.trim() || null,
        timeZone,
      });
      // A successful create redirects (no return); only an error comes back.
      if (r && !r.ok) setErr(r.message ?? m.genericError);
    });

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <FormHeader
        backHref={backHref}
        backLabel={backLabel}
        title={heading}
        gutter="responsive"
        actions={
          <Button type="submit" size="lg" disabled={pending || !name.trim() || !slug.trim()}>
            {pending ? m.creating : m.createTeam}
          </Button>
        }
      />
      <div className="flex max-w-2xl flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:p-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="flex items-center gap-1 text-muted-foreground">
            {m.name}
            <FieldHelp text={m.nameHelp} />
          </span>
          <Input value={name} className="min-h-[44px]" onChange={(e) => onName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="flex items-center gap-1 text-muted-foreground">
            {m.slug}
            <FieldHelp text={m.slugHelp} />
          </span>
          <Input
            value={slug}
            className="min-h-[44px]"
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugTouched(true);
            }}
          />
          {/* Live public-URL preview (R25) — a string you copy, so the mono voice. */}
          <span className="truncate font-mono text-xs text-muted-foreground">
            /{accountCode || '…'}/team/{slug || '…'}
          </span>
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="flex items-center gap-1 text-muted-foreground">
          {m.bioLabel}
          <FieldHelp text={m.bioHelp} />
        </span>
        <textarea
          value={bio}
          rows={2}
          placeholder={m.bioPlaceholder}
          onChange={(e) => setBio(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>

      <div className="flex flex-col gap-2">
        <span className="flex items-center gap-1 text-sm text-muted-foreground">
          {m.logoLabel}
          <FieldHelp text={m.logoHelp} />
        </span>
        <div className="flex items-center gap-3">
          {logoUrl ? (
            <img src={logoUrl} alt={m.logoLabel} className="h-12 w-12 rounded-md border border-border object-cover" />
          ) : (
            <span className="flex h-12 w-12 items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground">
              {(name.trim()[0] ?? 'T').toUpperCase()}
            </span>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              setImgErr(null);
              if (f) readImageFile(f, setLogoUrl, setImgErr, m);
              e.target.value = '';
            }}
          />
          <Button variant="outline" size="lg" onClick={() => fileRef.current?.click()}>
            <i aria-hidden className="pi pi-upload" style={{ fontSize: 13 }} />
            {m.uploadImage}
          </Button>
          {logoUrl ? (
            <Button
              variant="outline"
              size="lg"
              className="text-muted-foreground"
              onClick={() => setLogoUrl('')}
            >
              {m.clearImage}
            </Button>
          ) : null}
        </div>
        <Input
          value={logoUrl.startsWith('data:') ? '' : logoUrl}
          placeholder={m.orPasteUrl}
          className="min-h-[44px]"
          onChange={(e) => setLogoUrl(e.target.value)}
        />
        {imgErr ? <p role="alert" className="text-sm text-destructive">{imgErr}</p> : null}
      </div>

      {/* Full IANA list through P's picker, like every other timezone field in
          the admin. A <div>, not a <label>: the trigger is a <button>. */}
      <div className="flex max-w-sm flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{m.timezone}</span>
        <TimeZoneSelect value={timeZone} onChange={setTimeZone} locale={locale} ariaLabel={m.timezone} />
      </div>

      {err ? <p role="alert" className="text-sm text-destructive">{err}</p> : null}
      </div>
    </form>
  );
}
