// @effect-diagnostics nodeBuiltinImport:off - isolated git repositories and an SSH transport fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";
import { verifyPushedWork } from "./pushedWork.ts";

it.effect("requires the advertised branch head both locally and on the task remote", () =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "handoff-"));
    try {
      const git = (...args: string[]) =>
        NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
      git("init", "--quiet", "-b", "work");
      git("init", "--bare", "--quiet", "remote.git");
      const commit = () =>
        git(
          "-c",
          "user.name=A",
          "-c",
          "user.email=a@example.org",
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "work",
        );
      commit();
      const remoteUrl = "git@example.org:team/repo.git";
      git("remote", "add", "origin", remoteUrl);
      git("config", "core.sshCommand", "git-upload-pack ./remote.git #");
      git("push", "--quiet", "./remote.git", "work");
      const input = [{ workspaceRoot: root, repositoryIdentity: { locator: { remoteUrl } } }];
      const verify = (head: string) =>
        verifyPushedWork(input, { host: "example.org", scope: "team/repo" }, "work", head);
      const first = git("rev-parse", "HEAD");
      yield* verify(first);
      commit();
      expect((yield* Effect.flip(verify(git("rev-parse", "HEAD")))).message).toMatch(
        /Push the named branch/,
      );
      expect((yield* Effect.flip(verify(first))).message).toMatch(/Push the named branch/);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  }),
);
