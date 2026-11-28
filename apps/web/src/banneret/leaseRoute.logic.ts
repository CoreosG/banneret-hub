import {
  IssueTrackerKind,
  type BanneretEnrolmentView,
  type EnvironmentId,
  type TaskLeaseRef,
  type BanneretBoardTask,
} from "@t3tools/contracts";

/** One environment that may carry the lease call for a task, with its own reference to the issue. */
export interface LeaseMachine {
  readonly environmentId: EnvironmentId;
  /** The relay's label for the machine, else the environment's own name. */
  readonly label: string;
  /** The tracker address is the same on every machine. */
  readonly ref: Omit<TaskLeaseRef, "relayOrigin">;
}

/**
 * `none`, `not-joined` or `ready`, derived per task on every render. The table, the default machine and the
 * ownership rule are in docs/banneret/relay-v1/README.md, "Which machine writes". A machine is left out
 * only when provably someone else's; one that has not joined this relay is never written to.
 */
export type LeaseRoute =
  /** The page's machine has not answered with its enrolments yet: nothing is shown. */
  | { readonly kind: "loading" }
  | { readonly kind: "none"; readonly repo: string }
  | {
      readonly kind: "not-joined";
      /** Connected machines that have not joined, by label. */
      readonly machines: ReadonlyArray<string>;
      readonly company: string;
    }
  | {
      readonly kind: "ready";
      readonly machines: ReadonlyArray<LeaseMachine>;
      readonly chosen: LeaseMachine;
      /** The chosen machine is the one this window took the task on. */
      readonly held: boolean;
      /** The company source that owns tasks, by title. Unset: Banneret's own take and release. */
      readonly source?: string;
    };

export interface LeaseEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string | undefined;
  readonly issues: boolean;
  readonly enrolments: ReadonlyArray<BanneretEnrolmentView>;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The person each joined relay knows this environment as, by relay origin. */
const personByRelay = (enrolments: ReadonlyArray<BanneretEnrolmentView>) =>
  new Map(
    enrolments.flatMap((view) =>
      view.state === "configured" && view.me !== undefined
        ? [[view.relayOrigin, view.me.login] as const]
        : [],
    ),
  );

/** The claim's `<agent>`: the machine's label, made to fit `[A-Za-z0-9._-]{1,64}`. */
export function machineAgent(label: string): string {
  const slug = label
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug === "" ? "hub" : slug;
}

export interface LeaseRouteInput {
  /** The environment and relay the page reads the task through. */
  readonly page: { readonly environmentId: EnvironmentId; readonly relayOrigin: string };
  readonly taskRef: BanneretBoardTask["ref"];
  readonly environments: ReadonlyArray<LeaseEnvironment>;
  readonly heldOn: EnvironmentId | null;
  /** The person's explicit choice for this task in this window. */
  readonly preferred: ReadonlyArray<EnvironmentId>;
}

export function leaseRoute(input: LeaseRouteInput): LeaseRoute {
  const { page } = input;
  const pageEnvironment = input.environments.find(
    (environment) => environment.environmentId === page.environmentId,
  );
  if (pageEnvironment === undefined) return { kind: "loading" };
  const pagePeople = personByRelay(pageEnvironment.enrolments);
  const person = pagePeople.get(page.relayOrigin);
  const company =
    pageEnvironment.enrolments.find((view) => view.relayOrigin === page.relayOrigin)?.displayName ??
    hostOf(page.relayOrigin);
  const machines: LeaseMachine[] = [];
  const unjoined: string[] = [];
  for (const environment of input.environments) {
    if (!environment.issues) continue;
    if (input.taskRef.tracker !== "github") continue;
    const { tracker, host, scope, key } = input.taskRef;
    const ref = {
      tracker: IssueTrackerKind.make(tracker),
      ...(host === undefined ? {} : { host }),
      scope,
      key,
    };
    const people = personByRelay(environment.enrolments);
    const label =
      environment.enrolments.find((view) => view.relayOrigin === page.relayOrigin)?.label ??
      environment.label ??
      environment.environmentId;
    const here = people.get(page.relayOrigin);
    if (here !== undefined) {
      if (person !== undefined && same(here, person)) {
        machines.push({ environmentId: environment.environmentId, label, ref });
      }
      continue;
    }
    // Not joined here: left out when another relay both share names someone else.
    const someoneElse = [...people].some(([origin, login]) => {
      const mine = pagePeople.get(origin);
      return mine !== undefined && !same(mine, login);
    });
    if (!someoneElse) unjoined.push(label);
  }
  const first = machines.toSorted((a, b) => a.label.localeCompare(b.label));
  if (first.length === 0) {
    return unjoined.length === 0
      ? { kind: "none", repo: input.taskRef.scope }
      : { kind: "not-joined", machines: unjoined.toSorted((a, b) => a.localeCompare(b)), company };
  }
  const byId = (environmentId: EnvironmentId | null) =>
    environmentId === null
      ? undefined
      : first.find((machine) => machine.environmentId === environmentId);
  const held = byId(input.heldOn);
  const chosen =
    held ??
    input.preferred.map(byId).find((machine) => machine !== undefined) ??
    byId(page.environmentId) ??
    first[0]!;
  return { kind: "ready", machines: first, chosen, held: held !== undefined };
}

/**
 * When a company source owns tasks, take and release run on the page's own machine, with its sign-in to
 * that source. The server finds the task by the relay's id alone, so the rest of the reference only has
 * to be well formed.
 */
export function sourceRoute(input: {
  readonly page: LeaseRouteInput["page"];
  readonly taskId: string;
  readonly taskRef: BanneretBoardTask["ref"];
  readonly environments: ReadonlyArray<LeaseEnvironment>;
  readonly source: string;
}): LeaseRoute {
  const environment = input.environments.find(
    (one) => one.environmentId === input.page.environmentId,
  );
  if (environment === undefined) return { kind: "loading" };
  const view = environment.enrolments.find((one) => one.relayOrigin === input.page.relayOrigin);
  const machine: LeaseMachine = {
    environmentId: environment.environmentId,
    label: view?.label ?? environment.label ?? environment.environmentId,
    ref: {
      tracker: IssueTrackerKind.make("external"),
      scope: input.taskRef.scope.trim() || "-",
      key: input.taskRef.key.trim() || "-",
      taskId: input.taskId,
    },
  };
  return {
    kind: "ready",
    machines: [machine],
    chosen: machine,
    held: false,
    source: input.source,
  };
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** The key a choice of machine is remembered under: the task's repository. */
export const repoChoiceKey = (ref: { readonly tracker: string; readonly scope: string }) =>
  `${ref.tracker}:${ref.scope.toLowerCase()}`;

/** The words for a route that cannot run, or null when it can. */
export function routeProblem(route: LeaseRoute): string | null {
  switch (route.kind) {
    case "none":
      return `No joined machine can claim this task.`;
    case "not-joined":
      return `${namesList(route.machines)} ${route.machines.length === 1 ? "has" : "have"} not joined ${route.company}.`;
    case "loading":
    case "ready":
      return null;
  }
}

/** "a", "a and b", "a, b and c". */
function namesList(names: ReadonlyArray<string>): string {
  return names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
