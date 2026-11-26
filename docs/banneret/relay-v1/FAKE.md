# The fake relay

`packages/banneret-relay-fake` is a test double for the `/relay/v1` contract in this folder, plus a
conformance suite that runs against any relay. It is never a production relay: everything lives in memory,
enrolment has no sign-in page, and a test can approve or refuse any pairing. Release builds do not include it.

## Run it

```sh
node packages/banneret-relay-fake/src/bin.ts --port 0
```

It prints its origin, such as `http://127.0.0.1:41234`. The API is under `/relay/v1`. By default every
pairing is approved as soon as it starts, as the founder `ada-example`. Options:

- `--manual-approval`: pairings wait until a test confirms them through the control surface below.
- `--network-identity-header <name>`: turns on the optional network identity check, reading the caller's
  identity from that request header.
- `--public-origin <url>`: the origin clients reach the fake at when a proxy sits in front of it. It becomes the
  origin of the `browserUrl` that `POST /enroll/start` returns. Without it the fake uses the request's Host
  header over `http`, which is wrong behind an HTTPS proxy and is refused by the Hub's enrolment client as a
  different origin. The value is a scheme (`http` or `https`), a host and an optional port, with no path; the
  fake exits at start-up on anything else.
- `--host`, `--quiet`.

To demo the fake over Tailscale Serve:

```sh
node packages/banneret-relay-fake/src/bin.ts --port 4100 --public-origin https://<host>.<tailnet>.ts.net:8443
tailscale serve --https=8443 http://127.0.0.1:4100
```

In tests, `startFakeRelay({ port: 0 })` (also `publicOrigin`) from `@t3tools/banneret-relay-fake` returns the same server with
in-process helpers: `approve(confirmCode, person?)`, `refuse(confirmCode, reason)`, `seedNeeds`, `seedRepositories`,
`bumpCapabilities`, `publishBundle` and `removeStaff`.

The snapshot (README, "Snapshot") is built in memory. Files are stored once by the hash of their bytes, and each
person has a list of heads. The fake rebuilds every existing head whenever facts, needs, repositories or machines
change, and on every read of the head, so a head it serves is always current and it never answers 503. A read of
a file checks the caller's own retained heads (their last 16, plus any replaced less than 10 minutes ago), so
shared storage never grants access. `eventClock` replaces the clock that ages
the event log, so a test can prove the 24-hour `Last-Event-ID` bound and its `reset` event without waiting a
day.

## Run the conformance suite

```sh
cd packages/banneret-relay-fake
vp test run --config ../../vite.config.ts --dir .
```

Without settings it starts its own fake on an ephemeral port. To test another relay, such as the Go relay
in test mode, set its origin:

```sh
BANNERET_RELAY_URL=http://127.0.0.1:8080 vp test run --config ../../vite.config.ts --dir .
```

That relay must run with the network identity check off, and it must expose the control surface below.
Three tests run only against the fake, because they need a fresh store or a different configuration: the
empty-store start, the network identity check and the 24-hour event retention bound.

## Control surface (tests only)

A relay under test replaces the browser sign-in and the founder's decisions with these calls. They are
outside `/relay/v1`, are not part of the contract, and must never be enabled in production. Each takes and
returns JSON.

| Call                                                                                                                               | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /conformance/v1/pairings/{pairingId}/confirm` `{code, person: {login, role?, awaitFounder?}}`                                | The person signs in and types `code`. A wrong code counts toward the 5 that expire the pairing. `awaitFounder` holds a new person in `awaiting_approval`.                                                                                                                                                                                                                                                                                                      |
| `POST /conformance/v1/pairings/{pairingId}/approve`                                                                                | A founder approves an `awaiting_approval` pairing.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST /conformance/v1/pairings/{pairingId}/refuse` `{reason}`                                                                      | Refuses with `declined` or `not_staff`.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /conformance/v1/pairings/{pairingId}/expire`                                                                                 | Expires the pairing now: `code_expired` while `pending`, `approval_expired` while `awaiting_approval`.                                                                                                                                                                                                                                                                                                                                                         |
| `POST /conformance/v1/needs` `{machineId, count, kind?}`                                                                           | Adds needs-you items for the machine's owner, in this order, and sends one `mention` per item for kind `mention`, then one `needs.changed`.                                                                                                                                                                                                                                                                                                                    |
| `POST /conformance/v1/repositories` `{count}`                                                                                      | Adds `count` repositories (`example-org/repo-N`) to the company list, in this order.                                                                                                                                                                                                                                                                                                                                                                           |
| `POST /conformance/v1/capabilities/bump`                                                                                           | Changes the capabilities version and sends `capabilities.changed`.                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST /conformance/v1/bundle` `{bundleSha}`                                                                                        | Sends `bundle.changed`.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /conformance/v1/visits/read` `{login}`                                                                                       | Returns `{lastVisitAt, lastReadAt}` for the person: the reported last visit and the last `visit=1` read (both null if none).                                                                                                                                                                                                                                                                                                                                   |
| `POST /conformance/v1/visits/age` `{login, minutes}`                                                                               | Moves the person's stored visit times `minutes` into the past, to cross the 30-minute rule without waiting.                                                                                                                                                                                                                                                                                                                                                    |
| `POST /conformance/v1/usage` `{machineId}`                                                                                         | Returns `{usage}`: the `usage` array of the machine's latest facts (empty when it sent none).                                                                                                                                                                                                                                                                                                                                                                  |
| `POST /conformance/v1/snapshot/age` `{login, minutes}`                                                                             | Moves the replacement time of each of the person's snapshot heads `minutes` into the past, to cross the 10-minute retention floor without waiting. Returns `{heads}`, the number of heads the person holds. Answers 404 when the person has no head. The current head never ages out.                                                                                                                                                                          |
| `POST /conformance/v1/snapshot/rebuild` `{login}`                                                                                  | Forces an immediate rebuild of the person's snapshot head, ignoring any rebuild interval. Returns `{changed, etag}`: `changed` is true when the rebuild produced a new head. Heads are immutable, so an unchanged head yields no new head and the current one stays. Answers 404 for an unknown or removed person. Relays with a rebuild interval must honour it in test mode, so suites need not wait out the interval.                                       |
| `POST /conformance/v1/board/seed` `{tasks: [{id, title, column?, status?, holder?, leaseState?, branch?, projectKey?, restsOn?}]}` | Replaces the board with these tasks. `column` is a column id (default `free`); `status` defaults to `planned`; `holder` is a login and makes the card a held task whose lease starts now; `leaseState` may be `paused` or `conflict` to force those states; `branch` (and optional `projectKey`) let a fact find the task. Rebuilds every head.                                                                                                                |
| `POST /conformance/v1/lease/age` `{taskId, hours}`                                                                                 | Moves the task's lease `lastSignalAt` (and `since`) `hours` into the past, so a test crosses the 6 h stale and 24 h expired lines without waiting. Answers 404 for an unknown or unheld task. Rebuilds every head.                                                                                                                                                                                                                                             |
| `POST /conformance/v1/feed/seed` `{count?, type?, importance?, taskId?, by?}`                                                      | Replaces the feed with `count` derived entries (default 3), newest first and one minute apart. `type` defaults to `built` and `importance` to `normal`; `taskId` (a seeded board task, else 404) attaches the task, its link and its status; `by` is a login and sets the author. More than 100 entries leave the rest behind `nextCursor`. Rebuilds every head.                                                                                               |
| `POST /conformance/v1/graveyard/seed` `{cause, count?, taskId?, by?}`                                                              | Replaces the graveyard with `count` entries (default 1), all with this `cause`, newest first. `taskId` (a seeded board task, else 404) names the task; otherwise each entry gets a made-up task. `by` is a login. Rebuilds every head.                                                                                                                                                                                                                         |
| `POST /conformance/v1/checked/seed` `{taskId, by, reviewer}` (person ids)                                                          | Gives the seeded board task a merged pull request, passing checks and a `checked` label added by person id `by`, approved by person id `reviewer`, and releases any lease. The check is valid when `by` is an enrolled founder (the sign-off role) and `reviewer` is another id; otherwise `checked.valid` is false with an `ignoredReason` and the card stays `built`. Answers `{valid}`; 404 for an unknown task or an unknown `by` id. Rebuilds every head. |
| `POST /conformance/v1/map/seed` `{plan, statuses?}` or a stage plan document                                                       | Sets the stage plan the map is built from; see below. Rebuilds every head.                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST /conformance/v1/staff/remove` `{login}`                                                                                      | Removes a person, revokes their machines and sends `staff.removed`.                                                                                                                                                                                                                                                                                                                                                                                            |

The Go test relay (banneret-platform) offers matching operator commands for the seeds: `hub work seed`,
`hub lease age --task --hours`, `hub feed seed`, `hub graveyard seed --cause` and `hub checked seed --task --by
<login> --reviewer <login>` and `hub map seed --file -` (the plan on stdin). The control calls and the commands do the same thing. `board/seed` also accepts
`preview: {state, url?}` per task, which `GET /tasks/{taskId}` returns.

The fake computes lease state from age on every read: under 6 h `active`, from 6 h `stale`, from 24 h `expired`. A
held card with a stale or expired lease is in Stuck, never Free. A fact with a matching `taskId`, or a matching
`branch` (and `projectKey`, when the task has one), sets `lastSignalAt` to now and returns the lease to `active`.

`map/seed` takes a stage plan document (README, "Stage plan file") as the whole body, or `{plan, statuses?}` where
`statuses` maps an item id to a status for items with no `task` (the plan itself carries none). `hub map seed --file -`
reads the document from stdin and sends the same call. The fake accepts any `plan` and judges it the way a relay judges
its configured file, so a test can seed a broken one: a valid plan gives the map section and a `map` head file; an
invalid one (schema, duplicate or unknown ids, a `restsOn` that names nothing, a cycle) leaves the section present with a
`not_measured` map and the reason; `{plan: {"unreadable": true}}` does the same with `unreachable`; `{plan: null}` removes
the plan, so the section and the head key are omitted. The map joins an item's `task` to the seeded board cards by
`tracker`, `host`, `scope` and `key`. The fake's cards use tracker `github`, scope `example-org/example-app` and the key
`1`, `2`, ... in `board/seed` order. Changing whether the plan exists bumps the capabilities version.

## Changing the spec

This folder is the canonical contract. Change `openapi.yaml`, `README.md` and `examples/` here, update the fake
and the conformance suite in the same pull request, and run the suite. banneret-platform then copies the folder
into its mirror at `internal/hub/contract/relay-v1/`, where a drift test fails until the copy matches.

`scripts/banneret/sync-relay-spec.mjs` remains only for a one-off import from the platform, for example to take
over a change made there first:

```sh
node scripts/banneret/sync-relay-spec.mjs <banneret-platform>/internal/hub/contract/relay-v1 <commit-sha>
```

It overwrites the canonical `openapi.yaml`, `README.md` and `examples/` here with the platform's, so review the
diff before committing.
