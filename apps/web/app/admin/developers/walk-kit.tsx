'use client';

// spacing-gate:off: the walkthrough frames redraw third-party apps on a fixed 640x360 stage that is scaled as one picture, so their spacing copies those apps, not this product's scale.

import type { CSSProperties, ReactNode } from 'react';
import { BrandTileMark } from '@/components/brand/brand';
import { cn } from '@/lib/cn';

/**
 * The pieces every walkthrough frame is drawn with. Each animated element is
 * written in its FINAL state; the CSS keyframes (walkthrough.css) only say
 * where it comes from, waiting at that start until its delay `--d`. With
 * reduced motion the animations are off and every frame shows its end state.
 */
export type Delay = { d?: number };
export const at = (d = 0, extra: CSSProperties = {}): CSSProperties => ({ ['--d' as string]: `${d}s`, ...extra });

/** Text that types itself in: one step per character over `dur` seconds, from `d`. */
export function Typed({ text, d = 0, dur, className }: { text: string; d?: number; dur?: number; className?: string }) {
  const n = Math.max(1, text.length);
  const seconds = dur ?? Math.min(1.6, Math.max(0.5, n * 0.035));
  return (
    <span
      className={cn('wt-type', className)}
      style={at(d, { ['--n' as string]: n, ['--dur' as string]: `${seconds}s` })}
    >
      {text}
    </span>
  );
}

export function Line({ children, d = 0, className }: { children: ReactNode; className?: string } & Delay) {
  return (
    <div className={cn('wt-fade whitespace-pre-wrap break-all', className)} style={at(d)}>
      {children}
    </div>
  );
}

/** The mouse pointer, flying in from (fx, fy) to (x, y) at `d`; gone at `out` when given. */
export function Pointer({
  x,
  y,
  d = 0,
  fx = 90,
  fy = 70,
  out,
}: { x: number; y: number; fx?: number; fy?: number; out?: number } & Delay) {
  const svg = (
    <svg
      aria-hidden
      className="wt-pointer"
      width="13"
      height="17"
      viewBox="0 0 16 20"
      style={at(d, { left: x, top: y, ['--fx' as string]: `${fx}px`, ['--fy' as string]: `${fy}px` })}
    >
      <path d="M1 1l12.5 11.5H7.6L4.3 18.4z" fill="#fff" stroke="#111" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
  // A pointer that hands over to the next one leaves at `out`, so only one shows at a time.
  return out === undefined ? (
    svg
  ) : (
    <span className="wt-out" style={at(out)}>
      {svg}
    </span>
  );
}

/** The connector's icon: the product's mark on a dark tile, as the AI apps list a connector. */
export function ProductTile({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[22%] bg-[#1a1a1c] text-white ring-1 ring-white/10',
        className,
      )}
      style={{ width: size, height: size }}
    >
      <BrandTileMark size={size} />
    </span>
  );
}

/** The green step chip in the frame's corner, with the guide's own step title; `low` puts it at the bottom, clear of a terminal's title bar and its output. */
export function StepChip({ n, title, low }: { n: number; title: string; low?: boolean }) {
  return (
    <span
      className={`absolute left-3 ${low ? 'bottom-3' : 'top-3'} z-40 inline-flex items-center gap-1.5 rounded-full bg-black/70 py-1 pl-1 pr-2.5 text-[9.5px] font-medium text-white shadow-lg ring-1 ring-white/10 backdrop-blur`}
    >
      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#3DDC84] text-[8px] font-bold text-black">
        {n}
      </span>
      {title}
    </span>
  );
}

export interface AnswerCopy {
  found: string;
  slots: string[];
  booked: string;
  meeting: string;
  when: string;
  calendar: string;
}

/** The open time the agent books: the second one it found. */
export const BOOKED_SLOT = 1;

/**
 * The agent's answer in an app's chat: the open times it found (`call` draws
 * the app's own "used a tool" line), then the meeting it booked, a confirmed
 * tile on the host's calendar. Row by row from `d`.
 */
export function MeetingAnswer({
  a,
  d,
  call,
  className,
}: {
  a: AnswerCopy;
  d: number;
  /** The app's line for one tool call, in its own style. */
  call: (tool: string, d: number) => ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {call('find_available_slots', d)}
      <div className="wt-fade" style={at(d + 0.3)}>
        <p className="mb-1">{a.found}</p>
        <div className="flex gap-1.5">
          {a.slots.map((slot, i) => (
            <span
              key={slot}
              className={cn(
                'rounded-md border px-2 py-0.5 font-mono text-[9.5px]',
                i === BOOKED_SLOT ? 'border-[#3DDC84] text-[#3DDC84]' : 'border-white/15 opacity-70',
              )}
            >
              {slot}
            </span>
          ))}
        </div>
      </div>
      {call('book_meeting', d + 0.8)}
      <div
        className="wt-pop flex items-center gap-2.5 rounded-lg border border-[#3DDC84]/40 bg-[#3DDC84]/10 px-2.5 py-2"
        style={at(d + 1.1)}
      >
        <span className="w-1 self-stretch rounded-full bg-[#3DDC84]" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{a.meeting}</span>
          <span className="block truncate text-[9px] opacity-75">
            {a.when} · {a.calendar}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-[#3DDC84] px-1.5 py-0.5 text-[8.5px] font-semibold text-black">
          ✓ {a.booked}
        </span>
      </div>
    </div>
  );
}
