import appCss from "../index.css?inline";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  type BanneretBoard,
  type BanneretBoardCard,
  type BanneretEnrolmentView,
  type BanneretFeedBoardRead,
  type BanneretFeedState,
  type BanneretWorkspace,
  type TaskLeaseResult,
  type TaskLeaseStatus,
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
import { useProjects, useServerConfigs } from "../state/entities";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "../state/environments";
import { BoardPage } from "./BoardPage";
import { CompanySearchHost } from "./CompanySearch";
import { storeEnrolmentView, useEnrolmentStore } from "./enrolmentStore";
import { EnterpriseSidebarRows } from "./EnterpriseSidebarRows";
import { leaseRpc, useLeaseStore, type LeaseCall } from "./leaseStore";
import { feedRpc, useRelayFeedStore } from "./relayFeedStore";
import { TaskDialogHost } from "./TaskDialog";
import { openTaskDialog } from "./taskStore";
import { useWorkspacesStore } from "./workspacesStore";
import { rememberedBoard } from "./boardChoice";
import { boardEntry, singleBoard } from "./boards.testkit";
import { FILTER_MEMORY_KEY, rememberedFilters } from "./filterMemory";

vi.mock("../state/environments", { spy: true });
vi.mock("../state/entities", { spy: true });

const LOCAL = EnvironmentId.make("local");
const RELAY = { environmentId: LOCAL, relayOrigin: "https://relay.example.com" };
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
    openedAt: "2026-11-20T09:00:00.000Z",
    closedAt: null,
  },
  kind: "issue",
  column,
  status: "planned",
  statusWhy: "Open and nobody has taken it yet.",
  prs: [],
  assignees: [],
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
    prs: [
      { number: 76, url: "https://github.com/example-org/example-app/pull/76", state: "closed" },
      {
        number: 77,
        url: "https://github.com/example-org/example-app/pull/77",
        state: "open",
        checks: { state: "failing" },
      },
    ],
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
  value: value === null ? null : singleBoard(value),
  fetchedAt: "2026-11-26T10:00:00.000Z",
  atWork: [],
  leases: true,
  checked: true,
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
  map: null,
  feed: null,
  graveyard: null,
  team: null,
});

function setup() {
  useWorkspacesStore.setState({
    byEnvironment: {},
    local: [enterprise],
    activeId: WORKSPACE_ID,
    dialog: null,
  });
  useEnrolmentStore.setState({ views: {} });
  useRelayFeedStore.setState({ feeds: {} });
  sessionStorage.removeItem(FILTER_MEMORY_KEY);
  openTaskDialog(null);
  storeEnrolmentView(LOCAL, configured);
  vi.mocked(usePrimaryEnvironmentId).mockReturnValue(LOCAL);
  vi.mocked(useConnectedEnvironmentIds).mockReturnValue([LOCAL]);
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
      <CompanySearchHost />
    </SidebarProvider>
  );
}

function createBoardRouter(path = "/board") {
  const root = createRootRoute({ component: Shell });
  return createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/", component: () => <p>Home</p> }),
      createRoute({ getParentRoute: () => root, path: "/today", component: () => <p>Today</p> }),
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
const cardOf = (taskId: string) => document.querySelector(`[data-task-id="${taskId}"]`)!;
const chipOf = (taskId: string) =>
  document.querySelector<HTMLElement>(`[data-task-id="${taskId}"] [data-slot="lease-chip"]`);
const summaryText = () =>
  page.getByRole("heading", { level: 1 }).element().closest("header")?.querySelector("p")
    ?.textContent ?? "";
const legend = () => document.querySelector('[aria-label="Status legend"]')!;

describe("Enterprise board", () => {
  it("draws the relay's five columns in order, each card opening its Task tab", async () => {
    using stack = new DisposableStack();
    const { emit, router, screen } = await openBoard(stack, "/");
    await using _screen = screen;
    await emit(state(["today", "board"], boardRead(boardOf(CARDS()))));

    await userEvent.click(sidebar().getByRole("button", { name: "Board" }));
    expect(router.state.location.pathname).toBe("/board");
    await expect.element(page.getByRole("heading", { level: 1, name: "Board" })).toBeVisible();
    const titles = [...document.querySelectorAll("section[aria-label] h2")].map(
      (heading) => heading.textContent,
    );
    expect(titles).toEqual(["Free", "Taken", "Validating · 0", "Stuck", "Shipped"]);
    await expect.element(column("Stuck").getByText("Profile blocks")).toBeVisible();
    await expect.element(column("Taken").getByText("Guild invites")).toBeVisible();
    // An empty column is a header-only strip with a quiet hint on hover.
    const empty = column("Validating, no tasks");
    expect(empty.element().querySelectorAll("li")).toHaveLength(0);
    await userEvent.hover(empty);
    await expect.element(page.getByText("Nothing in Validating right now.")).toBeVisible();

    // The summary counts the known columns.
    expect(summaryText()).toBe("7 tasks. 1 free to take, 2 taken, 3 stuck, 1 shipped");

    // The pill says the status; the relay's reason is only its tooltip, never printed.
    const invites = cardOf("2");
    expect(invites.querySelector('[data-slot="status-pill"]')?.textContent).toBe("Needs you");
    expect(invites.textContent).not.toContain("Required checks are failing.");
    expect(invites.querySelector('[data-slot="task-ref"]')?.textContent).toBe("example-app#2");
    await userEvent.hover(invites.querySelector('[data-slot="status-pill"]')!);
    await expect.element(page.getByText("Required checks are failing.")).toBeVisible();
    // Linked PRs sum to one line with the worst check state of the open ones.
    expect(invites.querySelector("[data-pr]")?.textContent).toBe(
      "2 pull requests, 1 open·checks failing",
    );
    expect(invites.querySelector("[data-checks]")?.getAttribute("data-tone")).toBe("error");
    expect(invites.querySelector("a")).toBeNull();
    expect(cardOf("1").querySelector("[data-pr]")).toBeNull();

    // Only needs_you and sent_back cards carry the accent bar.
    const accented = [...document.querySelectorAll("[data-task-id]")]
      .filter((row) => row.querySelector('[data-slot="accent-bar"]') !== null)
      .map((row) => (row as HTMLElement).dataset.taskId);
    expect(accented).toEqual(["2", "6"]);

    // No thread is routed on the board, so the card opens the Task tab in its dialog.
    await userEvent.click(invites.querySelector('[data-slot="task-card"]')!);
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByRole("heading", { name: "Guild invites" })).toBeVisible();
    expect(document.querySelector('[data-task-panel="2"]')).not.toBeNull();
  });

  it("fits five columns of at least 180px without sideways scroll in a 1280px window with the sidebar open", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openBoard(stack);
    await using _screen = screen;
    // The main area of a 1280px window with the 256px sidebar open is 1024px wide.
    const nav = sidebar().element().getBoundingClientRect().width;
    await page.viewport(1024 + Math.ceil(nav), 800);
    await emit(state(["board"], boardRead(boardOf(CARDS()))));
    await expect.element(page.getByText("Guild invites")).toBeVisible();
    const grid = document.querySelector<HTMLElement>('[data-layout="board-columns"]')!;
    const widths = [...grid.children].map((child) => child.getBoundingClientRect().width);
    expect(widths).toHaveLength(5);
    // Validating is empty: a 40px strip, and the four others share its width.
    expect(widths[2]).toBe(40);
    for (const width of widths.toSpliced(2, 1)) expect(width).toBeGreaterThan(220);
    expect(grid.scrollWidth).toBeLessThanOrEqual(grid.clientWidth);

    // A long column scrolls on its own; the grid and the other columns stay put.
    const many = Array.from({ length: 20 }, (_, index) =>
      card(`s${index}`, `Stuck task ${index}`, "stuck"),
    );
    await emit(state(["board"], boardRead(boardOf([...CARDS(), ...many]))));
    await expect.element(page.getByText("Stuck task 19")).toBeInTheDocument();
    const list = column("Stuck").element().querySelector("ul")!;
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    expect(grid.scrollHeight).toBeLessThanOrEqual(grid.clientHeight);
    expect(column("Free").element().getBoundingClientRect().height).toBe(
      column("Stuck").element().getBoundingClientRect().height,
    );
  });

  it("shows each lease state on its chip", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openBoard(stack);
    await using _screen = screen;
    await emit(state(["board"], boardRead(boardOf(CARDS()))));
    await expect.element(page.getByText("Guild invites")).toBeVisible();

    const tone = (taskId: string) => chipOf(taskId)?.getAttribute("data-tone");
    expect(chipOf("1")).toBeNull();
    expect(chipOf("2")?.textContent).toBe("bo-exampleactive 12 min ago");
    expect(chipOf("3")?.textContent).toBe("cy-examplequiet 7 h");
    expect(tone("3")).toBe("warn");
    expect(chipOf("4")?.textContent).toBe("di-exampleexpired, should be released");
    expect(tone("4")).toBe("error");
    expect(chipOf("5")?.textContent).toBe("ed-examplepaused");
    expect(chipOf("6")?.textContent).toBe("fi-exampleconflict, two people claim this");
    expect(tone("6")).toBe("error");

    // Without the section's leases flag the chips stay off.
    await emit(state(["board"], boardRead(boardOf(CARDS()), { leases: false })));
    await vi.waitFor(() => expect(document.querySelector('[data-slot="lease-chip"]')).toBeNull());
  });

  it("counts statuses in the legend, dims zeros, and lists Checked only when the board flags it", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openBoard(stack);
    await using _screen = screen;
    const cards = () => [
      ...CARDS(),
      card("8", "Signed off", "shipped", { status: "checked", statusWhy: "Checked after merge." }),
    ];
    const chip = (status: string) =>
      legend().querySelector<HTMLElement>(`[data-status="${status}"]`);

    await emit(state(["board"], boardRead(boardOf(cards()))));
    await expect.element(page.getByText("Signed off")).toBeVisible();
    expect(cardOf("8").querySelector('[data-slot="status-pill"]')?.textContent).toBe("Checked");
    // The card carries no who and when, and a built card carries no notice about a rejected check.
    expect(cardOf("8").querySelector("time")).toBeNull();
    expect(cardOf("7").textContent).toContain("Built, needs a check");
    expect(cardOf("7").textContent).not.toContain("does not count");

    expect(chip("planned")?.querySelector("[data-count]")?.textContent).toBe("4");
    expect(chip("needs_you")?.querySelector("[data-count]")?.textContent).toBe("2");
    expect(chip("checked")?.querySelector("[data-count]")?.textContent).toBe("1");
    expect(chip("ruled_dead")?.className).toContain("opacity-60");
    expect(chip("planned")?.className).not.toContain("opacity-60");
    // Blocked shows only once a card is blocked.
    expect(chip("blocked")).toBeNull();

    await emit(
      state(
        ["board"],
        boardRead(boardOf([...cards(), card("9", "Waits", "stuck", { status: "blocked" })]), {
          checked: false,
        }),
      ),
    );
    await vi.waitFor(() => expect(chip("checked")).toBeNull());
    expect(chip("blocked")?.querySelector("[data-count]")?.textContent).toBe("1");
    expect(chip("built")).not.toBeNull();
  });

  it("rings a card whose task has a live agent session in the work file", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openBoard(stack);
    await using _screen = screen;
    await emit(state(["board"], boardRead(boardOf(CARDS()), { atWork: ["3", "gone"] })));
    await expect.element(page.getByText("Profile blocks")).toBeVisible();
    const ringed = [...document.querySelectorAll("[data-at-work]")].map(
      (element) => (element as HTMLElement).dataset.taskId,
    );
    expect(ringed).toEqual(["3"]);
    const pill = cardOf("3").querySelector<HTMLElement>('[data-slot="status-pill"]')!;
    expect(pill.className).toContain("ring-2");
    expect(pill.textContent).toContain("agent at work");
    expect(cardOf("1").querySelector('[data-slot="status-pill"]')?.className).not.toContain(
      "ring-2",
    );
    // The legend counts only cards on the board.
    expect(legend().querySelector('[data-slot="legend-at-work"] [data-count]')?.textContent).toBe(
      "1",
    );
  });

  it("filters to the tasks this person holds or is assigned with Mine, and back", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openBoard(stack);
    await using _screen = screen;
    const cards = () => [
      ...CARDS(),
      card("8", "My work", "taken", { lease: lease("Ada-Example", "active", MINUTE) }),
      card("9", "Assigned to me", "taken", { assignees: [{ login: "ADA-example" }] }),
    ];
    await emit(state(["board"], boardRead(boardOf(cards()))));
    await expect.element(page.getByText("My work")).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Mine" }));
    await vi.waitFor(() => expect(document.querySelectorAll("[data-task-id]")).toHaveLength(2));
    expect(cardOf("8")).not.toBeNull();
    expect(cardOf("9")).not.toBeNull();
    expect(summaryText()).toBe("2 assigned to you · 0 leases expired");
    expect(legend().querySelector('[data-status="planned"] [data-count]')?.textContent).toBe("2");

    // Without leases there is nothing to filter by, so the toggle goes and everyone shows.
    await emit(state(["board"], boardRead(boardOf(cards()), { leases: false })));
    await vi.waitFor(() => expect(document.querySelectorAll("[data-task-id]")).toHaveLength(9));
    expect(page.getByRole("button", { name: "Mine" }).elements()).toHaveLength(0);

    await emit(state(["board"], boardRead(boardOf(CARDS()))));
    await userEvent.click(page.getByRole("button", { name: "Mine" }));
    await expect.element(page.getByText("Nothing of yours here.")).toBeVisible();
    expect(summaryText()).toBe("0 assigned to you · 0 leases expired");
    await userEvent.click(page.getByRole("button", { name: "Everyone" }));
    await vi.waitFor(() => expect(document.querySelectorAll("[data-task-id]")).toHaveLength(7));
  });

  it("shows a card assigned without a claim in Taken, as assigned and not claimed", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openBoard(stack);
    await using _screen = screen;
    await emit(
      state(
        ["board"],
        boardRead(
          boardOf([
            card("1", "Assigned elsewhere", "taken", {
              assignees: [{ login: "bo-example" }, { login: "cy-example" }],
            }),
            card("2", "Claimed", "taken", {
              lease: lease("bo-example", "active", MINUTE),
              assignees: [{ login: "bo-example" }],
            }),
          ]),
        ),
      ),
    );
    await expect.element(column("Taken").getByText("Assigned elsewhere")).toBeVisible();
    const chip = cardOf("1").querySelector('[data-testid="assigned-not-claimed"]');
    expect(chip?.textContent).toBe("assigned · not claimed · bo-example, cy-example");
    expect(chip?.getAttribute("data-tone")).toBe("muted");
    expect(chipOf("1")).toBeNull();
    // A claimed card shows its lease chip only.
    expect(cardOf("2").querySelector('[data-testid="assigned-not-claimed"]')).toBeNull();
    expect(chipOf("2")).not.toBeNull();

    // Without leases the relay says nothing about claims, so the card does not guess.
    await emit(
      state(
        ["board"],
        boardRead(
          boardOf([
            card("1", "Assigned elsewhere", "taken", { assignees: [{ login: "bo-example" }] }),
          ]),
          { leases: false },
        ),
      ),
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="assigned-not-claimed"]')).toBeNull(),
    );
  });

  it("wraps a long title to three lines, then truncates", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openBoard(stack);
    await using _screen = screen;
    const long = Array.from({ length: 200 }, (_, index) => `word${index}`).join(" ");
    await emit(state(["board"], boardRead(boardOf([card("1", long, "free")]))));
    await expect.element(page.getByText(long)).toBeInTheDocument();
    const title = page.getByText(long).element() as HTMLElement;
    const lineHeight = Number.parseFloat(getComputedStyle(title).lineHeight);
    expect(title.clientHeight).toBe(Math.round(lineHeight * 3));
    expect(title.scrollHeight).toBeGreaterThan(title.clientHeight);
  });

  it("keeps five full columns at least 180px wide at 1165px, each title on up to three whole lines", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openBoard(stack);
    await using _screen = screen;
    // The tester's window: 1165px with the sidebar open, a card in every column, card menus on.
    await page.viewport(1165, 800);
    const long =
      "Delivery: v1 Stage 3 Guild, Trust, Works and Games, then the follow-ups from review";
    const path = "Fix banneret-knowledge-base/docs/spec/50-decided-by-orchestrator.md links";
    await emit(
      state(
        ["board"],
        boardRead(
          boardOf([
            card("1", long, "free"),
            card("2", path, "taken", { lease: lease("bo-example", "active", MINUTE) }),
            card("3", "Relay: stuck rule for quiet claims", "validating"),
            card("4", "Hub: Task dialog sized to its content", "stuck"),
            card("5", "Relay: board and leases", "shipped"),
          ]),
        ),
      ),
    );
    await expect.element(page.getByText(long)).toBeVisible();
    const grid = document.querySelector<HTMLElement>('[data-layout="board-columns"]')!;
    const widths = [...grid.children].map((child) => child.getBoundingClientRect().width);
    expect(widths).toHaveLength(5);
    for (const width of widths) expect(width).toBeGreaterThanOrEqual(180);
    const titles = [
      ...document.querySelectorAll<HTMLElement>("[data-task-id] [data-slot=task-ref] + span"),
    ];
    expect(titles).toHaveLength(5);
    for (const title of titles) {
      const lineHeight = Number.parseFloat(getComputedStyle(title).lineHeight);
      expect(title.clientHeight).toBeLessThanOrEqual(Math.round(lineHeight * 3));
      // Nothing is cut off sideways: a path too long for the card breaks onto the next line.
      expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth);
      // The card menu keeps clear of the title, which takes the card's whole inner width.
      const card = title.closest<HTMLElement>("[data-slot=task-card]")!;
      expect(title.clientWidth).toBe(card.clientWidth - 24);
    }
    const first = page.getByText(long).element() as HTMLElement;
    expect(first.clientHeight).toBe(
      Math.round(Number.parseFloat(getComputedStyle(first).lineHeight) * 3),
    );
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
    await expect.element(page.getByText(HOSTILE, { exact: true }).first()).toBeVisible();
    const row = document.querySelector('[data-task-id="9"]')!;
    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector("a")).toBeNull();
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  describe("take and release", () => {
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

    const free = (extra: Partial<TaskLeaseStatus> = {}): TaskLeaseStatus => ({
      availability: "available",
      viewer: "ada-example",
      lease: null,
      lastRelease: null,
      actions: { take: true, release: false, finish: false, withdraw: false },
      busy: false,
      ...extra,
    });
    const handedOver = {
      by: { login: "bo-example" },
      at: "2026-11-26T08:00:00.000Z",
      reason: "out_of_usage",
      freeToContinue: true,
      note: "Goal: Limit invites.\nNext: Return 429.",
    };
    const cards = () => [
      card("1", "Rate limits", "free"),
      card("8", "Invite limits", "free", { lastRelease: handedOver }),
      card("9", "Old idea", "free", {
        lastRelease: { ...handedOver, reason: "done", freeToContinue: false },
      }),
    ];

    function useLeases() {
      useLeaseStore.setState({ entries: {} });
      vi.mocked(useServerConfigs).mockReturnValue(
        new Map([
          [LOCAL, { environment: { capabilities: { issues: true } } }],
        ]) as unknown as ReturnType<typeof useServerConfigs>,
      );
      vi.mocked(useProjects).mockReturnValue([project]);
      return {
        check: vi.spyOn(leaseRpc, "check"),
        take: vi.spyOn(leaseRpc, "take"),
      };
    }

    it("puts free to continue cards at the top of Free and continues them from the note", async () => {
      using stack = new DisposableStack();
      const rpc = useLeases();
      rpc.check.mockResolvedValue({
        ok: true,
        value: free({ lastRelease: { ...handedOver, by: "bo-example" } }),
      });
      const { emit, screen } = await openBoard(stack);
      await using _screen = screen;
      await emit(state(["board"], boardRead(boardOf(cards()))));
      await expect.element(page.getByText("Invite limits")).toBeVisible();

      const order = [...column("Free").element().querySelectorAll("[data-task-id]")].map(
        (row) => (row as HTMLElement).dataset.taskId,
      );
      expect(order).toEqual(["8", "1", "9"]);
      expect(cardOf("8").querySelector('[data-testid="free-to-continue"]')?.textContent).toBe(
        "Free to continue · from bo-example · Out of usage",
      );
      expect(cardOf("9").querySelector('[data-testid="free-to-continue"]')).toBeNull();
      // The lease is read when a menu opens, never for every card.
      expect(rpc.check).not.toHaveBeenCalled();

      await userEvent.click(page.getByRole("button", { name: "Actions for Invite limits" }));
      await userEvent.click(page.getByRole("menuitem", { name: "Continue…" }));
      expect(rpc.check).toHaveBeenCalledWith(RELAY, expect.objectContaining({ key: "8" }));
      // Continue shows the note first, in the Task dialog, with Continue to take it.
      const dialog = page.getByRole("dialog");
      await expect
        .element(dialog.getByTestId("task-last-release-note"))
        .toHaveTextContent("Goal: Limit invites. Next: Return 429.");
      rpc.take.mockResolvedValue({
        ok: true,
        value: {
          outcome: "taken",
          status: free({
            lease: {
              holder: "ada-example",
              state: "active",
              since: null,
              claimants: ["ada-example"],
            },
            actions: { take: false, release: true, finish: false, withdraw: false },
          }),
        },
      });
      await userEvent.click(
        dialog.getByRole("button", { name: "Continue on Ada laptop", exact: true }),
      );
      expect(rpc.take).toHaveBeenCalledWith(
        RELAY,
        expect.objectContaining({ key: "8" }),
        "Ada-laptop",
      );
    });

    it("takes from the card menu, showing the read-back on the card until the board agrees", async () => {
      using stack = new DisposableStack();
      const rpc = useLeases();
      rpc.check.mockResolvedValue({ ok: true, value: free() });
      let answer: (value: LeaseCall<TaskLeaseResult>) => void = () => {};
      rpc.take.mockReturnValue(
        new Promise((done) => {
          answer = done;
        }),
      );
      const { emit, screen } = await openBoard(stack);
      await using _screen = screen;
      await emit(state(["board"], boardRead(boardOf(cards()))));
      await userEvent.click(page.getByRole("button", { name: "Actions for Rate limits" }));
      await userEvent.click(page.getByRole("menuitem", { name: "Take on Ada laptop" }));
      await vi.waitFor(() =>
        expect(cardOf("1").querySelector("[data-local-lease]")?.textContent).toBe(
          "Taking… confirming",
        ),
      );
      await act(() =>
        answer({
          ok: true,
          value: {
            outcome: "taken",
            status: free({
              lease: {
                holder: "ada-example",
                state: "active",
                since: null,
                claimants: ["ada-example"],
              },
              actions: { take: false, release: true, finish: false, withdraw: false },
            }),
          },
        }),
      );
      await vi.waitFor(() =>
        expect(cardOf("1").querySelector("[data-local-lease]")?.textContent).toBe("Taken by you"),
      );
      // Once the relay's snapshot shows the lease, the board's own chip takes over.
      const taken = cards().map((entry) =>
        entry.task.id === "1"
          ? { ...entry, column: "taken", lease: lease("ada-example", "active", MINUTE) }
          : entry,
      );
      await emit(state(["board"], boardRead(boardOf(taken))));
      await vi.waitFor(() => expect(cardOf("1").querySelector("[data-local-lease]")).toBeNull());
      expect(chipOf("1")?.textContent).toBe("ada-exampleactive 1 min ago");
    });

    it("names the reason in the menu when take is off, and has no menu without the flag", async () => {
      using stack = new DisposableStack();
      const rpc = useLeases();
      rpc.check.mockResolvedValue({
        ok: true,
        value: free({
          availability: "signed-out",
          detail: "Sign in to the tracker to take tasks.",
          actions: { take: false, release: false, finish: false, withdraw: false },
        }),
      });
      const { emit, screen } = await openBoard(stack);
      await using _screen = screen;
      await emit(state(["board"], boardRead(boardOf(cards()))));
      await userEvent.click(page.getByRole("button", { name: "Actions for Rate limits" }));
      await expect
        .element(page.getByRole("menuitem", { name: "Sign in to the tracker to take tasks." }))
        .toBeVisible();
      await userEvent.keyboard("{Escape}");
      await emit(state(["board"], boardRead(boardOf(cards()), { leases: false })));
      await vi.waitFor(() =>
        expect(document.querySelector('[aria-label="Actions for Rate limits"]')).toBeNull(),
      );
      expect(document.querySelector('[data-testid="free-to-continue"]')).toBeNull();
    });

    it("nudges me to my expired and incomplete claims, each with its lease buttons", async () => {
      using stack = new DisposableStack();
      const rpc = useLeases();
      rpc.check.mockImplementation(async (_environment, input) =>
        input.key === "21"
          ? {
              ok: true,
              value: free({
                lease: {
                  holder: "ada-example",
                  state: "expired",
                  since: null,
                  claimants: ["ada-example"],
                },
                actions: { take: false, release: true, finish: false, withdraw: false },
              }),
            }
          : {
              ok: true,
              value: free({
                lease: {
                  holder: "ada-example",
                  state: "incomplete",
                  since: null,
                  claimants: [],
                },
                actions: { take: false, release: false, finish: true, withdraw: true },
              }),
            },
      );
      const mine = () => [
        ...CARDS(),
        card("20", "Mine and fine", "taken", {
          lease: lease("ada-example", "active", MINUTE),
        }),
        card("21", "Mine and expired", "stuck", {
          lease: lease("Ada-Example", "expired", 26 * HOUR),
        }),
        card("22", "Mine half way", "stuck", {
          lease: lease("ada-example", "incomplete", 2 * HOUR),
        }),
      ];
      const { emit, screen } = await openBoard(stack);
      await using _screen = screen;
      await emit(state(["board"], boardRead(boardOf(mine()))));
      // Someone else's expired lease (task 4) is not mine to review.
      const nudge = page.getByTestId("claims-nudge");
      await expect.element(nudge).toBeVisible();
      expect(nudge.element().textContent).toContain("2 of your claims are expired or incomplete.");
      // Nothing reads the tracker until I review.
      expect(rpc.check).not.toHaveBeenCalled();

      await userEvent.click(nudge.getByRole("button", { name: "Review your expired claims" }));
      await vi.waitFor(() =>
        expect(
          [...document.querySelectorAll("[data-task-id]")].map(
            (row) => (row as HTMLElement).dataset.taskId,
          ),
        ).toEqual(["21", "22"]),
      );
      expect(page.getByTestId("claims-nudge").elements()).toHaveLength(0);
      expect(summaryText()).toBe("3 assigned to you · 1 lease expired · 1 incomplete");
      expect(rpc.check).toHaveBeenCalledTimes(2);
      // Each card follows the server's check: Release for the expired one, Finish or Withdraw for
      // the one left half way.
      const expired = cardOf("21");
      await vi.waitFor(() =>
        expect(expired.querySelector('[data-testid="lease-buttons"]')?.textContent).toBe(
          "Release…",
        ),
      );
      await vi.waitFor(() =>
        expect(cardOf("22").querySelector('[data-testid="lease-buttons"]')?.textContent).toBe(
          "FinishWithdraw",
        ),
      );
      await userEvent.click(page.getByRole("button", { name: "Release…" }));
      const dialog = page.getByTestId("release-dialog");
      await expect.element(dialog.getByText("Mine and expired")).toBeVisible();
      await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));

      // The strip leads back to all of mine, where the nudge returns.
      await userEvent.click(page.getByRole("button", { name: "Show all of mine" }));
      await vi.waitFor(() => expect(document.querySelectorAll("[data-task-id]")).toHaveLength(3));
      await expect.element(page.getByTestId("claims-nudge")).toBeVisible();
      expect(document.querySelector('[data-testid="lease-buttons"]')).toBeNull();
    });
  });
});

describe("Several boards, filters and search", () => {
  const OPS = (): BanneretBoardCard[] => [
    card("o1", "Deploy pipeline", "free", {
      task: {
        id: "o1",
        title: "Deploy pipeline",
        ref: {
          tracker: "github",
          scope: "example-org/example-ops",
          key: "11",
          url: "https://github.com/example-org/example-ops/issues/11",
        },
        openedAt: "2026-11-20T09:00:00.000Z",
        closedAt: null,
      },
    }),
    card("o2", "Backup checks", "taken", { assignees: [{ login: "ada-example" }] }),
  ];
  const twoBoards = (platform: BanneretBoardCard[], ops: BanneretBoardCard[]) =>
    state(["board", "today"], {
      ...boardRead(null),
      value: {
        boards: [
          boardEntry("platform", "Platform", boardOf(platform)),
          boardEntry("ops", "Ops", boardOf(ops)),
        ],
      },
    });
  const shownIds = () =>
    [...document.querySelectorAll<HTMLElement>("[data-task-id]")].map((row) => row.dataset.taskId);
  const switcher = () => document.querySelector('[data-testid="board-switcher"]');

  it("hides the switcher with one board, and switches boards with it, remembered per workspace", async () => {
    localStorage.removeItem("banneret.board-choice.v1");
    using stack = new DisposableStack();
    const { emit, router, screen } = await openBoard(stack);
    await using _screen = screen;
    await emit(state(["board"], boardRead(boardOf(CARDS()))));
    await expect.element(page.getByText("Guild invites")).toBeVisible();
    expect(switcher()).toBeNull();
    await expect.element(page.getByRole("heading", { level: 1, name: "Board" })).toBeVisible();

    await emit(twoBoards(CARDS(), OPS()));
    await vi.waitFor(() => expect(switcher()).not.toBeNull());
    await expect.element(page.getByRole("heading", { level: 1, name: "Platform" })).toBeVisible();
    await userEvent.click(switcher()!);
    // Each board names its size.
    await expect.element(page.getByRole("option", { name: "Platform 7 tasks" })).toBeVisible();
    await userEvent.click(page.getByRole("option", { name: "Ops 2 tasks" }));
    await vi.waitFor(() => expect(router.state.location.search).toMatchObject({ board: "ops" }));
    await expect.element(page.getByRole("heading", { level: 1, name: "Ops" })).toBeVisible();
    await vi.waitFor(() => expect(shownIds()).toEqual(["o1", "o2"]));
    expect(rememberedBoard(WORKSPACE_ID)).toBe("ops");

    // A link without a board opens the remembered one; an unknown board falls back to it too.
    await router.navigate({ to: "/board", search: { board: "gone" } } as never);
    await vi.waitFor(() => expect(shownIds()).toEqual(["o1", "o2"]));
  });

  it("keeps the filters in the URL, so a link opens the board filtered", async () => {
    localStorage.removeItem("banneret.board-choice.v1");
    using stack = new DisposableStack();
    const { emit, router, screen } = await openBoard(stack, "/board?q=guild");
    await using _screen = screen;
    await emit(state(["board"], boardRead(boardOf(CARDS()))));
    await vi.waitFor(() => expect(shownIds()).toEqual(["2"]));
    expect(summaryText()).toBe("1 task. 0 free to take, 1 taken, 0 stuck, 0 shipped");
    await expect.element(page.getByLabelText("Filter tasks")).toHaveValue("guild");

    // A person filter joins the text filter in the URL; nothing matches both.
    await userEvent.click(page.getByLabelText("Filter by person"));
    await userEvent.click(page.getByRole("option", { name: "Person: cy-example" }));
    await vi.waitFor(() =>
      expect(router.state.location.search).toMatchObject({ q: "guild", person: "cy-example" }),
    );
    await expect.element(page.getByText("No tasks match these filters.")).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Clear filters" }));
    await vi.waitFor(() => expect(shownIds()).toHaveLength(7));
    expect(router.state.location.search).toEqual({});

    // Typing filters as it goes, and `/` in the box types a slash rather than opening search.
    await userEvent.fill(page.getByLabelText("Filter tasks"), "example-app#3");
    await vi.waitFor(() =>
      expect(router.state.location.search).toMatchObject({ q: "example-app#3" }),
    );
    await vi.waitFor(() => expect(shownIds()).toEqual(["3"]));
    await userEvent.type(page.getByLabelText("Filter tasks"), "/");
    expect(document.querySelector('[data-testid="company-search"]')).toBeNull();
  });

  it("brings back a board's last filters when the sidebar opens it again, until they are cleared", async () => {
    localStorage.removeItem("banneret.board-choice.v1");
    using stack = new DisposableStack();
    const { emit, router, screen } = await openBoard(stack);
    await using _screen = screen;
    await emit(state(["today", "board"], boardRead(boardOf(CARDS()))));
    await vi.waitFor(() => expect(shownIds()).toHaveLength(7));
    await userEvent.fill(page.getByLabelText("Filter tasks"), "guild");
    await vi.waitFor(() => expect(shownIds()).toEqual(["2"]));
    expect(rememberedFilters(WORKSPACE_ID, "board:platform")).toEqual({ q: "guild" });

    // Today, then Board from the sidebar: the filter is back, in the box and in the URL.
    const openFromSidebar = async (row: string, path: string) => {
      await userEvent.click(sidebar().getByRole("button", { name: row, exact: true }));
      await vi.waitFor(() => expect(router.state.location.pathname).toBe(path));
    };
    await openFromSidebar("Today", "/today");
    await openFromSidebar("Board", "/board");
    await vi.waitFor(() => expect(router.state.location.search).toEqual({ q: "guild" }));
    await vi.waitFor(() => expect(shownIds()).toEqual(["2"]));
    await expect.element(page.getByLabelText("Filter tasks")).toHaveValue("guild");

    // A link's own filters win over the remembered ones.
    await act(() => router.navigate({ to: "/board", search: { q: "profile" } } as never));
    await vi.waitFor(() => expect(shownIds()).toEqual(["3"]));
    await expect.element(page.getByLabelText("Filter tasks")).toHaveValue("profile");

    // Clear filters forgets them: the sidebar then opens the whole board.
    await userEvent.click(page.getByRole("button", { name: "Clear filters" }));
    await vi.waitFor(() => expect(shownIds()).toHaveLength(7));
    expect(rememberedFilters(WORKSPACE_ID, "board:platform")).toEqual({});
    await openFromSidebar("Today", "/today");
    await openFromSidebar("Board", "/board");
    await vi.waitFor(() => expect(shownIds()).toHaveLength(7));
    expect(router.state.location.search).toEqual({});
  });

  it("opens / search, finds a card on a board that is not shown, and opens it with Enter", async () => {
    localStorage.removeItem("banneret.board-choice.v1");
    using stack = new DisposableStack();
    const { emit, screen } = await openBoard(stack);
    await using _screen = screen;
    await emit(twoBoards(CARDS(), OPS()));
    await vi.waitFor(() => expect(shownIds()).toHaveLength(7));
    expect(cardOf("o1")).toBeNull();

    // In a text field (the composer is content-editable) the key types a slash.
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    document.body.append(editor);
    stack.defer(() => editor.remove());
    editor.focus();
    await userEvent.keyboard("/");
    expect(document.querySelector('[data-testid="company-search"]')).toBeNull();
    editor.blur();

    await userEvent.keyboard("/");
    const search = page.getByTestId("company-search");
    await expect.element(search).toBeVisible();
    await userEvent.keyboard("deploy");
    const results = search.getByRole("group", { name: "Board cards" });
    await expect.element(results.getByText("Deploy pipeline")).toBeVisible();
    await expect.element(results.getByText("Ops · example-ops #11")).toBeVisible();
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="company-search"]')).toBeNull(),
    );
    await expect
      .element(page.getByRole("dialog").getByRole("heading", { name: "Deploy pipeline" }))
      .toBeVisible();
    expect(document.querySelector('[data-task-panel="o1"]')).not.toBeNull();
  });

  it("keeps Mine when switching boards, showing my cards on each", async () => {
    localStorage.removeItem("banneret.board-choice.v1");
    using stack = new DisposableStack();
    const { emit, screen } = await openBoard(stack);
    await using _screen = screen;
    await emit(
      twoBoards(
        [
          ...CARDS(),
          card("8", "My work", "taken", { lease: lease("ada-example", "active", MINUTE) }),
        ],
        OPS(),
      ),
    );
    await vi.waitFor(() => expect(shownIds()).toHaveLength(8));
    await userEvent.click(page.getByRole("button", { name: "Mine" }));
    await vi.waitFor(() => expect(shownIds()).toEqual(["8"]));

    await userEvent.click(switcher()!);
    await userEvent.click(page.getByRole("option", { name: "Ops 2 tasks" }));
    await vi.waitFor(() => expect(shownIds()).toEqual(["o2"]));
    expect(summaryText()).toBe("1 assigned to you · 0 leases expired");
    await expect
      .element(page.getByRole("button", { name: "Mine" }))
      .toHaveAttribute("aria-pressed", "true");
  });
});
