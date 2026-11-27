// Banneret Hub: the agent toolkit (docs/banneret/agents.md). Offered only to threads whose project is in an
// Enterprise workspace this machine has joined, and only the tools that workspace's relay names in its
// capabilities `mcpTools`. Reads come from the relay; lease writes go through LeaseService on the machine's
// tracker login, exactly as the Board's Take and Release buttons do.
import {
  LEASE_RELEASE_REASONS,
  OrchestratorMcpFailure,
  TaskLeaseError,
  TaskLeaseResult,
  TaskLeaseStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];

const failure = Schema.Union([OrchestratorMcpFailure, TaskLeaseError]);

const TaskId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)).annotate({
  description: "The task id from banneret_board.",
});

const TaskInput = Schema.Struct({ taskId: TaskId });

const Problem = Schema.optional(
  Schema.String.annotate({
    description: "Why the relay could not answer; the data is the last good answer.",
  }),
);

const Release = Schema.Struct({
  by: Schema.String,
  at: Schema.String,
  reason: Schema.String,
  freeToContinue: Schema.Boolean,
  reasonText: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
});

const Card = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  url: Schema.String,
  repo: Schema.String,
  column: Schema.String,
  status: Schema.String,
  statusWhy: Schema.String,
  /** The lease holder's login and the lease state, when someone holds it. */
  holder: Schema.optional(Schema.String),
  leaseState: Schema.optional(Schema.String),
  assignees: Schema.Array(Schema.String),
  lastRelease: Schema.optional(Release),
  prs: Schema.Array(
    Schema.Struct({
      number: Schema.Number,
      url: Schema.String,
      state: Schema.String,
      checks: Schema.optional(Schema.String),
    }),
  ),
  restsOn: Schema.Array(Schema.String),
});

const Company = {
  company: Schema.String,
  /** The login the relay knows this machine's person as. */
  me: Schema.String,
  fetchedAt: Schema.NullOr(Schema.String),
  problem: Problem,
};

const reads = <T extends Tool.Any>(tool: T) =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients) as T;

const writes = <T extends Tool.Any>(tool: T) =>
  tool
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients) as T;

const BoardTool = reads(
  Tool.make("banneret_board", {
    description:
      "Your company's task boards, from the relay's last snapshot (no tracker calls). A company can have several boards; `boards` lists them. Pick one with board (its id), or leave it out for every board. Filter by column (free, taken, validating, stuck, shipped), mine (tasks your person holds or is assigned) or repo (owner/name). Lease rules: read banneret://join.",
    parameters: Schema.Struct({
      board: Schema.optional(
        Schema.String.annotate({ description: "A board id from `boards`. Default: every board." }),
      ),
      column: Schema.optional(
        Schema.String.annotate({ description: "A column id, such as free." }),
      ),
      mine: Schema.optional(Schema.Boolean),
      repo: Schema.optional(Schema.String.annotate({ description: "owner/name" })),
      limit: Schema.optional(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })).annotate({
          description: "At most this many cards (default 50).",
        }),
      ),
    }),
    success: Schema.Struct({
      ...Company,
      /** The relay parses the lease protocol, so take and release work here. */
      leases: Schema.Boolean,
      /** Every board the relay publishes, with its cards per column. */
      boards: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          title: Schema.String,
          mode: Schema.String,
          counts: Schema.Record(Schema.String, Schema.Number),
        }),
      ),
      total: Schema.Number,
      cards: Schema.Array(
        Schema.Struct({
          /** The id of the board the card is on (its first board when two boards show it). */
          board: Schema.String,
          ...Card.fields,
        }),
      ),
    }),
    failure,
    failureMode: "return",
    dependencies,
  }),
);

const NeedsTool = reads(
  Tool.make("banneret_needs", {
    description:
      "What waits on your person at the company, most urgent first. Pass nextCursor back for the next page.",
    parameters: Schema.Struct({ cursor: Schema.optional(Schema.String) }),
    success: Schema.Struct({
      ...Company,
      items: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          kind: Schema.String,
          title: Schema.String,
          recommendation: Schema.optional(Schema.String),
          from: Schema.optional(Schema.String),
          url: Schema.optional(Schema.String),
          createdAt: Schema.String,
        }),
      ),
      nextCursor: Schema.NullOr(Schema.String),
    }),
    failure,
    failureMode: "return",
    dependencies,
  }),
);

const TaskTool = reads(
  Tool.make("banneret_task", {
    description:
      "One board task: status, lease, pull requests, preview, sign-off and the last release note (Goal, Done, Next).",
    parameters: TaskInput,
    success: Schema.Struct({
      ...Company,
      task: Schema.Struct({
        ...Card.fields,
        preview: Schema.optional(
          Schema.Struct({ state: Schema.String, url: Schema.optional(Schema.String) }),
        ),
        checkedBy: Schema.optional(Schema.String),
      }),
    }),
    failure,
    failureMode: "return",
    dependencies,
  }),
);

const LeaseCheckTool = reads(
  Tool.make("banneret_lease_check", {
    description:
      "Who holds a task now, read from the tracker, and what you may do (take, release, finish, withdraw). Costs one GitHub REST call per lease comment on the issue: call it once before you take or release, never in a loop. banneret_board shows leases for free.",
    parameters: TaskInput,
    success: TaskLeaseStatus,
    failure,
    failureMode: "return",
    dependencies,
  }),
);

const LeaseTakeTool = writes(
  Tool.make("banneret_lease_take", {
    description:
      "Take a task before you edit for it. Writes a claim comment, assigns your person and adds the claimed label, then reads again after about 10 seconds: the earliest claim wins. Edit only when the outcome is taken. Call again to finish your take if it stopped half way.",
    parameters: TaskInput,
    success: TaskLeaseResult,
    failure,
    failureMode: "return",
    dependencies,
  }),
);

const LeaseReleaseTool = writes(
  Tool.make("banneret_lease_release", {
    description:
      "Release a task your person holds when you stop, for any reason, with a reason and a short note. Set freeToContinue so someone else picks it up, with Goal, Done and Next in the note; it defaults to true for blocked, handing_over and out_of_usage. Call again to finish a release that stopped half way.",
    parameters: Schema.Struct({
      taskId: TaskId,
      reason: Schema.Literals(LEASE_RELEASE_REASONS),
      reasonText: Schema.optional(
        Schema.String.annotate({
          description: "One line, at most 200 characters. Required for other.",
        }),
      ),
      note: Schema.optional(
        Schema.String.annotate({
          description:
            "Plain facts, at most 2 KB, such as **Goal:** ... **Done:** ... **Next:** ...",
        }),
      ),
      freeToContinue: Schema.optional(Schema.Boolean),
      followUps: Schema.optional(
        Schema.Array(Schema.String).annotate({
          description: "Issue keys of follow-up work, such as #51.",
        }),
      ),
    }),
    success: TaskLeaseResult,
    failure,
    failureMode: "return",
    dependencies,
  }),
);

const LeaseWithdrawTool = writes(
  Tool.make("banneret_lease_withdraw", {
    description:
      "Undo your person's own take that stopped half way, or a claim that lost to an earlier one. To stop work on a task you hold, use banneret_lease_release.",
    parameters: TaskInput,
    success: TaskLeaseResult,
    failure,
    failureMode: "return",
    dependencies,
  }),
);

export const AgentToolkit = Toolkit.make(
  BoardTool,
  NeedsTool,
  TaskTool,
  LeaseCheckTool,
  LeaseTakeTool,
  LeaseReleaseTool,
  LeaseWithdrawTool,
);
