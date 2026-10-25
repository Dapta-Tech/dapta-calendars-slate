'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { t, type BookingMessages } from '@slate/shared';
import { AgentLogo } from '@/components/agent-logos';
import { BrandMark } from '@/components/brand/brand';
import { MCP_APP_NAMES, type McpApp } from '@/components/mcp-apps';
import { buttonVariants } from '@/components/ui/button';
import { DEVELOPERS_CONNECT_HREF } from '@/lib/admin-nav';
import { cn } from '@/lib/cn';
import { SERVER_NAME } from '@/lib/mcp-connect';
import './agent-promo.css';

type CardMessages = BookingMessages['admin']['home']['agentCard'];

/** The apps the card cycles through, in the connect page's order. */
const CARD_APPS: readonly McpApp[] = ['claude', 'chatgpt', 'claude-code', 'codex', 'cursor', 'openclaw', 'hermes'];

/**
 * The tools the agent calls for each prompt of the catalog, in the same order:
 * real names from the MCP catalog (a spec holds them to it), so the chips
 * under an answer are the calls that answer would make.
 */
export const CARD_TOOLS: readonly (readonly string[])[] = [
  ['find_available_slots', 'book_meeting'],
  ['find_team_slots', 'book_team_meeting'],
  ['list_bookings', 'reschedule_booking'],
  ['list_pending_bookings', 'confirm_booking'],
  ['list_bookings', 'cancel_booking'],
  ['list_pending_bookings', 'decline_booking', 'find_available_slots'],
];

/**
 * One steady beat per prompt, whatever its length: it types in TYPE_TOTAL_MS,
 * the answer holds for HOLD_MS, it erases in ERASE_TOTAL_MS and the next one
 * starts BETWEEN_MS later. Every app gets the same time on screen.
 */
export const TYPE_TOTAL_MS = 1800;
export const HOLD_MS = 3400;
export const ERASE_TOTAL_MS = 420;
export const BETWEEN_MS = 380;
const TYPE_TICKS = 36;
const ERASE_TICKS = 12;

/** The logos float on one shared beat, a quarter of it apart, so the row moves evenly. */
const FLOAT_DUR = '4s';
const FLOAT: CSSProperties[] = CARD_APPS.map((_, i) => ({
  ['--dur' as string]: FLOAT_DUR,
  ['--delay' as string]: `${-(i * 4) / CARD_APPS.length}s`,
  ['--amp' as string]: i % 2 === 0 ? '5px' : '-5px',
  ['--tilt' as string]: i % 2 === 0 ? '1.4deg' : '-1.4deg',
}));

type Phase = 'typing' | 'done' | 'erasing';

/**
 * The typing loop, the same as the dForms home card's (ported from the
 * dforms.ai landing's prompt carousel): each prompt types itself in, holds
 * while the agent answers, erases, and the next one starts in the next app.
 * It counts ticks, not characters, so a long prompt types faster and every
 * one takes the same time. The clock only runs while the card is on screen
 * and the tab is visible. With reduced motion nothing moves: the first prompt
 * sits complete, with its answer.
 */
function usePromptLoop(prompts: readonly string[], reduced: boolean, visible: boolean) {
  const [index, setIndex] = useState(0);
  // How far the prompt is typed (0 to TYPE_TICKS) or still standing while it
  // erases (ERASE_TICKS down to 0).
  const [tick, setTick] = useState(TYPE_TICKS);
  const [phase, setPhase] = useState<Phase>('done');

  useEffect(() => {
    if (reduced || !visible || prompts.length === 0) return;
    let timer: ReturnType<typeof setTimeout>;
    if (phase === 'typing') {
      if (tick < TYPE_TICKS) timer = setTimeout(() => setTick((n) => n + 1), TYPE_TOTAL_MS / TYPE_TICKS);
      else timer = setTimeout(() => setPhase('done'), 0);
    } else if (phase === 'done') {
      timer = setTimeout(() => {
        setTick(ERASE_TICKS);
        setPhase('erasing');
      }, HOLD_MS);
    } else if (tick > 0) {
      timer = setTimeout(() => setTick((n) => n - 1), ERASE_TOTAL_MS / ERASE_TICKS);
    } else {
      timer = setTimeout(() => {
        setIndex((i) => (i + 1) % prompts.length);
        setPhase('typing');
      }, BETWEEN_MS);
    }
    return () => clearTimeout(timer);
  }, [prompts.length, tick, phase, reduced, visible]);

  if (reduced) return { index: 0, text: prompts[0] ?? '', phase: 'done' as Phase };
  const text = prompts[index] ?? '';
  const shown = Math.ceil((text.length * tick) / (phase === 'erasing' ? ERASE_TICKS : TYPE_TICKS));
  return { index, text: text.slice(0, shown), phase };
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let query: MediaQueryList;
    try {
      query = window.matchMedia('(prefers-reduced-motion: reduce)');
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

/** Whether `el` is on screen and the tab is visible: the loop rests otherwise. */
function useOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = useState(true);
  const [tabVisible, setTabVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => setOnScreen(entry?.isIntersecting ?? true));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  useEffect(() => {
    const sync = () => setTabVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);
  return onScreen && tabVisible;
}

/**
 * The home's big "Connect your agent" card. On the left, what connecting
 * gives and the way in; on the right, the same animation as the dForms home
 * card: a prompt typed into Claude, ChatGPT, Claude Code, Codex, Cursor,
 * OpenClaw or Hermes, the tools the agent calls, and the host's calendar with
 * the change made. `m` arrives with the product's name filled in.
 */
export function AgentCard({ m }: { m: CardMessages }) {
  const box = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const visible = useOnScreen(box);
  // A click on the chat holds it still, another starts it again. The pointer
  // passing over never does: only a click pauses.
  const [paused, setPaused] = useState(false);
  const { index, text, phase } = usePromptLoop(m.prompts, reduced, visible && !paused);
  const app = CARD_APPS[index % CARD_APPS.length]!;
  const tools = CARD_TOOLS[index % CARD_TOOLS.length]!;
  const answered = phase === 'done';

  return (
    <section
      aria-labelledby="agent-card-title"
      data-testid="home-agent-card"
      className="mb-section overflow-hidden rounded-2xl border border-border bg-card"
    >
      <div className="grid lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="flex flex-col justify-center p-group sm:p-section">
          <p className="mb-field inline-flex w-fit items-center gap-inline rounded-full border border-signal/40 bg-signal/10 px-field py-tight text-xs font-semibold text-signal-ink">
            <span className="h-1.5 w-1.5 rounded-full bg-signal" aria-hidden />
            {m.eyebrow}
          </p>
          <h2 id="agent-card-title" className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            {m.title}
          </h2>
          <p className="mt-inline max-w-md text-muted-foreground">{m.body}</p>
          <ul
            className="mt-group flex flex-wrap gap-inline sm:gap-field"
            aria-label={CARD_APPS.map((a) => MCP_APP_NAMES[a]).join(', ')}
          >
            {CARD_APPS.map((a, i) => (
              <li key={a} className="ap-float" style={FLOAT[i]}>
                <span
                  title={MCP_APP_NAMES[a]}
                  className={cn(
                    'flex h-10 w-10 items-center justify-center rounded-xl border bg-card text-foreground shadow-sm transition-all duration-300 sm:h-11 sm:w-11',
                    a === app && !reduced ? 'border-signal ring-4 ring-signal/20' : 'border-border',
                  )}
                >
                  <AgentLogo app={a} size={24} />
                </span>
              </li>
            ))}
          </ul>
          <Link
            href={DEVELOPERS_CONNECT_HREF}
            data-testid="home-agent-card-cta"
            className={`${buttonVariants({ variant: 'default' })} mt-group w-fit`}
          >
            {m.cta}
            <i aria-hidden className="pi pi-arrow-right" style={{ fontSize: 12 }} />
          </Link>
        </div>

        <div className="border-t border-border bg-panel p-card sm:p-group lg:border-l lg:border-t-0">
          <div
            ref={box}
            role="img"
            aria-label={m.label}
            data-testid="home-agent-demo"
            data-app={app}
            data-phase={phase}
            data-paused={paused || undefined}
            onClick={() => setPaused((p) => !p)}
            className="flex h-[440px] cursor-pointer flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm sm:h-[400px]"
          >
            <div aria-hidden className="flex items-center justify-between gap-field border-b border-border px-card py-inline">
              <span key={app} className="ap-in flex items-center gap-inline text-sm font-semibold text-foreground">
                <AgentLogo app={app} size={18} />
                {MCP_APP_NAMES[app]}
              </span>
              <span className="flex items-center gap-tight text-xs text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-signal" />
                {m.connected}
              </span>
            </div>

            <div aria-hidden className="flex min-h-0 flex-1 flex-col gap-field overflow-hidden p-card">
              {text ? (
                <p className="ml-auto line-clamp-4 max-w-[90%] shrink-0 rounded-2xl rounded-br-md bg-muted px-field py-inline text-sm text-foreground">
                  {text}
                  {phase === 'typing' ? <span className="ap-caret" /> : null}
                </p>
              ) : null}
              {answered ? (
                <div className="flex flex-col gap-inline">
                  <p className="ap-in flex flex-nowrap gap-tight overflow-hidden" style={{ ['--d' as string]: '0.05s' }}>
                    {tools.map((tool) => (
                      <span
                        key={tool}
                        data-testid="home-agent-tool"
                        className="flex h-5 shrink-0 items-center rounded-md border border-border bg-panel px-inline font-mono text-2xs text-muted-foreground"
                      >
                        {SERVER_NAME} · {tool}
                      </span>
                    ))}
                  </p>
                  <div
                    className="ap-in rounded-xl border border-border bg-background p-field"
                    style={{ ['--d' as string]: '0.35s' }}
                  >
                    <div className="mb-field flex items-center justify-between gap-inline">
                      <BrandMark className="h-4 w-auto text-foreground" />
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-signal text-signal-foreground">
                        <i className="pi pi-check" style={{ fontSize: 9 }} />
                      </span>
                    </div>
                    {/* A day on the host's calendar: three hours, the meeting on the second. */}
                    <div className="flex flex-col gap-tight">
                      {[0, 1, 2].map((row) => (
                        <div key={row} className="flex items-center gap-inline">
                          <span className="h-1.5 w-6 shrink-0 rounded-full bg-muted" />
                          {row === 1 ? (
                            <span className="h-7 flex-1 rounded-md border-l-4 border-signal bg-signal/15" />
                          ) : (
                            <span className="h-7 flex-1 rounded-md border border-dashed border-border" />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                  <p className="ap-in flex items-center gap-tight text-sm text-foreground" style={{ ['--d' as string]: '0.6s' }}>
                    <i className="pi pi-check-circle text-signal-ink" style={{ fontSize: 13 }} />
                    {m.done}
                  </p>
                </div>
              ) : null}
            </div>

            <div aria-hidden className="border-t border-border p-field">
              <div className="flex items-center gap-inline rounded-xl border border-border bg-background px-field py-inline text-sm text-faint">
                <span className="flex-1 truncate">{t(m.placeholder, { app: MCP_APP_NAMES[app] })}</span>
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-foreground text-background">
                  <i className="pi pi-arrow-up" style={{ fontSize: 11 }} />
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
