'use client';

import { useId, useState } from 'react';
import { t, type BookingMessages } from '@slate/shared';
import { buttonVariants, Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { MCP_TOOLS, scopeLabel, type ToolKind } from '@/lib/mcp-connect';

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
}

type TabId = 'cursor' | 'claude-code' | 'codex' | 'other' | 'chat';

function CodeBlock({ value, label, copyLabel, copiedLabel }: { value: string; label?: string; copyLabel: string; copiedLabel: string }) {
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
      <div className="flex flex-col gap-inline rounded-md border border-border bg-muted p-field">
        <pre className="overflow-x-auto whitespace-pre font-mono text-xs">
          <code>{value}</code>
        </pre>
        <div>
          <Button variant="outline" size="lg" onClick={() => void copy()} aria-label={`${copyLabel} · ${label ?? value.slice(0, 24)}`}>
            <i aria-hidden className={`pi ${copied ? 'pi-check' : 'pi-copy'}`} style={{ fontSize: 12 }} />
            {copied ? copiedLabel : copyLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ConnectAgent({ snippets, messages: m }: { snippets: ConnectSnippets | null; messages: DevMessages }) {
  const base = useId();
  const tabs: { id: TabId; label: string }[] = [
    { id: 'cursor', label: m.tabCursor },
    { id: 'claude-code', label: m.tabClaudeCode },
    { id: 'codex', label: m.tabCodex },
    { id: 'other', label: m.tabOther },
    { id: 'chat', label: m.tabChat },
  ];
  const [active, setActive] = useState<TabId>('cursor');

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
    <section className="mb-section" aria-labelledby={`${base}-title`}>
      <h2 id={`${base}-title`} className="mb-tight text-xl font-semibold">
        {m.connectTitle}
      </h2>
      <p className="mb-field max-w-prose text-sm text-muted-foreground">{m.connectLead}</p>

      <div
        role="tablist"
        aria-label={m.connectTitle}
        className="-mx-gutter mb-field flex gap-tight overflow-x-auto px-gutter sm:mx-0 sm:px-0"
      >
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
        {active === 'chat' ? (
          <div className="flex flex-col gap-tight">
            <h3 className="text-base font-semibold">{m.chatTitle}</h3>
            <p className="max-w-prose text-sm text-muted-foreground">{m.chatBody}</p>
          </div>
        ) : snippets === null ? (
          <p className="max-w-prose text-sm text-muted-foreground">{m.mcpUrlMissing}</p>
        ) : (
          <>
            <CodeBlock value={snippets.mcpUrl} label={m.mcpUrlLabel} {...copy} />
            <p className="max-w-prose text-sm text-muted-foreground">{m.stepKey}</p>
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
    </section>
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

/** The ten tools with read / write / destructive labels, before anyone creates a key. */
export function AgentTools({ messages: m }: { messages: DevMessages }) {
  return (
    <section className="mb-section">
      <h2 className="mb-tight text-xl font-semibold">{m.toolsTitle}</h2>
      <p className="mb-field max-w-prose text-sm text-muted-foreground">{m.toolsLead}</p>
      <ul className="flex flex-col gap-inline">
        {MCP_TOOLS.map((tool) => (
          <li
            key={tool.name}
            className="flex flex-col gap-tight rounded-xl border border-border bg-card p-field"
          >
            <div className="flex flex-wrap items-center gap-inline">
              <code className="font-mono text-sm font-medium">{tool.name}</code>
              <KindChip kind={tool.kind} m={m} />
            </div>
            <p className="text-sm text-muted-foreground">{m.toolDescriptions[tool.name] ?? ''}</p>
            <p className="text-xs text-muted-foreground">
              {tool.scope ? t(m.toolNeeds, { scope: scopeLabel(m.scopeLabels, tool.scope) }) : tool.publicOk ? m.toolNeedsNoKey : m.toolNeedsAnyKey}
              {tool.scope && tool.publicOk ? ` ${m.toolOrPublic}` : ''}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
