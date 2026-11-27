import { useGitHubLogin } from "./accountIdentity";
import appCss from "../index.css?inline";
import {
  EnvironmentId,
  mergeBanneretWorkspaces,
  ProjectId,
  type BanneretEnrolmentView,
  type BanneretWorkspace,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import {
  useConnectedEnvironmentIds,
  useEnvironmentIdentities,
  usePrimaryEnvironmentId,
} from "../state/environments";
import {
  useDelegatedUnderParent,
  useProject,
  useProjects,
  useQuietThreadShells,
  useThreadShell,
  useServerConfigs,
} from "../state/entities";
import type { Project } from "../types";
import { enrolmentRpc, refreshEnrolment, useEnrolmentStore } from "./enrolmentStore";
import { WorkspacesHost } from "./WorkspacesHost";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import {
  loadEnvironmentWorkspaces,
  openWorkspaceDialog,
  useWorkspacesStore,
  workspacesRpc,
} from "./workspacesStore";

const state = vi.hoisted(() => ({ openExternal: vi.fn() }));

vi.mock("./accountIdentity", async (load) => ({
  ...(await load<typeof import("./accountIdentity")>()),
  useGitHubLogin: vi.fn(() => null),
}));
vi.mock("../state/entities", { spy: true });
vi.mock("../state/environments", { spy: true });
vi.mock(import("../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: () => ({ shell: { openExternal: state.openExternal } }) as never,
}));

const LOCAL = EnvironmentId.make("local");
// A Tailscale relay on a non-default port, as the live relay runs.
const ORIGIN = "https://relay-host.tail0000.ts.net:10000";
const WORKSPACE_ID = "ent-0123456789abcdef";
const TARGET = { environmentId: LOCAL, relayOrigin: ORIGIN };
/** A second company's relay, joined from the same machine. */
const OTHER_ORIGIN = "https://oss-relay.example.org";
const OTHER_ID = "ent-fedcba9876543210";

/** A `none` view of a relay, with the last result. */
const none = (reason?: string, origin = ORIGIN): BanneretEnrolmentView => ({
  state: "none",
  workspaceId: origin === ORIGIN ? WORKSPACE_ID : OTHER_ID,
  relayOrigin: origin,
  ...(reason === undefined ? {} : { reason }),
});
const HOSTILE = '<img src=x onerror="window.__pwned=1">';

function project(id: string, remoteUrl: string | null): Project {
  return {
    id: ProjectId.make(id),
    environmentId: LOCAL,
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity:
      remoteUrl === null
        ? null
        : {
            canonicalKey: `github.com/example-org/${id}`,
            locator: { source: "git-remote", remoteName: "origin", remoteUrl },
            displayName: `example-org/${id}`,
          },
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

const projects = [
  project("alpha", "git@github.com:example-org/alpha.git"),
  project("beta", "git@github.com:other-org/beta.git"),
];

/** A stubbed environment: what the server would answer, driven by the test. */
function setup(displayName = "Example Company") {
  useWorkspacesStore.setState({
    byEnvironment: {},
    local: [],
    activeId: null,
    dialog: null,
  });
  useEnrolmentStore.setState({ views: {}, machines: {}, missingStatusRpc: {} });
  vi.mocked(useGitHubLogin).mockReturnValue(null);
  state.openExternal.mockReset().mockResolvedValue(undefined);
  let stored: BanneretWorkspace[] = [];
  vi.spyOn(workspacesRpc, "list").mockImplementation(async () => ({ workspaces: stored }));
  vi.spyOn(workspacesRpc, "put").mockImplementation(async (_environmentId, workspaces) => {
    stored = mergeBanneretWorkspaces(stored, workspaces);
    return { workspaces: stored };
  });
  // What the server knows, per relay; `view` is the relay under test's.
  const views = new Map<string, BanneretEnrolmentView>();
  let view: BanneretEnrolmentView = none();
  const pending: BanneretEnrolmentView = {
    state: "requested",
    workspaceId: WORKSPACE_ID,
    relayOrigin: ORIGIN,
    displayName,
    label: "Ada laptop",
    confirmCode: "ABCD2345",
    browserUrl: `${ORIGIN}/admin/hub/enroll/pr_1`,
    expiresAt: "2099-01-01T00:10:00.000Z",
    pairingId: "pr_1",
  };
  const spies = {
    status: vi.spyOn(enrolmentRpc, "status").mockImplementation(async () => ({
      ok: true,
      value: {
        enrolments: [...views.values()]
          .filter((entry) => entry.relayOrigin !== ORIGIN)
          .concat(view.state === "none" && view.reason === undefined ? [] : [view])
          .toSorted((a, b) => a.relayOrigin.localeCompare(b.relayOrigin)),
        machine: { environmentId: "local", hostname: "ada-laptop", hubVersion: "0.1.1225" },
      },
    })),
    probe: vi.spyOn(enrolmentRpc, "probe").mockImplementation(async () => ({
      ok: true,
      value: { origin: ORIGIN, displayName },
    })),
    start: vi.spyOn(enrolmentRpc, "start").mockImplementation(async () => {
      view = pending;
      return { ok: true, value: view };
    }),
    cancel: vi.spyOn(enrolmentRpc, "cancel").mockImplementation(async () => {
      view = none("cancelled");
      return { ok: true, value: view };
    }),
    leave: vi.spyOn(enrolmentRpc, "leave"),
    machines: vi.spyOn(enrolmentRpc, "machines").mockImplementation(async () => ({
      ok: true,
      value: {
        items: [
          {
            id: "m_1",
            label: "Ada laptop",
            kind: "laptop",
            hostname: "ada",
            os: "Linux",
            ownerLogin: "ada-example",
            connected: true,
            lastHeardAt: null,
            revocable: true,
            thisMachine: true,
          },
          {
            id: "m_2",
            label: HOSTILE,
            kind: "server",
            hostname: "box",
            os: "Linux",
            ownerLogin: "grace-example",
            connected: false,
            lastHeardAt: null,
            revocable: false,
            thisMachine: false,
          },
        ],
        nextCursor: null,
      },
    })),
    revokeMachine: vi.spyOn(enrolmentRpc, "revokeMachine"),
    matchProjects: vi.spyOn(enrolmentRpc, "matchProjects").mockImplementation(async () => ({
      ok: true,
      value: { matched: ["git@github.com:example-org/alpha.git"] },
    })),
  };
  vi.mocked(useProjects).mockReturnValue(projects);
  vi.mocked(useQuietThreadShells).mockReturnValue([]);
  vi.mocked(useDelegatedUnderParent).mockReturnValue(new Set());
  vi.mocked(useConnectedEnvironmentIds).mockReturnValue([LOCAL]);
  vi.mocked(useEnvironmentIdentities).mockReturnValue([]);
  vi.mocked(usePrimaryEnvironmentId).mockReturnValue(LOCAL);
  vi.mocked(useThreadShell).mockReturnValue(null);
  vi.mocked(useProject).mockReturnValue(null);
  return {
    spies,
    setView: async (next: BanneretEnrolmentView) => {
      if (next.relayOrigin === ORIGIN) view = next;
      else views.set(next.relayOrigin, next);
      await act(async () => {
        await refreshEnrolment(LOCAL);
      });
    },
    serverWritesWorkspace: (origin = ORIGIN, name = displayName) => {
      stored = mergeBanneretWorkspaces(stored, [
        {
          id: origin === ORIGIN ? WORKSPACE_ID : OTHER_ID,
          name,
          kind: "enterprise",
          projectKeys: [],
          relay: { origin, displayName: name },
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
    },
    stored: () => stored,
    pending,
  };
}

async function prepareScreen(stack: DisposableStack) {
  await page.viewport(1280, 800);
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  stack.defer(() => style.remove());
}

function Harness() {
  return (
    <>
      <WorkspaceSwitcher homeLabel="T3 Code home" onBackdrop={false}>
        <span>Brand</span>
      </WorkspaceSwitcher>
      <WorkspacesHost />
    </>
  );
}

const relaySpies = (spies: ReturnType<typeof setup>["spies"]) => Object.values(spies);

describe("EnterpriseWizard", () => {
  it("manages each connected machine on the selected company's relay", async () => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    const server = setup();
    const remote = EnvironmentId.make("banneret-old");
    const pending = EnvironmentId.make("banneret-dev");
    const revoked = EnvironmentId.make("removed-server");
    const legacy = EnvironmentId.make("older-mac");
    const missing = EnvironmentId.make("missing-rpc");
    const connected = [LOCAL, remote, pending, revoked, legacy, missing];
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map([[legacy, { environment: { serverVersion: "0.1.1218" } }]]) as unknown as ReturnType<
        typeof useServerConfigs
      >,
    );
    vi.mocked(useConnectedEnvironmentIds).mockReturnValue(connected);
    const joined = { ...server.pending, state: "configured" } as const;
    const records = new Map<EnvironmentId, BanneretEnrolmentView[]>([
      [LOCAL, [joined]],
      [remote, [{ ...joined, relayOrigin: OTHER_ORIGIN }]],
      [pending, [server.pending]],
      [revoked, [{ ...joined, state: "revoked" }]],
    ]);
    server.serverWritesWorkspace();
    server.spies.status.mockImplementation(async (id) =>
      id === missing
        ? { ok: false, message: "Unknown request tag: banneretRelay.status" }
        : {
            ok: true,
            value: {
              machine: { environmentId: id, hostname: id, hubVersion: "1.0" },
              enrolments: records.get(id) ?? [],
            },
          },
    );
    await using _screen = await render(<Harness />);
    const machines = async () => {
      await act(() => openWorkspaceDialog({ kind: "machines", origin: ORIGIN }));
    };
    await machines();
    await expect
      .element(page.getByRole("listitem", { name: legacy }))
      .toHaveTextContent(
        "older-macUpdate needed to read its status (v0.1.1218)Update Banneret Hub on older-mac.",
      );
    await expect
      .element(page.getByRole("listitem", { name: missing }))
      .toHaveTextContent(
        "missing-rpcUpdate needed to read its statusUpdate Banneret Hub on missing-rpc.",
      );
    const row = page.getByRole("listitem", { name: pending });
    await expect.element(row.getByText(/ABCD2345/)).toBeVisible();
    const copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    stack.defer(() => copied.mockRestore());
    await userEvent.click(row.getByRole("button", { name: "Copy details" }));
    expect(copied).toHaveBeenCalledWith(expect.stringContaining("Environment: banneret-dev"));
    await expect
      .element(page.getByRole("listitem", { name: remote }).getByText("Not joined"))
      .toBeVisible();
    await expect
      .element(page.getByRole("listitem", { name: LOCAL }).getByText("Joined"))
      .toBeVisible();
    await expect
      .element(page.getByRole("listitem", { name: revoked }).getByText("Revoked"))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Join banneret-old…" }));
    const picker = page.getByRole("combobox", { name: "Machine" });
    await expect.element(picker).toHaveTextContent(remote);
    await expect.element(page.getByText("Joining banneret-old to Example Company")).toBeVisible();
    await userEvent.click(picker);
    await userEvent.click(page.getByRole("option", { name: pending }));
    await expect.element(page.getByLabelText("Confirm code")).toHaveTextContent("ABCD2345");
    await userEvent.click(picker);
    await userEvent.click(page.getByRole("option", { name: remote }));
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await userEvent.click(page.getByRole("button", { name: "Join Example Company" }));
    expect(server.spies.start).toHaveBeenCalledWith(
      remote,
      expect.objectContaining({ origin: ORIGIN }),
    );
    records.set(remote, [joined]);
    await act(async () => {
      await refreshEnrolment(remote);
    });
    await machines();
    await userEvent.click(page.getByRole("button", { name: "Leave banneret-old…" }));
    server.spies.leave.mockResolvedValue({ ok: true, value: none("left") });
    await userEvent.click(page.getByRole("button", { name: "Leave", exact: true }));
    expect(server.spies.leave).toHaveBeenCalledWith(
      { environmentId: remote, relayOrigin: ORIGIN },
      "revoke",
      true,
    );
  });

  it("walks address, Join, code, approval and projects, and opens sign-in without the code", async () => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    const server = setup();
    await using _screen = await render(<Harness />);

    await userEvent.click(page.getByRole("button", { name: "Switch workspace" }));
    await userEvent.click(page.getByRole("menuitem", { name: "New workspace…" }));
    await userEvent.click(page.getByRole("button", { name: "Enterprise" }));
    await userEvent.fill(page.getByLabelText("Relay address"), "relay-host.tail0000.ts.net:10000");
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    expect(server.spies.probe).toHaveBeenCalledWith(LOCAL, "relay-host.tail0000.ts.net:10000");

    await userEvent.fill(page.getByLabelText("Name for this machine"), "Ada laptop");
    await userEvent.click(page.getByRole("button", { name: "Server" }));
    await userEvent.click(page.getByRole("button", { name: "Join Example Company" }));
    expect(server.spies.start).toHaveBeenCalledWith(LOCAL, {
      origin: ORIGIN,
      label: "Ada laptop",
      kind: "server",
    });

    await expect.element(page.getByLabelText("Confirm code")).toHaveTextContent("ABCD2345");
    // The relay's own URL, verbatim: its origin check compares the exact host and port.
    expect(state.openExternal.mock.calls[0]?.[0]).toBe(
      "https://relay-host.tail0000.ts.net:10000/admin/hub/enroll/pr_1",
    );
    for (const [url] of state.openExternal.mock.calls) expect(url).not.toContain("ABCD2345");
    await userEvent.click(page.getByRole("button", { name: "Open sign-in page" }));
    expect(state.openExternal).toHaveBeenCalledTimes(2);

    await server.setView({ ...server.pending, state: "awaiting_approval" });
    await expect.element(page.getByText(/Waiting for a founder to approve/)).toBeVisible();

    await server.setView({
      state: "approved",
      workspaceId: WORKSPACE_ID,
      relayOrigin: ORIGIN,
      displayName: "Example Company",
      machineId: "m_1",
      label: "Ada laptop",
    });
    await expect.element(page.getByText("Finishing setup…")).toBeVisible();

    server.serverWritesWorkspace();
    await server.setView({
      state: "configured",
      workspaceId: WORKSPACE_ID,
      relayOrigin: ORIGIN,
      displayName: "Example Company",
      machineId: "m_1",
      label: "Ada laptop",
      me: { login: "ada-example", role: "founder" },
      replacedLabel: "Old laptop",
      health: "healthy",
    });
    await expect.element(page.getByText("Signed in as ada-example · Founder")).toBeVisible();
    await expect.element(page.getByText("This replaced Old laptop")).toBeVisible();
    // The project whose remote is in the company's list comes pre-ticked; the other does not.
    await expect
      .element(page.getByText("Ticked: projects in Example Company's repository list."))
      .toBeVisible();
    expect(server.spies.matchProjects).toHaveBeenCalledWith(
      TARGET,
      expect.arrayContaining(["git@github.com:example-org/alpha.git"]),
    );
    const alpha = page.getByRole("checkbox").first();
    const beta = page.getByRole("checkbox").last();
    await expect.element(alpha).toBeChecked();
    await expect.element(beta).not.toBeChecked();
    await userEvent.click(page.getByRole("button", { name: "Save projects" }));
    await vi.waitFor(() =>
      expect(server.stored().find((entry) => entry.id === WORKSPACE_ID)?.projectKeys).toEqual([
        "repo:github.com/example-org/alpha",
      ]),
    );
    expect(useWorkspacesStore.getState().activeId).toBe(WORKSPACE_ID);

    vi.mocked(useGitHubLogin).mockReturnValue("tracker-example");
    // The switcher row shows this machine's status.
    await userEvent.click(page.getByRole("button", { name: "Switch workspace" }));
    await expect
      .element(page.getByRole("menu").getByText("Signed in as ada-example · Founder"))
      .toBeVisible();
    await expect.element(page.getByText("· GitHub: tracker-example")).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Machines…" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Leave…" })).toBeVisible();
  });

  it.each([
    ["declined", "A founder declined this machine. Relay sign-in: Not available."],
    ["code_expired", "The code expired before it was confirmed. Join again."],
  ])("returns to the address with the reason after %s", async (reason, message) => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    const server = setup();
    await using _screen = await render(<Harness />);
    await act(() => openWorkspaceDialog({ kind: "enterprise" }));
    await userEvent.fill(page.getByLabelText("Relay address"), ORIGIN);
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await userEvent.click(page.getByRole("button", { name: "Join Example Company" }));
    await expect.element(page.getByLabelText("Confirm code")).toBeVisible();
    await server.setView(none(reason));
    await expect.element(page.getByRole("status")).toHaveTextContent(message);
    await expect.element(page.getByLabelText("Relay address")).toHaveValue(ORIGIN);
  });

  it("drops the last result as soon as a new Join starts", async () => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    const server = setup();
    await using _screen = await render(<Harness />);
    await server.setView(none("cancelled"));
    // The last result belongs to that relay: it shows when the wizard opens for it.
    await act(() => openWorkspaceDialog({ kind: "enterprise", origin: ORIGIN }));
    await expect.element(page.getByRole("status")).toHaveTextContent("Joining was cancelled.");

    await userEvent.fill(page.getByLabelText("Relay address"), ORIGIN);
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await expect.element(page.getByText("Joining was cancelled.")).not.toBeInTheDocument();

    // While the start is in flight, and after it fails, the old result stays gone.
    let finish: (value: { ok: false; message: string }) => void = () => {};
    server.spies.start.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await userEvent.click(page.getByRole("button", { name: "Join Example Company" }));
    await expect.element(page.getByRole("button", { name: "Join Example Company" })).toBeDisabled();
    await expect.element(page.getByText("Joining was cancelled.")).not.toBeInTheDocument();
    await act(async () => finish({ ok: false, message: "The relay is unavailable." }));
    await expect.element(page.getByRole("alert")).toHaveTextContent("The relay is unavailable.");
    await expect.element(page.getByText("Joining was cancelled.")).not.toBeInTheDocument();
  });

  it("renders hostile relay strings as text and never fetches an icon", async () => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    const server = setup(HOSTILE);
    const fetched: string[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) fetched.push(entry.name);
    });
    observer.observe({ type: "resource", buffered: false });
    stack.defer(() => observer.disconnect());
    await using _screen = await render(<Harness />);

    await act(() => openWorkspaceDialog({ kind: "enterprise" }));
    await userEvent.fill(page.getByLabelText("Relay address"), ORIGIN);
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await expect
      .element(page.getByRole("button", { name: `Join ${HOSTILE}`, exact: true }))
      .toBeVisible();

    server.serverWritesWorkspace();
    await server.setView({
      state: "configured",
      workspaceId: WORKSPACE_ID,
      relayOrigin: ORIGIN,
      displayName: HOSTILE,
      machineId: "m_1",
      label: "Ada laptop",
      me: { login: "ada-example", role: "founder" },
      health: "healthy",
    });
    await act(() => openWorkspaceDialog({ kind: "machines", origin: ORIGIN }));
    await expect.element(page.getByText(HOSTILE, { exact: true })).toBeVisible();
    await expect.element(page.getByText("This machine")).toBeVisible();

    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    expect(fetched.filter((name) => name.endsWith("/x"))).toEqual([]);
  });

  it("lets a stuck setup be cancelled or forgotten, and shows why it is stuck", async () => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    const server = setup();
    server.spies.leave.mockImplementation(async () => ({
      ok: true,
      value: none("forgotten"),
    }));
    await using _screen = await render(<Harness />);
    const approved: BanneretEnrolmentView = {
      state: "approved",
      workspaceId: WORKSPACE_ID,
      relayOrigin: ORIGIN,
      displayName: "Example Company",
      machineId: "m_1",
      label: "Ada laptop",
    };
    await server.setView(approved);
    await act(() => openWorkspaceDialog({ kind: "enterprise", origin: ORIGIN }));
    await expect.element(page.getByText("Finishing setup…")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(page.getByRole("button", { name: "Forget this machine here" }).query()).toBeNull();

    await server.setView({ ...approved, health: "forbidden" });
    await expect
      .element(
        page.getByText("The relay does not allow this machine. Relay account: Not available."),
      )
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Forget this machine here" }));
    expect(server.spies.leave).toHaveBeenCalledWith(TARGET, "forget", false);
    // The stub's leave does not change what status answers; make the server agree.
    await server.setView(none("forgotten"));
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent(
        "This machine was forgotten here. A founder must still remove it on the relay.",
      );

    await server.setView({ ...approved, health: "unreachable" });
    await expect
      .element(page.getByText(/^Cannot reach relay-host\.tail0000\.ts\.net:10000/))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Cancel" }));
    expect(server.spies.cancel).toHaveBeenCalledWith(TARGET);
    await expect.element(page.getByLabelText("Relay address")).toBeVisible();
  });

  it("offers Join again in the switcher after a 401, and keeps the view when a read fails", async () => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    const server = setup();
    await using _screen = await render(<Harness />);
    server.serverWritesWorkspace();
    await act(async () => {
      await loadEnvironmentWorkspaces(LOCAL);
      useWorkspacesStore.setState({ activeId: WORKSPACE_ID });
    });
    const refused: BanneretEnrolmentView = {
      state: "configured",
      workspaceId: WORKSPACE_ID,
      relayOrigin: ORIGIN,
      displayName: "Example Company",
      machineId: "m_1",
      label: "Ada laptop",
      me: { login: "ada-example", role: "founder" },
      health: "refused",
    };
    await server.setView(refused);
    await act(() => openWorkspaceDialog({ kind: "leave", origin: ORIGIN }));
    await expect
      .element(page.getByText(/The relay refused this machine, so it cannot confirm/))
      .toBeVisible();
    await act(() => useWorkspacesStore.setState({ dialog: null }));

    server.spies.status.mockImplementation(async () => ({ ok: false, message: "Lost." }));
    await act(async () => {
      await refreshEnrolment(LOCAL);
    });
    expect(useEnrolmentStore.getState().views[LOCAL]).toEqual([refused]);

    await userEvent.click(page.getByRole("button", { name: "Switch workspace" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Join again…" }));
    await expect.element(page.getByLabelText("Relay address")).toHaveValue(ORIGIN);
    await expect
      .element(
        page.getByText(
          "The relay refused this machine. Join again to replace it. Relay account: ada-example.",
        ),
      )
      .toBeVisible();
  });

  it("creating a Solo workspace calls no relay RPC", async () => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    const server = setup();
    await using _screen = await render(<Harness />);

    await userEvent.click(page.getByRole("button", { name: "Switch workspace" }));
    await userEvent.click(page.getByRole("menuitem", { name: "New workspace…" }));
    await userEvent.fill(page.getByLabelText("Name"), "Client work");
    await userEvent.click(page.getByRole("button", { name: "Create workspace" }));
    await vi.waitFor(() =>
      expect(server.stored().map((entry) => entry.name)).toEqual(["Client work"]),
    );
    for (const spy of relaySpies(server.spies)) expect(spy).not.toHaveBeenCalled();
  });

  it("joins a second company from the address step, and each workspace keeps its own status", async () => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    const server = setup();
    await using _screen = await render(<Harness />);
    // This machine already belongs to Example Company.
    server.serverWritesWorkspace();
    const configured: BanneretEnrolmentView = {
      state: "configured",
      workspaceId: WORKSPACE_ID,
      relayOrigin: ORIGIN,
      displayName: "Example Company",
      machineId: "m_1",
      label: "Ada laptop",
      me: { login: "ada-example", role: "founder" },
      health: "healthy",
    };
    await server.setView(configured);
    await act(async () => {
      await loadEnvironmentWorkspaces(LOCAL);
      useWorkspacesStore.setState({ activeId: WORKSPACE_ID });
    });

    // New workspace, Enterprise: the address step, not the joined company's projects.
    await userEvent.click(page.getByRole("button", { name: "Switch workspace" }));
    await userEvent.click(page.getByRole("menuitem", { name: "New workspace…" }));
    await userEvent.click(page.getByRole("button", { name: "Enterprise" }));
    await expect.element(page.getByLabelText("Relay address")).toHaveValue("");
    expect(page.getByText("Signed in as ada-example · Founder").query()).toBeNull();

    server.spies.probe.mockImplementation(async () => ({
      ok: true,
      value: { origin: OTHER_ORIGIN, displayName: "OSS Project" },
    }));
    server.spies.start.mockImplementation(async () => ({
      ok: true,
      value: {
        state: "requested",
        workspaceId: OTHER_ID,
        relayOrigin: OTHER_ORIGIN,
        displayName: "OSS Project",
        label: "Ada laptop",
        confirmCode: "WXYZ6789",
        browserUrl: `${OTHER_ORIGIN}/admin/hub/enroll/pr_2`,
        expiresAt: "2099-01-01T00:10:00.000Z",
      },
    }));
    await userEvent.fill(page.getByLabelText("Relay address"), "oss-relay.example.org");
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await userEvent.click(page.getByRole("button", { name: "Join OSS Project" }));
    await expect.element(page.getByLabelText("Confirm code")).toHaveTextContent("WXYZ6789");

    server.serverWritesWorkspace(OTHER_ORIGIN, "OSS Project");
    await server.setView({
      state: "awaiting_approval",
      workspaceId: OTHER_ID,
      relayOrigin: OTHER_ORIGIN,
      displayName: "OSS Project",
      label: "Ada laptop",
    });
    await expect.element(page.getByText(/Waiting for a founder to approve/)).toBeVisible();
    await act(async () => {
      useWorkspacesStore.setState({ dialog: null });
      await loadEnvironmentWorkspaces(LOCAL);
    });

    // Each Enterprise row has its own status line; Machines acts on the active workspace's relay.
    await userEvent.click(page.getByRole("button", { name: "Switch workspace" }));
    const menu = page.getByRole("menu");
    await expect.element(menu.getByText("Signed in as ada-example · Founder")).toBeVisible();
    await expect.element(menu.getByText("Waiting for a founder to approve")).toBeVisible();
    await userEvent.click(page.getByRole("menuitem", { name: "Machines…" }));
    await vi.waitFor(() => expect(server.spies.machines).toHaveBeenCalledWith(TARGET));
  });

  it("lists each pending join in the switcher with its own code, and copies a join's details", async () => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    const server = setup();
    await using _screen = await render(<Harness />);
    // Two joins started one after the other; neither has a workspace until it completes.
    await server.setView(server.pending);
    await server.setView({
      state: "awaiting_approval",
      workspaceId: OTHER_ID,
      relayOrigin: OTHER_ORIGIN,
      displayName: "OSS Project",
      label: "Ada laptop",
      confirmCode: "WXYZ6789",
      pairingId: "pr_2",
      expiresAt: "2099-01-01T00:10:00.000Z",
    });

    await userEvent.click(page.getByRole("button", { name: "Switch workspace" }));
    const oss = page.getByRole("menuitem", { name: /OSS Project/ });
    await expect
      .element(oss)
      .toHaveTextContent("OSS ProjectWaiting for a founder to approve · code WXYZ6789");
    await expect
      .element(page.getByRole("menuitem", { name: /Example Company/ }))
      .toHaveTextContent("Example CompanyWaiting for sign-in · code ABCD2345");

    await userEvent.click(oss);
    await expect.element(page.getByText(/Waiting for a founder to approve \(until/)).toBeVisible();
    // Closing the join screen leaves the join running; the other one is still a pick away.
    await userEvent.keyboard("{Escape}");
    await userEvent.click(page.getByRole("button", { name: "Switch workspace" }));
    await userEvent.click(page.getByRole("menuitem", { name: /Example Company/ }));
    await expect.element(page.getByLabelText("Confirm code")).toHaveTextContent("ABCD2345");

    const copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    stack.defer(() => copied.mockRestore());
    await userEvent.click(page.getByRole("button", { name: "Copy details" }));
    await vi.waitFor(() =>
      expect(copied).toHaveBeenCalledWith(
        [
          `Relay: ${ORIGIN}`,
          "Pairing: pr_1",
          "Environment: local",
          "Hostname: ada-laptop",
          "Hub version: 0.1.1225",
        ].join("\n"),
      ),
    );
    await expect.element(page.getByRole("button", { name: "Copied" })).toBeVisible();
  });

  it("an address this machine already joined opens that workspace instead of joining again", async () => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    const server = setup();
    await using _screen = await render(<Harness />);
    server.serverWritesWorkspace();
    await server.setView({
      state: "configured",
      workspaceId: WORKSPACE_ID,
      relayOrigin: ORIGIN,
      displayName: "Example Company",
      machineId: "m_1",
      label: "Ada laptop",
      me: { login: "ada-example", role: "founder" },
      health: "healthy",
    });
    await act(async () => {
      await loadEnvironmentWorkspaces(LOCAL);
    });
    expect(useWorkspacesStore.getState().activeId).toBeNull();

    await act(() => openWorkspaceDialog({ kind: "enterprise" }));
    await userEvent.fill(page.getByLabelText("Relay address"), ORIGIN);
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent(
        "This machine has already joined Example Company. Its workspace is now open.",
      );
    expect(useWorkspacesStore.getState().activeId).toBe(WORKSPACE_ID);
    expect(page.getByRole("button", { name: "Join Example Company" }).query()).toBeNull();
    expect(server.spies.start).not.toHaveBeenCalled();
  });
});
