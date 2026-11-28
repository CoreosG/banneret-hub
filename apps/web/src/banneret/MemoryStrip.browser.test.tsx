import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { MemoryStrip } from "./MemoryStrip";
import "~/index.css";

const respond = vi.hoisted(() => vi.fn());
vi.mock(import("~/environments/primary/target"), async (original) => ({
  ...(await original()),
  readPrimaryEnvironmentTarget: () => null,
}));

vi.mock("@t3tools/client-runtime/state/runtime", async (load) => {
  const original = await load<typeof import("@t3tools/client-runtime/state/runtime")>();
  const Atom = await import("effect/reactivity/Atom");
  return {
    ...original,
    createEnvironmentRpcCommand: (
      ...args: Parameters<typeof original.createEnvironmentRpcCommand>
    ) =>
      args[1].tag.startsWith("memory.")
        ? { tag: args[1].tag, permissionAtom: () => Atom.make(true) }
        : original.createEnvironmentRpcCommand(...args),
    runAtomCommand: respond,
  };
});

it("shows counts and storage disclosure only for an orchestrator", async () => {
  const environmentId = EnvironmentId.make("machine");
  respond.mockResolvedValueOnce({ _tag: "Success", value: null });
  await using _ordinary = await render(
    <MemoryStrip environmentId={environmentId} threadId={ThreadId.make("ordinary")} />,
  );
  await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
  expect(page.getByText(/unencrypted/).query()).toBeNull();
  respond.mockResolvedValueOnce({ _tag: "Success", value: { total: 7, proposed: 2, disputed: 1 } });
  respond.mockResolvedValueOnce({ _tag: "Success", value: [] });
  await using _orchestrator = await render(
    <MemoryStrip environmentId={environmentId} threadId={ThreadId.make("orchestrator")} />,
  );
  await expect
    .element(
      page.getByRole("button", { name: /Memory.*7 notes.*Stored unencrypted on this machine/ }),
    )
    .toBeVisible();
});

it("opens a scoped inline command card, searches notes and closes it", async () => {
  const { openMemoryCommand } = await import("./memoryCommand");
  const ref = { environmentId: EnvironmentId.make("machine"), threadId: ThreadId.make("search") };
  const note = {
    key: "format",
    text: "Two spaces",
    kind: "reference",
    scope: "project",
    trust: "confirmed",
    source: "guide",
    why: "",
    reason: "",
    flaggedBy: "",
    version: "1",
  };
  respond.mockImplementation(async (_registry, _command, { input }) => ({
    _tag: "Success",
    value: "pendingOnly" in input ? [note] : { total: 1, proposed: 0, disputed: 0 },
  }));
  await using screen = await render(<MemoryStrip {...ref} />);
  const promptRef = { current: "/memory spaces" };
  expect(
    openMemoryCommand(
      { routeThreadRef: ref, composerDraftTarget: ref, composerRef: { current: null }, promptRef },
      promptRef.current,
    ),
  ).toBe(true);
  expect(promptRef.current).toBe("");
  const search = screen.getByRole("searchbox");
  await expect.element(search).toBeVisible();
  await expect.element(screen.getByText("Two spaces")).toBeVisible();
  await search.fill("absent");
  await expect.element(screen.getByText("No matching notes.")).toBeVisible();
  await screen.getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(search).not.toBeInTheDocument();
});

it("labels a rule reminder separately from chat messages and shows its source and totals", async () => {
  respond.mockResolvedValue({
    _tag: "Success",
    value: {
      total: 1,
      proposed: 0,
      disputed: 0,
      reminders: {
        fired: 3,
        acknowledged: 1,
        contested: 1,
        latest: [
          { key: "format", text: "Use two spaces.", source: "Owner review", trust: "confirmed" },
        ],
      },
    },
  });
  await using screen = await render(
    <MemoryStrip
      environmentId={EnvironmentId.make("machine")}
      threadId={ThreadId.make("reminders")}
    />,
  );
  await expect
    .element(screen.getByRole("complementary").getByText("Rule reminder · format"))
    .toBeVisible();
  await expect.element(screen.getByText("Use two spaces.")).toBeVisible();
  await expect.element(screen.getByText("Source: Owner review")).toBeVisible();
  await expect.element(screen.getByText(/3 fired · 1 acknowledged · 1 contested/)).toBeVisible();
});

it("runs Review my workflow locally from the composer and presents the report in chat", async () => {
  const ref = {
    environmentId: EnvironmentId.make("machine"),
    threadId: ThreadId.make("main-workflow"),
  };
  let runs = 0;
  respond.mockImplementation(async (_registry, command, { input }) => {
    if (command.tag === "memory.summary")
      return { _tag: "Success", value: { main: true, total: 0, proposed: 0, disputed: 0 } };
    if (input.action === "run") runs++;
    return {
      _tag: "Success",
      value: {
        weekly: false,
        report: runs
          ? {
              created: 1,
              retries: 2,
              failures: 0,
              waiting: 0,
              disputed: 0,
              corrections: 0,
              proposed: 0,
              stale: 0,
              contested: 0,
              fired: 0,
              acknowledged: 0,
              pending: false,
            }
          : null,
      },
    };
  });
  await using screen = await render(<MemoryStrip {...ref} />);
  // One visible action at the top of the main chat, with or without an earlier report.
  const action = screen.getByRole("button", { name: "Review my workflow" });
  await expect.element(action).toBeVisible();
  expect(runs).toBe(0);
  await action.click();
  await vi.waitFor(() => expect(runs).toBe(1));
  await expect.element(action).toBeEnabled();
  runs = 0;
  const { openMemoryCommand } = await import("./memoryCommand");
  const promptRef = { current: "Review my workflow" };
  expect(
    openMemoryCommand(
      { routeThreadRef: ref, composerDraftTarget: ref, composerRef: { current: null }, promptRef },
      promptRef.current,
    ),
  ).toBe(true);
  await expect
    .element(screen.getByRole("article", { name: "Workflow review result" }))
    .toBeVisible();
  expect(runs).toBe(1);
  expect(promptRef.current).toBe("");
});
