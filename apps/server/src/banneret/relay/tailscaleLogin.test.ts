import { expect, it } from "vite-plus/test";
import { readTailscaleLogin } from "./tailscaleLogin.ts";

it("reports only the running node's own user", async () => {
  const value = {
    BackendState: "Running",
    Self: { UserID: 2 },
    User: { 1: { LoginName: "peer" }, 2: { LoginName: "me@example.com" } },
  };
  expect(await readTailscaleLogin(async () => JSON.stringify(value))).toBe("me@example.com");
  expect(
    await readTailscaleLogin(async () => JSON.stringify({ ...value, BackendState: "Stopped" })),
  ).toBeNull();
  expect(await readTailscaleLogin(async () => JSON.stringify({ ...value, User: {} }))).toBeNull();
  expect(
    await readTailscaleLogin(async () => {
      throw Error("unavailable");
    }),
  ).toBeNull();
});
