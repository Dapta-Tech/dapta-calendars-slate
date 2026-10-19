import { getMessages } from '@slate/shared';
import { describe, expect, it } from 'vitest';
import {
  API_KEY_ENV,
  MCP_TOOLS,
  SCOPE_CATALOG,
  claudeCodeCommand,
  codexConfigToml,
  cursorDeeplink,
  cursorMcpJson,
  cursorServerEntry,
  encodeCursorConfig,
  expiresAtMsFromDays,
  expiryState,
  scopeLabel,
  toMs,
} from './mcp-connect';

const URL_ = 'https://calendar.example.com/mcp';

describe('Cursor deeplink', () => {
  const link = cursorDeeplink(URL_);
  const config = new URL(link.replace('cursor://', 'http://')).searchParams.get('config')!;

  it('is the install scheme with the server name', () => {
    expect(link.startsWith('cursor://anysphere.cursor-deeplink/mcp/install?name=dapta-calendars&config=')).toBe(true);
  });

  it('carries base64 of the single server entry, not the name wrapper', () => {
    const decoded = JSON.parse(Buffer.from(config, 'base64').toString('utf8'));
    expect(decoded).toEqual({ url: URL_, headers: { Authorization: `Bearer \${env:${API_KEY_ENV}}` } });
    expect(decoded.mcpServers).toBeUndefined();
  });

  it('never contains a key: only the variable name', () => {
    expect(link).not.toMatch(/dcl_/);
    expect(Buffer.from(config, 'base64').toString('utf8')).toContain('${env:');
  });

  it('url-encodes base64 padding so the query survives', () => {
    expect(encodeCursorConfig({ a: 1 })).toBe('eyJhIjoxfQ==');
    expect(link).toContain(encodeURIComponent(encodeCursorConfig(cursorServerEntry(URL_))));
  });

  it('stays under Cursor\'s 10,000 character limit', () => {
    expect(link.length).toBeLessThan(10_000);
  });
});

describe('snippets', () => {
  it('mcp.json wraps the entry under mcpServers with env interpolation', () => {
    const j = JSON.parse(cursorMcpJson(URL_));
    expect(j.mcpServers['dapta-calendars']).toEqual(cursorServerEntry(URL_));
  });
  it('Claude Code uses the http transport and the env var in the header', () => {
    const c = claudeCodeCommand(URL_);
    expect(c).toContain(`claude mcp add --transport http dapta-calendars ${URL_}`);
    // Single-quoted so the shell leaves `${VAR}` for Claude Code to resolve; a
    // double-quoted `$VAR` would be expanded and the key stored in plaintext.
    expect(c).toContain(`--header 'Authorization: Bearer \${${API_KEY_ENV}}'`);
    expect(c).not.toContain('"Authorization');
  });
  it('Codex reads the token from the environment', () => {
    const c = codexConfigToml(URL_);
    expect(c).toContain('[mcp_servers.dapta-calendars]');
    expect(c).toContain(`url = "${URL_}"`);
    expect(c).toContain(`bearer_token_env_var = "${API_KEY_ENV}"`);
  });
  it('no snippet embeds a real key', () => {
    for (const s of [cursorMcpJson(URL_), claudeCodeCommand(URL_), codexConfigToml(URL_)]) {
      expect(s).not.toMatch(/dcl_[0-9a-f]{8}_/);
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
    expect(MCP_TOOLS).toHaveLength(10);
  });
  it('cancel is the only destructive tool', () => {
    expect(MCP_TOOLS.filter((t) => t.kind === 'destructive').map((t) => t.name)).toEqual(['cancel_booking']);
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
