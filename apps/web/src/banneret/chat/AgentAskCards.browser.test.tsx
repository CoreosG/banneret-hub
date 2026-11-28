import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { commands } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { AskCard, WaitingAsks } from "./AgentAskCards";
import { chatRpc } from "./client";

it("lets the owner allow a question, posts its receipt and auto-accepts the next question", async () => {
  await commands.companyChat("h1:start");
  await using resources = new AsyncDisposableStack();
  resources.defer(() => commands.companyChat("h1:stop"));
  using _rpc = vi.spyOn(chatRpc, "run").mockImplementation(async (_, action) => {
    const result = await commands.companyChat("h1:leo", action);
    if (!result.ok) throw new Error(result.message);
    return result.value;
  });
  const { ask, item } = await commands.companyChat("h1:agentAsk", "first");
  expect(ask.state).toBe("waiting_owner");
  const target = { environmentId: EnvironmentId.make("local"), relayOrigin: "https://relay.test" };
  await using needs = await render(<WaitingAsks item={item} target={target} />);
  await expect.element(needs.getByText("Which file defines retries?")).toBeVisible();
  await expect.element(needs.getByRole("link", { name: /#platform/ })).toBeVisible();
  await expect.element(needs.getByRole("button", { name: "Draft first" })).toBeEnabled();
  await expect.element(needs.getByRole("button", { name: "Answer myself" })).toBeEnabled();
  await expect.element(needs.getByRole("button", { name: "Decline", exact: true })).toBeEnabled();
  await needs.getByRole("checkbox").click();
  await needs.getByRole("button", { name: "Let it answer" }).click();
  await vi.waitFor(() =>
    expect(needs.getByRole("button", { name: "Let it answer" }).elements()).toHaveLength(0),
  );
  const answer = await commands.companyChat("h1:agentAnswer", ask.id);
  await using card = await render(<AskCard ask={answer} />);
  await expect.element(card.getByText("upload.ts")).toBeVisible();
  await expect.element(card.getByText(/180 tokens · 3 s · read/)).toBeVisible();
  expect((await commands.companyChat("h1:agentAsk", "second")).ask).toMatchObject({
    state: "open",
    reason: "auto_accepted",
  });
});
