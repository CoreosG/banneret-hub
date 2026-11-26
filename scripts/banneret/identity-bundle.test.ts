// @effect-diagnostics nodeBuiltinImport:off - builds the server with the brand plugin and runs it.
// Banneret Hub: the identity a built server ships. Source keeps upstream's names (t3, t3code://,
// T3CODE_HOME, T3_BOOT_SERVICE_UNIT); brand.mjs renames them at build time. This builds the real
// server entry and the shared app-link modules with that plugin, as the release does, then runs the
// result: the command, the home it picks, the service unit it writes and the app links it makes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { build } from "vite-plus";

import { banneretBrandPlugin } from "./brand.mjs";

const repoRoot = NodePath.resolve(import.meta.dirname, "../..");
const serverRoot = NodePath.join(repoRoot, "apps/server");
// Inside apps/server, so the server's own dependencies resolve from the output.
const outDir = NodePath.join(serverRoot, "node_modules/.cache", `banneret-identity-${process.pid}`);
const scratch = NodePath.join(outDir, "home");

const IDENTITY_ENTRY = "\0banneret-identity";
const identityEntry = `
export { buildPairingAppLink, readPairingAppLink } from "@t3tools/shared/remote";
export { promptLinkAppPath, promptLinkDeepLink } from "@t3tools/shared/promptLinks";
export { providerAuthReturnUrl } from "@t3tools/shared/providerAuthReturnUrl";
export { DESKTOP_RENDERER_ORIGINS } from "${serverRoot}/src/httpCors.ts";
export { renderBootServiceUnit, renderBootServicePlist, BOOT_SERVICE_UNIT_FILE } from "${serverRoot}/src/cloud/bootService.ts";
export { SERVICE_UNIT_ENV, SERVICE_LAUNCHER_CONTEXT_ENV } from "${serverRoot}/src/cloud/serviceProtocol.ts";
`;

interface Identity {
  buildPairingAppLink: (pairingUrl: string) => string;
  readPairingAppLink: (value: string) => string | null;
  promptLinkAppPath: (value: string) => string | null;
  promptLinkDeepLink: (appPath: string) => string;
  providerAuthReturnUrl: (value: string | undefined) => string | undefined;
  DESKTOP_RENDERER_ORIGINS: ReadonlyArray<string>;
  renderBootServiceUnit: (plan: unknown) => string;
  renderBootServicePlist: (plan: unknown, options: unknown) => string;
  BOOT_SERVICE_UNIT_FILE: string;
  SERVICE_UNIT_ENV: string;
  SERVICE_LAUNCHER_CONTEXT_ENV: string;
}

let identity: Identity;

beforeAll(async () => {
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(serverRoot, "package.json"), "utf8"),
  );
  const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter(
    (name) => !name.startsWith("@t3tools/"),
  );
  // Workspace packages are bundled, so the rewrite must reach them; the server's own deps stay out.
  const external = (id: string) =>
    id.startsWith("node:") ||
    NodeModule.builtinModules.includes(id) ||
    deps.some((name) => id === name || id.startsWith(`${name}/`));
  await build({
    root: serverRoot,
    configFile: false,
    logLevel: "warn",
    plugins: [
      banneretBrandPlugin({ cli: true }),
      {
        name: "banneret:identity-entry",
        resolveId: (id) => (id === IDENTITY_ENTRY ? id : null),
        load: (id) => (id === IDENTITY_ENTRY ? identityEntry : null),
      },
    ],
    ssr: { noExternal: true },
    build: {
      ssr: true,
      outDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      rollupOptions: {
        input: { bin: NodePath.join(serverRoot, "src/bin.ts"), identity: IDENTITY_ENTRY },
        external,
        output: { format: "esm", entryFileNames: "[name].mjs" },
      },
    },
  });
  NodeFS.mkdirSync(scratch, { recursive: true });
  identity = await import(NodeURL.pathToFileURL(NodePath.join(outDir, "identity.mjs")).href);
});

afterAll(() => NodeFS.rmSync(outDir, { recursive: true, force: true }));

/** Runs the built CLI in a scratch home with no inherited T3 or Banneret variables. */
const cli = (args: ReadonlyArray<string>, env: Record<string, string> = {}) => {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(T3CODE_|T3_|BANNERET_)/.test(name)),
  );
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(outDir, "bin.mjs"), ...args],
    {
      env: {
        ...clean,
        HOME: scratch,
        XDG_CONFIG_HOME: NodePath.join(scratch, ".config"),
        XDG_CACHE_HOME: NodePath.join(scratch, ".cache"),
        ...env,
      },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  return `${result.stdout}${result.stderr}`;
};

describe("the built command", () => {
  it("is banneret in help and the version banner", () => {
    const help = cli(["--help"]);
    expect(help).toMatch(/USAGE\n {2}banneret <subcommand>/);
    expect(help).toContain("run `banneret up`");
    expect(help).not.toMatch(/(?<![\w./@-])t3 [a-z<]/);
    expect(cli(["--version"])).toMatch(/^banneret v\d/m);
  });

  it("names its process banneret", () => {
    const bin = NodeFS.readFileSync(NodePath.join(outDir, "bin.mjs"), "utf8");
    expect(bin).toContain('process.title = "banneret";');
  });

  it("ignores T3CODE_HOME and honours BANNERET_HOME", () => {
    const official = NodePath.join(scratch, ".t3");
    const custom = NodePath.join(scratch, "custom");
    expect(cli(["trace", "summary"], { T3CODE_HOME: official })).toContain(
      `${NodePath.join(scratch, ".banneret")}/userdata/logs/server.trace.ndjson`,
    );
    expect(cli(["trace", "summary"], { T3CODE_HOME: official, BANNERET_HOME: custom })).toContain(
      `${custom}/userdata/logs/server.trace.ndjson`,
    );
    expect(cli(["__service-launcher"], { T3CODE_HOME: official })).toContain(
      "BANNERET_HOME is required",
    );
  });
});

describe("the built service", () => {
  const plan = {
    program: ["/home/me/.banneret/runtime/versions/0.1.1214/t3", "__service-launcher"],
    baseDir: "/home/me/.banneret",
    logPath: "/home/me/.banneret/userdata/logs/boot-service.log",
    unitPath: "/home/me/.config/systemd/user/banneret-hub.service",
  };

  it("is banneret-hub, with variables official T3 Code never sets", () => {
    expect(identity.BOOT_SERVICE_UNIT_FILE).toBe("banneret-hub.service");
    expect(identity.SERVICE_UNIT_ENV).toBe("BANNERET_BOOT_SERVICE_UNIT");
    expect(identity.SERVICE_LAUNCHER_CONTEXT_ENV).toBe("BANNERET_SERVICE_LAUNCHER_CONTEXT");
    const unit = identity.renderBootServiceUnit(plan);
    expect(unit).toContain("Environment=BANNERET_BOOT_SERVICE_UNIT=banneret-hub.service");
    expect(unit).toContain("Environment=BANNERET_HOME=/home/me/.banneret");
    const plist = identity.renderBootServicePlist(plan, {
      homeDir: "/Users/me",
      environmentPath: "/bin",
    });
    expect(plist).toContain("<string>com.coreosg.banneret-hub.service</string>");
    expect(plist).toContain("<key>BANNERET_BOOT_SERVICE_UNIT</key>");
    for (const text of [unit, plist]) expect(text).not.toMatch(/t3code|T3_BOOT|T3CODE_/);
  });
});

describe("the built app links", () => {
  const pairingUrl = "https://vps.example.com/#token=abc";

  it("pair through banneret://", () => {
    const link = identity.buildPairingAppLink(pairingUrl);
    expect(link.startsWith("banneret://pair?")).toBe(true);
    expect(identity.readPairingAppLink(link)).toBe(pairingUrl);
    expect(identity.readPairingAppLink(link.replace("banneret:", "banneret-dev:"))).toBe(
      pairingUrl,
    );
    expect(identity.promptLinkDeepLink("/new?prompt=hi")).toBe("banneret://new?prompt=hi");
    expect(identity.providerAuthReturnUrl("banneret://app/settings")).toBe(
      "banneret://app/settings",
    );
    expect(identity.DESKTOP_RENDERER_ORIGINS).toEqual(["banneret://app", "banneret-dev://app"]);
  });

  it("ignore official T3 Code's t3code:// links", () => {
    const official = `t3code://pair?pairingUrl=${encodeURIComponent(pairingUrl)}`;
    expect(identity.readPairingAppLink(official)).toBeNull();
    expect(identity.promptLinkAppPath("t3code://new?prompt=hi")).toBeNull();
    expect(identity.providerAuthReturnUrl("t3code://app/settings")).toBeUndefined();
  });
});
