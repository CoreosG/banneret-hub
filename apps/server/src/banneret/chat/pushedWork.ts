// @effect-diagnostics nodeBuiltinImport:off - git checks the exact branch in the registered checkout and its remote.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import { projectKeyFromRemote } from "../relay/projectKey.ts";
import { invalid } from "./AgentChat.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
export const verifyPushedWork = (
  projects: ReadonlyArray<{
    workspaceRoot: string;
    repositoryIdentity?: { locator: { remoteUrl: string } } | null | undefined;
  }>,
  ref: { host?: string | undefined; scope: string },
  branch: string,
  head: string,
) =>
  Effect.tryPromise({
    try: async () => {
      const repository = projectKeyFromRemote(
        "https://" + (ref.host ?? "github.com") + "/" + ref.scope,
      );
      if (!repository || !/^[a-f0-9]{40}$/.test(head)) throw new Error();
      for (const project of projects) {
        if (
          !project.repositoryIdentity ||
          projectKeyFromRemote(project.repositoryIdentity.locator.remoteUrl) !== repository
        )
          continue;
        const git = async (...args: string[]) =>
          (
            await exec("git", args, {
              cwd: project.workspaceRoot,
              timeout: 15000,
              env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
            })
          ).stdout.trim();
        await git("check-ref-format", "refs/heads/" + branch);
        const full = "refs/heads/" + branch;
        if (projectKeyFromRemote(await git("remote", "get-url", "origin")) !== repository) continue;
        if ((await git("rev-parse", "--verify", full).catch(() => "")) !== head) continue;
        if (
          (await git("ls-remote", "--exit-code", "--refs", "origin", full)) ===
          head + "\t" + full
        )
          return;
      }
      throw new Error();
    },
    catch: () =>
      invalid(
        "Push the named branch and supply its full current head SHA from the task repository.",
      ),
  });
