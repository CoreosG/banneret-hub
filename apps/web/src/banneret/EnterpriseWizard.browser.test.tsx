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

vi.mock("../state/entities", { spy: true });
vi.mock("../state/environments", { spy: true });
vi.mock(import("../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: () => ({ shell: { openExternal: state.openExternal } }) as never,
}));

const LOCAL = EnvironmentId.make("local");
const ORIGIN = "https://relay.example.com";
const WORKSPACE_ID = "ent-0123456789abcdef";
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
    supported: new Set(),
    local: [],
    activeId: null,
    dialog: null,
  });
  useEnrolmentStore.setState({ views: {} });
  state.openExternal.mockReset().mockResolvedValue(undefined);
  let stored: BanneretWorkspace[] = [];
  vi.spyOn(workspacesRpc, "list").mockImplementation(async () => ({ workspaces: stored }));
  vi.spyOn(workspacesRpc, "put").mockImplementation(async (_environmentId, workspaces) => {
    stored = mergeBanneretWorkspaces(stored, workspaces);
    return { workspaces: stored };
  });
  let view: BanneretEnrolmentView = { state: "none" };
  const pending: BanneretEnrolmentView = {
    state: "requested",
    workspaceId: WORKSPACE_ID,
    relayOrigin: ORIGIN,
    displayName,
    label: "Ada laptop",
    confirmCode: "ABCD2345",
    browserUrl: `${ORIGIN}/enroll?pairing=pr_1`,
    expiresAt: "2099-01-01T00:10:00.000Z",
  };
  const spies = {
    status: vi
      .spyOn(enrolmentRpc, "status")
      .mockImplementation(async () => ({ ok: true, value: view })),
    probe: vi.spyOn(enrolmentRpc, "probe").mockImplementation(async () => ({
      ok: true,
      value: { origin: ORIGIN, displayName, protocol: "1.0" },
    })),
    start: vi.spyOn(enrolmentRpc, "start").mockImplementation(async () => {
      view = pending;
      return { ok: true, value: view };
    }),
    cancel: vi.spyOn(enrolmentRpc, "cancel").mockImplementation(async () => {
      view = { state: "none", reason: "cancelled" };
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
      view = next;
      await act(async () => {
        await refreshEnrolment(LOCAL);
      });
    },
    serverWritesWorkspace: () => {
      stored = mergeBanneretWorkspaces(stored, [
        {
          id: WORKSPACE_ID,
          name: displayName,
          kind: "enterprise",
          projectKeys: [],
          relay: { origin: ORIGIN, displayName },
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
  it("walks address, Join, code, approval and projects, and opens sign-in without the code", async () => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    const server = setup();
    await using _screen = await render(<Harness />);

    await userEvent.click(page.getByRole("button", { name: "Switch workspace" }));
    await userEvent.click(page.getByRole("menuitem", { name: "New workspace…" }));
    await userEvent.click(page.getByRole("button", { name: "Enterprise" }));
    await userEvent.fill(page.getByLabelText("Relay address"), "relay.example.com");
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    expect(server.spies.probe).toHaveBeenCalledWith(LOCAL, "relay.example.com");

    await userEvent.fill(page.getByLabelText("Name for this machine"), "Ada laptop");
    await userEvent.click(page.getByRole("button", { name: "Server" }));
    await userEvent.click(page.getByRole("button", { name: "Join Example Company" }));
    expect(server.spies.start).toHaveBeenCalledWith(LOCAL, {
      origin: ORIGIN,
      label: "Ada laptop",
      kind: "server",
    });

    await expect.element(page.getByLabelText("Confirm code")).toHaveTextContent("ABCD2345");
    expect(state.openExternal).toHaveBeenCalledWith(server.pending.browserUrl);
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
    await expect.element(page.getByText("Connected as ada-example · Founder")).toBeVisible();
    await expect.element(page.getByText("This replaced Old laptop")).toBeVisible();
    // The project whose remote is in the company's list comes pre-ticked; the other does not.
    await expect
      .element(page.getByText("Ticked: projects in Example Company's repository list."))
      .toBeVisible();
    expect(server.spies.matchProjects).toHaveBeenCalledWith(
      LOCAL,
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

    // The switcher row shows this machine's status.
    await userEvent.click(page.getByRole("button", { name: "Switch workspace" }));
    await expect.element(page.getByText("Connected as ada-example")).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Machines…" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Leave…" })).toBeVisible();
  });

  it.each([
    ["declined", "A founder declined this machine."],
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
    await server.setView({ state: "none", reason });
    await expect.element(page.getByRole("status")).toHaveTextContent(message);
    await expect.element(page.getByLabelText("Relay address")).toHaveValue(ORIGIN);
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
    await act(() => openWorkspaceDialog({ kind: "machines" }));
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
      value: { state: "none", reason: "forgotten" },
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
    await act(() => openWorkspaceDialog({ kind: "enterprise" }));
    await expect.element(page.getByText("Finishing setup…")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(page.getByRole("button", { name: "Forget this machine here" }).query()).toBeNull();

    await server.setView({ ...approved, health: "forbidden" });
    await expect.element(page.getByText("The relay does not allow this machine")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Forget this machine here" }));
    expect(server.spies.leave).toHaveBeenCalledWith(LOCAL, "forget");
    // The stub's leave does not change what status answers; make the server agree.
    await server.setView({ state: "none", reason: "forgotten" });
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent(
        "This machine was forgotten here. A founder must still remove it on the relay.",
      );

    await server.setView({ ...approved, health: "unreachable" });
    await expect.element(page.getByText(/^Cannot reach relay\.example\.com/)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Cancel" }));
    expect(server.spies.cancel).toHaveBeenCalledWith(LOCAL);
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
    await act(() => openWorkspaceDialog({ kind: "leave" }));
    await expect
      .element(page.getByText(/The relay refused this machine, so it cannot confirm/))
      .toBeVisible();
    await act(() => useWorkspacesStore.setState({ dialog: null }));

    server.spies.status.mockImplementation(async () => ({ ok: false, message: "Lost." }));
    await act(async () => {
      await refreshEnrolment(LOCAL);
    });
    expect(useEnrolmentStore.getState().views[LOCAL]).toEqual(refused);

    await userEvent.click(page.getByRole("button", { name: "Switch workspace" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Join again…" }));
    await expect.element(page.getByLabelText("Relay address")).toHaveValue(ORIGIN);
    await expect
      .element(page.getByText("The relay refused this machine. Join again to replace it."))
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
});
