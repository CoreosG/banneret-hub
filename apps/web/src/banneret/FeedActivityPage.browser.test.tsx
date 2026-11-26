import appCss from "../index.css?inline";
import {
  EnvironmentId,
  type BanneretEnrolmentView,
  type BanneretFeedEntriesRead,
  type BanneretFeedEntry,
  type BanneretFeedEntryPageRead,
  type BanneretFeedState,
  type BanneretGraveyardEntry,
  type BanneretGraveyardPageRead,
  type BanneretGraveyardRead,
  type BanneretWorkspace,
} from "@t3tools/contracts";
import { minuteTick } from "@t3tools/client-runtime/clock";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { SidebarProvider } from "../components/ui/sidebar";
import { usePrimaryEnvironmentId } from "../state/environments";
import { storeEnrolmentView, useEnrolmentStore } from "./enrolmentStore";
import { EnterpriseSidebarRows } from "./EnterpriseSidebarRows";
import { FeedActivityPage } from "./FeedActivityPage";
import { feedRpc, useRelayFeedStore } from "./relayFeedStore";
import { TaskDialogHost } from "./TaskDialog";
import { openTaskDialog } from "./taskStore";
import { useWorkspacesStore } from "./workspacesStore";

vi.mock("../state/environments", { spy: true });

const LOCAL = EnvironmentId.make("local");
const WORKSPACE_ID = "ent-0123456789abcdef";
const HOSTILE = '<img src=x onerror="window.__pwned=1">';

const enterprise: BanneretWorkspace = {
  id: WORKSPACE_ID,
  name: "Example Company",
  kind: "enterprise",
  projectKeys: [],
  updatedAt: "2026-11-26T10:00:00.000Z",
  relay: { origin: "https://relay.example.com", displayName: "Example Company" },
};

const configured: BanneretEnrolmentView = {
  state: "configured",
  workspaceId: WORKSPACE_ID,
  relayOrigin: "https://relay.example.com",
  displayName: "Example Company",
  machineId: "m_1",
  label: "Ada laptop",
  me: { login: "ada-example", role: "founder" },
};

const task = (id: string, title: string) => ({
  id,
  title,
  ref: {
    tracker: "github",
    scope: "example-org/example-app",
    key: id,
    url: `https://github.com/example-org/example-app/issues/${id}`,
  },
});

// The page tells time from the start of the current minute; entries count back from there.
const at = (minutesAgo: number) =>
  new Date(Date.parse(`${minuteTick.getSnapshot()}:00.000Z`) - minutesAgo * 60_000).toISOString();

const entry = (
  id: string,
  minutesAgo: number,
  extra: Partial<BanneretFeedEntry> = {},
): BanneretFeedEntry => ({
  id,
  type: "built",
  at: at(minutesAgo),
  importance: "normal",
  summary: `Entry ${id}.`,
  ...extra,
});

const grave = (
  id: string,
  minutesAgo: number,
  extra: Partial<BanneretGraveyardEntry> = {},
): BanneretGraveyardEntry => ({
  task: task(id, `Dead task ${id}`),
  cause: "superseded by #12",
  ruledAt: at(minutesAgo),
  link: `https://github.com/example-org/example-app/issues/${id}`,
  ...extra,
});

const feedRead = (
  entries: BanneretFeedEntry[],
  nextCursor: string | null = null,
  extra: Partial<BanneretFeedEntriesRead> = {},
): BanneretFeedEntriesRead => ({
  value: { entries, nextCursor },
  fetchedAt: "2026-11-26T10:00:00.000Z",
  ...extra,
});

const graveyardRead = (
  entries: BanneretGraveyardEntry[],
  nextCursor: string | null = null,
): BanneretGraveyardRead => ({
  value: { entries, nextCursor },
  fetchedAt: "2026-11-26T10:00:00.000Z",
});

const state = (
  sections: string[],
  feed: BanneretFeedEntriesRead | null,
  graveyard: BanneretGraveyardRead | null = null,
): BanneretFeedState => ({
  joined: true,
  live: true,
  since: "2026-11-26T09:59:00.000Z",
  sectionsKnown: true,
  sections,
  needsCount: null,
  revision: 1,
  board: null,
  feed,
  graveyard,
});

function setup() {
  useWorkspacesStore.setState({
    byEnvironment: {},
    supported: new Set(),
    local: [enterprise],
    activeId: WORKSPACE_ID,
    dialog: null,
  });
  useEnrolmentStore.setState({ views: {} });
  useRelayFeedStore.setState({ feeds: {} });
  openTaskDialog(null);
  storeEnrolmentView(LOCAL, configured);
  vi.mocked(usePrimaryEnvironmentId).mockReturnValue(LOCAL);
  const listeners = new Set<(event: BanneretFeedState) => void>();
  const nothing = { joined: true, value: null, fetchedAt: null };
  vi.spyOn(feedRpc, "today").mockResolvedValue(nothing);
  vi.spyOn(feedRpc, "needs").mockResolvedValue(nothing);
  const feedPage = vi
    .spyOn(feedRpc, "feedPage")
    .mockResolvedValue(nothing satisfies BanneretFeedEntryPageRead);
  const graveyardPage = vi
    .spyOn(feedRpc, "graveyardPage")
    .mockResolvedValue(nothing satisfies BanneretGraveyardPageRead);
  const subscribe = vi.spyOn(feedRpc, "subscribe").mockImplementation((_id, listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const emit = (event: BanneretFeedState) =>
    act(() => {
      for (const listener of listeners) listener(event);
    });
  return { emit, subscribe, feedPage, graveyardPage };
}

function Shell() {
  return (
    <SidebarProvider>
      <nav aria-label="Sidebar">
        <EnterpriseSidebarRows />
      </nav>
      <Outlet />
      <TaskDialogHost />
    </SidebarProvider>
  );
}

function createFeedRouter(path: string) {
  const root = createRootRoute({ component: Shell });
  return createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/", component: () => <p>Home</p> }),
      createRoute({ getParentRoute: () => root, path: "/feed", component: FeedActivityPage }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
    disableGlobalCatchBoundary: true,
  });
}

async function openFeed(stack: DisposableStack, path = "/feed") {
  await page.viewport(1400, 900);
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  stack.defer(() => style.remove());
  const harness = setup();
  const router = createFeedRouter(path);
  const screen = await render(<RouterProvider router={router} />, { router: false });
  await vi.waitFor(() => expect(harness.subscribe).toHaveBeenCalled());
  return { ...harness, router, screen };
}

const sidebar = () => page.getByRole("navigation", { name: "Sidebar" });
const rowOf = (id: string) => document.querySelector(`[data-entry-id="${id}"]`);
const entryIds = () =>
  [...document.querySelectorAll("[data-entry-id]")].map(
    (element) => (element as HTMLElement).dataset.entryId,
  );

describe("Enterprise feed", () => {
  it("shows each entry's time, author, summary, status mark and link out", async () => {
    using stack = new DisposableStack();
    const { emit, router, screen } = await openFeed(stack, "/");
    await using _screen = screen;
    await emit(
      state(
        ["today", "feed"],
        feedRead([
          entry("e1", 1, {
            type: "pr_merged",
            importance: "high",
            author: { login: "bo-example" },
            summary: "Merged the rate limits change.",
            link: "https://github.com/example-org/example-app/pull/77",
            task: task("t1", "Rate limits"),
            status: "built",
          }),
          entry("e2", 2, { author: { login: "  " }, status: "needs_you", importance: "low" }),
          entry("e3", 3),
        ]),
      ),
    );

    await userEvent.click(sidebar().getByRole("button", { name: "Feed" }));
    expect(router.state.location.pathname).toBe("/feed");
    await expect.element(page.getByText("Merged the rate limits change.")).toBeVisible();

    const merged = rowOf("e1")!;
    expect(merged.textContent).toContain("PR merged · bo-example · ");
    expect(merged.querySelector("time")?.getAttribute("datetime")).toBe(at(1));
    const mark = merged.querySelector("[data-status]")!;
    expect(mark.textContent).toContain("◐");
    expect(mark.textContent).toContain("built, unchecked");
    expect(merged.getAttribute("data-importance")).toBe("high");
    expect(merged.className).toContain("border-primary");
    const open = [...merged.querySelectorAll("a")].find((link) => link.textContent === "Open")!;
    expect(open.getAttribute("href")).toBe("https://github.com/example-org/example-app/pull/77");
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
    // The task opens its Task tab; with no thread routed, in the Task dialog.
    const taskLink = merged.querySelector<HTMLElement>('[data-task-link="t1"]')!;
    expect(taskLink.textContent).toBe("Rate limits");
    expect(taskLink.tagName).toBe("BUTTON");
    await userEvent.click(taskLink);
    await expect
      .element(page.getByRole("dialog").getByRole("heading", { name: "Rate limits" }))
      .toBeVisible();
    expect(document.querySelector('[data-task-panel="t1"]')).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.querySelector("[data-task-panel]")).toBeNull());

    // An empty login leaves no name and no dangling separator; low importance only styles.
    const quiet = rowOf("e2")!;
    expect(quiet.textContent).toMatch(/^Built · /);
    expect(quiet.textContent).not.toContain("·  ·");
    expect(quiet.querySelector("[data-status]")?.textContent).toContain("needs you or blocked");
    expect(quiet.getAttribute("data-importance")).toBe("low");
    expect(rowOf("e3")!.querySelector("[data-status]")).toBeNull();
    expect(entryIds()).toEqual(["e1", "e2", "e3"]);
  });

  it("marks a checked entry with the checked mark", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openFeed(stack, "/feed");
    await using _screen = screen;
    await emit(
      state(
        ["today", "feed"],
        feedRead([entry("e1", 1, { type: "checked", status: "checked", summary: "Signed off." })]),
      ),
    );
    await expect.element(page.getByText("Signed off.")).toBeVisible();
    const mark = rowOf("e1")!.querySelector("[data-status]")!;
    expect(mark.textContent).toContain("●");
    expect(mark.textContent).toContain("checked");
  });

  it("renders an unknown type and importance generically", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openFeed(stack);
    await using _screen = screen;
    await emit(
      state(
        ["feed"],
        feedRead([
          entry("e1", 1, { type: "deploy_rolled_back", importance: "urgent", status: "on_fire" }),
        ]),
      ),
    );
    await expect.element(page.getByText("Entry e1.")).toBeVisible();
    const row = rowOf("e1")!;
    expect(row.getAttribute("data-type")).toBe("deploy_rolled_back");
    expect(row.textContent).toMatch(/^Activity · /);
    expect(row.getAttribute("data-importance")).toBe("normal");
    expect(row.querySelector("[data-status]")?.textContent).toContain("on fire");
  });

  it("merges duplicates and pages older entries with Load older", async () => {
    using stack = new DisposableStack();
    const { emit, feedPage, screen } = await openFeed(stack);
    await using _screen = screen;
    await emit(state(["feed"], feedRead([entry("e1", 1), entry("e2", 2), entry("e2", 2)], "c1")));
    await expect.element(page.getByText("Entry e1.")).toBeVisible();
    expect(entryIds()).toEqual(["e1", "e2"]);

    // The page shifted: e2 comes again, and must not show twice.
    feedPage.mockResolvedValueOnce({
      joined: true,
      value: { entries: [entry("e2", 2), entry("e3", 3)], nextCursor: "c2" },
      fetchedAt: "2026-11-26T10:00:00.000Z",
    });
    await userEvent.click(page.getByRole("button", { name: "Load older" }));
    await vi.waitFor(() => expect(entryIds()).toEqual(["e1", "e2", "e3"]));
    expect(feedPage).toHaveBeenLastCalledWith(LOCAL, "c1");

    feedPage.mockResolvedValueOnce({
      joined: true,
      value: { entries: [entry("e4", 4)], nextCursor: null },
      fetchedAt: "2026-11-26T10:00:00.000Z",
    });
    await userEvent.click(page.getByRole("button", { name: "Load older" }));
    await vi.waitFor(() => expect(entryIds()).toEqual(["e1", "e2", "e3", "e4"]));
    expect(feedPage).toHaveBeenLastCalledWith(LOCAL, "c2");
    expect(page.getByRole("button", { name: "Load older" }).elements()).toHaveLength(0);

    // A new snapshot file keeps the older pages and merges the overlap.
    await emit(state(["feed"], feedRead([entry("e0", 0), entry("e1", 1)], "c1")));
    await vi.waitFor(() => expect(entryIds()).toEqual(["e0", "e1", "e2", "e3", "e4"]));
  });

  it("shows the graveyard with each cause, ruling and link out, and pages it", async () => {
    using stack = new DisposableStack();
    const { emit, graveyardPage, screen } = await openFeed(stack);
    await using _screen = screen;
    await emit(
      state(
        ["feed"],
        feedRead([]),
        graveyardRead([grave("t1", 5, { by: { login: "ada-example" } }), grave("t2", 9)], "g1"),
      ),
    );
    await expect.element(page.getByText("No activity yet")).toBeVisible();
    await userEvent.click(page.getByRole("tab", { name: "Graveyard" }));
    await expect.element(page.getByText("Dead task t1")).toBeVisible();
    expect(
      page.getByRole("tab", { name: "Graveyard" }).element().getAttribute("aria-selected"),
    ).toBe("true");

    const first = document.querySelector('[data-task-id="t1"]')!;
    expect(first.querySelector('[data-testid="graveyard-cause"]')?.textContent).toBe(
      "Cause: superseded by #12",
    );
    expect(first.textContent).toContain("ruled dead");
    expect(first.textContent).toContain("by ada-example");
    expect(first.querySelector("time")?.getAttribute("datetime")).toBe(at(5));
    expect(first.querySelector('[data-task-link="t1"]')?.tagName).toBe("BUTTON");
    // No ruler: the ruling line ends at its time.
    expect(document.querySelector('[data-task-id="t2"]')?.textContent).not.toMatch(/ by \S+$/);

    graveyardPage.mockResolvedValueOnce({
      joined: true,
      value: { entries: [grave("t2", 9), grave("t3", 12)], nextCursor: null },
      fetchedAt: "2026-11-26T10:00:00.000Z",
    });
    await userEvent.click(page.getByRole("button", { name: "Load older" }));
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll("[data-task-id]")].map(
          (element) => (element as HTMLElement).dataset.taskId,
        ),
      ).toEqual(["t1", "t2", "t3"]),
    );
    expect(graveyardPage).toHaveBeenLastCalledWith(LOCAL, "g1");
    expect(page.getByRole("button", { name: "Load older" }).elements()).toHaveLength(0);

    await emit(state(["feed"], feedRead([]), graveyardRead([])));
    await expect.element(page.getByText("Nothing has been ruled dead")).toBeVisible();
  });

  it("gates the Feed row on the feed section and the Graveyard tab on its flag", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openFeed(stack);
    await using _screen = screen;

    await emit(state(["today"], null));
    await expect.element(sidebar().getByRole("button", { name: "Today" })).toBeVisible();
    expect(sidebar().getByRole("button", { name: "Feed" }).elements()).toHaveLength(0);
    await expect.element(page.getByText("Example Company does not offer a feed.")).toBeVisible();

    await emit(state(["today", "feed"], null));
    await expect.element(sidebar().getByRole("button", { name: "Feed" })).toBeVisible();
    await expect.element(page.getByText("Loading…")).toBeVisible();

    // The feed section without the graveyard flag: no tabs at all.
    await emit(state(["feed"], feedRead([entry("e1", 1)])));
    await expect.element(page.getByText("Entry e1.")).toBeVisible();
    expect(page.getByRole("tab").elements()).toHaveLength(0);

    await emit(state(["feed"], feedRead([entry("e1", 1)]), graveyardRead([])));
    await expect.element(page.getByRole("tab", { name: "Graveyard" })).toBeVisible();
    await userEvent.click(page.getByRole("tab", { name: "Graveyard" }));
    await expect.element(page.getByText("Nothing has been ruled dead")).toBeVisible();

    // The flag goes away while the Graveyard is open: back to the feed.
    await emit(state(["feed"], feedRead([entry("e1", 1)])));
    await expect.element(page.getByText("Entry e1.")).toBeVisible();
    expect(page.getByRole("tab").elements()).toHaveLength(0);
  });

  it("keeps the last-known feed with its age when the relay is away", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openFeed(stack);
    await using _screen = screen;
    await emit(
      state(
        ["feed"],
        feedRead([entry("e1", 1)], null, {
          problem: { message: "Cannot reach Example Company.", since: "2026-11-26T10:05:00.000Z" },
        }),
      ),
    );
    const statusText = () => document.querySelector('[role="status"]')?.textContent ?? "";
    await vi.waitFor(() => expect(statusText()).toContain("Cannot reach Example Company."));
    expect(statusText()).toContain("Showing what Example Company said");
    await expect.element(page.getByText("Entry e1.")).toBeVisible();
  });

  it("renders a hostile summary, cause and login as inert text and never links javascript:", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openFeed(stack);
    await using _screen = screen;
    const evilTask = {
      ...task("t9", HOSTILE),
      ref: { ...task("t9", HOSTILE).ref, url: "javascript:window.__pwned=1" },
    };
    await emit(
      state(
        ["feed"],
        feedRead([
          entry("e9", 1, {
            summary: HOSTILE,
            author: { login: HOSTILE },
            link: "javascript:window.__pwned=1",
            task: evilTask,
            type: HOSTILE,
            status: HOSTILE,
          }),
        ]),
        graveyardRead([
          grave("t9", 1, {
            task: evilTask,
            cause: HOSTILE,
            by: { login: HOSTILE },
            link: "javascript:window.__pwned=1",
          }),
        ]),
      ),
    );
    await expect.element(page.getByText(HOSTILE, { exact: true }).first()).toBeVisible();
    const row = rowOf("e9")!;
    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector("a")).toBeNull();
    expect(row.textContent).toContain(HOSTILE);

    await userEvent.click(page.getByRole("tab", { name: "Graveyard" }));
    await vi.waitFor(() => expect(document.querySelector('[data-task-id="t9"]')).not.toBeNull());
    const graveRow = document.querySelector('[data-task-id="t9"]')!;
    expect(graveRow.querySelector('[data-testid="graveyard-cause"]')?.textContent).toBe(
      `Cause: ${HOSTILE}`,
    );
    expect(graveRow.querySelector("img")).toBeNull();
    expect(graveRow.querySelector("a")).toBeNull();
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined();
  });
});
