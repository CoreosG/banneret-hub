import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { SidebarProvider } from "../components/ui/sidebar";
import { SettingsSidebarNav } from "../components/settings/SettingsSidebarNav";
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
