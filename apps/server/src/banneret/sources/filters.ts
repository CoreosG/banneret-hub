// Banneret Hub: which of a company source's tools a thread's agent gets, read from the naming convention
// `<prefix><capability>_<verb>` (docs/banneret/agents.md). No per-source tool list.
import type { RelayCapability } from "@t3tools/contracts";

import type { CompanySource } from "./ownership.ts";

const CAPABILITIES: ReadonlyArray<RelayCapability> = [
  "tasks",
  "skills",
  "memory",
  "chat",
  "search",
  "health",
];

/** `memory_person_*` is the person's own button press. No agent gets it, whatever the prefix or owner. */
export const isPersonTool = (name: string) => name.toLowerCase().includes("memory_person_");

/** The capability a tool name belongs to; Banneret's own spelling `banneret_<capability>_` counts too. */
const capabilityOfTool = (name: string, prefix: string) => {
  const bare = (prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name)
    .toLowerCase()
    .replace(/^banneret_/, "");
  return CAPABILITIES.find((capability) => bare.startsWith(`${capability}_`));
};

/**
 * Whether a thread may see a source's tool. A tool of a capability the source provides but does not
 * own here is hidden. A tool of no capability passes through.
 */
export const offeredToThread = (
  name: string,
  source: Pick<CompanySource, "prefix" | "provides" | "owns">,
) => {
  if (isPersonTool(name)) return false;
  const capability = capabilityOfTool(name, source.prefix);
  return !capability || !source.provides.includes(capability) || source.owns.includes(capability);
};

// The names the plugin kit (docs/banneret/plugins.md) and the join file agree on. The relay's own source
// check is the full one. Chat has no tool contract, and agents never call health.
const REQUIRED: Record<RelayCapability, ReadonlyArray<string>> = {
  tasks: ["tasks_read", "tasks_claim", "tasks_release"],
  skills: ["skills_list", "skills_get"],
  memory: ["memory_search", "memory_read", "memory_use", "memory_propose", "memory_flag"],
  chat: [],
  search: ["search_query"],
  health: [],
};

/** The required tools missing from a source's list, for the capabilities it owns here. */
export const missingTools = (
  source: Pick<CompanySource, "prefix" | "owns">,
  listed: ReadonlySet<string>,
) =>
  source.owns.flatMap((capability) =>
    REQUIRED[capability]
      .filter(
        (tool) =>
          !listed.has(source.prefix + tool) &&
          !(capability === "memory" && listed.has(`${source.prefix}banneret_${tool}`)),
      )
      .map((tool) => source.prefix + tool),
  );
