// Banneret Hub: a task as a company's task source answers it (docs/banneret/plugins.md, "Tasks"). Only
// the fields the Hub uses are read; the rest is ignored, as the contract asks.
import { BanneretBoardTaskRef, type BanneretBoardTask } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { SourceSession } from "./sourceClient.ts";

const Person = Schema.Struct({ login: Schema.String });
const ProviderCard = Schema.Struct({
  task: Schema.Struct({ id: Schema.String, title: Schema.String, ref: BanneretBoardTaskRef }),
  lease: Schema.optional(
    Schema.Struct({
      holder: Person,
      state: Schema.String,
      since: Schema.optional(Schema.String),
    }),
  ),
  lastRelease: Schema.optional(
    Schema.Struct({
      by: Person,
      at: Schema.String,
      reason: Schema.String,
      freeToContinue: Schema.Boolean,
      reasonText: Schema.optional(Schema.String),
      note: Schema.optional(Schema.String),
    }),
  ),
});
export type ProviderCard = typeof ProviderCard.Type;
const decodeCard = Schema.decodeUnknownOption(ProviderCard);

const MAX_BOARDS = 50;

const field = (value: unknown, name: string): unknown =>
  (value as Readonly<Record<string, unknown>> | null | undefined)?.[name];
const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

/** `tasks_read`; undefined when the answer is not a task with that id. */
export const readTask = (session: SourceSession, taskId: string) =>
  session
    .call("tasks_read", { taskId })
    .pipe(
      Effect.map((answer) =>
        Option.getOrUndefined(Option.filter(decodeCard(answer), (card) => card.task.id === taskId)),
      ),
    );

type Ref = BanneretBoardTask["ref"];
const sameTask = (a: Ref, b: Ref) =>
  a.tracker === b.tracker &&
  (a.host ?? "") === (b.host ?? "") &&
  a.scope === b.scope &&
  a.key === b.key &&
  a.url === b.url;

/**
 * The source's own card for a task on the relay's board, read with the person's sign-in. The relay may
 * give a task an id of its own, so only an identical reference counts: first under the board's id, then
 * among the boards this person can list. Undefined when the source does not show it to this person.
 */
export const findTask = Effect.fn("BanneretSources.findTask")(function* (
  session: SourceSession,
  boardTaskId: string,
  ref: Ref,
) {
  const direct = yield* readTask(session, boardTaskId).pipe(
    Effect.catchIf(
      (error) => error.kind === "tool",
      () => Effect.undefined,
    ),
  );
  if (direct && sameTask(direct.task.ref, ref)) return direct;
  const boards = list(field(yield* session.call("tasks_list_boards", {}), "boards"));
  for (const board of boards.slice(0, MAX_BOARDS)) {
    const boardId = field(board, "id");
    if (typeof boardId !== "string") continue;
    const answer = yield* session.call("tasks_list_tasks", { boardId });
    for (const row of list(field(answer, "tasks"))) {
      const card = Option.getOrUndefined(decodeCard(row));
      if (card && sameTask(card.task.ref, ref)) return card;
    }
  }
  return undefined;
});
