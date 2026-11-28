import { RunId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { PauseBanner } from "./Pause";
it("shows held work and targets the displayed run when stopped", async () => {
  const onAction = vi.fn();
  const run = { runId: RunId.make("running"), threadId: ThreadId.make("thread"), title: "Review" };
  await using screen = await render(
    <PauseBanner
      status={{ paused: true, held: 2, running: [run] }}
      label="This machine"
      disabled={false}
      onAction={onAction}
    />,
  );
  await expect.element(screen.getByText(/2 held/)).toBeVisible();
  await screen.getByRole("button", { name: "Stop", exact: true }).click();
  expect(onAction).toHaveBeenLastCalledWith({
    kind: "stop",
    threadId: run.threadId,
    runId: run.runId,
  });
  await screen.getByRole("button", { name: "Stop all" }).click();
  expect(onAction).toHaveBeenLastCalledWith({ kind: "stopAll" });
  await screen.getByRole("button", { name: "Resume" }).click();
  expect(onAction).toHaveBeenLastCalledWith({ kind: "resume" });
});
