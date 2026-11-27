import appCss from "../index.css?inline";
import {
  EnvironmentId,
  type BanneretEnrolmentView,
  type BanneretFeedMapRead,
  type BanneretFeedState,
  type BanneretMap,
  type BanneretMapItem,
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
import { usePrimaryEnvironmentId } from "../state/environments";
import { storeEnrolmentView, useEnrolmentStore } from "./enrolmentStore";
import { EnterpriseSidebarRows } from "./EnterpriseSidebarRows";
import { MapPage } from "./MapPage";
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

const task = (id: string, title: string, key: string) => ({
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
});

const item = (
  id: string,
  stageId: string,
  title: string,
  status: string,
  statusWhy: string,
  extra: Partial<BanneretMapItem> = {},
): BanneretMapItem => ({
  id,
  stageId,
  title,
  status,
  statusWhy,
  restsOn: [],
  blockedBy: [],
  ...extra,
});

/** One item per status; stages listed out of order, and one stage with nothing in it. */
const MAP = (): BanneretMap => ({
  state: "ok",
  notMeasured: [],
  stages: [
    { id: "s2", title: "Social", order: 20 },
    { id: "s3", title: "Later", order: 30 },
    { id: "s1", title: "Foundations", order: 10 },
  ],
  items: [
    item("sign-in", "s1", "Sign-in page", "checked", "A founder checked it after the merge.", {
      task: task("t_signin", "Sign-in page", "39"),
    }),
    item("search", "s1", "Search", "built", "The pull request merged.", {
      task: task("t_search", "Search", "40"),
    }),
    item("old-idea", "s1", "Old idea", "ruled_dead", "The issue was closed as not planned."),
    item("invites", "s2", "Guild invites", "sent_back", "Review asked for changes.", {
      task: task("t_invites", "Guild invites", "42"),
      restsOn: ["sign-in"],
    }),
    item("profile", "s2", "Profile blocks", "needs_you", "bo-example has been quiet for 7 hours.", {
      task: task("t_profile", "Profile blocks", "47"),
    }),
    item(
      "rate-limits",
      "s2",
      "Rate limits",
      "blocked",
      'Blocked by "Profile blocks", which needs you.',
      { restsOn: ["profile"], blockedBy: ["profile"] },
    ),
    // Propagation: Polish names the blocked item it rests on, not the root cause.
    item("polish", "s2", "Polish", "blocked", 'Blocked by "Rate limits", which is blocked.', {
      restsOn: ["rate-limits", "sign-in"],
      blockedBy: ["rate-limits"],
    }),
    item("docs", "s2", "Docs", "planned", "In the stage plan."),
  ],
  counters: {
    byStatus: {
      checked: 1,
      built: 1,
      ruled_dead: 1,
      sent_back: 1,
      needs_you: 1,
      blocked: 2,
      planned: 1,
    },
    byStage: {
      s1: { checked: 1, built: 1, ruled_dead: 1 },
      s2: { sent_back: 1, needs_you: 1, blocked: 2, planned: 1 },
      s3: {},
    },
  },
});

const mapRead = (
  value: BanneretMap | null,
  extra: Partial<BanneretFeedMapRead> = {},
): BanneretFeedMapRead => ({
  value,
  fetchedAt: "2026-11-26T10:00:00.000Z",
  atWork: [],
  restsOn: true,
  checked: true,
  ...extra,
});

const state = (sections: string[], map: BanneretFeedMapRead | null): BanneretFeedState => ({
  joined: true,
  live: true,
  since: "2026-11-26T09:59:00.000Z",
  sectionsKnown: true,
  sections,
  needsCount: null,
  revision: 1,
  board: null,
  map,
  feed: null,
  graveyard: null,
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
    </SidebarProvider>
  );
}

async function openMap(stack: DisposableStack, path = "/map") {
  await page.viewport(1600, 900);
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  stack.defer(() => style.remove());
  const harness = setup();
  const root = createRootRoute({ component: Shell });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/", component: () => <p>Home</p> }),
      createRoute({ getParentRoute: () => root, path: "/map", component: MapPage }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
    disableGlobalCatchBoundary: true,
  });
  const screen = await render(<RouterProvider router={router} />, { router: false });
  await vi.waitFor(() => expect(harness.subscribe).toHaveBeenCalled());
  return { ...harness, router, screen };
}

const sidebar = () => page.getByRole("navigation", { name: "Sidebar" });
const itemRow = (id: string, scope: ParentNode = document) =>
  scope.querySelector<HTMLElement>(`[data-item-id="${id}"]`);
const cardOf = (id: string) => itemRow(id)?.querySelector<HTMLElement>("[data-slot=map-item]");
const legend = () => document.querySelector('[aria-label="Status legend"]')!;
const countIn = (scope: Element, status: string) =>
  scope.querySelector(`li[data-status="${status}"] [data-count]`)?.textContent;
const stageRow = (title: string) =>
  document.querySelector<HTMLElement>(`li[data-stage-id][aria-label="${title}"]`)!;
const viewToggle = (name: string) => page.getByRole("button", { name, exact: true });
const picker = () => page.getByRole("combobox", { name: /^Item:/ });

async function pick(title: string) {
  await userEvent.click(picker());
  await userEvent.fill(page.getByRole("combobox", { name: "Search items" }), title);
  await userEvent.click(page.getByRole("option", { name: new RegExp(`^${title}`) }));
}

describe("Enterprise build map", () => {
  it("draws stage rows on a spine with progress, compact items and the counted legend", async () => {
    using stack = new DisposableStack();
    const { emit, router, screen } = await openMap(stack, "/");
    await using _screen = screen;
    await emit(state(["today", "map"], mapRead(MAP())));

    await userEvent.click(sidebar().getByRole("button", { name: "Map" }));
    expect(router.state.location.pathname).toBe("/map");
    await expect.element(page.getByText("Old idea")).toBeVisible();
    await expect.element(page.getByRole("heading", { level: 1, name: "Build map" })).toBeVisible();
    expect(document.querySelector("header p")?.textContent).toBe(
      "8 items in 3 stages · 2 built · 2 blocked",
    );

    const stages = [...document.querySelectorAll("li[data-stage-id] h2")].map(
      (heading) => heading.textContent,
    );
    expect(stages).toEqual(["Foundations", "Social", "Later"]);
    expect(
      [...stageRow("Foundations").querySelectorAll("[data-item-id]")].map((row) =>
        row.getAttribute("data-item-id"),
      ),
    ).toEqual(["sign-in", "search", "old-idea"]);

    // Built plus checked out of every item that is not dropped; the spine marks each stage.
    expect(stageRow("Foundations").querySelector("[data-progress]")?.textContent).toBe("2/2 built");
    expect(stageRow("Social").querySelector("[data-progress]")?.textContent).toBe("0/5 built");
    expect(stageRow("Later").textContent).toContain("Nothing planned in this stage.");
    expect(stageRow("Later").querySelector("[data-progress]")).toBeNull();
    expect(
      [...document.querySelectorAll("li[data-stage-id]")].map((row) =>
        row.getAttribute("data-spine"),
      ),
    ).toEqual(["done", "current", "todo"]);

    // Each card has its status icon and word, but never the relay's reason as text.
    for (const [id, status] of [
      ["old-idea", "ruled_dead"],
      ["sign-in", "checked"],
      ["invites", "sent_back"],
      ["profile", "needs_you"],
      ["rate-limits", "blocked"],
      ["search", "built"],
      ["docs", "planned"],
    ] as const) {
      expect(cardOf(id)?.getAttribute("data-status")).toBe(status);
    }
    expect(cardOf("search")!.textContent).toContain("Built, needs a check");
    expect(document.querySelector('[role="main"]')!.textContent).not.toContain(
      "The pull request merged.",
    );
    await userEvent.hover(cardOf("search")!);
    await expect.element(page.getByText("The pull request merged.")).toBeVisible();

    expect(countIn(legend(), "needs_you")).toBe("1");
    expect(countIn(legend(), "blocked")).toBe("2");
    expect(countIn(legend(), "checked")).toBe("1");
    expect(countIn(legend(), "planned")).toBe("1");

    // Without the sign-off rule the legend leaves Checked out.
    await emit(state(["map"], mapRead(MAP(), { checked: false })));
    await vi.waitFor(() => expect(legend().querySelector('[data-status="checked"]')).toBeNull());
  });

  it("says which item blocks a blocked one, and the relay's reason on hover", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openMap(stack);
    await using _screen = screen;
    const map = MAP();
    const items = map.items.map((entry) =>
      entry.id === "polish" ? { ...entry, blockedBy: ["rate-limits", "profile", "ghost"] } : entry,
    );
    await emit(state(["map"], mapRead({ ...map, items })));
    await expect.element(page.getByText("Rate limits")).toBeVisible();
    const note = (id: string) => itemRow(id)!.querySelector("[data-slot=map-item-note]");
    expect(note("rate-limits")?.textContent).toBe("Blocked by Profile blocks");
    expect(itemRow("rate-limits")!.getAttribute("data-blocked-by")).toBe("profile");
    // The dependant names its direct blocker, not the root cause, and how many more.
    expect(note("polish")?.textContent).toBe("Blocked by Rate limits and 2 more");
    expect(note("profile")).toBeNull();
    await userEvent.hover(cardOf("rate-limits")!);
    await expect
      .element(
        page.getByText('Not on the board yet. Blocked by "Profile blocks", which needs you.'),
      )
      .toBeVisible();
  });

  it("puts the picked item between what it needs first and what it unblocks", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openMap(stack);
    await using _screen = screen;
    await emit(state(["map"], mapRead(MAP())));
    await userEvent.click(viewToggle("Rests on"));
    await expect.element(viewToggle("Rests on")).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector("select")).toBeNull();

    const needs = () => page.getByRole("region", { name: "Needs these first" }).element();
    const unblocks = () => page.getByRole("region", { name: "Unblocks these" }).element();
    const centre = () => page.getByRole("region", { name: "Picked item" }).element();
    const ids = (scope: Element) =>
      [...scope.querySelectorAll("[data-item-id]")].map((row) => row.getAttribute("data-item-id"));
    const direct = () =>
      [...needs().querySelectorAll("[data-direct-blocker]")].map((mark) =>
        mark.closest("[data-item-id]")?.getAttribute("data-item-id"),
      );

    // The first item that rests on something is picked first.
    await expect.element(picker()).toHaveTextContent("Guild invites");
    expect(centre().getAttribute("data-item-id")).toBe("invites");

    // The picker searches by title.
    await pick("Rate limits");
    await vi.waitFor(() => expect(centre().getAttribute("data-item-id")).toBe("rate-limits"));
    expect(ids(needs())).toEqual(["profile"]);
    expect(ids(unblocks())).toEqual(["polish"]);
    expect(centre().textContent).toContain("Blocked by Profile blocks");
    expect(direct()).toEqual(["profile"]);

    // A side card becomes the picked item; only the direct blocker is marked.
    await userEvent.click(unblocks().querySelector('[data-item-id="polish"] button')!);
    await vi.waitFor(() => expect(centre().getAttribute("data-item-id")).toBe("polish"));
    expect(ids(needs())).toEqual(["rate-limits", "sign-in"]);
    expect(direct()).toEqual(["rate-limits"]);
    expect(page.getByRole("dialog").elements()).toHaveLength(0);

    await pick("Sign-in page");
    await vi.waitFor(() => expect(ids(unblocks())).toEqual(["invites", "polish"]));
    expect(ids(needs())).toEqual([]);
    expect(needs().textContent).toContain("Nothing. This can start now.");

    // The picked item with a task opens it.
    await userEvent.click(centre().querySelector("button")!);
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByRole("heading", { name: "Sign-in page" })).toBeVisible();
  });

  it("rings an item whose task has a live agent session in the work file", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openMap(stack);
    await using _screen = screen;
    await emit(state(["map"], mapRead(MAP(), { atWork: ["t_profile"] })));
    await expect.element(page.getByText("Profile blocks")).toBeVisible();
    const ringed = [...document.querySelectorAll("[data-at-work]")].map((row) =>
      row.getAttribute("data-item-id"),
    );
    expect(ringed).toEqual(["profile"]);
    expect(itemRow("profile")!.querySelector("[data-slot=at-work]")?.className).toContain("ring-2");
    expect(itemRow("profile")!.textContent).toContain("agent at work");
    expect(countIn(legend(), "needs_you")).toBe("1");
    expect(legend().querySelector("[data-slot=legend-at-work] [data-count]")?.textContent).toBe(
      "1",
    );
  });

  it("opens the Task tab from an item with a task; an item without one is not clickable", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openMap(stack);
    await using _screen = screen;
    await emit(state(["map"], mapRead(MAP())));
    await expect.element(page.getByText("Polish")).toBeVisible();

    expect(itemRow("polish")!.querySelector("button")).toBeNull();
    expect(itemRow("rate-limits")!.querySelector("button")).toBeNull();
    const inert = cardOf("polish")!;
    expect(getComputedStyle(inert).cursor).toBe("auto");
    expect(getComputedStyle(inert).borderStyle).toBe("dashed");
    const clickable = cardOf("invites")!;
    expect(clickable.tagName).toBe("BUTTON");
    expect(getComputedStyle(clickable).cursor).toBe("pointer");
    expect(clickable.textContent).toContain("#42");

    await userEvent.click(clickable);
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByRole("heading", { name: "Guild invites" })).toBeVisible();
    expect(document.querySelector('[data-task-panel="t_invites"]')).not.toBeNull();
  });

  it("gates the row and the view switch, and says when the plan is empty or not measured", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openMap(stack);
    await using _screen = screen;

    await emit(state(["today"], null));
    await expect.element(sidebar().getByRole("button", { name: "Today" })).toBeVisible();
    expect(sidebar().getByRole("button", { name: "Map" }).elements()).toHaveLength(0);
    await expect
      .element(page.getByText("Example Company does not offer a build map."))
      .toBeVisible();

    await emit(state(["today", "map"], null));
    await expect.element(sidebar().getByRole("button", { name: "Map" })).toBeVisible();
    await expect.element(page.getByText("Loading…")).toBeVisible();

    // Without the rests_on flag there is no Rests-on view.
    await emit(state(["map"], mapRead(MAP(), { restsOn: false })));
    await expect.element(page.getByText("Polish")).toBeVisible();
    expect(viewToggle("Rests on").elements()).toHaveLength(0);
    await emit(state(["map"], mapRead(MAP())));
    await expect.element(viewToggle("Rests on")).toBeVisible();

    const empty: BanneretMap = {
      state: "ok",
      notMeasured: [],
      stages: [],
      items: [],
      counters: { byStatus: {}, byStage: {} },
    };
    await emit(state(["map"], mapRead(empty)));
    await expect.element(page.getByText("This relay has no build plan yet.")).toBeVisible();
    expect(
      page.getByText("This relay has no build plan yet.").element().closest("[data-slot]"),
    ).toHaveAttribute("data-slot", "quiet-line");
    expect(viewToggle("Rests on").elements()).toHaveLength(0);

    await emit(
      state(
        ["map"],
        mapRead({
          ...empty,
          state: "not_measured",
          notMeasured: [
            {
              source: "stage_plan",
              reason: "malformed",
              since: "2026-11-26T10:00:00.000Z",
              detail: `Items a and b rest on each other, so the plan has a cycle. ${HOSTILE}`,
            },
          ],
        }),
      ),
    );
    const note = page.getByTestId("map-not-measured");
    await expect.element(note).toBeVisible();
    expect(note.element().textContent).toContain("the build plan breaks a rule");
    expect(note.element().querySelector("[data-detail]")?.textContent).toBe(
      `Items a and b rest on each other, so the plan has a cycle. ${HOSTILE}`,
    );
    expect(note.element().querySelector("img")).toBeNull();
    expect(page.getByText("This relay has no build plan yet.").elements()).toHaveLength(0);

    // The relay is away: the last good map stays, with its age.
    await emit(
      state(
        ["map"],
        mapRead(MAP(), {
          problem: { message: "Cannot reach Example Company.", since: "2026-11-26T10:05:00.000Z" },
        }),
      ),
    );
    const statusText = () => document.querySelector('[role="status"]')?.textContent ?? "";
    await vi.waitFor(() => expect(statusText()).toContain("Cannot reach Example Company."));
    expect(statusText()).toContain("Showing what Example Company said");
    await expect.element(page.getByText("Polish")).toBeVisible();
  });

  it("renders a hostile title and reason as inert text and never links a javascript: url", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openMap(stack);
    await using _screen = screen;
    const evil = item("evil", "s1", HOSTILE, "planned", HOSTILE, {
      task: {
        id: "t_evil",
        title: HOSTILE,
        ref: {
          tracker: "github",
          scope: "example-org/example-app",
          key: "9",
          url: "javascript:window.__pwned=1",
        },
        openedAt: "2026-11-20T09:00:00.000Z",
        closedAt: null,
      },
    });
    const map = MAP();
    await emit(
      state(
        ["map"],
        mapRead({
          ...map,
          stages: [{ id: "s1", title: HOSTILE, order: 1 }],
          items: [evil, item("plain", "s1", HOSTILE, "planned", HOSTILE, { restsOn: ["evil"] })],
        }),
      ),
    );
    await vi.waitFor(() => expect(itemRow("evil")).not.toBeNull());
    for (const id of ["evil", "plain"]) {
      const row = itemRow(id)!;
      expect(row.textContent).toContain(HOSTILE);
      expect(row.querySelector("img")).toBeNull();
      expect(row.querySelector("a")).toBeNull();
    }
    expect(document.querySelector('[role="main"] img')).toBeNull();
    await userEvent.click(viewToggle("Rests on"));
    await expect.element(picker()).toBeVisible();
    expect(document.querySelector('[role="main"] img')).toBeNull();
    expect(document.querySelector('[role="main"] a')).toBeNull();
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined();
  });
});
