import appCss from "../index.css?inline";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  type BanneretEnrolmentView,
  type BanneretFeedState,
  type BanneretFeedNeedsItem,
  type BanneretFeedNeedsRead,
  type BanneretFeedToday,
  type BanneretFeedTodayRead,
  type BanneretWorkspace,
} from "@t3tools/contracts";
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
import { useThreadShell } from "../state/entities";
import { useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { storeEnrolmentView, useEnrolmentStore } from "./enrolmentStore";
import { EnterpriseSidebarRows } from "./EnterpriseSidebarRows";
import { NeedsPage } from "./NeedsPage";
import { feedRpc, useRelayFeedStore } from "./relayFeedStore";
import { TodayPage } from "./TodayPage";
import { useWorkspacesStore } from "./workspacesStore";

vi.mock("../state/entities", { spy: true });
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

const item = (
  id: string,
  kind: string,
  title: string,
  extra: Partial<BanneretFeedNeedsItem> = {},
) => ({
  id,
  kind,
  title,
  createdAt: "2026-11-26T09:00:00.000Z",
  ...extra,
});

const NEEDS: ReadonlyArray<BanneretFeedNeedsItem> = [
  item("n1", "thread_question", "Should invites expire?", {
    recommendation: "After 7 days",
    deepLink: { environmentId: "local", threadId: "th_1", machineLabel: "Ada laptop" },
  }),
  item("n2", "thread_approval", "Run the migration", {
    deepLink: { environmentId: "env-bo", threadId: "th_9", machineLabel: "Bo desktop" },
  }),
  item("n3", "mention", "You were mentioned", {
    url: "https://github.com/example-org/app/issues/1",
  }),
  item("n4", "zz_new_kind", HOSTILE, { url: "javascript:window.__pwned=1" }),
];

const block = { state: "ok", items: [], notMeasured: [] };
const TODAY: BanneretFeedToday = {
  generatedAt: "2026-11-26T10:00:00.000Z",
  lastVisitAt: null,
  needsYou: { ...block, items: NEEDS, nextCursor: null },
  shipped: {
    state: "not_measured",
    items: [],
    notMeasured: [
      { source: "work_tracker", reason: "not_configured", since: "2026-11-26T08:00:00.000Z" },
    ],
  },
  working: block,
  stuck: {
    ...block,
    items: [
      {
        rules: ["check_failed", "unreviewed"],
        since: "2026-11-26T03:00:00.000Z",
        task: { title: "Profile blocks" },
      },
    ],
  },
  health: block,
};

const snapshot = (
  sections: string[],
  needsCount: number | null = null,
  revision = 1,
): BanneretFeedState => ({
  sectionsKnown: true,
  revision,
  joined: true,
  live: true,
  since: "2026-11-26T09:59:00.000Z",
  sections,
  needsCount,
  board: null,
  map: null,
  feed: null,
  graveyard: null,
});

function setup(
  options: { readonly enrolment?: BanneretEnrolmentView; readonly active?: string | null } = {},
) {
  useWorkspacesStore.setState({
    byEnvironment: {},
    local: [enterprise],
    activeId: options.active === undefined ? WORKSPACE_ID : options.active,
    dialog: null,
  });
  useEnrolmentStore.setState({ views: {} });
  useRelayFeedStore.setState({ feeds: {} });
  storeEnrolmentView(LOCAL, options.enrolment ?? configured);
  vi.mocked(usePrimaryEnvironmentId).mockReturnValue(LOCAL);
  vi.mocked(useEnvironment).mockImplementation((id) =>
    id === LOCAL ? ({ environmentId: LOCAL } as never) : null,
  );
  vi.mocked(useThreadShell).mockImplementation((ref) =>
    ref?.environmentId === LOCAL && ref.threadId === "th_1"
      ? ({ environmentId: LOCAL, id: ref.threadId } as EnvironmentThreadShell)
      : null,
  );
  const listeners = new Set<(event: BanneretFeedState) => void>();
  const server = {
    today: {
      joined: true,
      value: TODAY,
      fetchedAt: "2026-11-26T10:00:00.000Z",
    } as BanneretFeedTodayRead | null,
    needs: {
      joined: true,
      value: { items: NEEDS, nextCursor: null },
      fetchedAt: "2026-11-26T10:00:00.000Z",
    } as BanneretFeedNeedsRead | null,
  };
  const spies = {
    today: vi.spyOn(feedRpc, "today").mockImplementation(async () => server.today),
    needs: vi.spyOn(feedRpc, "needs").mockImplementation(async () => server.needs),
    subscribe: vi.spyOn(feedRpc, "subscribe").mockImplementation((_environmentId, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  const emit = (event: BanneretFeedState) =>
    act(() => {
      for (const listener of listeners) listener(event);
    });
  return { server, spies, emit, listeners };
}

function Shell() {
  return (
    <SidebarProvider>
      <nav aria-label="Sidebar">
        <EnterpriseSidebarRows />
      </nav>
      <Outlet />
    </SidebarProvider>
  );
}

function createFeedRouter(path = "/") {
  const root = createRootRoute({ component: Shell });
  const routes = [
    createRoute({ getParentRoute: () => root, path: "/", component: () => <p>Home</p> }),
    createRoute({ getParentRoute: () => root, path: "/today", component: TodayPage }),
    createRoute({ getParentRoute: () => root, path: "/needs", component: NeedsPage }),
    createRoute({
      getParentRoute: () => root,
      path: "/$environmentId/$threadId",
      component: () => <p>Thread page</p>,
    }),
  ];
  return createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
    disableGlobalCatchBoundary: true,
  });
}

async function prepareScreen(stack: DisposableStack) {
  await page.viewport(1280, 800);
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  stack.defer(() => style.remove());
}

const sidebar = () => page.getByRole("navigation", { name: "Sidebar" });

describe("Enterprise Today and Needs you", () => {
  it("shows the rows only for a configured Enterprise workspace, for sections the relay offers", async () => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    const { emit, spies } = setup({ active: null });
    const router = createFeedRouter();
    await using screen = await render(<RouterProvider router={router} />, { router: false });

    // Personal is active: no rows and no feed.
    await expect.element(page.getByText("Home")).toBeVisible();
    expect(sidebar().getByRole("button").elements()).toHaveLength(0);
    expect(spies.subscribe).not.toHaveBeenCalled();

    // The Enterprise workspace before this machine has finished joining: still nothing.
    await act(() => {
      storeEnrolmentView(LOCAL, { ...configured, state: "approved" });
      useWorkspacesStore.setState({ activeId: WORKSPACE_ID });
    });
    expect(sidebar().getByRole("button").elements()).toHaveLength(0);
    expect(spies.subscribe).not.toHaveBeenCalled();

    // Configured: the feed follows, and the relay offers only Today.
    await act(() => storeEnrolmentView(LOCAL, configured));
    await vi.waitFor(() => expect(spies.subscribe).toHaveBeenCalledTimes(1));
    await emit(snapshot(["today"]));
    await expect.element(sidebar().getByRole("button", { name: "Today" })).toBeVisible();
    expect(
      sidebar()
        .getByRole("button", { name: /Needs you/ })
        .elements(),
    ).toHaveLength(0);

    await emit(snapshot(["today", "needs"], 4));
    await expect.element(sidebar().getByRole("button", { name: /Needs you/ })).toBeVisible();
    await expect.element(screen.getByTestId("needs-count")).toHaveTextContent("4");

    // Back to Personal: rows go and the feed is let go.
    await act(() => useWorkspacesStore.setState({ activeId: null }));
    expect(sidebar().getByRole("button").elements()).toHaveLength(0);
  });

  it("counts Needs you from the relay, refetches on a change and keeps the relay's order", async () => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    const { emit, spies } = setup();
    const router = createFeedRouter();
    await using screen = await render(<RouterProvider router={router} />, { router: false });
    await vi.waitFor(() => expect(spies.subscribe).toHaveBeenCalled());
    await emit(snapshot(["today", "needs"]));

    // No needs.changed yet: the loaded page is the count.
    await expect.element(screen.getByTestId("needs-count")).toHaveTextContent("4");
    const needsCalls = spies.needs.mock.calls.length;
    await emit(snapshot(["today", "needs"], 7, 2));
    await expect.element(screen.getByTestId("needs-count")).toHaveTextContent("7");
    await vi.waitFor(() => expect(spies.needs.mock.calls.length).toBeGreaterThan(needsCalls));
    // A refetch is never a visit.
    expect(spies.today.mock.calls.every(([, visit]) => visit === false)).toBe(true);

    await userEvent.click(sidebar().getByRole("button", { name: /Needs you/ }));
    const list = page.getByRole("list", { name: "Needs you items" });
    await expect.element(list).toBeVisible();
    const rows = [...list.element().querySelectorAll("li")].map((row) => row.dataset.kind);
    expect(rows).toEqual(["thread_question", "thread_approval", "mention", "zz_new_kind"]);
  });

  it("renders an unknown kind generically and a hostile string as inert text", async () => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    const { emit } = setup();
    const router = createFeedRouter("/needs");
    await using _screen = await render(<RouterProvider router={router} />, { router: false });
    await emit(snapshot(["today", "needs"]));

    const hostile = page.getByText(HOSTILE, { exact: true });
    await expect.element(hostile).toBeVisible();
    const row = hostile.element().closest("li")!;
    expect(row.textContent).toContain("Item");
    // Neither the title nor the javascript: link became markup.
    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector("a")).toBeNull();
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined();

    // A known link out is a real link that opens elsewhere.
    const mention = page.getByText("You were mentioned").element().closest("li")!;
    const link = mention.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://github.com/example-org/app/issues/1");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("opens a known thread here, and names the machine for one elsewhere", async () => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    const { emit, spies } = setup();
    const router = createFeedRouter("/today");
    await using _screen = await render(<RouterProvider router={router} />, { router: false });
    await emit(snapshot(["today", "needs"]));

    // Opening Today is the one read that counts as a visit.
    await vi.waitFor(() => expect(spies.today).toHaveBeenCalledWith(LOCAL, true));
    expect(spies.today.mock.calls.filter(([, visit]) => visit).length).toBe(1);

    await expect.element(page.getByText("Should invites expire?")).toBeVisible();
    await expect.element(page.getByText("Recommended: After 7 days")).toBeVisible();
    await expect.element(page.getByText("on Bo desktop")).toBeVisible();
    // One row per stuck item, with every reason in the relay's order.
    await expect
      .element(page.getByText("Checks are failing \u00b7 Ready but not reviewed", { exact: false }))
      .toBeVisible();
    await expect
      .element(page.getByText("work_tracker: not measured since", { exact: false }))
      .toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Open thread" }));
    await expect.element(page.getByText("Thread page")).toBeVisible();
    expect(router.state.location.pathname).toBe("/local/th_1");
  });

  it("shows a shipped row's repo and pull request once, and names a stuck row's missing subject", async () => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    const { emit, server } = setup();
    const title = "feat(relay): stuck items carry ordered rules";
    server.today = {
      joined: true,
      fetchedAt: "2026-11-26T10:00:00.000Z",
      value: {
        ...TODAY,
        shipped: {
          ...block,
          items: [
            {
              // The task links its issue; the row names and links the item's own pull request.
              task: { title, url: "https://github.com/example-org/example-app/issues/12" },
              pr: {
                number: 38,
                url: "https://github.com/example-org/example-app/pull/38",
                repo: "example-org/example-app",
              },
              ref: {
                tracker: "github",
                scope: "example-org/example-app",
                key: "12",
                url: "https://github.com/example-org/example-app/issues/12",
              },
              summary: title,
              mergedAt: "2026-11-26T09:47:00.000Z",
              live: "no_deploy",
            },
          ],
        },
        stuck: {
          ...block,
          items: [
            { rules: ["checks_queued"], since: "2026-11-11T03:00:00.000Z" },
            {
              rules: ["claim_quiet"],
              since: "2026-11-26T03:00:00.000Z",
              task: { title: " ", url: "https://github.com/example-org/example-app/issues/12" },
            },
            {
              rules: ["dev_red"],
              since: "2026-11-26T08:00:00.000Z",
              subject: {
                repo: "example-org/example-app",
                run: {
                  name: "ci / test",
                  url: "https://github.com/example-org/example-app/actions/runs/9",
                },
              },
            },
            {
              rules: ["watched_job_down"],
              since: "2026-11-26T09:00:00.000Z",
              subject: {
                job: { name: "nightly-backup", url: "https://jobs.example.com/nightly-backup" },
              },
            },
          ],
        },
      },
    };
    const router = createFeedRouter("/today");
    await using _screen = await render(<RouterProvider router={router} />, { router: false });
    await emit(snapshot(["today", "needs"]));

    await expect.element(page.getByText(title)).toBeVisible();
    const shipped = page.getByText(title).element().closest("li")!;
    // The subtitle is repo · #PR · merged · age; the title is not repeated in it.
    expect(shipped.textContent?.split(title).length).toBe(2);
    expect(shipped.textContent).toContain("example-app \u00b7 #38 \u00b7 merged \u00b7 ");
    expect(shipped.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/example-org/example-app/pull/38",
    );

    // A stuck item with no task never renders without a subject.
    await expect
      .element(page.getByText("Checks are waiting to run: no task or pull request named"))
      .toBeVisible();
    // A task-less item with a subject shows "repo · run name", linked to the run.
    await expect.element(page.getByText("example-org/example-app \u00b7 ci / test")).toBeVisible();
    expect(
      page
        .getByText("example-org/example-app \u00b7 ci / test")
        .element()
        .closest("a")
        ?.getAttribute("href"),
    ).toBe("https://github.com/example-org/example-app/actions/runs/9");
    // A watched job with no repository shows the job name, linked.
    await expect.element(page.getByText("nightly-backup")).toBeVisible();
    expect(page.getByText("nightly-backup").element().closest("a")?.getAttribute("href")).toBe(
      "https://jobs.example.com/nightly-backup",
    );
    // A task with a blank title falls back to its number and repository.
    await expect
      .element(page.getByText("No activity on a claimed task: #12 in example-app"))
      .toBeVisible();
  });

  it("keeps showing the last-known data with its age when the relay is away", async () => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    const { emit, server } = setup();
    const router = createFeedRouter("/today");
    await using _screen = await render(<RouterProvider router={router} />, { router: false });
    await emit(snapshot(["today", "needs"]));
    await expect.element(page.getByText("Should invites expire?")).toBeVisible();

    // The server answers with its last good copy and why it could not ask the relay.
    server.today = {
      joined: true,
      value: TODAY,
      fetchedAt: "2026-11-26T10:00:00.000Z",
      problem: { message: "Cannot reach Example Company.", since: "2026-11-26T10:05:00.000Z" },
    };
    await emit(snapshot(["today", "needs"], null, 2));
    const statusText = () => document.querySelector('[role="status"]')?.textContent ?? "";
    await vi.waitFor(() => expect(statusText()).toContain("Cannot reach Example Company."));
    expect(statusText()).toContain("Showing what Example Company said");
    await expect.element(page.getByText("Should invites expire?")).toBeVisible();

    // This machine's own server cannot be reached either: the page still shows what it had.
    server.today = null;
    server.needs = null;
    await emit(snapshot(["today", "needs"], null, 3));
    await vi.waitFor(() =>
      expect(useRelayFeedStore.getState().feeds[LOCAL]?.unreachable).toBe(true),
    );
    expect(statusText()).toContain("Showing what Example Company said");
    await expect.element(page.getByText("Should invites expire?")).toBeVisible();
  });
});
