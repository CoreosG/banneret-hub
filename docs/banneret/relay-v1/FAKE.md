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
- `--host`, `--quiet`.

In tests, `startFakeRelay({ port: 0 })` from `@t3tools/banneret-relay-fake` returns the same server with
in-process helpers: `approve(confirmCode, person?)`, `refuse(confirmCode, reason)`, `seedNeeds`,
`bumpCapabilities`, `publishBundle` and `removeStaff`. `eventClock` replaces the clock that ages
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

| Call                                                                                                | Effect                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /conformance/v1/pairings/{pairingId}/confirm` `{code, person: {login, role?, awaitFounder?}}` | The person signs in and types `code`. A wrong code counts toward the 5 that expire the pairing. `awaitFounder` holds a new person in `awaiting_approval`. |
| `POST /conformance/v1/pairings/{pairingId}/approve`                                                 | A founder approves an `awaiting_approval` pairing.                                                                                                        |
| `POST /conformance/v1/pairings/{pairingId}/refuse` `{reason}`                                       | Refuses with `declined` or `not_staff`.                                                                                                                   |
| `POST /conformance/v1/pairings/{pairingId}/expire`                                                  | Expires the pairing now: `code_expired` while `pending`, `approval_expired` while `awaiting_approval`.                                                    |
| `POST /conformance/v1/needs` `{machineId, count, kind?}`                                            | Adds needs-you items for the machine's owner, in this order, and sends one `mention` per item for kind `mention`, then one `needs.changed`.               |
| `POST /conformance/v1/capabilities/bump`                                                            | Changes the capabilities version and sends `capabilities.changed`.                                                                                        |
| `POST /conformance/v1/bundle` `{bundleSha}`                                                         | Sends `bundle.changed`.                                                                                                                                   |
| `POST /conformance/v1/staff/remove` `{login}`                                                       | Removes a person, revokes their machines and sends `staff.removed`.                                                                                       |

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
