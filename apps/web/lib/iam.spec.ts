import { describe, it, expect, afterEach, vi } from 'vitest';
import { currentAccountId, listWorkspaces, mayPickAccount } from './iam';

/** An unsigned token body — these readers never verify, by design. */
function token(payload: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
}

afterEach(() => {
  delete process.env.OPERATOR_EMAIL_DOMAIN;
  delete process.env.IAM_BASE_URL;
  vi.unstubAllGlobals();
});

/** Stands upstream in, and records the URL the caller asked for. */
function stubIam(body: unknown, { ok = true }: { ok?: boolean } = {}) {
  process.env.IAM_BASE_URL = 'https://iam.example/iam';
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      return { ok, json: async () => body } as Response;
    }),
  );
  return calls;
}

describe('mayPickAccount — who is offered the account picker', () => {
  it('offers nobody when no operator domain is configured (a bare fork)', () => {
    expect(mayPickAccount(token({ email: 'anyone@operator.example' }))).toBe(false);
  });

  it('offers the operator’s own staff, whatever the casing', () => {
    process.env.OPERATOR_EMAIL_DOMAIN = '@operator.example';
    expect(mayPickAccount(token({ email: 'Impl@Operator.Example' }))).toBe(true);
  });

  it('accepts a configured domain written without the leading @', () => {
    process.env.OPERATOR_EMAIL_DOMAIN = 'operator.example';
    expect(mayPickAccount(token({ email: 'impl@operator.example' }))).toBe(true);
  });

  // The trap the leading `@` exists to close: this address ends with the same
  // characters as the configured domain and belongs to someone else entirely.
  it('refuses a domain that merely ends the same way', () => {
    process.env.OPERATOR_EMAIL_DOMAIN = '@operator.example';
    expect(mayPickAccount(token({ email: 'evil@notoperator.example' }))).toBe(false);
  });

  it('refuses a customer, and anything it cannot read', () => {
    process.env.OPERATOR_EMAIL_DOMAIN = '@operator.example';
    expect(mayPickAccount(token({ email: 'host@customer.io' }))).toBe(false);
    expect(mayPickAccount(token({ sub: 'no-email-claim' }))).toBe(false);
    expect(mayPickAccount('not-a-jwt')).toBe(false);
  });
});

describe('listWorkspaces — one searchable page of the picker', () => {
  it('asks for one page, and leaves the query out when there is none', async () => {
    const calls = stubIam({ data: [], hasMore: false });

    await listWorkspaces('tok');

    expect(calls[0]).toBe('https://iam.example/iam/workspace/search-light?page=1&limit=20');
  });

  it('forwards a trimmed query, and skips one that is only spaces', async () => {
    const calls = stubIam({ data: [] });

    await listWorkspaces('tok', { query: '  acme corp ' });
    await listWorkspaces('tok', { query: '   ' });

    expect(calls[0]).toContain('query=acme+corp');
    expect(calls[1]).not.toContain('query=');
  });

  // The page number arrives from a Server Action, so it is caller input.
  it('clamps the page and the page size instead of forwarding them', async () => {
    const calls = stubIam({ data: [] });

    await listWorkspaces('tok', { page: -3, limit: 5000 });

    expect(calls[0]).toContain('page=1');
    expect(calls[0]).toContain('limit=100');
  });

  it('keeps the rows it can read and drops the ones it cannot', async () => {
    stubIam({
      data: [
        { id: 'ws_1', account_id: 'acct_1', name: 'Acme' },
        { id: 'ws_2', account_id: 'acct_2' }, // nameless → falls back to its id
        { id: 'ws_3' }, // no account → unreachable, so not offered
      ],
      hasMore: true,
    });

    const page = await listWorkspaces('tok');

    expect(page.items).toEqual([
      { id: 'ws_1', accountId: 'acct_1', name: 'Acme' },
      { id: 'ws_2', accountId: 'acct_2', name: 'ws_2' },
    ]);
    expect(page.hasMore).toBe(true);
  });

  it('assumes a full page has a next one when upstream does not say', async () => {
    const full = Array.from({ length: 20 }, (_, i) => ({ id: `ws_${i}`, account_id: `acct_${i}` }));
    stubIam({ data: full });

    expect((await listWorkspaces('tok')).hasMore).toBe(true);
  });

  // All three read as "nothing to choose from", which hides the picker — right,
  // because it is an affordance and never the gate.
  it('answers an empty page when upstream is unset, or refuses', async () => {
    expect(await listWorkspaces('tok')).toEqual({ items: [], hasMore: false });

    stubIam({ data: [{ id: 'ws_1', account_id: 'acct_1' }] }, { ok: false });
    expect(await listWorkspaces('tok')).toEqual({ items: [], hasMore: false });
  });
});

describe('currentAccountId — which account the session names', () => {
  it('reads the claim, and answers null when there is none to read', () => {
    expect(currentAccountId(token({ account_id: 'acct_1' }))).toBe('acct_1');
    expect(currentAccountId(token({}))).toBeNull();
    expect(currentAccountId('garbage')).toBeNull();
  });
});
