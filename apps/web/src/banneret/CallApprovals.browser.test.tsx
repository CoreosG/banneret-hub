import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { CallApprovalCard } from "./CallApprovals";
it("shows the stored arguments, omits always for a restricted call, and returns the winning decision", async () => {
  const call = {
    id: "call",
    threadTitle: "Builder",
    sensitive: true,
    threadId: "thread",
    source: "plugin:tracker",
    name: "tasks_release",
    args: '{"taskId":"T398"}',
    allowAlways: false,
    state: "pending" as const,
    actor: "",
    reason: "",
  };
  const decide = vi
    .fn()
    .mockResolvedValue({ ...call, state: "refused", actor: "Ana", reason: "Already released." });
  await using _view = await render(<CallApprovalCard call={call} decide={decide} />);
  await expect.element(page.getByText(/"T398"/)).toBeVisible();
  await expect.element(page.getByRole("button", { name: /always allow/i })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Approve once" }).click();
  expect(decide).toHaveBeenCalledWith("once", "");
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Refused by Ana. Already released.");
});
