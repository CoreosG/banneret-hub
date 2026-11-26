// @effect-diagnostics nodeBuiltinImport:off - reads the shipped sources and runs the installer generator.
// Banneret Hub: the build-time identity rewrite in brand.mjs, checked on the real sources the server,
// desktop and installer builds ship.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { ENV_RENAMES, SCHEME_RULES, rebrandText, titleServerEntry } from "./brand.mjs";

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

describe("copy the 0.1.1217 check found", () => {
  it("names the banneret command on the About screen, keeping translation contexts", () => {
    expect(rebrandText(read("apps/web/src/components/settings/settingsSearch.ts"))).toContain(
      'title: msg("banneret command")',
    );
    const row = rebrandText(read("apps/web/src/components/settings/CliCommandSettingsRow.tsx"));
    expect(row).toContain("Run Banneret Hub's CLI as `banneret` from any terminal.");
    expect(row).toContain('$context: "verb, installs the t3 command"');
    expect(row).toContain('$context: "verb, uninstalls the t3 command"');
    expect(rebrandText(read("apps/web/src/state/desktopCliCommand.ts"))).not.toContain(
      "t3 command",
    );
  });

  it("names new links' sessions Banneret Hub, and still shows only the environment of old ones", () => {
    expect(rebrandText(read("apps/server/src/peer/PeerLinks.ts"))).toContain(
      'LINK_CLIENT_NAME_PREFIX = "Banneret Hub · "',
    );
    // Threads copied from official T3 Code keep "T3 Code · <environment>"; the shipped helper must
    // still strip it after the rewrite.
    expect(rebrandText(read("apps/web/src/banneret/linkOriginLabel.ts"))).toContain(
      "/^(?:T3\\x20Code|Banneret Hub) · /",
    );
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

describe("server process title", () => {
  it("is set to banneret first thing in the real server entry, and nowhere else", () => {
    const entry = read("apps/server/src/bin.ts");
    const titled = titleServerEntry(entry, NodePath.join(repoRoot, "apps/server/src/bin.ts"));
    expect(titled.match(/process\.title = "banneret";/g)).toHaveLength(1);
    expect(titled).toContain(
      '  process.title = "banneret";\n  process.stdout.on("error", ignoreOutputError);',
    );
    const other = read("apps/server/src/binMain.ts");
    expect(titleServerEntry(other, "apps/server/src/binMain.ts")).toBe(other);
  });

  it("fails the build when upstream moves the anchor line", () => {
    expect(() => titleServerEntry("export {};", "apps/server/src/bin.ts")).toThrow(
      /SERVER_ENTRY_ANCHOR/,
    );
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

  it("print Banneret Hub and the banneret command", () => {
    expect(sh).toContain("printf '  %sInstalled Banneret Hub %s%s\\n\\n'");
    expect(sh).toContain("printf '  Run %sbanneret%s to use Banneret Hub here, or %sbanneret up%s");
    expect(ps1).toContain('WriteLine("  ${green}Installed Banneret Hub $version$reset`n")');
    expect(ps1).toContain(
      'Write-Host "  Run ${bold}banneret$reset to use Banneret Hub here, or ${bold}banneret up$reset',
    );
    // Messages name the banneret command; a path ending in /t3 is the runtime, which keeps it.
    const message =
      /\b(printf|fail|step|Fail|Step|Write-Host|WriteLine|Write-Warning|Write-Error)\b/;
    for (const script of [sh, ps1]) {
      const lines = script.split("\n").filter((line) => !/^\s*#/.test(line));
      expect(lines.filter((line) => line.includes("T3 Code"))).toEqual([]);
      expect(
        lines.filter((line) => message.test(line) && /(?<![\w./\\'-])t3(?=[ %'$`])/.test(line)),
      ).toEqual([]);
    }
  });
});
