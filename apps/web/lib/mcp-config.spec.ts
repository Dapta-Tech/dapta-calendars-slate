import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const load = async () => (await import('./mcp-config')).resolveMcpConfig;

describe('resolveMcpConfig', () => {
  it('prefers the explicit MCP address and derives the API origin from it', async () => {
    const r = (await load())({ MCP_PUBLIC_URL: 'https://cal.example.com/mcp/' });
    expect(r).toEqual({ mcpUrl: 'https://cal.example.com/mcp', apiOrigin: 'https://cal.example.com' });
  });
  it('keeps a path prefix when it derives the API base from the MCP address', async () => {
    const r = (await load())({ MCP_PUBLIC_URL: 'https://host.example.com/calendar/mcp' });
    expect(r).toEqual({ mcpUrl: 'https://host.example.com/calendar/mcp', apiOrigin: 'https://host.example.com/calendar' });
  });
  it('takes only the origin from an MCP address that does not end in /mcp', async () => {
    const r = (await load())({ MCP_PUBLIC_URL: 'https://mcp.example.com/agents' });
    expect(r.apiOrigin).toBe('https://mcp.example.com');
  });
  it('keeps the path of an explicit API_PUBLIC_URL, over anything the MCP address implies', async () => {
    const r = (await load())({ API_PUBLIC_URL: 'https://host.example.com/calendar-api/', MCP_PUBLIC_URL: 'https://mcp.example.com/mcp' });
    expect(r).toEqual({ mcpUrl: 'https://mcp.example.com/mcp', apiOrigin: 'https://host.example.com/calendar-api' });
  });
  it('builds /mcp off API_PUBLIC_URL when only that is set', async () => {
    const r = (await load())({ API_PUBLIC_URL: 'https://api.example.com/' });
    expect(r).toEqual({ mcpUrl: 'https://api.example.com/mcp', apiOrigin: 'https://api.example.com' });
  });
  it('never reads a NEXT_PUBLIC value', async () => {
    const r = (await load())({ NODE_ENV: 'production', NEXT_PUBLIC_API_URL: 'https://baked.example.com' });
    expect(r).toEqual({ mcpUrl: null, apiOrigin: null });
  });
  it('gives a bare clone the local API, and production nothing', async () => {
    expect((await load())({}).mcpUrl).toBe('http://localhost:4000/mcp');
    expect((await load())({ NODE_ENV: 'production' }).mcpUrl).toBeNull();
  });
  it('rejects a non-http value', async () => {
    expect((await load())({ NODE_ENV: 'production', MCP_PUBLIC_URL: 'javascript:alert(1)' }).mcpUrl).toBeNull();
  });
  it('treats an address with credentials, a query or a fragment as unset', async () => {
    const resolve = await load();
    const withUser = new URL('https://cal.example.com/mcp');
    // Userinfo set at runtime so no credential-looking literal sits in the source.
    withUser.username = 'user';
    withUser.password = 'secret';
    for (const v of [withUser.href, 'https://cal.example.com/mcp?token=abc', 'https://cal.example.com/mcp#x']) {
      expect(resolve({ NODE_ENV: 'production', MCP_PUBLIC_URL: v })).toEqual({ mcpUrl: null, apiOrigin: null });
      expect(resolve({ NODE_ENV: 'production', API_PUBLIC_URL: v.replace('/mcp', '') })).toEqual({ mcpUrl: null, apiOrigin: null });
    }
  });
});

describe('signInMcpUrl', () => {
  const read = async () => (await import('./mcp-config')).signInMcpUrl;

  it('is MCP_PUBLIC_URL, cleaned, and only that: never derived from API_PUBLIC_URL', async () => {
    const f = await read();
    expect(f({ MCP_PUBLIC_URL: 'https://mcp.example.com/mcp/' })).toBe('https://mcp.example.com/mcp');
    expect(f({ API_PUBLIC_URL: 'https://api.example.com' })).toBeNull();
    expect(f({ NODE_ENV: 'development' })).toBeNull();
    expect(f({ MCP_PUBLIC_URL: 'javascript:alert(1)' })).toBeNull();
  });
});

describe('claudeDirectoryUrl', () => {
  const directory = async () => (await import('./mcp-config')).claudeDirectoryUrl;
  const LISTING = 'https://claude.ai/directory/acme-calendars';

  it('is the listing the deployment sets, cleaned', async () => {
    const read = await directory();
    expect(read({ MCP_CLAUDE_DIRECTORY_URL: LISTING })).toBe(LISTING);
    expect(read({ MCP_CLAUDE_DIRECTORY_URL: ` ${LISTING}/ ` })).toBe(LISTING);
  });

  it('is null when unset, blank, not a URL or not https', async () => {
    const read = await directory();
    expect(read({})).toBeNull();
    expect(read({ MCP_CLAUDE_DIRECTORY_URL: '  ' })).toBeNull();
    expect(read({ MCP_CLAUDE_DIRECTORY_URL: 'dcal' })).toBeNull();
    expect(read({ MCP_CLAUDE_DIRECTORY_URL: 'http://claude.ai/directory/dcal' })).toBeNull();
    // A query or a fragment makes it no clean public URL at all.
    expect(read({ MCP_CLAUDE_DIRECTORY_URL: `${LISTING}?ref=x` })).toBeNull();
  });

  it('is only ever a page of Claude\'s directory: the button says so', async () => {
    const read = await directory();
    for (const v of ['https://example.com/directory/dcal', 'https://claude.ai.example.com/directory/dcal', 'https://evil.example/claude.ai/']) {
      expect(read({ MCP_CLAUDE_DIRECTORY_URL: v }), v).toBeNull();
    }
  });

  it('knows no listing yet for any MCP address, the hosted one included, so nothing points at a page that does not exist', async () => {
    const read = await directory();
    expect(read({ MCP_PUBLIC_URL: 'https://mcp.dcal.ai/mcp' })).toBeNull();
    expect(read({ MCP_PUBLIC_URL: 'https://mcp.dev.dcal.ai/mcp' })).toBeNull();
  });

  it('lets a deployment listed under its own address point at its own listing', async () => {
    const read = await directory();
    expect(read({ MCP_PUBLIC_URL: 'https://mcp.acme.example/mcp', MCP_CLAUDE_DIRECTORY_URL: LISTING })).toBe(LISTING);
  });

  it('never reads a build-time NEXT_PUBLIC_ variable', async () => {
    const read = await directory();
    expect(read({ NEXT_PUBLIC_MCP_CLAUDE_DIRECTORY_URL: LISTING })).toBeNull();
  });
});
