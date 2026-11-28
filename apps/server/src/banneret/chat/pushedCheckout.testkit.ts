// @effect-diagnostics nodeBuiltinImport:off - an isolated git repository with a local bare remote.
import * as NodeChildProcess from "node:child_process";

/** A checkout in `root` whose branch `work` is pushed to the task's repository, and its head. */
export function pushedCheckout(root: string) {
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet", "-b", "work");
  git("init", "--bare", "--quiet", "remote.git");
  const author = ["-c", "user.name=A", "-c", "user.email=a@example.org"];
  git(...author, "commit", "--quiet", "--allow-empty", "-m", "work");
  const remoteUrl = "git@github.com:example-org/example-app.git";
  git("remote", "add", "origin", remoteUrl);
  git("config", "core.sshCommand", "git-upload-pack ./remote.git #");
  git("push", "--quiet", "./remote.git", "work");
  return { remoteUrl, head: git("rev-parse", "HEAD") };
}
