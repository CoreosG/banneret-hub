import type { SignInAction, SourceSignIn } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { SignInPrompts, SignInSettingsList } from "./SourceSignIns";
import { keepBrowserStorage } from "./test/browserStorage";
import { expectClickable, forEachViewport, windowRect } from "./test/viewports";
import "~/index.css";

vi.mock(import("~/environments/primary/target"), async (original) => ({
  ...(await original()),
  readPrimaryEnvironmentTarget: () => null,
}));

const row = (over: Partial<SourceSignIn> & Pick<SourceSignIn, "sourceId">): SourceSignIn => ({
  relayOrigin: "https://relay.example.test",
  company: "Acme",
  title: "Acme " + over.sourceId,
  address: "mcp.example.test",
  auth: "oauth",
  state: "signed_out",
  ...over,
});

const signInPage = "https://id.example.test/authorize?state=" + "s".repeat(120);

/** One row for each state a person can meet, with long text where a company can send it. */
const EVERY_STATE: readonly SourceSignIn[] = [
  row({ sourceId: "tracker", state: "signed_in" }),
  row({ sourceId: "wiki", state: "signed_out" }),
  row({ sourceId: "memory", state: "expired", authorizationUrl: signInPage }),
  row({ sourceId: "search", state: "refused" }),
  row({
    sourceId: "jira",
    auth: "bearer_per_person",
    help: "Create a personal token at https://jira.example.test/secure/ViewProfile/personal-access-tokens-for-your-own-account and give it read and write access.",
    address: "a-very-long-gateway-host-name.internal.platform.engineering.example.test:8443",
  }),
  row({ sourceId: "vpn", auth: "none", state: "network" }),
];

const card = (name: string) => page.getByRole("region", { name, exact: true });

/** The person's own copies: off beside a signed-in and a network server, still on beside the rest. */
const OWN_COPIES: readonly SourceSignIn[] = [
  row({ sourceId: "tracker", state: "signed_in", ownCopy: { settings: "Codex", off: true } }),
  row({
    sourceId: "vpn",
    title: "Acme platform engineering gateway for every internal service and long-lived tool",
    auth: "none",
    state: "network",
    ownCopy: { settings: "Claude", off: true },
  }),
  row({ sourceId: "wiki", state: "signed_out", ownCopy: { settings: "Claude", off: false } }),
];

describe("company sign-ins", () => {
  it("says each state and offers only what fits it", async () => {
    await using _view = await render(
      <SignInSettingsList label="this machine" rows={EVERY_STATE} act={vi.fn()} />,
    );
    for (const [title, state] of [
      ["Acme tracker", "Signed in"],
      ["Acme wiki", "Signed out"],
      ["Acme memory", "Expired"],
      ["Acme search", "Refused"],
      ["Acme vpn", "No sign-in needed"],
    ] as const)
      await expect.element(card(title).getByText(state, { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Sign out of Acme tracker" }))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Sign in to Acme wiki" })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Sign in to Acme search" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Open sign-in page" }))
      .toHaveAttribute("href", signInPage);
    await expect.element(page.getByText(/Create a personal token/)).toBeVisible();
    // A network identity has nothing to press.
    expect(card("Acme vpn").element().querySelector("button, input, a")).toBeNull();
    expect(card("Acme tracker").element().querySelector("input, a")).toBeNull();
  });

  it("sends each action once, redacts what was pasted and empties the field", async () => {
    const sent: SignInAction[] = [];
    const act = vi.fn(async (action: SignInAction) => void sent.push(action));
    await using _view = await render(
      <SignInSettingsList label="this machine" rows={EVERY_STATE} act={act} />,
    );
    await page.getByRole("button", { name: "Sign in to Acme wiki" }).click();
    await page.getByRole("button", { name: "Sign out of Acme tracker" }).click();

    const pasted = page.getByRole("textbox", { name: "Address from the Acme memory sign-in" });
    await pasted.fill(" http://127.0.0.1:3793/banneret/sources/oauth/callback?code=c&state=s ");
    await page.getByRole("button", { name: "Finish sign-in" }).click();
    await expect.element(pasted).toHaveValue("");

    const token = page.getByLabelText("Access token for Acme jira");
    await expect.element(token).toHaveAttribute("type", "password");
    await token.fill("personal-secret");
    await page.getByRole("button", { name: "Save token" }).click();
    await expect.element(token).toHaveValue("");

    const target = (sourceId: string) => ({
      relayOrigin: "https://relay.example.test",
      sourceId,
    });
    expect(sent.slice(0, 2)).toEqual([
      { kind: "start", ...target("wiki") },
      { kind: "sign_out", ...target("tracker") },
    ]);
    const [, , finish, save] = sent;
    expect(finish?.kind === "finish" && Redacted.value(finish.callbackUrl)).toBe(
      "http://127.0.0.1:3793/banneret/sources/oauth/callback?code=c&state=s",
    );
    expect(save?.kind === "token" && Redacted.value(save.token)).toBe("personal-secret");
    expect(JSON.stringify(sent)).not.toContain("personal-secret");
    expect(document.body.innerHTML).not.toContain("personal-secret");
  });

  it("shows what the machine answered when an action fails", async () => {
    await using _view = await render(
      <SignInSettingsList
        label="this machine"
        rows={[EVERY_STATE[4]!]}
        act={async () => {
          throw new Error("Acme jira refused that token.");
        }}
      />,
    );
    await page.getByLabelText("Access token for Acme jira").fill("wrong");
    await page.getByRole("button", { name: "Save token" }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Acme jira refused that token.");
  });

  it("prompts in a thread only for servers that wait on the person", async () => {
    await using view = await render(<SignInPrompts rows={EVERY_STATE} act={vi.fn()} />);
    for (const name of ["wiki", "memory", "search", "jira"])
      await expect.element(card(`Acme ${name} needs your sign-in`)).toBeVisible();
    expect(view.container.querySelectorAll("section")).toHaveLength(4);
    await view.rerender(
      <SignInPrompts
        rows={EVERY_STATE.filter((r) => r.state === "signed_in" || r.state === "network")}
        act={vi.fn()}
      />,
    );
    expect(view.container.querySelectorAll("section")).toHaveLength(0);
  });

  it("says in the thread what happened to the person's own copies, whatever the sign-in", async () => {
    await using view = await render(<SignInPrompts rows={OWN_COPIES} act={vi.fn()} />);
    const notes = card("Company servers");
    await expect
      .element(
        notes.getByText(
          "Your own copy of Acme tracker is turned off in this chat; the company copy runs through the Hub. It is also in your Codex settings, which stay as they are.",
        ),
      )
      .toBeVisible();
    await expect
      .element(notes.getByText(/gateway .* is turned off in this chat.*your Claude settings/))
      .toBeVisible();
    await expect
      .element(
        notes.getByText(
          "Your own copy of Acme wiki is also in your Claude settings and is still on in this chat. It skips the company's tool access and approvals. Remove it from your Claude settings, then start a new chat.",
        ),
      )
      .toBeVisible();
    // The one server that waits on the person still asks them to sign in.
    await expect.element(card("Acme wiki needs your sign-in")).toBeVisible();
    expect(view.container.querySelectorAll("[data-slot=own-copy]")).toHaveLength(3);

    await view.rerender(<SignInPrompts rows={EVERY_STATE} act={vi.fn()} />);
    expect(view.container.querySelector("[data-slot=own-copy]")).toBeNull();
    expect(page.getByRole("region", { name: "Company servers" }).elements()).toHaveLength(0);
  });

  it("shows nothing on a machine without company servers", async () => {
    await using view = await render(
      <SignInSettingsList label="this machine" rows={[]} act={vi.fn()} />,
    );
    expect(view.container.textContent).toBe("");
  });
});

for (const [surface, content] of [
  [
    "the sign-in settings",
    <SignInSettingsList key="settings" label="this machine" rows={EVERY_STATE} act={vi.fn()} />,
  ],
  [
    "the sign-in prompts",
    <SignInPrompts key="thread" rows={[EVERY_STATE[2]!, EVERY_STATE[4]!]} act={vi.fn()} />,
  ],
] as const) {
  forEachViewport(`${surface} keep every control reachable`, async (at) => {
    await using view = await render(
      // The app's panels scroll inside the window; the page itself never does.
      <main
        data-testid="panel"
        className="scrollbar-gutter-both h-dvh overflow-y-auto overflow-x-hidden bg-background p-4 text-foreground"
      >
        <div className="mx-auto w-full max-w-3xl">{content}</div>
      </main>,
    );
    const panel = page.getByTestId("panel").element();
    await expect.element(page.getByRole("button", { name: "Save token" })).toBeVisible();
    await at.screenshot();
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
    for (const element of view.container.querySelectorAll(
      "button, input, a, [data-slot=sign-in-state], p, strong",
    )) {
      element.scrollIntoView({ block: "center" });
      const box = element.getBoundingClientRect();
      expect(box.width).toBeGreaterThan(0);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(windowRect().right);
      // Text that is wider than its own box would be cut off.
      expect(element.scrollWidth).toBeLessThanOrEqual(Math.ceil(box.width) + 1);
      if (element.matches("button, a"))
        expectClickable(element, element.textContent ?? "a control");
    }
  });
}

forEachViewport("the own copy notes wrap inside the thread", async (at) => {
  using _storage = keepBrowserStorage();
  await using view = await render(
    <main
      data-testid="panel"
      className="scrollbar-gutter-both h-dvh overflow-y-auto overflow-x-hidden bg-background p-4 text-foreground"
    >
      <div className="mx-auto w-full max-w-3xl">
        <SignInPrompts rows={OWN_COPIES} act={vi.fn()} />
      </div>
    </main>,
  );
  await expect.element(card("Company servers")).toBeVisible();
  await at.screenshot();
  const panel = page.getByTestId("panel").element();
  expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
  const notes = view.container.querySelectorAll("[data-slot=own-copy]");
  expect(notes).toHaveLength(3);
  for (const note of notes) {
    note.scrollIntoView({ block: "center" });
    const box = note.getBoundingClientRect();
    expect(box.height).toBeGreaterThan(0);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(windowRect().right);
    expect(note.scrollWidth).toBeLessThanOrEqual(Math.ceil(box.width) + 1);
  }
});
