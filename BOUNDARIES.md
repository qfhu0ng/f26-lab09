# BOUNDARIES.md

One section per milestone. Fill them in in order (the sketch before you write
anything about it, the copies next, the proposal last).

Draw Milestone 1's sketch from the code. A TA may ask where each arrow came
from.

Keep it short and specific. Point at modules, files, and callers.

---

## Milestone 1: The architecture as built

**The sketch.** Drawn from the wiring in `CampusReservePlatform` and the calls
under it. A cylinder is state that one copy holds in its own memory. `A1`–`A4`
is the availability path and `B1`–`B10` the booking path. The module edges
(poms and imports) match `AGENTS.md` rule 1 exactly, so the sketch draws
runtime calls rather than repeating them.

```mermaid
flowchart TB
  client([client])

  subgraph COPY["one api copy: one JVM started by CampusReserveServer.main"]
    subgraph HTTP["http-api: wiring and handlers, holds no domain data"]
      SRV["HttpApiServer + Router"]
      RH["RoomsHandler"]
      BH["BookingsHandler"]
      RA["RequestAuth"]
      AUD["AccountsUserDirectory"]
    end
    subgraph ACC["accounts: writes accounts and tokens"]
      AZ["AuthorizationService"]
      TS[("TokenService.byValue")]
      AD[("AccountDirectory.byId")]
    end
    subgraph CORE["core-domain: rules and ports, writes only through ports"]
      AS["AvailabilityService"]
      BS["BookingService"]
      CC["ConflictChecker + TimeInterval.overlaps"]
    end
    subgraph STO["storage: writes bookings, waitlist, rooms, users, event log (memory)"]
      IBS[("InMemoryBookingStore<br/>findConflicts compares starts and ends itself")]
      IWS[("InMemoryWaitlistStore")]
      IUS[("InMemoryUserStore")]
      LOG[("EventLogPublisher + InMemoryEventLog")]
    end
    subgraph NOT["notifications: writes the outbox, nothing delivers it"]
      NS[("NotificationService + InMemoryOutbox")]
    end
  end

  subgraph CLIP["cli process: builds its own in-memory platform per run"]
    CLI["cli commands"]
    BIL[("billing: invoices")]
  end
  FILE[/"events.jsonl"/]
  PY["analytics (Python): reads only"]

  client -->|"A1 GET /rooms/{id}/availability"| SRV
  SRV -->|"A2"| RH
  RH -->|"A3 freeOnDate"| AS
  AS -->|"A4 findConflicts"| IBS

  client -->|"B1 POST /bookings"| SRV
  SRV -->|"B2"| BH
  BH -->|"B3 require"| RA
  RA -->|"B4 authenticateHeader"| AZ
  AZ -->|"B5 find"| TS
  BH -->|"B6 requestBooking"| BS
  BS -->|"B7 hasConflict"| CC
  BS -->|"B8 findActiveByRoom, save"| IBS
  BS -->|"B8w slot taken"| IWS
  BS -->|"B9 publish"| LOG
  LOG -->|"B10 subscriber"| NS

  NS --> AUD --> AD
  AD -.->|"syncInto, once at startup"| IUS
  CLI --> BIL
  CLI -->|"export-events"| FILE --> PY
```

Where each arrow is in the code:

| Arrow | Code |
|---|---|
| wiring | `CampusReservePlatform` constructor, lines 44–58; routes, lines 153–158 |
| A2, B2 | `HttpApiServer.route`, lines 87 and 101 |
| A3 | `RoomsHandler.availability`, line 80 |
| A4 | `AvailabilityService.busyIntervals`, line 41, into `InMemoryBookingStore.findConflicts`, lines 55–63 |
| B3, B6 | `BookingsHandler.create`, lines 55 and 63 |
| B4, B5 | `RequestAuth.require`, line 30, into `AuthorizationService.authenticate`, line 43 |
| B7, B8 | `BookingService.requestBooking`, lines 112–113 and 124 |
| B8w | `BookingService.joinWaitlist`, line 332 |
| B9, B10 | `BookingService.requestBooking`, line 125, into `EventLogPublisher.publish`, lines 38 and 41; subscribed at `CampusReservePlatform`, line 58 |
| NS to AD | `CampusReservePlatform`, line 57 |
| syncInto | `CampusReserveServer.seed`, line 54, into `AccountDirectory.syncInto`, line 174 |
| cli | `CliContext`, lines 54–63; `ExportEventsCommand`, line 49 |
| billing on storage | `InMemoryInvoiceStore` extends `storage.InMemoryRecordStore` |

**Where your sketch and `ARCHITECTURE.md` disagree.**

1. `ARCHITECTURE.md` (lines 84–86) draws `TimeInterval.overlaps` as the only overlap implementation; the sketch's availability path (A1–A4) never reaches it and ends in a second one, `InMemoryBookingStore.findConflicts`. `ARCHITECTURE.md` does not draw the availability path at all.
2. `ARCHITECTURE.md` (lines 194–196) has the event log outliving a process through `JsonlFileEventLogWriter`; in the sketch no entry point builds that writer, and a running api copy logs to `InMemoryEventLog`, which is gone when the copy stops.
3. The sketch draws user data twice (`AccountDirectory.byId` and `InMemoryUserStore`), joined by one `syncInto` at startup; `ARCHITECTURE.md` draws neither the second copy nor the sync.

**How you decided which one is right.**

1. Read `InMemoryBookingStore.findConflicts` (lines 55–63): it tests
   `start.isBefore(windowEnd) && windowStart.isBefore(end)` inline and never
   calls `overlaps`. Listed its callers with
   `grep -rn findConflicts --include='*.java' */src/main`: the only production
   caller is `AvailabilityService` (lines 35 and 41), which
   `RoomsHandler.availability` reaches through `freeOnDate`. The two predicates
   agree today, and storage's `FindConflictsTest` pins that, including the
   half-open edges (lines 53 and 59) and a comparison against `overlaps`
   (line 99). `AvailabilityServiceTest`, though, runs on the test fake
   `core/support/InMemoryStores` (line 109), which does call `overlaps`, so the
   core-domain gate would not notice the storage copy drifting. The sketch is
   right; the documents state the rule, not the code.
2. `grep -rn "withEventLogFile\|new JsonlFileEventLogWriter" --include='*.java' */src/main`
   finds only the factory itself (`StoreRegistry`, lines 37–38). Both entry
   points call `StoreRegistry.inMemory()` (`CampusReservePlatform`, line 44;
   `CliContext`, line 54), and `CampusReserveServer.main` reads only a port,
   which is all the `Dockerfile`'s `CMD` passes. The CLI's `export-events` does
   write a file (`ExportEventsCommand`, line 49), but only from the platform
   that one CLI run built. The file writer ships and is tested, and nothing
   running uses it, so a booking made over HTTP never reaches `events.jsonl` or
   analytics. The sketch is right for the system as run.
3. `grep -rn "syncInto\|syncAccountsIntoBookingDomain" --include='*.java' */src/main`
   finds one call, in `CampusReserveServer.seed` (line 54), after the two
   seeded accounts are registered. Authentication reads `AccountDirectory`
   (`AuthorizationService`, line 53), while `BookingService.requestBooking`
   checks the booking domain's own `UserStore` (line 98). Both copies exist in
   the code, so the sketch is right to draw them.

---

## Milestone 2: Run it as copies

**Your stack.** `docker compose up -d --build --scale api=2`, with
`compose.yaml` at the root. Scripts run with
`docker compose run --rm --no-deps k6 run /load/<script>.js`. Twenty
`GET /health` requests through the proxy saw 2 distinct `X-Upstream` values
(8 and 12 answers), and every two-copy run below saw both copies in its
`setup()`.

### Finding 1: tokens

**The claim.** A token works on any request, whichever copy answers it.

**The script and its result.** `load/tokens.js`. One VU sends
`GET /bookings` through the proxy 40 times with the member token one copy
printed at startup. Threshold: `token_accepted` `rate==1`, so every request
has to come back 200. `setup()` aborts the run unless at least `MIN_COPIES`
copies (default 2) answer `/health` through the proxy, so a run that reached
one copy cannot pass. Two copies, token from `api-1` (172.19.0.3):

```
copies answering: 172.19.0.3:8080, 172.19.0.2:8080
172.19.0.2:8080: {"401":21}
172.19.0.3:8080: {"200":19}
✗ 'rate==1' rate=47.50%
```

k6 exited 99. Every request the issuing copy answered was a 200, and every one
the other copy answered was a 401. Scaled to one copy (`--scale api=1`, which
kept `api-2`), the guard stopped the run with the default `MIN_COPIES`
("1 copy answered through the proxy, wanted 2.", exit 108). With
`MIN_COPIES=1` and `api-2`'s own token, all 40 were 200 and the threshold
passed (exit 0). So the script can pass, and the failure at two copies comes
from the copies rather than from the token or the script.

**Why, from the code.** Tokens live in `TokenService.byValue`, a
`LinkedHashMap` field of one `TokenService` instance (`TokenService.java`,
line 31). The only `new TokenService` in production code is in the
`CampusReservePlatform` constructor (line 53), and each copy's
`CampusReserveServer.main` builds its own platform (line 26) and issues its own
two tokens from `TokenMinter.random()` (lines 35–36). A token is looked up
only in the answering copy's map: `RequestAuth.require` (line 30) calls
`AuthorizationService.authenticate`, where `tokens.find` comes back empty for
a token this copy never issued and the result is `INVALID_TOKEN` (lines
43–45). `DenialReason.suggestedHttpStatus` (line 65) makes that a 401, with
body `{"error":"invalid_token",...}`. Nothing copies tokens between
processes. Found by following B3–B5 in the Milestone 1 sketch, then
`grep -rn "new TokenService" --include='*.java' */src/main` for the one place
the map is created.

**The kind of problem.** The api is a stateful service. Session state (the
token map) lives in one copy's memory, so the copies are not interchangeable,
and "any copy can serve any request", which horizontal scaling relies on,
does not hold. The state has no home outside a copy. It is not a race: one VU
sending one request at a time sees it.

### Finding 2: bookings

**The claim.** A room slot is booked at most once.

**The script and its result.** `load/bookings.js`. It asks for one room slot
twice: u-1 on copy A, then u-2 on copy B. Threshold: `slot_confirmed`
`count==1`, so twice breaks the claim and never means the run could not book;
and `unexpected_status` `rate==0`, so every answer has to be 201 confirmed or
202 waitlisted. `setup()` picks a slot both copies' availability shows as
free, and aborts unless A refuses B's token (`MIN_COPIES`, default 2), so A
and B cannot quietly be the same copy. Copy A `f26-lab09-api-2`, copy B
`f26-lab09-api-3`:

```
slot: r-1 from 2026-10-31T06:00:00Z for 60 minutes
copy A (http://f26-lab09-api-2:8080): 201 confirmed
copy B (http://f26-lab09-api-3:8080): 201 confirmed
✗ 'count==1' count=2
✓ 'rate==0' rate=0.00%
```

k6 exited 99, and each copy's `/health` afterwards showed `"bookings":1`. With
A and B both pointed at `api-2`, the guard stopped the default run ("A
accepted B's token, so A and B look like the same copy.", exit 108). With
`MIN_COPIES=1`, the same copy answered `201 confirmed` and then
`202 waitlisted` for the next free slot, and both thresholds passed (exit 0).

It reaches each copy by its container name inside the stack
(`http://f26-lab09-api-2:8080`, from `docker compose ps`), with a token that
copy printed. It has to: through the proxy, about half the requests would land
on the copy that never issued their token and come back 401 (Finding 1), and
a 401 says nothing about the slot.

**Why, from the code.** Each copy has its own bookings. The only
`new InMemoryBookingStore()` in production code is in the `StoreRegistry`
constructor (line 25, the waitlist's is line 26), `CampusReservePlatform`
builds one registry per platform with `StoreRegistry.inMemory()` (line 44),
and each copy's `CampusReserveServer.main` builds its own platform (line 26).
`BookingService.requestBooking` checks the slot against
`bookings.findActiveByRoom` (line 112), which reads only the answering copy's
store. On copy B that list was empty, so `ConflictChecker.hasConflict`
(line 113) found nothing and the booking was saved (line 124). On one copy, the
second request found the first booking there and went to `joinWaitlist`
instead. Found by following B6–B8 in the Milestone 1 sketch, then
`grep -rn "new InMemoryBookingStore" --include='*.java' */src/main`.

**The kind of problem.** A check-then-insert whose check reads one copy's
state. Bookings and the waitlist have no single owner: each copy keeps its own
copy of the data and never hears about the other's writes, so the
no-double-booking invariant holds per copy and not for the system. It is not a
race. The two requests were one after the other, so a lock inside
`BookingService` would not help, since it would only guard one copy's memory.

### What you checked

One thing your agent proposed that you checked (what it proposed, how you
checked it, and what came of it).

---

## Milestone 3: One boundary

The problem is Finding 2. Each copy's `StoreRegistry` builds its own
`InMemoryBookingStore` and `InMemoryWaitlistStore` (lines 25–26), and
`BookingService.requestBooking` decides a room is free with
`findActiveByRoom` (line 112) and then calls `save` (line 124). The check sees
one copy, so `load/bookings.js` got the same slot confirmed on both.

**The boundary.** The booking ports decide whether a room is free, in one
call. `BookingStore` gains `saveIfRoomFree(Booking)`, which stores the booking
and answers `Saved`, or stores nothing and answers `Conflict` when an active
booking in the same room overlaps it. Modify and promote use the same call.
`WaitlistStore.nextSequence()` and the promotion step (save the promoted
booking, remove its entry) become one transaction in the store. `storage`
implements the ports against one database that every copy shares, with an
exclusion constraint on the room and a half-open time range (Postgres
`EXCLUDE ... WITH &&`). What moves: the deciding room check, from
`BookingService`'s memory into the store's atomic write, and the bookings and
waitlist rows, out of every copy. What stays: `BookingRules`, the policy, the
order of the checks, FIFO promotion, and `ConflictChecker` for the asker's own
calendar. The in-memory stores stay for tests and the CLI and implement the
same calls under a lock.

**Who owns the data.** `storage` owns the booking and waitlist rows in the
shared database. `BookingService` is the only code that writes them, through
the ports (as `AGENTS.md` rule 4 already says for the waitlist), whether it
runs in an api copy or in the CLI. Everybody else (the handlers,
`AvailabilityService`) may only read through the port's queries, and no copy
keeps booking rows of its own between requests.

**The one invariant that must not cross.** A booking becomes active only
through the store call that refuses it when an active booking in the same room
overlaps it. Any code that saves an active booking after deciding from an
earlier read that the room is free violates it.

**What the boundary costs.**

- A second overlap implementation. The database constraint compares ranges
  itself, against `AGENTS.md` rule 3, so the rule has to name both, and a test
  has to pin them to the same half-open answers. The alternative,
  `UNIQUE(room, cell)` with one row per 15-minute cell, costs up to 16 rows per
  booking, and every modify and cancel rewrites them.
- Seven write paths change shape: request (line 124), modify (209), cancel
  (149), promote (306–307), join (332), leave (233), and drop (285).
- Two implementations to keep in agreement, with contract tests run against
  both. The shipped gates run no database, so CI needs one.
- The performance argument again. Every booking and every availability read
  becomes a round trip, and `findConflicts`, the in-memory shortcut from the
  performance work, has to be redone as an indexed query.
- A new single point of failure. When the database is down, no copy can book.
  Today each copy fails alone.
- What it leaves unfixed: tokens (Finding 1). The booking cap and the asker's
  own calendar (`checkAskerLimits`, lines 337–346) are still check-then-insert
  across rows, so one user on two copies at once can still pass both checks,
  and that needs a transaction per user. The event log and the outbox stay per
  copy.

I would take this if CampusReserve has to run as more than one copy. If one
copy is enough, I would instead make one copy a deployment rule and pay
nothing: at one copy, `load/bookings.js` passes today.
