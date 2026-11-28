import { MemoryContradictionCard } from "./MemoryContradictionCard";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { MemoryNotes } from "./MemoryReview";
vi.mock(import("~/environments/primary/target"), async (original) => ({
  ...(await original()),
  readPrimaryEnvironmentTarget: () => null,
}));

const feedback = vi.hoisted(() => ({ list: vi.fn(), send: vi.fn() }));
vi.mock("./chat/client", async (load) => ({
  ...(await load<typeof import("./chat/client")>()),
  conversations: feedback.list,
  chatRpc: { run: feedback.send },
}));
const note = {
  key: "Format",
  text: "Two spaces",
  source: "Style guide",
  why: "Keep indentation consistent",
  scope: "project",
  kind: "reference",
  trust: "proposed",
  flaggedBy: "",
  reason: "",
  version: "1",
};
it("reviews proposals and disputes directly in a collapsed conversation", async () => {
  const apply = vi.fn().mockResolvedValue(undefined);
  const show = (n: typeof note) => (
    <MemoryNotes expanded={false} notes={[n]} apply={apply} writable />
  );
  await using screen = await render(show(note));
  await expect.element(screen.getByText(/Style guide/)).toBeVisible();
  await expect.element(screen.getByText(/Keep indentation consistent/)).toBeVisible();
  await screen.getByRole("button", { name: "Edit then confirm" }).click();
  await screen.getByRole("textbox").fill("Four spaces");
  await screen.getByRole("button", { name: "Save and confirm" }).click();
  expect(apply).toHaveBeenCalledWith(note, { kind: "editConfirm", text: "Four spaces" });
  await screen.getByRole("button", { name: "Confirm", exact: true }).click();
  expect(apply).toHaveBeenCalledWith(note, { kind: "confirm" });
  await screen.getByRole("button", { name: "Dismiss" }).click();
  expect(apply).toHaveBeenCalledWith(note, { kind: "dismiss" });
  const disputed = {
    ...note,
    trust: "disputed",
    version: "2",
    flaggedBy: "chat-a",
    reason: "Guide changed",
  };
  await screen.rerender(show(disputed));
  await expect.element(screen.getByText(/Flagged by chat-a: Guide changed/)).toBeVisible();
  await screen.getByRole("button", { name: "Keep", exact: true }).click();
  expect(apply).toHaveBeenCalledWith(disputed, { kind: "keep" });
});

it("filters the expanded trust groups by kind and scope", async () => {
  const apply = vi.fn().mockResolvedValue(undefined);
  const pinned = { ...note, trust: "pinned" };
  const personal = {
    ...note,
    key: "Reviews",
    trust: "confirmed",
    kind: "feedback",
    scope: "personal",
  };
  await using screen = await render(
    <MemoryNotes expanded notes={[pinned, personal]} apply={apply} writable />,
  );
  await expect.element(screen.getByRole("heading", { name: "Pinned" })).toBeVisible();
  await screen.getByLabelText("Scope").selectOptions("personal");
  expect(screen.getByText("Format").query()).toBeNull();
  await expect.element(screen.getByText("Reviews")).toBeVisible();
  await screen.getByLabelText("Kind").selectOptions("reference");
  expect(screen.getByText("Reviews").query()).toBeNull();
});

it("opens both citations and submits a scope decision only after Save", async () => {
  const apply = vi.fn().mockResolvedValue(undefined);
  await using screen = await render(
    <MemoryContradictionCard
      conflict={{ id: "123", a: note, b: { text: "Four spaces", source: "AGENTS.md:4" } }}
      writable
      apply={apply}
    />,
  );
  await screen.getByText("Possible contradiction").click();
  await expect
    .element(screen.getByText("To change the provider rule, edit AGENTS.md:4 yourself."))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Keep A" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Keep B" })).toBeVisible();
  await screen.getByRole("button", { name: "Both apply in different scopes" }).click();
  await screen.getByLabelText("A applies when").fill("editing JSON");
  expect(apply).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Save scopes" }).click();
  expect(apply).toHaveBeenCalledWith({
    kind: "scopeConflict",
    id: "123",
    scopeA: "editing JSON",
    scopeB: "running in CI",
  });
});

it("previews the exact public draft and only opens it on a click", async () => {
  const { WorkflowResult } = await import("./WorkflowReview");
  const { EnvironmentId } = await import("@t3tools/contracts");
  const target = {
    environmentId: EnvironmentId.make("local"),
    relayOrigin: "https://example.test",
  };
  feedback.list.mockResolvedValue([
    { kind: "channel", name: "feedback", id: "c1", archived: false, me: { can: { post: true } } },
  ]);
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  try {
    const act = vi.fn();
    await using screen = await render(
      <WorkflowResult
        act={act}
        target={target}
        report={{
          created: 1,
          topRule: null,
          topCount: 0,
          proposalKey: null,
          failures: 0,
          waiting: 0,
          disputed: 0,
          corrections: 0,
          pending: false,
          retries: 2,
          proposed: 0,
          stale: 0,
          contested: 0,
          fired: 0,
          acknowledged: 0,
        }}
      />,
    );
    await expect.element(screen.getByText("Explain agent retries")).toBeVisible();
    expect(feedback.list).not.toHaveBeenCalled();
    expect(feedback.send).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Open draft as a public issue" }).click();
    const url = new URL(String(open.mock.calls[0]?.[0]));
    expect(url.searchParams.get("title")).toBe("Explain agent retries");
    await expect
      .element(screen.getByText(url.searchParams.get("body")!, { exact: true }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Find company feedback channel" }).click();
    expect(feedback.send).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: /Send draft to #feedback/ }).click();
    expect(feedback.send).toHaveBeenCalledWith(
      target,
      expect.objectContaining({
        kind: "post",
        id: "c1",
        text: url.searchParams.get("title") + "\n\n" + url.searchParams.get("body"),
      }),
    );
  } finally {
    open.mockRestore();
  }
});
