// Banneret Hub: a linked thread's `linkOrigin.label` is the link's session name, "<app> · <env>".
// Threads official T3 Code started say "T3 Code" there; show only the environment, store as is.
// `\x20` keeps brand.mjs from rewriting the official name in this pattern.
import type { OrchestrationV2LinkOrigin } from "@t3tools/contracts";

const APP_PREFIX = /^(?:T3\x20Code|Banneret Hub) · /;

export function linkOriginLabel(
  origin: Pick<OrchestrationV2LinkOrigin, "label"> | null | undefined,
): string | undefined {
  return origin?.label.replace(APP_PREFIX, "");
}
