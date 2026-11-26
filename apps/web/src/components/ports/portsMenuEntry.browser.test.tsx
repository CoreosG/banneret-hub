import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { RightPanelTabs, type RightPanelTabsProps } from "../RightPanelTabs";

const state = vi.hoisted(() => ({ forwards: [] as ReadonlyArray<{ remotePort: number }> }));
vi.mock("~/state/portForwards", async (original) => ({
  ...(await original<typeof import("~/state/portForwards")>()),
  usePortForwards: () => state.forwards,
}));

const noop = () => {};

function Tabs(props: Partial<RightPanelTabsProps>) {
  const base: RightPanelTabsProps = {
    mode: "embedded",
    keybindings: [],
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
    }),
    surfaces: [{ id: "ports", kind: "ports" }],
    environmentId: null,
    activeSurfaceId: "ports",
    pendingSurfaceIds: new Set(),
    previewSessions: {},
    desktopByTabId: {},
    terminalLabelsById: new Map(),
    onActivate: noop,
    onCloseSurface: noop,
    onCloseOtherSurfaces: noop,
    onCloseSurfacesToRight: noop,
    onCloseAllSurfaces: noop,
    onCopyFilePath: noop,
    onAddBrowser: noop,
    onAddBrowserInProfile: noop,
    onAddTerminal: noop,
    onAddDiff: noop,
    onAddFiles: noop,
    onAddPullRequest: noop,
    onAddPullRequests: noop,
    onAddDevice: noop,
    browserAvailable: false,
    terminalAvailable: true,
    diffAvailable: false,
    filesAvailable: false,
    pullRequestAvailable: false,
    pullRequestsAvailable: false,
    deviceAvailable: false,
    children: null,
    ...props,
  } as RightPanelTabsProps;
  return <RightPanelTabs {...base} />;
}

describe("Ports in the right panel", () => {
  it("the add-tab menu lists Ports and opens it", async () => {
    state.forwards = [];
    const onAddPorts = vi.fn();
    await using _screen = await render(<Tabs onAddPorts={onAddPorts} />);
    await userEvent.click(page.getByRole("button", { name: "Add panel surface" }));
    await userEvent.click(page.getByRole("menuitem", { name: /Ports/ }));
    expect(onAddPorts).toHaveBeenCalledTimes(1);
  });

  it("offers no Ports entry where the host gives no way to open it", async () => {
    state.forwards = [];
    await using _screen = await render(<Tabs />);
    await userEvent.click(page.getByRole("button", { name: "Add panel surface" }));
    await expect.element(page.getByRole("menuitem", { name: /Terminal/ })).toBeVisible();
    expect(page.getByRole("menuitem", { name: /Ports/ }).elements()).toHaveLength(0);
  });

  it("the Ports tab shows how many forwards are active", async () => {
    state.forwards = [{ remotePort: 3000 }, { remotePort: 5173 }];
    await using _screen = await render(<Tabs onAddPorts={noop} />);
    await expect.element(page.getByTestId("ports-forward-count").first()).toHaveTextContent("2");
  });
});
