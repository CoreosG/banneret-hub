import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const roots = ["apps/server/dist/client", "apps/server/dist", "apps/desktop/dist-electron"];
const upstream =
  /(?:https?:|wss?:)?\/\/(?:[\w-]+\.)*(?:t3\.codes|t3\.chat|ping\.gg|t3\.sh|t3code\.(?:dev|app|com)|posthog\.com)(?![\w.-])[^\s"'\x60<>)]*|(?:[\w-]+\.)+(?:t3\.codes|ping\.gg|posthog\.com)\b|pingdotgg\/t3code\b|registry\.npmjs\.org\/t3\b|pk_live_Y2xlcmsudDMuY29kZXMk/gi;
// Exact non-network text and one user-opened subscription link inside the signed-in Connect panel.
const allowed = new Set([
  "https://t3.codes/schema/t3.json",
  "https://t3.chat/settings/subscription",
]);
const copy = [
  "Remote: phones, other computers, app.t3.codes",
  "Outside MCP clients get app.t3.codes thread links",
  "(app.t3.codes)",
  "app.t3.codes serves stable.",
];

for (const root of roots) {
  let scripts = 0;
  for (const name of NodeFS.readdirSync(root, { recursive: true })) {
    if (root === "apps/server/dist" && name.startsWith("client/")) continue;
    if (!/\.(?:[cm]?js|css|html|json|webmanifest)$/i.test(name)) continue;
    const file = NodePath.join(root, name);
    const content = NodeFS.readFileSync(file, "utf8");
    if (/\.[cm]?js$/.test(name)) scripts++;
    const scan = copy.reduce((text, phrase) => text.replaceAll(phrase, ""), content);
    for (const [match] of scan.matchAll(upstream)) {
      NodeAssert.ok(allowed.has(match), file + " contains upstream destination " + match);
    }
  }
  NodeAssert.ok(scripts > 0, "Missing release scripts under " + root);
  console.log("Scanned " + scripts + " scripts and static assets in " + root);
}
