# Production pilot release and rollback

The implementation commit is safe to prepare but must not be pushed, merged, or deployed by the
implementation agent.

## Coordinator release sequence

1. Review the signed commit and confirm the intended production image/tag.
2. Back up the production Postgres database and record the currently deployed API/web image digests.
3. Build the workspace and API/web images from the reviewed commit:
   `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
4. Run `DATABASE_URL=<production-postgres> pnpm db:migrate` once. Migrations
   `0012_public_api_mvp.sql` are additive.
5. Deploy the API image first with the existing production environment and calendar backend overlay.
6. Verify `/health/ready`, `/openapi.json`, and `/docs`; create a least-privilege pilot `dcl_` key.
7. Smoke test discovery, slots, create/get/add-guest/reschedule/cancel against a dedicated test event
   type/calendar. Confirm the provider event moved in place and no duplicate invite exists.
8. Deploy the web image only if the release process pins both apps to the same repository revision.
9. Watch API 4xx/5xx, provider errors, outbox pending/failed counts, and duplicate-booking reports
   through the pilot window.

## Risks

- Calendar permission metadata is fail-closed; incomplete provider capability mapping can produce
  visible 403s until the private backend returns explicit capabilities.
- Batch calendar availability is provider free/busy, not event-type working-hours availability.
  Use `/v2/slots` before booking.
- New-UID reschedule moves the persisted provider reference. A provider outage leaves a durable
  outbox retry; monitor `/health/ready` outbox counts.
- SQLite has transactional app guards; production Postgres remains the hard overlap guarantee.
- Seats, recurrence, routing, reservations, and broad Cal compatibility are intentionally absent.

## Rollback

1. Stop new pilot traffic/revoke the pilot key.
2. Redeploy the previously recorded API image digest, then its matching web digest if changed.
3. Do not roll back the additive migration during an incident. Old code ignores the new nullable
   columns/tables, so leaving them is the safer rollback.
4. Drain or inspect calendar/email outbox rows created before rollback. Do not delete them blindly;
   reconcile provider events by booking UID.
5. Restore the database backup only for confirmed data corruption, with product-owner approval.
