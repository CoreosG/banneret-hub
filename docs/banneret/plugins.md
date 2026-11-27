# Write a Banneret plugin

Run your provider as its own MCP server and distribute a JSON manifest with it. You can use any language. The TypeScript workspace package `@t3tools/banneret-plugin-kit` exports Zod schemas for the manifest and all twelve tools, inferred input and output types, and an in-process test client.

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

The relay configuration assigns each of `tasks`, `skills`, `memory`, `chat`, `search` and `health` exactly one owner: `banneret`, `external:<source>` or `off`. For this manifest the external owner is `external:acme`. The manifest advertises capabilities. The operator chooses which ones to route. This slice specifies external tools for tasks, skills and memory. Relay selection and Hub integration come later.

Use a stable source ID of 1 to 64 ASCII letters, digits, underscores or hyphens. Supply a description, at least one capability, and one auth model. With `per-user-token`, the transport authenticates each user's credential and the provider enforces their tracker permissions. With `service`, the transport authenticates the installation. Bind the acting user, workspace, project and chat from trusted session context when the operation depends on them. Refuse calls when the required context is unavailable. Keep credentials outside the manifest and tool arguments.

## Serve MCP calls

Advertise every tool for each capability you provide through `tools/list`. Names below are literal. A gateway can prepend the manifest's optional `toolPrefix` verbatim, including any desired separator. For example, the tracker above exposes `acme_tasks_read`. Prefixes apply only to tool names.

Accept the input object as `tools/call` arguments. Return the output object in MCP `structuredContent`. Use an MCP tool error for failed operations such as an unknown task or insufficient access. Expected claim conflicts and releases by a non-holder have explicit results below.

The contract is versionless by shape. Both sides ignore unknown fields, including fields in nested objects. Validate required fields and known values, and apply only recognized inputs. When generating input JSON Schema from Zod, use `z.toJSONSchema(schema, { io: "input" })` so additional fields remain acceptable. Independently released plugins can then add optional information without coordinating upgrades. Relay-v1 takes the opposite approach and rejects unknown fields in closed payloads to detect defects at its versioned boundary.

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

| Tool                      | Arguments                          | Behavior                                                                            |
| ------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------- |
| `banneret_memory_search`  | `{query}`                          | Search notes visible to the caller in this workspace and project.                   |
| `banneret_memory_read`    | `{key}`                            | Read a visible note without recording a use.                                        |
| `banneret_memory_use`     | `{key}`                            | Record reliance on a note. Count distinct chats, including on retry.                |
| `banneret_memory_propose` | `{key, text, source, kind, scope}` | Create a proposal for human review. Never auto-confirm or replace an existing note. |
| `banneret_memory_flag`    | `{key, reason}`                    | Mark the note disputed. Only a human can resolve a dispute.                         |

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
