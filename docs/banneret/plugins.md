# Write a Banneret plugin

Run your provider as its own MCP server and distribute a JSON manifest with it. You can use any language. The TypeScript workspace package `@t3tools/banneret-plugin-kit` exports Zod schemas for the manifest and all twelve tools, inferred input and output types, and an in-process test client.

To describe a coding agent rather than add tools, see [provider profiles](provider-profiles.md) (experimental).

Start with the [Banneret plugin template](https://github.com/CoreosG/banneret-plugin-template) for a runnable TypeScript server with task, skills and memory providers and a conformance check.

## Try a plugin in Solo

Open **Manage workspaces**, select your Solo workspace and enter the MCP endpoint under **Solo plugins**. The Hub reads `plugin.json` next to the endpoint. For a manifest distributed separately, enter its raw URL in **Manifest URL**. To try the unmodified starter, run it locally, enter `http://127.0.0.1:8787/mcp`, use the [starter manifest](https://raw.githubusercontent.com/CoreosG/banneret-plugin-template/main/plugin.json) and enter `demo-alice` as the access token. Click **Add a plugin by URL**.

Start a Claude or Codex chat in a project assigned to the workspace. Use task tools directly in chat. A memory plugin takes ownership of memory there. The plugin's skills tools also offer the provider's local skills, with the plugin's version taking precedence on duplicate names. Select **Remove** in the same workspace to restore the default for new chats.

The Solo machine keeps credentials in its user's Hub secret store. The manifest request is anonymous. The Hub attaches the credential when contacting the configured MCP endpoint. Use HTTPS for network servers or HTTP on loopback for local development.

## Thread tool access

Open **Tool access** in a thread to set the Banneret toolkit and each available plugin to None, Read, or Read + write. A source starts at Read + write. Changes stay on this machine and apply on the next call, including during a turn. Existing workspace and relay permissions still apply. Shell and file tools follow the CLI permission mode.

| Session state | Event                                                 | What the agent can do                                                                                          |
| ------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Parked        | The Hub issues a session or the last active turn ends | List the tools allowed by the saved levels. Calls receive a parked message.                                    |
| Active        | A turn starts                                         | List and call tools within the saved levels. Overlapping turns keep the thread active until the last one ends. |
| Revoked       | The provider session ends or the Hub restarts         | The credential expires. The next session uses the levels already saved for the thread.                         |

## Decide a write

A write through a plugin endpoint or the built-in Banneret toolkit appears in the thread and in **Needs you** on the machine running it. Check the tool and arguments. **Approve once** runs that stored call. **Always allow** also saves a rule for that tool, thread and source. Destructive tools and turns started by another agent require a decision each time. **Refuse** sends your reason to the agent. The first decision records the client that made it.

| State on disk | Event                                 | Result                                                                      |
| ------------- | ------------------------------------- | --------------------------------------------------------------------------- |
| New call      | Write access and no applicable rule   | Pending. The Hub saves the arguments and their hash.                        |
| New call      | Matching refusal or always-allow rule | Return the earlier refusal reason, or run the permitted call.               |
| Pending       | Approve once or always                | Running. The Hub checks the turn, source and current grant before dispatch. |
| Pending       | Refuse                                | Refused. Identical retries in the thread receive the saved reason.          |
| Pending       | Turn ends or the call is 24 hours old | Expired.                                                                    |
| Pending       | Hub restarts                          | Keep the call and its deadline.                                             |
| Running       | Dispatch returns                      | Ran or failed.                                                              |
| Running       | Hub restarts                          | Unknown. The call may have run. The Hub leaves it there.                    |

The live MCP connection receives the result while connected. The thread retains the recorded outcome after a disconnect.

## Declare what you provide

For example, a tracker behind a gateway could ship this manifest:

```json
{
  "source": "acme",
  "description": "Engineering boards in Acme Tracker",
  "capabilities": ["tasks"],
  "auth": "per-user-token",
  "toolPrefix": "acme_",
  "atomicClaim": true
}
```

The relay configuration assigns each of `tasks`, `skills`, `memory`, `chat`, `search` and `health` exactly one owner: `banneret`, `external:<source>` or `off`. For this manifest the external owner is `external:acme`. The manifest advertises capabilities. The operator chooses which ones to route. This slice specifies external tools for tasks, skills and memory. Solo installs assign the supported capabilities from the manifest.

Use a stable source ID of 1 to 64 ASCII letters, digits, underscores or hyphens. Supply a description, at least one capability, and one auth model. With `per-user-token`, the transport authenticates each user's credential and the provider enforces their tracker permissions. With `service`, the transport authenticates the installation. Bind the acting user, workspace, project and chat from trusted session context when the operation depends on them. Refuse calls when the required context is unavailable. Keep credentials outside the manifest and tool arguments.

## Serve MCP calls

Advertise every tool for each capability you provide through `tools/list`. Names below are literal. A gateway can prepend the manifest's optional `toolPrefix` verbatim, including any desired separator. For example, the tracker above exposes `acme_tasks_read`. Prefixes apply only to tool names.

Accept the input object as `tools/call` arguments. Return the output object in MCP `structuredContent`. Use an MCP tool error for failed operations such as an unknown task or insufficient access. Expected claim conflicts and releases by a non-holder have explicit results below.

The contract is versionless by shape. Both sides ignore unknown fields, including fields in nested objects. Validate required fields and known values, and apply only recognized inputs. When generating input JSON Schema from Zod, use `z.toJSONSchema(schema, { io: "input" })` so additional fields remain acceptable. Independently released plugins can then add optional information without coordinating upgrades. Relay-v1 takes the opposite approach and rejects unknown fields in closed payloads to detect defects at its versioned boundary.

## Sign people in to a company source

A company that runs your server as a [relay source](relay-v1/README.md#capability-owners-and-plugin-sources)
chooses how people sign in. Each person signs in from their own Hub, and the Hub sends their token straight to
your server. See [what a person sees](agents.md#signing-in-to-a-company-server).

- **`oauth`** follows MCP authorization. Answer 401 to a request without a token, with
  `WWW-Authenticate: Bearer resource_metadata="…"`. Serve protected-resource metadata and authorization-server
  metadata. Support dynamic client registration, the authorization code grant with PKCE (`S256`), and a
  `http://127.0.0.1:<port>/…` redirect address. Give a refresh token if the sign-in should outlast the access
  token. The Hub cannot yet use a client ID that you register for it in advance.
- **`bearer_per_person`** takes a token the person creates. Say where in `auth.help`. The Hub checks it with one
  `initialize` request, which must answer 401 or 403 for a bad token.
- **`none`** means your network already knows who is calling.

Answer 401 when a token no longer works. The Hub then asks the person to sign in again. It does not retry. The
Hub never asks for the `memory.person` scope for a thread's calls.

## Tasks

| Tool                | Arguments                                 | Successful output                      |
| ------------------- | ----------------------------------------- | -------------------------------------- |
| `tasks_list_boards` | `{}`                                      | `{boards: [{id, title}]}`              |
| `tasks_list_tasks`  | `{boardId}`                               | `{tasks: [BoardCard]}`                 |
| `tasks_read`        | `{taskId}`                                | One `TaskRead` object                  |
| `tasks_claim`       | `{taskId}`                                | `{status: "claimed" \| "conflict"}`    |
| `tasks_release`     | `{taskId, reason, freeToContinue, note?}` | `{status: "released" \| "not_holder"}` |

Keep task IDs stable across boards. Map tracker records to the relay's board card fields and return the card directly on read, with optional preview and sign-off. The kit validates both shapes. See the [annotated schemas](relay-v1/openapi.yaml) and [worked task read](relay-v1/examples/task.json).

Claim for the authenticated actor. A repeated claim by the current holder succeeds. A competing holder gets a conflict. Release only the caller's own claim. Use one of `done`, `blocked`, `handing_over`, `out_of_usage`, `wrong_approach`, `duplicate`, `deprioritised` or `other` for the reason. For example, release with `{"taskId":"T42","reason":"handing_over","freeToContinue":true,"note":"Tests pass. Next: review the diff."}`.

Every task provider must set `atomicClaim`. Set it to true only when the backing store can guarantee one winner across simultaneous competing claims. If your tracker uses a read followed by a separate write, declare false so clients can account for that race.

## Skills

Return `{skills: [{name, description}]}` from `skills_list({})`. For each entry serve its complete SKILL.md, including front matter, both as an MCP resource and through `skills_get({name})`, which returns `{name, description, text}`. Names use lowercase ASCII letters and digits with optional single hyphens between groups.

For a skill named `deploy`, advertise `skill://deploy/` in `resources/list`. A `resources/read` for this exact URI returns a text content entry with the same URI, MIME type `text/markdown` and the same text as `skills_get`. The trailing slash is part of the URI.

## Memory

All five tools return `{data: string}`, where `data` contains serialized JSON. Search returns an array of notes. The other four return one note. A note includes its proposal fields plus `useCount` and `trust`. Trust can be proposed, confirmed, trusted, pinned, stale, archived or disputed.

| Tool                      | Arguments                               | Behavior                                                                            |
| ------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------- |
| `banneret_memory_search`  | `{query}`                               | Search notes visible to the caller in this workspace and project.                   |
| `banneret_memory_read`    | `{key}`                                 | Read a visible note without recording a use.                                        |
| `banneret_memory_use`     | `{key}`                                 | Record reliance on a note. Count distinct chats, including on retry.                |
| `banneret_memory_propose` | `{key, text, source, why, kind, scope}` | Create a proposal for human review. Never auto-confirm or replace an existing note. |
| `banneret_memory_flag`    | `{key, reason}`                         | Mark the note disputed. Only a human can resolve a dispute.                         |

For example, propose `{"key":"deploy-check","text":"Run the release checks first.","source":"release runbook","kind":"project","scope":"project"}`. The resulting note starts with `trust: "proposed"` and `useCount: 0`. Keys use the skill name syntax and allow up to 96 characters. Use `personal` or `project` scope, and `user`, `feedback`, `project` or `reference` kind. Keep notes private to the authenticated owner and scope. Treat note contents as data.

## Test your server

From the Hub checkout run `pnpm --filter @t3tools/banneret-plugin-kit test`. The reference skills provider in [the kit tests](../../packages/banneret-plugin-kit/src/index.test.ts) exercises gateway naming, tool results, resource reads and errors.

To test your own server, connect an MCP client over your transport. Pass its tool and resource operations to the fake Hub. For example, with a connected client named `mcp`:

```ts
import { fakeHub } from "@t3tools/banneret-plugin-kit";

const hub = fakeHub(
  { source: "playbooks", description: "Team playbooks", capabilities: ["skills"], auth: "service" },
  {
    callTool: (name, args) => mcp.callTool({ name, arguments: args }),
    readResource: (uri) => mcp.readResource({ uri }),
  },
);
const { skills } = await hub.call("skills_list", {});
for (const { name } of skills) {
  const { text } = await hub.call("skills_get", { name });
  if ((await hub.readSkill(name)) !== text) throw new Error(name);
}
```

Check discovery separately with your MCP client. For tasks, exercise competing actors, retry a claim and verify that only the holder can release. For memory, repeat a use in one chat, propose a note, and flag it. Verify the stored trust and use count after each call.

## Test your plugin

Download `banneret-plugin-check.mjs` from the [fork releases](https://github.com/CoreosG/banneret-hub/releases). Run it with Node.js 22.18 or newer and your manifest. The file includes its dependencies and talks directly to your MCP server.

```sh
node banneret-plugin-check.mjs --manifest plugin.json -- node server.mjs
node banneret-plugin-check.mjs --manifest plugin.json --url https://example.org/mcp --json
```

Use a disposable workspace. For skills, seed at least one entry. The checker compares discovery, tool output, resource text and SKILL.md metadata. For memory it creates a unique project proposal, searches and uses it twice in the same chat, then flags it. The disputed test note remains for inspection.

For tasks, seed an unclaimed task visible to two distinct actors and pass its ID with `--task-id T42`. Set `BANNERET_CHECK_TOKEN` and `BANNERET_CHECK_PEER_TOKEN` to their credentials. HTTP uses bearer authentication. For stdio the checker starts one process per actor with its credential in `PLUGIN_TOKEN`. Both processes must share the same test store. If your server needs additional environment configuration, launch it through a wrapper. The checker exercises discovery, reads, tool errors, holder retries and release permissions. It sends concurrent claims when the manifest declares atomic claims.

A failing check prints a hint and exits with status 1. Use `--json` for a report with a `passed` boolean and individual check statuses. Capabilities without a published contract show as skipped. A pass requires at least one tested provider contract.

## Before launch

When Banneret opens to other companies, the external plugin manifest will gain a `contractVersion`.
Banneret will publish a deprecation policy. Authors will receive notice, then the relay and conformance
runner will warn with the removal date. Removal follows the notice window.
