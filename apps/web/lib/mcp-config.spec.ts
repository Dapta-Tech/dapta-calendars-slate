import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const load = async () => (await import('./mcp-config')).resolveMcpConfig;

describe('resolveMcpConfig', () => {
  it('prefers the explicit MCP address and derives the API origin from it', async () => {
    const r = (await load())({ MCP_PUBLIC_URL: 'https://cal.example.com/mcp/' });
    expect(r).toEqual({ mcpUrl: 'https://cal.example.com/mcp', apiOrigin: 'https://cal.example.com' });
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
});
