'use client';

import { useRef, useState, useTransition } from 'react';
import type { BookingMessages, Locale } from '@slate/shared';
import { FieldHelp } from '@/components/field-help';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormHeader } from '@/components/ui/page-header';
import { TimeZoneSelect } from '@/components/ui/timezone-select';
import { readImageFile, type ImageErrorCode } from '@/lib/image-file';
import { createTeamFullAction } from '../actions';

type TeamsMessages = BookingMessages['admin']['teams'];

/** The shared reader's codes, in this form's own words. */
function imageErrText(code: ImageErrorCode, m: TeamsMessages): string {
  if (code === 'invalid') return m.imageInvalidType;
  if (code === 'tooLarge') return m.imageTooLarge;
  if (code === 'cannotShrink') return m.imageCannotShrink;
  return m.imageReadError;
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
  // A 25MB decode is not instant, so the control says so rather than looking dead.
  const [imgBusy, setImgBusy] = useState(false);
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
      <div className="flex max-w-2xl flex-col gap-card rounded-xl border border-border bg-card p-card sm:p-group">
      <div className="grid grid-cols-1 gap-field sm:grid-cols-2">
        <label className="flex flex-col gap-tight text-sm">
          <span className="flex items-center gap-tight text-muted-foreground">
            {m.name}
            <FieldHelp text={m.nameHelp} />
          </span>
          <Input value={name} className="min-h-control" onChange={(e) => onName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-tight text-sm">
          <span className="flex items-center gap-tight text-muted-foreground">
            {m.slug}
            <FieldHelp text={m.slugHelp} />
          </span>
          <Input
            value={slug}
            className="min-h-control"
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

      <label className="flex flex-col gap-tight text-sm">
        <span className="flex items-center gap-tight text-muted-foreground">
          {m.bioLabel}
          <FieldHelp text={m.bioHelp} />
        </span>
        <textarea
          value={bio}
          rows={2}
          placeholder={m.bioPlaceholder}
          onChange={(e) => setBio(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-field py-inline text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>

      <div className="flex flex-col gap-inline">
        <span className="flex items-center gap-tight text-sm text-muted-foreground">
          {m.logoLabel}
          <FieldHelp text={m.logoHelp} />
        </span>
        <div className="flex items-center gap-field">
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
            disabled={imgBusy}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              setImgErr(null);
              if (!f) return;
              setImgBusy(true);
              try {
                const r = await readImageFile(f, 'logo');
                if (r.ok) setLogoUrl(r.dataUrl);
                else setImgErr(imageErrText(r.code, m));
              } finally {
                setImgBusy(false);
              }
            }}
          />
          <Button
            variant="outline"
            size="lg"
            disabled={imgBusy}
            aria-busy={imgBusy}
            onClick={() => fileRef.current?.click()}
          >
            <i aria-hidden className="pi pi-upload" style={{ fontSize: 13 }} />
            {imgBusy ? m.imageWorking : m.uploadImage}
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
          className="min-h-control"
          onChange={(e) => setLogoUrl(e.target.value)}
        />
        {imgErr ? <p role="alert" className="text-sm text-destructive">{imgErr}</p> : null}
      </div>

      {/* Full IANA list through P's picker, like every other timezone field in
          the admin. A <div>, not a <label>: the trigger is a <button>. */}
      <div className="flex max-w-sm flex-col gap-tight text-sm">
        <span className="text-muted-foreground">{m.timezone}</span>
        <TimeZoneSelect value={timeZone} onChange={setTimeZone} locale={locale} ariaLabel={m.timezone} />
      </div>

      {err ? <p role="alert" className="text-sm text-destructive">{err}</p> : null}
      </div>
    </form>
  );
}
