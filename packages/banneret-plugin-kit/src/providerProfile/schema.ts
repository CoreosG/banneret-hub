// Experimental: the shape may change in any release. It is not part of the plugin manifest contract.
// Objects are strict, unlike the plugin manifest: a misspelled key must fail, not silently drop a fact.
import { z } from "zod";

const text = z.string().min(1);
const sourceId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const source = z.union([
  z.strictObject({
    url: z.url().describe("The provider's documentation page."),
    checked: z.iso.date().describe("The day the page was read."),
  }),
  z.strictObject({
    code: text.describe("A file in the Hub repository, for a fact about the Hub's own adapter."),
    symbol: text.describe("The function or name in that file that shows the fact."),
    commit: z.string().regex(/^[0-9a-f]{7,40}$/),
    checked: z.iso.date(),
  }),
]);

function fact<T extends z.ZodType>(value: T, explain: string) {
  return z
    .union([
      z.strictObject({
        value,
        from: z.array(sourceId).min(1).describe("Ids of entries in `sources`."),
        note: text.optional().describe("A limit or condition the value cannot express."),
      }),
      z.strictObject({
        unknown: text.describe("Why this is not known."),
        from: z
          .array(sourceId)
          .min(1)
          .optional()
          .describe("Pages that were read and left it open, for example because they disagree."),
      }),
    ])
    .describe(explain);
}

// A relative path inside a folder, such as `AGENTS.md` or `.claude/CLAUDE.md`.
const fileName = z
  .string()
  .regex(
    /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/,
    "Use a path relative to the folder, without `..`.",
  );

const nameRule = z.strictObject({
  names: z.array(fileName).min(1).describe("File names, in the order they are read."),
  take: z
    .enum(["all", "firstNonEmpty"])
    .describe("Read every name that exists, or only the first one that has content."),
});

const trigger = z.enum(["read", "write", "edit"]);
const level = z.enum(["managed", "user", "project", "local", "subdirectory"]);
export const instructionLevels = ["managed", "user", "project", "subdirectory"] as const;

const sizeCap = z.strictObject({
  limit: fact(
    z.strictObject({
      amounts: z
        .array(
          z.strictObject({
            amount: z.int().positive(),
            unit: z.enum(["bytes", "characters", "lines", "tokens"]),
            when: text.optional(),
          }),
        )
        .min(1),
      setting: text.nullable().describe("The setting that changes the limit, or null."),
    }),
    "The size limit.",
  ),
  counts: fact(z.enum(["eachFile", "allFilesTogether"]), "What the limit is measured over."),
  over: fact(
    z.enum(["skipsFile", "keepsStart", "dropsLaterFiles"]),
    "What happens beyond the limit.",
  ),
});

const instructions = z.strictObject({
  agentsMd: fact(
    z.enum(["native", "fallback", "setting", "unsupported"]),
    "How the provider reads a project's AGENTS.md: always, only when its own file is missing, only through a setting, or not at all.",
  ),
  nameSetting: fact(
    z
      .strictObject({
        key: text,
        set: text.describe("What to put in the setting."),
        honoredIn: z.array(text).min(1),
        since: text.nullable(),
      })
      .nullable(),
    "The setting that makes the provider read another file name. Null when there is none.",
  ),
  homeFolder: fact(
    z.strictObject({
      path: z.string().startsWith("~/"),
      env: text.nullable().describe("The environment variable that moves the folder, or null."),
    }),
    "The provider's home folder.",
  ),
  managed: fact(
    z.strictObject({ linux: text, macos: text, windows: text }).nullable(),
    "The instruction file an organization installs, per system. Null when there is none.",
  ),
  user: fact(nameRule, "Personal instruction files, relative to the home folder."),
  project: z.strictObject({
    walk: fact(
      z
        .strictObject({
          startsAt: z.enum(["startFolder", "projectRoot", "filesystemRoot"]),
          stopsAt: z.enum(["startFolder", "projectRoot", "filesystemRoot"]),
        })
        .refine((w) => (w.startsAt === "startFolder") !== (w.stopsAt === "startFolder"), {
          message: "Exactly one end of the walk must be startFolder.",
        }),
      "Where the search for project files starts and stops. startFolder is where the session runs.",
    ),
    root: fact(
      z
        .strictObject({
          markers: z.array(text).min(1),
          markerSetting: text.nullable(),
          withoutRoot: z.enum(["startFolderOnly"]),
        })
        .nullable(),
      "How the project root is found. Null when the search does not use one.",
    ),
    names: fact(nameRule, "File names read in each folder of the walk."),
    fallback: fact(
      z.discriminatedUnion("when", [
        z.strictObject({
          when: z.literal("noPrimaryFileOnTheWalk"),
          names: z.array(fileName).min(1),
        }),
        z.strictObject({
          when: z.literal("afterPrimaryNamesInEachFolder"),
          names: z.array(fileName).describe("The names tried by default. May be empty."),
          setting: text.nullable().describe("The setting that adds names."),
        }),
        z.strictObject({ when: z.literal("never") }),
      ]),
      "Other file names, and when they are read.",
    ),
  }),
  subdirectory: fact(
    z.discriminatedUnion("load", [
      z.strictObject({ load: z.literal("never") }),
      z.strictObject({
        load: z.literal("onDemand"),
        names: nameRule,
        triggers: z.array(trigger).min(1).describe("File actions that load a folder's files."),
        fallback: z
          .strictObject({
            names: z.array(fileName).min(1),
            triggers: z.array(trigger).min(1),
            blockedBy: z
              .array(fileName)
              .describe("The folder gets no fallback file when it has one of these."),
          })
          .nullable()
          .describe("Read only while the project fallback is also in effect."),
        foldersBetween: z
          .enum(["loaded", "notDocumented"])
          .describe("Folders between the start folder and the touched file's folder."),
      }),
    ]),
    "What happens in folders below the start folder.",
  ),
  sizeCaps: z.strictObject({
    user: sizeCap,
    project: sizeCap,
    subdirectory: sizeCap.nullable().describe("Null when folders below are never loaded."),
  }),
  precedence: fact(
    z.strictObject({
      order: z.array(z.enum(["managed", "user", "project"])).min(1),
      folderOrder: z.enum(["outermostFirst"]),
      onConflict: z.enum(["laterIsCloser", "notDefined"]),
    }),
    "The order files are joined in at the start, and what wins when two disagree. Nothing here replaces a file.",
  ),
  rules: fact(
    z
      .strictObject({
        folders: z.array(z.strictObject({ level, path: text })).min(1),
        pathScopeField: text.nullable(),
      })
      .nullable(),
    "Folders of extra rule files. The resolver does not list them yet.",
  ),
  imports: fact(
    z
      .strictObject({
        syntax: text,
        relativeTo: z.enum(["importingFile", "startFolder"]),
        maxDepth: z.int().positive(),
        outsideProject: z.enum(["asksOnce", "loads", "blocked"]),
      })
      .nullable(),
    "Whether one instruction file can import another. Null when it cannot.",
  ),
});

const launchSwitch = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("env"), name: text, value: z.string() }),
  z.strictObject({
    kind: z.literal("setting"),
    key: text,
    value: z.union([z.boolean(), z.string()]),
  }),
  z.strictObject({ kind: z.literal("argument"), args: z.array(text).min(1) }),
]);

const memory = z.strictObject({
  learns: fact(z.boolean(), "Whether the provider has a memory it writes from past work."),
  onByDefault: fact(z.boolean(), "Whether that memory is on without any setup."),
  writesByItself: fact(z.boolean(), "Whether it saves without asking the person."),
  location: fact(z.array(text).min(1), "Where the memory is stored."),
  offAtLaunch: fact(
    z.discriminatedUnion("possible", [
      z.strictObject({
        possible: z.literal(true),
        apply: z.array(launchSwitch).min(1).describe("Apply all of these."),
      }),
      z.strictObject({ possible: z.literal(false) }),
    ]),
    "How to switch the learned memory off when a session starts.",
  ),
});

export const commonEvents = [
  "sessionStart",
  "sessionEnd",
  "promptSubmit",
  "toolBefore",
  "toolAfter",
  "toolFailed",
  "permissionRequest",
  "notification",
  "stop",
  "interrupt",
  "subagentStart",
  "subagentStop",
  "compactBefore",
  "compactAfter",
  "modelRequestBefore",
  "modelRequestAfter",
] as const;
const commonEvent = z.enum(commonEvents);

const toolKind = z.enum([
  "shell",
  "patch",
  "fileWrite",
  "fileEdit",
  "fileRead",
  "fileSearch",
  "webFetch",
  "webSearch",
  "subagent",
]);

// The only code a profile can ask for. The hook adapter implements each name; a profile cannot add one.
const pathHelper = z.enum(["applyPatchPaths"]);

const cannotCarry = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("event"), name: commonEvent, why: text }),
  z.strictObject({ kind: z.literal("tool"), name: toolKind, why: text }),
  z.strictObject({
    kind: z.enum(["decision", "handler", "input", "output"]),
    name: text,
    why: text,
  }),
]);

const trustRules = z.array(z.enum(["folderForAllHooks", "folderForProjectHooks", "eachHook"]));

const inputField = text.optional();

const hooks = z.strictObject({
  model: fact(
    z.enum(["entries", "extension", "none"]),
    "Hook entries in a config file, a code extension, or no hooks.",
  ),
  configFiles: fact(
    z.array(z.strictObject({ level, path: text })).min(1),
    "The files hooks are declared in.",
  ),
  handlers: fact(
    z.strictObject({ runs: z.array(text).min(1), skips: z.array(text) }),
    "Handler types that run, and types that are accepted but skipped.",
  ),
  events: fact(
    z
      .array(
        z.strictObject({
          native: text.describe("The provider's event name."),
          common: commonEvent.nullable().describe("The shared name, or null when there is none."),
        }),
      )
      .min(1),
    "The normalization map for events.",
  ),
  tools: fact(
    z
      .array(
        z.strictObject({
          kind: toolKind,
          names: z.array(text).min(1).describe("Tool names a hook receives as input."),
          aliases: z.array(text).describe("Extra names a matcher also accepts."),
          paths: z
            .strictObject({
              field: text,
              helper: pathHelper.nullable().describe("Null when the field is already a path."),
            })
            .nullable()
            .describe("Where the touched file paths are, or null."),
        }),
      )
      .min(1),
    "The normalization map for tools. A kind that is absent here is not known.",
  ),
  mcpToolName: fact(
    text.includes("{server}").includes("{tool}"),
    "How an MCP tool is named in a hook, with {server} and {tool}.",
  ),
  inputFields: fact(
    z.strictObject({
      sessionId: inputField,
      turnId: inputField,
      cwd: inputField,
      eventName: inputField,
      permissionMode: inputField,
      prompt: inputField,
      toolName: inputField,
      toolInput: inputField,
      toolUseId: inputField,
      toolResult: inputField,
      shellCommand: inputField,
      filePath: inputField,
    }),
    "The normalization map for input fields: shared name to the provider's dotted path.",
  ),
  blocks: fact(
    z.strictObject({ exitCode: z.int().nullable(), decisions: z.array(text) }),
    "How a hook blocks an action.",
  ),
  ask: fact(
    z.enum(["supported", "unsupportedToolRuns", "unsupportedDenies"]),
    "Whether a hook before a tool can ask the person. unsupportedToolRuns means the tool runs anyway.",
  ),
  whenHookFails: fact(
    z.enum(["toolRuns", "toolBlocked"]),
    "The default when a hook before a tool crashes or times out.",
  ),
  contextLimit: fact(
    z.strictObject({
      amount: z.int().positive(),
      unit: z.enum(["characters", "tokens"]),
      setting: text.nullable(),
    }),
    "How much text a hook can hand to the model before it is cut or moved to a file.",
  ),
  trust: fact(
    z.strictObject({ interactive: trustRules, nonInteractive: trustRules }),
    "What the person must trust before hooks run. An empty list means no trust step. Managed hooks are not covered.",
  ),
  cannotCarry: fact(
    z.array(cannotCarry),
    "What a hook loses on this provider. With a known event map, every shared event is either mapped or listed here.",
  ),
  recordedInputs: fact(
    z
      .array(
        z.strictObject({
          event: text,
          tool: text.nullable(),
          input: z.record(z.string(), z.unknown()),
        }),
      )
      .min(1),
    "Hook inputs captured from a real run of the provider. Examples copied from documentation do not count.",
  ),
});

const location = z.strictObject({ level, path: text });

const skills = z.strictObject({
  locations: fact(z.array(location).min(1), "Skill folders."),
  entryFile: fact(fileName, "The file that makes a folder a skill."),
  sharedAgentsFolder: fact(z.boolean(), "Whether it reads the shared .agents/skills folder."),
});

const agents = z.strictObject({
  locations: fact(
    z.array(location.extend({ format: z.enum(["markdown", "toml", "json"]) })).min(1),
    "Folders of custom agent files.",
  ),
});

const mcp = z.strictObject({
  configs: fact(
    z
      .array(
        location.extend({
          key: text
            .optional()
            .describe(
              "The key or table that lists servers. Left out when the docs do not name it.",
            ),
        }),
      )
      .min(1),
    "Files that declare MCP servers.",
  ),
});

const loads = z.strictObject({
  atStart: z.array(text).describe("Files read when the session starts, in order."),
  onDemand: z.array(text).describe("Files read after the tree's file actions, in order."),
  undetermined: z.array(text).describe("Files the docs do not say are read or skipped."),
  unknownLevels: z
    .array(z.enum(instructionLevels))
    .describe("Levels the profile cannot answer for. This is different from reading nothing."),
});

export const providerProfileSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_-]*$/)
    .describe("The Hub's driver id for this provider."),
  name: text,
  sources: z.record(sourceId, source).describe("Every page and code location the facts cite."),
  instructions,
  memory,
  hooks,
  skills,
  agents,
  mcp,
  hubNotes: fact(
    z.strictObject({
      reachesTurn: z.boolean(),
      deliveredAs: z.enum(["quotedUserInput", "untrustedContext"]).nullable(),
    }),
    "Whether the Hub can add a note of its own to a turn on this provider.",
  ),
  conformance: z.strictObject({
    instructionLoads: z
      .strictObject({ mixed: loads, agentsOnly: loads })
      .describe(
        "What the provider's docs say it reads from each fixed file tree. Write it by hand from the docs.",
      ),
  }),
});

export type ProviderProfile = z.infer<typeof providerProfileSchema>;
export type InstructionLevel = (typeof instructionLevels)[number];
export type InstructionLoads = z.infer<typeof loads>;
