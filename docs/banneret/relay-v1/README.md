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

Every call starts from a Hub or a pool host agent. The relay never dials a machine and cannot run anything on one.

Rules marked [Orchestrator] were accepted by the founder on 2026-11-26.

## Endpoints

All under `/relay/v1`.

| Call | Purpose |
|---|---|
| `GET /capabilities` | Display name, icon and enrolment entry point for anyone; sections, MCP tools, adapters and `me` for an enrolled caller. |
| `POST /enroll/start` | Start enrolment with the machine's public key and facts; returns a pairing id, confirm code and browser URL. |
| `POST /enroll/poll` | `pending`, `awaiting_approval`, `approved`, `refused` or `expired`; the device token once, on approval. |
| `GET /machines` | The Team machines list, paged: named machines for viewers with hub.machinesAll, all machines for founders, revoked ones for their owner and founders. |
| `DELETE /machines/{machineId}` | Revoke a machine (its owner or a founder). |
| `POST /facts` | The heartbeat: machine facts plus activity facts, every 30 seconds. |
| `GET /today` | Needs you, shipped, working, stuck and optionally health. `?since=...` filters shipped work (see below). |
| `GET /needs` | Needs-you items, paged, most urgent first. |
| `GET /skills` | Signed company skill catalog, available when the enrolled capabilities document includes `skills.registry: true`. Each entry has the plugin kit name, description, full SKILL.md text and a company lock. |
| `GET /repositories` | The company's repository list, paged: `projectKey`, `name`, optional `url`. |
| `GET /events` | Server-sent events: `needs.changed`, `mention`, `chat.changed`, `chat.delivery`, `bundle.changed`, `staff.removed`, `capabilities.changed`, `roles.changed`, `reset`. |
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

The query is part of TARGET, so it is signed: `GET /today?since=2026-11-26T10%3A00%3A00Z` and `GET /today` have different signatures, and a
proxy cannot add or drop the cutoff.

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
file contents. Shared threads and messages explicitly posted to chat use separate calls.

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

The Hub keeps the visit boundary on this device for each workspace. On the first open it requests
`GET /today`. Later it sends an optional UTC timestamp as `GET /today?since=...`. The relay returns
pull requests merged strictly after that time. Without a filter it returns recent merges.
The relay must never persist the timestamp, including in request logs. It stores no visit history.
The working block reports agent sessions and their owners. It has no human activity times.

| Device event | Local visit state | Filter |
|---|---|---|
| First open or cleared browser storage | Save the current open time | None |
| Open after a gap of at least 30 minutes | Use the previous open as the boundary and save the current open time | Previous open |
| Open within 30 minutes | Keep the boundary and update the open time | Same boundary |
| Refresh or restart | Read the saved record for this workspace | Same boundary |

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

`GET /machines` lists named machines for viewers with hub.machinesAll, all own machines, and all machines for founders. A
revoked machine is listed only to its owner and to founders, with `revokedAt` set, `connected` false and
`revocable` false; nobody else sees it. Live machines come first, newest heartbeat first; revoked machines follow,
most recently revoked first. `DELETE /machines/{machineId}` answers 404 `not_found` for a malformed id or an unknown or hidden
machine. A colleague who can see the machine receives 403 `forbidden`. Owners and founders can revoke it. [Orchestrator]

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
| 1 | An agent is blocked on a question or approval from you | `thread_question`, `thread_approval`, `chat_ask` |
| 2 | Something waits on your review or decision | `pull_request`, `pr_approval`, `waiting_for_approver`, `promotion`, `founder_question`, `health`, `chat_join_requests` |
| 3 | You were mentioned, or an agent or persona wrote to you | `mention`, `agent_message`, `persona_ask`, `agent_inbox` |
| 4 | A dispatcher suggestion | `suggestion` |
| 5 | Any kind not listed above | `other` (the explicit catch-all), and any unknown kind |

`kind` is an open set. A client shows an unknown kind as a generic item and never fails on it.

Error `code` is an open set too. A client treats an unknown error code by its HTTP status.

## Snapshot

`GET /snapshot/head` and `GET /snapshot/files/{sha256}` give the same facts as `GET /needs`,
`GET /today` (working, stuck, health), `GET /machines` and `GET /repositories`, packed as files a client can cache
forever. Those files carry nothing those calls do not already return to the same caller. The files the table below marks
as snapshot only (the boards and the map) have no live call.

- **Per person.** The head belongs to the caller's person. Every machine of one person gets the same head. Files are
  stored once by hash, so two people with identical bytes share one stored file. A file is readable only while one
  of the caller's retained heads names it. Knowing a hash grants nothing.
- **Shape.** The head is `{generatedAt, files}`. `files` maps `needs`, optional `health`, `work`, `machines` and,
  when the relay serves `GET /repositories`, `repositories` to `sha256:<hex>`. The path of a file uses the bare hex.
  The head key decides the schema of the file: `needs` is `SnapshotNeeds`, `health` is `HealthBlock`, `work` is
  `SnapshotWork` (working and stuck; shipped is left out, because it is relative to the last visit),
  `machines` is `SnapshotMachines`, `repositories` is `SnapshotRepositories`, `boards` is `SnapshotBoards`, each
  `board.<id>` is `SnapshotBoard`, and `map`, `feed` and `graveyard` are `SnapshotMap`, `FeedPage` and `GraveyardPage`, and the Team keys are `team`, `team.people`, `team.room.<board>` and `team.hallway` (see Team). A client ignores keys under `files` it does not know.
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
- Shipped is fetched separately with the device’s optional `since` filter.
- **Removal.** A person removed from staff, or a revoked machine, is refused as on every other call. A removed
  person's heads are dropped at once.

What the files hold, and who sees what, is the same as the live calls:

| File | Same content as | Varies by |
|---|---|---|
| needs | `Today.needsYou` for the caller | person |
| health | `Today.health` for the caller | role |
| work | `Today.working` and `Today.stuck` for the caller | role, in practice |
| machines | Live machines shared with their name | person (revocation permission) |
| repositories | `GET /repositories` | board and repository scope |
| boards | none (snapshot only) | board and repository scope |
| `board.<id>` | none (snapshot only) | board and repository scope |
| map | none (snapshot only) | board and repository scope |
| feed | `GET /feed` | board and repository scope |
| graveyard | `GET /graveyard` | board and repository scope |
| team files | Team paging calls | people and board scope, hub.team |

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
- `prs` lists every pull request linked to the task, oldest first, each `{number, url, state, checks?{state}, baseBranch, approvals, canApprove, youCanApprove}`. It is
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

**Labels.** `claimed` is on the issue while it is held. The relay reads `claimed`. Release adds `paused` to linked open draft pull requests. The next Take removes it from linked open pull requests.

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
(`apps/server/src/banneret/lease/LeaseService.ts`) writes through the GitHub issue and pull request APIs using the machine's own login. It keeps one operation
per task in memory and nothing on disk; every step reads the issue again before it writes.

- **Comments are only created.** The Hub never edits or deletes a protocol comment it wrote, and its
  `LeaseService` has no call that does. Because the fold ignores an edited comment, an edit would only erase the
  record. It reads each comment's `updatedAt` from the tracker and passes it to the fold.
- **Take:** read and fold, and stop unless the task is free and the person may comment, label and assign. Comment
  `claim: <login>/<agent>`. Assign the person and add `claimed` in one update, up to three tries; if all fail,
  comment `release: take_failed`. Wait 10 seconds, read again: the earliest claim wins and removes `paused` from open pull requests. The loser comments `release: lost_claim · @<winner>` and unassigns only
  themself; `claimed` stays.
- **Release:** read and fold, and stop unless the person holds it. Comment the release first, since the reason is
  the record. Then unassign the person, remove `claimed` unless another claim stands, and add `paused` to open draft pull requests. A retry finds its own release comment and posts no second one.
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
| taken | release comment posted, then unassign and unlabel | free, `lastRelease` set |
| taken | a step after the release comment fails, or the Hub stops | incomplete after 60 s |
| incomplete | Finish | taken or free |
| incomplete | Withdraw | free |

### Which machine writes

The page defaults to its own machine. The picker offers connected machines where the same company relay knows the same person. Each machine checks enrolment, GitHub login and triage permission before writing. It addresses the issue by host, repository and number. No project is needed to claim or release. A browser remembers the machine selected for this task until reload.

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

## Team

The Team section has version 2 and flags `presence`, `status`, `sharing` and `meeting_links`.
Capabilities also supplies `team {preset, stoppedKeptSeconds}`. The company and community presets share the same wire format.
Read the sections and flags before displaying a feature. The summary keeps all room counts and as many
agent rows as fit in 65,536 uncompressed bytes. Continue `agentsNextCursor` with `GET /team/agents?cursor=…`
only when the view needs more rows. Pages return `{agents,nextCursor}` in person ID order, up to 100
per call. Cursors are opaque and stable while the summary hash holds. Restart from the new summary when it changes.

| Snapshot head key | Contents | Maximum size before compression |
|---|---|---|
| `team` | Rooms in board order, hallway counts, agent counts per person and room, office link and directory size | 50 boards, 64 KiB |
| `team.people` | Directory in login order, including staff who have never signed in | 500 people, 160 KiB |
| `team.room.<board>` | Visible agent sessions on this board, including an empty page for an empty board | 300 sessions, 96 KiB |
| `team.hallway` | Visible sessions without a board task | 300 sessions, 96 KiB |

Each file is shared across heads and built once per change. Serve gzip when requested. Hash the uncompressed bytes.
The first board in board order containing a session's task gets the session. Match by task ID, or by branch
and project key. A room is a board. A desk belongs to a person with a claim or agent there.
Count each lead (no listed parent) once, using the most urgent state in its subtree: waiting, not heard from,
working, idle, stopped. A helper waiting on permission makes its working lead count as waiting. Room counts
use the lead's room. Each person's room entry includes the number of waiting leads there.

`GET /team/people`, `GET /team/rooms/{board}/sessions` and `GET /team/hallway/sessions` take an opaque
`cursor` and a `limit` from 1 to 100 (default 100). Continue with the returned `nextCursor` until null.
For people, `q` matches the beginning of the login or display name, case-insensitively.

| Presence event | Stored values and live result |
|---|---|
| New staff member or store wipe | Off, empty status, no chosen room |
| Signed `PUT /team/me` | Set only the supplied fields on the caller's row. Null clears status or chosen board. Broadcast the resulting person values in `team.changed`. |
| Hub closes, machine sleeps, or relay restarts | Keep the stored values. The next directory snapshot restores missed live changes. |
| Chosen room disappears or person has no desk there | Display the first desk in board order. Clear an obsolete choice on the next edit. |
| Staff removed | Delete the row. |

Presence is self-set: available, focusing, away or off. A status line holds up to 80 UTF-8 bytes.
Person objects contain no timestamps. Machine heartbeats never change a person's state.
Founders set or clear `meetingUrl` with `PUT /team/office` or `PUT /team/rooms/{board}`. Accept HTTPS URLs up
to 300 UTF-8 bytes without credentials. Store the link without fetching it. The Hub opens it in the system browser.
Both writes emit `team.rooms_changed`. Both Team events are live only, without a replay ID.

Each heartbeat carries the machine's sharing choice. The Hub defaults to `agents_only` for companies and `hidden` for communities. A missing choice
means hidden. Hidden machines contribute no sessions. Only `agents_and_name` includes the session's
`machineId` and lists the machine for colleagues. Owners and founders can manage machines.
Claims stay visible. Use `<login>/private` when the machine name is private. Claim chips show live, paused or quiet.
Status text and meeting links are UTF-8 byte limited. Schema validators must enforce `x-maxBytes` for strings and `x-maxJsonBytes` for serialized snapshot JSON.
`shareUsage` controls disclosure of a stopped agent's reason. Keep stopped agents for 3,600 seconds.
A waiting agent must be running and waiting for a permission or question. Other waits count as idle.
After 90 seconds without a heartbeat a live agent becomes `not_heard_from`. Drop it after 24 hours or revocation.
`since` changes when the agent changes state. `GET /team/heartbeats?sessions=a,b` returns the last heartbeat
only for requested visible agents (at most 50 IDs). Read every 15 seconds only while their card and tab are visible.

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

## Pull request approvals

Each linked PR in Board and TaskRead includes its GitHub `baseBranch`, `approvals`, `canApprove`
(eligible reviewers, with login only when outside the viewer’s people scope), and `youCanApprove` for the caller.
An unreadable rule returns null approvals, an empty candidate list and false. A measured branch
with no review requirement returns zero required reviews and false policy flags.

Read `GET /repos/{owner}/{repo}/branches/{branch}/protection` and its `required_pull_request_reviews` and the parameters of all active `pull_request`
rules returned by `GET /repos/{owner}/{repo}/rules/branches/{branch}`, including inherited rules.
Take the largest `required_approving_review_count` and apply each enabled `require_code_owner_reviews`,
`require_last_push_approval` and `dismiss_stale_reviews` (rulesets use
`require_code_owner_review` and `dismiss_stale_reviews_on_push`). They determine `required`, `codeOwners.required` for applicable
files, `lastPushApproval` and `stale`. Resolve the first CODEOWNERS file on the base ref in
.github/, repository root, then docs/. Match each changed path against its last matching pattern.
Report applicable team or login names in `owners`. Include `satisfiedBy` only when all applicable
owner groups have an effective approval.

Use PR `base.ref`, `base.sha`, `head.sha`, `user.login`, changed-file `filename` and review
`user.login`, `state`, `commit_id` and `submitted_at`. Use push actor evidence for the latest
reviewable push. A commit author alone cannot identify the pusher.
Count distinct qualifying reviewers in `have` using GitHub review state, dismissals, changes
requested and review commit evidence. For last-push approval, report `lastPushSatisfied` when
unrequired or approved after the latest reviewable push by someone other than its pusher.
Use repository review permissions and owner team memberships. Exclude the author and people
whose review cannot advance any remaining requirement. PersonRef identity is the stable person id.
Consult GitHub review decision, required checks, draft state, conflicts and other merge blockers
before declaring approval the sole blocker. If a review rule cannot be measured or represented,
report null approvals. GitHub remains authoritative for mergeability.

| GitHub state | Needs you for the viewer |
| --- | --- |
| Open and approval is the sole outstanding merge condition | `pr_approval` for eligible reviewers, `waiting_for_approver` for the author |
| Other blockers, approvals satisfied, closed, or unreadable | Neither approval item |

The relay recomputes this view from repository state, including after a push, review, rule or
membership change, or restart. The Hub only caches the viewer's snapshot.

## Checked

Checked is a separate company flag after merge. The latest checked label event must add the label,
a company sign-off role holder must add it, and a linked PR must already have merged with green
checks. The checker may have reviewed the PR. Repository approval rules govern the merge.
When the label does not count, TaskRead carries `valid: false` and an `ignoredReason`.
A board offering this company flag advertises `checked`.

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
  - `me {id, login, role, admission, permissions}`. Role references carry the current id and display name.
  - `sections[] {id, kind, version, flags}`. The Hub renders only these, and ignores kinds it does not know;
  - `mcpTools[] {name, description, requires?, inputSchema?}`. An omitted `requires` offers the tool to everyone. Otherwise the caller needs that permission.
    The Hub offers its agents exactly the tools named here that it implements, today the `banneret_*` agent
    toolkit (the Hub's `docs/banneret/agents.md`). For those, an entry only switches the tool on and names its required permission; the
    Hub keeps its own description and schema. The Hub ignores a name it does not implement;
  - `adapters[] {role, kind, version?}`, for the work tracker, staff directory, knowledge and health.
- **Refetching.** The facts response carries `capabilitiesVersion`, and the `capabilities.changed` event says when
  to refetch. The `GET /capabilities` `ETag` is the same value in double quotes: `capabilitiesVersion` `c-7f3a`
  is `ETag: "c-7f3a"`. [Orchestrator]

## Open sets

Clients ignore response fields and enum values they do not know. `RoleRef.id`, `NeedsItem.kind`, section kinds, adapter
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
active alarms alongside `items` and `notMeasured`. The relay keeps up to 20 active alarms per source and 100 in total.
Keep the most severe first (critical, warning, info), then the newest by `firedAt` within each severity.
Enrolled people can read active alarms.

The optional `dashboards` list defaults to empty. Return it only in authenticated capabilities.
Each entry has `id`, `title`, an HTTPS `url` and an optional `group`. Today opens it locally.
The authenticated board section's `params` contains the configured `board.staleSeconds` and
`board.expirySeconds`. Both are whole seconds and expiry must exceed stale.

A source with a private `secret` accepts `POST /relay/v1/hooks/{sourceId}`. External senders can reach this endpoint
outside the network identity gate. Only the HMAC signature authenticates the sender. Apply the body
size cap and per-source rate limit before verifying the signature. Send the generic
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

## Roles

Admission is either `member` (org membership) or `outside` (an approved named grant). Each request resolves admission, the staff role and its current permissions. Historical person references still contain only id and login. Current people and chat member entries include their RoleRef and admission.

`roles.default` defaults to `staff`. `roles.outsideDefault` defaults to `outside`. Role definitions persist. A founder may replace a template's permissions or reset it. New ids match `^[a-z][a-z0-9_]{0,31}$`. Keep at least one org member with `relay.admin`. An outsider must hold a role with `forOutside: true`. Such a role cannot grant relay.admin, channels.manageAll, channels.directoryAll or channels.openToOutside.

| Permission | Founder | Staff (default) | Contractor | Outside collaborator |
|---|---|---|---|---|
| seePublic | yes | yes | no | no |
| createPublic / createPrivate | yes / yes | yes / yes | no / no | no / no |
| invite | yes | yes | no | no |
| manageAll | yes | no | no | no |
| openToOutside | yes | no | no | no |
| directoryAll | yes | no | no | no |
| dm.start | anyone | anyone | anyone | shared_channel |
| dm.group / dm.outsiders | yes / yes | yes / yes | yes / no | no / no |
| agents.mention / dm / wakeOthers | yes / yes / yes | yes / yes / yes | yes / yes / yes | yes / no / no |
| scope.boards / scope.people | all / all | all / all | all / all | all / shared_channels |
| hub.team / health / pool / machinesAll | yes | yes / yes / yes / no | yes / no / no / no | no |
| relay.admin | yes | no | no | no |
| For outside collaborators | no | no | no | yes |

Channel permissions have the `channels.` prefix. The Hub reads enabled names from `me.permissions`. A valued permission includes its value after a colon, for example `dm.start:shared_channel` or one `scope.boards:<id>` per allowed board. Ignore unfamiliar permissions.

Only a holder of `relay.admin` receives the roles section and can use these calls. GET /roles returns role details and live member counts. PUT /roles/{id} creates or replaces a role using name, forOutside and permissions. DELETE removes an unused custom role. POST /roles/{id}/reset restores its built-in definition. PUT /staff/{personId}/role takes {roleId}. Each successful write sends `roles.changed` to enrolled clients to refetch capabilities.

## Access

The relay intersects board scope with repository grants on every read. Board, Feed, Graveyard, repository listings, Today working and stuck and pull request approval lists all use that intersection. Map items outside the viewer's boards are omitted, including dependencies and plan-only tasks for a restricted viewer. People outside people scope appear by login only on an in-scope approval. Team files are built for each scope and may share hashes only for identical content. Team events go only to viewers who can see the changed person or room. Own machines are visible. Colleagues' named machines require hub.machinesAll. Health needs require hub.health. Shared-thread pickers list only people the caller may DM. Search uses only visible data. Losing access also prevents fetching earlier snapshot files containing that data.

The relay checks admission first. A confirmed loss returns 401 token_revoked. Its details.reason is outside_grant_lost, outside_entry_removed, outside_2fa_off or outside_identity_mismatch. Unchecked and paused outsiders receive 503 unavailable, retryable true, with details.reason outside_check_pending. Refused pairing polls identify the signed-in account with `account {login}`. They never include its network login.

A confirmed revocation removes channel memberships and handles, voids pending requests and posts an access-ended system message. Other DM participants keep history and lose the composer. Re-admission starts with no channel memberships. A restart or temporary admission pause preserves memberships and pending requests.

## Chat

A live `chat.changed` event can include a recipient-specific `notice` with the message ID, author's display name and up to 240 characters of text. The relay sends it for new DMs, addressed asks, eligible channel mentions and followed replies, or all new channel messages when selected. It suppresses alerts for the sender on every machine. Notices are absent from change history. A chat inbox item carries `chatRead`, the conversation, optional thread root and sequence to pass to the private read call.


Paths below are relative to `/relay/v1`. Every call is signed. A read on behalf of an agent supplies the `asHandle` query parameter. The relay verifies the active handle, owner and signing machine before applying the same read filter to every result. An agent request must never fall back to the person’s authority. Paged with `cursor` and `limit` (1–100) like today.

| Call | Does |
|---|---|
| `GET /chat/conversations` | The caller's sidebar: channels they are in, public channels they can join, DMs; each with unread count, mention count and last seq |
| `POST /chat/conversations` | Create a channel `{kind: channel, name, purpose?, template or access, managers?, agents?}` or open a DM `{kind: dm, members[]}` (an existing DM with the same members is returned) |
| `PATCH /chat/conversations/{id}` | Rename, set purpose, access, managers, agents or archive |
| `GET /chat/conversations/{id}/members` | Page through channel members |
| `PUT /chat/conversations/{id}/members/{memberId}` / `DELETE` | Join, add a person or an agent (`h_` id), leave, remove |
| `PUT /chat/conversations/{id}/settings` | The caller's notification level and mute |
| `GET /chat/me/settings` / `PUT` | The caller's own chat settings: `agentsReadMyDms, agentWakeDefault, agentAsks, agentsPaused` (defaults false and everyone). Changing DM reads emits `conversation.updated` for each of the caller's DMs to all participants |
| `GET /chat/conversations/{id}/messages` | Top-level messages, `before` / `after` / `around` a message, newest page first |
| `GET /chat/threads/{rootId}` | The root and its replies |
| `POST /chat/messages` | Post `{conversationId, threadRootId?, text, card?, taskRef?, key, asHandle?}`; the author is the caller's person, or the handle in `asHandle` (only from the handle's machine and owner) |
| `PATCH /chat/messages/{id}` | Edit (author only) |
| `DELETE /chat/messages/{id}` | Delete (author; founders) |
| `PUT /chat/messages/{id}/progress` | Create or edit the caller agent's progress message in a thread (relay slice CR6) |
| `PUT /chat/messages/{id}/reactions/{emoji}` / `DELETE` | React |
| `PUT /chat/tasks/{taskId}/thread` | Open or create the board task's canonical discussion; no request body (relay slice CR5) |
| `PUT /chat/threads/{rootId}/task` / `DELETE` | Associate a current root with a board task, or remove its association (204) (relay slice CR5) |
| `PUT /chat/threads/{rootId}/follow` / `DELETE` | Follow or unfollow |
| `POST /chat/read` | Move read cursors `{conversationId, threadRootId?, seq}` |
| `GET /chat/search` | `q`, `limit`, `cursor`, optional `asHandle`. Each hit includes `conversationName`, `author` (ChatAuthor), `createdAt` (UTC timestamp), snippet and location. |
| `POST /chat/asks` | Create a question or review. Tag the recipient as a person or agent. |
| `POST /chat/asks/{id}/answer` | The recipient answers directly or the target handle submits its result |
| `POST /chat/asks/{id}/cancel` | The agent or its owner |
| `GET /chat/changes` | `after=<seq>`, `limit`; every change the caller may see |
| `PUT /chat/handles/{id}` / `DELETE` | The owner's Hub registers or removes a handle `{name, threadRef, provider, machineId}` |
| `GET /chat/handles` | Handles the caller may mention, with owner and reachable (yes/no) |
| `GET /chat/deliveries` | Pending deliveries for this machine's handles |
| `POST /chat/deliveries/{id}/claim`, `/consume`, `/refuse` | The delivery transitions below |
| `POST /chat/messages/{id}/promote` | Only when `promote` is on: returns the text and link for the Hub to post on GitHub as the person. The relay itself writes nothing to GitHub |

### Channel access and joining

The chat section advertises channel_access, join_requests and agent_inbox. The relay returns me.can on each conversation. The Hub uses those rights for the composer and controls. A hidden conversation returns 404 on every path. Role and channel refusals use 403 with details.account (id, login, role, admission), rule, and the applicable conversationId, asHandle and owner. Codes are role_permission_missing, chat_post_restricted, chat_not_member, chat_invite_restricted, chat_outsiders_not_allowed, chat_manage_restricted, chat_dm_restricted and chat_agent_capped. Role conflicts use 409 role_in_use or role_not_for_outside.


| Template | visibility | join | outsiders | post | invite | agents |
|---|---|---|---|---|---|---|
| General (each `chat.defaultChannels` entry) | public | open, auto-added for roles with `seePublic`, cannot leave | none | everyone (can switch to announcement) | n/a | allowed |
| Team | public | open | none | everyone | members | allowed |
| Private | private | invite | none | everyone | members | allowed |
| Announcement | public | open | none | managers, replies everyone | managers | off |
| Shared with outsiders | private | invite | invited | everyone | managers | mentions_only |
| Community (open source) | public | request | listed | everyone | managers | mentions_only |

The last two need `channels.openToOutside` to create.

#### Effective rights

One function in the relay decides every chat action, for reads, search, `/chat/changes`, events, notices and
writes alike. In plain words:

- **See:** you are a member; or the channel is public and your role has `seePublic`; or you are outside and the
  channel's `outsiders` is `listed`; or your role has `directoryAll` (directory entry only). Anything you
  cannot see answers **404**, never a named refusal, so refusals never reveal a hidden channel.
- **Read:** you are a member, or you can see it as public (not through `directoryAll`).
- **Join / request:** you can see it, the join mode is `open` (or `request`), and if you are outside, `outsiders`
  is `listed`.
- **Post / reply:** you are a member and the `post` (or `replies`) rule includes your role or you are a manager.
- **Invite:** you are a member and a manager, or a member whose role has `channels.invite` where `invite` is
  `members`. The person added must be able to be there: an outside person only when `outsiders` is not `none`,
  and adding them needs you to be a manager.
- **Manage:** you are a manager or your role has `channels.manageAll`.

**Precedence:** admission first (refused people do nothing), then hidden-means-404, then the role permission, then
the channel rule.

**Agents:** an agent's right is its owner's right **and** the agent rule, never more:

| Action | Agent rule on top of the owner's right |
|---|---|
| Read | Today's agent read table (members, `readPublic`, follows, owner-DM switch) |
| Post top-level | `agents` is not `off`; never in a `managers` (announcement) channel |
| Reply | `agents` is not `off`; `mentions_only` allows a reply only in a thread where it was mentioned |
| Mention another agent | Its owner's `agents.mention`; today's hop cap and pair budget |
| Join, request, invite, manage, open a DM | Never. Its owner adds it to a channel the owner is a member of. |

An agent refusal names both the handle and its owner.


The creator manages the channel. PUT or DELETE /chat/conversations/{id}/managers/{personId} changes managers. Keep the last manager unless the person leaves staff. Closing outsider access removes outside members in the same transaction and posts the count. Switching from listed to invited retains them. Role changes preserve explicit memberships. Adding an outsider reveals all earlier messages. GET /chat/directory lists visible unjoined channels with member counts and any pending me.request. Directory-only access reveals metadata. A directory administrator may archive or join a private channel. Joining posts a system line before the person can read history.

**Archiving a channel.** `PATCH /chat/conversations/{id}` with `{"archived": true}` archives it, and `{"archived": false}` restores it. Both need the manage right. Nothing is deleted, and people who could read the channel still can. Nobody can post, reply, join or ask to join while it is archived. Archiving a default channel is refused with 403 `forbidden`. A directory administrator who cannot read the channel sends `archived` as the only field.

POST /chat/conversations/{id}/requests accepts an optional note of up to 200 UTF-8 bytes. Managers page pending requests with GET on that path. One class 2 chat_join_requests need per channel carries conversationId and count.

| Stored state | Event | Next state |
|---|---|---|
| No pending row | Eligible requester asks | pending |
| pending | POST /chat/requests/{id}/approve | approved with membership in the same transaction |
| pending | POST /chat/requests/{id}/decline | declined, retry after seven days |
| pending | Requester deletes /chat/requests/{id} | cancelled |
| pending | Fourteen days pass | expired |
| pending | Channel archived, join mode changes, confirmed revocation, departure or loss of visibility | void |
| Final | Another decision | 409 chat_request_closed with the first actor |

Persist requests and decisions. Sweep on restart. Cap pending requests at five per person. Derive manager counts from pending rows. Send request.updated and access.updated through chat.changed. A temporary outage never voids a request.

DM participants must satisfy each other's dm.start rule. Crossing the admission boundary needs a shared channel. Starting a DM to an outsider also requires dm.outsiders. Outsiders cannot start group DMs or DM another person's agent. Losing the shared channel closes the composer and preserves history.

Every mention, DM, followed reply and ask answer creates an inbox delivery. Its wakes flag is decided at write, and only a pause changes it later. Across owners, agent-written messages stay inbox-only unless the delivery belongs to an open ask or is an ask_result. Outside collaborators never wake another person's agent, including through a reply or an answer to a question. So an `ask_result` whose answerer (`to.owner`, or `to.person`) is an outside collaborator is inbox-only, unless that answerer owns the asking agent. The same holds for a person's answer (reason `answer`). An answerer the relay does not know counts as outside. Paused deliveries are inbox-only. A personal or company pause also turns waking deliveries that are still pending into inbox-only, for the paused owner's handles or for all handles. A claimed delivery keeps its wake. If it returns to pending during the pause, it becomes inbox-only too. Ending the pause restores no wake. An `ask` delivery turned this way keeps the ask's deadline. Any other expires one inbox lifetime after it was written. Asks and their results have their own wake rules (see Requests between agents). So does a person's answer to an agent's question (see Ask to a person). For other messages, Everyone allows the owner and senders with agents.wakeOthers. Owner permits only the owner. Nobody disables all wakes. Outside collaborators cannot wake other people's agents. A mention alone authorizes no action. GET and PUT /chat/me/settings include agentWakeDefault (everyone by default). PUT /chat/me/agents/wake takes {wake} and updates existing owned handles. An owner sees one class 3 agent_inbox need per handle with handleId and count. It counts the deliveries held in that agent's inbox. An `ask` delivery counts only while its ask is `open` (see Requests between agents). An ask that waits for approval shows only as `agent_ask`, or as `review_request` for a review. The MCP tool banneret_chat_inbox uses POST /chat/inbox {asHandle} to read and consume a batch of waiting deliveries on the owning machine. Repeat until empty. It never hands an `ask` delivery to the turn that reads it (see Requests between agents). Waking deliveries expire after 24 hours, inbox-only deliveries after seven days.

### Message search and GitHub posting

With the chat section flag `search`, combine words and filters with spaces. Every term must match. Use `in:#channel`, `from:@person`, `from:owner/agent`, `is:agent`, `is:human`, `kind:ask`, `has:task`, `task:#55`, `before:YYYY-MM-DD` and `after:YYYY-MM-DD`. Dates use UTC midnight, exclusive for before and inclusive for after. A reply inherits the root task when it has none. Return newest messages first. Exclude deleted, progress and system messages. Apply the caller's read rules before paging. Reject empty queries. A DM's conversationName names its participants. A channel's name starts with #.

With `promote` enabled, an empty POST to `/chat/messages/{id}/promote` returns the current text and a Hub-relative `link` of the form `/channels/{conversationId}?message={id}`. Replies include `thread={threadRootId}&` before the message parameter. Require human read access and a live message. Reject agent calls and disabled promotion. The relay performs no external write. The Hub resolves the link against its origin and posts only on explicit confirmation under the person's verified GitHub login.

| In-memory UI state | Event | Next state |
| --- | --- | --- |
| Search open | Query, page, caller or chat revision changes | Fetch that result page and discard superseded results |
| Loading | Response | Results or error |
| Message menu | Post to GitHub | Choose an issue, defaulting to the linked task |
| Choosing | Confirm | Posting, with submit disabled |
| Posting | Tracker response | Destination link or error |
| Any | Restart | Close search and picker. A posted GitHub comment persists. No request is replayed. |

**Events** on the existing `GET /events`: `chat.changed {seq, change?}`, `chat.delivery {deliveryId, handleId}`
(to the handle's machine only). Both are live only and never replayed. Mentions and asks also raise the
existing `needs.changed` and `mention`.

**Shapes.** The objects most calls return:

```text
Conversation { id, kind: channel|dm, name?, purpose, private, agents: allowed|mentions_only|off,
               members[] {kind: person|agent, id, login | handle, ownerLogin?},  // DMs; channels page members
               memberCount {people, agents}, archived, lastSeq,
               agentReaders[] {personId, login},  // DMs only: participants whose agents may read it
               me {member, notify: all|mentions|nothing, muted, readSeq, unread, mentions} }  // me: caller only

Message      { id, conversationId, threadRootId?, seq,
               author {kind: person|agent|system, id?, login?, handle?, ownerLogin?, provider?},
               kind: text|progress|ask|system, text, card?, systemEvent?,
               progress? {state: working|stale|done|blocked|stopped, steps[] {title, state}},
               ask? ChatAsk  // tagged recipient, owner decision, state, result and receipts,
               taskRef?, mentions[] {kind, id}, replyCount, lastReplyAt?,
               reactions[] {emoji, count, mine}, createdAt, editedAt?, deleted }

Handle       { id, owner {id, login}, claimName, shortName?, provider, machine {id, label}, reachable, wake, paused }
```

**Capabilities.** A section `{kind: "chat", version: 1, flags}` plus a `chat` object with limits:

| Flag | Means |
|---|---|
| `channels` | Channels exist |
| `private_channels` | Private channels can be made |
| `dms`, `group_dms` | People can DM |
| `threads` | Replies in threads |
| `agents` | Agents can be members, be mentioned and post |
| `agent_dms` | People can DM agents |
| `agent_owner_dm_read` | People may turn on "My agents can read my DMs" |
| `others_agents` | People can mention and DM other people's agents |
| `asks` | Agent questions and answers |
| `task_links` | Task threads, task chips and lease echoes (relay slice CR5) |
| `reactions` | Reactions |
| `search` | Message search |
| `promote` | "Post to GitHub" on messages |

The `chat` object: `{maxTextBytes, editWindowSeconds, rate {postsPerMinute, postsPerHour, openAsks,
hopCap, pairPerMinute}, retentionDays {channels, dms}}`. Tool descriptions read these numbers.

Count only undeleted replies in `replyCount`. Use their latest creation time for `lastReplyAt` and omit it when the count is zero.

An edit window of zero permits the author to edit at any age. Text and card limits count UTF-8 bytes. Post keys are idempotent per author. Reusing a key in another conversation is refused. Card links accept HTTPS URLs or relay-relative task URLs.

**Relay config** (`chat:` in the relay's one config file, all optional):

| Key | Default |
|---|---|
| `chat.enabled` | `false`. Everything below applies only when true |
| `chat.defaultChannels` | `["general"]`. List of public channel names. Create them on startup. Auto-add only members with `channels.seePublic`. Never auto-add outside collaborators. Eligible members cannot leave. Return `defaultChannel: true` for these channels. |
| `chat.channels.privateAllowed` | `true` |
| `chat.dms.enabled` / `chat.dms.groupMax` | `true` / `8` |
| `chat.agents.enabled` | `true` |
| `chat.agents.readPublic` | `true` |
| `chat.agents.ownerDmRead` | `true`: the per-person switch is offered. Each person's switch still starts off |
| `chat.agents.rate` | `{postsPerMinute: 10, postsPerHour: 120, openAsks: 5, hopCap: 4, pairPerMinute: 20}` |
| `chat.asks.expireAfter` | `7d` |
| `chat.deliveries.expireAfter` / `inboxExpireAfter` | `24h` / `7d` |
| `chat.requests.expireAfter` / `retryAfterDecline` / `maxPendingPerPerson` | `14d` / `7d` / `5` |
| `chat.channels.maxMembers` | `200` |
| `chat.taskLinks.enabled` / `chat.taskLinks.leaseEvents` | `true` / `true` |
| `chat.boards[].channel` | none |
| `chat.retention.channels` / `chat.retention.dms` | `0` (keep) / `0` (keep) |
| `chat.promote.enabled` | `false` (Banneret's preset: `true`) |
| `chat.search.enabled` | `true` |

| Membership and composer | Event | Next state |
|---|---|---|
| Default public channel | Eligible org member enrols | Relay grants membership. Composer available. |
| Other public channel, outside | Join | Await relay confirmation. On failure, show the error and allow retry. |
| Joined | Leave a non-default channel | Relay removes membership. Show Join. |
| Any | Reload or reconnect | Read membership from the relay. Pending UI and open message actions reset on reload. |

Banneret's preset sets `chat.enabled: true`, `chat.promote.enabled: true`, channels `general`, `platform`, `hub`,
`ops`, and maps each board to its channel. Authenticated chat capabilities can publish those mappings as `chat.boards[]` entries with `board` and `channel`. The Hub resolves them against the channels visible to the caller. Nothing Banneret-specific is in code.


**Task threads are relay slice CR5.** The slice covers both task PUTs, the task's root and the lease system
replies below. A relay without it does not advertise `task_links`, and a Hub then calls neither task PUT.

Both task PUTs return 200 `ChatThreadLocation {conversationId, threadRootId}`. A task has one linked root and a root has one linked task. Concurrent links return the existing location, including when the proposed root differs. An inaccessible destination returns 404 without its location. Explicit link and unlink require membership in the writable conversation. Unlink a root before assigning it to another task. Deleting the root frees its association.

Opening an unlinked task creates a system root (`task_linked`, task title, `taskRef`) in its configured board channel, or the default public channel when unmapped. The fake uses its default general channel. Future counted takes, releases and handovers append system replies with `taskRef`, one line of text and `systemEvent` respectively `lease_taken`, `lease_released`, or `lease_handed_over`. The release line includes the release reason. No lease ages or human activity signals are sent. The Hub resolves chip state from its board snapshot.

### Chat state transitions

Deliveries, asks, progress and handle registration persist across restarts. The hop counter, pair budget and rate windows reset on restart. A chat store schema change bumps its user version. Wipe the old chat store on this schema change.

#### Delivery

| From | Event | To | Who |
|---|---|---|---|
| (none) | message stored and the rules say deliver | `pending` | relay, same transaction as the message |
| `pending`, inbox only | `banneret_chat_inbox` on its handle’s machine | `consumed` | Relay, atomically with the read |
| `pending`, wakes | `POST …/claim` from `machine_id` | `claimed` | Hub |
| `claimed` | `POST …/consume` | `consumed` | Hub, after the turn or queue entry exists |
| `claimed` | 10 min without consume | `pending` | relay sweeper |
| `pending`, wakes | its owner's pause or the company pause | `pending`, inbox only | relay, with the pause |
| `pending`, `claimed` | `POST …/refuse` | `refused` | Hub |
| `pending`, `claimed` | `expires_at` passed | `expired` | relay sweeper |
| `pending`, `claimed` | handle removed | `expired` | relay |
| `pending`, `claimed` | restore from backup | `expired` | restore |
| `consumed`, `refused`, `expired` | (none) | final | |

- For waking deliveries, `refused` and `expired` write a `system` message `not_delivered` into the conversation.
- Refusing the `ask` delivery of an open ask also ends that ask at once, as `unanswered` with reason
  `not_delivered`. The relay does not wait for the deadline.
- The Hub writes the delivery id into the turn it creates. Before creating a turn it looks for that id in the
  thread, so a crash between creating the turn and `consume` never sends twice.
- Claims by any machine other than `machine_id` are refused with 403 `forbidden`.

### Ask to a person

The request names `to: {"kind": "person", "person": "<id or login>"}`. The stored ask carries
`to: {"kind": "person", "person": {"id", "login"}}`. `banneret_chat_ask` uses this shape. With no
`threadRootId`, the ask opens a DM between the agent and that person.

An agent asks only a person its owner can see. Under `scope.people: shared_channels`, that is someone who
shares a channel with the owner. For anyone else the relay returns 404 `not_found`, by id or by login, whether
or not the ask names a thread. This check comes before the DM and thread rules, so a refusal never confirms a
hidden person.

| From | Event | To |
|---|---|---|
| (none) | `POST /chat/asks` | `open` (+ Needs-you item `chat_ask` for that person) |
| `open` | the named person answers (choice or thread reply) | `answered` (+ delivery `answer`, no `ask_result`) |
| `open` | agent or owner cancels | `cancelled` |
| `open` | `expires_at` passed | `expired` |
| `open` | handle removed | `orphaned` |
| any final | answer or cancel | 409 `ask_closed` |

`POST /chat/asks/{id}/answer` accepts exactly one of `{choice}` (an offered label) and `{text}` (nonblank). Only the named person can answer an open ask. The reply answers that ask alone and returns 200 with its updated `ChatAsk`. Invalid choices and blank text return 400. A closed ask returns 409 `ask_closed`. Another recipient gets 403, and a hidden ask gets 404.

The Needs-you item is derived from `open`, so every exit removes it. A choice click posts the choice as the
person's message, so `answerMessageId` is always set. A thread reply by the named person while
an ask is open in that thread answers it (with the reply text, no choice). The answer is that person's
click, so it sets `decidedBy`.

The `answer` delivery wakes the asking agent whatever its wake setting, and whatever the person's
`agents.wakeOthers`. The agent asked and is waiting. Two cases leave it in the inbox: a pause of the agent's
owner or of the company, and an answer from an outside collaborator who does not own the agent. A reply that
answers no ask keeps the normal wake rule.

An outside collaborator's agent asks another person only when its owner could DM that person under the current
DM rule, in a thread or a DM. Otherwise the relay returns 403 `chat_dm_restricted`. These questions count
against the limits of asks between agents: the open and daily caps for the owner and that person
(`agent_ask_capped`), the same question to that person three times in one thread or DM (`agent_ask_circle`),
and the hour's wait after a decline (`agent_ask_declined_recently`). All the owner's agents share these
counts with their asks to that person's agents, in both directions. An agent that asks its own owner is not
limited this way. A member's questions to a person count toward none of these. The limit of five open asks per
agent applies to every agent.

### Requests between agents

Agent asks, hand-offs and reviews each have a switch in chat configuration: `chat.agentAsks.enabled`, `chat.handoffs.enabled` and `chat.reviews.enabled`. Each defaults to false.

- **The asks and hand-off switches are independent.** Hand-offs work with asks off, and asks work with hand-offs off.
- **Reviews require asks.** With asks off, the relay advertises no `reviews` flag, whatever the review switch says.
- **Reviews stay off until relay slice CR6.** Keep `chat.reviews` off until the relay serves promotion (see [Review asks](#review-asks)).

The flags are `agent_asks`, `handoffs`, `reviews` and `agent_pause`. With asks off, an ask to an agent returns 404 `not_found`. With hand-offs off, every hand-off call returns 404. The role permission `agents.ask` belongs to Founder, Staff and Contractor by default. The tools `banneret_agent_ask` and `banneret_agent_answer` come with asks, and `banneret_handoff_offer` comes with hand-offs. Each requires that permission.

A new ask names either `{kind: person, person: id}` or `{kind: agent, handle: id}`. The stored row includes the resolved person or handle owner. Both agents need a shared thread where they may reply. Only the supplied question (6144 bytes), context (8192 bytes), completion condition (300 bytes), choices and task or PR references travel. Check the originating person's rights at every hop. A retry with the same handle and key returns its existing row.

| Stored state | Event | New state and effect |
|---|---|---|
| New | Same owner, and the chain was started by that owner or by a member | Open and deliver an ask. No consent is needed. |
| New | Same owner, and the chain was started by an outside collaborator who is not that owner | Waiting_owner, as in the owner approval row. No rule opens it. With the owner's asks off, refuse with 403 `agent_ask_off`. |
| New | Matching auto rule of another owner, and neither the asker nor the chain's origin is an outside collaborator | Open with `byRule: true` and reason `auto_accepted`, and deliver an ask. Record the rule decision in the thread. |
| New | Owner approval required | Waiting_owner. Emit a Needs change and a machine delivery. Keep the delivery inbox-only. |
| Waiting_owner | Owner allows once, always or draft | Open. Deliver to the answerer. Save an always rule in the same commit. |
| Waiting_owner | Owner answers or declines with a reason | Answered or declined |
| Open | Named handle answers | Answered, or draft for owner confirmation |
| Open | Turn ends without an answer, including stop or cap | Unanswered with a reason |
| Open | The answerer's machine refuses the ask delivery | Unanswered with reason `not_delivered`, at once |
| Draft | Owner posts, optionally editing the text, or discards | Answered or declined |
| Any active state | Asker cancels, deadline passes, or either side loses access | Cancelled, expired or orphaned |
| Any final state | Another decision | Return 409 `ask_closed` with the first decision |

**Where a chain starts.** The relay knows a chain's origin only through `parentAskId`: the new ask takes the parent's `onBehalfOf`. A Hub sends `parentAskId` for an ask made during the turn that answers another ask. An ask sent without it starts a new chain under the asking agent's owner, so the relay cannot apply the rules of an earlier chain to it.

State values on the wire use lowercase. Creation, decisions and expiry update the thread and its derived Needs items. Each final transition writes exactly one `ask_result` to the asking handle in the same transaction if that handle still has access. A draft is private to the answerer's owner until confirmation. The asking handle can attach a receipt on create. The answering handle can attach one on answer. A hand-off collects the giver receipt on offer and the receiver receipt on accept. Receipts name the handle, token count, elapsed seconds and tool names. Tool arguments, results and prices stay out of receipts.

`decidedBy` records only a person's click: a decision, an answer, a confirmation or a cancel by that person. An action by an agent handle, a rule or the relay never sets it. An earlier click stays on the ask when an agent acts later. A rule acceptance records `byRule: true`, as on a hand-off, and `to.owner` is the rule owner. `byRule` is optional and stays on the ask through later states. A client shows the auto-accept only when it is true. The thread line for a change names the person who clicked, the agent handle that acted, or Relay.

Deleting the ask message, or its thread root, orphans an active ask. The asker still gets its `ask_result` if it can still read the conversation. That delivery's message is the tombstone: `deleted: true`, empty text and the final `ask`. A machine must accept it and tell the asker the question was deleted. It must never refuse a result because the question is gone.

List asks with `GET /chat/asks?role=asker|answerer|owner`, optionally filtering by state. Both lists support pagination. The owner calls `/decision`, `/answer` or `/confirm` on an ask. A handle submits `asHandle` on its answer. The relay guards each change by the current state. Rows and deadlines survive relay restarts. Sweep on startup and while running.

The Hub saves an answer run for each ask turn it starts, from a wake or from an inbox read. On restart it ends an open ask as unanswered only when it saved a run and that run is gone. A consumed delivery alone never ends an ask. An ask that was read but never got a saved run waits for its deadline.

Push `needs.changed` to the owner and `chat.delivery` to the owning machine when the ask is written. On approval, issue the waking delivery. Reconnect with backoff starting at two seconds and drain after the event cursor. An offline machine can claim until the deadline. Owner wait time counts against the four-hour default, up to seven days.

The answerer's wake setting applies to an ask as follows. An ask that its owner approved with a click wakes the answerer, even when the answerer is set to `nobody`. An ask that opened without a click, by a rule or between one owner's agents, stays in a `nobody` agent's inbox and wakes nothing. An `ask_result` wakes the asker, whatever its wake setting, unless the answerer is an outside collaborator who does not own the asking agent. Personal and company pause come first: a delivery written during a pause is inbox-only. That includes an `ask_result`, which waits in the asker's inbox.

An ask shows in the answering owner's Needs you at most once:

| Ask | Needs item |
|---|---|
| `waiting_owner` or `draft` | `agent_ask`, or `review_request` for a waiting review. It never counts in `agent_inbox`. |
| `open`, with a delivery that wakes | None |
| `open` and unread in the inbox: held by a pause, or opened without a click for a `nobody` agent | Counts in that agent's `agent_inbox` |
| Read from the inbox, or ended | None |

An ask read from the inbox runs like a woken ask. The reading turn gets none of its text. For each open ask addressed to that agent, the Hub queues one answer turn, unless its owner is paused. It has the same read-only rules, token and time limits and receipt, and `banneret_agent_answer` gives its one result. `banneret_chat_inbox` counts these turns in `answerTurns`. If the Hub or the owner (`agentsPaused`) is paused, it ends the ask as unanswered with reason `paused`. A Hub cannot see the company pause. If the turn cannot start, the reason is `start_failed`, or the same reason a woken ask would give. An ask that is not open, such as one still waiting for its owner, is withheld and starts nothing. Approval delivers it again.

`agentAsks` in personal settings defaults to approve, an empty auto list, 200000 tokens and 900 seconds. Off and pause take precedence over auto rules. Questions may match a person, agent handle or member role. Reviews and hand-offs may match only a person. Reject an outsider role or an invalid source with `auto_accept_scope`. A person rule must name a current person who is not an outside collaborator. An agent rule must name an active handle whose owner is not one. A role rule must name a known role that is not for outside collaborators. The relay checks only sources that are new in the saved policy, so a stored source that has since gone blocks no later save, such as a pause.

No auto rule accepts an ask when the asker, or the person the chain started from (`onBehalfOf`), is an outside collaborator. Only the answering owner's click opens it, also between one owner's agents on such a chain. The one exception is an outside collaborator who owns both agents and started the chain: a click would only ask the same person, so the ask opens at once. `allow: "always"` on an ask from an outside collaborator returns 403 `auto_accept_scope`. So does `allow: "always"` on a same-owner ask that waits because of its chain: a rule naming yourself would change nothing. The ask stays waiting and no rule is saved. A client offers no "Always allow" for these asks. On a later hop between two owners, where a member's agent asks, "always" still saves a rule for that member, and no rule ever opens an outside collaborator's chain. A configured usage threshold falls back to owner approval when below-threshold usage cannot be established. Each handle exposes its owner's `agentsPaused` as `paused`. A relay administrator can set company wake pause with `PUT /chat/agents/pause`.

Asks between one owner's agents skip the two directed-pair limits on every chain. They also skip consent and the owner's `off` setting, except on a chain that another outside collaborator started. There the ask needs the owner's click, and `off` refuses it with 403 `agent_ask_off`, like a direct ask from an outsider. A pause and every other limit apply to them.

| Limit | Default | Refusal |
|---|---|---|
| Open per asking handle | 5 | rate_limited |
| Asks to agents in one thread since a person last wrote there (hop cap, shared with agent mentions) | 4 | rate_limited |
| Asks and mentions between one pair of agents in one thread per minute, both directions | 20 | rate_limited |
| Open per directed pair of two different owners | 3 | agent_ask_capped |
| Per directed pair of two different owners in 24 hours | 20 | agent_ask_capped |
| Chain depth | 2 | agent_ask_depth |
| Ask back to a waiting ancestor | Never | agent_ask_cycle |
| Identical question, target and thread | 3 | agent_ask_circle |
| Same question to the declined owner's agents | Wait 1 hour | agent_ask_declined_recently |
| Missing common home | Required | agent_ask_no_home |
| Off or paused target | Refuse | agent_ask_off or agent_ask_paused |

A target owner who turned asks off gets 403 `agent_ask_off` for an ask from another owner's agent, including an outside collaborator's direct ask. The same code refuses an ask between that owner's own agents on a chain another outside collaborator started. A Hub says `<owner> doesn't take asks from other people's agents.`

An `ask_result` and an answer add nothing to the hop cap or the pair limit. Read these counts from stored rows. Existing thread hop and posting limits still apply. The signed capabilities response publishes `chat.rate.agentAsks` and `chat.rate.handoffs`. Derive class 2 `agent_ask` by asking owner and count across waiting and draft rows. Each waiting review gives one `review_request` with its ask ID.

### Named hand-offs

Create an offer with `POST /chat/handoffs` and list by giver or receiver with `GET /chat/handoffs`. The note carries goal, done, next and optional risks. The giver's Hub checks that its branch is pushed. Only the holder can offer and the named receiver must have access to take the task. Reject failures with `handoff_not_holder` or `handoff_cannot_take`. A second active offer for the task receives 409 `handoff_open`.

A repeated offer from the same giver and handle with the same key, task and receiver returns the stored hand-off. The same key with another task or receiver returns 409 `handoff_key_reused`.

| Stored state | Event | New state |
|---|---|---|
| New | Offer accepted for storage | Offered. Emit handoff_offered and derive handoff_offer for the receiver. |
| Offered | Receiver accepts, or a matching personal auto rule passes the Take checks | Accepted. Emit handoff_accepted. |
| Offered | Receiver declines, giver withdraws, 24-hour deadline passes | Declined, withdrawn or expired |
| Offered | Giver loses the lease, task closes or a party loses access | Void |
| Accepted | Giver withdraws before release | Withdrawn |
| Accepted | Receiver holds the lease | Closed with outcome done |
| Accepted | A third party takes the released task | Closed with outcome lost |
| Final | Repeated decision | 409 handoff_closed |
| Final | 30 days pass since it finished | Removed. It leaves the lists, a decision on it returns 404, and its key is free again. |

**An `incomplete` lease never closes or voids a hand-off.** Its parts disagree, and the holder it names may have no claim. So it decides neither the step nor a change of holder. An accepted hand-off keeps its step, usually `waiting_take` after a take that did not finish. After the stall time, `handoff_stalled` tells the person whose write is next. Withdrawing an accepted hand-off on such a lease returns 503 `unavailable`. A closed task, lost access or the offer's deadline still end the hand-off. A giver that an `incomplete` lease names can still offer.

The Office shows agent activity that your account can read. Floor and List show it as text. Select a robot to see its question and open the shared thread when available.

| Agent indicator | Appears when | Clears when |
| --- | --- | --- |
| Asking | An agent question or review is waiting for a decision, open or awaiting draft confirmation | The ask closes |
| Answering | The recipient has an open agent ask | An answer or draft is submitted, or the ask closes |
| Pending hand-off | An agent offers a hand-off | The lease transfer finishes or the offer ends |
| Paused | The handle reports Pause or its machine is paused locally | The corresponding pause is lifted |

The Office rebuilds these indicators from current relay data and the machine's saved Pause setting when you reopen it. They add no activity history.

Each offer records the signed giver device as `fromMachineId` and its resolved discussion as `threadRootId` when present. When an offer names no thread, the relay looks up the task's linked thread itself (relay slice CR5). So a Hub opens the task thread first on a relay that advertises `task_links`, and need not add it to the offer. Only that giver device runs the release. Creation always leaves the offer pending. For automatic acceptance the receiver checks the tracker first, then sends `byRule: true` and its own `machineId` to `/accept`. The relay rechecks the named-person rule, usage and pause settings at that write. If the rule or its limits no longer allow the hand-off, return 403 `auto_accept_scope` and leave the offer open for a click. The signed receiver device must supply its own machine ID on rule acceptance. Persist `byRule: true` on the hand-off through all later transitions. Manual acceptances omit this audit field. A successful rule acceptance records “Auto-accepted by <login>'s rule.” in the thread.

The receiver calls `/accept` with its selected machine (and `newThread: true` to start a new task thread there after take) or `/decline` with a reason. The giver calls `/withdraw`. Emit `handoff_declined` for decline and `handoff_closed` for other final outcomes. Keep the existing lease release event. Derive `waiting_release` while the giver holds the lease and `waiting_take` while the task is free. After 30 minutes in a step, derive class 2 `handoff_stalled` for the party that can advance it. Each Hub re-reads the fold before writing its release or claim. On restart, read accepted offers and recompute the step from the tracker.

### Review asks

A review is an ask of kind `review`, sent to an agent. It names the repository, the PR number and the requested head SHA. The rules for requests between agents above apply too: consent, rules by a named person and the loop limits. A review has no draft mode, so `allow: "draft"` returns 400. A result carries the reviewed head and a verdict of `clean`, `findings` or `could_not_review`. Only a person posts a review or approval to GitHub.

**`chat.reviews` stays off until relay slice CR6, "agent reads + progress".** The Hub's "Post as review" first calls `POST /chat/messages/{id}/promote`, which that slice serves.

The relay finds the pull request on the asker's board by its GitHub link. The asker, the reviewer's owner and the person the chain started from must all see it, or the relay returns 404 `not_found`. When the relay cannot read enough of a board to decide this, it returns 503 `unavailable`. A merged or closed pull request returns 400 `malformed`. Each head has at most one active review for each reviewer owner.

**Maker and checker.** The reviewer's owner must not have opened the pull request or hold any task that links it. Logins are compared without case. An `incomplete` lease counts for the holder it names. This applies between one owner's agents too. If the board shows neither, but the relay cannot tell who opened the pull request or who holds a linked task, a review request returns 503 `unavailable`.

**The relay checks again when the verdict arrives,** because the owner may have taken the task since. This covers the reviewing agent's answer and the owner's own answer by hand:

- If the reviewer's owner now holds a linked task or opened the pull request, the review ends as `orphaned` with reason `review_same_owner`. It writes its one `ask_result`. The answer gets 403 `review_same_owner`, and the change is still saved.
- If the board cannot rule that out, also when no task on it links the pull request any more, the answer gets 503 and the review stays active.
- An answer with `none: true` posts no verdict, so it is not checked.
- No background check ends a review for this.

**When the head moves.** The board comes from GitHub data, which can lag. It may still show the old head when an agent asks about a commit it has just pushed. So the relay ends a review as `head_moved` for a different board head only after its board has shown the requested commit. A board read that began before the review was written does not count. Until then, only the reviewer's Hub can report a move. It reads the head itself when it checks out the pull request and before it answers. It then sends `none: true` with reason `head_moved`. An answer that names another head ends the review the same way.

| Stored state | Event | New state and effect |
|---|---|---|
| New | The reviewer's owner opened the pull request or holds a linked task | Refused, 403 `review_same_owner` |
| New | The board cannot rule that out | Refused, 503 `unavailable` |
| New | That head already has an active review by that owner | Refused, 403 `agent_ask_capped` |
| Waiting_owner, open | A verdict arrives and the reviewer's owner now made the pull request or holds a linked task | Orphaned, `review_same_owner`. The answer gets 403 |
| Waiting_owner, open | A verdict arrives and the board cannot rule that out | Unchanged. The answer gets 503 |
| Open | A verdict for the requested head | Answered, with verdict and head |
| Waiting_owner, open | The answer names another head | Unanswered, `head_moved` |
| Open | The board has shown the requested head and now shows another | Unanswered, `head_moved` |
| Waiting_owner | The owner answers after the board showed the requested head and then another | Unanswered, `head_moved` |
| Waiting_owner, open | The pull request is merged or closed | Orphaned |

Every other change follows the ask table, so an answer to a review that has already ended gets 409 `ask_closed`. The relay sees a merge or close only while the pull request is still on the board. Otherwise the review ends at its deadline. A head change after a review has finished does not change it, and the client marks it stale. The board shows the current commit in the linked pull request's optional `headSha`. An answered review's `answerMessageId` names the ask's own message, the result card that the human-only promotion check uses.

### Progress message (`messages.progress_state`)

| From | Event | To | Who |
|---|---|---|---|
| (none) | `banneret_chat_progress` with no working message in that thread | `working` | agent via Hub |
| `working` | progress call | `working` (edited) | agent |
| `working` | progress call with `done`, `blocked`, `stopped` | that state | agent |
| `working`, `stale` | session stops, errors or is archived | `stopped` | owner's Hub |
| `working`, `stale` | Hub restart finds no live session for it | `stopped` | owner's Hub, before serving |
| `working` | handle's machine "not heard from" (90 s) | `stale` | relay sweeper |
| `stale` | the same handle calls progress again | `working` (same message) | agent via Hub |
| `working`, `stale` | handle removed | `stopped` | relay |
| final | (none) | final | |

### Handle

| From | Event | To |
|---|---|---|
| (none) | `PUT /chat/handles/{id}` from the owner's machine | `active` |
| `active` | owner removes it; Hub reports thread deleted; machine revoked; owner leaves staff | `removed` |

`unreachable` is derived (the machine is "not heard from", 90 s), never stored, so it cannot get stuck.

On restart the relay reconciles: any `active` handle whose owner is no longer staff, or whose machine is revoked,
is removed with the full cleanup.

**Writing as a handle.** Any write with `asHandle` (message, reply, progress, ask, reaction, delivery calls) is
accepted only when the signed call comes from `handles.machine_id`, the token's person is `handles.owner_id`,
and `state = 'active'`. Otherwise 403 `forbidden`.

### Who may read what

| Reader | Can read |
|---|---|
| Person | Channels allowed by the channel rules below and DMs they are in |
| Agent (handle) | Within the owner's read access: public channels (when `chat.agents.readPublic`); channels it is a member of; DMs it is in; threads it follows; its owner's DMs with people only while `person_settings.agents_read_dms = 1` for the owner and `chat.agents.ownerDmRead` is true. Read and search only: never a delivery or a wake |
| Founder | Same as a person. Founders do not read others' DMs through the API. The operator can read the file |

One read filter implements this table. `chat_read`, `chat_search`, `/chat/changes` and `/chat/conversations` all
use it, so the A3 switch cannot be bypassed through a second path. Turning the switch off takes effect on the next
call; it cannot take back what an agent already read.

### Delivery rules (the write path)

For a stored message M by author A in conversation C:

1. For each agent `@mention` H in M: deliver to H if C allows agents (not `off`), and A is H's owner or
   A has `agents.mention`; if A is an agent, also check the hop cap and the pair budget. Across owners the mention is inbox-only. Only an open ask or its result may wake the other agent.
2. If C is a DM with agent H and A is a person: deliver to H (reason `dm`).
3. If M is a reply and A is a **person**: deliver to every agent following that thread, except ones already
   covered by 1 (reason `follow`). Agent authors never trigger follow deliveries.
4. If M answers an open ask: deliver to the asking agent (reason `answer`).
5. Set `wakes` once when storing the message. An inbox-only delivery waits up to seven days.
6. At most one delivery per (H, M): the first matching reason of answer, mention, dm, follow.

### Chat events

On the existing `GET /events` stream:

| Event | To | Payload |
|---|---|---|
| `team.changed` | enrolled staff, live only | `{person:{id,presence,status?,seatBoard?}}` |
| `team.rooms_changed` | enrolled staff, live only | `{}` |
| `chat.changed` | every person who may see the change, on all their machines | `{seq, change?}`. `change` is the full change (message with text) when it fits in 8 KiB, otherwise absent and the Hub reads `/chat/changes` |
| `chat.delivery` | the handle's machine only | `{deliveryId, handleId}` |
| `needs.changed` | the person | existing; raised for asks, mentions and DMs |
| `mention` | the person | existing; carries the Needs-you item |
| `reset` | as today | the Hub also re-reads `/chat/changes` from its last seq and `/chat/deliveries` |

Only `mention`, `team.changed` and `chat.changed` may include content. Live Team and chat events omit the SSE event ID so reconnects retain the last replayable ID. `chat.changed` and `chat.delivery` are live only. They never enter the relay's 1000-event replay ring, so chat
traffic cannot push other events out of it. After any reconnect the Hub reads `/chat/changes` from its last seq
and `/chat/deliveries`, which are the truth.

`GET /chat/changes?after=<seq>` returns `{items[], nextSeq, resync}`. `resync: true` means the feed was pruned
past `after`; the Hub then reloads the conversation list and the open conversation.

Message changes resolve to the current message, including its tombstone after deletion. Conversation changes carry a reference so each participant fetches their own view. A private cursor update reaches only the same person’s machines. A chat ask adds `ask` to its class 1 Needs item so the named person can answer by id.

### Owner Hub delivery and progress calls

`PUT /chat/handles/{id}` accepts an opaque string `threadRef`. Omit `name` or `wake` to preserve that field on an existing registration. A new handle defaults to its claim name and wakes for everyone. The Hub derives the id from the thread. An existing id cannot move to another owner, machine or thread.

Every `ChatDelivery` includes the target `threadRef`, `wake` policy at write and the resulting `wakes` flag and current `message: ChatMessage`. Only its enrolled machine can read or claim it. `GET /chat/deliveries?asHandle=...` additionally limits the list to one owned handle. Reclaiming a claimed delivery from the same machine returns its current contents. The Hub uses the handle and delivery ids as its durable dispatch receipt.

Relay slice CR6, "agent reads + progress", adds both progress calls, together with owner-DM reads, search and promotion.

`GET /chat/progress?cursor=...&limit=...` returns `{items: [{handleId, threadRef, message}], nextCursor}` for this machine's working or stale progress. For `PUT /chat/messages/{id}/progress`, the id may be a thread root, a DM conversation, or the working progress message itself. Updating by progress id must reject a closed message. This prevents a stale reconciliation from stopping a newer message. Agent conversation reads with `asHandle` page oldest first.

## Shared machines

The relay advertises the signed-in section `{id:"pool",kind:"pool",version:1,flags:[]}` when
`pool.enabled` is true. Configure the block using `PoolConfig` (see `examples/pool-config.json`).
Host capacities are ceilings. Take the lower configured and reported limit. A host must independently
verify its level, capacity and image list before accepting a request. Size suffixes K, M and G are binary.
A schema change wipes the pool store.

Host enrolment uses the existing signed start and poll bodies at `/pool/hosts/enroll/start` and
`/pool/hosts/enroll/poll`. The machine environment ID names the configured host. A founder must
confirm the pairing. Bind the resulting credential to that host and permit only host calls. Ordinary
device tokens authorize the Hub calls. Scope sandbox reads, cancellation and extension to the owner.

Every 30 seconds the host replaces its previous facts with one full report. Drop superseded samples.
The facts response returns effective ceilings and warning thresholds as `PoolPolicy`. Signed-in Hubs
read the same policy on the host row. Before the first report its policy is null.
After two minutes without a report set `reporting:false`. A host that has never reported has null
contention. The running array is the complete set of running sandbox IDs. The relay filters workspace
rows by authenticated person ID before constructing `me.workspaces`. Staff hosts show current slot
holders and the line. Community hosts return empty lists and counts only. Ended rows belong to the owner.

Disk and memory values are bytes. PID and inode values are counts. A null limit is unlimited.
A null sample is unavailable. Use UTC measurement times for host-wide and local samples only.
Set `notMeasured` to macos, windows or missing_files when a source is unavailable, otherwise null. CPU throttling is the percentage of
throttled periods in the last five minutes. PSI is the kernel percentage for some and full over 10 and
60 seconds. The host uses aggregate PSI, available memory, pool memory and free slots. Set busy if
any configured host threshold is exceeded. A person's Hub reads local Resources and sends them
directly to that person's desktop. The host heartbeat can carry only disk, inodes and warning flags
for that person. The memory warning also covers a new OOM kill. Never send human activity samples.

A workspace Hub with `BANNERET_POOL_HOST_ID` set to its configured host ID includes `poolHostId` in machine facts. Owners always receive their own machines through `GET /machines`, including `poolHostId` when configured, regardless of sharing. The `machines` snapshot includes only live machines shared with their name and carries `poolHostId` on those machines when configured. The desktop uses this ID to match the public pressure reading to the machine. Standalone machines omit it. Access to a live reading always requires a direct connection to the workspace Hub.

| Resource state | Event | Next state |
| --- | --- | --- |
| Hidden | Owner opens a linked machine | Read immediately, then every 15 seconds while visible |
| Visible | Read fails or machine disconnects | Drop its reading |
| Visible | User leaves or changes workspace | Discard the view and ignore outstanding replies |
| CPU window warming | Five minutes of counters available | Show throttling from the counter delta |
| CPU window available | Counters reset, slice changes or sampling gap exceeds five minutes | Warm a new window |

All samples stay in memory. Restart clears the window. Folder sizes are read only on request.

A sandbox offer carries the original signed POST to `/relay/v1/pool/sandboxes` as standard base64 body
bytes with the original signing headers. Pool calls have no query parameters. Hosts verify the signature
with the requesting machine key already bound to that person, check the signed host, size and digest,
and key local work by the pair of sandbox `id` and opaque `offerId`. Each re-offer of the signed request has a fresh offerId.
The offer deadline is 60 seconds. Hosts include the offerId in every state update. A stale or unknown
offerId returns 409 `stale_offer`. A forbidden transition for the current offer returns 403 `forbidden`.
Both include `{error, current: {sandboxId, state, offerId?}}`. A late `starting` after expiry gets the
current `waiting` state without an offerId. Abort that local start and accept future offers for the same sandbox.
If the owner cancels before the host acknowledges, the relay ends the sandbox with reason `cancelled`,
releases the slot immediately and sends no directive. A late host state update gets 409 `stale_offer`
with current state `ended`.
An unknown sandbox or a sandbox assigned to a different host returns 404 without its state.

Host facts replies include `directives`. Host next replies contain `{offer, directives}`, with a null
offer when no request is eligible. Both carry up to 100 pending directives for that host across sizes.
Apply each directive to its matching booking and post the resulting state. For `extend`, set the timer
to the absolute `endsAt` and report `running` with that exact timestamp and the running machineId.
For a `cancel` directive on an acknowledged booking, stop the booking and report `ending`, then report the cleanup outcome. Polls repeat
directives until confirmed. A newer extension replaces the pending deadline and cancel supersedes extend.

For each size, the host reports `freeSlots` as its local slot capacity minus all locally held slots
in `starting`, `running`, `ending` or `cleanup_failed`. The relay subtracts only unacknowledged
`offered` rows from that number before offering work. Its configured slot limit still applies.

Queue places start at 1. Wait estimates use seconds. An extension requires a
running sandbox and an empty line. Use the normal error envelope with 409 pool_limit_reached or
403 level_not_offered. The relay only records requests. All account and sandbox operations run on the host.

| State | Event and next state | Storage and restart |
| --- | --- | --- |
| Workspace asked | Founder approves or declines | Relay keeps the request |
| Approved | Admin creates the account and verifies limits | Relay keeps approval |
| Ready to join | Member joins, or unused account expires after seven days | Host facts rebuild the row |
| Active | Founder suspends, or member leaves | Host restarts the member's service |
| Suspended | Admin resumes or removes the account | Locked account stays locked |
| Removed | Purge home after 14 days | Host stores the purge date |
| Sandbox waiting | Eligible host takes it, member cancels, or two hours elapse | Relay stores the queue order |
| Offered | Host acknowledges with starting, expiry restores the original queue place, or owner cancellation moves it to ended | Relay releases the offer reservation on cancellation or expiry |
| Starting | Hub enrols and reports running, owner cancellation starts ending, or startup fails after three minutes | Starting, running, ending and cleanup_failed each occupy a local slot in freeSlots accounting |
| Running | Apply extend and confirm running with endsAt, or enter ending on cancel, expiry or reboot | Agent reconciles the unit. Reboot ends it with host_restarted |
| Ending | Verified cleanup gives ended, a failure gives cleanup_failed | Host resumes cleanup before reuse |
| Cleanup failed | Admin verifies cleanup and closes the request | Host and relay keep the slot unavailable |
| Ended | Delete after seven days | Relay retains the owner-only result |

#### Founder pool controls

A signed Hub device belonging to a current founder can GET or POST `/pool/founder`.
Both return `PoolFounderView`. Host credentials and other roles receive 403.
List pending unexpired host pairings by pairing ID and host ID only. Confirm using
`{action:"confirm",pairingId,code}` with the code supplied by the admin, or refuse
using `{action:"refuse",pairingId}`. Apply the existing pairing expiry and attempt limit.
Unknown, closed and non-host pairings return 404.

Each configured host row has requested, local and effective ceilings (limits and sizes).
Local and effective are null before the first facts report. POST
`{action:"limits",requested:{limits,sizes}}` to replace that host's requested ceilings.
Require a report, keep host ID and level fixed and reject excess capacity or a memory
floor above its maximum with 409 pool_limit_reached. Compare sizes in bytes.
Recompute effective ceilings immediately and on every report, taking each lower bound.
Warnings continue to come from the pool configuration.

Workspace request rows identify the request, host, person and state (asked or approved).
POST `{action:"approve",requestId}` to reserve a workspace within effective capacity.
Repeating approval succeeds while reserved. Keep approval visible until host facts
report the seat. The host administrator chooses an unused login, UID and port and
runs the seat command by hand. The relay never provisions an account.

The Pool view includes `sandboxes` (the configured sandbox policy, or null)
and `bookings` (the authenticated owner's retained sandbox and host ID pairs).
The Hub polls each visible booking by ID. Each non-null offer includes
`publicKey`, the standard-base64 raw Ed25519 key of the enrolled signing
machine, supplied by the authenticated relay from its machine record.

PoolSandbox receipts include the board `taskId` from the signed request, or null
for a standalone booking. With Pool enabled, advertise `banneret_pool_status`,
`banneret_sandbox_request`, `banneret_sandbox_status` and `banneret_sandbox_cancel`
in the signed capabilities for members allowed to use them.

## Capability owners and plugin sources

An enrolled capabilities response may include `owners` and `sources`. Older relays omit both.
Anonymous responses omit both. Bump `capabilitiesVersion` when the published document changes.

When present, `owners` names one owner for each of tasks, skills, memory, chat, search and health.
Choose `banneret`, `off` or `external`. An external owner names a source whose `provides` includes the
capability. Tasks owned by Banneret use `leases: banneret`. External tasks use `leases: provider`.
Disabled tasks and the other five capabilities omit leases. New relays default tasks, skills, memory
and search to Banneret, and chat and health to off. Banneret's own preset enables all six.

Each source has a unique id, title, MCP URL, capabilities it provides, public authentication instructions
and the last source check. Use HTTPS, or HTTP with a private IP, Tailscale IP or tailnet DNS name.
Source ids cannot be `t3-code`, `t3-code-direct` or start with `banneret`. An optional tool prefix
uses 1 to 32 lowercase ASCII letters, digits or underscores and ends with an underscore.
A Hub connects directly with its user's OAuth or bearer credential, or uses the company's network
identity (`none`). A source advertises no command, credentials or relay reader configuration.

The relay filters `mcpTools` by owner. Board, task and lease tools follow tasks. Skills, memory,
chat (including agent asks, answers and handoffs) and KB search follow their respective owners.
Needs and Team remain relay views. When chat is external or off, omit the chat section and its limits
and return HTTP 404 with code `not_found` on the chat routes.

| Source check before | Event | Source check after |
| --- | --- | --- |
| Any | Config changes | unchecked |
| unchecked or last result | Startup, check interval or manual check | checking |
| checking | Required tools found | ok |
| checking | Missing required tools | shape_missing |
| checking | Read exceeds 5 seconds | degraded |
| checking | Service identity refused | auth_failed |
| checking | Anonymous check needs a login and there is no reader | reachable |
| checking | Connection fails or times out | down |

Persist the last result per source, including its check time and any tool shape found. The interval
timer is in memory and starts again on restart. In each reported capability's shape, `required` is
`complete` or a list of missing names. The `optional` list holds the optional tool names found.
See [an external tracker](examples/capabilities-external.json).
