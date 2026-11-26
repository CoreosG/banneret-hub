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

Rules marked [Orchestrator] were accepted by the founder on 2026-11-26.

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
| `GET /today` | The five ordered Today blocks: needs you, shipped, working, stuck, health. `?visit=1` marks a real open (see below). |
| `GET /needs` | Needs-you items, paged, most urgent first. |
| `GET /repositories` | The company's repository list, paged: `projectKey`, `name`, optional `url`. |
| `GET /events` | Server-sent events: `needs.changed`, `mention`, `bundle.changed`, `staff.removed`, `capabilities.changed`, `reset`. |
| `GET /snapshot/head` | The caller's current snapshot head: the SHA-256 of each snapshot file. Added in 1.1. |
| `GET /snapshot/files/{sha256}` | One immutable snapshot file, by hash. Added in 1.1. |

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

The signature covers these bytes, joined with `\n` (byte 0x0A), followed by the raw body [Orchestrator]:

```
relay/v1
<METHOD>
<TARGET>          the request target exactly as sent by the Hub: path, plus "?" and the query when there is one
<DEVICE>          the X-Banneret-Device value; empty on enrolment calls
<COUNTER>         the X-Banneret-Counter value as sent
<SENT_AT>         the X-Banneret-Sent-At value as sent
<BODY>            the exact request body bytes; empty when there is none
```

The query is part of TARGET, so it is signed: `GET /today?visit=1` and `GET /today` have different signatures, and a
proxy cannot add or drop `visit=1`.

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
  owner (from the token) and the last-heard time (from receipt). A machine cannot report either. [Orchestrator]
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
- **Usage facts (optional `usage`):** one entry per provider login and window on this machine, each
  `{provider, window, usedPercent, resetsAt}`. `provider` is an open string (known: `claude`, `codex`), `window` is an
  open string (known: `5h`, `weekly`, `monthly`), `usedPercent` is a number from 0 to 100 and `resetsAt` is RFC 3339
  UTC or null. No tokens, costs, prompts, content or account identifiers. This feeds per-person usage (P2-11). Only
  the machine owner's own logins are reported. Like activity, each heartbeat carries the full current set.
- **`projectKey`** is `sha256:` plus the lowercase hex SHA-256 of the repository identity `host/owner/name`. For
  example `github.com/example-org/example-app` is lowercased, with no scheme, credentials, port or `.git`. It is
  never the T3 project id and never a path. The relay hashes its configured repository list the same way to match
  projects. [Orchestrator]

## Today and visits

`GET /today` returns `lastVisitAt`: when the person last opened Today in an earlier visit, or null. The Hub sends
`GET /today?visit=1` only when the person actually opens Today, and plain `GET /today` for background refetches
(such as after `needs.changed`). Only a `visit=1` read can move `lastVisitAt`. Visit reads less than 30 minutes after
the previous visit read count as one visit and leave it as it was; a visit read 30 minutes or more later starts a new
visit, and `lastVisitAt` becomes the time of the previous visit's last read. The only accepted value of `visit` is
`1`; any other is refused with 400 `malformed`.

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

## Repositories

`GET /repositories` is the company's repository list. Enterprise workspaces are made of the local projects whose
repository is on it. The Hub computes the same `projectKey` from each project's git remote and matches it against
the list; no path or remote is sent to the relay. `name` is the display string `owner/name`; `url` is an optional
https link to the repository page. Paged like `GET /needs`. [Orchestrator]

## Needs you

`GET /needs`, and Today's needs-you block, are ordered most urgent first: by class, then oldest first within a
class. [Orchestrator]

| Class | Means | Kinds |
|---|---|---|
| 1 | An agent is blocked on a question or approval from you | `thread_question`, `thread_approval` |
| 2 | Something waits on your review or decision | `pull_request`, `promotion`, `founder_question`, `health` |
| 3 | You were mentioned, or an agent or persona wrote to you | `mention`, `agent_message`, `persona_ask` |
| 4 | A dispatcher suggestion | `suggestion` |
| 5 | Any kind not listed above | `other` (the explicit catch-all), and any unknown kind |

`kind` is an open set. A client shows an unknown kind as a generic item and never fails on it.

Error `code` is an open set too. A client treats an unknown error code by its HTTP status.

## Snapshot

Added in 1.1. `GET /snapshot/head` and `GET /snapshot/files/{sha256}` give the same facts as `GET /needs`,
`GET /today` (working, stuck, health), `GET /machines` and `GET /repositories`, packed as files a client can cache
forever. They carry nothing those calls do not already return to the same caller.

- **Per person.** The head belongs to the caller's person. Every machine of one person gets the same head. Files are
  stored once by hash, so two people with identical bytes share one stored file. A file is readable only while one
  of the caller's retained heads names it. Knowing a hash grants nothing.
- **Shape.** The head is `{protocol, generatedAt, files}`. `files` maps `needs`, `health`, `work`, `machines` and,
  when the relay serves `GET /repositories`, `repositories` to `sha256:<hex>`. The path of a file uses the bare hex.
  The head key decides the schema of the file: `needs` is `SnapshotNeeds`, `health` is `HealthBlock`, `work` is
  `SnapshotWork` (working and stuck; shipped is left out, because it is relative to the last visit),
  `machines` is `SnapshotMachines`, `repositories` is `SnapshotRepositories`, `board`, `map`, `feed` and `graveyard` (added
  in 1.2) are `SnapshotBoard`, `SnapshotMap`, `FeedPage` and `GraveyardPage`. A client ignores keys under `files` it does not know, so
  a 1.1 Hub ignores them.
- **Immutable.** A file never changes, and its body hashes to its name. A changed fact produces a new file and a new
  head. The relay stores a file before it publishes a head that names it, so a client that reads a head can always
  fetch its files.
- **Caching.** The head carries `ETag: "sha256:<hex>"` (the hash of its exact bytes) and
  `Cache-Control: private, no-cache`; `If-None-Match` with a matching tag gets 304 with no body. `generatedAt`
  changes only with the head, which is why 304 can fire. A file is `private, max-age=31536000, immutable`.
- **404 for everything else.** A malformed, unknown, expired or someone else's hash all get the same 404
  `not_found`, never 400. On 404 the client refetches the head once.
- **Retention.** A file stays readable while it is named by one of the caller's last 16 heads, or by a head that was
  replaced less than 10 minutes ago. After that it answers 404, and the client refetches the head.
- **Freshness.** A served head is current. The relay re-checks time-dependent facts (a machine is connected only
  while heard within 90 seconds) at least every 30 seconds, and answers 503 rather than serve a stale head. A broken
  source shows in the file's `state` and `notMeasured`, as on Today.
- **Change notice.** The facts response carries `snapshotEtag`, the head's `ETag` unquoted, absent until the person
  has a head. A Hub refetches the head with `If-None-Match` when that value changes, and after `needs.changed`,
  `capabilities.changed` or `reset`. Rebuilds may be debounced, so a heartbeat's own response can carry the
  previous value; the next one carries the new one. There is no `snapshot.changed` event: working items change on
  every heartbeat, so one event per head change would push `needs.changed` and `mention` out of the replay window
  of `GET /events`.
- **Discovery.** An enrolled caller's capabilities carry `snapshot {version, head}` when the relay serves snapshots.
- **Not a visit.** Reading a snapshot never moves `lastVisitAt`. Shipped stays on `GET /today?visit=1`.
- **Removal.** A person removed from staff, or a revoked machine, is refused as on every other call. A removed
  person's heads are dropped at once.

What the files hold, and who sees what, is the same as the live calls:

| File | Same content as | Varies by |
|---|---|---|
| needs | `Today.needsYou` for the caller | person |
| health | `Today.health` for the caller | role |
| work | `Today.working` and `Today.stuck` for the caller | role, in practice |
| machines | `GET /machines` for the caller | person (revoked machines for owner and founders; `revocable`) |
| repositories | `GET /repositories` | nothing (relay-wide) |
| board | none (snapshot only, added in 1.2) | nothing (relay-wide) |
| map | none (snapshot only, added in 1.2) | nothing (relay-wide) |
| feed | `GET /feed` (added in 1.2) | nothing (relay-wide) |
| graveyard | `GET /graveyard` (added in 1.2) | nothing (relay-wide) |

"No titles" means no title, text or path that a Hub reported (a heartbeat never carries them). The tracker titles that
`GET /needs` and `GET /today` already return to staff stay in the needs and work files.

## Board and leases

Added in 1.2, all additive. A relay that serves the board advertises the section `{kind:"board", flags:["leases"]}`
(plus the flag `checked` when it applies the sign-off rule below)
and names the `board` file in the snapshot head. A 1.1 Hub ignores the head key and the section. A Hub does not
read the board unless capabilities carry the section. The board is snapshot-only: the relay computes it, the Hub
draws it. Writes (take, release, hand-off) are not part of this contract.

**The file.** `SnapshotBoard` is `{state, notMeasured, columns[], cards[]}`.

- `columns` are the relay's five, each `{id, title}`: `free` (Free), `taken` (Taken), `validating` (Validating),
  `stuck` (Stuck), `shipped` (Shipped). Ids are open strings.
- A card is `{task{id, title, ref{tracker, host?, scope, key, url}}, column, status, statusWhy, lease?, pr?{number,
  url, state}, checks?{state}, restsOn[taskId]}`. Objects in the file are closed, so an unknown field is a relay
  defect and a conformance failure. New fields come with a new minor version.
- `lease` is `{holder{id, login}, state, since, lastSignalAt, staleAt, expiresAt}`. A card with no `lease` is
  Free. A relay that cannot read claims says so in the board's `state` and `notMeasured`, never as a lease state.
- The "agent at work" ring is not in the file. The Hub derives it from the `work` file, joined by task id.

**Status.** `status` is an open string; a client accepts values it does not know. One vocabulary serves the board,
and later the map and the feed. `statusWhy` is one plain sentence for hover and for the Task tab. The relay picks the
first matching row:

| Mark | `status` | Word | First match wins |
|---|---|---|---|
| † | `ruled_dead` | ruled dead | Issue closed as "not planned" |
| ● | `checked` | checked | `checked` label that passes the sign-off rule (see "Checked") |
| ✕ | `sent_back` | sent back | Issue reopened after its PR merged; review "changes requested"; PR closed unmerged |
| ◆ | `needs_you` | needs you or blocked | `needs:<person>` or `blocked` label; failing required checks; lease conflict; a rests-on task that is `needs_you`, `sent_back` or `ruled_dead` |
| ◐ | `built` | built, unchecked | Linked PR merged, or issue closed as completed |
| ○ | `planned` | planned | Open, none of the above |

The rule for "checked" is under "Checked", below.

**Lease state.** `state` is an open string; known values `active`, `stale`, `expired`, `paused`, `conflict`. Time
runs from `lastSignalAt`, the latest heartbeat, push or comment:

- `staleAt` is `lastSignalAt` plus 6 hours. After it the lease is `stale` and the card is in Stuck.
- `expiresAt` is `lastSignalAt` plus 24 hours. After it the lease is `expired`.
- An expired lease stays in Stuck. It is never shown as Free while the tracker still names the assignee, because
  only a release on the tracker frees the task.
- `paused` and `conflict` (two holders claim one task) come from the claims, not from time.

**Heartbeat from facts.** An activity fact refreshes a lease only when **all** of these hold:

- the machine that sent it belongs to the **lease holder**. A coworker's agent on the same task or branch never
  refreshes someone else's claim, because that would hide the `stale` (6 h) and `expired` (24 h) rules. This mirrors
  GitHub activity, where only the holder's own pushes and comments count;
- its session is **running**: `processRunning` is true, or `state` is not `stopped`. A fact whose `state` is
  `stopped` with `processRunning` false (a failed, interrupted or cancelled run) is not a heartbeat;
- it matches the task: by `taskId` when the activity carries one, otherwise by `branch` and `projectKey`.

A match sets `lastSignalAt` to the receipt time, which returns a `stale` or `expired` lease to `active`. A fact that
fails any of the three changes nothing. The `taskId` is an opaque id the Hub takes from the thread's linked issue.

## Map and the stage plan

Added in 1.2, all additive. A relay that has a stage plan advertises the section `{kind:"map", flags:["rests_on"]}` and
names the `map` file in the snapshot head. A 1.1 Hub ignores both. A Hub does not read the map unless capabilities carry
the section. Like the board, the map is snapshot-only: the relay computes it and the Hub draws it.

**When it is advertised.**

- No stage plan configured: the section and the head key are omitted. A tracker without a plan keeps its board.
- Configured and valid: the section is present and `map.state` is `ok`.
- Configured but unreadable or invalid: the section is present, `state` is `not_measured`, and `notMeasured` says why,
  with `reason` `unreachable` (the file could not be read) or `malformed` (it broke a rule below) and a one-sentence
  `detail` naming the rule. `stages` and `items` are empty. The Hub never shows a broken plan as an empty one.

**The file.** `SnapshotMap` is `{state, notMeasured, stages[{id, title, order}], items[{id, stageId, title, status,
statusWhy, task?{id, title, ref}, restsOn[itemId]}], counters{byStatus{<status>: n}, byStage{<stageId>: {<status>: n}}}}`.
Objects are closed, like the board's.

- `stages` are in ascending `order`, ties in plan order. `items` are grouped by stage in that order, and keep plan
  order within a stage.
- `task` is the board task the item's plan `task` resolves to: the board card whose `ref` has the same `tracker`,
  `host` (both absent counts as equal), `scope` and `key`. It is absent when the plan gives the item no `task`, and
  also when the board holds no such task.
- `restsOn` lists **item** ids, copied from the plan.
- `counters` count every item once by its final status. `byStage` has an entry for every stage, empty when the stage
  has no items.

**Status.** The vocabulary is the board's (see "Board and leases"): `ruled_dead`, `checked`, `sent_back`, `needs_you`,
`built`, `planned`, and the same first-match order.

1. An item with a `task` takes that task's computed status and `statusWhy` from the board card. An item without a
   `task`, or whose task is not on the board, is `planned`.
2. A rests-on item that ends up `needs_you`, `sent_back` or `ruled_dead` makes its dependant `needs_you`, with a
   `statusWhy` that names the blocker, for example `It rests on "Profile blocks", which needs you.` This applies only
   when the dependant's own status ranks below `needs_you` (`built` or `planned`): `ruled_dead`, `checked` and
   `sent_back` keep their own status, as in the first-match order.
3. The rule is applied dependencies first, so a blocked item blocks its own dependants in turn. When several
   dependencies block, the first in `restsOn` order is named.

## Stage plan file

The relay never parses prose. It reads one machine-readable file, the **stage plan**, and builds the map from it. The
format is public: any company can produce one. Banneret generates its own from its knowledge base (`docs/spec/stages.json`
there, never edited by hand). `stage-plan.schema.json` (JSON Schema 2020-12) is the structure, and
`examples/stage-plan.json` is an example. Where the relay finds the file is the relay's configuration: a repository path
read through its knowledge adapter, or a local file.

```json
{
  "version": 1,
  "generatedAt": "2026-11-26T09:00:00Z",
  "source": "example-org/build-spec at 4f2a9c1",
  "stages": [{ "id": "s1", "title": "Foundations", "order": 10 }],
  "items": [
    {
      "id": "sign-in",
      "stageId": "s1",
      "title": "Sign-in page",
      "restsOn": [],
      "task": { "tracker": "github", "scope": "example-org/example-app", "key": "39" }
    }
  ]
}
```

- `version` is `1`. A relay refuses a version it does not know.
- `generatedAt` is a timestamp. `source` is optional plain text saying where the file came from.
- `stages[]` is `{id, title, order}`. `items[]` is `{id, stageId, title, restsOn?[itemId], task?{tracker, host?, scope,
  key}}`.
- Ids are stable strings (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`) that never change when a title does. Titles are plain
  text. There are no prose fields beyond titles, and unknown fields are refused.
- `task` names the tracker issue behind an item, with the fields of a board `ref` (without the url), so the relay can
  join the item to the board's computed status. The plan carries no status of its own.

**Validation.** Beyond the schema, the relay refuses a plan that breaks any of these: stage ids are unique, item ids are
unique, every `stageId` names a stage, every `restsOn` entry names an item and not the item itself, and `restsOn` has no
cycle. A plan that fails is not partly used: the map is `not_measured` with `reason` `malformed` and a `detail` naming
the first failing rule. A file that cannot be read is `not_measured` with `reason` `unreachable`.

## Feed and graveyard

Added in 1.2, all additive. A relay that serves them advertises the section `{kind:"feed", flags:["graveyard"]}` and
names the `feed` (and, with the flag, the `graveyard`) file in the snapshot head. A Hub does not read either file
unless capabilities carry the section.

- **The files.** Both are `{entries[], nextCursor}`: `FeedPage` and `GraveyardPage`. Each holds the latest 100
  entries, newest first. `nextCursor` is null when nothing is older.
- **Paging.** `GET /feed?cursor=` and `GET /graveyard?cursor=` are signed and cursor-paged like `GET /needs`
  (`cursor`, `limit` 1 to 100, 400 `malformed` for a cursor the relay did not issue). The file's `nextCursor`
  continues in the call. A cursor is opaque, and a page can shift when new entries arrive.
- **Derived only.** The relay builds entries from tracker and relay events. A client cannot write one; written
  entries (comments, announcements) wait for a later minor version.
- **Feed entry.** `{id, type, at, author?{id, login}, importance, summary, link?, task?{id, title, ref}, status?}`.
  Objects are closed. `type` is an open string; known values `taken`, `released`, `lease_expired`, `pr_opened`,
  `pr_merged`, `built`, `checked`, `sent_back`, `ruled_dead`, `comment`. `importance` is an open string; known
  values `high`, `normal`, `low`. `status` is the task's status when the entry was made, in the board vocabulary.
  `author` is absent for something the relay noticed itself. `summary` is one plain sentence.
- **Graveyard entry.** `{task{id, title, ref}, cause, ruledAt, by?{id, login}, link?}`. `cause` is always present:
  the Hub shows it, so a task never sits in the graveyard without a reason.

## Task

Added in 1.2. A relay that serves it advertises the section `{kind:"task", flags:[]}`. `GET /tasks/{taskId}` is
signed and returns one board card (every field of `BoardCard`) plus two optional fields:

- `preview?{state, url?}`: `state` is an open string, known values `building`, `ready`, `failed`; `url` is present
  when the preview can be opened.
- `checked?{by{id, login}, at, valid, ignoredReason?}`: the sign-off record, present when the task has a `checked`
  label. See "Checked".

A `taskId` that is malformed (not an `Id`) or unknown answers 404 `not_found`, never 400, like `DELETE
/machines/{machineId}`. The Hub reads the card from the `board` or `map` file when it holds the task and calls this
only for the rest.

## Checked

"Checked" means a person with the **sign-off role** confirms the item after CI passed and review approved. (Banneret's
preset gives the sign-off role to founders; another company may map it differently, and the relay decides.) The sign-off
lives in the `checked` label on the tracker issue; the relay keeps no store of its own. It counts only when the tracker's
event log shows **all** of:

1. a holder of the sign-off role added the `checked` label, and it is the **latest** `labeled` event for `checked`
   (a later `unlabeled` event removes the check);
2. the linked pull request had already merged;
3. its checks were green;
4. a review was approved by someone **other than the person who added the label**, the approval is on the **merged
   head commit**, and it still stands: a dismissed approval, or a later "changes requested" from the same reviewer,
   voids it.

Identity is the stable `id`, never the login: `checked.by` and the reviewer are compared by `id`, and the login is
display only (`checked.by` is `{id, login}` like every other person in this protocol).

If any of these fails, the relay ignores the label: `checked.valid` is false, `checked.ignoredReason` says why in one
plain sentence (for example "The person who checked it also approved the review." or "ada-example does not hold the
sign-off role."), and the card's `status` is not `checked`. A relay that applies the rule advertises the flag `checked`
on the `board` section. A Hub draws a valid check as the checked mark with who and when, and an invalid one as the
built mark with the reason.

## Events

`GET /events` without `Last-Event-ID` is live only: it starts with the next event. With `Last-Event-ID` the relay
replays the caller's events after that id, reaching back over the smaller of the last 1000 events and the last 24
hours. When the relay no longer holds every event after that id, or does not know the id, it sends one `reset`
event instead and then continues live; the client refetches `GET /today`, `GET /needs` and `GET /capabilities`. [Orchestrator]

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

### Changelog

- **1.2.** Adds the board and leases (see "Board and leases"): the `board` head key and `SnapshotBoard` file, the
  `board` section kind with flag `leases`, and the facts-as-heartbeat rule. A 1.1 Hub ignores unknown head keys and
  section kinds, so nothing breaks. A client reads the board only when capabilities carry the `board` section.
  Also in 1.2 (additive): the feed and graveyard (see "Feed and graveyard"): the `feed` and
  `graveyard` head keys, `GET /feed` and `GET /graveyard`, the `feed` section with flag `graveyard`; the task read
  (see "Task"): `GET /tasks/{taskId}` and the `task` section; and the `checked` rule (see "Checked") with the flag
  `checked` on the `board` section.
  Also in 1.2 (additive): the map (see "Map and the stage plan"): the `map` head key and `SnapshotMap` file, the `map`
  section with flag `rests_on`, advertised only when a stage plan is configured; the stage plan file format (see "Stage
  plan file"); and an optional `detail` sentence on `NotMeasured`.
- **1.1.** Banneret Hub 0.1.1211 shipped with 1.0, so from here on every additive change bumps the minor. 1.1 adds:
  - the `visit=1` flag on `GET /today`;
  - `usage` in facts;
  - the needs-you kinds `agent_message`, `persona_ask` and `other`;
  - the snapshot endpoints (`GET /snapshot/head`, `GET /snapshot/files/{sha256}`), `snapshot` in capabilities and
    `snapshotEtag` in the facts response.

  A client treats all of these as optional when it talks to a 1.0 relay: it does not send `visit=1` or `usage`
  unless the relay's `protocol` is 1.1 or later, it does not call the snapshot endpoints unless capabilities carry
  `snapshot`, and it ignores a missing `snapshotEtag`.
- **1.0.** The first release.

## Ids and time

- Every id is an opaque string matching `^[A-Za-z0-9_-]{1,64}$` (T3's `environmentId` allows up to 128). Clients
  never parse ids.
- No GitHub numeric id leaves the relay's GitHub adapter; people are `id` plus a display `login`.
- Timestamps are RFC 3339 in UTC, ending in `Z`.

## Extraction guards

This folder names no organisation; examples use `example-org`. In the platform mirror, the folder also imports
nothing from outside `internal/hub`, and `TestExtractionGuards` checks both.
