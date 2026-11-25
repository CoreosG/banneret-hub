// Build-time product-name rewrite: shipped bundles say "Banneret Hub" where upstream source says
// "T3 Code", without editing upstream files (which would conflict on every sync).
//
// UI text is translated through General Translation catalogs keyed by a hash of the English
// source, so renaming source text also re-keys every catalog entry that mentions the name.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const OFFICIAL_NAME = "T3 Code";
export const BRAND_NAME = "Banneret Hub";
// Also Swedish genitive: "T3 Codes" becomes "Banneret Hubs".
const NAME_PATTERN = /\bT3 Code(?=s?\b)/g;
const CATALOG_PATTERN = /[\\/]i18n[\\/]translations[\\/]([A-Za-z-]+)\.json$/;
const SOURCE_PATTERN = /\.(?:[cm]?[jt]sx?)$/;

export function rebrandText(text) {
  return text.replace(NAME_PATTERN, BRAND_NAME);
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
    if (!JSON.stringify(source).includes(OFFICIAL_NAME)) continue;
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
 * Vite / Rolldown plugin. Rewrites the product name in first-party sources and re-keys the
 * translation catalogs next to them. Pass `vite: true` from Vite configs so it only runs in builds
 * (tests keep asserting upstream's copy).
 */
export function banneretBrandPlugin({ vite = false } = {}) {
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
      if (!code.includes(OFFICIAL_NAME)) return null;
      return { code: rebrandText(code), map: null };
    },
  };
}
