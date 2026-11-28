import { EnvironmentId, ThreadId, type BanneretWorkspace } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import type { ChatComposerProps } from "../components/chat/ChatComposer";
import { toastManager } from "../components/ui/toast";
import { usePrimaryEnvironmentId } from "../state/environments";
import { ChatComposer } from "./MemoryComposer";
import { useMemoryAvailability, memoryThreadKey } from "./memoryCommand";
import { useBanneretPaletteItems } from "./workspacePaletteItems";
import { useRelayFeedStore } from "./relayFeedStore";
import { relayKey } from "./enrolmentStore";
import { useWorkspacesStore } from "./workspacesStore";
import { WORKFLOW_HINT } from "./WorkflowReview";

const respond = vi.hoisted(() => vi.fn());
vi.mock(import("~/environments/primary/target"), async (original) => ({
  ...(await original()),
  readPrimaryEnvironmentTarget: () => null,
}));
vi.mock("../state/environments", { spy: true });
vi.mock("../components/ports/showPortsCommand", () => ({
  useCommandPaletteShowPortsItem: () => null,
}));
vi.mock("../components/chat/ChatComposer", () => ({
  ChatComposer: (props: ChatComposerProps) => <button onClick={() => props.onSend()}>Send</button>,
}));
vi.mock("../components/chat/ThreadTimeline", () => ({ ThreadTimeline: () => null }));
vi.mock("@t3tools/client-runtime/state/runtime", async (load) => ({
  ...(await load<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: respond,
}));

const environmentId = EnvironmentId.make("machine");
const company: BanneretWorkspace = {
  id: "company",
  name: "Company",
  kind: "enterprise",
  projectKeys: [],
  updatedAt: "2026-11-27T00:00:00Z",
  relay: { origin: "https://relay.test", displayName: "Company" },
};
const show = (activeId: string | null) =>
  useWorkspacesStore.setState({ activeId, local: [company], byEnvironment: {} });
const runs = () => respond.mock.calls.filter((call) => call[2].input.action === "run");

function composer(threadId: ThreadId, onSend: () => void) {
  const ref = { environmentId, threadId };
  const props = {
    routeThreadRef: ref,
    composerDraftTarget: ref,
    activeThreadRuns: [],
    composerRef: { current: null },
    promptRef: { current: "Review my workflow" },
    providerStatuses: [],
    onSend,
  } as unknown as ChatComposerProps;
  return <ChatComposer {...props} />;
}

it("sends the phrase from a new chat as usual and points to the main orchestrator chat", async () => {
  respond.mockReset();
  show(company.id);
  using toast = vi.spyOn(toastManager, "add");
  const onSend = vi.fn();
  await using screen = await render(composer(ThreadId.make("new-chat"), onSend));
  await screen.getByRole("button", { name: "Send" }).click();
  expect(onSend).toHaveBeenCalledOnce();
  expect(toast).toHaveBeenCalledWith({ type: "info", ...WORKFLOW_HINT });
  expect(runs()).toHaveLength(0);
});

it("gives no hint in Personal, which has no main orchestrator", async () => {
  respond.mockReset();
  show(null);
  using toast = vi.spyOn(toastManager, "add");
  const onSend = vi.fn();
  await using screen = await render(composer(ThreadId.make("personal-chat"), onSend));
  await screen.getByRole("button", { name: "Send" }).click();
  expect(onSend).toHaveBeenCalledOnce();
  expect(toast).not.toHaveBeenCalled();
});

it("runs the review instead of sending the phrase in the main orchestrator chat", async () => {
  respond.mockReset();
  respond.mockResolvedValue({ _tag: "Success", value: { weekly: false, report: null } });
  show(company.id);
  const threadId = ThreadId.make("main-chat");
  const key = memoryThreadKey({ environmentId, threadId });
  useMemoryAvailability.setState({ threads: { [key]: true }, mains: { [key]: true } });
  const onSend = vi.fn();
  await using screen = await render(composer(threadId, onSend));
  await screen.getByRole("button", { name: "Send" }).click();
  await vi.waitFor(() => expect(runs()).toHaveLength(1));
  expect(onSend).not.toHaveBeenCalled();
});

function PaletteItem() {
  const item = useBanneretPaletteItems(null).find((i) => i.value === "action:review-my-workflow");
  return item?.kind === "action" ? (
    <button onClick={() => void item.run()}>{String(item.title)}</button>
  ) : null;
}

it("opens the main orchestrator chat from the command palette and runs the review there", async () => {
  respond.mockReset();
  respond.mockImplementation(async (_registry, _command, { input }) => ({
    _tag: "Success",
    value:
      input.action === "get"
        ? { main: "main-chat", projects: {} }
        : { weekly: false, report: null },
  }));
  vi.mocked(usePrimaryEnvironmentId).mockReturnValue(environmentId);
  show(company.id);
  await using screen = await render(<PaletteItem />);
  await screen.getByRole("button", { name: "Review my workflow" }).click();
  await vi.waitFor(() => expect(runs()).toHaveLength(1));
  expect(runs()[0]![2]).toMatchObject({ input: { threadId: "main-chat" } });
  expect(screen.router?.state.location.pathname).toBe("/machine/main-chat");
});

it("explains how to choose a main orchestrator and offers nothing in Personal", async () => {
  respond.mockReset();
  respond.mockResolvedValue({ _tag: "Success", value: { main: null, projects: {} } });
  vi.mocked(usePrimaryEnvironmentId).mockReturnValue(environmentId);
  using toast = vi.spyOn(toastManager, "add");
  show(company.id);
  {
    await using screen = await render(<PaletteItem />);
    await screen.getByRole("button", { name: "Review my workflow" }).click();
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Choose a main orchestrator first" }),
      ),
    );
    expect(runs()).toHaveLength(0);
  }
  show(null);
  await using personal = await render(<PaletteItem />);
  expect(personal.getByRole("button").elements()).toHaveLength(0);
});

it("neither hints nor offers the command when the company's memory belongs elsewhere", async () => {
  respond.mockReset();
  vi.mocked(usePrimaryEnvironmentId).mockReturnValue(environmentId);
  using toast = vi.spyOn(toastManager, "add");
  show(company.id);
  const key = relayKey({ environmentId, relayOrigin: "https://relay.test" });
  useRelayFeedStore.setState({
    feeds: { [key]: { elsewhere: { memory: { owner: "off" } } } },
  } as unknown as ReturnType<typeof useRelayFeedStore.getState>);
  using stack = new DisposableStack();
  stack.defer(() => useRelayFeedStore.setState({ feeds: {} }));
  const onSend = vi.fn();
  await using screen = await render(
    <>
      {composer(ThreadId.make("elsewhere-chat"), onSend)}
      <PaletteItem />
    </>,
  );
  expect(screen.getByRole("button").elements()).toHaveLength(1);
  await screen.getByRole("button", { name: "Send" }).click();
  expect(onSend).toHaveBeenCalledOnce();
  expect(toast).not.toHaveBeenCalled();
});
