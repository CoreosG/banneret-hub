// @effect-diagnostics nodeBuiltinImport:off - use a real temporary Git repository for the checkout test.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { reviewCheckout } from "./ReviewCheckout.ts";

it("checks out the requested PR head in a clean directory and rejects a moved head", async () => {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "review-test-"));
  using cleanup = new DisposableStack();
  cleanup.defer(() => NodeFS.rmSync(repo, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git(repo, "init", "-q");
  git(
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.org",
    "commit",
    "--allow-empty",
    "-qm",
    "head",
  );
  const headSha = git(repo, "rev-parse", "HEAD");
  git(repo, "update-ref", "refs/pull/2/head", headSha);
  NodeFS.writeFileSync(NodePath.join(repo, "private"), "builder changes");
  const pr = { repo: "acme/app", number: 2, headSha };
  const cwd = await reviewCheckout(pr, repo);
  cleanup.defer(() => NodeFS.rmSync(cwd, { recursive: true, force: true }));
  expect(git(cwd, "status", "--porcelain")).toBe("");
  expect(git(cwd, "rev-parse", "HEAD")).toBe(headSha);
  await expect(reviewCheckout({ ...pr, headSha: "0".repeat(40) }, repo)).rejects.toThrow(
    "head_moved",
  );
});
