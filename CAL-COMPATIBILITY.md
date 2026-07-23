# Cal.com compatibility and gap matrix

This matrix names what works today. Anything not marked **Implemented** must not be inferred from a
similar `/v1` route.

| Cal.com v2 resource                           | Status          | Milestone / notes                                              |
| --------------------------------------------- | --------------- | -------------------------------------------------------------- |
| Slots by event type ID                        | **Implemented** | R1, `2024-09-04`                                               |
| Slots by personal slug + username             | **Implemented** | R1                                                             |
| Slots by team slug                            | **Implemented** | R1; existing round-robin, collective, fixed round-robin engine |
| Slots `format=range`                          | **Implemented** | R1                                                             |
| Slots reschedule exclusion                    | Explicit `422`  | R2                                                             |
| Dynamic usernames availability                | Not routed      | Later compatibility milestone                                  |
| Create personal booking                       | **Implemented** | R1, `2026-02-25`                                               |
| Create team booking                           | **Implemented** | R1; assigned hosts come from the existing engine               |
| Creation-time guests                          | **Implemented** | R1; every unique guest is persisted                            |
| Booking metadata and booking fields           | **Implemented** | R1; documented value limits apply                              |
| Create recurrence / seats / instant / routing | Explicit `422`  | Deferred                                                       |
| Reservations                                  | Not routed      | R2                                                             |
| Get one booking                               | Not routed      | R2                                                             |
| List bookings                                 | Not routed      | R2                                                             |
| Cancel booking                                | Not routed      | R2                                                             |
| Reschedule booking with new UID               | Not routed      | R2                                                             |
| Add/list guests or attendees                  | Not routed      | R2                                                             |
| Calendar discovery                            | Not routed      | R3                                                             |
| Raw multi-calendar busy times                 | Not routed      | R3                                                             |
| Selected calendars                            | Not routed      | R3                                                             |
| Destination calendar                          | Not routed      | R3                                                             |
| 100-calendar JSON batch availability          | Not routed      | R3                                                             |
| Event-type discovery                          | Not routed      | R3/read-only follow-up                                         |
| Team discovery                                | Not routed      | R3/read-only follow-up                                         |
| Schedule discovery                            | Not routed      | Later read-only milestone                                      |

`/v1` public, host, admin, and machine routes preserve their existing paths and envelopes.
