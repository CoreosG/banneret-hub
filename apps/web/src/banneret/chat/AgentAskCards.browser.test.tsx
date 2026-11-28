import appCss from "../../index.css?inline";
import { EnvironmentId, type ChatAsk } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, commands, userEvent } from "vite-plus/test/browser";
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

it("shows the reviewed commit and findings and posts only on a person's click at the current head", async () => {
  const headSha = "36f141bab4f16987292b38018123456789abcdef";
  const maker = { id: "ana", login: "ana" };
  const reviewer = { id: "leo", login: "leo" };
  const result = {
    id: "review",
    from: { owner: maker, handle: "ana/builder" },
    to: { kind: "agent", owner: reviewer, handle: "leo/reviewer" },
    choices: [],
    depth: 1,
    createdAt: "2026-11-28T00:00:00Z",
    expiresAt: "2026-11-28T04:00:00Z",
    onBehalfOf: maker,
    kind: "review",
    state: "answered",
    question: "Does retrying a failed upload preserve its batch?",
    pr: { repo: "acme/platform", number: 17, headSha },
    receipts: [{ handle: "leo/reviewer", tokens: 1278, seconds: 19, tools: ["read"] }],
    answer: {
      by: "leo/reviewer",
      text: "The retry drops the final batch. I checked the worker and its tests. I did not check mobile uploads.",
      verdict: "findings",
      headSha,
    },
  } satisfies ChatAsk;
  using resources = new DisposableStack();
  await page.viewport(720, 460);
  const postReview = vi.fn(async () => "Posted to GitHub");
  const style = document.head.appendChild(document.createElement("style"));
  style.textContent = appCss;
  resources.defer(() => style.remove());
  const owner = result.to.owner.login;
  await using other = await render(
    <AskCard ask={result} viewer="other" currentHead={headSha} postReview={postReview} />,
  );
  expect(other.getByRole("button", { name: "Post as review" }).elements()).toHaveLength(0);
  await other.unmount();
  await using card = await render(
    <AskCard viewer={owner} ask={result} currentHead={headSha} postReview={postReview} />,
  );
  await expect.element(card.getByText("Review result: findings")).toBeVisible();
  await expect.element(card.getByText(result.answer.text)).toBeVisible();
  const sha = card.getByRole("button", { name: headSha.slice(0, 7) }).first();
  await userEvent.hover(sha);
  await expect.element(page.getByText(headSha, { exact: true })).toBeVisible();
  await userEvent.unhover(sha);
  if (import.meta.env.VITE_H4_SCREENSHOTS)
    await page.screenshot({ path: import.meta.env.VITE_H4_SCREENSHOTS + "/card-after.png" });
  expect(postReview).not.toHaveBeenCalled();
  await card.getByRole("button", { name: "Post as review" }).click();
  expect(postReview).toHaveBeenCalledTimes(1);
  await using stale = await render(
    <AskCard viewer={owner} ask={result} currentHead={"b".repeat(40)} postReview={postReview} />,
  );
  await expect.element(stale.getByText(/Stale: reviewed at/)).toBeVisible();
  expect(stale.getByRole("button", { name: "Post as review" }).elements()).toHaveLength(0);
});
