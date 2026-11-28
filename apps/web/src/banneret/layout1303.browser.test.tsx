// Layout at every supported window size for the click-test surfaces: channel settings, Browse
// channels, Roles and the thread header entry points.
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { expect, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import appCss from "../index.css?inline";
import { ThreadTimeline } from "./chat/AgentSettings";
import { ChannelSettings } from "./chat/ChannelSettings";
import { chatRpc } from "./chat/client";
import { Directory } from "./chat/JoinRequests";
import { WorkspaceRoles } from "./chat/Roles";
import "./nativeSelect.css";
import { usePause } from "./Pause";
import { expectReadableLines, expectUnclipped, forEachViewport } from "./test/viewports";

const { useEnterpriseFeed } = vi.hoisted(() => ({ useEnterpriseFeed: vi.fn() }));
vi.mock(import("~/environments/primary/target"), async (original) => ({
  ...(await original()),
  readPrimaryEnvironmentTarget: () => null,
}));
vi.mock("./useEnterpriseFeed", async (load) => ({
  ...(await load<typeof import("./useEnterpriseFeed")>()),
  useEnterpriseFeed,
}));
vi.mock("../state/session", async (load) => ({
  ...(await load<typeof import("../state/session")>()),
  useEnvironmentScope: () => true,
}));
vi.mock("../components/chat/ThreadTimeline", () => ({
  ThreadTimeline: () => <div className="grow" />,
}));
vi.mock("./CallApprovals", () => ({ CallApprovals: () => null }));
vi.mock("@t3tools/client-runtime/state/runtime", async (load) => {
  const original = await load<typeof import("@t3tools/client-runtime/state/runtime")>();
  const Atom = await import("effect/reactivity/Atom");
  const values: Record<string, unknown> = {
    "memory.summary": { main: true, total: 128, proposed: 12, disputed: 3 },
    "memory.workflow": { weekly: false, report: null },
    "plugins.levels": [{ source: "banneret", level: "read" }],
    "memory.list": [],
  };
  return {
    ...original,
    createEnvironmentRpcCommand: (
      ...args: Parameters<typeof original.createEnvironmentRpcCommand>
    ) =>
      /^(memory|plugins|banneretPause)\./.test(args[1].tag)
        ? { tag: args[1].tag, permissionAtom: () => Atom.make(true) }
        : original.createEnvironmentRpcCommand(...args),
    runAtomCommand: async (_registry: unknown, command: { tag: string }) => ({
      _tag: "Success",
      value: values[command.tag] ?? { paused: false, held: 0, running: [] },
    }),
  };
});

/** The app sidebar's default width. */
const SIDEBAR = 256;

const env = EnvironmentId.make("desk");
/** The widest channel name the contract allows: 40 characters with nowhere to break. */
const LONG_NAME = "m".repeat(40);
const logins = ["CoreosG", "a-very-long-github-login-of-39-chars-x", "leo", "kim", "ana", "rosa"];
const people = logins.map((login, i) => ({
  id: "p_" + i,
  login,
  admission: "member" as const,
  role: { id: "founder", name: "Founder" },
}));
const target = { environmentId: env, relayOrigin: "https://relay.test" };
const enterprise = (chatFlags: string[]) => ({
  environmentId: env,
  target,
  workspace: { id: "w", name: "banneret-app" },
  enrolment: { me: { id: "p_0", login: "CoreosG", permissions: ["relay.admin"] } },
  feed: {
    sections: ["roles", "chat"],
    chatRevision: 1,
    chatFlags,
    team: { value: { people } },
    needs: [{ kind: "agent_inbox", handleId: "h_1", count: 3 }],
  },
});
const channel = (name: string, extra: { read?: boolean; join?: boolean } = {}) => ({
  kind: "channel" as const,
  id: "c_" + name,
  name,
  purpose: "Release coordination, API changes and the follow-ups that come out of each review.",
  archived: false,
  agents: "allowed" as const,
  managers: [{ id: "p_0", login: "CoreosG" }],
  memberCount: { people: 6, agents: 2 },
  lastSeq: 0,
  access: {
    visibility: "public" as const,
    join: "open" as const,
    outsiders: "none" as const,
    post: "everyone" as const,
    replies: "everyone" as const,
    invite: "members" as const,
  },
  me: {
    member: true,
    can: {
      read: extra.read ?? true,
      post: true,
      reply: true,
      join: extra.join ?? false,
      request: false,
      manage: true,
      invite: true,
      openToOutside: false,
    },
    notify: "all" as const,
    muted: false,
    readSeq: 0,
    unread: 0,
    mentions: 0,
  },
});

const box = (element: Element) => element.getBoundingClientRect();
const where = (element: Element) => {
  const r = box(element);
  return `[${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}]`;
};

/** The window and every ancestor that cuts off or scrolls this element's content. */
function framesOf(element: Element) {
  const frames = [new DOMRect(0, 0, window.innerWidth, window.innerHeight)];
  for (
    let node = element;
    node.parentElement && getComputedStyle(node).position !== "fixed";
    node = node.parentElement
  ) {
    const style = getComputedStyle(node.parentElement);
    if (`${style.overflowX} ${style.overflowY}` !== "visible visible")
      frames.push(box(node.parentElement));
  }
  return frames;
}

/** What a person can see of the element now; empty once it has scrolled out of its frame. */
const visiblePart = (element: Element) =>
  framesOf(element).reduce((part, frame) => {
    const left = Math.max(part.left, frame.left);
    const top = Math.max(part.top, frame.top);
    return new DOMRect(
      left,
      top,
      Math.max(0, Math.min(part.right, frame.right) - left),
      Math.max(0, Math.min(part.bottom, frame.bottom) - top),
    );
  }, box(element));

function scrollerOf(element: Element) {
  let node = element.parentElement;
  while (node && !/auto|scroll/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
  return node;
}

/**
 * Every visible control under `root` scrolls into full view, covers no other control and cuts off
 * none of its own text.
 */
function expectControls(root: Element, label: string) {
  const controls = [...root.querySelectorAll("button, a, input, select, summary")].filter((node) =>
    node.checkVisibility(),
  );
  expect(controls.length, `${label} has controls`).toBeGreaterThan(0);
  for (const control of controls) {
    const name = `${label}: ${control.textContent?.trim() || control.getAttribute("aria-label") || control.tagName}`;
    control.scrollIntoView({ block: "nearest", inline: "nearest" });
    expectUnclipped(control, name);
    if (control.tagName === "BUTTON")
      expect(control.scrollWidth, `${name} cuts off its text`).toBeLessThanOrEqual(
        control.clientWidth + 1,
      );
  }
  for (const [index, first] of controls.entries()) {
    for (const second of controls.slice(index + 1)) {
      if (first.contains(second) || second.contains(first)) continue;
      // Inside one scroller, positions compare even out of view. Across two, only what shows can.
      const together = scrollerOf(first) === scrollerOf(second);
      const a = together ? box(first) : visiblePart(first);
      const b = together ? box(second) : visiblePart(second);
      expect(
        Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1,
        `${label}: "${first.textContent}" ${where(first)} overlaps "${second.textContent}" ${where(second)}`,
      ).toBe(false);
    }
  }
}

/**
 * Nothing spills past the sides of the bordered box that holds it, and no placeholder is cut off.
 * A box that overflows visibly neither clips nor scrolls, so the checks above would pass it.
 */
function expectContained(root: Element, label: string) {
  const context = document.createElement("canvas").getContext("2d")!;
  for (const element of root.querySelectorAll("*")) {
    if (!element.checkVisibility() || element.closest("option, svg, .sr-only")) continue;
    if (element instanceof HTMLInputElement && element.placeholder && !element.value) {
      const style = getComputedStyle(element);
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      expect(
        context.measureText(element.placeholder).width,
        `${label}: placeholder "${element.placeholder}" is cut off`,
      ).toBeLessThanOrEqual(
        element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) + 1,
      );
    }
    const r = box(element);
    if (!r.width) continue;
    for (let node: Element = element; node !== root && node.parentElement;) {
      // A popover leaves its trigger's box on purpose; the window and column checks cover it.
      if (/absolute|fixed/.test(getComputedStyle(node).position)) break;
      node = node.parentElement;
      const style = getComputedStyle(node);
      if (!parseFloat(style.borderLeftWidth) || !parseFloat(style.borderRightWidth)) continue;
      const frame = box(node);
      expect(
        r.left >= frame.left - 0.5 && r.right <= frame.right + 0.5,
        `${label}: <${element.tagName.toLowerCase()}> "${element.textContent?.slice(0, 40)}" ${where(element)} spills out of its box ${where(node)}`,
      ).toBe(true);
      break;
    }
  }
}

/** No sideways scroll, nothing spilling out of its box, and lines a person can read. */
function expectReadable(root: Element, label: string, maxWidth: number) {
  expectContained(root, label);
  expect(box(root).width, `${label} width`).toBeLessThanOrEqual(maxWidth + 0.5);
  expect(root.scrollWidth, `${label} scrolls sideways`).toBeLessThanOrEqual(root.clientWidth + 1);
  expectReadableLines(root, label);
}

function styles() {
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  document.documentElement.classList.add("dark");
  document.body.style.background = "var(--background)";
  document.body.style.color = "var(--foreground)";
  return {
    [Symbol.dispose]() {
      style.remove();
      document.documentElement.classList.remove("dark");
      document.body.removeAttribute("style");
    },
  };
}

function relay() {
  return vi.spyOn(chatRpc, "run").mockImplementation(async (_, action) => {
    if (action.kind === "roles")
      return {
        items: [
          {
            id: "founder",
            name: "Founder",
            forOutside: false,
            permissions: {},
            memberCount: 8,
            template: "founder",
          },
        ],
      };
    if (action.kind === "directory")
      return {
        items: [channel(LONG_NAME, { join: true }), channel("secret-plans", { read: false })],
        nextCursor: null,
      };
    if (action.kind === "threadChat")
      return {
        id: "h_1",
        owner: { id: "p_0", login: "CoreosG" },
        claimName: "codex-1a2b3c4d",
        provider: "codex",
        machine: { id: "m_1", label: "Desk" },
        reachable: true,
        wake: "owner",
        paused: false,
      };
    return { items: [], nextCursor: null };
  });
}

forEachViewport("the channel settings sheet fits", async (at) => {
  using _styles = styles();
  using _relay = relay();
  await using _screen = await render(
    <ChannelSettings
      enterprise={enterprise(["channels"]) as never}
      channel={channel(LONG_NAME)}
      people={people.map((p) => ({ ...p, kind: "person" as const }))}
      close={() => {}}
      saved={() => {}}
    />,
  );
  const sheet = page.getByRole("dialog", { name: `#${LONG_NAME} settings` });
  await expect.element(sheet.getByRole("button", { name: "Archive channel" })).toBeInTheDocument();
  const popup = sheet.element();
  await Promise.all(popup.getAnimations().map((animation) => animation.finished));
  expectReadable(popup, "sheet", 448);
  const form = popup.querySelector("form")!;
  expectReadable(form, "sheet form", 448);
  expectControls(popup, "sheet");
  // The end of the form, with the archive step, is reachable and in full.
  await sheet.getByRole("button", { name: "Archive channel" }).click();
  form.scrollTop = form.scrollHeight;
  expectControls(popup, "sheet confirming");
  expectUnclipped(
    sheet.getByRole("button", { name: "Confirm archive" }).element(),
    "Confirm archive",
  );
  await at.screenshot();
});

forEachViewport("Browse channels fits the sidebar", async (at) => {
  using _styles = styles();
  using _relay = relay();
  await using screen = await render(
    <aside data-sidebar-column style={{ width: SIDEBAR }}>
      <Directory enterprise={enterprise(["channels"]) as never} open={() => {}} />
    </aside>,
  );
  await expect.element(screen.getByText("#secret-plans")).toBeVisible();
  const column = screen.container.querySelector("[data-sidebar-column]")!;
  expectReadable(column, "directory", SIDEBAR);
  expectControls(column, "directory");
  await screen.getByRole("button", { name: "Archive channel" }).click();
  expectReadable(column, "directory confirming", SIDEBAR);
  expectControls(column, "directory confirming");
  await at.screenshot();
});

forEachViewport("Roles fits the settings page", async (at) => {
  using _styles = styles();
  using _relay = relay();
  useEnterpriseFeed.mockReturnValue(enterprise([]));
  // The settings page's own scroller and readable container.
  await using screen = await render(
    <div
      data-settings-scroller
      className="flex flex-col overflow-y-auto"
      style={{ height: "100vh", marginLeft: SIDEBAR }}
    >
      <WorkspacePageContainer width="readable">
        <WorkspaceRoles />
      </WorkspacePageContainer>
    </div>,
  );
  await screen.getByRole("button", { name: "Roles", exact: true }).click();
  await expect.element(screen.getByText(/^Changes apply to /)).toBeVisible();
  const scroller = screen.container.querySelector("[data-settings-scroller]")!;
  const content = scroller.firstElementChild!;
  expectReadable(content, "roles", 896);
  expectControls(scroller, "roles");
  scroller.scrollTop = 0;
  await at.screenshot();
  await screen.getByRole("button", { name: "New role" }).click();
  await expect.element(screen.getByText(/lowercase letters/)).toBeVisible();
  expectReadable(content, "new role", 896);
  expectControls(scroller, "new role");
  const left = box(content).left - box(scroller).left;
  const right = box(scroller).right - box(content).right;
  expect(Math.abs(left - right), "roles is centred").toBeLessThanOrEqual(24);
});

/** A thread that has no agent handle yet: the header offers a name and shows the person's default. */
function unnamedThread() {
  const answer = vi.mocked(chatRpc.run).getMockImplementation()!;
  vi.mocked(chatRpc.run).mockImplementation(async (relayTarget, action) =>
    action.kind === "threadChat"
      ? { unregistered: true }
      : action.kind === "dmSettings"
        ? {
            agentWakeDefault: "everyone",
            agentsReadMyDms: false,
            agentsPaused: false,
            agentAsks: { default: "off", auto: [], maxTokens: 1, maxSeconds: 1 },
          }
        : answer(relayTarget, action),
  );
  return { [Symbol.dispose]: () => void vi.mocked(chatRpc.run).mockImplementation(answer) };
}

forEachViewport("the thread header entry points fit", async (at) => {
  using _styles = styles();
  using _relay = relay();
  usePause.setState({ [env]: { status: { paused: false, held: 0, running: [] } } });
  const timeline = {
    draftEntries: null,
    threadDetailRef: { environmentId: env, threadId: ThreadId.make("main") },
    isWorking: false,
  } as unknown as ComponentProps<typeof ThreadTimeline>;
  // Both relays, and a handle with and without a name: the short label moves the wake panel left.
  for (const header of ["default only", "named", "unnamed"] as const) {
    const flags = header === "default only" ? ["agent_inbox"] : ["agents", "agent_inbox"];
    const agents = header !== "default only";
    useEnterpriseFeed.mockReturnValue(enterprise(flags));
    using _unnamed = header === "unnamed" ? unnamedThread() : undefined;
    await using screen = await render(
      // The chat column clips what leaves it.
      <main
        className="flex flex-col overflow-hidden"
        style={{ height: "100vh", marginLeft: SIDEBAR }}
      >
        <ThreadTimeline {...timeline} />
      </main>,
    );
    const main = screen.container.querySelector("main")!;
    await expect.element(screen.getByRole("button", { name: "Review my workflow" })).toBeVisible();
    const summary = screen.getByText(
      header === "unnamed" ? /^Give a chat name/ : /· Wake: Only me/,
    );
    await expect
      .element(agents ? summary : screen.getByRole("link", { name: "Wake settings" }))
      .toBeVisible();
    const lane = Math.min(box(main).width, 46 * 16);
    const lanes = [...main.querySelectorAll(".chat-content-lane")].filter((node) =>
      node.checkVisibility(),
    );
    expect(lanes.length, "memory bar and header use the chat lane").toBeGreaterThanOrEqual(2);
    for (const node of lanes) {
      expect(box(node).width, "lane width").toBeLessThanOrEqual(lane + 0.5);
      expect(
        Math.abs(box(node).left - box(main).left - (box(main).right - box(node).right)),
        "lane is centred",
      ).toBeLessThanOrEqual(2);
    }
    const bar = main.querySelector("header")!;
    const memory = screen
      .getByRole("button", { name: /Memory/ })
      .element()
      .closest("section")!;
    expect(box(memory).bottom, "memory bar sits above the header").toBeLessThanOrEqual(
      box(bar).top + 0.5,
    );
    expectControls(main, "thread header");
    await screen.getByRole("button", { name: "Stop all" }).click();
    expectControls(main, "stop all confirm");
    expectReadable(bar, "header", box(main).width);
    if (header === "named") await at.screenshot();
    await screen.getByRole("button", { name: "Cancel" }).click();
    // Each popover opens inside the window.
    await screen.getByRole("button", { name: "Tool access" }).click();
    const levels = page.getByRole("combobox", { name: "Banneret tools" });
    await expect.element(levels).toBeVisible();
    const panel = levels.element().closest("fieldset")!;
    await Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
    );
    expectUnclipped(panel, "tool access panel");
    await userEvent.keyboard("{Escape}");
    await expect.element(levels).not.toBeInTheDocument();
    if (agents) {
      await summary.click();
      const wake = screen.getByRole("combobox", { name: "Who can wake this agent" });
      await expect.element(wake).toBeVisible();
      expectUnclipped(wake.element().closest("form")!, "wake panel");
    }
  }
});
