// @effect-diagnostics nodeBuiltinImport:off - reads the shipped sources and runs the installer generator.
// Banneret Hub: the build-time identity rewrite in brand.mjs, checked on the real sources the server,
// desktop and installer builds ship.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { ENV_RENAMES, SCHEME_RULES, rebrandText } from "./brand.mjs";

const repoRoot = NodePath.resolve(import.meta.dirname, "../..");
const read = (file: string) => NodeFS.readFileSync(NodePath.join(repoRoot, file), "utf8");
const trackedSources = (...paths: string[]) =>
  NodeChildProcess.execFileSync("git", ["ls-files", "--", ...paths], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
    .filter((file) => !/\.test\.|\/test\/|testUtils|testkit|__tests__/.test(file));

describe("command name", () => {
  const cli = (text: string) => rebrandText(text, { cli: true });

  it("is banneret in help, the version banner, messages and the status line", () => {
    expect(cli('Command.make("t3", { ...flags })')).toBe('Command.make("banneret", { ...flags })');
    expect(cli('new CliError.ShowHelp({ commandPath: ["t3"], errors: [] })')).toContain(
      'commandPath: ["banneret"]',
    );
    expect(cli('"Run it from your other devices: run `t3 up`."')).toContain("`banneret up`");
    expect(cli("`Then open a new terminal and run \\`t3\\`.`")).toContain("\\`banneret\\`");
    expect(cli("`Another t3 at ${path} runs first.`")).toBe(
      "`Another banneret at ${path} runs first.`",
    );
    expect(cli("`Service installed · t3@${version}`")).toBe(
      "`Service installed · banneret@${version}`",
    );
    expect(cli('label: "t3 pair"')).toBe('label: "banneret pair"');
  });

  it("finds the installed banneret launcher, on PATH and in the install bin dir", () => {
    const invocation = cli(read("apps/server/src/cli/invocation.ts"));
    expect(invocation).toContain('resolveCommandPath("banneret")');
    expect(invocation).toContain("if (command !== `banneret ${subcommand}`)");
    expect(invocation).toContain("return `banneret ${input.subcommand}`;");
    const client = cli(read("apps/server/src/cloud/serviceLauncherClient.ts"));
    expect(client).toContain('path.join(installBinDir, "banneret")');
    expect(client).toContain('path.join(directory || cwd, "banneret")');
    expect(client).not.toMatch(/path\.join\([^)]*, "t3"\)/);
  });

  it("keeps the runtime executable, the npm package and code", () => {
    for (const kept of [
      'path.join(versionDir, platform === "win32" ? "t3.exe" : "t3")',
      "`npx t3@${version} pair`",
      '["view", "--json", `t3@${spec}`, "version"]',
      "`t3 checkpoint ref=${ref}`",
      "if (t3 !== undefined) return t3;",
      'manifest.name === "t3"',
    ]) {
      expect(cli(kept)).toBe(kept);
    }
  });

  it("is not t3 anywhere in the server's CLI copy once rewritten", () => {
    const files = trackedSources("apps/server/src/cli", "apps/server/src/binCli.ts");
    expect(files.length).toBeGreaterThan(20);
    const leftovers = files.flatMap((file) =>
      cli(read(file))
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        // npm's package stays `t3` (`npx t3@...`, `npm uninstall -g t3`).
        .filter((line) => /(?<![\w./@$-])(?<!npx |-g )t3(?= [a-z<.-]|\\?`)/.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(leftovers).toEqual([]);
  });
});

describe("environment", () => {
  it("renames the variables that would point at official T3 state", () => {
    expect(rebrandText('Config.String("T3CODE_HOME")')).toBe('Config.String("BANNERET_HOME")');
    expect(rebrandText("Environment=T3CODE_HOME=/x")).toBe("Environment=BANNERET_HOME=/x");
    expect(rebrandText("T3CODE_THREAD_ID T3CODE_LAN T3CODE_CLI_PATH")).toBe(
      "BANNERET_THREAD_ID BANNERET_LAN BANNERET_CLI_PATH",
    );
    // Whole names only.
    expect(rebrandText("delete env.T3_BOOT_SERVICE_UNIT, env.T3_SERVICE_LAUNCHER_CONTEXT")).toBe(
      "delete env.BANNERET_BOOT_SERVICE_UNIT, env.BANNERET_SERVICE_LAUNCHER_CONTEXT",
    );
    expect(rebrandText("T3CODE_HOMEDIR MY_T3CODE_HOME T3CODE_PORT")).toBe(
      "T3CODE_HOMEDIR MY_T3CODE_HOME T3CODE_PORT",
    );
  });

  it("leaves no reader or writer of an official variable in the server or desktop bundles", () => {
    const names = Object.keys(ENV_RENAMES);
    const files = trackedSources("apps/server/src", "apps/desktop/src", "packages");
    const reads = files.filter((file) => {
      const text = read(file);
      return names.some((name) => text.includes(name)) && !/\/i18n\//.test(file);
    });
    // The home is read in many places; each must come out renamed.
    expect(reads).toContain("apps/server/src/cli/config.ts");
    expect(reads).toContain("apps/desktop/src/app/DesktopConfig.ts");
    for (const file of reads) {
      const rewritten = rebrandText(read(file));
      for (const name of names) expect(rewritten, file).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
    expect(rebrandText(read("apps/server/src/cli/config.ts"))).toContain(
      'Config.String("BANNERET_HOME")',
    );
  });
});

describe("app-link scheme", () => {
  const bundledSources = () =>
    trackedSources("apps/server/src", "apps/desktop/src", "apps/web/src", "packages").filter(
      (file) => /^(apps\/[^/]+|packages\/[^/]+)\/src\//.test(file),
    );
  const officialScheme = /\bt3code(-dev)?:(\/\/|["'$])|\^t3code\(|(_SCHEME = |scheme = )"t3code/;

  it("has every rule still matching upstream's text", () => {
    for (const [pattern, replacement, files] of SCHEME_RULES) {
      for (const file of files) {
        const text = read(file);
        expect(text.replace(pattern, replacement), `${pattern} in ${file}`).not.toBe(text);
      }
    }
  });

  it("is banneret:// everywhere the bundles handle app links", () => {
    expect(rebrandText(read("apps/desktop/src/electron/ElectronProtocol.ts"))).toContain(
      'const DESKTOP_PRODUCTION_SCHEME = "banneret";',
    );
    expect(rebrandText(read("packages/shared/src/codexAuthHandoff.ts"))).toContain(
      '`${development ? "banneret-dev" : "banneret"}://auth/codex`',
    );
    const leftovers = bundledSources().flatMap((file) =>
      rebrandText(read(file))
        .split("\n")
        .filter((line) => officialScheme.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(leftovers).toEqual([]);
  });

  it("leaves other t3code strings alone", () => {
    for (const kept of [
      '"service.namespace": "t3code"',
      'spawnEnv.TERM_PROGRAM = "t3code";',
      '"user-agent": "t3code"',
      'attribution === "t3code"',
      'name: "t3code:build-version"',
    ]) {
      expect(rebrandText(kept)).toBe(kept);
    }
  });
});

describe("installers", () => {
  const outputDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "banneret-install-"));
  NodeChildProcess.execFileSync(
    process.execPath,
    [NodePath.join(repoRoot, "scripts/banneret/make-install-scripts.mjs"), outputDir],
    { encoding: "utf8" },
  );
  const sh = NodeFS.readFileSync(NodePath.join(outputDir, "install.sh"), "utf8");
  const ps1 = NodeFS.readFileSync(NodePath.join(outputDir, "install.ps1"), "utf8");

  it("read only BANNERET_* variables", () => {
    for (const script of [sh, ps1]) {
      expect(script).not.toContain("T3CODE_");
      expect(script).toContain("BANNERET_HOME");
      expect(script).toContain("BANNERET_INSTALL_BIN_DIR");
    }
    expect(ps1).toContain(
      '$t3Home = if ($env:BANNERET_HOME) { $env:BANNERET_HOME } else { Join-Path $HOME ".banneret" }',
    );
  });

  it("install.sh ignores an inherited T3CODE_HOME and honours BANNERET_HOME", () => {
    const homeLine = sh.split("\n").find((line) => line.startsWith("t3_home="));
    expect(homeLine).toBe('t3_home="${BANNERET_HOME:-$HOME/.banneret}"');
    const resolve = (env: Record<string, string>) =>
      NodeChildProcess.execFileSync("sh", ["-c", `${homeLine}; printf %s "$t3_home"`], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/home/me", ...env },
        encoding: "utf8",
      });
    expect(resolve({ T3CODE_HOME: "/home/me/.t3" })).toBe("/home/me/.banneret");
    expect(resolve({ T3CODE_HOME: "/home/me/.t3", BANNERET_HOME: "/srv/hub" })).toBe("/srv/hub");
  });
});
