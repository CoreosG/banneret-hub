import appCss from "../index.css?inline";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { minuteTick } from "@t3tools/client-runtime/clock";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type BanneretBoardCard,
  type BanneretEnrolmentView,
  type BanneretFeedState,
  type BanneretTask,
  type BanneretTaskRead,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import {
  migratePersistedRightPanelState,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { useProjects, useServerConfigs } from "../state/entities";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { storeEnrolmentView, useEnrolmentStore } from "./enrolmentStore";
import { feedRpc, useRelayFeedStore } from "./relayFeedStore";
import { TaskPanel } from "./TaskPanel";
import { taskRpc } from "./taskStore";
import { taskSurface } from "./taskSurface";
import { useOpenTask } from "./useOpenTask";

vi.mock("../state/entities", { spy: true });
// Upstream's issue panel needs a live tracker; the stub shows which issue the tab embedded.
vi.mock("../components/issue/IssueDetailPanel", () => ({
  IssueDetailPanel: (props: { reference: { tracker: string; scope: string; key: string } }) => (
    <div data-testid="issue-thread">
      {`${props.reference.tracker} ${props.reference.scope} ${props.reference.key}`}
    </div>
  ),
}));

const LOCAL = EnvironmentId.make("local");
const HOSTILE = '<img src=x onerror="window.__pwned=1">';
const MINUTE = 60_000;

const minuteStart = () => Date.parse(`${minuteTick.getSnapshot()}:00.000Z`);
const ago = (ms: number) => new Date(minuteStart() - ms).toISOString();

const founder: BanneretEnrolmentView = {
  state: "configured",
  workspaceId: "ent-0123456789abcdef",
  relayOrigin: "https://relay.example.com",
  displayName: "Example Company",
  me: { login: "ada-example", role: "founder" },
};

const ref = (key: string, tracker = "github") => ({
  tracker,
  scope: "example-org/example-app",
  key,
  url: `https://github.com/example-org/example-app/issues/${key}`,
});

const card = (key: string, title: string, extra: Partial<BanneretBoardCard> = {}) =>
  ({
    task: { id: `t_${key}`, title, ref: ref(key) },
    column: "taken",
    status: "needs_you",
    statusWhy: "Required checks are failing.",
    lease: {
      holder: { login: "bo-example" },
      state: "active",
      since: ago(60 * MINUTE),
      lastSignalAt: ago(12 * MINUTE),
      staleAt: ago(-6 * 60 * MINUTE),
      expiresAt: ago(-24 * 60 * MINUTE),
    },
    pr: { number: 77, url: "https://github.com/example-org/example-app/pull/77", state: "open" },
    checks: { state: "failing" },
    restsOn: [],
    ...extra,
  }) satisfies BanneretBoardCard;

const state = (sections: string[], cards: BanneretBoardCard[] | null): BanneretFeedState => ({
  joined: true,
  live: true,
  since: "2026-11-26T09:59:00.000Z",
  sectionsKnown: true,
  sections,
  needsCount: null,
  revision: 1,
  board:
    cards === null
      ? null
      : {
          value: { state: "ok", notMeasured: [], columns: [], cards },
          fetchedAt: "2026-11-26T10:00:00.000Z",
          atWork: [],
          leases: true,
          checked: true,
        },
  map: null,
  feed: null,
  graveyard: null,
});

const found = (task: BanneretTask): BanneretTaskRead => ({
  joined: true,
  value: task,
  fetchedAt: "2026-11-26T10:00:00.000Z",
});

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

function setup(options: { issues?: boolean; enrolment?: BanneretEnrolmentView } = {}) {
  useRelayFeedStore.setState({ feeds: {} });
  useEnrolmentStore.setState({ views: {} });
  storeEnrolmentView(LOCAL, options.enrolment ?? founder);
  vi.mocked(useServerConfigs).mockReturnValue(
    new Map([
      [LOCAL, { environment: { capabilities: { issues: options.issues === true } } }],
    ]) as unknown as ReturnType<typeof useServerConfigs>,
  );
  vi.mocked(useProjects).mockReturnValue(options.issues === true ? [project] : []);
  const listeners = new Set<(event: BanneretFeedState) => void>();
  const nothing = { joined: true, value: null, fetchedAt: null };
  vi.spyOn(feedRpc, "today").mockResolvedValue(nothing);
  vi.spyOn(feedRpc, "needs").mockResolvedValue(nothing);
  vi.spyOn(feedRpc, "subscribe").mockImplementation((_id, listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const read = vi.spyOn(taskRpc, "read");
  const emit = (event: BanneretFeedState) =>
    act(() => {
      for (const listener of listeners) listener(event);
    });
  return { emit, read };
}

async function openPanel(surface: unknown) {
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  const screen = await render(<TaskPanel surface={surface} threadRef={null} />);
  return {
    screen,
    [Symbol.asyncDispose]: async () => {
      await screen[Symbol.asyncDispose]();
      style.remove();
    },
  };
}

const header = () => document.querySelector('[data-testid="task-header"]') as HTMLElement;

describe("Task tab", () => {
  it("draws the header from the board card, with the preview and sign-off from the task read", async () => {
    const { emit, read } = setup();
    const shown = card("2", "Guild invites", { restsOn: ["t_1", "t_gone"] });
    read.mockResolvedValue(
      found({
        ...shown,
        preview: { state: "ready", url: "https://preview.example.com/t_2" },
        checked: { by: { login: "cy-example" }, at: "2026-11-26T09:30:00.000Z", valid: true },
      }),
    );
    await using _panel = await openPanel(taskSurface(LOCAL, shown.task));
    await emit(state(["board", "task"], [shown, card("1", "Rate limits")]));

    await expect.element(page.getByRole("heading", { name: "Guild invites" })).toBeVisible();
    await vi.waitFor(() => expect(header().textContent).toContain("Preview"));
    expect(read).toHaveBeenCalledWith(LOCAL, "t_2");
    const text = header().textContent!;
    expect(header().querySelector("[data-status]")?.textContent).toContain("needs you or blocked");
    expect(text).toContain("Required checks are failing.");
    expect(header().querySelector('[data-testid="lease-chip"]')?.textContent).toBe(
      "bo-example · active 12 min ago",
    );
    expect(text).toContain("PR #77 open · checks failing");
    const links = [...header().querySelectorAll("a")].map((link) => [
      link.textContent,
      link.getAttribute("href"),
    ]);
    expect(links).toContainEqual(["Open", "https://github.com/example-org/example-app/pull/77"]);
    expect(links).toContainEqual(["Open preview", "https://preview.example.com/t_2"]);
    expect(header().querySelector("[data-preview]")?.textContent).toBe("ready");
    // Rests on: the board's title where it holds the task, else the id.
    expect(header().querySelector('[data-rests-on="t_1"]')?.textContent).toContain("Rate limits");
    expect(header().querySelector('[data-rests-on="t_gone"]')?.textContent).toContain("t_gone");
    // A valid sign-off shows the checked mark with who; a founder needs no sign-off link then.
    const checked = header().querySelector('[data-checked="valid"]')!;
    expect(checked.textContent).toContain("●");
    expect(checked.textContent).toContain("Checked by cy-example");
    expect(checked.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-11-26T09:30:00.000Z",
    );
    expect(text).not.toContain("Sign off on");
  });

  it("draws the header from the task read when the board does not hold the task", async () => {
    const { emit, read } = setup();
    const relayTask = card("8", "Search", { statusWhy: "Open and nobody has taken it yet." });
    read.mockResolvedValue(found({ ...relayTask, status: "planned" }));
    await using _panel = await openPanel(taskSurface(LOCAL, relayTask.task));
    await emit(state(["task"], null));

    await vi.waitFor(() =>
      expect(header().textContent).toContain("Open and nobody has taken it yet."),
    );
    expect(header().querySelector("[data-status]")?.textContent).toContain("planned");
    expect(header().textContent).toContain("PR #77 open · checks failing");
  });

  it("says so when the relay does not know the task, keeping its title and link out", async () => {
    const { emit, read } = setup();
    read.mockResolvedValue({ joined: true, value: null, fetchedAt: null, notFound: true });
    await using _panel = await openPanel(taskSurface(LOCAL, card("9", "Gone").task));
    await emit(state(["task"], null));
    await expect
      .element(page.getByText("The relay does not know this task any more."))
      .toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Gone" })).toBeVisible();
    expect(document.querySelector('[data-testid="task-link-out"] a')?.getAttribute("href")).toBe(
      "https://github.com/example-org/example-app/issues/9",
    );
  });

  it("does not read a relay that does not offer the task section", async () => {
    const { emit, read } = setup();
    const shown = card("2", "Guild invites");
    await using _panel = await openPanel(taskSurface(LOCAL, shown.task));
    await emit(state(["board"], [shown]));
    await expect.element(page.getByRole("heading", { name: "Guild invites" })).toBeVisible();
    expect(header().textContent).toContain("Required checks are failing.");
    expect(read).not.toHaveBeenCalled();
  });

  it("shows an ignored sign-off with its reason, and gives founders a sign-off link", async () => {
    const { emit, read } = setup();
    const shown = card("3", "Profile blocks", { status: "built" });
    read.mockResolvedValue(
      found({
        ...shown,
        checked: {
          by: { login: "di-example" },
          at: "2026-11-26T09:30:00.000Z",
          valid: false,
          ignoredReason: "di-example does not hold the sign-off role.",
        },
      }),
    );
    await using _panel = await openPanel(taskSurface(LOCAL, shown.task));
    await emit(state(["board", "task"], [shown]));

    await vi.waitFor(() =>
      expect(header().querySelector('[data-checked="ignored"]')).not.toBeNull(),
    );
    const notice = header().querySelector('[data-checked="ignored"]')!;
    expect(notice.textContent).toContain(
      "di-example added the checked label, but it does not count.",
    );
    expect(notice.textContent).toContain("di-example does not hold the sign-off role.");
    expect(header().querySelector('[data-checked="valid"]')).toBeNull();
    expect(header().querySelector("[data-status]")?.textContent).toContain("built, unchecked");
    const signOff = [...header().querySelectorAll("a")].find(
      (link) => link.textContent === "Sign off on GitHub",
    );
    expect(signOff?.getAttribute("href")).toBe(
      "https://github.com/example-org/example-app/issues/3",
    );
    expect(signOff?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("gives staff no sign-off link", async () => {
    const { emit, read } = setup({
      enrolment: { ...founder, me: { login: "bo-example", role: "limited_staff" } },
    });
    const shown = card("3", "Profile blocks", { status: "built" });
    read.mockResolvedValue(found(shown));
    await using _panel = await openPanel(taskSurface(LOCAL, shown.task));
    await emit(state(["board", "task"], [shown]));
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    await expect.element(page.getByRole("heading", { name: "Profile blocks" })).toBeVisible();
    expect(header().textContent).not.toContain("Sign off on");
  });

  it("links out when no project here is on the task's tracker", async () => {
    const { emit } = setup({ issues: false });
    const shown = card("2", "Guild invites");
    await using _panel = await openPanel(taskSurface(LOCAL, shown.task));
    await emit(state(["board"], [shown]));
    const fallback = document.querySelector('[data-testid="task-link-out"]')!;
    expect(fallback).not.toBeNull();
    const link = fallback.querySelector("a")!;
    expect(link.textContent).toBe("Open on GitHub");
    expect(link.getAttribute("href")).toBe("https://github.com/example-org/example-app/issues/2");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(document.querySelector('[data-testid="issue-thread"]')).toBeNull();
  });

  it("links out for a tracker upstream does not support, even with issues on", async () => {
    const { emit } = setup({ issues: true });
    const odd = {
      id: "t_5",
      title: "Odd tracker",
      ref: {
        tracker: "youtrack",
        scope: "EX",
        key: "EX-5",
        url: "https://youtrack.example.com/issue/EX-5",
      },
    };
    await using _panel = await openPanel(taskSurface(LOCAL, odd));
    await emit(state([], null));
    const fallback = document.querySelector('[data-testid="task-link-out"]')!;
    expect(fallback.querySelector("a")?.textContent).toBe("Open on youtrack");
    expect(document.querySelector('[data-testid="task-thread-help"]')).toBeNull();
    expect(document.querySelector('[data-testid="issue-thread"]')).toBeNull();
  });

  it("embeds upstream's issue thread when a project here is on the task's repository", async () => {
    const { emit } = setup({ issues: true });
    const shown = card("2", "Guild invites");
    await using _panel = await openPanel(taskSurface(LOCAL, shown.task));
    await emit(state(["board"], [shown]));
    await expect
      .element(page.getByTestId("issue-thread"))
      .toHaveTextContent("github example-org/example-app 2");
    expect(document.querySelector('[data-testid="task-link-out"]')).toBeNull();
    expect(document.querySelector('[data-testid="task-thread-help"]')?.textContent).toBe(
      "Edits here are made on GitHub as you; the board's rules for claims and sign-off still apply.",
    );
  });

  it("renders a hostile title and reason as inert text and never links a javascript: url", async () => {
    const { emit, read } = setup();
    const evil = card("9", HOSTILE, { statusWhy: HOSTILE });
    const evilTask = {
      ...evil.task,
      ref: { ...evil.task.ref, url: "javascript:window.__pwned=1" },
    };
    read.mockResolvedValue(
      found({
        ...evil,
        task: evilTask,
        pr: { number: 1, url: "javascript:window.__pwned=1", state: "open" },
        preview: { state: HOSTILE, url: "javascript:window.__pwned=1" },
        checked: {
          by: { login: HOSTILE },
          at: "2026-11-26T09:30:00.000Z",
          valid: false,
          ignoredReason: HOSTILE,
        },
      }),
    );
    await using _panel = await openPanel(taskSurface(LOCAL, evilTask));
    await emit(state(["task"], null));
    await vi.waitFor(() =>
      expect(header().querySelector('[data-checked="ignored"]')).not.toBeNull(),
    );
    expect(header().querySelector("h2")?.textContent).toBe(HOSTILE);
    const panel = document.querySelector("[data-task-panel]")!;
    expect(panel.querySelector("img")).toBeNull();
    expect(panel.querySelector("a")).toBeNull();
    expect(panel.textContent).toContain(HOSTILE);
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  it("says so for a saved surface that is not a task", async () => {
    setup();
    await using _panel = await openPanel({ id: "task:x", kind: "task" });
    await expect.element(page.getByText("This task can no longer be shown.")).toBeVisible();
  });
});

describe("Task tab in a thread's right panel", () => {
  it("keeps a saved task tab when the app reloads", async () => {
    const surface = taskSurface(LOCAL, card("2", "Guild invites").task);
    const key = scopedThreadKey(scopeThreadRef(LOCAL, ThreadId.make("thread-1")));
    const saved = { isOpen: true, activeSurfaceId: surface.id, surfaces: [surface] };
    const storageKey = "t3code:right-panel-state:v2";
    const before = localStorage.getItem(storageKey);
    try {
      // Same version: the saved state loads as written.
      useRightPanelStore.setState({ byThreadKey: {} });
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          state: { byThreadKey: { [key]: saved }, threadPanelVisibilityByThreadKey: {} },
          version: useRightPanelStore.persist.getOptions().version,
        }),
      );
      await useRightPanelStore.persist.rehydrate();
      expect(useRightPanelStore.getState().byThreadKey[key]?.surfaces).toEqual([surface]);
    } finally {
      if (before === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, before);
      useRightPanelStore.setState({ byThreadKey: {} });
    }
    // An older version migrates, and the migration keeps only registered kinds.
    const migrated = migratePersistedRightPanelState({ byThreadKey: { [key]: saved } });
    expect(migrated.byThreadKey[key]?.surfaces).toEqual([surface]);
    expect(migrated.byThreadKey[key]?.activeSurfaceId).toBe(surface.id);
  });

  it("opens as a tab beside a routed thread", async () => {
    setup();
    useRightPanelStore.setState({ byThreadKey: {} });
    const task = card("2", "Guild invites").task;
    function Opener() {
      const open = useOpenTask(LOCAL);
      return (
        <button type="button" onClick={() => open(task)}>
          Open task
        </button>
      );
    }
    const root = createRootRoute();
    const router = createRouter({
      routeTree: root.addChildren([
        createRoute({
          getParentRoute: () => root,
          path: "/$environmentId/$threadId",
          component: Opener,
        }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/local/thread-1"] }),
      disableGlobalCatchBoundary: true,
    });
    await using _screen = await render(<RouterProvider router={router} />, { router: false });
    await userEvent.click(page.getByRole("button", { name: "Open task" }));
    const ref = scopeThreadRef(LOCAL, ThreadId.make("thread-1"));
    const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
    expect(panel.isOpen).toBe(true);
    expect(panel.surfaces).toEqual([taskSurface(LOCAL, task)]);
    expect(panel.activeSurfaceId).toBe(taskSurface(LOCAL, task).id);
  });
});
