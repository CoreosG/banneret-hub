import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { LevelsPanel } from "./ThreadToolLevels";

it("edits one tool source and explains the CLI boundary", async () => {
  const change = vi.fn().mockResolvedValue([{ source: "banneret", level: "none" }]);
  await using _view = await render(
    <LevelsPanel
      load={async () => [{ source: "banneret", level: "read_write" }]}
      change={change}
    />,
  );
  const selector = page.getByRole("combobox", { name: "Banneret tools" });
  await expect.element(selector).toHaveValue("read_write");
  await selector.selectOptions("none");
  await expect.element(selector).toHaveValue("none");
  expect(change).toHaveBeenCalledWith("banneret", "none");
  await expect.element(page.getByText(/Shell and files follow/)).toBeVisible();
});
