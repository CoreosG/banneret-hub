import appCss from "../index.css?inline";
import {
  EnvironmentId,
  type BanneretBoard,
  type BanneretBoardCard,
  type BanneretEnrolmentView,
  type BanneretFeedBoardRead,
  type BanneretFeedState,
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
import { BoardPage } from "./BoardPage";
import { storeEnrolmentView, useEnrolmentStore } from "./enrolmentStore";
import { EnterpriseSidebarRows } from "./EnterpriseSidebarRows";
import { feedRpc, useRelayFeedStore } from "./relayFeedStore";
import { TaskDialogHost } from "./TaskDialog";
import { openTaskDialog } from "./taskStore";
import { useWorkspacesStore } from "./workspacesStore";

vi.mock("../state/environments", { spy: true });

const LOCAL = EnvironmentId.make("local");
const WORKSPACE_ID = "ent-0123456789abcdef";
const HOSTILE = '<img src=x onerror="window.__pwned=1">';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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

// The page tells time from the start of the current minute; lease ages count from there.
const minuteStart = () => Date.parse(`${minuteTick.getSnapshot()}:00.000Z`);
const ago = (ms: number) => new Date(minuteStart() - ms).toISOString();

const lease = (login: string, state: string, quietMs: number): BanneretBoardCard["lease"] => ({
  holder: { login },
  state,
  since: ago(quietMs + HOUR),
  lastSignalAt: ago(quietMs),
  staleAt: ago(quietMs - 6 * HOUR),
  expiresAt: ago(quietMs - 24 * HOUR),
});

const card = (
  id: string,
  title: string,
  column: string,
  extra: Partial<BanneretBoardCard> = {},
): BanneretBoardCard => ({
  task: {
    id,
    title,
    ref: {
      tracker: "github",
      scope: "example-org/example-app",
      key: id,
      url: `https://github.com/example-org/example-app/issues/${id}`,
    },
  },
  column,
  status: "planned",
  statusWhy: "Open and nobody has taken it yet.",
  restsOn: [],
  ...extra,
});

const COLUMNS = [
  { id: "free", title: "Free" },
  { id: "taken", title: "Taken" },
  { id: "validating", title: "Validating" },
  { id: "stuck", title: "Stuck" },
  { id: "shipped", title: "Shipped" },
];

const boardOf = (
  cards: BanneretBoardCard[],
  extra: Partial<BanneretBoard> = {},
): BanneretBoard => ({
  state: "ok",
  notMeasured: [],
  columns: COLUMNS,
  cards,
  ...extra,
});

const CARDS = (): BanneretBoardCard[] => [
  card("1", "Rate limits", "free"),
  card("2", "Guild invites", "taken", {
    lease: lease("bo-example", "active", 12 * MINUTE),
    status: "needs_you",
    statusWhy: "Required checks are failing.",
    pr: { number: 77, url: "https://github.com/example-org/example-app/pull/77", state: "open" },
    checks: { state: "failing" },
  }),
  card("3", "Profile blocks", "stuck", { lease: lease("cy-example", "stale", 7 * HOUR) }),
  card("4", "Search", "stuck", { lease: lease("di-example", "expired", 25 * HOUR) }),
  card("5", "Paused work", "taken", { lease: lease("ed-example", "paused", HOUR) }),
  card("6", "Contested", "stuck", {
    lease: lease("fi-example", "conflict", MINUTE),
    status: "needs_you",
    statusWhy: "Two people claim this task.",
  }),
  card("7", "Shipped work", "shipped", { status: "built" }),
];

const boardRead = (value: BanneretBoard | null, extra: Partial<BanneretFeedBoardRead> = {}) => ({
  value,
  fetchedAt: "2026-11-26T10:00:00.000Z",
  atWork: [],
  leases: true,
  ...extra,
});

const state = (sections: string[], board: BanneretFeedBoardRead | null): BanneretFeedState => ({
  joined: true,
  live: true,
  since: "2026-11-26T09:59:00.000Z",
  sectionsKnown: true,
  sections,
  needsCount: null,
  revision: 1,
  board,
  feed: null,
  graveyard: null,
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
  const subscribe = vi.spyOn(feedRpc, "subscribe").mockImplementation((_id, listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const emit = (event: BanneretFeedState) =>
    act(() => {
      for (const listener of listeners) listener(event);
    });
  return { emit, subscribe };
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

function createBoardRouter(path = "/board") {
  const root = createRootRoute({ component: Shell });
  return createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/", component: () => <p>Home</p> }),
      createRoute({ getParentRoute: () => root, path: "/board", component: BoardPage }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
    disableGlobalCatchBoundary: true,
  });
}

async function openBoard(stack: DisposableStack, path = "/board") {
  await page.viewport(1600, 900);
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  stack.defer(() => style.remove());
  const harness = setup();
  const router = createBoardRouter(path);
  const screen = await render(<RouterProvider router={router} />, { router: false });
  await vi.waitFor(() => expect(harness.subscribe).toHaveBeenCalled());
  return { ...harness, router, screen };
}

const sidebar = () => page.getByRole("navigation", { name: "Sidebar" });
const column = (name: string) => page.getByRole("region", { name });
const chipOf = (taskId: string) =>
  document.querySelector(`[data-task-id="${taskId}"] [data-testid="lease-chip"]`);

describe("Enterprise board", () => {
  it("draws the relay's five columns in order, each card opening its Task tab", async () => {
    using stack = new DisposableStack();
    const { emit, router, screen } = await openBoard(stack, "/");
    await using _screen = screen;
    await emit(state(["today", "board"], boardRead(boardOf(CARDS()))));

    await userEvent.click(sidebar().getByRole("button", { name: "Board" }));
    expect(router.state.location.pathname).toBe("/board");
    const titles = [...document.querySelectorAll("section[aria-label] h2")].map(
      (heading) => heading.firstElementChild?.textContent,
    );
    expect(titles).toEqual(["Free", "Taken", "Validating", "Stuck", "Shipped"]);
    await expect.element(column("Stuck").getByText("Profile blocks")).toBeVisible();
    await expect.element(column("Taken").getByText("Guild invites")).toBeVisible();
    expect(column("Validating").element().querySelectorAll("li")).toHaveLength(0);

    // The status mark shows its word and the relay's reason on hover; PR and checks show too.
    const invites = document.querySelector('[data-task-id="2"]')!;
    const mark = invites.querySelector("[data-status]")!;
    expect(mark.textContent).toContain("◆");
    expect(mark.textContent).toContain("needs you or blocked");
    await userEvent.hover(mark);
    await expect.element(page.getByText("Required checks are failing.")).toBeVisible();
    expect(invites.textContent).toContain("PR #77 open · checks failing");
    expect(invites.querySelector("a")).toBeNull();

    await expect.element(page.getByRole("list", { name: "Status legend" })).toBeVisible();

    // No thread is routed on the board, so the card opens the Task tab in its dialog.
    await userEvent.click(invites.querySelector("[data-open-task]")!);
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByRole("heading", { name: "Guild invites" })).toBeVisible();
    expect(document.querySelector('[data-task-panel="2"]')).not.toBeNull();
  });

  it("shows each lease state on its chip", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openBoard(stack);
    await using _screen = screen;
    await emit(state(["board"], boardRead(boardOf(CARDS()))));
    await expect.element(page.getByText("Guild invites")).toBeVisible();

    expect(chipOf("1")).toBeNull();
    expect(chipOf("2")?.textContent).toBe("bo-example · active 12 min ago");
    expect(chipOf("3")?.textContent).toBe("cy-example · quiet 7 h");
    expect(chipOf("3")?.className).toContain("warning");
    expect(chipOf("4")?.textContent).toBe("di-example · expired, should be released");
    expect(chipOf("4")?.className).toContain("destructive");
    expect(chipOf("5")?.textContent).toBe("ed-example · paused");
    expect(chipOf("6")?.textContent).toBe("fi-example · conflict, two people claim this");
    expect(chipOf("6")?.className).toContain("destructive");

    // Without the section's leases flag the chips stay off.
    await emit(state(["board"], boardRead(boardOf(CARDS()), { leases: false })));
    await vi.waitFor(() => expect(document.querySelector('[data-testid="lease-chip"]')).toBeNull());
  });

  it("rings a card whose task has a live agent session in the work file", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openBoard(stack);
    await using _screen = screen;
    await emit(state(["board"], boardRead(boardOf(CARDS()), { atWork: ["3"] })));
    await expect.element(page.getByText("Profile blocks")).toBeVisible();
    const ringed = [...document.querySelectorAll("[data-at-work]")].map(
      (element) => (element as HTMLElement).dataset.taskId,
    );
    expect(ringed).toEqual(["3"]);
    const ring = document.querySelector('[data-task-id="3"] [data-status] > span[aria-hidden]')!;
    expect(ring.className).toContain("ring-2");
    expect(document.querySelector('[data-task-id="3"]')?.textContent).toContain("agent at work");
  });

  it("has no row without the board section, and says so when the board is empty or partial", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openBoard(stack);
    await using _screen = screen;

    await emit(state(["today"], null));
    await expect.element(sidebar().getByRole("button", { name: "Today" })).toBeVisible();
    expect(sidebar().getByRole("button", { name: "Board" }).elements()).toHaveLength(0);
    await expect.element(page.getByText("Example Company does not offer a board.")).toBeVisible();

    await emit(state(["today", "board"], null));
    await expect.element(sidebar().getByRole("button", { name: "Board" })).toBeVisible();
    await expect.element(page.getByText("Loading…")).toBeVisible();

    await emit(state(["board"], boardRead(boardOf([]))));
    await expect.element(page.getByText("No tasks yet.")).toBeVisible();

    await emit(
      state(
        ["board"],
        boardRead(
          boardOf(CARDS(), {
            state: "partial",
            notMeasured: [
              { source: "claims", reason: "unreachable", since: "2026-11-26T09:00:00.000Z" },
            ],
          }),
        ),
      ),
    );
    await expect
      .element(page.getByText("Part of this board could not be read, so it may be incomplete."))
      .toBeVisible();
    await expect
      .element(page.getByText("claims: the source could not be reached", { exact: false }))
      .toBeVisible();

    // The relay is away: the last good board stays, with its age.
    await emit(
      state(
        ["board"],
        boardRead(boardOf(CARDS()), {
          problem: { message: "Cannot reach Example Company.", since: "2026-11-26T10:05:00.000Z" },
        }),
      ),
    );
    const statusText = () => document.querySelector('[role="status"]')?.textContent ?? "";
    await vi.waitFor(() => expect(statusText()).toContain("Cannot reach Example Company."));
    expect(statusText()).toContain("Showing what Example Company said");
    await expect.element(page.getByText("Guild invites")).toBeVisible();
  });

  it("renders a hostile title as inert text and never links a javascript: url", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openBoard(stack);
    await using _screen = screen;
    const hostile = card("9", HOSTILE, "free", { statusWhy: HOSTILE });
    const evil = {
      ...hostile,
      task: { ...hostile.task, ref: { ...hostile.task.ref, url: "javascript:window.__pwned=1" } },
      lease: lease(HOSTILE, "active", MINUTE),
    };
    await emit(state(["board"], boardRead(boardOf([evil]))));
    await expect.element(page.getByText(HOSTILE, { exact: true })).toBeVisible();
    const row = document.querySelector('[data-task-id="9"]')!;
    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector("a")).toBeNull();
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined();
  });
});
