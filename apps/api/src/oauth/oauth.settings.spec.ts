import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { loadServerEnv, oauthConfigProblems, oauthMode, serverEnvSchema } from '@slate/config/env';
import { resourceMetadataUrlFor, trimSlash } from './oauth.settings';
import { toolCallNeeds } from '../mcp/mcp.controller';

const on = (extra: Record<string, string> = {}) =>
  serverEnvSchema.parse({
    OAUTH_ENABLED: 'true',
    OAUTH_AUTHORIZATION_SERVER: 'https://auth.example.com',
    MCP_PUBLIC_URL: 'https://calendar.example.com/mcp',
    ...extra,
  });

describe('OAuth configuration fails fast', () => {
  it('off by default, and a bare fork boots', () => {
    const env = loadServerEnv({});
    expect(env.OAUTH_ENABLED).toBe(false);
    expect(oauthMode(env)).toBe('off');
    expect(oauthConfigProblems(env)).toEqual([]);
  });

  it('refuses to boot with OAUTH_ENABLED and anything missing, naming each problem', () => {
    expect(() => loadServerEnv({ OAUTH_ENABLED: 'true' })).toThrow(/MCP_PUBLIC_URL is required[\s\S]*OAUTH_AUTHORIZATION_SERVER is required/);
  });

  it('OAUTH_ENABLED with only the removed built-in settings refuses to boot and says why', () => {
    const problems = oauthConfigProblems(
      on({
        OAUTH_AUTHORIZATION_SERVER: '',
        OAUTH_ISSUER: 'https://calendar.example.com',
        OAUTH_SIGNING_JWK: JSON.stringify(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })),
      }),
    ).join(' | ');
    expect(problems).toContain('OAUTH_AUTHORIZATION_SERVER is required');
    expect(problems).toContain('no longer runs one of its own');
  });

  it('settings of the removed built-in server are ignored next to an external one', () => {
    const env = on({ OAUTH_ISSUER: 'https://calendar.example.com', OAUTH_SIGNING_JWK: 'not even json', OAUTH_DCR_ENABLED: 'true' });
    expect(oauthConfigProblems(env)).toEqual([]);
    expect(oauthMode(env)).toBe('external');
  });

  it('wants an https resource and MCP on', () => {
    const problems = (extra: Record<string, string>) => oauthConfigProblems(on(extra)).join(' | ');
    expect(problems({ MCP_PUBLIC_URL: 'http://calendar.example.com/mcp' })).toContain('https');
    expect(problems({ MCP_PUBLIC_URL: 'http://localhost:4000/mcp', OAUTH_AUTHORIZATION_SERVER: 'http://localhost:9000' })).toBe('');
    expect(problems({ MCP_ENABLED: 'false' })).toContain('MCP_ENABLED');
    expect(problems({})).toBe('');
  });
});

describe('resources', () => {
  it('places the protected-resource metadata per RFC 9728', () => {
    expect(resourceMetadataUrlFor('https://a.example/mcp')).toBe('https://a.example/.well-known/oauth-protected-resource/mcp');
    expect(resourceMetadataUrlFor('https://a.example')).toBe('https://a.example/.well-known/oauth-protected-resource');
  });

  it('trims trailing slashes only', () => {
    expect(trimSlash('https://a.example///')).toBe('https://a.example');
    expect(trimSlash('/mcp/')).toBe('/mcp');
    expect(trimSlash('')).toBe('');
  });
});

describe('which tool calls need a credential', () => {
  const call = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

  it('reads the scope each call needs, public tools need nothing, other methods are ignored', () => {
    expect(toolCallNeeds(call('list_bookings'))).toEqual({ credential: true, scopes: ['bookings:read'] });
    expect(toolCallNeeds(call('whoami'))).toEqual({ credential: true, scopes: [] });
    expect(toolCallNeeds(call('book_meeting'))).toEqual({ credential: false, scopes: [] });
    expect(toolCallNeeds(call('find_available_slots', { booking_page_url: 'https://x.test/a/b/c' }))).toEqual({ credential: false, scopes: [] });
    expect(toolCallNeeds(call('find_available_slots', { event_type_id: 'e1' }))).toEqual({ credential: true, scopes: ['availability:read'] });
    expect(toolCallNeeds({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toEqual({ credential: false, scopes: [] });
    expect(toolCallNeeds(call('no_such_tool'))).toEqual({ credential: false, scopes: [] });
    expect(toolCallNeeds(null)).toEqual({ credential: false, scopes: [] });
  });

  it('the newer tools: a public page needs nothing, an id or a decision needs its scope', () => {
    expect(toolCallNeeds(call('hold_slot', { booking_page_url: 'https://x.test/a/b/c' }))).toEqual({ credential: false, scopes: [] });
    expect(toolCallNeeds(call('hold_slot', { event_type_id: 'e1' }))).toEqual({ credential: true, scopes: ['bookings:write'] });
    expect(toolCallNeeds(call('find_team_slots', { booking_page_url: 'https://x.test/a/team/t/e' }))).toEqual({ credential: false, scopes: [] });
    expect(toolCallNeeds(call('find_team_slots', { event_type_id: 'e1' }))).toEqual({ credential: true, scopes: ['availability:read'] });
    expect(toolCallNeeds(call('book_team_meeting', { booking_page_url: 'https://x.test/a/team/t/e' }))).toEqual({ credential: false, scopes: [] });
    expect(toolCallNeeds(call('book_team_meeting', { event_type_id: 'e1' }))).toEqual({ credential: true, scopes: ['bookings:write'] });
    expect(toolCallNeeds(call('list_pending_bookings'))).toEqual({ credential: true, scopes: ['bookings:read'] });
    expect(toolCallNeeds(call('confirm_booking'))).toEqual({ credential: true, scopes: ['bookings:write'] });
    expect(toolCallNeeds(call('decline_booking'))).toEqual({ credential: true, scopes: ['bookings:write'] });
  });

  it('collects every scope a batch needs', () => {
    expect(toolCallNeeds([call('create_booking'), call('cancel_booking'), call('book_meeting')])).toEqual({
      credential: true,
      scopes: ['bookings:write', 'bookings:cancel'],
    });
  });
});
