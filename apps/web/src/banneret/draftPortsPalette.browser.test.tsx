import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { CommandPalette } from "../components/CommandPalette";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import type { DraftThreadState } from "../composerDraftStore";
import { useRightPanelStore } from "../rightPanelStore";

vi.mock(import("~/environments/primary/target"), async (original) => ({
  ...(await original()),
  readPrimaryEnvironmentTarget: () => null,
}));

const state = vi.hoisted(() => ({ draft: null as DraftThreadState | null }));
vi.mock(import("../hooks/useHandleNewThread"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useHandleNewThread: () => ({
      ...actual.useHandleNewThread(),
      activeThread: null,
      activeDraftThread: state.draft,
    }),
  };
});

it("opens Show ports in a draft thread's right panel", async () => {
  const environmentId = EnvironmentId.make("remote");
  const threadId = ThreadId.make("draft-thread");
  state.draft = {
    threadId,
    environmentId,
    projectId: ProjectId.make("project"),
    logicalProjectKey: "remote:project",
    createdAt: "2026-03-01T00:00:00.000Z",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    envMode: "local",
    startFromOrigin: false,
  };
  const draftRef = scopeThreadRef(environmentId, threadId);
  useRightPanelStore.getState().removeThread(draftRef);
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

  openCommandPalette({ query: "Show ports" });
  await userEvent.click(page.getByRole("option", { name: /Show ports/ }));

  await expect.poll(() => useCommandPaletteStore.getState().open).toBe(false);
  const panel = useRightPanelStore.getState().byThreadKey[scopedThreadKey(draftRef)];
  expect(panel?.isOpen).toBe(true);
  expect(panel?.activeSurfaceId).toBe("ports");
  expect(panel?.surfaces.map((surface) => surface.kind)).toContain("ports");
});
