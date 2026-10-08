import { describe, it, expect, afterEach } from 'vitest';
import { currentAccountId, mayPickAccount } from './iam';

/** An unsigned token body — these readers never verify, by design. */
function token(payload: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
}

afterEach(() => {
  delete process.env.OPERATOR_EMAIL_DOMAIN;
});

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

describe('currentAccountId — which account the session names', () => {
  it('reads the claim, and answers null when there is none to read', () => {
    expect(currentAccountId(token({ account_id: 'acct_1' }))).toBe('acct_1');
    expect(currentAccountId(token({}))).toBeNull();
    expect(currentAccountId('garbage')).toBeNull();
  });
});
