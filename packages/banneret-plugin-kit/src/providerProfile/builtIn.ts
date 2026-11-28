// The built-in profile data, with no validator: the Hub server bundles this file, and its
// single executable cannot load zod. The conformance tests check this data against the schema.
import claudeAgent from "./profiles/claudeAgent.json" with { type: "json" };
import codex from "./profiles/codex.json" with { type: "json" };
import type { ProviderProfile } from "./schema.ts";

// A JSON import widens literals such as "firstNonEmpty" to string, hence the cast.
export const builtInProfileData = [claudeAgent, codex] as unknown as ReadonlyArray<ProviderProfile>;
