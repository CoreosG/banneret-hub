// Build-time identity rewrite, so upstream files stay unedited: "T3 Code" becomes "Banneret Hub",
// official T3CODE_* / T3_* variables become BANNERET_* ones, the t3code:// app-link scheme becomes
// banneret://, and (`cli: true`) the `t3` command `banneret`. Source and tests keep upstream's values.
// Catalogs are keyed by a hash of the English source, so changed entries are re-keyed too.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const OFFICIAL_NAME = "T3 Code";
export const BRAND_NAME = "Banneret Hub";
// Also Swedish genitive: "T3 Codes" becomes "Banneret Hubs".
const NAME_PATTERN = /\bT3 Code(?=s?\b)/g;
const CATALOG_PATTERN = /[\\/]i18n[\\/]translations[\\/]([A-Za-z-]+)\.json$/;
const SOURCE_PATTERN = /\.(?:[cm]?[jt]sx?)$/;

/**
 * Official T3 Code variables that would point Banneret Hub at official state, and the names shipped
 * bundles use instead. Renamed on both sides of every handoff (service units, desktop shims, agent
 * shells, the WSL probe), since every producer and reader is in a rewritten bundle or installer.
 */
export const ENV_RENAMES = Object.freeze({
  T3CODE_HOME: "BANNERET_HOME",
  T3CODE_INSTALL_BIN_DIR: "BANNERET_INSTALL_BIN_DIR",
  T3CODE_CLI_PATH: "BANNERET_CLI_PATH",
  T3CODE_THREAD_ID: "BANNERET_THREAD_ID",
  T3CODE_LAN: "BANNERET_LAN",
  // The installer's knobs, which the server's hints and update path also name.
  T3CODE_RELEASE_BASE_URL: "BANNERET_RELEASE_BASE_URL",
  T3CODE_VERSION: "BANNERET_VERSION",
  T3CODE_CHANNEL: "BANNERET_CHANNEL",
  // The background service's own variables. Official T3's service sets them in its agent shells, so
  // a Banneret command run there would take T3's unit and launcher for its own.
  T3_BOOT_SERVICE_UNIT: "BANNERET_BOOT_SERVICE_UNIT",
  T3_SERVICE_LAUNCHER_CONTEXT: "BANNERET_SERVICE_LAUNCHER_CONTEXT",
});
const ENV_PATTERN = new RegExp(`\\b(?:${Object.keys(ENV_RENAMES).join("|")})\\b`, "g");

export const SCHEME = "banneret";
/**
 * The app-link scheme, so official T3 Code never opens our links, nor we its. Rules are anchored on
 * upstream's exact text, never a bare "t3code" (it also names attribution and user agents).
 * `[pattern, replacement, files]`: brand.test.ts fails when a rule stops matching one of `files`.
 */
export const SCHEME_RULES = [
  // Pair links, CORS origins: `t3code://pair`, "t3code-dev://app".
  [
    /\bt3code(-dev)?:\/\//g,
    `${SCHEME}$1://`,
    ["apps/server/src/httpCors.ts", "packages/shared/src/remote.ts"],
  ],
  // The desktop's registered scheme, and the prompt-link default.
  [
    /(_SCHEME = |scheme = )"t3code(-dev)?"/g,
    `$1"${SCHEME}$2"`,
    ["apps/desktop/src/electron/ElectronProtocol.ts", "packages/shared/src/promptLinks.ts"],
  ],
  // URL.protocol comparisons: "t3code:", "t3code-dev:".
  [
    /"t3code(-dev)?:"/g,
    `"${SCHEME}$1:"`,
    ["packages/shared/src/providerAuthReturnUrl.ts", "packages/shared/src/codexAuthHandoff.ts"],
  ],
  // Any-channel matchers: /^t3code(?:-[a-z]+)?:$/.
  [
    /\^t3code(?=\(\?:-\[a-z\]\+\)\?:\$)/g,
    `^${SCHEME}`,
    ["packages/shared/src/remote.ts", "packages/shared/src/promptLinks.ts"],
  ],
  // `${development ? "t3code-dev" : "t3code"}://auth/codex`.
  [
    /\? "t3code-dev" : "t3code"\}:\/\//g,
    `? "${SCHEME}-dev" : "${SCHEME}"}://`,
    ["packages/shared/src/codexAuthHandoff.ts"],
  ],
];

export const CLI_NAME = "banneret";
/**
 * Where upstream's server names its command `t3` to the user: the CLI definition (help, usage and
 * the `--version` banner), quoted commands in messages, the `t3@<version>` status line, and prose.
 * The runtime executable (`runtime/versions/<v>/t3`), the npm package `t3` (`npx t3@...`) and the
 * hidden `t3 checkpoint` commit messages keep upstream's name.
 */
const CLI_RULES = [
  [/\b(Command\.make\(|commandPath: \[)"t3"/g, `$1"${CLI_NAME}"`],
  // The installed launcher, looked up on PATH and in the install bin dir.
  [/\bresolveCommandPath\("t3"\)/g, `resolveCommandPath("${CLI_NAME}")`],
  [/(path\.join\((?:installBinDir|directory \|\| cwd), )"t3"\)/g, `$1"${CLI_NAME}")`],
  // `t3 ...` and `t3` in messages, also as \`t3 ...\` inside template literals.
  [/(\\?`)t3(?= |\\?`)(?! checkpoint|\\?` npm)/g, `$1${CLI_NAME}`],
  [/(["'])t3(?= [a-z./-])/g, `$1${CLI_NAME}`],
  // `t3@${version}` in messages; `t3@${spec}` alone is an npm package spec.
  [/(?<=[ (])(?<!npx )t3@(?=\$\{)|(?<=`)t3@(?=\$\{[^}]*\} )/g, `${CLI_NAME}@`],
  [/(?<=\.local[\\/]bin[\\/])t3(?=[\s`"'])/g, CLI_NAME],
  // Prose: "Another t3 at", "so t3 did not", "(t3 service protect)", "Installed t3 ${version}".
  [/(?<=[A-Za-z0-9:,] |\()(?<!npx |-g )t3(?= [a-zA-Z(]| \$\{|\\?`)(?! checkpoint)/g, CLI_NAME],
];

export function rebrandText(text, { cli = false } = {}) {
  let result = text.replace(NAME_PATTERN, BRAND_NAME).replace(ENV_PATTERN, (n) => ENV_RENAMES[n]);
  for (const [pattern, replacement] of SCHEME_RULES) result = result.replace(pattern, replacement);
  if (cli)
    for (const [pattern, replacement] of CLI_RULES) result = result.replace(pattern, replacement);
  return result;
}

function rebrandValue(value) {
  if (typeof value === "string") return rebrandText(value);
  if (Array.isArray(value)) return value.map(rebrandValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rebrandValue(v)]));
  }
  return value;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .toSorted()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function isVariable(child) {
  if (typeof child.k !== "string") return false;
  const keys = Object.keys(child).length;
  const hasIndex = typeof child.i === "number";
  const hasValue = typeof child.v === "string";
  return (
    keys === 1 || (keys === 2 && (hasIndex || hasValue)) || (keys === 3 && hasIndex && hasValue)
  );
}

// Mirrors generaltranslation's sanitizeJsxChildren: elements hash by content and branches only.
function sanitizeJsx(children) {
  if (Array.isArray(children)) return children.map(sanitizeJsx);
  if (!children || typeof children !== "object") return children;
  if (isVariable(children)) return { k: children.k, ...(children.v && { v: children.v }) };
  const sanitized = {};
  if (children.c) sanitized.c = sanitizeJsx(children.c);
  if (children.d?.b) {
    sanitized.b = Object.fromEntries(
      Object.entries(children.d.b).map(([key, value]) => [key, sanitizeJsx(value)]),
    );
  }
  if (children.d?.t) sanitized.t = children.d.t;
  return sanitized;
}

/** General Translation's source hash (generaltranslation `hashSource`, no context or id). */
export function hashCatalogSource(source, dataFormat) {
  const hashed = dataFormat === "JSX" ? sanitizeJsx(source) : source;
  return NodeCrypto.createHash("sha256")
    .update(stableStringify({ source: hashed, dataFormat }))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Maps each English catalog key whose source names the product to the key the rewritten source
 * hashes to. Throws when an affected key cannot be reproduced, so a change to GT's hashing fails
 * the build instead of silently dropping translations.
 */
export function catalogKeyRenames(englishCatalog) {
  const renames = new Map();
  for (const [key, source] of Object.entries(englishCatalog)) {
    if (JSON.stringify(rebrandValue(source)) === JSON.stringify(source)) continue;
    const format = ["ICU", "JSX"].find((f) => hashCatalogSource(source, f) === key);
    if (format === undefined) {
      throw new Error(
        `Banneret brand: cannot reproduce translation key ${key} for ${JSON.stringify(source)}; ` +
          "General Translation hashing changed, update scripts/banneret/brand.mjs.",
      );
    }
    renames.set(key, hashCatalogSource(rebrandValue(source), format));
  }
  return renames;
}

export function rebrandCatalog(catalog, renames) {
  return Object.fromEntries(
    Object.entries(catalog).map(([key, value]) => [renames.get(key) ?? key, rebrandValue(value)]),
  );
}

/**
 * Vite / Rolldown plugin. Rewrites the product name, environment variables and scheme in first-party
 * sources and re-keys the translation catalogs next to them. Pass `vite: true` from Vite configs so
 * it only runs in builds (tests keep asserting upstream's copy), and `cli: true` from the server
 * build to also rename the command.
 */
export function banneretBrandPlugin({ vite = false, cli = false } = {}) {
  const renamesByDir = new Map();
  const renamesFor = (dir) => {
    let renames = renamesByDir.get(dir);
    if (!renames) {
      const english = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "en.json"), "utf8"));
      renames = catalogKeyRenames(english);
      renamesByDir.set(dir, renames);
    }
    return renames;
  };
  return {
    name: "banneret:brand",
    ...(vite
      ? {
          apply: "build",
          enforce: "pre",
          transformIndexHtml: { order: "post", handler: rebrandText },
        }
      : {}),
    load(id) {
      const file = id.split("?")[0];
      if (!CATALOG_PATTERN.test(file) || file.includes("node_modules")) return null;
      const catalog = JSON.parse(NodeFS.readFileSync(file, "utf8"));
      const code = JSON.stringify(rebrandCatalog(catalog, renamesFor(NodePath.dirname(file))));
      return vite ? code : { code, moduleType: "json" };
    },
    transform(code, id) {
      const file = id.split("?")[0];
      if (!SOURCE_PATTERN.test(file) || file.includes("node_modules")) return null;
      const rebranded = rebrandText(code, { cli });
      return rebranded === code ? null : { code: rebranded, map: null };
    },
  };
}
