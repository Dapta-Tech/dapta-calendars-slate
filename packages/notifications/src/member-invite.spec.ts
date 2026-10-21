import { describe, it, expect } from 'vitest';
import { BookingNotifier } from './booking-notifier';
import { deliversEmail, renderMemberInvite, type MemberInviteNotification } from './member-invite';
import { LogOnlyEmailProvider } from './adapters/log-only';
import { NoopEmailProvider } from './adapters/noop';
import type { EmailMessage, EmailProvider, EmailResult } from './email.port';

const base: MemberInviteNotification = {
  accountId: 'acct_1',
  memberId: 'mem_1',
  email: 'pablo@acme.test',
  workspaceName: 'Acme Sales',
  inviterName: 'Alejandro',
  role: 'member',
  acceptUrl: 'https://calendar.example.com/invite/abc123',
  locale: 'en',
  sendKey: '1',
};

class Capture implements EmailProvider {
  sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<EmailResult> {
    this.sent.push(message);
    return Promise.resolve({ delivered: true, driver: 'smtp' });
  }
}

describe('renderMemberInvite', () => {
  it('says who invited whom, where, and which address to sign in with (EN)', () => {
    const r = renderMemberInvite(base);
    expect(r.subject).toBe('Alejandro invited you to Acme Sales');
    expect(r.text).toContain('Alejandro invited you to join Acme Sales as a member.');
    expect(r.text).toContain('Accept the invitation: https://calendar.example.com/invite/abc123');
    expect(r.text).toContain('Sign in with pablo@acme.test to accept.');
    expect(r.html).toContain('href="https://calendar.example.com/invite/abc123"');
    expect(r.html).toContain('Accept invitation');
    expect(r.html).not.toContain('Made with');
  });

  it('is written in Spanish when the inviter works in Spanish', () => {
    const r = renderMemberInvite({ ...base, locale: 'es', role: 'admin' });
    expect(r.subject).toBe('Alejandro te invitó a Acme Sales');
    expect(r.text).toContain('Alejandro te invitó a unirte a Acme Sales como administrador.');
    expect(r.text).toContain('Entra con pablo@acme.test para aceptar.');
    expect(r.html).toContain('Aceptar invitación');
    expect(r.html).toContain('Administrador');
  });

  it('reads without an inviter name', () => {
    const r = renderMemberInvite({ ...base, inviterName: null });
    expect(r.subject).toBe('You’re invited to Acme Sales');
    expect(r.html).not.toContain('>From<');
  });

  it('keeps names out of the headers and the markup', () => {
    const r = renderMemberInvite({
      ...base,
      workspaceName: 'Acme\r\nBcc: x@evil.test <b>bold</b>',
      inviterName: '<script>alert(1)</script>',
    });
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.html).not.toContain('<script>');
    expect(r.html).not.toContain('<b>bold</b>');
    expect(r.html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('never links anywhere but http(s)', () => {
    const r = renderMemberInvite({ ...base, acceptUrl: 'javascript:alert(1)' });
    expect(r.html).not.toContain('javascript:');
  });

  it('names the support desk only when the deployment has one', () => {
    expect(renderMemberInvite(base, { supportEmail: 'help@example.com' }).html).toContain('mailto:help@example.com');
    expect(renderMemberInvite(base).html).not.toContain('mailto:');
  });
});

describe('BookingNotifier.sendMemberInvite', () => {
  it('sends to the invited address with a key per send, not per retry', async () => {
    const capture = new Capture();
    const notifier = new BookingNotifier(capture);
    await notifier.sendMemberInvite(base);
    await notifier.sendMemberInvite(base);
    await notifier.sendMemberInvite({ ...base, sendKey: '2' });
    expect(capture.sent.map((m) => m.to)).toEqual(['pablo@acme.test', 'pablo@acme.test', 'pablo@acme.test']);
    const keys = capture.sent.map((m) => m.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(capture.sent[0].accountId).toBe('acct_1');
  });
});

describe('deliversEmail', () => {
  it('is false for the log-only default and noop, true for a real transport', () => {
    expect(deliversEmail(new LogOnlyEmailProvider())).toBe(false);
    expect(deliversEmail(new NoopEmailProvider())).toBe(false);
    expect(deliversEmail(new Capture())).toBe(true);
  });
});
