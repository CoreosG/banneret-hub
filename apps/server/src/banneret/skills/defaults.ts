// @effect-diagnostics nodeBuiltinImport:off - the CLI build embeds these same bundled documents.
import * as NodeFS from "node:fs";
const directory = new URL("./defaults/", import.meta.url);
export const defaultText = NodeFS.readdirSync(directory)
  .sort()
  .map((name) => NodeFS.readFileSync(new URL(name + "/SKILL.md", directory), "utf8"));
