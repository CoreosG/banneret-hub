# Relay protocol v1

Canonical copy. banneret-platform mirrors it at `internal/hub/contract/relay-v1/` with a drift test.
First imported from banneret-platform `aed7ce53054b1b45ef77e6399244ce1461791106`.

`openapi.yaml` (OpenAPI 3.1) is the contract between a Banneret Hub server and a central relay. This folder, in
the public Banneret Hub fork at `docs/banneret/relay-v1/`, is the canonical specification; change the contract
here first. The fake relay and conformance suite live in `packages/banneret-relay-fake/` (see `FAKE.md`). The Go
relay in banneret-platform mirrors this folder at `internal/hub/contract/relay-v1/`, and a drift test there fails
when its copy differs from this one. `examples/` holds one valid payload per schema, and `examples/invalid/` holds
payloads the relay must refuse. `contract.test.ts` here, and `contract_test.go` in the mirror, prove the schema
compiles, every example validates (and, in Go, decodes into the Go types), and every invalid example is refused.

Every call starts from a Hub server. The relay never dials a machine and cannot run anything on one.

Rules marked [Orchestrator] are the orchestrator's decisions, pending founder review.

### Pending founder review

These [Orchestrator] rules hold until the founder reviews them:

- the signing scope (method, target with query, device, counter, sending time and body);
- the time-based counter and its 256-counter window;
- `projectKey` hashing;
- the owner and last-heard time set by the relay, never reported by a machine;
- the recognition tick on the confirm page;
- same-owner re-enrolment replacing the old machine;
- the expiry timings: a 10-minute code, 5 wrong codes, a 7-day approval wait;
- the decisions of 2026-11-26: the counter window keeps the 256 highest counters; the quoted `ETag`;
  `DELETE /machines/{machineId}` answering 404 for a malformed or unknown id; the int64 counter maximum; open
  sets for roles and needs-you kinds; and the newly specified behaviour (403 for a foreign `environmentId`, the
  1 MiB body limit, machine visibility, needs-you order, event resume and `reset`, 401 `bad_signature`).

## Endpoints

All under `/relay/v1`.

| Call | Purpose |
|---|---|
| `GET /capabilities` | Protocol version, display name, icon and enrolment entry point for anyone; sections, MCP tools, adapters and `me` for an enrolled caller. |
| `POST /enroll/start` | Start enrolment with the machine's public key and facts; returns a pairing id, confirm code and browser URL. |
| `POST /enroll/poll` | `pending`, `awaiting_approval`, `approved`, `refused` or `expired`; the device token once, on approval. |
| `GET /machines` | The Team machines list, paged: every live machine for everyone, revoked ones for their owner and founders. |
| `DELETE /machines/{machineId}` | Revoke a machine (its owner or a founder). |
| `POST /facts` | The heartbeat: machine facts plus activity facts, every 30 seconds. |
| `GET /today` | The five ordered Today blocks: needs you, shipped, working, stuck, health. |
| `GET /needs` | Needs-you items, paged, most urgent first. |
| `GET /events` | Server-sent events: `needs.changed`, `mention`, `bundle.changed`, `staff.removed`, `capabilities.changed`, `reset`. |

## Enrolment

1. The Hub makes an Ed25519 key pair for this server environment and calls `POST /enroll/start` with the public
   key and its machine facts (including T3's `environmentId`).
2. The Hub shows `confirmCode` and opens `browserUrl` in the person's browser. That is a relay page, not an API:
   the person signs in there through the relay's staff directory (GitHub organisation members by default) and
   types the code the Hub shows. The code is never in a URL. The code expires after 10 minutes, or at once on the
   5th wrong code typed for the pairing (`expired`, reason `too_many_attempts`, `expiresAt` the time of that 5th
   attempt).
3. **The confirm page shows the machine.** Before confirming, the page shows the pending machine's label,
   hostname, operating system and `environmentId`, with the warning "Only confirm a code that your own Banneret
   Hub is showing you right now". The person must tick that they recognise the machine. On a relay without a
   network identity check this is the only guard against a phished code, so the page always requires it.
   [Orchestrator]
4. **Optional network identity check.** Relays SHOULD enable one; Banneret's relay does, through Tailscale
   Serve. A relay configured with a network identity source checks the machine's network identity as a second
   factor only; a relay without one skips this step.
   - the relay records the network identity of the machine's `POST /enroll/start`;
   - at confirmation it must be the signed-in person's registered network identity, or the pairing is refused
     with reason `network_identity_mismatch`;
   - every later signed call is checked again, and a mismatch is refused with 403 `network_identity_mismatch`.
5. A person new to the relay waits in `awaiting_approval` until a founder approves, for at most 7 days; then the
   pairing is `expired` with reason `approval_expired`. [Orchestrator]
6. The Hub polls `POST /enroll/poll`, no sooner than `retryAfterMs`. On `approved` the first poll returns
   `machineId` and `token`; later polls never return the token again. `expiresAt` is the deadline of the current
   state (the code while `pending`, the approval while `awaiting_approval`).
7. **One representation for outcomes.** A refused or expired pairing is a 200 poll response with `state` and
   `reason`:
   - refused: `declined`, `not_staff`, `network_identity_mismatch`, `environment_enrolled`;
   - expired: `code_expired`, `too_many_attempts`, `approval_expired`.

   Error responses from the enrolment calls mean only a malformed request (400), a missing, malformed or
   failing signature (401), an unknown pairing id (404 `not_found`, poll only), a body over 1 MiB (413), rate
   limiting (429) or an unavailable relay (503), as `openapi.yaml` lists per call. [Orchestrator]

**One token per environment.** A device token belongs to one Hub server environment (`environmentId`) and its
person, not to a workspace. A server may hold several workspaces, but at most one Enterprise workspace per relay.
Re-enrolling an environment that already holds a machine record [Orchestrator]:
- confirmed by the **same owner**: the new enrolment replaces the old machine record, with a new machine id, and
  revokes the old token. This is how a Hub that lost its token or key recovers;
- confirmed by a **different person**: refused with reason `environment_enrolled`. The old machine must be
  revoked first.

## Auth and request signing

Every call except the two enrolment calls and an anonymous `GET /capabilities` sends:

| Header | Value |
|---|---|
| `Authorization` | `Bearer <device token>`. Opaque, bound to one machine. |
| `X-Banneret-Device` | The machine id from enrolment. |
| `X-Banneret-Counter` | Decimal integer, 1–19 digits, at most 9223372036854775807 (int64): Unix time in ms × 1000 + a sequence 0–999. |
| `X-Banneret-Sent-At` | RFC 3339 UTC sending time, ending in `Z`. |
| `X-Banneret-Signature` | Standard base64 (padded) Ed25519 signature by the machine key. |

The enrolment calls send no `Authorization` and no `X-Banneret-Device`, use counter `0`, and are signed with the
key in the start request.

When the optional network identity check is configured, the relay also reads the caller's network identity on
every call (Banneret's relay reads it from Tailscale Serve); it must be the machine owner's registered one (see
Enrolment), or the call is refused with 403 `network_identity_mismatch`. The Hub sends nothing for this.

`GET /capabilities` without an `Authorization` header gets the public document. A call that sends a token which
fails (revoked, unknown, badly signed) is refused with 401 and its code, such as `token_revoked`; it never falls
back to the public document. [Orchestrator]

The signature covers these bytes, joined with `\n` (byte 0x0A), followed by the raw body:

```
relay/v1
<METHOD>
<TARGET>          the request target exactly as sent by the Hub: path, plus "?" and the query when there is one
<DEVICE>          the X-Banneret-Device value; empty on enrolment calls
<COUNTER>         the X-Banneret-Counter value as sent
<SENT_AT>         the X-Banneret-Sent-At value as sent
<BODY>            the exact request body bytes; empty when there is none
```

TARGET is verified byte for byte. Proxies in front of the relay must not rewrite the path or query; a Tailscale
Serve path mount must preserve the `/relay/v1/...` target as the Hub sent it.

**The counter is time-based** [Orchestrator]: the Hub's Unix time in milliseconds × 1000, plus a sequence number
0–999 that resets each millisecond. It is strictly increasing per machine, so a restarted Hub never reuses one
and needs no stored counter. Enrolment calls use `0`.

The relay refuses, each with 401:
- a missing or malformed `X-Banneret-Counter`, `X-Banneret-Sent-At` or `X-Banneret-Signature` (including a
  counter above 9223372036854775807, or a non-zero counter on an enrolment call): `bad_signature`;
- a signature that does not verify: `signature_invalid`;
- a sending time more than 2 minutes from its clock: `clock_skew`;
- a counter that repeats or falls below its window: `counter_reused`.

**The counter window.** The relay keeps the 256 highest counters it has accepted from each machine. It refuses a
counter equal to one of them, or below the lowest of them (the 256th highest), and accepts any counter above
that. While it has seen fewer than 256, it accepts any counter that is not a repeat. [Orchestrator]

The 256-counter window lets concurrent requests arrive out of order. This keeps the old devices pairing rule (an Ed25519 key,
standard base64, the method, the path and the raw body, and a 2-minute window) and adds the query, the device,
the counter and the time to the signed bytes, so that `GET` and `DELETE` calls, which have no body, are covered.

### Test vectors

The key is the Ed25519 key from the 32-byte seed `00 01 02 … 1f`. Its public key is
`A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=`. Inputs are shown as JSON strings.

| Signing input | Signature |
|---|---|
| `"relay/v1\nPOST\n/relay/v1/enroll/poll\n\n0\n2026-11-26T10:00:00Z\n{\"pairingId\":\"pr_Zk3mN8vQ\"}"` | `rPCodAbBYNrjUCPlH1wWSIwomRnNdT9uQ5PNpAcVBOasEIMXT8gqBrcgHLeYoQQoHvxuaZjRbjBq6GTICT67Dw==` |
| `"relay/v1\nGET\n/relay/v1/needs?cursor=c_eyJvIjoyfQ&limit=20\nm_4fT9wQ\n1795687200000003\n2026-11-26T10:00:00Z\n"` | `RdNPpOkxOTulgldjylwLSDwD3VB04h1yN4PLAyFQkovxCBoDYMAlEXZbnVL62ko3sx/9yyr/eFcB68EzBUIHCQ==` |

## Facts: nothing but facts leaves the Hub

`POST /facts` and everything inside it is closed (`additionalProperties: false`), and every free string has a
pattern. A heartbeat never carries prompts, replies, code, command text, thread or task titles, local paths or
file contents. The only thread content that ever leaves a Hub is a thread its owner chose to share, and that
goes through a different call.

- **Machine facts:** `environmentId`, `label`, `kind` (`laptop`, `desktop`, `server`, `cloud`), `hostname`, `os`,
  `hubVersion`, `policyFingerprint` (or null), `sandbox {enabled, image}` (image or null). The relay sets the
  owner (from the token) and the last-heard time (from receipt). A machine cannot report either.
- **Activity facts:** one per agent session. Each has:
  - a random `sessionId` and an optional `parentSessionId`;
  - T3's `threadId` and a `projectKey`;
  - the `branch` name and an optional `taskId`;
  - `provider` (`claude` or `codex`), its version, `model` and `persona`;
  - `state` (`working`, `waiting`, `idle`, `stopped`), with `waiting` (`permission`, `question`, `input`) or
    `stopReason`;
  - the tool `name`, plus an `activity` from a fixed list;
  - `processRunning`, `startedAt`, `lastSeenAt` and `bundleSha`.

  Each heartbeat carries the full current set. A session missing from it has ended.
- **`projectKey`** is `sha256:` plus the lowercase hex SHA-256 of the repository identity `host/owner/name`. For
  example `github.com/example-org/example-app` is lowercased, with no scheme, credentials, port or `.git`. It is
  never the T3 project id and never a path. The relay hashes its configured repository list the same way to match
  projects.

## Errors

Every failure has one shape:

```json
{ "error": { "code": "…", "message": "…", "retryable": false, "details": { } } }
```

The codes are fixed: `malformed` (400); `unauthenticated`, `token_revoked`, `bad_signature`, `signature_invalid`,
`clock_skew`, `counter_reused` (401); `forbidden`, `network_identity_mismatch` (403); `not_found` (404); `too_large` (413);
`rate_limited`, `capacity` (429); `unavailable` (503); `internal` (500). `429` and `503` carry `Retry-After`. `message` is for
people; clients act on `code` and `retryable` only.

**Body limit.** A request body over 1 MiB (1,048,576 bytes) is refused with 413 `too_large`. [Orchestrator]

**Ownership.** `POST /facts` whose `machine.environmentId` is not the environment the token's machine enrolled
is refused with 403 `forbidden`. [Orchestrator]

## Paging

List calls take `cursor` and `limit` (1–100, default 50) and return `items` plus `nextCursor` (null on the last
page). Cursors are opaque. Today's needs-you block holds at most 20 items, and its `nextCursor` continues in
`GET /needs`.

## Machines

`GET /machines` shows every enrolled person every live (not revoked) machine of the relay, whoever owns it. A
revoked machine is listed only to its owner and to founders, with `revokedAt` set, `connected` false and
`revocable` false; nobody else sees it. Live machines come first, newest heartbeat first; revoked machines follow,
most recently revoked first. `DELETE /machines/{machineId}` answers 404 `not_found` for a malformed or unknown
id, never 400. [Orchestrator]

## Needs you

`GET /needs`, and Today's needs-you block, are ordered most urgent first: by class, then oldest first within a
class. [Orchestrator]

| Class | Means | Kinds |
|---|---|---|
| 1 | An agent is blocked on a question or approval from you | `thread_question`, `thread_approval` |
| 2 | Something waits on your review or decision | `pull_request`, `promotion`, `founder_question`, `health` |
| 3 | You were mentioned | `mention` |
| 4 | A dispatcher suggestion | `suggestion` |
| 5 | Any kind not listed above | |

`kind` is an open set. A client shows an unknown kind as a generic item and never fails on it.

## Events

`GET /events` without `Last-Event-ID` is live only: it starts with the next event. With `Last-Event-ID` the relay
replays the caller's events after that id, reaching back over the smaller of the last 1000 events and the last 24
hours. Beyond that, or for an id it does not know, the relay sends one `reset` event and then continues live;
the client refetches `GET /today`, `GET /needs` and `GET /capabilities`. [Orchestrator]

## Deep links

Today and needs-you items that belong to a thread carry `deepLink {environmentId, threadId?}`. The Hub opens the
thread when the environment is its own, and otherwise says which machine holds it.

## Capabilities

- **Anonymous callers** get `protocol`, `displayName`, `iconUrl` (or null) and `enrolment` only.
- **Enrolled callers** also get the following, none of it secret:
  - `me {id, login, role}`, so no separate identity call is needed. `role` is an open set (`founder`,
    `limited_staff` today); a client treats an unknown role as `limited_staff`;
  - `sections[] {id, kind, version, flags}`. The Hub renders only these, and ignores kinds it does not know;
  - `mcpTools[] {name, description, role, inputSchema?}`. `role` is the lowest role that may call the tool;
  - `adapters[] {role, kind, version?}`, for the work tracker, staff directory, knowledge and health.
- **Refetching.** The facts response carries `capabilitiesVersion`, and the `capabilities.changed` event says when
  to refetch. The `GET /capabilities` `ETag` is the same value in double quotes: `capabilitiesVersion` `c-7f3a`
  is `ETag: "c-7f3a"`. [Orchestrator]

## Versioning

- The major version is in the path (`/relay/v1`). Within v1 every change is additive: new optional response
  fields, new endpoints, new section kinds, new needs-you kinds, new adapter kinds.
- `protocol` (`1.<minor>`) and `info.version` grow by one minor per additive change.
- Clients ignore response fields and enum values they do not know. Fields that grow within v1 (`Role`,
  `NeedsItem.kind`, section and adapter kinds) are open strings with their known values documented, not closed
  enums, so a validating client accepts new values. Request bodies stay closed: a new request
  field is a new minor that the relay accepts as optional.
- A breaking change is `/relay/v2`.

## Ids and time

- Every id is an opaque string matching `^[A-Za-z0-9_-]{1,64}$` (T3's `environmentId` allows up to 128). Clients
  never parse ids.
- No GitHub numeric id leaves the relay's GitHub adapter; people are `id` plus a display `login`.
- Timestamps are RFC 3339 in UTC, ending in `Z`.

## Extraction guards

This folder names no organisation; examples use `example-org`. In the platform mirror, the folder also imports
nothing from outside `internal/hub`, and `TestExtractionGuards` checks both.
