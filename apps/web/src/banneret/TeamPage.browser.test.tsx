import appCss from "../index.css?inline";
import { minuteTick } from "@t3tools/client-runtime/clock";
import {
  EnvironmentId,
  PoolResources,
  PoolFounderView,
  type BanneretBoardCard,
  type BanneretEnrolmentView,
  type BanneretFeedBoardRead,
  type BanneretFeedState,
  type BanneretTeam,
  type BanneretTeamRead,
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
import * as Schema from "effect/Schema";
import rawFounder from "../../../../docs/banneret/relay-v1/examples/pool-founder-view.json";
import { PoolFounderPage } from "./PoolFounderPage";
import { PoolPage } from "./PoolPage";
import rawPool from "../../../../docs/banneret/relay-v1/examples/pool.json";
import ownExample from "../../../../docs/banneret/relay-v1/examples/pool-resources-local.json";
import { useEnvironmentScope } from "../state/session";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "../state/environments";
import { CompanySearchHost } from "./CompanySearch";
import { enrolmentRpc, storeEnrolmentView, useEnrolmentStore } from "./enrolmentStore";
import { EnterpriseSidebarRows } from "./EnterpriseSidebarRows";
import { feedRpc, useRelayFeedStore } from "./relayFeedStore";
import { TaskDialogHost } from "./TaskDialog";
import { openTaskDialog } from "./taskStore";
import { TeamPage } from "./TeamPage";
import { useWorkspacesStore } from "./workspacesStore";

vi.mock("../state/session", { spy: true });
vi.mock("../state/environments", { spy: true });

const LOCAL = EnvironmentId.make("local");
const WORKSPACE_ID = "ent-0123456789abcdef";
// The page's own minute clock, so ages read the same in the fixture and on the page.
const minuteStart = () => Date.parse(`${minuteTick.getSnapshot()}:00.000Z`);
const ago = (minutes: number) => new Date(minuteStart() - minutes * 60_000).toISOString();

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
  machineId: "m_ada_server",
  label: "Ada server",
  me: { login: "ada-example", role: "founder" },
};

const card = (id: string, key: string, title: string, holder?: string): BanneretBoardCard => ({
  task: {
    id,
    title,
    ref: {
      tracker: "github",
      scope: "example-org/example-app",
      key,
      url: `https://github.com/example-org/example-app/issues/${key}`,
    },
    openedAt: "2026-11-20T09:00:00.000Z",
    closedAt: null,
  },
  kind: "issue",
  column: holder === undefined ? "free" : "taken",
  status: "planned",
  statusWhy: "Open, none of the above.",
  ...(holder === undefined
    ? {}
    : {
        lease: {
          holder: { login: holder },
          state: "active",
          since: ago(120),
          lastSignalAt: ago(4),
          staleAt: ago(-356),
          expiresAt: ago(-1436),
        },
      }),
  assignees: holder === undefined ? [] : [{ login: holder }],
  prs: [],
  restsOn: [],
});

const BOARD = (): BanneretFeedBoardRead => ({
  value: {
    boards: [
      {
        id: "platform",
        title: "Platform",
        mode: "dev",
        source: { kind: "filter" },
        counts: { free: 1, taken: 3 },
        board: {
          state: "ok",
          notMeasured: [],
          columns: [],
          cards: [
            card("t_invites", "42", "Guild invites", "ada-example"),
            card("t_profile", "47", "Profile blocks", "bo-example"),
            card("t_limits", "51", "Rate limits for invites", "ada-example"),
            card("t_docs", "53", "Write the hub docs"),
          ],
        },
      },
    ],
  },
  fetchedAt: ago(0),
  atWork: [],
  leases: true,
  checked: false,
});

/** Banneret's shape: two people, several machines each, a lead with helpers. */
const TEAM = (): BanneretTeam => ({
  people: [
    {
      id: "p_ada",
      login: "ada-example",
      role: "founder",
      machines: [
        { id: "m_ada_server", label: "Ada server", kind: "server", connected: true },
        { id: "m_ada_laptop", label: "Ada laptop", kind: "laptop", connected: true },
        { id: "m_ada_pc", label: "Ada PC", kind: "desktop", connected: false },
      ],
      sessions: [
        {
          id: "s_lead",
          machineId: "m_ada_server",
          provider: "claude",
          state: "working",
          taskId: "t_invites",
          since: ago(25),
        },
        {
          id: "s_helper_1",
          parentId: "s_lead",
          machineId: "m_ada_server",
          provider: "claude",
          state: "waiting",
          waiting: "permission",
          taskId: "t_invites",
          since: ago(3),
        },
        {
          id: "s_helper_2",
          parentId: "s_lead",
          machineId: "m_ada_server",
          provider: "codex",
          state: "working",
          taskId: "t_invites",
          since: ago(12),
        },
        {
          id: "s_limits",
          machineId: "m_ada_laptop",
          provider: "codex",
          state: "working",
          taskId: "t_limits",
          since: ago(40),
        },
        {
          id: "s_idle",
          machineId: "m_ada_laptop",
          provider: "claude",
          state: "idle",
          since: ago(90),
        },
      ],
    },
    {
      id: "p_bo",
      login: "bo-example",
      role: "limited_staff",
      machines: [
        { id: "m_bo_laptop", label: "Bo laptop", kind: "laptop", connected: true },
        { id: "m_bo_server", label: "Bo server", kind: "server", connected: false },
      ],
      sessions: [
        {
          id: "s_bo_ask",
          machineId: "m_bo_laptop",
          provider: "claude",
          state: "waiting",
          waiting: "question",
          taskId: "t_profile",
          since: ago(6),
        },
        {
          id: "s_bo_gone",
          machineId: "m_bo_server",
          provider: "codex",
          state: "not_heard_from",
          taskId: "t_elsewhere",
          since: ago(14),
        },
      ],
    },
    { id: "p_cy", login: "cy-example", role: "limited_staff", machines: [], sessions: [] },
  ],
});

const teamRead = (
  value: BanneretTeam | null,
  extra: Partial<BanneretTeamRead> = {},
): BanneretTeamRead => ({ value, fetchedAt: ago(0), ...extra });

const state = (sections: string[], team: BanneretTeamRead | null): BanneretFeedState => ({
  joined: true,
  live: true,
  since: ago(1),
  sectionsKnown: true,
  sections,
  needsCount: null,
  revision: 1,
  board: sections.includes("board") ? BOARD() : null,
  map: null,
  feed: null,
  graveyard: null,
  team,
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
      <CompanySearchHost />
    </SidebarProvider>
  );
}

async function openTeam(stack: DisposableStack, path = "/team") {
  await page.viewport(1280, 800);
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  stack.defer(() => style.remove());
  const harness = setup();
  const root = createRootRoute({ component: Shell });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/", component: () => <p>Home</p> }),
      createRoute({
        getParentRoute: () => root,
        path: "/offer-machine",
        component: PoolFounderPage,
      }),
      createRoute({ getParentRoute: () => root, path: "/pool", component: PoolPage }),
      createRoute({ getParentRoute: () => root, path: "/team", component: TeamPage }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
    disableGlobalCatchBoundary: true,
  });
  const screen = await render(<RouterProvider router={router} />, { router: false });
  await vi.waitFor(() => expect(harness.subscribe).toHaveBeenCalled());
  return { ...harness, router, screen };
}

const poolExample = Schema.decodeUnknownSync(PoolResources)(rawPool);
const founderExample = Schema.decodeUnknownSync(PoolFounderView)(rawFounder);
const ALL = ["today", "board", "team"];
const sidebar = () => page.getByRole("navigation", { name: "Sidebar" });
const personRow = (login: string) =>
  document.querySelector<HTMLElement>(`li[data-person="${login}"]`);
const groupsOf = (login: string) =>
  Object.fromEntries(
    [...(personRow(login)?.querySelectorAll('[aria-label="Live agents"] [data-group]') ?? [])].map(
      (pill) => [pill.getAttribute("data-group"), pill.textContent],
    ),
  );
const shownLogins = () =>
  [...document.querySelectorAll("li[data-person]")].map((row) => row.getAttribute("data-person"));

describe("Team page", () => {
  it("opens founder approvals and prepares the manual seat command", async () => {
    using stack = new DisposableStack();
    vi.mocked(useEnvironmentScope).mockReturnValue(true);
    const view = founderExample;
    const rpc = vi.spyOn(enrolmentRpc, "poolFounder").mockResolvedValue({ ok: true, value: view });
    vi.spyOn(enrolmentRpc, "pool").mockResolvedValue({ ok: true, value: poolExample });
    const { emit, screen } = await openTeam(stack, "/pool");
    await using _screen = screen;
    await emit(state(["pool"], null));
    await expect.element(page.getByText("Your workspace: Active")).toBeVisible();
    if (import.meta.env.VITE_POOL_SCREENSHOTS)
      await page.screenshot({ path: import.meta.env.VITE_POOL_SCREENSHOTS + "/pool.png" });
    await sidebar().getByRole("button", { name: "Offer a machine" }).click();
    await expect.element(page.getByLabelText("Workspace seats")).toHaveValue(4);
    if (import.meta.env.VITE_POOL_SCREENSHOTS)
      await page.screenshot({ path: import.meta.env.VITE_POOL_SCREENSHOTS + "/founder.png" });
    rpc.mockResolvedValue({
      ok: true,
      value: { ...view, requests: view.requests.map((w) => ({ ...w, state: "approved" })) },
    });
    await userEvent.click(page.getByRole("button", { name: "Approve workspace" }));
    expect(rpc).toHaveBeenLastCalledWith(
      { environmentId: LOCAL, relayOrigin: configured.relayOrigin },
      { action: "approve", requestId: "req_1" },
    );
    await page.getByLabelText("Login", { exact: true }).fill("alice");
    await page.getByLabelText("UID", { exact: true }).fill("24001");
    await page.getByLabelText("Seat port").fill("24101");
    await userEvent.click(page.getByRole("button", { name: "Show admin command" }));
    await expect
      .element(
        page.getByText("/opt/banneret-pool/banneret pool seat p_alice alice 24001 24101 --apply"),
      )
      .toBeVisible();
    await act(() =>
      storeEnrolmentView(LOCAL, { ...configured, me: { login: "member", role: "limited_staff" } }),
    );
    await expect
      .element(page.getByRole("button", { name: "Offer a machine" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByLabelText("Workspace seats")).not.toBeInTheDocument();
  });
  it("shows the pool and pairing guidance only when advertised", async () => {
    using stack = new DisposableStack();
    vi.spyOn(enrolmentRpc, "pool").mockResolvedValue({ ok: true, value: poolExample });
    const { emit, screen } = await openTeam(stack, "/pool");
    await using _screen = screen;
    await emit(state(["team"], null));
    await expect
      .element(sidebar().getByRole("button", { name: "Pool", exact: true }))
      .not.toBeInTheDocument();
    await emit(state(["pool"], null));
    await expect.element(page.getByText("Your workspace: Active")).toBeVisible();
    await expect.element(page.getByText("banneret pair", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Storage quota", { exact: true })).toBeVisible();
  });

  it("launches, follows and cancels the owner's booking", async () => {
    using stack = new DisposableStack();
    vi.mocked(useEnvironmentScope).mockReturnValue(true);
    vi.spyOn(enrolmentRpc, "pool").mockResolvedValue({ ok: true, value: poolExample });
    const waiting = {
      id: "sb1",
      state: "waiting" as const,
      place: 2,
      waitSeconds: 60,
      endsAt: null,
      machineId: null,
      reason: null,
    };
    let cancelled = false;
    const sandbox = vi
      .spyOn(enrolmentRpc, "sandbox")
      .mockImplementation(async (_target, action) => {
        if (action.kind === "cancel") cancelled = true;
        return {
          ok: true,
          value: cancelled
            ? { ...waiting, state: "ended", place: null, reason: "cancelled" }
            : waiting,
        };
      });
    const { emit, screen } = await openTeam(stack, "/pool");
    await using _screen = screen;
    await emit(state(["pool"], null));
    await userEvent.click(page.getByRole("button", { name: "Launch a sandbox" }));
    expect(sandbox).toHaveBeenCalledWith(
      { environmentId: LOCAL, relayOrigin: configured.relayOrigin },
      {
        kind: "launch",
        size: "small",
        hostId: "dev",
        image: poolExample.sandboxes!.images[0]!.digest,
      },
    );
    await expect.element(page.getByText(/Place in line: 2/)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Cancel sandbox" }));
    await expect.element(page.getByText("Sandbox sb1: ended")).toBeVisible();
  });

  it("requests a seat on the selected company host and shows the receipt", async () => {
    using stack = new DisposableStack();
    vi.mocked(useEnvironmentScope).mockReturnValue(true);
    vi.spyOn(enrolmentRpc, "pool").mockResolvedValue({
      ok: true,
      value: { ...poolExample, me: { workspaces: [] } },
    });
    const request = vi
      .spyOn(enrolmentRpc, "requestWorkspace")
      .mockResolvedValue({ ok: true, value: { hostId: "dev", state: "asked" } });
    const { emit, screen } = await openTeam(stack, "/pool");
    await using _screen = screen;
    await emit(state(["pool"], null));
    await userEvent.click(
      page.getByRole("button", { name: "Request a workspace on a shared machine" }),
    );
    expect(request).toHaveBeenCalledWith(
      { environmentId: LOCAL, relayOrigin: configured.relayOrigin },
      "dev",
    );
    await expect.element(page.getByText("Your workspace: Requested")).toBeVisible();
  });

  it("keeps quota bars on the owner's card and shares only host pressure with a colleague", async () => {
    using stack = new DisposableStack();
    vi.mocked(useConnectedEnvironmentIds).mockReturnValue([LOCAL]);
    const { emit, screen } = await openTeam(stack);
    await using _screen = screen;
    vi.spyOn(enrolmentRpc, "pool").mockResolvedValue({
      ok: true,
      value: {
        ...poolExample,
        me: {
          workspaces: poolExample.me.workspaces.map((w) => ({
            ...w,
            resources: {
              inodes: null,
              ...w.resources,
              disk: { used: 51 * 2 ** 30, limit: 60 * 2 ** 30, warn: true },
            },
          })),
        },
      },
    });
    const read = vi.spyOn(enrolmentRpc, "resources").mockResolvedValue({
      ok: true,
      value: {
        own: {
          ...ownExample,
          memory: {
            used: 14 * 2 ** 30,
            limit: 16 * 2 ** 30,
            floor: 2 ** 30,
            oomKills: 0,
            warn: true,
          },
        },
        host: rawPool.hosts[0]!.contention,
        recentOomKill: false,
        cpuCores: 1.25,
        coreLimit: 4,
      },
    });
    const team = TEAM();
    const people = team.people.map((p) => ({
      ...p,
      machines: p.machines.slice(0, 1).map((m) => ({ ...m, poolHostId: "dev" })),
    }));
    await emit(state([...ALL, "pool"], teamRead({ people })));
    await vi.waitFor(() => expect(personRow("ada-example")?.textContent).toContain("14.0 GiB"));
    const colleague = personRow("bo-example")!;
    expect(colleague.textContent).toContain("Host available");
    expect(colleague.textContent).not.toContain("Storage quota");
    expect(colleague.textContent).not.toContain("CPU cores");
    expect(read.mock.calls.every(([id]) => id === LOCAL)).toBe(true);
  });
  it("shows one row per person: role, machines, held leases and live agents by state", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openTeam(stack);
    await using _screen = screen;
    await emit(state(ALL, teamRead(TEAM())));
    await vi.waitFor(() =>
      expect(shownLogins()).toEqual(["ada-example", "bo-example", "cy-example"]),
    );

    const ada = personRow("ada-example")!;
    expect(ada.textContent).toContain("you");
    expect(ada.textContent).toContain("Founder");
    expect(
      [...ada.querySelectorAll("[data-machine]")].map((machine) => [
        machine.textContent,
        machine.hasAttribute("data-online"),
      ]),
    ).toEqual([
      ["Ada server, online", true],
      ["Ada laptop, online", true],
      ["Ada PC, offline", false],
    ]);
    // Helpers count under their lead: the lead takes its waiting helper's state, and it is mine.
    expect(groupsOf("ada-example")).toEqual({ needs_you: "1 needs you", working: "1 working" });
    expect(ada.textContent).toContain("1 idle");
    expect(
      [...ada.querySelectorAll("[data-lease-task]")].map((lease) =>
        lease.getAttribute("data-lease-task"),
      ),
    ).toEqual(["t_invites", "t_limits"]);

    // Someone else's wait is theirs to answer; their quiet machine is not heard from.
    expect(groupsOf("bo-example")).toEqual({
      waiting: "1 waiting on someone else",
      not_heard_from: "1 not heard from",
    });
    expect(personRow("cy-example")!.textContent).toContain("No live agents");
    expect(personRow("cy-example")!.textContent).toContain("Not joined yet");
    expect(personRow("cy-example")!.textContent).toContain("No machines");

    const totals = document.querySelector('[aria-label="Live agents by state"]')!;
    expect(totals.textContent).toContain("1 needs you");
    expect(totals.textContent).toContain("1 waiting on someone else");
    expect(document.querySelector("h1 + p")?.textContent).toBe("1 working · 1 idle · 1 needs you");

    // A held lease opens its task, without any lease check.
    await userEvent.click(ada.querySelector<HTMLElement>('[data-lease-task="t_limits"]')!);
    await expect
      .element(page.getByRole("dialog").getByRole("heading", { name: "Rate limits for invites" }))
      .toBeVisible();
  });

  it("expands a person into the working tree: sessions, their helpers and the task each works on", async () => {
    using stack = new DisposableStack();
    const { emit, router, screen } = await openTeam(stack);
    await using _screen = screen;
    await emit(state(ALL, teamRead(TEAM())));
    await vi.waitFor(() => expect(personRow("ada-example")).not.toBeNull());
    expect(document.querySelector("[data-session]")).toBeNull();

    await userEvent.click(page.getByRole("button", { name: /ada-example/ }));
    await vi.waitFor(() =>
      expect(router.state.location.search).toMatchObject({ person: "ada-example" }),
    );
    const tree = page.getByRole("list", { name: "Agents of ada-example" });
    await expect.element(tree).toBeVisible();
    const lead = document.querySelector<HTMLElement>('[data-session="s_lead"]')!;
    expect(
      [...lead.querySelectorAll("[data-session]")].map((child) =>
        child.getAttribute("data-session"),
      ),
    ).toEqual(["s_helper_1", "s_helper_2"]);
    const helper = document.querySelector<HTMLElement>('[data-session="s_helper_1"]')!;
    expect(helper.textContent).toContain("Helper · Claude");
    expect(helper.textContent).toContain("Ada server · waiting for a permission answer");
    expect(document.querySelector('[data-session="s_idle"]')!.textContent).toContain(
      "no task linked",
    );

    await userEvent.click(lead.querySelector<HTMLElement>('[data-task-link="t_invites"]')!);
    await expect
      .element(page.getByRole("dialog").getByRole("heading", { name: "Guild invites" }))
      .toBeVisible();
  });

  it("names a task that is on no board, and says not heard from with its time", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openTeam(stack, "/team?person=bo-example");
    await using _screen = screen;
    await emit(state(ALL, teamRead(TEAM())));
    const gone = await vi.waitFor(() => {
      const row = document.querySelector<HTMLElement>('[data-session="s_bo_gone"]');
      expect(row).not.toBeNull();
      return row!;
    });
    expect(gone.textContent).toContain("a task not on the board");
    // The page's clock moves by the minute, so the age reads 13 or 14 minutes.
    expect(gone.textContent).toMatch(/Bo server · not heard from for 1[34] min/);
    expect(document.querySelector('[data-session="s_bo_ask"]')!.textContent).toContain(
      "waiting for an answer",
    );
  });

  it("narrows the people with the filter, kept in the URL", async () => {
    using stack = new DisposableStack();
    const { emit, router, screen } = await openTeam(stack, "/team?q=laptop");
    await using _screen = screen;
    await emit(state(ALL, teamRead(TEAM())));
    await expect.element(page.getByLabelText("Find a person")).toHaveValue("laptop");
    await vi.waitFor(() => expect(shownLogins()).toEqual(["ada-example", "bo-example"]));

    await userEvent.fill(page.getByLabelText("Find a person"), "profile blocks");
    await vi.waitFor(() => expect(shownLogins()).toEqual(["bo-example"]));
    expect(router.state.location.search).toMatchObject({ q: "profile blocks" });

    await userEvent.fill(page.getByLabelText("Find a person"), "nobody here");
    await expect.element(page.getByText("No person matches this filter.")).toBeVisible();
  });

  it("finds a person from / search and opens them on the Team page", async () => {
    using stack = new DisposableStack();
    const { emit, router, screen } = await openTeam(stack, "/");
    await using _screen = screen;
    await emit(state(ALL, teamRead(TEAM())));
    await expect.element(sidebar().getByRole("button", { name: "Team" })).toBeVisible();
    await userEvent.keyboard("/");
    const search = page.getByTestId("company-search");
    await expect.element(search).toBeVisible();
    await userEvent.keyboard("bo laptop");
    const people = search.getByRole("group", { name: "People" });
    await expect.element(people.getByText("bo-example")).toBeVisible();
    await userEvent.fill(search.getByRole("combobox"), "bo-ex");
    await expect
      .element(search.getByRole("option").first())
      .toHaveAttribute("data-hit", "person:p_bo");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/team"));
    expect(router.state.location.search).toMatchObject({ person: "bo-example" });
    await expect.element(page.getByRole("list", { name: "Agents of bo-example" })).toBeVisible();
  });

  it("is hidden when the relay does not advertise a team", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openTeam(stack);
    await using _screen = screen;
    await emit(state(["today", "board"], null));
    await expect.element(sidebar().getByRole("button", { name: "Board" })).toBeVisible();
    expect(sidebar().getByRole("button", { name: "Team" }).elements()).toHaveLength(0);
    await expect
      .element(page.getByText("Example Company does not offer a team view."))
      .toBeVisible();
  });

  it("keeps what the relay last said, with its age, while it cannot be reached", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openTeam(stack);
    await using _screen = screen;
    await emit(
      state(
        ALL,
        teamRead(TEAM(), {
          fetchedAt: ago(7),
          problem: { message: "Cannot reach Example Company.", since: ago(5) },
        }),
      ),
    );
    await vi.waitFor(() => {
      const status = document.querySelector('[role="status"]')?.textContent ?? "";
      expect(status).toContain("Cannot reach Example Company.");
      expect(status).toMatch(/Showing what Example Company said [67] min ago/);
    });
    expect(shownLogins()).toHaveLength(3);
  });

  it("says when nobody is here yet", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openTeam(stack);
    await using _screen = screen;
    await emit(state(ALL, teamRead({ people: [] })));
    await expect.element(page.getByText("Nobody is here yet.")).toBeVisible();
  });
});
