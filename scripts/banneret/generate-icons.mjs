#!/usr/bin/env node
// Banneret Hub: regenerates every tracked brand icon from assets/banneret/icon-template.svg.
// Writes over upstream's file names in assets/{prod,nightly,dev} and apps/web/public, so the
// build scripts pick our icons up with no code changes. Run: node scripts/banneret/generate-icons.mjs
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const require = NodeModule.createRequire(NodePath.join(repoRoot, "apps/desktop/package.json"));
let sharp;
try {
  sharp = require("sharp");
} catch {
  const pnpmDir = NodePath.join(repoRoot, "node_modules/.pnpm");
  const entry = NodeFS.readdirSync(pnpmDir).find((name) => name.startsWith("sharp@"));
  if (!entry) throw new Error("sharp is not installed; run `vp i` first.");
  sharp = NodeModule.createRequire(
    NodePath.join(pnpmDir, entry, "node_modules/sharp/package.json"),
  )("sharp");
}

const template = NodeFS.readFileSync(
  NodePath.join(repoRoot, "assets/banneret/icon-template.svg"),
  "utf8",
);
const mark = NodeFS.readFileSync(NodePath.join(repoRoot, "assets/banneret/mark.svg"), "utf8");

const variants = {
  prod: { dir: "prod", prefix: "black", webPrefix: "t3-black", bg: ["#26215c", "#0d0b24"] },
  nightly: { dir: "nightly", prefix: "nightly", webPrefix: "nightly", bg: ["#4c1d6e", "#1c0730"] },
  dev: { dir: "dev", prefix: "blueprint", webPrefix: "blueprint", bg: ["#0d5376", "#05202f"] },
};
const FG = "#f2c14e";

// Shapes: "bleed" is a full square (iOS crops it), "rounded" fills the canvas with rounded corners,
// "mac" follows the pre-Tahoe macOS grid (824px body inset 100px, ~185px radius).
const shapes = {
  bleed: { inset: 0, size: 1024, radius: 0, markScale: 0.78 },
  rounded: { inset: 0, size: 1024, radius: 224, markScale: 0.78 },
  mac: { inset: 100, size: 824, radius: 185, markScale: 0.64 },
};

function svgFor(variant, shapeName) {
  const shape = shapes[shapeName];
  return template
    .replaceAll("{{BG_TOP}}", variant.bg[0])
    .replaceAll("{{BG_BOTTOM}}", variant.bg[1])
    .replaceAll("{{FG}}", FG)
    .replaceAll("{{INSET}}", String(shape.inset))
    .replaceAll("{{SIZE}}", String(shape.size))
    .replaceAll("{{RADIUS}}", String(shape.radius))
    .replaceAll("{{MARK_SCALE}}", String(shape.markScale));
}

const png = (svg, size) =>
  sharp(Buffer.from(svg), { density: Math.max(72, Math.ceil((72 * size) / 1024) * 4) })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();

/** ICO with embedded PNG frames (supported since Windows Vista). */
function ico(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  const entries = [];
  let offset = 6 + 16 * frames.length;
  for (const { size, data } of frames) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...frames.map((frame) => frame.data)]);
}

const write = (relativePath, data) => {
  const target = NodePath.join(repoRoot, relativePath);
  NodeFS.writeFileSync(target, data);
  console.log(`wrote ${relativePath}`);
};

for (const variant of Object.values(variants)) {
  const base = `assets/${variant.dir}`;
  const rounded = svgFor(variant, "rounded");
  write(`${base}/${variant.prefix}-ios-1024.png`, await png(svgFor(variant, "bleed"), 1024));
  write(`${base}/${variant.prefix}-macos-1024.png`, await png(svgFor(variant, "mac"), 1024));
  write(`${base}/${variant.prefix}-universal-1024.png`, await png(rounded, 1024));
  const web = {
    "web-apple-touch-180.png": await png(svgFor(variant, "bleed"), 180),
    "web-favicon-16x16.png": await png(rounded, 16),
    "web-favicon-32x32.png": await png(rounded, 32),
    "web-icon-192x192.png": await png(rounded, 192),
    "web-icon-512x512.png": await png(rounded, 512),
  };
  for (const [suffix, data] of Object.entries(web)) {
    write(`${base}/${variant.webPrefix}-${suffix}`, data);
  }
  const frames = async (sizes) =>
    Promise.all(sizes.map(async (size) => ({ size, data: await png(rounded, size) })));
  write(`${base}/${variant.webPrefix}-web-favicon.ico`, ico(await frames([16, 32, 48])));
  write(
    `${base}/${variant.webPrefix}-windows.ico`,
    ico(await frames([16, 24, 32, 48, 64, 128, 256])),
  );
  // Icon Composer project: its foreground layer becomes our mark, in white like upstream's.
  write(
    `${base}/app-icon.icon/Assets/text.svg`,
    mark.replaceAll("currentColor", "#ffffff").replace(/<!--.*?-->\s*/s, ""),
  );
  if (variant.dir === "dev") {
    // The browser favicon, manifest icons and splash use the development exports.
    write("apps/web/public/apple-touch-icon.png", web["web-apple-touch-180.png"]);
    write("apps/web/public/favicon-16x16.png", web["web-favicon-16x16.png"]);
    write("apps/web/public/favicon-32x32.png", web["web-favicon-32x32.png"]);
    write("apps/web/public/icon-192x192.png", web["web-icon-192x192.png"]);
    write("apps/web/public/icon-512x512.png", web["web-icon-512x512.png"]);
    write("apps/web/public/favicon.ico", ico(await frames([16, 32, 48])));
  }
}
write("assets/prod/logo.svg", mark.replaceAll("currentColor", FG));
