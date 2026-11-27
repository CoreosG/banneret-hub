// Banneret Hub: which of this client's environments a task's take and release run on. The desktop is often
// only the cockpit and the code lives on a linked server, so any connected environment of the same person,
// joined to the same relay, with a project on the task's repository may carry the call; its server writes
// with its own tracker login and its own checks apply. Nothing here is stored; see `LeaseRoute`.
import { isStandaloneIssueLink, resolveIssueLinkTarget } from "@t3tools/client-runtime/issue-links";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { BanneretEnrolmentView, EnvironmentId, IssueRef } from "@t3tools/contracts";

/** One environment that may carry the lease call for a task, with its own reference to the issue. */
export interface LeaseMachine {
  readonly environmentId: EnvironmentId;
  /** The relay's label for the machine, else the environment's own name. */
  readonly label: string;
  /** Resolved through this environment's own project: a project id means nothing on another server. */
  readonly ref: IssueRef;
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
      /** Every machine that has the repository but has not joined, by label. */
      readonly machines: ReadonlyArray<string>;
      readonly company: string;
    }
  | {
      readonly kind: "ready";
      readonly machines: ReadonlyArray<LeaseMachine>;
      readonly chosen: LeaseMachine;
      /** The chosen machine is the one this window took the task on. */
      readonly held: boolean;
    };

export interface LeaseEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string | undefined;
  readonly issues: boolean;
  readonly projects: ReadonlyArray<EnvironmentProject>;
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

/**
 * The environment's reference to the issue, only through a project of its own on the issue's repository
 * (its own remote or an upstream it tracks). A project on another repository of the same host lends its
 * login for reading, but the server refuses to write through it.
 */
export function ownIssueRef(
  url: string,
  projects: ReadonlyArray<EnvironmentProject>,
): IssueRef | null {
  const target = resolveIssueLinkTarget({ url, projects });
  if (target === null) return null;
  const scope = target.ref.scope.toLowerCase();
  const owns = sourceControlClients
    .issueBindings(target.project.repositoryIdentity)
    .some(
      (binding) =>
        String(binding.tracker) === String(target.ref.tracker) &&
        (target.ref.host === undefined || binding.host === target.ref.host) &&
        binding.scope.toLowerCase() === scope,
    );
  return owns ? target.ref : null;
}

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
  readonly taskUrl: string;
  /** "example-org/example-app", for the message when no machine has it. */
  readonly repo: string;
  readonly environments: ReadonlyArray<LeaseEnvironment>;
  /** The page environment's own reference, which may come from a standalone tracker's bindings. */
  readonly pageRef: IssueRef | null;
  readonly heldOn: EnvironmentId | null;
  /** The person's last choice for this repository, then the last machine used for any. */
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
    const isPage = environment.environmentId === page.environmentId;
    // A standalone tracker's link resolves only through bindings the page already read; a git host's
    // link resolves from the projects alone.
    const ref = isStandaloneIssueLink(input.taskUrl)
      ? isPage
        ? input.pageRef
        : null
      : ownIssueRef(input.taskUrl, environment.projects);
    if (ref === null) continue;
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
      ? { kind: "none", repo: input.repo }
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
      return `Take needs a project on ${route.repo} on one of your machines.`;
    case "not-joined":
      return `${namesList(route.machines)} ${route.machines.length === 1 ? "has" : "have"} the repository but ${route.machines.length === 1 ? "has" : "have"} not joined ${route.company}.`;
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
