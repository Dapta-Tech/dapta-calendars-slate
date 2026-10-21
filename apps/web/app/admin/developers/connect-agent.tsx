'use client';

import { useId, useState } from 'react';
import { t, type BookingMessages } from '@slate/shared';
import { buttonVariants, Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { MCP_TOOLS, SERVER_NAME, scopeLabel, type ToolKind } from '@/lib/mcp-connect';

type DevMessages = BookingMessages['admin']['developer'];

/** Everything the guide prints, built on the server from the runtime MCP address. */
export interface ConnectSnippets {
  mcpUrl: string;
  cursorDeeplink: string;
  cursorJson: string;
  claudeCode: string;
  codexToml: string;
  exportKey: string;
  header: string;
  /** Claude's add-connector dialog, pre-filled (used when OAuth is on). */
  claudeConnector: string;
  /** The same setups with no key, for an app that signs in itself (external sign-in). */
  cursorSignInDeeplink: string;
  cursorSignInJson: string;
  claudeCodeSignIn: string;
}

type TabId = 'cursor' | 'claude-code' | 'codex' | 'other' | 'chat';

export function CodeBlock({
  value,
  label,
  copyLabel,
  copiedLabel,
  wrap = false,
}: {
  value: string;
  label?: string;
  copyLabel: string;
  copiedLabel: string;
  /** Prose to paste (a prompt), not code: it wraps instead of scrolling sideways. */
  wrap?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the text is selectable */
    }
  };
  return (
    <div className="flex flex-col gap-tight">
      {label ? <span className="text-xs text-muted-foreground">{label}</span> : null}
      {/* Copy sits top-right inside the block, so a one-line value takes one line. */}
      <div className="flex items-start gap-inline rounded-md border border-border bg-muted p-inline pl-field">
        <pre
          className={`min-w-0 flex-1 self-center font-mono text-xs ${
            wrap ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto whitespace-pre'
          }`}
        >
          <code>{value}</code>
        </pre>
        <Button
          variant="outline"
          size="lg"
          className="shrink-0"
          onClick={() => void copy()}
          aria-label={`${copyLabel} · ${label ?? value.slice(0, 24)}`}
        >
          <i aria-hidden className={`pi ${copied ? 'pi-check' : 'pi-copy'}`} style={{ fontSize: 12 }} />
          {/* Icon only under 640px, where the block sits in the guide's step
              column and the word would take half its width; the aria-label
              names the button either way. */}
          <span className="hidden sm:inline">{copied ? copiedLabel : copyLabel}</span>
        </Button>
      </div>
    </div>
  );
}

/**
 * Which tabs a list shows. `all`: the four key setups and the chat apps, the
 * guide's step 2 with OAuth off or this API's own server. With an external
 * sign-in the guide splits them: `sign-in` (the chat apps first, then Cursor,
 * Claude Code and any other app, all with no key) and `keys` (the four key
 * setups, for headless agents and scripts).
 */
export type ConnectVariant = 'all' | 'sign-in' | 'keys';

const TAB_ORDER: Record<ConnectVariant, TabId[]> = {
  all: ['cursor', 'claude-code', 'codex', 'other', 'chat'],
  'sign-in': ['chat', 'cursor', 'claude-code', 'other'],
  keys: ['cursor', 'claude-code', 'codex', 'other'],
};

/**
 * The agent tabs: the MCP address and the exact setup for each agent. Part of
 * the setup guide (`setup-guide.tsx`), which carries the titles and the key,
 * and which shows none of this while the API does not serve MCP.
 */
export function ConnectAgent({
  snippets,
  oauth = false,
  variant = 'all',
  label,
  messages: m,
}: {
  snippets: ConnectSnippets | null;
  /** OAuth is on: chat apps connect with a sign-in. */
  oauth?: boolean;
  variant?: ConnectVariant;
  /** The tab list's accessible name (the step's title). */
  label?: string;
  messages: DevMessages;
}) {
  const base = useId();
  const signIn = variant === 'sign-in';
  const labels: Record<TabId, string> = {
    cursor: m.tabCursor,
    'claude-code': m.tabClaudeCode,
    codex: m.tabCodex,
    other: m.tabOther,
    chat: oauth || signIn ? m.chatOAuthTitle : m.tabChat,
  };
  const tabs = TAB_ORDER[variant].map((id) => ({ id, label: labels[id] }));
  const [active, setActive] = useState<TabId>(tabs[0]!.id);

  const onKey = (e: React.KeyboardEvent, i: number) => {
    let next = i;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    setActive(tabs[next]!.id);
    document.getElementById(`${base}-tab-${tabs[next]!.id}`)?.focus();
  };

  const copy = { copyLabel: m.copy, copiedLabel: m.copied };

  return (
    <div>
      {/* Wraps rather than scrolls: in the guide's step column a scrolling strip
          hid two of the five agents at 360px with nothing to say they were
          there, and the old bleed to the page gutter ran into the step numbers. */}
      <div role="tablist" aria-label={label ?? m.connectTitle} className="mb-field flex flex-wrap gap-tight">
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${base}-tab-${tab.id}`}
            aria-selected={active === tab.id}
            aria-controls={`${base}-panel-${tab.id}`}
            tabIndex={active === tab.id ? 0 : -1}
            onClick={() => setActive(tab.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={cn(
              'inline-flex min-h-control shrink-0 items-center whitespace-nowrap rounded-md px-field text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99]',
              active === tab.id
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`${base}-panel-${active}`}
        aria-labelledby={`${base}-tab-${active}`}
        className="flex flex-col gap-field rounded-xl border border-border bg-card p-field"
      >
        {active === 'chat' && (oauth || signIn) && snippets ? (
          <ChatOAuth snippets={snippets} external={signIn} m={m} />
        ) : active === 'chat' && !signIn ? (
          <div className="flex flex-col gap-tight">
            <h3 className="text-base font-semibold">{m.chatTitle}</h3>
            <p className="max-w-prose text-sm text-muted-foreground">{m.chatBody}</p>
          </div>
        ) : snippets === null ? (
          <p className="max-w-prose text-sm text-muted-foreground">{m.mcpUrlMissing}</p>
        ) : signIn ? (
          <SignInSetup tab={active} snippets={snippets} m={m} />
        ) : (
          <>
            <CodeBlock value={snippets.mcpUrl} label={m.mcpUrlLabel} {...copy} />
            <CodeBlock value={snippets.exportKey} label={m.stepKeyEnv} {...copy} />
            {active === 'cursor' ? (
              <>
                <p className="max-w-prose text-sm text-muted-foreground">{m.cursorLead}</p>
                <div>
                  <a href={snippets.cursorDeeplink} className={buttonVariants({ size: 'lg' })}>
                    {m.addToCursor}
                  </a>
                </div>
                <p className="max-w-prose text-xs text-muted-foreground">{m.cursorKeyNote}</p>
                <CodeBlock value={snippets.cursorJson} label={m.cursorFileLabel} {...copy} />
              </>
            ) : null}
            {active === 'claude-code' ? <CodeBlock value={snippets.claudeCode} label={m.claudeCodeLead} {...copy} /> : null}
            {active === 'codex' ? <CodeBlock value={snippets.codexToml} label={m.codexLead} {...copy} /> : null}
            {active === 'other' ? (
              <>
                <p className="max-w-prose text-sm text-muted-foreground">{m.otherLead}</p>
                <CodeBlock value={snippets.mcpUrl} label={m.otherUrl} {...copy} />
                <CodeBlock value={snippets.header} label={m.otherHeader} {...copy} />
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * An app that signs in itself, with no key: the address, then that app's own
 * way to add it. The server's 401 starts the sign-in, so no snippet carries a
 * header or names the key variable.
 */
function SignInSetup({ tab, snippets, m }: { tab: TabId; snippets: ConnectSnippets; m: DevMessages }) {
  const copy = { copyLabel: m.copy, copiedLabel: m.copied };
  if (tab === 'other') {
    return (
      <>
        <p className="max-w-prose text-sm text-muted-foreground">{m.signInOtherLead}</p>
        <CodeBlock value={snippets.mcpUrl} label={m.mcpUrlLabel} {...copy} />
      </>
    );
  }
  return (
    <>
      <CodeBlock value={snippets.mcpUrl} label={m.mcpUrlLabel} {...copy} />
      {tab === 'cursor' ? (
        <>
          <p className="max-w-prose text-sm text-muted-foreground">{m.signInCursorLead}</p>
          <div>
            <a href={snippets.cursorSignInDeeplink} className={buttonVariants({ size: 'lg' })}>
              {m.addToCursor}
            </a>
          </div>
          <CodeBlock value={snippets.cursorSignInJson} label={m.cursorFileLabel} {...copy} />
        </>
      ) : null}
      {tab === 'claude-code' ? (
        <>
          <CodeBlock value={snippets.claudeCodeSignIn} label={m.claudeCodeLead} {...copy} />
          <p className="max-w-prose text-sm text-muted-foreground">{t(m.signInClaudeCodeNext, { server: SERVER_NAME })}</p>
        </>
      ) : null}
    </>
  );
}

/** The chat-app tab when OAuth is on: real "add custom connector" steps, no key. */
function ChatOAuth({ snippets, external, m }: { snippets: ConnectSnippets; external: boolean; m: DevMessages }) {
  const copy = { copyLabel: m.copy, copiedLabel: m.copied };
  const steps = (items: string[]) => (
    <ol className="flex list-decimal flex-col gap-tight pl-group text-sm text-muted-foreground">
      {items.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  );
  return (
    <>
      <p className="max-w-prose text-sm text-muted-foreground">{external ? m.chatSignInLead : m.chatOAuthLead}</p>
      <div>
        <a href={snippets.claudeConnector} target="_blank" rel="noopener noreferrer" className={buttonVariants({ size: 'lg' })}>
          {m.addToClaude}
        </a>
      </div>
      <CodeBlock value={snippets.mcpUrl} label={m.mcpUrlLabel} {...copy} />
      <div className="flex flex-col gap-tight">
        <h3 className="text-base font-semibold">{m.chatClaudeHeading}</h3>
        {steps([m.chatClaudeStep1, m.chatClaudeStep2, external ? m.chatSignInClaudeStep3 : m.chatClaudeStep3])}
      </div>
      <div className="flex flex-col gap-tight">
        <h3 className="text-base font-semibold">{m.chatGptHeading}</h3>
        {steps([m.chatGptStep1, m.chatGptStep2, external ? m.chatSignInGptStep3 : m.chatGptStep3])}
      </div>
      {/* A sign-in has no step-up: what it may do is said under the tabs (setup-guide.tsx). */}
      {external ? null : <p className="max-w-prose text-xs text-muted-foreground">{m.chatScopesNote}</p>}
    </>
  );
}

const KIND_CLASS: Record<ToolKind, string> = {
  read: 'bg-muted text-muted-foreground',
  write: 'bg-warning/20 text-foreground',
  destructive: 'bg-destructive/15 text-destructive',
};

export function KindChip({ kind, m }: { kind: ToolKind; m: DevMessages }) {
  const label = kind === 'read' ? m.kindRead : kind === 'write' ? m.kindWrite : m.kindDestructive;
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded-full px-inline py-tight text-xs font-medium', KIND_CLASS[kind])}>
      {label}
    </span>
  );
}

/**
 * The tools with read / write / destructive labels, before anyone creates a key.
 * `signIn`: this installation also signs agents in (OAuth on, either server), so
 * a tool that needs no particular scope says a sign-in works too.
 */
export function AgentTools({ messages: m, signIn = false }: { messages: DevMessages; signIn?: boolean }) {
  return (
    <section className="mb-section">
      <h2 className="mb-tight text-xl font-semibold">{m.toolsTitle}</h2>
      <p className="mb-field max-w-prose text-sm text-muted-foreground">{m.toolsLead}</p>
      <ul className="grid grid-cols-1 gap-inline md:grid-cols-2">
        {MCP_TOOLS.map((tool) => (
          <li key={tool.name} className="flex flex-col gap-tight rounded-xl border border-border bg-card p-field">
            <div className="flex flex-wrap items-center justify-between gap-x-inline gap-y-tight">
              <code className="min-w-0 break-all font-mono text-sm font-medium">{tool.name}</code>
              <KindChip kind={tool.kind} m={m} />
            </div>
            <p className="text-xs text-muted-foreground">{m.toolDescriptions[tool.name] ?? ''}</p>
            <p className="text-xs text-foreground">
              {tool.scope
                ? t(m.toolNeeds, { scope: scopeLabel(m.scopeLabels, tool.scope) })
                : tool.publicOk
                  ? m.toolNeedsNoKey
                  : signIn
                    ? m.toolNeedsAnyKeyOrSignIn
                    : m.toolNeedsAnyKey}
              {tool.scope && tool.publicOk ? ` ${m.toolOrPublic}` : ''}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
