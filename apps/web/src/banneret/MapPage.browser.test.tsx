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
});

const item = (
  id: string,
  stageId: string,
  title: string,
  status: string,
  statusWhy: string,
  extra: Partial<BanneretMapItem> = {},
): BanneretMapItem => ({ id, stageId, title, status, statusWhy, restsOn: [], ...extra });

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
      "needs_you",
      'It rests on "Profile blocks", which needs you.',
      { restsOn: ["profile"] },
    ),
    item("polish", "s2", "Polish", "planned", "In the stage plan.", {
      restsOn: ["rate-limits", "sign-in"],
    }),
  ],
  counters: {
    byStatus: { checked: 1, built: 1, ruled_dead: 1, sent_back: 1, needs_you: 2, planned: 1 },
    byStage: {
      s1: { checked: 1, built: 1, ruled_dead: 1 },
      s2: { sent_back: 1, needs_you: 2, planned: 1 },
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
const markOf = (id: string) => itemRow(id)?.querySelector("[data-status]")?.textContent ?? "";
const legend = () => document.querySelector('[aria-label="Status legend"]')!;
const countIn = (scope: Element, status: string) =>
  scope.querySelector(`li:has(> [data-status="${status}"]) [data-count]`)?.textContent;

describe("Enterprise build map", () => {
  it("draws stages in order, every status mark with its word, and the counters", async () => {
    using stack = new DisposableStack();
    const { emit, router, screen } = await openMap(stack, "/");
    await using _screen = screen;
    await emit(state(["today", "map"], mapRead(MAP())));

    await userEvent.click(sidebar().getByRole("button", { name: "Map" }));
    expect(router.state.location.pathname).toBe("/map");
    await expect.element(page.getByText("Old idea")).toBeVisible();

    const stages = [...document.querySelectorAll("section[data-stage-id] h2")].map(
      (heading) => heading.textContent,
    );
    expect(stages).toEqual(["Foundations", "Social", "Later"]);
    const foundations = page.getByRole("region", { name: "Foundations" }).element();
    expect(
      [...foundations.querySelectorAll("[data-item-id]")].map((row) =>
        row.getAttribute("data-item-id"),
      ),
    ).toEqual(["sign-in", "search", "old-idea"]);
    await expect
      .element(
        page.getByRole("region", { name: "Later" }).getByText("Nothing planned in this stage."),
      )
      .toBeVisible();

    const marks: Array<[string, string, string]> = [
      ["old-idea", "†", "ruled dead"],
      ["sign-in", "●", "checked"],
      ["invites", "✕", "sent back"],
      ["profile", "◆", "needs you or blocked"],
      ["search", "◐", "built, unchecked"],
      ["polish", "○", "planned"],
    ];
    for (const [id, mark, word] of marks) {
      expect(markOf(id)).toContain(mark);
      expect(markOf(id)).toContain(word);
    }
    // The relay's reason shows on its own line.
    expect(itemRow("search")?.querySelector("[data-status-why]")?.textContent).toBe(
      "The pull request merged.",
    );

    // Totals ride on the shared legend; each stage shows its own counts.
    expect(countIn(legend(), "needs_you")).toBe("2");
    expect(countIn(legend(), "checked")).toBe("1");
    expect(countIn(legend(), "planned")).toBe("1");
    const social = document.querySelector('[aria-label="Social counts"]')!;
    expect(countIn(social, "needs_you")).toBe("2");
    expect(countIn(social, "sent_back")).toBe("1");
    expect(countIn(social, "checked")).toBeUndefined();
    const foundationCounts = document.querySelector('[aria-label="Foundations counts"]')!;
    expect(countIn(foundationCounts, "ruled_dead")).toBe("1");
    expect(document.querySelector('[aria-label="Later counts"]')).toBeNull();

    // Without the sign-off rule the legend leaves the checked mark out.
    await emit(state(["map"], mapRead(MAP(), { checked: false })));
    await vi.waitFor(() => expect(legend().textContent).not.toContain("●"));
  });

  it("shows the blocker's name on a blocked dependant", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openMap(stack);
    await using _screen = screen;
    await emit(state(["map"], mapRead(MAP())));
    await expect.element(page.getByText("Rate limits")).toBeVisible();
    const blocked = itemRow("rate-limits")!;
    expect(blocked.querySelector("[data-status]")?.textContent).toContain("◆");
    expect(blocked.querySelector("[data-status-why]")?.textContent).toBe(
      'It rests on "Profile blocks", which needs you.',
    );
  });

  it("lists what an item rests on and what rests on it", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openMap(stack);
    await using _screen = screen;
    await emit(state(["map"], mapRead(MAP())));
    await userEvent.click(page.getByRole("tab", { name: "Rests on" }));
    await expect
      .element(page.getByRole("tab", { name: "Rests on" }))
      .toHaveAttribute("aria-selected", "true");

    const restsOn = () => page.getByRole("region", { name: "It rests on" }).element();
    const dependants = () => page.getByRole("region", { name: "Rests on it" }).element();
    const ids = (scope: Element) =>
      [...scope.querySelectorAll("[data-item-id]")].map((row) => row.getAttribute("data-item-id"));

    // The first item that rests on something is picked first.
    const select = page.getByRole("combobox", { name: "Item" });
    await expect.element(select).toHaveValue("invites");
    await userEvent.selectOptions(select, "rate-limits");
    await vi.waitFor(() => expect(ids(restsOn())).toEqual(["profile"]));
    expect(ids(dependants())).toEqual(["polish"]);
    // The blocked item names its blocker.
    const selected = page.getByRole("list", { name: "Selected item" }).element();
    expect(selected.querySelector("[data-status-why]")?.textContent).toContain('"Profile blocks"');

    await userEvent.selectOptions(select, "sign-in");
    await vi.waitFor(() => expect(ids(dependants())).toEqual(["invites", "polish"]));
    expect(ids(restsOn())).toEqual([]);
    expect(restsOn().textContent).toContain("Nothing.");
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
    const ring = itemRow("profile")!.querySelector("[data-status] > span[aria-hidden]")!;
    expect(ring.className).toContain("ring-2");
    expect(itemRow("profile")!.textContent).toContain("agent at work");
  });

  it("opens the Task tab from an item with a task; an item without one is not clickable", async () => {
    using stack = new DisposableStack();
    const { emit, screen } = await openMap(stack);
    await using _screen = screen;
    await emit(state(["map"], mapRead(MAP())));
    await expect.element(page.getByText("Polish")).toBeVisible();

    expect(itemRow("polish")!.querySelector("button")).toBeNull();
    expect(itemRow("rate-limits")!.querySelector("button")).toBeNull();
    expect(itemRow("polish")!.querySelector("[tabindex]")).toBeNull();

    await userEvent.click(itemRow("invites")!.querySelector("[data-open-task]")!);
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByRole("heading", { name: "Guild invites" })).toBeVisible();
    expect(document.querySelector('[data-task-panel="t_invites"]')).not.toBeNull();
  });

  it("gates the row and the tab, and says when the plan is empty or not measured", async () => {
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

    // Without the rests_on flag there is no Rests-on tab.
    await emit(state(["map"], mapRead(MAP(), { restsOn: false })));
    await expect.element(page.getByText("Polish")).toBeVisible();
    expect(page.getByRole("tab").elements()).toHaveLength(0);
    await emit(state(["map"], mapRead(MAP())));
    await expect.element(page.getByRole("tab", { name: "Rests on" })).toBeVisible();

    const empty: BanneretMap = {
      state: "ok",
      notMeasured: [],
      stages: [],
      items: [],
      counters: { byStatus: {}, byStage: {} },
    };
    await emit(state(["map"], mapRead(empty)));
    await expect.element(page.getByText("This relay has no build plan yet.")).toBeVisible();
    expect(page.getByRole("tab").elements()).toHaveLength(0);

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
      },
    });
    const map = MAP();
    await emit(
      state(
        ["map"],
        mapRead({
          ...map,
          stages: [{ id: "s1", title: HOSTILE, order: 1 }],
          items: [evil, item("plain", "s1", HOSTILE, "planned", HOSTILE)],
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
    await userEvent.click(page.getByRole("tab", { name: "Rests on" }));
    await expect.element(page.getByRole("combobox", { name: "Item" })).toBeVisible();
    expect(document.querySelector('[role="main"] img')).toBeNull();
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined();
  });
});
