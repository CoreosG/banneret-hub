// Loads profile data. Nothing here reads the disk or a provider's files.
import type { z } from "zod";
import claudeAgent from "./profiles/claudeAgent.json" with { type: "json" };
import codex from "./profiles/codex.json" with { type: "json" };
import unknown from "./profiles/unknown.json" with { type: "json" };
import { providerProfileSchema, type ProviderProfile } from "./schema.ts";

const invalid = (origin: string, problems: ReadonlyArray<string>) =>
  new Error(`${origin}: invalid provider profile\n${problems.map((p) => `  ${p}`).join("\n")}`);

// A fact is a union of "known" and "unknown". Report the branch the author was closest to.
function describeIssues(issues: ReadonlyArray<z.core.$ZodIssue>, at: PropertyKey[]): string[] {
  return issues.flatMap((issue) => {
    const path = [...at, ...issue.path];
    if (issue.code === "invalid_union" && issue.errors.length > 0) {
      const closest = issue.errors.reduce((best, next) =>
        next.length < best.length ? next : best,
      );
      return describeIssues(closest, path);
    }
    return [`${path.map(String).join(".") || "(profile)"}: ${issue.message}`];
  });
}

function citedSources(value: unknown, at: string, found: Array<{ path: string; id: string }>) {
  if (typeof value !== "object" || value === null) return found;
  if ("from" in value && ("value" in value || "unknown" in value) && Array.isArray(value.from)) {
    for (const id of value.from) found.push({ path: at, id: String(id) });
  }
  for (const [key, child] of Object.entries(value)) {
    citedSources(child, at ? `${at}.${key}` : key, found);
  }
  return found;
}

export function parseProviderProfile(data: unknown, origin = "profile"): ProviderProfile {
  const parsed = providerProfileSchema.safeParse(data);
  if (!parsed.success) throw invalid(origin, describeIssues(parsed.error.issues, []));
  const { sources, conformance: _conformance, ...parts } = parsed.data;
  const cited = citedSources(parts, "", []);
  const used = new Set(cited.map((c) => c.id));
  const problems = [
    ...cited
      .filter((c) => !Object.hasOwn(sources, c.id))
      .map((c) => `${c.path}: cites "${c.id}", which is not in sources`),
    ...Object.keys(sources)
      .filter((id) => !used.has(id))
      .map((id) => `sources.${id}: no fact cites it`),
  ];
  if (problems.length > 0) throw invalid(origin, problems);
  return parsed.data;
}

export function parseProviderProfileText(json: string, origin = "profile"): ProviderProfile {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw invalid(origin, [`not valid JSON: ${(error as Error).message}`]);
  }
  return parseProviderProfile(data, origin);
}

const builtIn = new Map(
  [claudeAgent, codex].map((data) => {
    const profile = parseProviderProfile(data, `built-in ${data.id}`);
    return [profile.id, profile] as const;
  }),
);

export const builtInProviderProfileIds: ReadonlyArray<string> = [...builtIn.keys()];

/** A provider with nothing known. Every part is unknown, so no feature has to guess. */
export function unknownProviderProfile(id: string, name = id): ProviderProfile {
  return parseProviderProfile({ ...unknown, id, name }, `unknown ${id}`);
}

/** The profile for a driver id. A driver without one gets the unknown profile, never another's. */
export function providerProfile(id: string): ProviderProfile {
  return builtIn.get(id) ?? unknownProviderProfile(id);
}
