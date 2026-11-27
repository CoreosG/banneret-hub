import appCss from "../../index.css?inline";
import {
  EnvironmentId,
  type BanneretFeedState,
  type BanneretFeedNeedsItem,
  type BanneretTeamPerson,
  type ChannelAction,
  type ChannelResult,
} from "@t3tools/contracts";
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";
import { commands, page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { SidebarProvider } from "../../components/ui/sidebar";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "../../state/environments";
import { storeEnrolmentView } from "../enrolmentStore";
import { ChannelRows } from "./ChannelRows";
import { useEnvironmentFeed, feedRpc } from "../relayFeedStore";
import { useWorkspacesStore } from "../workspacesStore";
import { EnterpriseSidebarRows } from "../EnterpriseSidebarRows";
import { TabsFrame } from "../tabs/TabsFrame";
import { useTabsStore } from "../tabs/tabsStore";
import * as Schema from "effect/Schema";
import { ChatConversations, ChatMessages } from "@t3tools/contracts";
import { DmPrivacy, ChannelPage } from "./ChannelPage";
import { NeedsRow } from "../TodayRows";
import { chatRpc } from "./client";
const decodeMessages = Schema.decodeUnknownSync(ChatMessages);
const decodeConversations = Schema.decodeUnknownSync(ChatConversations);
declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    companyChat: {
      (op: "outsideStart"): Promise<typeof import("@t3tools/contracts").RelayMe.Type>;
      (op: "start"): Promise<{ id: string; root: string; people: BanneretTeamPerson[] }>;
      (op: "call" | "leo", arg: ChannelAction): Promise<ChannelResult>;
      (op: "ask"): Promise<BanneretFeedNeedsItem>;
      (op: "stop"): Promise<void>;
    };
  }
}
vi.mock("../../state/environments", { spy: true });
it("answers a named agent question from its Needs you row", async () => {
  await commands.companyChat("start");
  await using resources = new AsyncDisposableStack();
  resources.defer(() => commands.companyChat("stop"));
  const item = await commands.companyChat("ask");
  using rpc = vi.spyOn(chatRpc, "run").mockImplementation(async (_, action) => {
    const result = await commands.companyChat("call", action);
    if (!result.ok) throw new Error(result.message);
    return result.value;
  });
  const target = { environmentId: EnvironmentId.make("local"), relayOrigin: "https://chat.test" };
  {
    await using limited = await render(<NeedsRow item={item} target={target} />);
    expect(limited.getByRole("textbox", { name: "Your answer" }).elements()).toHaveLength(0);
  }
  await using screen = await render(<NeedsRow asks item={item} target={target} />);
  await expect.element(screen.getByRole("textbox", { name: "Your answer" })).toBeVisible();
  await screen.getByRole("button", { name: "Linux" }).click();
  await expect.element(screen.getByText("Answer sent")).toBeVisible();
  expect(rpc).toHaveBeenCalledWith(target, {
    kind: "answer",
    id: item.ask?.id,
    answer: { choice: "Linux" },
  });
});
it("opens only when offered, reads the channel, posts, replies, edits and deletes through the fake relay", async () => {
  const { root: message, people } = await commands.companyChat("start");
  await using resources = new AsyncDisposableStack();
  resources.defer(() => commands.companyChat("stop"));
  const env = EnvironmentId.make("local"),
    origin = "https://chat.test",
    workspace = "ent-0123456789abcdef";
  useWorkspacesStore.setState({
    activeId: workspace,
    local: [
      {
        id: workspace,
        name: "Engineering",
        kind: "enterprise",
        updatedAt: "2026-11-27T00:00:00Z",
        projectKeys: [],
        relay: { origin, displayName: "Engineering" },
      },
    ],
    byEnvironment: {},
  });
  storeEnrolmentView(env, {
    state: "configured",
    workspaceId: workspace,
    relayOrigin: origin,
    me: {
      login: "ada",
      id: "p_me",
      permissions: ["relay.admin"],
      role: { id: "founder", name: "Founder" },
      admission: "member" as const,
    },
  });
  vi.mocked(usePrimaryEnvironmentId).mockReturnValue(env);
  vi.mocked(useConnectedEnvironmentIds).mockReturnValue([]);
  vi.spyOn(feedRpc, "today").mockResolvedValue(null);
  vi.spyOn(feedRpc, "needs").mockResolvedValue(null);
  let publish: ((state: BanneretFeedState) => void) | undefined;
  vi.spyOn(feedRpc, "subscribe").mockImplementation((_, fn) => {
    publish = fn;
    return () => {};
  });
  let revision = 0;
  let limited = true;
  const emit = (sections: string[]) =>
    publish?.({
      sections: ["today", "needs", "board", "map", "feed", "team", ...sections],
      sectionsKnown: true,
      chatFlags: limited
        ? ["channels", "threads", "private_channels"]
        : [
            "channels",
            "threads",
            "private_channels",
            "reactions",
            "dms",
            "group_dms",
            "agents",
            "agent_dms",
            "others_agents",
            "agent_owner_dm_read",
          ],
      chatRevision: ++revision,
      revision: 1,
      joined: true,
      live: true,
      since: null,
      needsCount: null,
      board: null,
      map: null,
      feed: null,
      graveyard: null,
      team: { value: { people }, fetchedAt: null },
    } as BanneretFeedState);
  vi.spyOn(chatRpc, "run").mockImplementation(async (_, action) => {
    const result = await commands.companyChat("call", action);
    if (!result.ok) throw new Error(result.message);
    if (
      ["post", "edit", "delete", "read", "dm", "notifications", "setDmSettings"].includes(
        action.kind,
      )
    )
      emit(["chat"]);
    if (limited && action.kind === "messages") {
      const page = decodeMessages(result.value);
      return {
        ...page,
        items: page.items.map((m) => ({
          ...m,
          taskRef: "hidden-task",
          reactions: [{ emoji: "👍", count: 1, mine: false }],
        })),
      };
    }
    return result.value;
  });
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  resources.defer(() => style.remove());
  await page.viewport(1440, 900);
  const shell = createRootRoute({
    component: () => (
      <SidebarProvider>
        <nav className="w-64 shrink-0 border-r bg-sidebar p-3">
          <EnterpriseSidebarRows />
        </nav>
        <TabsFrame />
      </SidebarProvider>
    ),
  });
  const route = createRoute({
    getParentRoute: () => shell,
    path: "/channels/$channelId",
    component: () => {
      const search = route.useSearch() as { thread?: string };
      return (
        <ChannelPage
          id={(route.useParams() as { channelId: string }).channelId}
          root={search.thread}
        />
      );
    },
  });
  const router = createRouter({
    routeTree: shell.addChildren([
      route,
      createRoute({ getParentRoute: () => shell, path: "/", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await using screen = await render(<RouterProvider router={router} />, { router: false });
  await vi.waitFor(() => expect(publish).toBeDefined());
  await act(() => emit([]));
  expect(screen.getByText("Channels", { exact: true }).elements()).toHaveLength(0);
  const created = await commands.companyChat("leo", {
    kind: "create",
    name: "design",
    purpose: "",
    private: false,
  });
  if (!created.ok) throw new Error(created.message);
  await act(() => emit(["chat"]));
  await screen.getByRole("button", { name: "design", exact: true }).click();
  await expect.element(screen.getByRole("heading", { name: "Welcome to #design" })).toBeVisible();
  await expect.element(screen.getByText("Join #design to post")).toBeVisible();
  await screen.getByRole("button", { name: "Join", exact: true }).click();
  await expect.element(screen.getByRole("textbox", { name: "Channel message" })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: /^platform\b/ }))
    .toHaveAttribute("data-unread", "true");
  await screen.getByRole("button", { name: /^platform\b/ }).click();
  await expect.element(screen.getByText("New messages", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "platform", exact: true }))
    .toHaveAttribute("data-unread", "false");
  async function proof(view: string) {
    if (!import.meta.env.VITE_CHAT_SCREENSHOTS) return;
    for (const theme of ["light", "dark"]) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      await page.screenshot({
        path: import.meta.env.VITE_CHAT_SCREENSHOTS + "/" + view + "-" + theme + ".png",
      });
    }
    document.documentElement.classList.remove("dark");
  }
  expect(useTabsStore.getState().tabs.at(-1)).toMatchObject({ kind: "chat", kept: false });
  await proof("channel");
  expect(screen.getByText("Direct messages", { exact: true }).elements()).toHaveLength(0);
  expect(screen.getByRole("textbox", { name: "Search conversation" }).elements()).toHaveLength(0);
  expect(screen.getByText("hidden-task").elements()).toHaveLength(0);
  expect(screen.getByRole("button", { name: "👍 1" }).elements()).toHaveLength(0);
  expect(screen.getByText("Upload verification").elements()).toHaveLength(0);
  const actions = screen.getByLabelText("Message actions").first();
  await actions.click();
  expect(screen.getByRole("button", { name: "Post to GitHub" }).elements()).toHaveLength(0);
  expect(screen.getByRole("button", { name: "React with thumbs up" }).elements()).toHaveLength(0);
  expect(screen.getByText(/Only an explicit @mention/).elements()).toHaveLength(0);
  await actions.click();
  limited = false;
  await act(() => emit(["chat"]));
  const level = screen.getByRole("combobox", { name: "Channel notifications" });
  await level.selectOptions("all");
  await expect.element(level).toHaveValue("all");
  const input = screen.getByRole("textbox", { name: "Channel message" });
  await input.fill("Upload flow checked.");
  await screen.getByRole("button", { name: "Send message" }).click();
  const messageRow = (text: string) => screen.getByRole("article").filter({ hasText: text });
  await expect.element(messageRow("Upload flow checked.")).toBeVisible();
  await vi.waitFor(() =>
    expect(useTabsStore.getState().tabs.at(-1)).toMatchObject({ kind: "chat", kept: true }),
  );
  await screen.getByRole("button", { name: /2 replies/ }).click();
  await vi.waitFor(() => expect(router.state.location.search).toMatchObject({ thread: message }));
  const reply = screen.getByRole("textbox", { name: "Thread reply" });
  await reply.fill("Test passed on Linux.");
  await screen.getByRole("button", { name: "Send message" }).last().click();
  await expect.element(messageRow("Test passed on Linux.")).toBeVisible();
  expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(window.innerHeight);
  await proof("thread");
  await messageRow("Test passed on Linux.").getByLabelText("Message actions").click();
  await messageRow("Test passed on Linux.")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await reply.fill("Checked on Linux.");
  await screen.getByRole("button", { name: "Send message" }).last().click();
  await expect.element(messageRow("Checked on Linux.")).toBeVisible();
  await messageRow("Checked on Linux.")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect.element(screen.getByText("Message deleted")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /2 replies/ })).toBeVisible();
  await screen.getByRole("button", { name: "Start direct message" }).click();
  await screen.getByRole("checkbox", { name: "kim" }).click();
  await screen.getByRole("checkbox", { name: "leo" }).click();
  await screen.getByRole("button", { name: "Open conversation" }).click();
  await expect.element(screen.getByText(/The relay's operator can read it/)).toBeVisible();
  await expect.element(screen.getByText("kim's agents can read this conversation.")).toBeVisible();
  const optIn = screen.getByRole("checkbox", { name: "My agents can read my DMs" });
  await expect.element(optIn).not.toBeChecked();
  await optIn.click();
  await expect.element(screen.getByText("ada's agents can read this conversation.")).toBeVisible();
  const otherClient = await commands.companyChat("leo", { kind: "list" });
  if (!otherClient.ok) throw new Error(otherClient.message);
  const secondDm = decodeConversations(otherClient.value).items.find(
    (c) => c.kind === "dm" && c.members.some((m) => m.kind === "person" && m.login === "ada"),
  );
  if (secondDm?.kind !== "dm") throw new Error("Leo cannot open the DM.");
  {
    await using leoScreen = await render(
      <DmPrivacy showAgentReaders channel={secondDm} login="leo" title="ada, kim" />,
    );
    await expect
      .element(leoScreen.getByText("ada's agents can read this conversation."))
      .toBeVisible();
  }
  const dm = screen.getByRole("textbox", { name: "Direct message" });
  await dm.fill("Can we review the release together?");
  await screen.getByRole("button", { name: "Send message" }).click();
  await expect.element(messageRow("Can we review the release together?")).toBeVisible();
  await proof("group-dm");
  await screen.getByRole("button", { name: "Start direct message" }).click();
  await screen.getByRole("checkbox", { name: /leo\/reviewer/ }).click();
  await screen.getByRole("button", { name: "Open conversation" }).click();
  await expect
    .element(screen.getByText("Questions only. This agent takes instructions from leo."))
    .toBeVisible();
  await screen.getByRole("textbox", { name: "Direct message" }).fill("Which checks passed?");
  await screen.getByRole("button", { name: "Send message" }).click();
  await expect.element(screen.getByText("Which checks passed?")).toBeVisible();
  await proof("agent-dm");
  await act(() => useWorkspacesStore.setState({ activeId: null }));
  await expect.element(screen.getByText("Channels", { exact: true })).not.toBeInTheDocument();
});

it("offers an outsider only one DM recipient from their joined channels", async () => {
  const me = await commands.companyChat("outsideStart");
  await using resources = new AsyncDisposableStack();
  resources.defer(() => commands.companyChat("stop"));
  using rpc = vi.spyOn(chatRpc, "run").mockImplementation(async (_, action) => {
    const reply = await commands.companyChat("call", action);
    if (!reply.ok) throw new Error(reply.message);
    return reply.value;
  });
  const target = { environmentId: EnvironmentId.make("local"), relayOrigin: "https://chat.test" };
  function Picker() {
    const feed = useEnvironmentFeed(null);
    return (
      <SidebarProvider>
        <ChannelRows
          onOpen={() => {}}
          enterprise={{
            environmentId: target.environmentId,
            target,
            workspace: {
              id: "ent-rosa",
              kind: "enterprise",
              name: "Company",
              updatedAt: "2026-11-27T00:00:00Z",
              projectKeys: [],
            },
            enrolment: {
              state: "configured",
              workspaceId: "ent-rosa",
              relayOrigin: target.relayOrigin,
              me,
            },
            feed: { ...feed, chatFlags: ["channels", "private_channels", "dms", "group_dms"] },
          }}
        />
      </SidebarProvider>
    );
  }
  await using screen = await render(<Picker />);
  await expect.element(screen.getByText("launch", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Start direct message" }).click();
  await expect.element(screen.getByRole("radio", { name: "ana" })).toBeVisible();
  expect(screen.getByRole("radio").elements()).toHaveLength(1);
  expect(screen.getByRole("checkbox").elements()).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Create channel" }).elements()).toHaveLength(0);
  expect(rpc).toHaveBeenCalledWith(target, expect.objectContaining({ kind: "members" }));
});
