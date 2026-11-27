// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - git plumbing uses a temporary object database; the credential lookup pins GitHub and refuses redirects.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { formatNote, parseNote, scanMemory, isMemoryFileError } from "./files.ts";
import { withNotes, type NoteStore } from "./store.ts";

const hash = (s: string | undefined) =>
  s === undefined ? "" : NodeCrypto.createHash("sha256").update(s).digest("hex");
function command(bin: string, args: string[], cwd?: string, input?: string): Promise<string> {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
  } as NodeJS.ProcessEnv;
  for (const name of [
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_WORK_TREE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ])
    delete env[name];
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      bin,
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 60000,
        env,
      },
      (err, out) =>
        err
          ? reject(
              new Error(
                "Git copy failed. Check your login, repository access and connection, then retry.",
              ),
            )
          : resolve(out),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

export function allowsPersonalRepo(capabilities: unknown) {
  // TODO: advertise memory.personalRepo in https://github.com/CoreosG/banneret-platform under internal/hub/contract/relay-v1/.
  if (!capabilities || typeof capabilities !== "object") return false;
  if (!("memory" in capabilities)) return true;
  const memory = capabilities.memory;
  return Boolean(
    memory &&
    typeof memory === "object" &&
    (!("personalRepo" in memory) || memory.personalRepo === true),
  );
}

async function repositoryVisibility(repo: string) {
  const [owner, name] = repo.split("/");
  const query =
    "query($owner:String!,$name:String!){viewer{login} repository(owner:$owner,name:$name){visibility owner{login}}}";
  let response: string;
  try {
    response = await command("gh", [
      "api",
      "--hostname",
      "github.com",
      "graphql",
      "-f",
      "query=" + query,
      "-f",
      "owner=" + owner,
      "-f",
      "name=" + name,
    ]);
  } catch {
    const entry = await command(
      "git",
      ["credential", "fill"],
      undefined,
      "protocol=https\nhost=github.com\npath=" + repo + ".git\n\n",
    );
    const token = /^password=(.+)$/m.exec(entry)?.[1];
    if (!token) throw new Error("Sign in to GitHub with gh or a Git credential helper.");
    const result = await fetch("https://api.github.com/graphql", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { owner, name } }),
    });
    response = await result.text();
  }
  const data = JSON.parse(response)?.data;
  return {
    visibility: String(data?.repository?.visibility ?? ""),
    owner: String(data?.repository?.owner?.login ?? ""),
    login: String(data?.viewer?.login ?? ""),
  };
}
export async function verifyRepo(url: string, lookup = repositoryVisibility) {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!match || match[1]!.split("/").some((x) => x === "." || x === ".."))
    throw new Error("Enter the HTTPS URL of a private GitHub repository you own.");
  const { visibility, owner, login } = await lookup(match[1]!);
  if (visibility !== "PRIVATE" || !login || login !== owner)
    throw new Error("Git copy requires a private repository you own.");
}

export interface CopyContext {
  file: string;
  now: () => number;
  project: string;
  workspace: string;
  projectFolder: string;
  enterprise: boolean;
  allowed: () => Promise<boolean>;
}

export async function syncCopy(ctx: CopyContext, verify = verifyRepo) {
  const open = <T>(f: (s: NoteStore) => T) => withNotes(ctx.file, ctx.project, ctx.now(), f);
  const { url, projects } = open((s) => s.repo.setting());
  if (!url) return "Choose a private repository in Memory settings.";
  const check = async () => {
    const current = open((s) => s.repo.setting());
    if (current.url !== url || current.projects !== projects || !(await ctx.allowed()))
      throw new Error("Git copy is disabled for this workspace.");
    await verify(url);
  };
  await check();
  const tmp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "banneret-memory-"));
  const git = (args: string[], input?: string) =>
    command(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "http.followRedirects=false",
        "-c",
        "user.name=Banneret Hub",
        "-c",
        "user.email=memory@localhost",
        ...(url.startsWith("https://github.com/")
          ? ["-c", "credential.https://github.com.helper=!gh auth git-credential"]
          : []),
        ...args,
      ],
      tmp,
      input,
    );
  try {
    await git(["clone", "--bare", "--single-branch", "--depth=1", "--", url, "."]);
    const ref = (await git(["symbolic-ref", "HEAD"])).trim();
    const head = (await git(["for-each-ref", "--format=%(objectname)", ref])).trim();
    if (head) await git(["read-tree", head]);
    const issues = new Set<string>();
    let dirty = false;
    const records: { folder: string; key: string; digest: string }[] = [];
    for (const scope of ["personal", "project"] as const) {
      if (scope === "project" && ctx.enterprise && !projects) continue;
      const folder =
        ctx.workspace + "/" + (scope === "personal" ? scope : "project/" + ctx.projectFolder);
      const blobs = new Map<string, string>();
      if (head) {
        for (const entry of (await git(["ls-tree", "-z", head, folder + "/"])).split("\0")) {
          const match = /^100644 blob ([a-f0-9]+)\t(.+)$/.exec(entry);
          const name = entry.split("\t")[1]?.slice(folder.length + 1);
          if (!name?.startsWith("note-")) continue;
          if (!match || !/^note-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name))
            throw new Error("Invalid file in the memory folder.");
          blobs.set(name.slice(5, -3), await git(["cat-file", "blob", match[1]!]));
        }
      }
      const updates = open((s) => {
        const base = s.repo.baseline(url, folder);
        const notes = new Map(
          s
            .list(false)
            .filter((n) => n.scope === scope)
            .map((n) => [n.key, n]),
        );
        const changes = new Map<string, string | undefined>();
        for (const key of new Set([...notes.keys(), ...blobs.keys(), ...base.keys()])) {
          const row = notes.get(key);
          const local = row ? formatNote(s.read(key)) : undefined;
          const remote = blobs.get(key);
          try {
            if (local) scanMemory(local);
            if (remote) scanMemory(remote);
          } catch (e) {
            if (!isMemoryFileError(e)) throw e;
            issues.add(key + ": " + e.message);
            continue;
          }
          const prior = base.get(key);
          if (s.repo.pending(key)) {
            issues.add("Review the proposal for " + key + ".");
            continue;
          }
          const l = hash(local),
            r = hash(remote);
          if (l === r) {
            s.repo.remember(url, folder, key, l, r);
            continue;
          }
          if (r === (prior?.remote ?? "")) {
            if (l !== (prior?.local ?? "")) changes.set(key, local);
            continue;
          }
          const parsed = remote ? parseNote("note-" + key + ".md", remote) : undefined;
          const incoming = parsed?.note;
          if (incoming && (incoming.key !== key || incoming.scope !== scope))
            throw new Error("A remote note has an invalid key or scope.");
          const conflict = l !== (prior?.local ?? "");
          if (row) s.review(key, row.version, { kind: "remove" });
          if (conflict || incoming) {
            const note =
              incoming ?? (local ? parseNote("note-" + key + ".md", local).note : undefined);
            if (!note) throw new Error("Missing conflict text.");
            s.propose({
              ...note,
              text: conflict ? (row?.text ?? note.text) : note.text,
              why: conflict
                ? row && incoming
                  ? "Both copies changed. Choose the text to keep."
                  : "Git conflict. One copy was deleted. Confirm to keep the edited text or dismiss to delete."
                : "Copied from your private repository.",
            });
            if (conflict) {
              s.repo.conflict(key, row && incoming ? incoming.text : null);
              issues.add("Review the proposal for " + key + ".");
            }
            if (!conflict && parsed) s.repo.restore(key, parsed.meta);
            s.repo.remember(
              url,
              folder,
              key,
              conflict ? "unresolved" : hash(formatNote(s.read(key))),
              r,
            );
          } else s.repo.remember(url, folder, key, "", "");
        }
        return changes;
      });
      const stage = async (path: string, content: string) => {
        scanMemory(content);
        const oid = (await git(["hash-object", "-w", "--stdin"], content)).trim();
        await git(["update-index", "--add", "--cacheinfo", "100644", oid, path]);
      };
      for (const [key, value] of updates) {
        const path = folder + "/note-" + key + ".md";
        if (value === undefined) {
          await git(["update-index", "--index-info"], "0 " + "0".repeat(40) + "\t" + path + "\n");
          blobs.delete(key);
        } else {
          await stage(path, value);
          blobs.set(key, value);
        }
        records.push({ folder, key, digest: hash(value) });
      }
      if (updates.size) {
        dirty = true;
        const names = [...blobs.keys()].sort().map((k) => "note-" + k + ".md");
        await stage(
          folder + "/MEMORY.md",
          "# Memory\n\n<!-- Banneret index -->\n" + names.map((n) => `- [${n}](${n})`).join("\n"),
        );
      }
    }
    if (dirty) {
      await check();
      const tree = (await git(["write-tree"])).trim();
      const commit = (
        await git([
          "commit-tree",
          tree,
          ...(head ? ["-p", head] : []),
          "-m",
          "memory: update notes",
        ])
      ).trim();
      await git(["push", "origin", commit + ":" + ref]);
      open((s) => {
        for (const { folder, key, digest } of records)
          s.repo.remember(url, folder, key, digest, digest);
      });
    }
    return [...issues].join(" ") || "Memory synced.";
  } finally {
    await NodeFSP.rm(tmp, { recursive: true, force: true });
  }
}
