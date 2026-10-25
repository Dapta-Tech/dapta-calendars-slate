import { getMessages } from '@slate/shared';
import { describe, expect, it } from 'vitest';
import {
  API_KEY_ENV,
  MCP_TOOLS,
  SCOPE_CATALOG,
  SERVER_NAME,
  claudeCodeCommand,
  codexAddCommand,
  codexLoginCommand,
  cursorDeeplink,
  cursorMcpJson,
  encodeCursorConfig,
  expiresAtMsFromDays,
  expiryState,
  hermesConfig,
  hermesLoginCommand,
  isShellSafeUrl,
  mcpSnippets,
  openclawLoginCommand,
  openclawSetCommand,
  scopeLabel,
  toMs,
} from './mcp-connect';

const URL_ = 'https://calendar.example.com/mcp';

describe('the server name', () => {
  it('is dcal, the name the server announces, for every new install', () => {
    expect(SERVER_NAME).toBe('dcal');
  });
});

describe('snippets: the URL alone, the app signs in', () => {
  it('Claude Code: added for every project by URL alone, the sign-in runs from /mcp', () => {
    expect(claudeCodeCommand(URL_)).toBe(`claude mcp add --transport http --scope user dcal ${URL_}`);
  });

  it('Codex: add by URL, then log in', () => {
    expect(codexAddCommand(URL_)).toBe(`codex mcp add dcal --url ${URL_}`);
    expect(codexLoginCommand).toBe('codex mcp login dcal');
  });

  it('OpenClaw: a remote streamable-HTTP entry that logs in with OAuth, then login', () => {
    expect(openclawSetCommand(URL_)).toBe(
      `openclaw mcp set dcal '{"url":"${URL_}","transport":"streamable-http","auth":"oauth"}'`,
    );
    expect(openclawLoginCommand).toBe('openclaw mcp login dcal');
  });

  it('Hermes: an mcp_servers entry with auth oauth, then login', () => {
    expect(hermesConfig(URL_)).toBe(`mcp_servers:\n  dcal:\n    url: "${URL_}"\n    auth: oauth`);
    expect(hermesLoginCommand).toBe('hermes mcp login dcal');
  });

  it('Cursor: the entry is the URL alone, in the file and in the one-click link (base64 JSON)', () => {
    const json = JSON.parse(cursorMcpJson(URL_)) as { mcpServers: Record<string, { url: string }> };
    expect(json.mcpServers[SERVER_NAME]).toEqual({ url: URL_ });
    const link = new URL(cursorDeeplink(URL_));
    expect(link.protocol).toBe('cursor:');
    expect(link.searchParams.get('name')).toBe('dcal');
    const config = JSON.parse(Buffer.from(link.searchParams.get('config')!, 'base64').toString('utf8'));
    expect(config).toEqual({ url: URL_ });
  });

  it('url-encodes base64 padding so the Cursor link survives, and stays under its 10,000 character limit', () => {
    expect(encodeCursorConfig({ a: 1 })).toBe('eyJhIjoxfQ==');
    expect(cursorDeeplink(`https://${'a'.repeat(200)}.example.com/mcp`).length).toBeLessThan(10_000);
  });

  it('carries no key and no key variable: the app signs in instead', () => {
    const all = JSON.stringify(mcpSnippets(URL_));
    expect(all).not.toMatch(/dcl_[A-Za-z0-9]/);
    expect(all).not.toContain(API_KEY_ENV);
    expect(all).not.toMatch(/Authorization|bearer/i);
  });

  it('carries the Claude directory listing when there is one, null by default', () => {
    expect(mcpSnippets(URL_).claudeDirectory).toBeNull();
    expect(mcpSnippets(URL_, 'https://claude.ai/directory/dcal').claudeDirectory).toBe('https://claude.ai/directory/dcal');
  });
});

describe('isShellSafeUrl', () => {
  it('takes an address a shell reads as one word', () => {
    for (const u of [URL_, 'http://localhost:4000/mcp', 'https://host.example.com/calendar/mcp', 'https://mcp.dcal.ai/mcp']) {
      expect(isShellSafeUrl(u), u).toBe(true);
    }
  });

  it('refuses anything a shell would run, split or unquote, since the commands paste it bare', () => {
    for (const u of ['https://x.example/mcp$(id)', "https://x.example/m'cp", 'https://x.example/a;b', 'https://x.example/a&b', 'https://x.example/a|b', 'https://x.example/a b', 'https://x.example/`id`', 'ftp://x.example/mcp']) {
      expect(isShellSafeUrl(u), u).toBe(false);
    }
  });
});

describe('scope and tool catalogs', () => {
  const locales = ['en', 'es'] as const;
  it.each(locales)('every scope has a plain-language label in %s', (loc) => {
    const labels = getMessages(loc).admin.developer.scopeLabels;
    for (const { scope } of SCOPE_CATALOG) expect(labels[scope], scope).toBeTruthy();
  });
  it('includes the new cancel scope as destructive', () => {
    expect(SCOPE_CATALOG.find((s) => s.scope === 'bookings:cancel')?.kind).toBe('destructive');
  });
  it('every tool needs a scope that exists, and is described in both locales', () => {
    const known = new Set(SCOPE_CATALOG.map((s) => s.scope));
    for (const loc of locales) {
      const d = getMessages(loc).admin.developer.toolDescriptions;
      for (const tool of MCP_TOOLS) {
        expect(d[tool.name], `${loc}:${tool.name}`).toBeTruthy();
        if (tool.scope) expect(known.has(tool.scope)).toBe(true);
      }
    }
    expect(MCP_TOOLS).toHaveLength(17);
  });
  it('rescheduling, declining and cancelling are the destructive tools, as the server marks them', () => {
    expect(MCP_TOOLS.filter((t) => t.kind === 'destructive').map((t) => t.name)).toEqual(['reschedule_booking', 'decline_booking', 'cancel_booking']);
  });
  it('falls back to the raw scope for one the catalog lacks', () => {
    expect(scopeLabel({}, 'future:scope')).toBe('future:scope');
  });
});

describe('key details tolerance', () => {
  const now = Date.UTC(2026, 9, 18);
  it('treats missing, null and blank as absent', () => {
    expect(toMs(undefined)).toBeNull();
    expect(toMs(null)).toBeNull();
    expect(toMs('')).toBeNull();
    expect(toMs('not a date')).toBeNull();
  });
  it('reads epoch ms and ISO strings', () => {
    expect(toMs(1000)).toBe(1000);
    expect(toMs('2026-10-18T00:00:00.000Z')).toBe(now);
  });
  it('classifies expiry', () => {
    expect(expiryState(undefined, now)).toBe('never');
    expect(expiryState(now + 1, now)).toBe('active');
    expect(expiryState(now, now)).toBe('expired');
  });
  it('turns a day preset into an absolute time, and 0 into none', () => {
    expect(expiresAtMsFromDays(0, now)).toBeUndefined();
    expect(expiresAtMsFromDays(30, now)).toBe(now + 30 * 86_400_000);
  });
});
