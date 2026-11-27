import appCss from "../index.css?inline";
import { minuteTick } from "@t3tools/client-runtime/clock";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  type BanneretBoardCard,
  type BanneretFeedState,
  type TaskLeaseResult,
  type TaskLeaseStatus,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { useProjects, useServerConfigs } from "../state/entities";
import { useConnectedEnvironmentIds } from "../state/environments";
import { storeEnrolmentView, useEnrolmentStore } from "./enrolmentStore";
import { LeaseConfirmHost, ReleaseDialogHost } from "./LeaseControls";
import { useLeaseMachineStore } from "./leaseMachineStore";
import {
  leaseRpc,
  openLeaseConfirm,
  openReleaseDialog,
  useLeaseStore,
  type LeaseCall,
} from "./leaseStore";
import { feedRpc, useRelayFeedStore } from "./relayFeedStore";
import { TaskPanel } from "./TaskPanel";
import { taskRpc } from "./taskStore";
import { taskSurface } from "./taskSurface";

vi.mock("../state/entities", { spy: true });
vi.mock("../state/environments", { spy: true });
vi.mock("../components/issue/IssueDetailPanel", () => ({
  IssueDetailPanel: () => <div data-testid="issue-thread" />,
}));

const LOCAL = EnvironmentId.make("local");
/** The relay the tests' tasks belong to, on this environment. */
const RELAY = { environmentId: LOCAL, relayOrigin: "https://relay.example.com" };
const ME = "ada-example";
const MINUTE = 60_000;
const minuteStart = () => Date.parse(`${minuteTick.getSnapshot()}:00.000Z`);
const ago = (ms: number) => new Date(minuteStart() - ms).toISOString();

const project = {
  id: ProjectId.make("example-app"),
  workspaceRoot: "/workspace/example-app",
  environmentId: LOCAL,
  repositoryIdentity: {
    provider: "github",
    displayName: "example-org/example-app",
    canonicalKey: "github.com/example-org/example-app",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/example-org/example-app.git",
    },
  },
} as unknown as EnvironmentProject;

const card = (extra: Partial<BanneretBoardCard> = {}): BanneretBoardCard => ({
  task: {
    id: "t_2",
    title: "Guild invites",
    ref: {
      tracker: "github",
      scope: "example-org/example-app",
      key: "2",
      url: "https://github.com/example-org/example-app/issues/2",
    },
    openedAt: "2026-11-20T09:00:00.000Z",
    closedAt: null,
  },
  column: "free",
  status: "planned",
  statusWhy: "Open and nobody has taken it yet.",
  prs: [],
  assignees: [],
  restsOn: [],
  ...extra,
});

const feed = (cards: BanneretBoardCard[], leases = true): BanneretFeedState => ({
  joined: true,
  live: true,
  since: "2026-11-26T09:59:00.000Z",
  sectionsKnown: true,
  sections: ["board", "map"],
  needsCount: null,
  revision: 1,
  board: {
    value: { state: "ok", notMeasured: [], columns: [], cards },
    fetchedAt: "2026-11-26T10:00:00.000Z",
    atWork: [],
    leases,
    checked: true,
  },
  map: {
    value: {
      state: "ok",
      notMeasured: [],
      stages: [{ id: "s_1", title: "Stage 1: Identity core", order: 1 }],
      items: [
        {
          id: "i_2",
          stageId: "s_1",
          title: "Guild invites",
          status: "planned",
          statusWhy: "Open.",
          task: card().task,
          restsOn: [],
          blockedBy: [],
        },
      ],
      counters: { byStatus: {}, byStage: {} },
    },
    fetchedAt: "2026-11-26T10:00:00.000Z",
    atWork: [],
    restsOn: true,
    checked: true,
  },
  feed: null,
  graveyard: null,
});

const NO_ACTIONS = { take: false, release: false, finish: false, withdraw: false };

const leaseStatus = (extra: Partial<TaskLeaseStatus> = {}): TaskLeaseStatus => ({
  availability: "available",
  viewer: ME,
  lease: null,
  lastRelease: null,
  actions: { ...NO_ACTIONS, take: true },
  busy: false,
  ...extra,
});

const heldByMe = leaseStatus({
  lease: { holder: ME, state: "active", since: ago(MINUTE), claimants: [ME] },
  actions: { ...NO_ACTIONS, release: true },
});

const ok = <A,>(value: A): LeaseCall<A> => ({ ok: true, value });

/** A call the test answers when it chooses. */
function deferred<A>() {
  let resolve: (value: LeaseCall<A>) => void = () => {};
  const promise = new Promise<LeaseCall<A>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A linked server: its relay person (null: not joined) and whether it has the task's repository. */
interface LinkedServer {
  readonly me: string | null;
  readonly hasRepo: boolean;
}

const SERVER = EnvironmentId.make("dev-server-env");
const serverProject = {
  ...project,
  id: ProjectId.make("example-app-on-server"),
  environmentId: SERVER,
} as unknown as EnvironmentProject;

function setup(options: { issues?: boolean; localRepo?: boolean; server?: LinkedServer } = {}) {
  useRelayFeedStore.setState({ feeds: {} });
  useEnrolmentStore.setState({ views: {} });
  useLeaseStore.setState({ entries: {} });
  useLeaseMachineStore.setState({ byRepo: {}, last: null });
  openReleaseDialog(null);
  openLeaseConfirm(null);
  storeEnrolmentView(LOCAL, {
    state: "configured",
    workspaceId: "ent-0123456789abcdef",
    relayOrigin: "https://relay.example.com",
    displayName: "Example Company",
    label: "desk",
    me: { login: ME, role: "staff" },
  });
  const issues = options.issues !== false;
  const server = options.server;
  if (server?.me != null) {
    storeEnrolmentView(SERVER, {
      state: "configured",
      workspaceId: "ent-0123456789abcdef",
      relayOrigin: "https://relay.example.com",
      displayName: "Example Company",
      label: "dev-server",
      me: { login: server.me, role: "staff" },
    });
  } else if (server !== undefined) {
    // It answered: no relay joined.
    useEnrolmentStore.setState((state) => ({ views: { ...state.views, [SERVER]: [] } }));
  }
  vi.mocked(useServerConfigs).mockReturnValue(
    new Map<EnvironmentId, unknown>([
      [LOCAL, { environment: { label: "Desktop", capabilities: { issues } } }],
      ...(server === undefined
        ? []
        : [
            [
              SERVER,
              { environment: { label: "dev-server", capabilities: { issues: true } } },
            ] as const,
          ]),
    ]) as unknown as ReturnType<typeof useServerConfigs>,
  );
  vi.mocked(useConnectedEnvironmentIds).mockReturnValue(
    server === undefined ? [LOCAL] : [LOCAL, SERVER],
  );
  vi.mocked(useProjects).mockReturnValue([
    ...(issues && options.localRepo !== false ? [project] : []),
    ...(server?.hasRepo === true ? [serverProject] : []),
  ]);
  const listeners = new Set<(event: BanneretFeedState) => void>();
  const nothing = { joined: true, value: null, fetchedAt: null };
  vi.spyOn(feedRpc, "today").mockResolvedValue(nothing);
  vi.spyOn(feedRpc, "needs").mockResolvedValue(nothing);
  vi.spyOn(feedRpc, "subscribe").mockImplementation((_id, listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  vi.spyOn(taskRpc, "read").mockResolvedValue(nothing);
  const rpc = {
    check: vi.spyOn(leaseRpc, "check"),
    take: vi.spyOn(leaseRpc, "take"),
    release: vi.spyOn(leaseRpc, "release"),
    finish: vi.spyOn(leaseRpc, "finish"),
    withdraw: vi.spyOn(leaseRpc, "withdraw"),
  };
  const emit = (event: BanneretFeedState) =>
    act(() => {
      for (const listener of listeners) listener(event);
    });
  return { emit, rpc };
}

async function openTask(shown: BanneretBoardCard) {
  await page.viewport(1280, 900);
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  const screen = await render(
    <>
      <TaskPanel surface={taskSurface(RELAY, shown.task)} threadRef={null} />
      <ReleaseDialogHost />
      <LeaseConfirmHost />
    </>,
  );
  return {
    [Symbol.asyncDispose]: async () => {
      await screen[Symbol.asyncDispose]();
      style.remove();
    },
  };
}

const button = (name: string) => page.getByRole("button", { name, exact: true });
const result = (
  outcome: TaskLeaseResult["outcome"],
  status: TaskLeaseStatus,
  detail?: string,
): LeaseCall<TaskLeaseResult> =>
  ok({ outcome, status, ...(detail === undefined ? {} : { detail }) });

describe("Take", () => {
  it("shows the read-back while the take confirms, then the task as taken by you", async () => {
    const { emit, rpc } = setup();
    rpc.check.mockResolvedValue(ok(leaseStatus()));
    const take = deferred<TaskLeaseResult>();
    rpc.take.mockReturnValue(take.promise);
    await using _task = await openTask(card());
    await emit(feed([card()]));

    await userEvent.click(button("Take on desk"));
    expect(rpc.check).toHaveBeenCalledWith(RELAY, expect.objectContaining({ key: "2" }));
    // The claim names the machine it was taken on.
    expect(rpc.take).toHaveBeenCalledWith(RELAY, expect.objectContaining({ key: "2" }), "desk");
    await expect
      .element(page.getByTestId("lease-progress"))
      .toHaveTextContent("Taking… confirming who claimed first.");
    expect(document.querySelector('[data-slot="read-back-bar"]')).not.toBeNull();
    await expect.element(button("Taking…")).toBeDisabled();

    await act(() => take.resolve(result("taken", heldByMe)));
    await expect.element(page.getByText("Taken by you.")).toBeVisible();
    await expect.element(button("Release…")).toBeVisible();
    expect(document.querySelector('[data-testid="lease-progress"]')).toBeNull();
    // The board's snapshot lags the take; the owner fact follows the tracker's answer.
    await expect.element(page.getByTestId("owner-from-tracker")).toBeVisible();
    expect(page.getByTestId("owner-from-tracker").element().textContent).toContain(ME);
  });

  it("names who claimed first when the take loses, with Withdraw only while the claim stands", async () => {
    const { emit, rpc } = setup();
    rpc.check.mockResolvedValue(ok(leaseStatus()));
    rpc.take.mockResolvedValueOnce(
      result(
        "lost",
        leaseStatus({
          lease: {
            holder: "bo-example",
            state: "active",
            since: ago(MINUTE),
            claimants: ["bo-example"],
          },
          actions: NO_ACTIONS,
        }),
        "bo-example took it first.",
      ),
    );
    await using _task = await openTask(card());
    await emit(feed([card()]));
    await userEvent.click(button("Take on desk"));
    await expect.element(page.getByText("bo-example took it first.")).toBeVisible();
    expect(document.querySelector('[data-testid="lease-buttons"] button')).toBeNull();
    expect(rpc.withdraw).not.toHaveBeenCalled();
  });

  it("offers Withdraw when the losing claim could not be withdrawn", async () => {
    const { emit, rpc } = setup();
    rpc.check.mockResolvedValue(ok(leaseStatus()));
    const conflict = leaseStatus({
      lease: {
        holder: "bo-example",
        state: "conflict",
        since: ago(MINUTE),
        claimants: ["bo-example", ME],
      },
      actions: { ...NO_ACTIONS, withdraw: true },
    });
    rpc.take.mockResolvedValue(
      result(
        "incomplete",
        conflict,
        "bo-example took it first. Withdrawing your claim failed: The tracker refused the change: The comment was refused.",
      ),
    );
    rpc.withdraw.mockResolvedValue(result("withdrawn", leaseStatus({ actions: NO_ACTIONS })));
    await using _task = await openTask(card());
    await emit(feed([card()]));
    await userEvent.click(button("Take on desk"));

    await expect
      .element(page.getByText("bo-example took it first. Withdraw your claim."))
      .toBeVisible();
    await userEvent.click(button("Withdraw"));
    expect(rpc.withdraw).toHaveBeenCalledWith(RELAY, expect.objectContaining({ key: "2" }));
    await expect.element(page.getByText("Your claim is withdrawn.")).toBeVisible();
  });

  it("shows why take and release are off, and a failed call in plain words", async () => {
    const { emit, rpc } = setup();
    rpc.check.mockResolvedValueOnce(
      ok(
        leaseStatus({
          availability: "no-permission",
          detail: "Needs triage access to example-org/example-app.",
          actions: NO_ACTIONS,
        }),
      ),
    );
    await using _task = await openTask(card());
    await emit(feed([card()]));
    await expect
      .element(page.getByText("Needs triage access to example-org/example-app."))
      .toBeVisible();
    expect(document.querySelector('[data-testid="lease-buttons"] button')).toBeNull();
  });

  it("says the rate limit stopped a take and reads the lease again", async () => {
    const { emit, rpc } = setup();
    rpc.check.mockResolvedValue(ok(leaseStatus()));
    rpc.take.mockResolvedValue({
      ok: false,
      message: "The tracker's rate limit is used up. Try again in a few minutes.",
    });
    await using _task = await openTask(card());
    await emit(feed([card()]));
    await userEvent.click(button("Take on desk"));
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("The tracker's rate limit is used up. Try again in a few minutes.");
    await vi.waitFor(() => expect(rpc.check).toHaveBeenCalledTimes(2));
    await expect.element(button("Take on desk")).toBeEnabled();
  });

  it("does not show an old failure again when the task is opened later", async () => {
    const { emit, rpc } = setup();
    rpc.check.mockResolvedValue(ok(leaseStatus()));
    rpc.take.mockResolvedValue({
      ok: false,
      message: "The tracker's rate limit is used up. Try again in a few minutes.",
    });
    {
      await using _task = await openTask(card());
      await emit(feed([card()]));
      await userEvent.click(button("Take on desk"));
      await expect.element(page.getByRole("alert")).toBeVisible();
    }
    await using _again = await openTask(card());
    await emit(feed([card()]));
    await vi.waitFor(() => expect(rpc.check).toHaveBeenCalledTimes(3));
    await expect.element(button("Take on desk")).toBeEnabled();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("asks nothing of the tracker without the leases flag or a local project", async () => {
    const off = setup();
    off.rpc.check.mockResolvedValue(ok(leaseStatus()));
    {
      await using _task = await openTask(card());
      await off.emit(feed([card()], false));
      await expect.element(page.getByRole("heading", { name: "Guild invites" })).toBeVisible();
      expect(off.rpc.check).not.toHaveBeenCalled();
      expect(document.querySelector('[data-testid="lease-buttons"]')).toBeNull();
    }
    const away = setup({ issues: false });
    away.rpc.check.mockResolvedValue(ok(leaseStatus()));
    await using _task = await openTask(card());
    await away.emit(feed([card()]));
    await expect
      .element(page.getByTestId("task-link-out"))
      .toHaveTextContent("No local project for example-appOpen on GitHub");
    expect(away.rpc.check).not.toHaveBeenCalled();
  });
});

describe("Release", () => {
  async function openRelease() {
    const harness = setup();
    harness.rpc.check.mockResolvedValue(ok(heldByMe));
    const shown = card({
      column: "taken",
      lease: {
        holder: { login: ME },
        state: "active",
        since: ago(MINUTE),
        lastSignalAt: ago(MINUTE),
        staleAt: ago(-6 * 60 * MINUTE),
        expiresAt: ago(-24 * 60 * MINUTE),
      },
    });
    const task = await openTask(shown);
    await harness.emit(feed([shown]));
    await userEvent.click(button("Release…"));
    await expect.element(page.getByRole("dialog", { name: "Release task" })).toBeVisible();
    return { ...harness, task };
  }

  const radio = (name: string) => page.getByRole("radio", { name });
  const toggle = () => page.getByRole("switch", { name: "Free to continue" });
  const release = () => button("Release");

  it("turns Free to continue on by default only for handing over, out of usage and blocked", async () => {
    const { task } = await openRelease();
    await using _task = task;
    await expect.element(release()).toBeDisabled();
    const defaults: Array<[string, boolean]> = [
      ["Done", false],
      ["Blocked", true],
      ["Handing over", true],
      ["Out of usage", true],
      ["Wrong approach", false],
      ["Duplicate", false],
      ["Deprioritised", false],
      ["Other", false],
    ];
    for (const [reason, on] of defaults) {
      await userEvent.click(radio(reason));
      await expect.element(toggle()).toHaveAttribute("aria-checked", String(on));
    }
    // A person can still change it.
    await userEvent.click(radio("Done"));
    await userEvent.click(toggle());
    await expect.element(toggle()).toHaveAttribute("aria-checked", "true");
  });

  it("caps Other's text at 200 characters and sends it with the reason", async () => {
    const { rpc, task } = await openRelease();
    await using _task = task;
    rpc.release.mockResolvedValue(result("released", leaseStatus()));
    await userEvent.click(radio("Other"));
    await expect.element(release()).toBeDisabled();
    await expect
      .element(page.getByTestId("release-problem"))
      .toHaveTextContent("Say why when the reason is Other.");
    const why = page.getByLabelText("Why");
    await userEvent.fill(why, "é".repeat(201));
    await expect
      .element(page.getByTestId("counter-characters"))
      .toHaveTextContent("201 / 200 characters");
    await expect.element(release()).toBeDisabled();
    await userEvent.fill(why, "not needed after the redesign");
    await expect.element(release()).toBeEnabled();
    await userEvent.click(release());
    expect(rpc.release).toHaveBeenCalledWith(
      RELAY,
      expect.objectContaining({
        key: "2",
        reason: "other",
        reasonText: "not needed after the redesign",
        freeToContinue: false,
      }),
    );
    expect(rpc.release.mock.calls[0]?.[1]).not.toHaveProperty("note");
    await expect
      .element(page.getByRole("dialog", { name: "Release task" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("Released.")).toBeVisible();
  });

  it("caps the note at 2 KB with a live counter and sends Goal, Done and Next as plain lines", async () => {
    const { rpc, task } = await openRelease();
    await using _task = task;
    rpc.release.mockResolvedValue(result("released", leaseStatus()));
    await userEvent.click(radio("Out of usage"));
    const goal = page.getByLabelText("Goal");
    await userEvent.fill(goal, "a".repeat(2050));
    await expect.element(page.getByTestId("counter-bytes")).toHaveTextContent("2056 / 2048 bytes");
    await expect.element(release()).toBeDisabled();
    await expect
      .element(page.getByTestId("release-problem"))
      .toHaveTextContent("The note is longer than 2048 bytes.");
    await userEvent.fill(goal, "Limit invites per guild.");
    await userEvent.fill(page.getByLabelText("Next"), "Return 429 from the invite route.");
    await expect.element(page.getByTestId("counter-bytes")).toHaveTextContent("70 / 2048 bytes");
    await userEvent.click(release());
    expect(rpc.release).toHaveBeenCalledWith(
      RELAY,
      expect.objectContaining({
        reason: "out_of_usage",
        freeToContinue: true,
        note: "Goal: Limit invites per guild.\nNext: Return 429 from the invite route.",
      }),
    );
  });

  it("keeps the dialog open with the reason when the release fails", async () => {
    const { rpc, task } = await openRelease();
    await using _task = task;
    rpc.release.mockResolvedValue({
      ok: false,
      message: "This device may not change tasks on this server. Ask its owner for operate access.",
    });
    await userEvent.click(radio("Done"));
    await userEvent.click(release());
    await expect
      .element(page.getByRole("dialog", { name: "Release task" }).getByRole("alert"))
      .toHaveTextContent(
        "This device may not change tasks on this server. Ask its owner for operate access.",
      );
  });
});

describe("Incomplete", () => {
  it("offers Finish and Withdraw for a take or release that stopped half way", async () => {
    const { emit, rpc } = setup();
    rpc.check.mockResolvedValue(
      ok(
        leaseStatus({
          lease: { holder: ME, state: "incomplete", since: ago(5 * MINUTE), claimants: [ME] },
          actions: { ...NO_ACTIONS, finish: true, withdraw: true },
        }),
      ),
    );
    rpc.finish.mockResolvedValue(result("taken", heldByMe));
    await using _task = await openTask(card());
    await emit(feed([card()]));
    await expect
      .element(
        page.getByText("Your last take or release stopped half way. Finish it, or Withdraw."),
      )
      .toBeVisible();
    await expect.element(button("Withdraw")).toBeVisible();
    await userEvent.click(button("Finish"));
    expect(rpc.finish).toHaveBeenCalledWith(RELAY, expect.objectContaining({ key: "2" }));
    await expect.element(page.getByText("Taken by you.")).toBeVisible();
    expect(rpc.withdraw).not.toHaveBeenCalled();
  });
});

describe("Task dialog facts", () => {
  it("shows the owner, stage and every pull request with its checks", async () => {
    const { emit, rpc } = setup();
    rpc.check.mockResolvedValue(ok(heldByMe));
    const shown = card({
      column: "taken",
      lease: {
        holder: { login: "bo-example" },
        state: "stale",
        since: ago(3 * 24 * 60 * MINUTE),
        lastSignalAt: ago(7 * 60 * MINUTE),
        staleAt: ago(MINUTE),
        expiresAt: ago(-17 * 60 * MINUTE),
      },
      prs: [
        { number: 57, url: "https://github.com/example-org/example-app/pull/57", state: "merged" },
        {
          number: 60,
          url: "https://github.com/example-org/example-app/pull/60",
          state: "open",
          checks: { state: "passing" },
        },
      ],
    });
    await using _task = await openTask(shown);
    await emit(feed([shown]));
    const panel = () => document.querySelector("[data-task-panel]")!;
    await vi.waitFor(() => expect(panel().textContent).toContain("Stage 1: Identity core"));
    const facts = [...panel().querySelectorAll("dt")].map((term) => term.textContent);
    // Every row stays, so each task's facts have the same shape; a missing one says so. Check is
    // left out only because this relay has no sign-off rule.
    expect(facts).toEqual([
      "Owner",
      "Opened",
      "Closed",
      "Pull requests",
      "Stage",
      "Preview",
      "Rests on",
      "Last release",
    ]);
    const empty = (label: string) =>
      [...panel().querySelectorAll("dt")]
        .find((term) => term.textContent === label)
        ?.nextElementSibling?.querySelector("[data-fact-empty]")?.textContent;
    expect(empty("Closed")).toBe("Still open");
    // The relay served no task read here, so it has not said whether there is a preview.
    expect(empty("Preview")).toBe("Not known");
    expect(empty("Rests on")).toBe("None");
    expect(panel().querySelector('[data-slot="lease-chip"]')?.textContent).toBe(
      "bo-examplequiet 7 h",
    );
    expect(panel().textContent).toContain("claimed 3 d ago");
    expect([...panel().querySelectorAll("[data-pr]")].map((pr) => pr.textContent)).toEqual([
      "#57 merged",
      "#60 openChecks passing",
    ]);
  });

  it("shows the last release: who, when, why and the note as plain text", async () => {
    const { emit, rpc } = setup();
    const lastRelease = {
      by: "bo-example",
      at: ago(2 * 60 * MINUTE),
      reason: "other",
      reasonText: "**moved** to <b>v2</b>",
      freeToContinue: true,
      note: "Goal: Limit invites.\nNext: Return 429.",
    };
    rpc.check.mockResolvedValue(ok(leaseStatus({ lastRelease })));
    const shown = card({
      lastRelease: { ...lastRelease, by: { login: "bo-example" } },
    });
    await using _task = await openTask(shown);
    await emit(feed([shown]));
    const release = page.getByTestId("task-last-release");
    await expect.element(release).toBeVisible();
    const text = release.element().textContent;
    expect(text).toContain("bo-example");
    expect(text).toContain("Other: **moved** to <b>v2</b>");
    expect(text).toContain("2 h ago");
    expect(text).toContain("Free to continue");
    expect(release.element().querySelector("b")).toBeNull();
    expect(page.getByTestId("task-last-release-note").element().textContent).toBe(
      "Goal: Limit invites.\nNext: Return 429.",
    );
    // The last holder left it free to continue, so Take reads Continue.
    await expect.element(button("Continue on desk")).toBeVisible();
  });
});

describe("Machines", () => {
  const ON_SERVER = { environmentId: SERVER, relayOrigin: RELAY.relayOrigin };

  it("offers Take when only a linked server has the repository, and runs it there", async () => {
    const { emit, rpc } = setup({ localRepo: false, server: { me: ME, hasRepo: true } });
    rpc.check.mockResolvedValue(ok(leaseStatus()));
    rpc.take.mockResolvedValue(result("taken", heldByMe));
    await using _task = await openTask(card());
    await emit(feed([card()]));

    await userEvent.click(button("Take on dev-server"));
    // One machine: no picker.
    expect(document.querySelector('[data-testid="lease-confirm-dialog"]')).toBeNull();
    const serverRef = expect.objectContaining({ projectId: serverProject.id, key: "2" });
    expect(rpc.check).toHaveBeenCalledWith(ON_SERVER, serverRef);
    expect(rpc.take).toHaveBeenCalledWith(ON_SERVER, serverRef, "dev-server");
    await expect.element(page.getByText("Taken by you.")).toBeVisible();

    // Release goes to the machine that took it, and says so.
    rpc.release.mockResolvedValue(result("released", leaseStatus()));
    await userEvent.click(button("Release…"));
    await expect
      .element(page.getByTestId("release-machine"))
      .toHaveTextContent("Releases on dev-server.");
    await userEvent.click(page.getByRole("radio", { name: "Done" }));
    await userEvent.click(button("Release"));
    expect(rpc.release).toHaveBeenCalledWith(
      ON_SERVER,
      expect.objectContaining({ reason: "done" }),
    );
  });

  it("asks which machine when two have the repository, and routes the take to the one picked", async () => {
    const { emit, rpc } = setup({ server: { me: ME, hasRepo: true } });
    rpc.check.mockResolvedValue(ok(leaseStatus()));
    rpc.take.mockResolvedValue(result("taken", heldByMe));
    await using _task = await openTask(card());
    await emit(feed([card()]));

    // The page's own machine is the default; the check runs there only.
    await vi.waitFor(() => expect(rpc.check).toHaveBeenCalledTimes(1));
    expect(rpc.check).toHaveBeenCalledWith(
      RELAY,
      expect.objectContaining({ projectId: project.id }),
    );
    await userEvent.click(button("Take…"));
    const dialog = page.getByTestId("lease-confirm-dialog");
    await expect.element(dialog).toBeVisible();
    await expect.element(page.getByRole("radio", { name: "desk" })).toBeChecked();
    expect(rpc.take).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("radio", { name: "dev-server" }));
    await userEvent.click(button("Take on dev-server"));
    expect(rpc.take).toHaveBeenCalledWith(
      ON_SERVER,
      expect.objectContaining({ projectId: serverProject.id }),
      "dev-server",
    );
    // The choice is remembered for the repository.
    expect(useLeaseMachineStore.getState().last).toBe(SERVER);
  });

  it("keeps the machine switch when the default machine cannot be reached", async () => {
    const { emit, rpc } = setup({ server: { me: ME, hasRepo: true } });
    rpc.check.mockImplementation(async (where) =>
      where.environmentId === LOCAL
        ? {
            ok: false,
            message: "The Hub server is not reachable. Check the task before trying again.",
          }
        : ok(leaseStatus()),
    );
    await using _task = await openTask(card());
    await emit(feed([card()]));
    await expect.element(page.getByRole("alert")).toBeVisible();
    await userEvent.click(page.getByTestId("lease-machine-switcher"));
    await userEvent.click(page.getByRole("menuitem", { name: "dev-server" }));
    await vi.waitFor(() =>
      expect(rpc.check).toHaveBeenLastCalledWith(
        ON_SERVER,
        expect.objectContaining({ projectId: serverProject.id }),
      ),
    );
    await expect.element(button("Take…")).toBeEnabled();
  });

  it("ignores a linked server that belongs to someone else", async () => {
    const { emit, rpc } = setup({
      localRepo: false,
      server: { me: "bo-example", hasRepo: true },
    });
    rpc.check.mockResolvedValue(ok(leaseStatus()));
    await using _task = await openTask(card());
    await emit(feed([card()]));
    // The link row says no project here has it; the other person's server adds nothing.
    await expect
      .element(page.getByTestId("task-link-out"))
      .toHaveTextContent("No local project for example-appOpen on GitHub");
    expect(rpc.check).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="lease-buttons"]')).toBeNull();
  });

  it("says a server with the repository has not joined the company, and writes nothing", async () => {
    const { emit, rpc } = setup({ localRepo: false, server: { me: null, hasRepo: true } });
    rpc.check.mockResolvedValue(ok(leaseStatus()));
    await using _task = await openTask(card());
    await emit(feed([card()]));
    await expect
      .element(page.getByTestId("lease-route-problem"))
      .toHaveTextContent("dev-server has the repository but has not joined Example Company.");
    expect(document.querySelector('[data-testid="lease-buttons"]')).toBeNull();
    for (const call of Object.values(rpc)) expect(call).not.toHaveBeenCalled();
  });
});
