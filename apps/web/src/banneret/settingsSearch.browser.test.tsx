import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { SidebarProvider } from "../components/ui/sidebar";
import { SettingsSidebarNav } from "../components/settings/SettingsSidebarNav";
vi.mock(import("~/environments/primary/target"), async (original) => ({
  ...(await original()),
  readPrimaryEnvironmentTarget: () => null,
}));

vi.mock("../components/chat/GlobalVoiceInputIndicator", () => ({
  GlobalVoiceInputIndicator: () => null,
}));
it("finds Accounts and Banneret memory in Settings", async () => {
  await using _screen = await render(
    <SidebarProvider defaultOpen>
      <SettingsSidebarNav pathname="/settings/general" />
    </SidebarProvider>,
    { router: "/settings/general" },
  );
  const search = page.getByRole("combobox", { name: "Search settings" });
  for (const query of ["Accounts", "Use Banneret memory", "Relay identity", "Tailscale login"]) {
    await search.fill(query);
    await expect
      .element(page.getByRole("option", { name: new RegExp(query) }).first())
      .toBeVisible();
  }
});

it.each([
  ["wake", "Wake agents", "agent-wake"],
  ["wake agents", "Wake agents", "agent-wake"],
  ["who can wake", "Wake agents", "agent-wake"],
  ["pause", "Pause new work", "automatic-work"],
  ["stop all", "Stop all", "automatic-work"],
])("jumps from a search for %s to %s", async (query, title, target) => {
  await using screen = await render(
    <SidebarProvider defaultOpen>
      <SettingsSidebarNav pathname="/settings/general" />
    </SidebarProvider>,
    { router: "/settings/general" },
  );
  await page.getByRole("combobox", { name: "Search settings" }).fill(query);
  await page.getByRole("option", { name: new RegExp("^" + title) }).click();
  await vi.waitFor(() => {
    expect(screen.router?.state.location.pathname).toBe("/settings/chat");
    expect(screen.router?.state.location.hash).toBe(target);
  });
});
