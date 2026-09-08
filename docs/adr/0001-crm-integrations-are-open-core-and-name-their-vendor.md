# CRM integrations are open core and may name their vendor

## Context

Invariant R15 in `CLAUDE.md` forbids naming a calendar vendor anywhere in this
repo: the calendar seam is vendor-neutral, and a real integration platform is a
private overlay loaded by `CALENDAR_BACKEND_MODULE`. The pilot needs a
user-facing HubSpot integration, which forces the question of whether that rule
also binds CRM vendors — and, if it does not, whether the adapter still belongs
in a private overlay.

## Decision

R15 governs **calendar** vendors only. A CRM adapter may name its vendor.

The CRM seam ships **open core**: `packages/crm` defines the `CrmProvider` port,
and the HubSpot adapter lives beside it in this repo, selected by
`CRM_PROVIDER` (`disabled` default, `hubspot`). Same shape as the entitlements
port: a disabled no-op default plus one real adapter.

## Why

R15 exists because Dapta's calendar connectivity runs through a commercial
integration platform whose contract and identity are not ours to publish. No
equivalent constraint applies here. The HubSpot integration is built entirely on
HubSpot's public API, authorized by a private-app token that the end user pastes
in themselves — there is no Dapta-side credential, contract, or infrastructure
name to protect.

The alternative was to mirror the calendar seam exactly: keep only the port in
this repo and load a HubSpot adapter from the gitignored `deploy/` overlay. That
was rejected because it buys no secrecy and costs the open-core promise. A bare
fork would get an empty seam and no way to fill it; with the adapter in-repo, a
fork pastes a token and has a working CRM integration.

The publish-gate secret scan was checked before deciding: its denylist covers
Dapta infrastructure names and hosts only, so `hubspot`, `api.hubapi.com`, and
`HUBSPOT_PRIVATE_APP_TOKEN` pass it cleanly.

## Consequences

- A reader who finds a named vendor under `packages/crm` next to R15 should read
  this ADR rather than "fix" the apparent violation.
- A second CRM is a second adapter behind the same port, not a second seam.
- The calendar rule is untouched. No calendar vendor may be named, ever.
