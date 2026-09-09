'use client';

import { useRef, useState, useTransition } from 'react';
import type { BookingMessages } from '@slate/shared';
import { t } from '@slate/shared';
import type { OnboardingState } from '@slate/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  finishOnboardingAction,
  noteFirstAnswerAction,
  skipOnboardingAction,
  submitQualificationAction,
  submitSetupAction,
} from './actions';

type Messages = BookingMessages['onboarding'];
type Step = 'qualify' | 'template';

/**
 * The one wizard behind `/onboarding`, running whichever gates apply.
 *
 * The step order matters: qualification describes the workspace and is owed
 * once by an owner/admin, setup describes THIS host and is owed by everyone —
 * so an invited member's `onboardingRequired` is false and they open straight
 * on the template picker, which is the dead end ADR 0002 exists to prevent.
 */
export function OnboardingWizard({
  state,
  messages: m,
}: {
  state: OnboardingState;
  messages: Messages;
}) {
  const [step, setStep] = useState<Step>(state.onboardingRequired ? 'qualify' : 'template');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startT] = useTransition();
  // O2: the early contact push fires at most once per mount; the server is
  // idempotent per account, so this only avoids a pointless second request.
  const firstAnswerNoted = useRef(false);

  /**
   * O2 (#65 → Growth funnel) — the contact reaches the CRM as soon as ONE
   * question is answered, so someone who abandons the wizard here is still
   * reachable. Deliberately on blur rather than on every keystroke: a partial
   * value mid-typing is not an answer.
   *
   * Not awaited and never surfaced. The growth funnel has no claim on this
   * screen's behaviour, so a failure is invisible by construction.
   */
  function noteFirstAnswer(value: string) {
    if (firstAnswerNoted.current || value.trim().length === 0) return;
    firstAnswerNoted.current = true;
    void noteFirstAnswerAction();
  }

  function submitQualify() {
    setError(null);
    startT(async () => {
      const r = await submitQualificationAction(answers);
      if (!r.ok) return setError(m.errorGeneric);
      // Gate 2 may not be owed (a host who already has an event type and was
      // sent here only for the commercial questions) — then the wizard is done.
      // Done is not skipped: finishing must NOT set the skip cookie, or this
      // host stops being guided if they delete their last event type later.
      if (state.setupRequired) setStep('template');
      else await finishOnboardingAction();
    });
  }

  if (step === 'qualify') {
    // Every listed key must be answered: the cohort already decided how few to
    // ask, so a blank one is an unanswered question rather than an optional field.
    const complete = state.questionKeys.every((k) => (answers[k] ?? '').trim().length > 0);
    return (
      <Shell title={m.qualifyTitle} subtitle={m.qualifySubtitle} error={error}>
        <div className="flex flex-col gap-4">
          {state.questionKeys.map((key) => (
            <label key={key} className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{m.questions[key]}</span>
              <Input
                value={answers[key] ?? ''}
                onChange={(e) => setAnswers((a) => ({ ...a, [key]: e.target.value }))}
                onBlur={(e) => noteFirstAnswer(e.target.value)}
                // `phone` is the one key with a known input type; the rest of
                // the bank is free text by design (Forms scores the raw string).
                type={key === 'phone' ? 'tel' : 'text'}
                autoComplete={key === 'phone' ? 'tel' : 'off'}
              />
            </label>
          ))}
        </div>
        <div className="mt-8 flex justify-end">
          <Button onClick={submitQualify} disabled={pending || !complete}>
            {pending ? m.saving : m.continueLabel}
          </Button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title={m.templateTitle} subtitle={m.templateSubtitle} error={error}>
      <TemplatePicker state={state} messages={m} onError={() => setError(m.errorGeneric)} />
    </Shell>
  );
}

function TemplatePicker({
  state,
  messages: m,
  onError,
}: {
  state: OnboardingState;
  messages: Messages;
  onError: () => void;
}) {
  const [picked, setPicked] = useState<string>(state.templates[0]?.id ?? '');
  const [pending, startT] = useTransition();

  return (
    <>
      {/* One column: the list is four items and each carries a duration and a
          sentence, so a grid tuned for three would only shrink the copy. */}
      <div className="flex flex-col gap-2">
        {state.templates.map((tpl) => {
          const selected = picked === tpl.id;
          return (
            <button
              key={tpl.id}
              type="button"
              onClick={() => setPicked(tpl.id)}
              aria-pressed={selected}
              className={
                'flex items-start justify-between gap-4 rounded-md border px-4 py-3 text-left transition-colors ' +
                (selected ? 'border-primary bg-accent' : 'border-border hover:bg-accent/50')
              }
            >
              <span className="flex flex-col">
                <span className="text-sm font-medium">{tpl.title}</span>
                <span className="text-xs text-muted-foreground">{tpl.description}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {t(m.minutes, { minutes: tpl.lengthMinutes })}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-8 flex items-center justify-between gap-3">
        {/* The escape hatch. Without it the admin guard is a trap and the Home
            checklist — #65's designated recovery path — is unreachable. */}
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => startT(async () => void (await skipOnboardingAction()))}
        >
          {m.skipForNow}
        </Button>
        <Button
          disabled={pending || !picked}
          onClick={() =>
            startT(async () => {
              const r = await submitSetupAction(picked);
              if (r && !r.ok) onError();
            })
          }
        >
          {pending ? m.finishing : m.finish}
        </Button>
      </div>
    </>
  );
}

function Shell({
  title,
  subtitle,
  error,
  children,
}: {
  title: string;
  subtitle: string;
  error: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-8">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mb-8 text-sm text-muted-foreground">{subtitle}</p>
      {error ? (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {children}
    </div>
  );
}
