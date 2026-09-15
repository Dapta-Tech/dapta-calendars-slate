/**
 * Seam — the Integrations tab's decisions (H1b / #93).
 *
 * `apps/web`'s vitest runs in a NODE environment with no DOM, so the card is
 * not renderable here. Every branch it can take is decided by these pure
 * functions instead, which is what makes them testable at all.
 *
 * Two properties carry this file. First, a UI must never offer connecting where
 * it cannot succeed. Second, when the provider named the scopes it was missing,
 * those names must reach the screen LITERALLY — #74 established the field is a
 * scope name list, and paraphrasing it is the whole failure this ticket exists
 * to fix.
 */
import { describe, it, expect } from 'vitest';
import type { IntegrationCapabilities, IntegrationStatusView } from '@slate/types';
import {
  availability,
  canConnect,
  canDisconnect,
  connectFailure,
  connectionState,
  rowFor,
  scopeChecklist,
  scopesFromDetails,
  unhealthyReason,
} from './status';

const row = (over: Partial<IntegrationStatusView> = {}): IntegrationStatusView => ({
  provider: 'hubspot',
  status: 'connected',
  label: 'QA portal',
  tokenLast4: '7788',
  lastCheckAt: 1_788_972_690_463,
  lastCheckOk: true,
  lastCheckDetail: null,
  lastErrorDetail: null,
  ...over,
});

const caps = (over: Partial<IntegrationCapabilities> = {}): IntegrationCapabilities => ({
  provider: 'hubspot',
  enabled: true,
  canStoreCredentials: true,
  requiredScopes: ['crm.objects.contacts.read', 'crm.objects.contacts.write'],
  ...over,
});

describe('connection state (what the ACCOUNT has)', () => {
  it('distinguishes a disconnected row from no row at all', () => {
    // Not cosmetic: a disconnected row keeps its id, and that id is what stops
    // a reconnect from creating a SECOND meeting for a booking that already has
    // one (#63). The card offers Reconnect there, and Connect only when the
    // account has genuinely never connected.
    expect(connectionState(undefined)).toBe('none');
    expect(connectionState(row({ status: 'disconnected' }))).toBe('disconnected');
  });

  it('reports connected and unhealthy from the row', () => {
    expect(connectionState(row())).toBe('connected');
    expect(connectionState(row({ status: 'unhealthy' }))).toBe('unhealthy');
  });

  it('picks the row for the asked-for provider only', () => {
    const rows = [row({ provider: 'other' }), row({ provider: 'hubspot', label: 'mine' })];
    expect(rowFor(rows, 'hubspot')?.label).toBe('mine');
    expect(rowFor(rows, 'nobody')).toBeUndefined();
  });
});

describe('availability (what the DEPLOYMENT can do)', () => {
  it('offers connecting only when an adapter AND a key are present', () => {
    expect(availability(caps())).toBe('ok');
    expect(canConnect(caps())).toBe(true);
  });

  it('names WHICH of the two is missing, so the copy can be specific', () => {
    expect(availability(caps({ enabled: false }))).toBe('disabled');
    expect(availability(caps({ canStoreCredentials: false }))).toBe('no-key');
  });

  it('refuses to offer connecting when either is missing', () => {
    // The whole point of the capabilities route: a Connect button whose only
    // possible outcome is a 400 or a 503 must not be offered, because pressing
    // it is preceded by a trip to the provider's portal.
    expect(canConnect(caps({ enabled: false }))).toBe(false);
    expect(canConnect(caps({ canStoreCredentials: false }))).toBe(false);
  });

  it('reports an unreadable capabilities reply as unknown, NOT as disabled', () => {
    // Failing toward "you cannot connect" is the honest direction, and it is
    // what `canConnect` does. But `disabled` carries copy telling the host to go
    // set CRM_PROVIDER, and a probe that timed out has established no such
    // thing — the likeliest way here is a web build shipped ahead of its API,
    // where the route 404s on a perfectly well-configured deployment.
    expect(availability(null)).toBe('unknown');
    expect(canConnect(null)).toBe(false);
  });

  it('refuses to offer connecting for a provider this deployment did not enable', () => {
    // A deployment can run an adapter that is not this card's. Offering Connect
    // there would only ever answer CRM_DISABLED — the outcome the capabilities
    // route exists to keep the UI out of.
    expect(availability(caps({ provider: 'other' }), 'hubspot')).toBe('disabled');
    expect(canConnect(caps({ provider: 'other' }), 'hubspot')).toBe(false);
    expect(canConnect(caps(), 'hubspot')).toBe(true);
  });
});

describe('the scope checklist', () => {
  it('comes from the adapter, so it cannot drift from what the adapter needs', () => {
    // The names are NOT in the locale catalog: they are provider identifiers a
    // host matches character-for-character on a checkbox in someone else's UI,
    // and a translated one is a wrong one.
    expect(scopeChecklist(caps(), 'hubspot')).toEqual([
      'crm.objects.contacts.read',
      'crm.objects.contacts.write',
    ]);
  });

  it('is empty for a provider the deployment did not enable, or no reply at all', () => {
    expect(scopeChecklist(caps({ provider: 'other' }), 'hubspot')).toEqual([]);
    expect(scopeChecklist(null, 'hubspot')).toEqual([]);
  });

  it('drops blanks rather than rendering an empty checkbox', () => {
    expect(scopeChecklist(caps({ requiredScopes: ['a.b', '  ', ''] }), 'hubspot')).toEqual(['a.b']);
  });
});

describe('disconnect availability', () => {
  it('stays offered on a stored credential whatever the deployment can do', () => {
    // Disconnect scrubs a column. It needs neither an adapter nor a key, and an
    // account that stored a credential must always be able to unplug it — an
    // operator switching CRM_PROVIDER off afterwards must not trap it there.
    expect(canDisconnect(row())).toBe(true);
    expect(canDisconnect(row({ status: 'unhealthy' }))).toBe(true);
  });

  it('is not offered where there is nothing to disconnect', () => {
    expect(canDisconnect(undefined)).toBe(false);
    expect(canDisconnect(row({ status: 'disconnected' }))).toBe(false);
  });
});

describe('why an integration is unhealthy', () => {
  it('renders the scope NAMES the provider returned, verbatim', () => {
    const r = row({
      status: 'unhealthy',
      lastCheckDetail: 'This app hasn’t been granted all required scopes…',
      lastErrorDetail: {
        category: 'MISSING_SCOPES',
        requiredGranularScopes: ['crm.objects.contacts.write'],
      },
    });
    expect(unhealthyReason(r)).toEqual({
      kind: 'scopes',
      scopes: ['crm.objects.contacts.write'],
    });
  });

  it('prefers the scope list over the prose that came with it', () => {
    // The prose is the same sentence for every missing scope. The list is the
    // only part that tells the host which checkbox to go and tick.
    const r = row({
      status: 'unhealthy',
      lastCheckDetail: 'something generic',
      lastErrorDetail: { requiredGranularScopes: ['a.b.c'] },
    });
    expect(unhealthyReason(r).kind).toBe('scopes');
  });

  it('falls through to the provider message when the scope list is empty', () => {
    const r = row({
      status: 'unhealthy',
      lastCheckDetail: 'hubspot rejected the credential (401)',
      lastErrorDetail: { category: 'AUTH', requiredGranularScopes: [] },
    });
    expect(unhealthyReason(r)).toEqual({
      kind: 'message',
      message: 'hubspot rejected the credential (401)',
    });
  });

  it('falls through again when there is no message either', () => {
    expect(unhealthyReason(row({ status: 'unhealthy' }))).toEqual({ kind: 'unknown' });
    expect(
      unhealthyReason(row({ status: 'unhealthy', lastCheckDetail: '   ' })),
    ).toEqual({ kind: 'unknown' });
  });
});

describe('reading a scope list out of an error body', () => {
  it('takes the strings', () => {
    expect(
      scopesFromDetails({
        requiredGranularScopes: ['crm.objects.contacts.read', 'crm.objects.contacts.write'],
      }),
    ).toEqual(['crm.objects.contacts.read', 'crm.objects.contacts.write']);
  });

  it('survives a body that is not the shape it expected', () => {
    // `ApiError.details` is whatever the server sent. Dropping a non-string is
    // better than rendering `[object Object]` beside two real scope names.
    expect(scopesFromDetails(undefined)).toEqual([]);
    expect(scopesFromDetails({})).toEqual([]);
    expect(scopesFromDetails({ requiredGranularScopes: 'nope' })).toEqual([]);
    expect(scopesFromDetails({ requiredGranularScopes: [1, null, {}, ' ', 'ok'] })).toEqual(['ok']);
  });
});

describe('why a connect attempt failed', () => {
  it('carries the scope names through when the credential was refused for one', () => {
    expect(
      connectFailure('INTEGRATION_REJECTED', {
        category: 'MISSING_SCOPES',
        requiredGranularScopes: ['crm.objects.contacts.write'],
      }),
    ).toEqual({ kind: 'scopes', scopes: ['crm.objects.contacts.write'] });
  });

  it('separates rejected from unverified', () => {
    // Different actions: one means go back to the portal, the other means try
    // again in a minute with the same token.
    expect(connectFailure('INTEGRATION_REJECTED', {})).toEqual({ kind: 'rejected' });
    expect(connectFailure('INTEGRATION_UNVERIFIED', undefined)).toEqual({ kind: 'unverified' });
  });

  it('maps the two deployment refusals to their own copy', () => {
    expect(connectFailure('INTEGRATION_KEY_MISSING', undefined)).toEqual({ kind: 'no-key' });
    expect(connectFailure('CRM_DISABLED', undefined)).toEqual({ kind: 'disabled' });
  });

  it('falls back to generic for a code it does not know', () => {
    expect(connectFailure(undefined, undefined)).toEqual({ kind: 'generic' });
    expect(connectFailure('BAD_REQUEST', undefined)).toEqual({ kind: 'generic' });
  });
});
