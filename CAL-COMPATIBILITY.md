# Cal.com compatibility and pilot gap matrix

This matrix is intentionally literal. Similar `/v1` or internal operations do not imply a `/v2`
contract.

| Capability                              | Pilot status                 | Notes                                                                 |
| --------------------------------------- | ---------------------------- | --------------------------------------------------------------------- |
| Personal/team event-type discovery      | **Implemented**              | Key/tenant scoped; current `2024-06-14` pin                           |
| Provider calendar discovery             | **Implemented**              | Stable Dapta IDs, permission capabilities, explicit provider failures |
| One/many calendar availability          | **Implemented**              | Dapta JSON extension, 1–100 IDs, three aggregation modes              |
| Personal/team slots                     | **Implemented**              | Current `2024-09-04`; round-robin/collective/fixed-round-robin engine |
| Personal/team booking create            | **Implemented**              | Current `2026-02-25`                                                  |
| Creation guests/metadata/fields         | **Implemented**              | Every unique guest persists                                           |
| Personal destination calendar           | **Implemented**              | Requires explicit create capability                                   |
| Get booking by UID                      | **Implemented**              | Current `2026-02-25`                                                  |
| Add guests                              | **Implemented**              | Current `2024-08-13`; dedupe and limits                               |
| New-UID reschedule                      | **Implemented**              | Bidirectional linkage and provider reference transfer                 |
| Cancel                                  | **Implemented**              | UID preserved                                                         |
| Idempotency on every mutation           | **Implemented**              | Dapta extension for Flow retries                                      |
| Team destination override               | Explicit `422`               | Dynamic assigned-host destination cannot be safely overridden         |
| Seats / recurrence / instant / routing  | Explicit `422` or not routed | Outside pilot                                                         |
| Slot reservations                       | Not routed                   | Outside pilot                                                         |
| Booking list/search/filter              | Not routed                   | Outside pilot                                                         |
| Guest removal/list as separate resource | Not routed                   | Full guest state is returned on booking reads                         |
| Old Cal version adapters                | Not implemented              | Exact pilot pins only                                                 |
| PBAC / broad Cal admin resources        | Not implemented              | Dapta API-key scopes are authoritative                                |
| Webhook parity                          | Not claimed                  | Existing native Dapta webhook effects remain                          |

`/v1` public, machine, host, and admin paths keep their existing routes and envelopes.
