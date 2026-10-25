'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { t, type BookingMessages } from '@slate/shared';
import { AgentLogo } from '@/components/agent-logos';
import { MCP_APPS, MCP_APP_NAMES, type McpApp } from '@/components/mcp-apps';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/cn';
// Types only: the builders run on the server, where the MCP address is read.
import type { McpSnippets } from '@/lib/mcp-connect';
import { CodePanel, type CopyLabels } from './code-panel';
import { stepText } from './step-text';
import { WALK_DURATIONS, Walkthrough } from './walkthrough';

type ConnectMessages = BookingMessages['admin']['connect'];
type StepCopy = { title: string; body: string };

/** Per-browser memory of the picked app: a convenience, never a source of truth. */
export const APP_KEY = 'dcal.mcp.app';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** Whether the person asked for less motion; follows the setting live. False on the server. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let query: MediaQueryList;
    try {
      query = window.matchMedia(REDUCED_MOTION);
    } catch {
      return;
    }
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener?.('change', sync);
    return () => query.removeEventListener?.('change', sync);
  }, []);
  return reduced;
}

function readStored(): string | null {
  try {
    return window.localStorage.getItem(APP_KEY);
  } catch {
    return null;
  }
}

function writeStored(value: string) {
  try {
    window.localStorage.setItem(APP_KEY, value);
  } catch {
    // Private mode or blocked storage: the guide works the same, it only forgets.
  }
}

/**
 * Where each app is opened from its first step. Claude's connectors page is
 * the one its docs link to; Claude Desktop answers `claude://` (documented
 * for a new chat, where the + menu starts the flow); ChatGPT has no
 * documented deep link to its apps settings, so its home.
 */
export const OPEN_LINKS = {
  claude: 'https://claude.ai/customize/connectors',
  claudeDesktop: 'claude://claude.ai/new',
  chatgpt: 'https://chatgpt.com/',
} as const;

/**
 * A phone or a computer, from the browser: a mobile user agent, or a coarse
 * pointer on a narrow screen. Computer on the server and until it is known,
 * so nothing a computer can do is hidden by mistake on first paint.
 */
export function useDevice(): 'phone' | 'desktop' {
  const [device, setDevice] = useState<'phone' | 'desktop'>('desktop');
  useEffect(() => {
    try {
      const ua = navigator.userAgent;
      const mobileUa = /iPhone|iPod|Android.+Mobile|Windows Phone|Mobile Safari/i.test(ua);
      const coarseNarrow = window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 768;
      setDevice(mobileUa || coarseNarrow ? 'phone' : 'desktop');
    } catch {
      setDevice('desktop');
    }
  }, []);
  return device;
}

/** How many numbered steps an app's walkthrough plays: one frame per step. */
export function stepCount(app: McpApp): number {
  return WALK_DURATIONS[app].length;
}

/** The guide's step titles for an app, for the walkthrough's corner chip. */
function captionsOf(m: ConnectMessages, app: McpApp, directory: boolean): string[] {
  if (app === 'claude' && directory) return m.apps.claudeDirectory.steps.map((s) => s.title);
  const key = { claude: 'claude', chatgpt: 'chatgpt', 'claude-code': 'claudeCode', codex: 'codex', cursor: 'cursor', openclaw: 'openclaw', hermes: 'hermes' } as const;
  return m.apps[key[app]].steps.map((s) => s.title);
}

/**
 * "Connect with your account": the recommended way in. Three benefits, a tab
 * per AI app with its official logo, then, full width, the app's animated
 * walkthrough (each app's interface redrawn in code with this product as the
 * connector, or a replay of the real CLI), and under it the numbered steps
 * with the MCP URL and the commands in copy blocks. The step playing is lit;
 * clicking a step's number jumps the walkthrough there.
 *
 * `snippets` is built on the server for this environment's MCP address, and
 * `m` arrives with the product's and the server's names filled in. The page
 * renders this card only when the MCP takes a sign-in, so every snippet
 * connects with the URL alone: no key, no key variable.
 */
export function ConnectGuide({
  m,
  snippets,
  stepUp = false,
}: {
  m: ConnectMessages;
  snippets: McpSnippets;
  /** This API runs its own sign-in server: a new connection reads until the person approves more. */
  stepUp?: boolean;
}) {
  const [app, setApp] = useState<McpApp>('claude');
  const [step, setStep] = useState(0);
  const [userPaused, setUserPaused] = useState(false);
  const reduced = useReducedMotion();
  const device = useDevice();
  useEffect(() => {
    const stored = readStored();
    if (stored && (MCP_APPS as readonly string[]).includes(stored)) setApp(stored as McpApp);
  }, []);
  const pick = (next: McpApp) => {
    setApp(next);
    setStep(0);
    writeStored(next);
  };

  // The walkthrough loops through the app's steps on a timer, one frame per
  // step; with reduced motion it rests on the last frame and lights no step.
  const lastStep = stepCount(app) - 1;
  const shown = reduced ? lastStep : Math.min(step, lastStep);
  // Only a click pauses it (on the frame or the button), never the pointer passing over.
  const paused = userPaused;
  // How much of the current step has already played: a pause stops the clock
  // and a resume waits only for the rest, so the frame, the progress bar
  // (paused by CSS) and the timer stay together. A new step starts at zero;
  // this effect is declared first so it runs before the timer's.
  const played = useRef(0);
  useEffect(() => {
    played.current = 0;
  }, [app, shown]);
  useEffect(() => {
    if (reduced || paused) return;
    const started = Date.now();
    const left = Math.max(0, WALK_DURATIONS[app][shown]! - played.current);
    const timer = setTimeout(() => setStep((s) => (s >= lastStep ? 0 : s + 1)), left);
    return () => {
      clearTimeout(timer);
      played.current += Date.now() - started;
    };
  }, [app, shown, lastStep, reduced, paused]);

  const jump = (i: number) => setStep(i);
  const active = reduced ? null : shown;
  const copy: CopyLabels = { copy: m.copy, copied: m.copied, copyFailed: m.copyFailed };
  const name = MCP_APP_NAMES[app];

  return (
    <section
      aria-labelledby="connect-signin-title"
      data-testid="mcp-connect"
      className="overflow-hidden rounded-2xl border border-border bg-card"
    >
      <div className="border-b border-border bg-signal/[0.07] px-card py-card sm:px-group sm:py-group">
        <div className="flex flex-wrap items-center gap-x-field gap-y-inline">
          <h2 id="connect-signin-title" className="text-lg font-semibold text-foreground">
            {m.signinTitle}
          </h2>
          <span
            data-testid="mcp-connect-recommended"
            className="pill-pulse inline-flex h-6 items-center gap-tight rounded-full bg-signal px-inline text-xs font-semibold text-signal-foreground"
          >
            <i aria-hidden className="pi pi-star-fill" style={{ fontSize: 10 }} />
            {m.recommended}
          </span>
        </div>
        {/* Three across only from lg: at md the rail takes 240px and three
            columns leave a word or two per line. */}
        <ul className="mt-group grid gap-field lg:grid-cols-3" data-testid="mcp-connect-benefits">
          <Benefit icon="pi-key" title={m.benefits.noKey.title} body={m.benefits.noKey.body} />
          <Benefit icon="pi-building" title={m.benefits.workspaces.title} body={m.benefits.workspaces.body} />
          <Benefit icon="pi-shield" title={m.benefits.access.title} body={m.benefits.access.body} />
        </ul>
      </div>

      <div className="px-card py-group sm:px-group">
        <p className="mb-field text-sm text-muted-foreground">{m.signinIntro}</p>
        <AppTabs label={m.appsLabel} app={app} onPick={pick}>
          <div className="flex flex-col gap-group">
            <Walkthrough
              app={app}
              step={shown}
              captions={captionsOf(m, app, snippets.claudeDirectory !== null)}
              paused={paused}
              userPaused={userPaused}
              reduced={reduced}
              onToggle={() => setUserPaused((p) => !p)}
              label={t(m.media.terminalLabel, { app: name })}
              playLabel={m.media.play}
              pauseLabel={m.media.pause}
              m={m.walkthrough}
              prompt={m.walkthrough.prompt}
              snippets={snippets}
            />
            <AppSteps app={app} m={m} snippets={snippets} copy={copy} active={active} onStep={jump} device={device} />
          </div>
        </AppTabs>

        <p
          data-testid="mcp-connect-tip"
          className="mt-group flex gap-field rounded-xl border border-signal/40 bg-signal/[0.08] p-card text-sm text-muted-foreground"
        >
          <LineIcon icon="pi-check-circle" size={16} className="text-signal-ink" />
          <span>{stepText(m.tip)}</span>
        </p>
        {stepUp ? (
          <p data-testid="mcp-connect-step-up" className="mt-field flex gap-inline text-xs text-muted-foreground">
            <span aria-hidden className="flex h-4 shrink-0 items-center">
              <i className="pi pi-info-circle" style={{ fontSize: 12 }} />
            </span>
            <span>{m.stepUpNote}</span>
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * An icon beside the first line of a text block: in a box the height of one
 * line of `text-sm`, so it sits on that line however the text wraps.
 */
function LineIcon({ icon, size, className }: { icon: string; size: number; className?: string }) {
  return (
    <span aria-hidden className={cn('flex h-5 shrink-0 items-center', className)}>
      <i className={`pi ${icon}`} style={{ fontSize: size }} />
    </span>
  );
}

function Benefit({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <li className="flex gap-field rounded-xl border border-border bg-card p-field">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-signal/15 text-signal-ink">
        <i aria-hidden className={`pi ${icon}`} style={{ fontSize: 14 }} />
      </span>
      <span className="min-w-0 text-sm">
        <strong className="block font-semibold text-foreground">{title}</strong>
        <span className="text-muted-foreground">{body}</span>
      </span>
    </li>
  );
}

/**
 * One tab per app, each with its official logo. The strip scrolls sideways on
 * a narrow screen instead of wrapping, and the picked tab scrolls into view.
 */
function AppTabs({
  label,
  app,
  onPick,
  children,
}: {
  label: string;
  app: McpApp;
  onPick: (app: McpApp) => void;
  children: ReactNode;
}) {
  const base = useId();
  const strip = useRef<HTMLDivElement>(null);
  const tabs = useRef<Partial<Record<McpApp, HTMLButtonElement | null>>>({});
  const reduced = useReducedMotion();

  // The picked tab in view, a remembered one included, by scrolling the strip
  // sideways only: `scrollIntoView` would move the page too.
  useEffect(() => {
    const box = strip.current?.getBoundingClientRect();
    const at = tabs.current[app]?.getBoundingClientRect();
    if (!box || !at || !strip.current) return;
    const by = at.left < box.left ? at.left - box.left : at.right > box.right ? at.right - box.right : 0;
    if (by !== 0) strip.current.scrollBy({ left: by, behavior: reduced ? 'auto' : 'smooth' });
  }, [app, reduced]);
  const tabId = (a: McpApp) => `${base}-tab-${a}`;
  const panelId = `${base}-panel`;

  const onKeyDown = (e: KeyboardEvent) => {
    const at = MCP_APPS.indexOf(app);
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (at + 1) % MCP_APPS.length;
    else if (e.key === 'ArrowLeft') next = (at - 1 + MCP_APPS.length) % MCP_APPS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = MCP_APPS.length - 1;
    if (next === null) return;
    e.preventDefault();
    const picked = MCP_APPS[next]!;
    onPick(picked);
    tabs.current[picked]?.focus();
  };

  return (
    <div className="min-w-0">
      <div
        ref={strip}
        className="-mx-card overflow-x-auto px-card pb-tight sm:mx-0 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div
          role="tablist"
          aria-label={label}
          onKeyDown={onKeyDown}
          data-testid="mcp-app-tabs"
          className="flex w-max min-w-full gap-inline"
        >
          {MCP_APPS.map((a) => {
            const selected = a === app;
            return (
              <button
                key={a}
                ref={(el) => {
                  tabs.current[a] = el;
                }}
                type="button"
                role="tab"
                id={tabId(a)}
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                data-testid={`mcp-app-${a}`}
                onClick={() => onPick(a)}
                className={cn(
                  'flex shrink-0 items-center gap-inline rounded-xl border px-field py-inline text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98]',
                  // `signal-edge`, not `signal`: the plain green is under 3:1 on
                  // white, too faint to mark the picked tab (WCAG 1.4.11).
                  selected
                    ? 'border-signal-edge bg-signal/10 text-foreground shadow-sm'
                    : 'border-border bg-card text-muted-foreground hover:border-foreground/20 hover:text-foreground',
                )}
              >
                <span
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-lg border text-foreground',
                    selected ? 'border-signal/40 bg-card' : 'border-border bg-panel',
                  )}
                >
                  <AgentLogo app={a} size={16} />
                </span>
                {MCP_APP_NAMES[a]}
              </button>
            );
          })}
        </div>
      </div>
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(app)}
        data-testid="mcp-app-panel"
        data-app={app}
        className="mt-group"
      >
        {children}
      </div>
    </div>
  );
}

/** The numbered steps of one app, each with its copy block where the app asks for one. */
function AppSteps({
  app,
  m,
  snippets,
  copy,
  active,
  onStep,
  device,
}: {
  app: McpApp;
  m: ConnectMessages;
  snippets: McpSnippets;
  copy: CopyLabels;
  device: 'phone' | 'desktop';
  /** The step the walkthrough is on, or null when nothing plays. */
  active: number | null;
  /** Jump the walkthrough to a step. */
  onStep: (i: number) => void;
}) {
  const url = (
    <CodePanel label={m.urlLabel} code={snippets.url} language="text" copyLabel={m.copyUrl} m={copy} wrap testId="mcp-url" />
  );
  const prompt = (
    <CodePanel label={m.promptLabel} code={m.prompt} language="text" copyLabel={m.copyPrompt} m={copy} wrap testId="mcp-prompt" />
  );
  const command = (code: string, testId: string) => (
    <CodePanel label="bash" code={code} language="shell" copyLabel={m.copyCommand} m={copy} wrap testId={testId} />
  );
  const phone = device === 'phone';
  const phoneNote = (
    <p data-testid="mcp-phone-note" className="flex gap-inline rounded-lg border border-border bg-panel px-field py-inline text-sm text-muted-foreground">
      <LineIcon icon="pi-desktop" size={13} />
      {t(m.open.phoneNote, { app: MCP_APP_NAMES[app] })}
    </p>
  );
  // The first step of a terminal app: one click copies the add command; on a phone, the note instead.
  const firstCommand = (code: string, testId: string) => (
    <div className="flex flex-col gap-field">
      {phone ? (
        phoneNote
      ) : (
        <div className="flex flex-wrap items-center gap-field">
          <CopyCommandButton
            code={code}
            label={m.open.copyCommand}
            copied={m.open.copied}
            failed={m.copyFailed}
            testId={`${testId}-big-copy`}
          />
          <span className="text-sm text-muted-foreground">{m.open.pasteHint}</span>
        </div>
      )}
      {command(code, testId)}
    </div>
  );

  // Where the connector is listed in Claude's directory, that listing leads
  // Claude's tab and opens Claude Code's: a button straight to it.
  const directory = snippets.claudeDirectory;
  const directoryLink = directory ? (
    <OpenLink href={directory} label={m.open.claudeDirectory} app="claude" testId="mcp-claude-directory" external={m.open.newTab} />
  ) : null;

  let steps: { copy: StepCopy; extra?: ReactNode }[];
  let note: string | null = null;
  let lead: ReactNode = null;
  let fallback: ReactNode = null;
  switch (app) {
    case 'claude': {
      if (directoryLink) {
        const d = m.apps.claudeDirectory;
        steps = [
          { copy: d.steps[0]!, extra: directoryLink },
          { copy: d.steps[1]! },
          { copy: d.steps[2]! },
          { copy: d.steps[3]!, extra: prompt },
        ];
        // The custom connector stays for organizations that turned the directory off.
        fallback = (
          <details data-testid="mcp-claude-fallback" className="group rounded-xl border border-border bg-panel px-card py-field text-sm">
            <summary className="flex min-h-control cursor-pointer list-none items-center gap-inline font-medium text-foreground [&::-webkit-details-marker]:hidden">
              <i aria-hidden className="pi pi-chevron-right text-muted-foreground transition-transform group-open:rotate-90" style={{ fontSize: 11 }} />
              {d.fallbackTitle}
            </summary>
            <div className="mt-field flex flex-col gap-field">
              <p className="text-muted-foreground">{stepText(d.fallbackBody)}</p>
              {url}
            </div>
          </details>
        );
        break;
      }
      const s = m.apps.claude.steps;
      steps = [
        {
          copy: s[0]!,
          extra: (
            <div className="flex flex-wrap gap-inline">
              <OpenLink href={OPEN_LINKS.claude} label={m.open.claude} app="claude" testId="mcp-open-claude" external={m.open.newTab} />
              {phone ? null : (
                <OpenLink href={OPEN_LINKS.claudeDesktop} label={m.open.claudeDesktop} app="claude" testId="mcp-open-claude-desktop" soft />
              )}
            </div>
          ),
        },
        { copy: s[1]!, extra: url },
        { copy: s[2]! },
        { copy: s[3]!, extra: prompt },
      ];
      break;
    }
    case 'chatgpt': {
      const s = m.apps.chatgpt.steps;
      steps = [
        { copy: s[0]!, extra: <OpenLink href={OPEN_LINKS.chatgpt} label={m.open.chatgpt} app="chatgpt" testId="mcp-open-chatgpt" external={m.open.newTab} /> },
        { copy: s[1]!, extra: url },
        { copy: s[2]! },
        { copy: s[3]! },
        { copy: s[4]!, extra: prompt },
      ];
      break;
    }
    case 'claude-code': {
      const s = m.apps.claudeCode.steps;
      steps = [
        { copy: s[0]!, extra: firstCommand(snippets.claudeCode, 'mcp-claude-code-command') },
        { copy: s[1]! },
        { copy: s[2]!, extra: prompt },
      ];
      if (directoryLink) {
        // Claude Code on the same Claude account already has the directory
        // connector: say so first, with the way to connect it there; the
        // note under the steps would only repeat it.
        lead = (
          <div data-testid="mcp-claude-code-directory" className="mb-group flex flex-col gap-field rounded-xl border border-signal/40 bg-signal/[0.08] p-card text-sm">
            <p className="flex gap-inline">
              <LineIcon icon="pi-check-circle" size={15} className="text-signal-ink" />
              <span>
                <strong className="block font-semibold text-foreground">{m.apps.claudeCode.directoryTitle}</strong>
                <span className="text-muted-foreground">{stepText(m.apps.claudeCode.directoryBody)}</span>
              </span>
            </p>
            <div className="pl-group">{directoryLink}</div>
          </div>
        );
      } else {
        note = m.apps.claudeCode.note;
      }
      break;
    }
    case 'codex': {
      const s = m.apps.codex.steps;
      steps = [
        { copy: s[0]!, extra: firstCommand(snippets.codexAdd, 'mcp-codex-add') },
        { copy: s[1]!, extra: command(snippets.codexLogin, 'mcp-codex-login') },
        { copy: s[2]!, extra: prompt },
      ];
      note = m.apps.codex.note;
      break;
    }
    case 'cursor': {
      const s = m.apps.cursor.steps;
      steps = [
        {
          copy: s[0]!,
          extra: (
            <div className="flex flex-col gap-field">
              {phone ? (
                phoneNote
              ) : (
                <div>
                  <a href={snippets.cursorDeeplink} data-testid="mcp-cursor-deeplink" className={buttonVariants({ variant: 'default' })}>
                    <AgentLogo app="cursor" size={15} />
                    {m.addToCursor}
                  </a>
                </div>
              )}
              <CodePanel
                label="mcp.json"
                code={snippets.cursorJson}
                language="json"
                copyLabel={m.copyConfig}
                m={copy}
                testId="mcp-cursor-json"
              />
            </div>
          ),
        },
        { copy: s[1]! },
        { copy: s[2]!, extra: prompt },
      ];
      break;
    }
    case 'openclaw': {
      const s = m.apps.openclaw.steps;
      steps = [
        { copy: s[0]!, extra: firstCommand(snippets.openclawSet, 'mcp-openclaw-set') },
        { copy: s[1]!, extra: command(snippets.openclawLogin, 'mcp-openclaw-login') },
        { copy: s[2]!, extra: prompt },
      ];
      break;
    }
    case 'hermes': {
      const s = m.apps.hermes.steps;
      steps = [
        {
          copy: s[0]!,
          extra: (
            <div className="flex flex-col gap-field">
              {phone ? (
                phoneNote
              ) : (
                <CopyCommandButton
                  code={snippets.hermesConfig}
                  label={m.copyConfig}
                  copied={m.open.copied}
                  failed={m.copyFailed}
                  testId="mcp-hermes-config-big-copy"
                />
              )}
              <CodePanel
                label="~/.hermes/config.yaml"
                code={snippets.hermesConfig}
                language="text"
                copyLabel={m.copyConfig}
                m={copy}
                testId="mcp-hermes-config"
              />
            </div>
          ),
        },
        { copy: s[1]!, extra: command(snippets.hermesLogin, 'mcp-hermes-login') },
        { copy: s[2]!, extra: prompt },
      ];
      break;
    }
  }

  return (
    <>
      {lead}
      <ol className="flex flex-col" data-testid={`mcp-steps-${app}`}>
        {steps.map((step, i) => (
          <Step
            key={`${app}-${i}`}
            n={i + 1}
            title={step.copy.title}
            last={i === steps.length - 1}
            active={active === i}
            onSelect={() => onStep(i)}
          >
            <p className="text-sm text-muted-foreground">{stepText(step.copy.body)}</p>
            {step.extra ? <div className="mt-field">{step.extra}</div> : null}
          </Step>
        ))}
      </ol>
      {note ? (
        <p data-testid="mcp-steps-note" className="flex gap-inline text-xs text-muted-foreground">
          <span aria-hidden className="flex h-4 shrink-0 items-center">
            <i className="pi pi-info-circle" style={{ fontSize: 12 }} />
          </span>
          <span>{stepText(note)}</span>
        </p>
      ) : null}
      {fallback ? <div className="mt-inline">{fallback}</div> : null}
    </>
  );
}

function Step({
  n,
  title,
  last,
  active,
  onSelect,
  children,
}: {
  n: number;
  title: string;
  last: boolean;
  active: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <li data-active={active || undefined} data-testid="mcp-step" className="relative flex min-w-0 gap-card">
      <div className="flex shrink-0 flex-col items-center">
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          // A shortcut for the pointer: it must not leave focus on a hidden element.
          onMouseDown={(e) => e.preventDefault()}
          onClick={onSelect}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-all duration-300',
            active
              ? 'bg-signal text-signal-foreground ring-4 ring-signal/25'
              : 'border border-border bg-background text-muted-foreground',
          )}
        >
          {n}
        </button>
        {last ? null : <span aria-hidden className="mt-tight w-px flex-1 bg-border" />}
      </div>
      <div
        className={cn(
          '-mt-tight min-w-0 flex-1 rounded-xl px-field pt-tight transition-colors duration-300',
          active ? 'bg-signal/[0.08]' : 'bg-transparent',
          last ? 'pb-field' : 'mb-field pb-field',
        )}
      >
        {/* The title's line box is the number's height, so the two sit side by side. */}
        <h3 className="flex min-h-7 items-center text-sm font-semibold text-foreground">{title}</h3>
        <div className="mt-tight">{children}</div>
      </div>
    </li>
  );
}

/** A button that opens the app where its first step happens, with the app's mark. */
function OpenLink({
  href,
  label,
  app,
  testId,
  external,
  soft,
}: {
  href: string;
  label: string;
  app: McpApp;
  testId: string;
  /** Opens in a new tab: the text a screen reader hears after the label. */
  external?: string;
  soft?: boolean;
}) {
  return (
    <a
      href={href}
      data-testid={testId}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      // A long label ("Open in the Claude directory") wraps on a phone: the
      // button grows with it instead of pressing two lines into one row.
      className={cn(buttonVariants({ variant: soft ? 'soft' : 'default' }), 'h-auto min-h-10 py-inline')}
    >
      <AgentLogo app={app} size={15} />
      {label}
      {external ? <i aria-hidden className="pi pi-external-link" style={{ fontSize: 11 }} /> : null}
      {external ? <span className="sr-only"> {external}</span> : null}
    </a>
  );
}

/**
 * The big "Copy command": one click puts the add command on the clipboard, and
 * says so, or says it could not (no clipboard on a plain http page). Only that
 * outcome is announced, once: the live region empties again instead of going
 * back to the label.
 */
function CopyCommandButton({
  code,
  label,
  copied,
  failed,
  testId,
}: {
  code: string;
  label: string;
  copied: string;
  failed: string;
  testId: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setState('copied');
    } catch {
      setState('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2000);
  };
  const said = state === 'copied' ? copied : state === 'failed' ? failed : '';
  return (
    <button
      type="button"
      data-testid={testId}
      data-state={state}
      onClick={() => void onClick()}
      className={cn(buttonVariants({ variant: 'default' }), 'h-auto min-h-10 py-inline')}
    >
      <i
        aria-hidden
        className={`pi ${state === 'copied' ? 'pi-check' : state === 'failed' ? 'pi-times-circle' : 'pi-copy'}`}
        style={{ fontSize: 13 }}
      />
      <span aria-hidden={state !== 'idle' || undefined}>{state === 'copied' ? copied : state === 'failed' ? failed : label}</span>
      <span aria-live="polite" className="sr-only">
        {said}
      </span>
    </button>
  );
}
