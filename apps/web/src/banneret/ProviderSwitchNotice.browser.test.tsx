import {
  EnvironmentId,
  ProviderDriverKind,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2TurnItem,
  type ProviderSwitchSide,
  type ServerProvider,
  type SwitchNotice,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import type { ChatComposerProps } from "../components/chat/ChatComposer";
import { ComposerBanner } from "../components/chat/ComposerBanner";
import { ComposerBannerStack } from "../components/chat/ComposerBannerStack";
import { V2LifecycleRow } from "../components/chat/V2LifecycleRow";
import { useComposerDraftStore } from "../composerDraftStore";
import { useSwitchBanner } from "./ProviderSwitchNotice";
import { expectInside, expectNoPageScroll, forEachViewport, windowRect } from "./test/viewports";

const ask = vi.hoisted(() => vi.fn());
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
      args[1].tag === "memory.switchNotice"
        ? { tag: args[1].tag, permissionAtom: () => Atom.make(true) }
        : original.createEnvironmentRpcCommand(...args),
    runAtomCommand: ask,
  };
});
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const Atom = await import("effect/reactivity/Atom");
  const providers = Atom.make(
    [
      ["claudeAgent", "claudeAgent", "Claude"],
      ["claude_work", "claudeAgent", "Claude work"],
      ["codex", "codex", "Codex"],
      ["kiro", "kiro", "Kiro"],
    ].map(
      ([instanceId, driver, displayName]) =>
        ({
          instanceId,
          driver,
          displayName,
          enabled: true,
          installed: true,
          models: [],
        }) as unknown as ServerProvider,
    ),
  );
  const settings = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: () => providers,
      settingsValueAtom: () => settings,
    },
  };
});

// The server test asserts that the real profiles give these.
const sides: Record<string, ProviderSwitchSide> = {
  claudeAgent: {
    name: "Claude Code",
    integrated: true,
    project:
      "CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md. AGENTS.md and .claude/AGENTS.md only when none of these is found",
    personal: "~/.claude/CLAUDE.md",
  },
  codex: {
    name: "Codex",
    integrated: true,
    project: "AGENTS.override.md or AGENTS.md",
    personal: "~/.codex/AGENTS.override.md or ~/.codex/AGENTS.md",
  },
  kiro: { name: "Kiro", integrated: false, project: null, personal: null },
};

/** Answers the notice read until the test ends. */
function answering() {
  ask.mockImplementation(async (_registry, _command, { input }) => ({
    _tag: "Success",
    value: {
      from: sides[input.from]!,
      to: sides[input.to]!,
      notes: 38,
      carried: input.handoffId ? { items: 14, of: 61 } : null,
    } satisfies SwitchNotice,
  }));
  return { [Symbol.dispose]: () => void ask.mockReset() };
}

const environmentId = EnvironmentId.make("machine");
const selection = (instanceId: string) => ({ instanceId, model: "model" }) as ModelSelection;
const runsOf = (instances: ReadonlyArray<string>) =>
  instances.map((instanceId, index) => ({
    id: `run-${index + 1}`,
    ordinal: index + 1,
    status: "completed",
    startedAt: {},
    providerInstanceId: instanceId,
    modelSelection: selection(instanceId),
  })) as unknown as ChatComposerProps["activeThreadRuns"];

function handoff(
  thread: string,
  from: string,
  to: string,
  options: { title?: string; resumed?: boolean } = {},
) {
  return {
    type: "handoff",
    threadId: ThreadId.make(thread),
    runId: "run-2",
    title: options.title ?? "Provider handoff",
    status: "completed",
    strategy: options.resumed ? "delta_since_target_last_seen" : "full_thread_summary",
    contextHandoffId: "handoff-1",
    fromProviderInstanceIds: [from],
    toProviderInstanceId: to,
  } as unknown as OrchestrationV2TurnItem;
}

const row = (thread: string, from: string, to: string, options?: Parameters<typeof handoff>[3]) => (
  <V2LifecycleRow
    environmentId={environmentId}
    item={handoff(thread, from, to, options)}
    runs={runsOf([from, to])}
    onOpenThread={() => {}}
  />
);

function ComposerLine({ thread, from }: { thread: string; from: string }) {
  const banner = useSwitchBanner({
    environmentId,
    activeThreadId: ThreadId.make(thread),
    composerDraftTarget: { environmentId, threadId: ThreadId.make(thread) },
    activeThread: {
      modelSelection: selection(from),
      latestRun: {},
      itemCount: 1,
      runtime: null,
    },
    activeThreadRuns: runsOf([from]),
    providerStatuses: [
      { instanceId: "claudeAgent", driver: "claudeAgent" },
      { instanceId: "claude_work", driver: "claudeAgent" },
      { instanceId: "codex", driver: ProviderDriverKind.make("codex") },
      { instanceId: "kiro", driver: "kiro" },
    ],
    multipleModelSelections: null,
  } as unknown as ChatComposerProps);
  return (
    <ComposerBanner.Column>
      <ComposerBannerStack items={banner ? [banner] : []} />
      <ComposerBanner.Attachment>
        <div data-testid={`composer-${thread}`} className="h-24 rounded-2xl border bg-card" />
      </ComposerBanner.Attachment>
    </ComposerBanner.Column>
  );
}

function pick(thread: string, instanceId: string) {
  useComposerDraftStore
    .getState()
    .setModelSelection({ environmentId, threadId: ThreadId.make(thread) }, selection(instanceId), {
      explicit: true,
    });
}

const card = () => page.getByRole("region", { name: "Provider switch" });
const expectCard = (text: string) =>
  expect.poll(() => card().query()?.textContent ?? "").toContain(text);

it("shows what applies after a switch from Claude to Codex", async () => {
  using _answers = answering();
  await using _screen = await render(row("to-codex", "claudeAgent", "codex"));
  await expectCard("Now on Codex.New session.");
  await expectCard("14 of 61 history items.");
  await expectCard("38 Banneret notes available.");
  await expectCard("Codex's own instructions.Project: AGENTS.override.md or AGENTS.md.");
  await expectCard("Claude Code's own instructions.Project: CLAUDE.md, .claude/CLAUDE.md");
  await expect.element(page.getByText("Context handoff")).toBeVisible();
});

it("says a switch back to Claude resumes its earlier session", async () => {
  using _answers = answering();
  await using _screen = await render(row("to-claude", "codex", "claudeAgent", { resumed: true }));
  await expectCard("Now on Claude Code.Resumed its earlier session.");
  await expectCard("14 of 61 history items since it last ran.");
});

it("says a provider with no profile isn't fully integrated and names no files for it", async () => {
  using _answers = answering();
  await using _screen = await render(row("to-kiro", "codex", "kiro"));
  await expectCard(
    "Now appliesKiro isn't fully integrated: the Hub does not know which files it reads.Instead of",
  );
});

it.each([
  ["a second account of one provider", row("account", "claudeAgent", "claude_work")],
  ["the same provider", row("same", "codex", "codex", { title: "Recovered context" })],
  ["a fork", row("fork", "claudeAgent", "codex", { title: "Fork context" })],
])("adds no notice for %s", async (_name, element) => {
  using _answers = answering();
  await using _screen = await render(element);
  await expect.element(page.getByText(/handoff/i)).toBeVisible();
  expect(card().query()).toBeNull();
  expect(ask).not.toHaveBeenCalled();
});

describe("composer line", () => {
  it.each([
    ["claudeAgent", "codex", "Switching to Codex starts a new session."],
    ["codex", "claudeAgent", "Switching to Claude Code starts a new session."],
  ])("announces a pick from %s to %s", async (from, to, title) => {
    const thread = `compose-${from}-${to}`;
    using _answers = answering();
    await using _screen = await render(<ComposerLine thread={thread} from={from} />);
    expect(page.getByText(/Switching to/).query()).toBeNull();
    pick(thread, to);
    await expect.element(page.getByText(title)).toBeVisible();
    await expect
      .element(page.getByText(`${sides[to]!.name} follows its own instruction files.`))
      .toBeVisible();
    pick(thread, from);
    await expect.poll(() => page.getByText(/Switching to/).query()).toBeNull();
  });

  it("says so when the picked provider has no profile", async () => {
    using _answers = answering();
    await using _screen = await render(<ComposerLine thread="compose-kiro" from="codex" />);
    pick("compose-kiro", "kiro");
    await expect.element(page.getByText("Switching to Kiro starts a new session.")).toBeVisible();
    await expect.element(page.getByText(/Kiro isn't fully integrated/)).toBeVisible();
  });

  it("stays away for another account of the same provider", async () => {
    using _answers = answering();
    await using _screen = await render(
      <ComposerLine thread="compose-account" from="claudeAgent" />,
    );
    pick("compose-account", "claude_work");
    await expect.element(page.getByTestId("composer-compose-account")).toBeVisible();
    expect(page.getByText(/Switching to/).query()).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });
});

forEachViewport("the provider switch notice stays inside the chat column", async (at) => {
  using _answers = answering();
  const thread = `layout-${at.id}`;
  await using _screen = await render(
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <div className="chat-content-lane pt-6" data-testid="lane">
          <p className="ml-auto w-fit rounded-2xl bg-secondary px-4 py-2 text-sm">
            Claude is close to its limit. Carry on with the retry change on Codex.
          </p>
          {row(thread, "claudeAgent", "codex")}
          <p className="text-sm">I read the earlier work. I will finish the retry change.</p>
        </div>
      </div>
      <div className="px-4 pb-4">
        <div className="chat-content-lane">
          <ComposerLine thread={thread} from="codex" />
        </div>
      </div>
    </div>,
  );
  pick(thread, "claudeAgent");
  await expect.element(card()).toBeVisible();
  const line = page.getByText("Switching to Claude Code starts a new session.");
  await expect.element(line).toBeVisible();
  await expect
    .element(page.getByText("Claude Code follows its own instruction files."))
    .toBeVisible();

  const lane = page.getByTestId("lane").element().getBoundingClientRect();
  const notice = card().element() as HTMLElement;
  expectInside(notice, windowRect(), "the switch notice");
  expectInside(line.element(), windowRect(), "the composer line");
  const box = notice.getBoundingClientRect();
  expect(box.left).toBeGreaterThanOrEqual(lane.left - 0.5);
  expect(box.right).toBeLessThanOrEqual(lane.right + 0.5);
  for (const part of [notice, ...notice.querySelectorAll<HTMLElement>("dt, dd, p")]) {
    expect(part.scrollWidth).toBeLessThanOrEqual(part.clientWidth + 1);
  }
  // A cut banner offers its full text behind a button.
  await expect.poll(() => page.getByRole("button", { name: /^Show/ }).query()).toBeNull();
  expectNoPageScroll();
  await at.screenshot();
});
