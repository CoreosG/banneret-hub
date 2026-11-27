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
| `GET /capabilities` | Display name, icon and enrolment entry point for anyone; sections, MCP tools, adapters and `me` for an enrolled caller. |
| `POST /enroll/start` | Start enrolment with the machine's public key and facts; returns a pairing id, confirm code and browser URL. |
| `POST /enroll/poll` | `pending`, `awaiting_approval`, `approved`, `refused` or `expired`; the device token once, on approval. |
| `GET /machines` | The Team machines list, paged: every live machine for everyone, revoked ones for their owner and founders. |
| `DELETE /machines/{machineId}` | Revoke a machine (its owner or a founder). |
| `POST /facts` | The heartbeat: machine facts plus activity facts, every 30 seconds. |
| `GET /today` | Needs you, shipped, working, stuck and optionally health. `?visit=1` marks a real open (see below). |
| `GET /needs` | Needs-you items, paged, most urgent first. |
| `GET /repositories` | The company's repository list, paged: `projectKey`, `name`, optional `url`. |
| `GET /events` | Server-sent events: `needs.changed`, `mention`, `bundle.changed`, `staff.removed`, `capabilities.changed`, `reset`. |
| `GET /snapshot/head` | The caller's current snapshot head: the SHA-256 of each snapshot file. |
| `GET /snapshot/files/{sha256}` | One immutable snapshot file, by hash. |

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
6. The Hub polls `POST /enroll/poll`, no sooner than `retryAfterMs`. `expiresAt` is the deadline of the current
   state (the code while `pending`, the approval while `awaiting_approval`). Once the pairing is `approved`:
   - every poll returns `machineId` and a **fresh token** until a token is used, meaning the relay authenticates
     a signed call made with it;
   - each fresh token replaces the one before it, so only the latest one works; an older one is refused with
     401 `unauthenticated`;
   - after the first call the relay authenticates, or once the machine is revoked, polls still answer `approved` with `machineId`, but without
     `token`.

   So a lost poll reply costs nothing: the Hub polls again. **Hub rule:** if the token is refused with 401
   `unauthenticated` before any call made with it has succeeded, the Hub polls again, stores the fresh token and
   retries.
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

### Shipped

Each shipped item is one merged pull request: `{task{id, title, url?}, pr{number, url, repo}, ref?, summary, mergedAt,
live}`. `pr` is always present: the pull request's number, its link and the repository as the `owner/name` display
string. `ref` is the task's tracker ref `{tracker, host?, scope, key, url}`, present when the relay knows which issue
the pull request belongs to. A client names and links the item from these fields alone; it never joins Shipped to the
board. Shipped is not in the snapshot (see "Snapshot").

### Stuck

The stuck block has one item per task and owner. `rules` lists every reason that applies to it. It is never empty
and never repeats a rule. It is ordered most important first, in this fixed priority:

1. `dev_red`
2. `check_failed`
3. `deploy_failed`
4. `watched_job_down`
5. `unreviewed`
6. `claim_quiet`
7. `checks_queued`

A client shows the reasons in the order it receives them.

An item has exactly one of `task` or `subject`. Neither is refused, and so is both. A `subject` is
`{ repo?, run?, job? }` and carries at least `repo` or `job`:

- `repo` is the `owner/name` display string. Nothing else identifies the repository.
- `run` names the CI run (`name`) and gives its `url`.
- `job` names a watched job (`name`) and may give its `url`. A watched job that belongs to no repository has
  only `job`.

The object is closed. Items without a task are one per subject and rule, and are never merged across
repositories.

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

`GET /snapshot/head` and `GET /snapshot/files/{sha256}` give the same facts as `GET /needs`,
`GET /today` (working, stuck, health), `GET /machines` and `GET /repositories`, packed as files a client can cache
forever. They carry nothing those calls do not already return to the same caller.

- **Per person.** The head belongs to the caller's person. Every machine of one person gets the same head. Files are
  stored once by hash, so two people with identical bytes share one stored file. A file is readable only while one
  of the caller's retained heads names it. Knowing a hash grants nothing.
- **Shape.** The head is `{generatedAt, files}`. `files` maps `needs`, optional `health`, `work`, `machines` and,
  when the relay serves `GET /repositories`, `repositories` to `sha256:<hex>`. The path of a file uses the bare hex.
  The head key decides the schema of the file: `needs` is `SnapshotNeeds`, `health` is `HealthBlock`, `work` is
  `SnapshotWork` (working and stuck; shipped is left out, because it is relative to the last visit),
  `machines` is `SnapshotMachines`, `repositories` is `SnapshotRepositories`, `boards` is `SnapshotBoards`, each
  `board.<id>` is `SnapshotBoard`, and `map`, `feed` and `graveyard` are `SnapshotMap`, `FeedPage` and `GraveyardPage`. A client ignores keys under `files` it does not know.
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
| boards | none (snapshot only) | nothing (relay-wide) |
| `board.<id>` | none (snapshot only) | nothing (relay-wide) |
| map | none (snapshot only) | nothing (relay-wide) |
| feed | `GET /feed` | nothing (relay-wide) |
| graveyard | `GET /graveyard` | nothing (relay-wide) |

"No titles" means no title, text or path that a Hub reported (a heartbeat never carries them). The tracker titles that
`GET /needs` and `GET /today` already return to staff stay in the needs and work files.

## Board and leases

A relay that serves boards advertises the section `{kind:"board", version:2, flags:["leases", "boards"]}`
(plus the flag `checked` when it applies the sign-off rule below). A Hub does not read a board unless capabilities
carry the section. Boards are snapshot-only: the relay computes them, the Hub draws them. The flag `leases` also means
the relay parses the lease protocol below. The flag `boards` means the snapshot head names the `boards` index and one
`board.<id>` file per board. The flag `status_columns` is reserved for boards whose columns come from a tracker's
status field (a later version); a relay does not send it yet.

**Several boards.** A company can have more than one board, for example one per team. The relay's config lists them;
the Hub never discovers them. The head names:

- `boards`: the index, `SnapshotBoards` = `{boards[{id, title, mode, source{kind, url?}, counts{<columnId>: n}}]}`,
  in display order, at most 50. The list is data, not capabilities, so it can change without a deploy.
- `board.<id>`: one `SnapshotBoard` per index entry, with its own 1,000-card cap. One file per board means a change on
  one board does not re-send the others.

`mode` and `source.kind` are open tokens. Known today: mode `dev` (the five columns below, with leases) and source
`filter` (repositories and labels from the relay's config). A client draws an unknown mode as plain columns.
`counts` are cards per column id after every column rule, so a client can show a board's size without reading its
file. A task id is relay-wide: a task on two boards is the same task, and its lease is the same lease.

A relay only reads. Every take, release and hand-off write comes from the Hub on the person's own login (see "Lease
protocol"). The relay has no write endpoint for them.

**The file.** `SnapshotBoard` is `{state, notMeasured, columns[], cards[]}`. At most 51 columns.

- On a `dev` board, `columns` are the relay's five, each `{id, title}`: `free` (Free), `taken` (Taken), `validating` (Validating),
  `stuck` (Stuck), `shipped` (Shipped). Ids are open strings.
- A card is `{task, kind, column, status, statusWhy, lease?, lastRelease?, assignees[], prs[], restsOn[taskId]}`. Objects in the file are closed, so
  an unknown field is a relay defect and a conformance failure. New fields come with a new minor version.
- `kind` is an open token: `issue`, `pull_request` or `draft` (an item that belongs to no repository yet). A client
  shows an unknown kind like `issue`.
- `task` is `{id, title, ref{tracker, host?, scope, key, url}, openedAt, closedAt}`. `openedAt` is when the tracker
  issue was opened. `closedAt` is when it was closed, or null while it is open. Every task in the protocol has this
  shape: board cards, map items, `GET /tasks/{id}`, feed and graveyard entries.
- `prs` lists every pull request linked to the task, oldest first, each `{number, url, state, checks?{state}}`. It is
  an array, empty when none is linked. `state` is an open string, known values `open`, `merged`, `closed`. `checks` is
  the state of the required checks on that pull request's head (known values `passing`, `failing`, `pending`), present
  when the relay has read them. There is no card-level `pr` or `checks`.
- `lease` is `{holder{id, login}, state, since, lastSignalAt, staleAt, expiresAt}`. A relay that cannot read claims
  says so in the board's `state` and `notMeasured`, never as a lease state.
- `assignees` is `[{id, login}]`: everyone the tracker names as assigned, in the tracker's order, and empty when
  nobody is. It is always present. An assignee is not a lease (see "Lease protocol"), so a card can have
  assignees and no `lease`. The same field is on `GET /tasks/{taskId}`.
- **Free and Taken.** Taken = has a lease or an assignee. Free = no assignee and no lease. Validating, Stuck and
  Shipped come first: the rule only chooses between Free and Taken for a task that is in none of them. So a
  card assigned without a claim is in Taken with no lease chip; the Hub shows it as assigned but not claimed.
- `lastRelease` is `{by{id, login}, at, reason, freeToContinue, reasonText?, note?}`: the latest counted release,
  present only while nobody holds a standing claim, and absent as soon as one stands (see "Lease protocol"). The same object is on `GET /tasks/{taskId}`.
- The "agent at work" ring is not in the file. The Hub derives it from the `work` file, joined by task id.

**Status.** `status` is an open string; a client accepts values it does not know. One vocabulary serves the board,
and later the map and the feed. `statusWhy` is one plain sentence for hover and for the Task tab. The relay picks the
first matching row:

| Mark | `status` | Word | First match wins |
|---|---|---|---|
| † | `ruled_dead` | ruled dead | Issue closed as "not planned" |
| ● | `checked` | checked | `checked` label that passes the sign-off rule (see "Checked") |
| ✕ | `sent_back` | sent back | Issue reopened after a linked PR merged; review "changes requested" on an open linked PR; every linked PR closed unmerged (at least one, none open, none merged) |
| ◆ | `needs_you` | needs you | `needs:<person>` or `blocked` label; any open linked PR with failing required checks; lease conflict |
| ⊘ | `blocked` | blocked | A rests-on task that is `needs_you`, `sent_back`, `ruled_dead` or `blocked` |
| ◐ | `built` | built, unchecked | Any linked PR merged, or issue closed as completed |
| ○ | `planned` | planned | Open, none of the above |

The rule for "checked" is under "Checked", below.

`needs_you` means the task itself needs a person: a label, failing checks or a lease conflict. `blocked` means the task
waits on a dependency and nobody can act on it directly. A tracker label named `blocked` is a person flagging the task,
so it gives `needs_you`, not `blocked`. A client shows `blocked` as "Blocked by <title>", or "Blocked" where space is
short, and its mark is ⊘.

**Lease state.** `state` is an open string; known values `active`, `stale`, `expired`, `paused`, `conflict`,
`incomplete`. Time runs from `lastSignalAt`, the latest heartbeat, push or comment:

- `staleAt` is `lastSignalAt` plus `params.staleSeconds` (default 6 hours). After it the lease is `stale` and the card is in Stuck.
- `expiresAt` is `lastSignalAt` plus `params.expirySeconds` (default 24 hours). After it the lease is `expired`.
- An expired lease stays in Stuck. It is never shown as Free while the tracker still names the assignee, because
  only a release on the tracker frees the task.
- `paused` and `conflict` (two holders claim one task) come from the claims, not from time.
- `incomplete` comes from the lease protocol: the tracker's assignee and `claimed` label disagree with the claim
  comments for longer than the settle window. A plain assignee with no claim comment and no label is not a lease. A take or release stopped half way, and the Hub offers Finish and
  Withdraw. `conflict` and `incomplete` are never aged into `stale` or `expired`.

## Lease protocol

A take or a release is a comment on the tracker issue plus an assignee and label change, all written by the Hub on
the person's own login. Line 1 of the comment is the machine format; there is no hidden marker and no local
journal. The relay derives everything from the issue's comments, assignees and labels.

**Comments.** Only line 1 counts. The line is trimmed of spaces first. The separator is ` · ` (a middle dot with a
space on each side).

**Matching rules.** The line prefixes `claim:` and `release:` are exact and lower case: `Claim:` and `Release: done`
are not protocol lines. Reason ids are exact and lower case too: `DONE` is not `done`, and reads as `other`. Two things
match without regard to case: the `free to continue` suffix (`Free To Continue` counts), and logins (`Ada-Example`
and `ada-example` are the same person, for the claim line against the comment's author, for assignees, for founders
and for the holder).

| Line 1 | Meaning |
|---|---|
| `claim: <login>/<agent>` | A take. `<login>` must be the comment's author, or the line is ignored. `<agent>` names what took it: a tool such as `hub`, or the Hub machine it was taken on, such as `dev-server`. The relay does not interpret it. It must match `[A-Za-z0-9._-]{1,64}`, so it may not contain `#` or a space. An old `persona#n` claim has a `#` in it and does not count: the line is ignored. `claim: <login>` alone is also read. |
| `release: <reason>[ · <text>][ · free to continue]` | A release. The rest of the comment is the note. |
| `release: lost_claim[ · <text>]`, `release: take_failed[ · <text>]` | A withdrawal by the Hub. Never a release. |

Reason ids are `done`, `blocked`, `handing_over`, `out_of_usage`, `wrong_approach`, `duplicate`, `deprioritised`
and `other`. The id is matched exactly. An unknown id reads as `other`, with the raw text after `release:` in
`reasonText`. For a known id, the text after it is `reasonText`. `reasonText` is cut to 200 characters on read. The
note is everything after line 1, cut to 2 KB (2,048 UTF-8 bytes) on read. Both are plain text: a client shows them
as written and renders no markup. The Hub refuses to write a longer note or text.

A full release comment:

```
release: out_of_usage · free to continue
**Goal:** Limit invites per guild.
**Done:** Counter and tests.
**Next:** Return 429 from the invite route.
Follow-ups: #51, #52
```

More valid line 1 examples: `release: done`, `release: other · not needed after the redesign`,
`release: blocked · waiting on #12 · free to continue`, `claim: ada-example/hub`. Lines that are not protocol lines:
`Release: done` (capital R), `claim: bob-example/hub` written by ada-example (not the author), `claim:` (no login).
`release: DONE` and `release: vacation` are releases with reason `other`.

**Labels.** `claimed` is on the issue while it is held. `paused` is on the task's open draft pull request after a
release, and the next take removes it. The relay reads `claimed`; `paused` is for people and agents.

**Edited comments do not count.** On GitHub anyone with write access can edit another person's comment, so an
edited `claim:` could be turned into a `release: done`. A `claim:` or `release:` comment whose `updated_at` is later
than its `created_at` is ignored by the fold, as if it were not a protocol line: it starts no claim, ends none and
counts as no release or withdrawal. The author must post a new comment. A comment that is not a protocol line is not
affected. The Hub never edits its own protocol comments (see "How the Hub writes").

**The fold.** Comments are read in order of `created_at`, then comment id. On GitHub the comment id is the numeric
REST id (`databaseId`, the number in `#issuecomment-<id>`), compared as a number; never the GraphQL node id. Other
trackers compare their ids as numbers when both are digits, otherwise as strings.

1. A claim stands from its comment until its author withdraws it or a counted release ends it. A person with a
   standing claim who claims again changes nothing.
2. The holder is the earliest standing claim. More than one standing claim is `conflict`: the earliest claim wins,
   and every later claimant is in conflict until they withdraw.
3. A `release:` counts only when the holder writes it, or when a founder writes it about someone else's lease (a
   founder release). It ends the holder's claim, and the next standing claim, if any, becomes the holder.
4. A `release:` by any other claimant, and `lost_claim` or `take_failed` by any claimant, withdraws only that
   author's claim. The system reasons are never accepted as a release reason from a comment, so they never set
   `lastRelease` and never make a feed entry.
5. Everything else is ignored, including a release by someone who neither holds the lease nor is a founder.
6. An extra assignee next to a consistent standing claim does not make the lease incomplete. For example, a conflict
   loser who withdraws with `lost_claim` but is still assigned leaves the winner's lease `active`, as long as the
   winner is assigned and `claimed` is on (fixture `loser-withdrawn-still-assigned-active`).

**Settle window: 60 seconds.** A standing holder should be assigned and the issue should carry `claimed`. When no
claim stands, nobody should be assigned and `claimed` should be off. `incomplete` means the protocol is plainly in
use and its parts disagree for longer than 60 seconds. There are exactly three cases:

- a standing claim comment without the assignee or the `claimed` label;
- the `claimed` label with no standing claim;
- a counted release (or a withdrawal) while the ended claimant is still assigned.

Time runs from the claim, or, with no standing claim, from the last protocol comment. Inside the window the relay
shows the claim as `active`, or the release as done, because the Hub writes the comment first and the assignee a
moment later. An `incomplete` lease with no standing claim is held by the released holder when they are still
assigned or `claimed` is still on; otherwise by the ended claimant who is still assigned, or by the first assignee
when only the label is left. Its `since` in the fold is the claim time of the released holder, and only when that holder is the one shown. In every other case (the ended claimant or the first assignee, or a leftover `claimed` label) the fold gives null, because no claim comment backs it. The fold never reads assignment or issue times. A card still needs a timestamp in `BoardLease.since`, and the fold does not say which one a relay should use then. When the fold gives no time, a relay uses the latest assignment time of the shown holder, otherwise the issue's opened time. A
`claimed` label with nobody named anywhere (no assignee, no release) has no holder to show, so it makes no lease.

**A plain assignee is not a lease.** Many issues are assigned outside the protocol. An assignee with no standing
claim, no `claimed` label and no release or withdrawal for that person is not an `incomplete` lease: the card has no
`lease` and shows no lease chip, and it is Free for lease purposes (anyone may take it). The board column still
follows the assignee as usual, so the card is in Taken (see "Free and Taken"). When someone takes it, the Hub's claim
comment starts a lease and the Hub leaves the existing assignees as they are, adding the taker.

**lastRelease.** The latest counted release, present only while nobody holds a standing claim. It is not "the
current or last epoch": the moment any claim stands, `lastRelease` is null, and it comes back when that claim ends
by a counted release (a new, later one) or is withdrawn (the earlier one). A withdrawal is never a release, so a
later `lost_claim` or `take_failed` by another claimant does not replace or hide the earlier release. For example,
in the fixture `withdrawn-take-keeps-release`, Ada releases with `free to continue`, Bob takes and then withdraws
with `take_failed`, and `lastRelease` is still Ada's, with `freeToContinue` true. `freeToContinue` is true only when
line 1 of that release says free to continue **and** nobody is assigned now. It survives a later withdrawal, but
not an assignee: once someone is assigned, it reads false.

**Feed.** Every counted release is a `released` entry with the release's author, `reason` and `freeToContinue` as
written, and `reasonText` and `note` when present. Withdrawals make no entry.

**Shared fold fixtures.** `fixtures/lease-fold/*.json` are cases of `{name, description, input{comments[{id, author,
createdAt, updatedAt?, body}], assignees, labels, founders, now}, expected{lease, lastRelease, releases}}`. `lease` is
`{holder, state, since, claimants}` (logins; `since` is null when no claim comment backs it) or null for free.
A comment without `updatedAt` was never edited: it equals `createdAt`. `releases` lists every counted release in order, `{by, holder, at, reason, freeToContinue, reasonText?, note?}`,
with `freeToContinue` as written. Every reader of the protocol runs all of them: the Hub
(`packages/contracts/src/leaseProtocol.ts`, run by the fake relay's tests) and the Go relay. Time-based states
(`stale`, `expired`) are applied after the fold and are not in the fixtures.

### How the Hub writes

Not part of the relay contract; it explains the states a relay sees. The Hub's `LeaseService`
(`apps/server/src/banneret/lease/LeaseService.ts`) writes through the tracker's issue API and, for `paused`, its pull
request API (GitHub's issue update resolves a number as an issue and refuses a pull request). It keeps one operation
per task in memory and nothing on disk; every step reads the issue again before it writes.

- **Comments are only created.** The Hub never edits or deletes a protocol comment it wrote, and its
  `LeaseService` has no call that does. Because the fold ignores an edited comment, an edit would only erase the
  record. It reads each comment's `updatedAt` from the tracker and passes it to the fold.
- **Take:** read and fold, and stop unless the task is free and the person may comment, label and assign. Comment
  `claim: <login>/<agent>`. Assign the person and add `claimed` in one update, up to three tries; if all fail,
  comment `release: take_failed`. Wait 10 seconds, read again: the earliest claim wins. The winner removes `paused`
  from the task's open pull requests. The loser comments `release: lost_claim · @<winner>` and unassigns only
  themself; `claimed` stays.
- **Release:** read and fold, and stop unless the person holds it. Comment the release first, since the reason is
  the record. Then unassign the person, remove `claimed` unless another claim stands, and add `paused` to the open
  draft pull request. A retry finds its own release comment and posts no second one.
- **Finish** re-runs the steps after the comment. **Withdraw** comments `take_failed` (or `lost_claim` for a loser)
  and unassigns.

| From | Event | To |
|---|---|---|
| free | take refused by the pre-read (held, no permission, wrong account) | free; nothing written |
| free | claim comment fails | free; nothing written |
| free | claim posted | taking (in memory) |
| taking | assign and label fail three times, `take_failed` posted | free |
| taking | ... and `take_failed` fails too, or the Hub stops | incomplete after 60 s |
| taking | read-back: my claim is earliest | taken |
| taking | read-back: an earlier claim, `lost_claim` posted, unassigned | free for me |
| taking | ... and the withdrawal fails | conflict, until Withdraw |
| taken | release comment posted, then unassign, unlabel, pause the draft | free, `lastRelease` set |
| taken | a step after the release comment fails, or the Hub stops | incomplete after 60 s |
| incomplete | Finish | taken or free |
| incomplete | Withdraw | free |

### Which machine writes

Also not part of the relay contract. The Hub client may be connected to several of the person's machines (a
desktop and the servers it is linked to). A lease call runs on one of them, and that machine's server writes
with its own tracker login. The client picks the machine per task, on every render, and stores nothing but
the person's last choice per repository, in the browser:

| Route | When | The Hub shows |
|---|---|---|
| none | no connected machine of the person has a project on the task's repository | "Take needs a project on <repo> on one of your machines." |
| not-joined | only machines that have not joined this relay have one | "<machine> has the repository but has not joined <company>." Nothing is written. |
| ready | one or more joined machines of the person have one | the lease buttons; a picker when there are several |

- **The person's machine:** the relay knows it as the same login as the machine the page reads the task through.
  A machine is left out only when that is provably someone else: its enrolment, on this relay or on another
  relay both have joined, names another login.
- **Default machine:** the one this window took the task on, then the last choice for the repository, then the
  last machine used, then the page's own machine, then the first by name.
- **The server refuses** a lease call that names a relay it has not joined, before reading the tracker.
- **The claim** names the machine: `claim: <login>/<machine label>`, with the label made to fit `<agent>`. An agent
  that takes a task through the agent toolkit writes from its own machine and names its session instead:
  `claim: <login>/<provider>-<start of the thread id>`, such as `claim: ada-example/claude-1a2b3c4d`.

A second operation on a task while one runs is refused as busy. After a restart nothing is remembered: every task
is what the tracker says, folded as above.

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

A relay that has a stage plan advertises the section `{kind:"map", flags:["rests_on"]}` and
names the `map` file in the snapshot head. A Hub does not read the map unless capabilities carry
the section. Like the board, the map is snapshot-only: the relay computes it and the Hub draws it.

**When it is advertised.**

- No stage plan configured: the section and the head key are omitted. A tracker without a plan keeps its board.
- Configured and valid: the section is present and `map.state` is `ok`.
- Configured but unreadable or invalid: the section is present, `state` is `not_measured`, and `notMeasured` says why,
  with `reason` `unreachable` (the file could not be read) or `malformed` (it broke a rule below) and a one-sentence
  `detail` naming the rule. `stages` and `items` are empty. The Hub never shows a broken plan as an empty one.

**The file.** `SnapshotMap` is `{state, notMeasured, stages[{id, title, order}], items[{id, stageId, title, status,
statusWhy, task?{id, title, ref, openedAt, closedAt}, restsOn[itemId], blockedBy[itemId]}], counters{byStatus{<status>:
n}, byStage{<stageId>: {<status>: n}}}}`. Objects are closed, like the board's.

- `stages` are in ascending `order`, ties in plan order. `items` are grouped by stage in that order, and keep plan
  order within a stage.
- `task` is present whenever the item's plan has a `task` ref, and absent only when it has none. It is always
  `{id, title, ref, openedAt, closedAt}`. When the board holds a card whose `ref` has the same `tracker`, `host` (both absent counts as
  equal), `scope` and `key`, `task` is that card's task. When it holds none (the issue is closed, say, or not on the
  board), the relay builds `task` from the plan ref and its own read of the issue: `id` is the relay's opaque task id
  for that ref, `title` is the issue title (the plan item's title if the issue cannot be read), and `ref` is
  `{tracker, host?, scope, key, url}`, and `openedAt` and `closedAt` come from that same read of the issue (the issue's
  open and close times; `closedAt` null while it is open). `GET /tasks/{id}` may answer 404 for such a task. The client
  then shows the map item's status and the issue by `ref`.
- `restsOn` lists **item** ids, copied from the plan.
- `blockedBy` lists the item's **direct** blockers: its own `restsOn` entries whose final status is `needs_you`,
  `sent_back`, `ruled_dead` or `blocked`, in `restsOn` order, without repeats. It is always present, and empty when
  nothing blocks the item. It never names a blocker further down the chain.
- `counters` count every item once by its final status. `byStage` has an entry for every stage, empty when the stage
  has no items.

**Status.** The vocabulary is the board's (see "Board and leases"): `ruled_dead`, `checked`, `sent_back`, `needs_you`,
`blocked`, `built`, `planned`, and the same first-match order.

1. **Own status.** An item whose task has a board card takes that card's computed status and `statusWhy`, with one
   exception: a card that is `blocked` (by the board's task-level rests-on row) gives the status it would have without
   that row, `built` or `planned`, because the map applies its own `restsOn` instead. An item whose task has no card
   takes its status from the issue: closed as completed is `built`, closed as not planned is `ruled_dead`, open is
   `planned`. An item without a `task` is `planned`. So the board and the map can disagree about one task: each says
   what blocks it in its own graph.
2. **Blockers.** A status is blocking when it is `needs_you`, `sent_back`, `ruled_dead` or `blocked`. `blockedBy` is
   the item's `restsOn` entries whose final status is blocking. It is computed whatever the item's own status is.
3. **Blocked.** An item whose own status is `built` or `planned` and whose `blockedBy` is not empty is `blocked`, with
   a `statusWhy` that names the first entry of `blockedBy`, for example `Blocked by "Profile blocks", which needs you.`
   Items with a higher own status (`ruled_dead`, `checked`, `sent_back`, `needs_you`) keep it, and still list their
   `blockedBy`.
4. **Propagation.** The rule is applied dependencies first, so a `blocked` item blocks its own dependants in turn.
   A dependant lists the `blocked` item it rests on, never the root cause: if C rests on B and B rests on A, which
   needs you, then B is `blocked` with `blockedBy` `[A]` and C is `blocked` with `blockedBy` `[B]`.
5. `needs_you` on the map comes only from the item's own task, never from a dependency.
6. `counters` count `blocked` like any other status.

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

A relay that serves them advertises the section `{kind:"feed", flags:["graveyard"]}` and
names the `feed` (and, with the flag, the `graveyard`) file in the snapshot head. A Hub does not read either file
unless capabilities carry the section.

- **The files.** Both are `{entries[], nextCursor}`: `FeedPage` and `GraveyardPage`. Each holds the latest 100
  entries, newest first. `nextCursor` is null when nothing is older.
- **Paging.** `GET /feed?cursor=` and `GET /graveyard?cursor=` are signed and cursor-paged like `GET /needs`
  (`cursor`, `limit` 1 to 100, 400 `malformed` for a cursor the relay did not issue). The file's `nextCursor`
  continues in the call. A cursor is opaque, and a page can shift when new entries arrive.
- **Derived only.** The relay builds entries from tracker and relay events. A client cannot write one; written
  entries (comments, announcements) wait for a later minor version.
- **Feed entry.** `{id, type, at, author?{id, login}, importance, summary, link?, task?{id, title, ref, openedAt, closedAt}, status?, reason?, freeToContinue?, reasonText?, note?}`.
  Objects are closed. `type` is an open string; known values `taken`, `released`, `lease_expired`, `pr_opened`,
  `pr_merged`, `built`, `checked`, `sent_back`, `ruled_dead`, `comment`. `importance` is an open string; known
  values `high`, `normal`, `low`. `status` is the task's status when the entry was made, in the board vocabulary.
  `author` is absent for something the relay noticed itself. `summary` is one plain sentence. A `released` entry
  requires `reason` (an open token, see "Lease protocol") and `freeToContinue`, and carries `reasonText` (at most 200
  characters) and `note` (at most 2,048) when the release had them. Every other type carries none of the four.
- **Graveyard entry.** `{task{id, title, ref, openedAt, closedAt}, cause, ruledAt, by?{id, login}, link?}`. `cause` is always present:
  the Hub shows it, so a task never sits in the graveyard without a reason.

## Task

A relay that serves it advertises the section `{kind:"task", flags:[]}`. `GET /tasks/{taskId}` is
signed and returns one board card (every field of `BoardCard`, `lastRelease` with its `note` included) plus two
optional fields:

- `preview?{state, url?}`: `state` is an open string, known values `building`, `ready`, `failed`; `url` is present
  when the preview can be opened.
- `checked?{by{id, login}, at, valid, ignoredReason?}`: the sign-off record, present when the task has a `checked`
  label. See "Checked".

A `taskId` that is malformed (not an `Id`) or unknown answers 404 `not_found`, never 400, like `DELETE
/machines/{machineId}`. The Hub reads the card from a `board.<id>` or the `map` file when it holds the task and calls this
only for the rest.

## Checked

"Checked" means a person with the **sign-off role** confirms the item after CI passed and review approved. (Banneret's
preset gives the sign-off role to founders; another company may map it differently, and the relay decides.) The sign-off
lives in the `checked` label on the tracker issue; the relay keeps no store of its own. It counts only when the tracker's
event log shows **all** of:

1. a holder of the sign-off role added the `checked` label, and it is the **latest** `labeled` event for `checked`
   (a later `unlabeled` event removes the check);
2. a linked pull request (an entry of `prs`) had already merged;
3. that pull request's checks were green;
4. a review of that pull request was approved by someone **other than the person who added the label**, the approval
   is on its **merged head commit**, and it still stands: a dismissed approval, or a later "changes requested" from
   the same reviewer, voids it.

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

- **Anonymous callers** get `displayName`, `iconUrl` (or null) and `enrolment` only.
- **Enrolled callers** also get the following, none of it secret:
  - `me {id, login, role}`, so no separate identity call is needed. `role` is an open set (`founder`,
    `limited_staff` today); a client treats an unknown role as `limited_staff`;
  - `sections[] {id, kind, version, flags}`. The Hub renders only these, and ignores kinds it does not know;
  - `mcpTools[] {name, description, role, inputSchema?}`. `role` is the lowest role that may call the tool.
    The Hub offers its agents exactly the tools named here that it implements, today the `banneret_*` agent
    toolkit (the Hub's `docs/banneret/agents.md`). For those, an entry only switches the tool on and sets its role; the
    Hub keeps its own description and schema. The Hub ignores a name it does not implement;
  - `adapters[] {role, kind, version?}`, for the work tracker, staff directory, knowledge and health.
- **Refetching.** The facts response carries `capabilitiesVersion`, and the `capabilities.changed` event says when
  to refetch. The `GET /capabilities` `ETag` is the same value in double quotes: `capabilitiesVersion` `c-7f3a`
  is `ETag: "c-7f3a"`. [Orchestrator]

## Open sets

Clients ignore response fields and enum values they do not know. `Role`, `NeedsItem.kind`, section kinds, adapter
kinds and error codes are open strings with their known values documented, not closed enums, so a validating
client accepts new values. Request bodies are closed.

## Ids and time

- Every id is an opaque string matching `^[A-Za-z0-9_-]{1,64}$` (T3's `environmentId` allows up to 128). Clients
  never parse ids.
- No GitHub numeric id leaves the relay's GitHub adapter; people are `id` plus a display `login`.
- Timestamps are RFC 3339 in UTC, ending in `Z`.

## Extraction guards

This folder names no organisation; examples use `example-org`. In the platform mirror, the folder also imports
nothing from outside `internal/hub`, and `TestExtractionGuards` checks both.

### Optional health sources, dashboards and alarms

Configure `healthSources` with a stable `id` and an open `kind` per source, such as
`relay`, `http_check` or `webhook`. The default is an empty list. With zero sources omit the
health section, `Today.health` and the snapshot head's `health` key. Otherwise advertise the section
and include `source` and `kind` on every measurement. Health blocks carry an `alarms` array of
active alarms alongside `items` and `notMeasured`. Enrolled people can read active alarms.

The optional `dashboards` list defaults to empty. Return it only in authenticated capabilities.
Each entry has `id`, `title`, an HTTPS `url` and an optional `group`. Today opens it locally.
The authenticated board section's `params` contains the configured `board.staleSeconds` and
`board.expirySeconds`. Both are whole seconds and expiry must exceed stale.

A source with a private `secret` accepts `POST /relay/v1/hooks/{sourceId}`. Send the generic
[alarm JSON](examples/alarm.json). Supply a Unix timestamp in seconds in `X-Alarm-Timestamp`.
Set `X-Alarm-Signature` to lowercase hex HMAC-SHA256 with the UTF-8 source secret over the ASCII
timestamp, a literal period and the exact request bytes. The body sourceId must equal the path id.
Accept timestamps within 300 seconds of receipt in either direction. Reject repeat signatures
within that window (401), bodies over 1 MiB (413) and more than 60 requests per source per minute (429).
Success returns 204. Provider mapping happens at the relay boundary. For example, an AWS SNS/SES
adapter can map a delivery failure into a warning keyed by message id. An Alertmanager adapter can
use the fingerprint, startsAt and endsAt for id, firedAt and resolvedAt. Sign the mapped JSON for
this endpoint. Keep keys, deliveries and alarm records on the relay.

| Stored state | Delivery | Result after commit |
| --- | --- | --- |
| Missing | Fired or resolved | Insert by (sourceId, id). Only an unresolved occurrence appears on Today. |
| Active | Same firedAt | Update severity and details. A resolvedAt closes the occurrence. |
| Resolved | Same occurrence | Keep closed, including after delayed retries. |
| Either | Newer firedAt | Replace with the new occurrence. Ignore older occurrences. |
| Any | Restart | Reopen the relay DB. Alarm rows and replay receipts survive. In-memory rate windows restart. |

A critical active occurrence adds one health Needs-you item for each configured person.
`criticalRecipients` holds stable person ids. Omitting it selects current founders. An empty list
routes to nobody. Resolution or a lower severity removes the need. Alarm state belongs to the relay
database and is never published to the work tracker.
