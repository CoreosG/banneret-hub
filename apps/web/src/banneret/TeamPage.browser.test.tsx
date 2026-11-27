import company from "./offices/fixtures/company.csv?raw";
import { chatRpc } from "./chat/client";
import { restoredSearch } from "./filterMemory";
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

import { act, fakeTimers, render } from "../../test/render";
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
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
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
  me: {
    login: "ada-example",
    id: "p_me",
    permissions: ["relay.admin"],
    role: { id: "founder", name: "Founder" },
    admission: "member" as const,
  },
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
      role: { id: "founder", name: "Founder" },
      admission: "member" as const,
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
      role: { id: "staff", name: "Staff" },
      admission: "member" as const,
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
    {
      id: "p_cy",
      login: "cy-example",
      role: { id: "staff", name: "Staff" },
      admission: "member" as const,
      machines: [],
      sessions: [],
    },
  ],
});

const counts = { working: 1, waiting: 0, notHeardFrom: 0, stopped: 0, idle: 0 };
const office = {
  preset: "company" as const,
  revision: "one",
  files: { "team.room.platform": "platform-file" },
  flags: ["status", "presence", "sharing", "meeting_links"],
  summary: {
    rooms: [
      { board: "platform", active: 2, desks: 2, counts },
      { board: "other", active: 0, desks: 0, counts: { ...counts, working: 0 } },
    ],
    agents: [],
    agentsNextCursor: null,
    people: { total: 3 },
    office: {},
    hallway: { counts },
  },
};
const teamRead = (
  value: BanneretTeam | null,
  extra: Partial<BanneretTeamRead> = {},
): BanneretTeamRead => ({
  value: value ? { ...value, office: value.office ?? office } : null,
  fetchedAt: ago(0),
  ...extra,
});

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
  localStorage.removeItem("banneret.team.view." + WORKSPACE_ID);
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
  vi.spyOn(feedRpc, "room").mockResolvedValue({ sessions: [], nextCursor: null });
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
        <WorkspaceSwitcher homeLabel="Home" onBackdrop={false}>
          Workspace
        </WorkspaceSwitcher>
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
      createRoute({
        getParentRoute: () => root,
        path: "/channels/$channelId",
        component: () => <p>Chat</p>,
      }),
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
  document.querySelector<HTMLElement>(`[data-person="${login}"]`);
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
      storeEnrolmentView(LOCAL, {
        ...configured,
        me: {
          login: "member",
          id: "p_me",
          permissions: [],
          role: { id: "staff", name: "Staff" },
          admission: "member" as const,
        },
      }),
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
      taskId: null,
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
      presence: "available",
      machines: p.machines.slice(0, 1).map((m) => ({ ...m, poolHostId: "dev" })),
    }));
    await emit(state([...ALL, "pool"], teamRead({ people })));
    await userEvent.click(page.getByText("Ada server", { exact: true }));
    await userEvent.click(page.getByText("Bo laptop", { exact: true }));
    await vi.waitFor(() => expect(personRow("ada-example")?.textContent).toContain("14.0 GiB"));
    const colleague = personRow("bo-example")!;
    expect(colleague.textContent).toContain("Host available");
    expect(colleague.textContent).not.toContain("Storage quota");
    expect(colleague.textContent).not.toContain("CPU cores");
    expect(read.mock.calls.every(([id]) => id === LOCAL)).toBe(true);
  });
  it("loads open rooms on demand, caps desks, and windows 500 people", async () => {
    using stack = new DisposableStack();
    const { emit, screen, router } = await openTeam(stack);
    await using _screen = screen;
    // Directory IDs and logins from the fake relay's 500-owner conformance case.
    const people = company
      .trim()
      .split("\n")
      .map((line, i) => ({
        id: line.split(",")[0]!,
        login: line.split(",")[1]!,
        role: { id: "staff", name: "Staff" },
        admission: "member" as const,
        presence: i === 0 ? "away" : "off",
        machines: [],
        sessions: [],
      }));
    vi.mocked(feedRpc.room).mockImplementation(async (_target, _room, cursor) => ({
      sessions: (cursor
        ? people.slice(Number(cursor), Number(cursor) + 100)
        : people.slice(0, 300)
      ).map((p) => ({
        id: "s" + p.id,
        personId: p.id,
        state: "working",
        since: ago(2),
        provider: "codex",
      })),
      nextCursor: cursor === "400" ? null : cursor ? "400" : "300",
    }));
    const agents = people
      .map((p) => ({ personId: p.id, counts, rooms: [{ board: "platform", waiting: 0 }] }))
      .sort((a, b) => a.personId.localeCompare(b.personId));
    const largeOffice = {
      ...office,
      summary: {
        ...office.summary,
        people: { total: 500 },
        rooms: [
          { board: "platform", desks: 500, active: 500, counts: { ...counts, working: 500 } },
        ],
        agents: agents.slice(0, 400),
        agentsNextCursor: "opaque",
      },
    };
    const next = vi
      .spyOn(feedRpc, "agents")
      .mockResolvedValue({ agents: agents.slice(400), nextCursor: null });
    await emit(state(ALL, teamRead({ people, office: largeOffice })));
    expect(next).not.toHaveBeenCalled();
    expect(feedRpc.room).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: /Platform.*desks/ }));
    await vi.waitFor(() =>
      expect(document.querySelectorAll("article[data-person]")).toHaveLength(12),
    );
    await expect.element(page.getByText("488 more")).toBeVisible();
    expect(vi.mocked(feedRpc.room).mock.calls.map((c) => c[1])).toEqual([
      "platform",
      "platform",
      "platform",
    ]);
    await userEvent.click(page.getByRole("button", { name: /Platform.*desks/ }));
    expect(document.querySelectorAll("article[data-person]")).toHaveLength(0);
    await userEvent.click(page.getByRole("button", { name: "List", exact: true }));
    const list = page.getByRole("list", { name: "Team members" });
    await vi.waitFor(() => expect(list.getByRole("listitem").elements()).toHaveLength(25));
    list.element().scrollTop = 4800;
    await vi.waitFor(() => expect(list.getByText(people[100]!.login).elements()).toHaveLength(1));
    expect(list.getByRole("listitem").elements()).toHaveLength(25);
    await userEvent.selectOptions(page.getByLabelText("Presence"), "away");
    await vi.waitFor(() => expect(list.getByRole("listitem").elements()).toHaveLength(1));
    expect(router.state.location.search).toMatchObject({ presence: "away" });
  });
  it("loads a waiting room only when scrolled into view and preserves folding on refresh", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openTeam(stack);
    await using _screen = screen;
    const rooms = Array.from({ length: 50 }, (_, i) => ({
      board: "board-" + i,
      active: 1,
      desks: 1,
      counts,
    }));
    const last = rooms[49]!.board;
    const team = {
      ...TEAM(),
      office: {
        ...office,
        summary: {
          ...office.summary,
          rooms,
          agents: [
            {
              personId: "p_ada",
              counts: { ...counts, waiting: 1 },
              rooms: [{ board: last, waiting: 1 }],
            },
          ],
        },
      },
    };
    await emit(state(ALL, teamRead(team)));
    const button = page.getByRole("button", { name: /board-49.*desks/ });
    await expect.element(button).toHaveAttribute("aria-expanded", "true");
    expect(feedRpc.room).not.toHaveBeenCalled();
    button.element().scrollIntoView();
    await vi.waitFor(() => expect(feedRpc.room).toHaveBeenCalledTimes(1));
    expect(vi.mocked(feedRpc.room).mock.calls[0]?.[1]).toBe(last);
    await userEvent.click(button);
    await emit(state(ALL, teamRead({ ...team, office: { ...team.office, revision: "two" } })));
    await expect.element(button).toHaveAttribute("aria-expanded", "false");
  });

  it("pages agent counts only when List needs an uncovered row and restores Team filters", async () => {
    using stack = new DisposableStack();
    const { emit, screen, router } = await openTeam(stack, "/team?view=list");
    await using _screen = screen;
    const people = Array.from({ length: 100 }, (_, i) => ({
      id: "p" + String(i).padStart(3, "0"),
      login: "worker" + i,
      role: { id: "staff", name: "Staff" },
      admission: "member" as const,
      presence: "available",
      machines: [],
      sessions: [],
    }));
    const agents = people.map((p) => ({
      personId: p.id,
      counts,
      rooms: [{ board: "other", waiting: 0 }],
    }));
    const next = vi
      .spyOn(feedRpc, "agents")
      .mockResolvedValue({ agents: agents.slice(30), nextCursor: null });
    await emit(
      state(
        ALL,
        teamRead({
          people,
          office: {
            ...office,
            summary: { ...office.summary, agents: agents.slice(0, 30), agentsNextCursor: "opaque" },
          },
        }),
      ),
    );
    const list = page.getByRole("list", { name: "Team members" });
    await vi.waitFor(() => expect(list.getByRole("listitem").elements()).toHaveLength(25));
    expect(next).not.toHaveBeenCalled();
    list.element().scrollTop = 48 * 35;
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    expect(next.mock.calls[0]?.[1]).toBe("opaque");
    await userEvent.fill(page.getByRole("searchbox", { name: "Find a person" }), "worker77");
    await userEvent.selectOptions(page.getByLabelText("Agent states"), "working");
    await userEvent.selectOptions(page.getByLabelText("Boards"), "other");
    await vi.waitFor(() => expect(list.getByRole("listitem").elements()).toHaveLength(1));
    expect(router.state.location.search).toMatchObject({
      q: "worker77",
      state: "working",
      board: "other",
    });
    expect(restoredSearch(WORKSPACE_ID, "/team", null)).toEqual({
      q: "worker77",
      state: "working",
      board: "other",
    });
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
    await expect.element(page.getByRole("listitem").getByText("bo-example")).toBeVisible();
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
    await expect.element(page.getByRole("button", { name: /Platform.*desks/ })).toBeVisible();
  });

  it("starts a community on Floor with machines hidden and no automatic reminder", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openTeam(stack);
    await using _screen = screen;
    const people = TEAM().people.map((p) => ({ ...p, presence: "off" }));
    await emit(state(ALL, teamRead({ people, office: { ...office, preset: "community" } })));
    await expect
      .element(page.getByRole("button", { name: "Floor", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByRole("checkbox", { name: "Show machines" })).not.toBeChecked();
    expect(page.getByRole("dialog").elements()).toHaveLength(0);
    await expect.element(page.getByText("Ada server", { exact: true })).not.toBeInTheDocument();
    await page.getByLabelText("Show machines").click();
    await expect.element(page.getByText("Ada server", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Office", exact: true }).click();
    await page.getByText("My office", { exact: true }).click();
    await expect.element(page.getByLabelText("Machine sharing")).toHaveValue("hidden");
  });
  it("opens only advertised board channels, preferring a configured channel", async () => {
    using stack = new DisposableStack();
    const { emit, screen, router } = await openTeam(stack);
    await using _screen = screen;
    const items = ["platform", "releases"].map((name) => ({
      kind: "channel",
      name,
      id: "c_" + name,
      purpose: "",
      agents: "off",
      memberCount: { people: 1, agents: 0 },
      archived: false,
      access: {
        visibility: "public",
        join: "open",
        outsiders: "none",
        post: "everyone",
        invite: "members",
        replies: "everyone",
      },
      managers: [],
      lastSeq: 0,
      me: {
        can: {
          read: true,
          post: true,
          reply: true,
          join: false,
          request: false,
          manage: false,
          invite: true,
          openToOutside: false,
        },
        member: true,
        notify: "all",
        muted: false,
        readSeq: 0,
        unread: 0,
        mentions: 0,
      },
    }));
    vi.spyOn(chatRpc, "run").mockResolvedValue({ items, nextCursor: null });
    const base = state([...ALL, "chat"], teamRead(TEAM()));
    const link = page.getByRole("link", { name: "Open channel" });
    await emit({ ...base, chatFlags: ["channels"] });
    await expect.element(link).toHaveAttribute("href", "/channels/c_platform");
    await emit({ ...base, chatFlags: ["channels"], boardChannels: { platform: "releases" } });
    await expect.element(link).toHaveAttribute("href", "/channels/c_releases");
    await emit({ ...base, chatFlags: ["dms"] });
    await expect.element(link).not.toBeInTheDocument();
    const me = items[0]!.me;
    vi.mocked(chatRpc.run).mockResolvedValue({
      kind: "dm",
      id: "dm_bo",
      private: true,
      members: [],
      agentReaders: [],
      purpose: "",
      agents: "off",
      memberCount: { people: 2, agents: 0 },
      archived: false,
      lastSeq: 0,
      me,
    });
    await page.getByRole("button", { name: "Direct message bo-example" }).click();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/channels/dm_bo"));
    expect(chatRpc.run).toHaveBeenCalledWith(
      expect.objectContaining({ relayOrigin: configured.relayOrigin }),
      { kind: "dm", members: ["p_bo"] },
    );
  });
  it("reminds only the signed-in person and writes only on Save", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openTeam(stack);
    await using _screen = screen;
    const edit = vi
      .spyOn(enrolmentRpc, "officeEdit")
      .mockResolvedValue({ ok: true, value: undefined });
    const people = TEAM().people.map((p) => ({
      ...p,
      presence: p.login === "ada-example" ? "away" : "off",
    }));
    await emit(state(ALL, teamRead({ people })));
    await expect.element(page.getByText("You're shown as Away. Change?")).toBeVisible();
    if (import.meta.env.VITE_OFFICE_SCREENSHOTS)
      await page.screenshot({ path: import.meta.env.VITE_OFFICE_SCREENSHOTS + "/reminder.png" });
    await page.getByRole("button", { name: "Change", exact: true }).click();
    await userEvent.selectOptions(page.getByRole("dialog").getByRole("combobox"), "focusing");
    await userEvent.fill(page.getByLabelText("Status line"), "Design review");
    expect(edit).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Save presence" }).click();
    expect(edit.mock.lastCall?.[1]).toEqual({
      kind: "presence",
      presence: "focusing",
      status: { text: "Design review" },
    });
    await userEvent.fill(page.getByLabelText("Status line"), "");
    await page.getByRole("button", { name: "Save presence" }).click();
    expect(edit.mock.lastCall?.[1]).toMatchObject({ status: null });
  });

  it("previews all machine sharing choices before saving and omits person ages", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openTeam(stack);
    await using _screen = screen;
    const edit = vi
      .spyOn(enrolmentRpc, "officeEdit")
      .mockResolvedValue({ ok: true, value: undefined });
    await emit(state(ALL, teamRead(TEAM())));
    await page.getByRole("button", { name: "Office", exact: true }).click();
    await page.getByText("My office", { exact: true }).click();
    const sharing = page.getByLabelText("Machine sharing");
    await expect.element(sharing).toHaveValue("agents_only");
    await expect.element(page.getByText("Agents without the machine name")).toBeVisible();
    await userEvent.selectOptions(sharing, "agents_and_name");
    await expect.element(page.getByText("Agents and machine name: Ada server")).toBeVisible();
    if (import.meta.env.VITE_OFFICE_SCREENSHOTS)
      await page.screenshot({ path: import.meta.env.VITE_OFFICE_SCREENSHOTS + "/office.png" });
    await userEvent.selectOptions(sharing, "hidden");
    await expect.element(page.getByText("No agents or machine name")).toBeVisible();
    await expect.element(page.getByText("Claims: ada-example/private")).toBeVisible();
    expect(edit).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Save sharing" }).click();
    expect(edit.mock.lastCall?.[1]).toEqual({
      kind: "sharing",
      share: "hidden",
      shareUsage: false,
    });
    await page.getByRole("button", { name: "List", exact: true }).click();
    for (const row of page.getByRole("listitem").elements())
      expect(row.textContent).not.toMatch(/ago|last seen|heard/i);
  });
  it("says when nobody is here yet", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openTeam(stack);
    await using _screen = screen;
    await emit(state(ALL, teamRead({ people: [] })));
    await expect.element(page.getByText("Nobody is here yet.")).toBeVisible();
  });
});

it("opens the company office, reads only visible rooms and makes zero frame requests or paints in two idle seconds", async () => {
  using stack = new DisposableStack();
  const { emit, screen } = await openTeam(stack, "/team?view=office");
  await using _screen = screen;
  const people = Array.from({ length: 500 }, (_, i) => ({
    id: "p" + String(i).padStart(3, "0"),
    login: "builder-" + String(i).padStart(3, "0"),
    role: { id: "staff", name: "Staff" },
    admission: "member" as const,
    presence: "available",
    machines: [],
    sessions: [],
  }));
  const rooms = Array.from({ length: 50 }, (_, i) => ({
    board: ["Platform", "Design", "Operations"][i] ?? "Board " + i,
    active: 10,
    desks: 10,
    counts: { ...counts, working: 30 },
  }));
  const agents = people.map((p, i) => ({
    personId: p.id,
    counts: { ...counts, working: 3 },
    rooms: [{ board: rooms[Math.floor(i / 10)]!.board, waiting: 0 }],
  }));
  const next = vi
    .spyOn(feedRpc, "agents")
    .mockResolvedValue({ agents: agents.slice(400), nextCursor: null });
  vi.mocked(feedRpc.room).mockImplementation(async (_target, board) => {
    const index = rooms.findIndex((r) => r.board === board);
    return {
      sessions: people.slice(index * 10, index * 10 + 10).flatMap((p) =>
        ["codex", "claude", "cursor"].map((provider) => ({
          id: p.id + provider,
          personId: p.id,
          state: "working",
          since: ago(1),
          provider,
        })),
      ),
      nextCursor: null,
    };
  });
  localStorage.removeItem("banneret.team.view." + WORKSPACE_ID);
  await emit(
    state(
      ALL,
      teamRead({
        people,
        office: {
          ...office,
          preset: "company",
          summary: {
            ...office.summary,
            people: { total: 500 },
            rooms,
            agents: agents.slice(0, 400),
            agentsNextCursor: "remaining",
          },
        },
      }),
    ),
  );
  const map = page.getByRole("group", { name: /Office map/ });
  await vi.waitFor(() =>
    expect(
      document.querySelector('[data-office-target="team.room.Platform/desk/p000"]'),
    ).toBeTruthy(),
  );
  if (import.meta.env.VITE_SCALE_SCREENSHOTS) {
    await page.screenshot({ path: import.meta.env.VITE_SCALE_SCREENSHOTS + "/office.png" });
    await page.getByRole("button", { name: "Floor", exact: true }).click();
    await page.getByRole("button", { name: /Platform.*desks/ }).click();
    await expect.element(page.getByText("builder-000", { exact: true })).toBeVisible();
    await page.screenshot({ path: import.meta.env.VITE_SCALE_SCREENSHOTS + "/floor.png" });
    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect.element(page.getByRole("list", { name: "Team members" })).toBeVisible();
    await page.screenshot({ path: import.meta.env.VITE_SCALE_SCREENSHOTS + "/list.png" });
    await page.getByRole("button", { name: "Office", exact: true }).click();
    await expect.element(map).toBeVisible();
  }
  const surface = map.element().querySelector("canvas")!;
  await vi.waitFor(() =>
    expect(
      surface
        .getContext("2d")!
        .getImageData(0, 0, surface.width, surface.height)
        .data.some((v) => v > 0),
    ).toBe(true),
  );
  {
    using _clock = fakeTimers();
    const requests = vi.spyOn(window, "requestAnimationFrame");
    const paints = vi.spyOn(CanvasRenderingContext2D.prototype, "drawImage");
    await vi.advanceTimersByTimeAsync(2000);
    expect(requests).toHaveBeenCalledTimes(0);
    expect(paints).toHaveBeenCalledTimes(0);
    requests.mockRestore();
    paints.mockRestore();
  }
  for (const label of ["full", "simple", "overview"]) {
    if (label !== "full") await userEvent.click(page.getByRole("button", { name: "Zoom out" }));
    const canvas = map.element().querySelector("canvas")!;
    expect(Math.max(canvas.width, canvas.height)).toBeLessThanOrEqual(4096);
    expect(map.element().querySelectorAll("button").length).toBeLessThanOrEqual(250);
  }
  expect(vi.mocked(feedRpc.room).mock.calls.some(([, id]) => id === "Board 49")).toBe(false);
  expect(map.element().querySelectorAll('[data-office-target*="/desk/"]')).toHaveLength(0);
  expect(next).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "List", exact: true }).click();
  const list = page.getByRole("list", { name: "Team members" });
  await expect.element(list).toBeVisible();
  expect(next).not.toHaveBeenCalled();
  list.element().scrollTop = 48 * 450;
  await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
  expect(next.mock.calls[0]?.[1]).toBe("remaining");
});

it("explores desks with the keyboard and restores focus after closing the card", async () => {
  using stack = new DisposableStack();
  const { emit, screen } = await openTeam(stack, "/team?view=office");
  await using _screen = screen;
  const people = TEAM().people.map((p) => ({
    ...p,
    presence: p.id === "p_ada" ? "focusing" : "available",
    seatBoard: "platform",
    machines: p.id === "p_bo" ? [] : p.machines,
  }));
  vi.mocked(feedRpc.room).mockImplementation(async (_target, board) => ({
    sessions:
      board === "platform"
        ? people.flatMap((p) => p.sessions.slice(0, 2).map((s) => ({ ...s, personId: p.id })))
        : [],
    nextCursor: null,
  }));
  const rooms = office.summary.rooms.map((r) =>
    r.board === "platform" ? { ...r, meetingUrl: "https://example.com/meet" } : r,
  );
  await emit(
    state(ALL, teamRead({ people, office: { ...office, summary: { ...office.summary, rooms } } })),
  );
  const map = page.getByRole("group", { name: /Office map/ });
  await vi.waitFor(() =>
    expect(map.element().querySelector('[data-office-target*="/desk/"]')).toBeTruthy(),
  );
  const desk = map.getByRole("button", { name: "ada-example", exact: true });
  await expect.element(desk.getByText("focusing", { exact: true })).toBeVisible();
  expect(desk.element().getAttribute("aria-description")).toContain("Ada server");
  expect(
    map
      .getByRole("button", { name: "bo-example", exact: true })
      .element()
      .getAttribute("aria-description"),
  ).not.toMatch(/Bo laptop|m_bo_laptop/);
  const robot = map.getByRole("button", { name: "codex · not_heard_from" });
  await robot.click();
  const card = page.getByRole("complementary", { name: "bo-example" });
  await expect
    .element(card.getByRole("button", { name: /Direct message/ }))
    .not.toBeInTheDocument();
  await card.getByRole("button", { name: /Profile blocks/ }).click();
  await expect.element(page.getByRole("dialog", { name: "Task" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await card.getByRole("button", { name: "Close" }).click();
  expect(document.activeElement).toBe(robot.element());
  await emit({
    ...state(
      ALL,
      teamRead({ people, office: { ...office, summary: { ...office.summary, rooms } } }),
    ),
    sections: [...ALL, "chat"],
    chatFlags: ["dms"],
  });
  await robot.click();
  await expect
    .element(card.getByRole("button", { name: "Direct message bo-example" }))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await map.getByRole("button", { name: /Platform.*Meeting link/i }).click();
  await expect
    .element(page.getByRole("link", { name: "Open Platform board" }))
    .toHaveAttribute("href", "/board?board=platform");
  await expect
    .element(page.getByRole("link", { name: "Meeting link" }))
    .toHaveAttribute("href", "https://example.com/meet");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  map.element().focus();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  await expect.element(page.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement?.hasAttribute("data-office-target")).toBe(true);
  map.element().focus();
  for (const label of ["full", "simple", "overview"]) {
    if (label !== "full") await userEvent.click(page.getByRole("button", { name: "Zoom out" }));
    if (import.meta.env.VITE_OFFICE_SCREENSHOTS)
      await page.screenshot({
        path: import.meta.env.VITE_OFFICE_SCREENSHOTS + "/" + label + ".png",
      });
  }
});

it("shows the same people, presence, claims and agent counts in Floor, List and Office", async () => {
  using stack = new DisposableStack();
  const { emit, screen } = await openTeam(stack);
  await using _screen = screen;
  const people = TEAM().people.map((p, i) => ({ ...p, presence: i ? "away" : "focusing" }));
  const agents = people.slice(0, 2).map((p, i) => ({
    personId: p.id,
    counts: { ...counts, working: 1 - i, waiting: i },
    rooms: [{ board: "platform", waiting: i }],
  }));
  vi.mocked(feedRpc.room).mockImplementation(async (_, board) => ({
    nextCursor: null,
    sessions:
      board === "platform"
        ? people.slice(0, 2).map((p) => ({ ...p.sessions[0]!, personId: p.id }))
        : [],
  }));
  await emit(
    state(
      ALL,
      teamRead({
        people,
        office: { ...office, preset: "company", summary: { ...office.summary, agents } },
      }),
    ),
  );
  const expected = [
    ["ada-example", "focusing", "1 working", "Guild invites", "Rate limits for invites"],
    ["bo-example", "away", "1 waiting", "Profile blocks"],
    ["cy-example", "away"],
  ] as const;
  for (const view of ["Floor", "List", "Office"]) {
    if (view !== "Floor") await page.getByRole("button", { name: view, exact: true }).click();
    if (view === "Floor") await page.getByText("Hallway", { exact: true }).click();
    for (const [login, ...facts] of expected) {
      if (view === "Office") await page.getByRole("button", { name: login, exact: true }).click();
      await vi.waitFor(() => {
        const row =
          view === "Office"
            ? page.getByRole("complementary", { name: login }).element()
            : personRow(login);
        for (const fact of [login, ...facts]) expect(row?.textContent).toContain(fact);
        const chips = Array.from(
          row!.querySelectorAll('[data-slot="lease-chip"]'),
          (c) => c.textContent,
        );
        expect(chips).toEqual(facts.slice(2).map(() => login + "/privatelive"));
      });
      if (view === "Office") await userEvent.keyboard("{Escape}");
    }
  }
});
