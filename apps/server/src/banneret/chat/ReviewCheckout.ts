// @effect-diagnostics nodeBuiltinImport:off - Git prepares a private directory for the review thread.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import type { AskPr } from "@t3tools/contracts";

// Git may inherit repository-local paths from the process that started the Hub.
function gitEnvironment() {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ])
    delete env[key];
  return env;
}
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
function reviewRemote(pr: AskPr) {
  if (
    !/^[\w-]+\/[\w.-]+$/.test(pr.repo) ||
    /\/\.{1,2}$/.test(pr.repo) ||
    !Number.isSafeInteger(pr.number) ||
    pr.number < 1 ||
    !/^[0-9a-f]{40}$/.test(pr.headSha)
  )
    throw new Error("Choose a GitHub pull request and its full head SHA.");
  return "https://github.com/" + pr.repo + ".git";
}
export async function currentReviewHead(pr: AskPr) {
  const { stdout } = await exec(
    "git",
    ["ls-remote", "--exit-code", reviewRemote(pr), "refs/pull/" + pr.number + "/head"],
    { timeout: 30000, env: gitEnvironment() },
  );
  return stdout.split(/\s/)[0];
}

export async function reviewCheckout(pr: AskPr, remote = reviewRemote(pr)) {
  const cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "banneret-review-"));
  const git = async (...args: string[]) =>
    (
      await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd,
        timeout: 120000,
        env: gitEnvironment(),
      })
    ).stdout.trim();
  try {
    await git("init", "--quiet", "--template=");
    await git("remote", "add", "origin", remote);
    await git("fetch", "--no-tags", "origin", "refs/pull/" + pr.number + "/head");
    if ((await git("rev-parse", "FETCH_HEAD")) !== pr.headSha) throw new Error("head_moved");
    await git("checkout", "--quiet", "--detach", pr.headSha);
    return cwd;
  } catch (error) {
    await NodeFSP.rm(cwd, { recursive: true, force: true });
    throw error;
  }
}
