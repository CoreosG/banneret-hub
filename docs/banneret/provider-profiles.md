# Provider profiles (experimental)

A provider profile describes one coding agent: which instruction files it reads, how its memory is switched off, how its hooks work, and where its skills, agents and MCP servers live. It is a JSON file. It cannot run code.

Profiles are experimental. The shape may change in any release. They are not part of the plugin manifest contract in [Write a Banneret plugin](plugins.md).

The Hub does not act on profiles yet. This page describes the data and the checks it must pass.

## What ships

The package `@t3tools/banneret-plugin-kit` exports the profile code as `@t3tools/banneret-plugin-kit/provider-profile`.

| Piece                               | Where                                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The shape, with each part explained | [schema.ts](../../packages/banneret-plugin-kit/src/providerProfile/schema.ts)                        |
| Claude Code, driver `claudeAgent`   | [claudeAgent.json](../../packages/banneret-plugin-kit/src/providerProfile/profiles/claudeAgent.json) |
| Codex, driver `codex`               | [codex.json](../../packages/banneret-plugin-kit/src/providerProfile/profiles/codex.json)             |
| The profile with nothing known      | [unknown.json](../../packages/banneret-plugin-kit/src/providerProfile/profiles/unknown.json)         |
| The two fixed file trees            | [trees.ts](../../packages/banneret-plugin-kit/src/providerProfile/trees.ts)                          |

`providerProfile(driverId)` returns the built-in profile for a driver. Any other driver gets the unknown profile under its own id. It never gets another provider's facts.

## Every fact has a source

A fact is written in one of two ways:

```json
{ "value": ["~/.example/skills"], "from": ["skills-page"], "note": "Optional." }
```

```json
{ "unknown": "The skills page does not say.", "from": ["skills-page"] }
```

Each id in `from` names an entry in `sources`. An entry is a documentation address with the day it was read, or a file in the Hub repository with a function name and commit. A fact about the provider cites its documentation. A fact about what the Hub's own adapter does cites the Hub's code.

An unknown fact may list the pages that left it open, for example two pages that disagree.

Do not guess. Write `unknown` when the docs do not say. A page that does not mention a feature does not prove the feature is missing.

An empty list or `null` is a claim. `"managed": { "value": null, ... }` says there is no organization-wide instruction file. `"managed": { "unknown": ... }` says nobody knows.

## The parts

| Part                      | What it declares                                                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instructions`            | Personal, project and subfolder files. Where the search starts and stops. The order, fallback names and size limits. The home folder, rule folders and imports. How the provider reads `AGENTS.md`                   |
| `memory`                  | Whether it has a learned memory, where it is, and the launch settings that switch it off                                                                                                                             |
| `hooks`                   | The hook model, files and handler types. The maps from the provider's event, tool and input names to shared ones. How a hook blocks, whether it can ask, the trust step, and what cannot be carried to this provider |
| `skills`, `agents`, `mcp` | Folders, files and formats                                                                                                                                                                                           |
| `hubNotes`                | Whether the Hub can add its own note to a turn                                                                                                                                                                       |
| `conformance`             | The files the docs say the provider reads from each fixed tree                                                                                                                                                       |

Paths are written the way the provider's docs write them.

A profile rejects keys it does not know. This differs from the plugin manifest, which ignores them. A misspelled key in a profile would otherwise drop a fact without a word.

When reading `hooks`:

- A tool kind that is missing from `tools` is not known. A tool kind in `cannotCarry` is known to be missing.
- A profile may name a helper that finds file paths, such as `applyPatchPaths`. The list of helpers is fixed in the Hub. A profile cannot add one.
- `recordedInputs` holds hook inputs captured from a real run. Examples copied from documentation do not count.

## Check a profile

Print a built-in profile to copy, an empty one for another driver, or the shape as JSON Schema. Run these from the Hub repository:

```sh
node packages/banneret-plugin-kit/checker/cli.mjs --print-profile claudeAgent
node packages/banneret-plugin-kit/checker/cli.mjs --print-profile my-driver > profile.json
node packages/banneret-plugin-kit/checker/cli.mjs --print-profile schema
```

Then check your file:

```sh
node packages/banneret-plugin-kit/checker/cli.mjs --profile profile.json
```

The released `banneret-plugin-check.mjs` takes the same options, in releases that include profiles. It needs no Hub source. Add `--json` for a report. A failed check names the field and exits with status 1.

| Check                                                          | What it does                                                                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shape`                                                        | The file matches the schema, and the cited sources and the listed sources are the same set                                                                          |
| `instructions: mixed tree` and `instructions: agentsOnly tree` | Works out which files your facts say are read from a fixed tree, then compares the list and its order with `conformance.instructionLoads`                           |
| `hooks: maps`                                                  | No name is mapped twice. With a known event map and `cannotCarry`, each shared event is in exactly one of them. A provider that cannot ask says so in `cannotCarry` |

Write `conformance.instructionLoads` by hand from the provider's docs. If you copy what the check prints, the check proves nothing. The trees exist only in memory. The check reads your profile file and none of the provider's files.

Each list has four parts:

- `atStart` and `onDemand` are the files read, in order.
- `undetermined` holds files the docs do not say are read or skipped.
- `unknownLevels` names the levels the facts cannot answer for. An unknown level is different from a level with no files.

The trees do not cover every setting. They use each provider's default home folder and default settings, they use the Linux path for an organization's file, and they do not list rule folders.

Two checks show as skipped:

- **Same verdict through the adapter.** The same guard, run directly and through the Hub's hook adapter, must give the same result. The Hub has no adapter yet.
- **The Hub applies the memory off switch.** The Hub does not start sessions with profile switches yet. Today only the shape of the switch is checked.
