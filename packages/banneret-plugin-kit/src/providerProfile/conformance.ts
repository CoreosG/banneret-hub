// The checks every profile must pass, built in or drafted by someone else.
import * as NodeUtil from "node:util";
import { resolveInstructions } from "./resolve.ts";
import { commonEvents, type ProviderProfile } from "./schema.ts";
import { instructionTrees } from "./trees.ts";
import { parseProviderProfile } from "./load.ts";

export interface ConformanceCheck {
  readonly name: string;
  readonly status: "pass" | "fail" | "skip";
  readonly hint?: string;
}

function duplicates(values: ReadonlyArray<string>) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

function hookProblems({ hooks }: ProviderProfile): string[] {
  const problems: string[] = [];
  const events = "value" in hooks.events ? hooks.events.value : undefined;
  const tools = "value" in hooks.tools ? hooks.tools.value : undefined;
  const lost = "value" in hooks.cannotCarry ? hooks.cannotCarry.value : undefined;

  if ("value" in hooks.model && hooks.model.value === "none" && (events || tools)) {
    problems.push("A provider without hooks cannot map events or tools.");
  }
  for (const name of duplicates(events?.map((e) => e.native) ?? [])) {
    problems.push(`Event "${name}" is mapped twice.`);
  }
  for (const name of duplicates(tools?.flatMap((t) => [...t.names, ...t.aliases]) ?? [])) {
    problems.push(`Tool name "${name}" belongs to two rows.`);
  }
  if (events && lost) {
    const mapped = new Set(events.map((e) => e.common));
    const listed = new Set(lost.flatMap((l) => (l.kind === "event" ? [l.name] : [])));
    for (const event of commonEvents) {
      if (!mapped.has(event) && !listed.has(event)) {
        problems.push(`Shared event "${event}" is neither mapped nor listed in cannotCarry.`);
      }
      if (mapped.has(event) && listed.has(event)) {
        problems.push(`Shared event "${event}" is both mapped and listed in cannotCarry.`);
      }
    }
  }
  for (const entry of lost ?? []) {
    if (entry.kind === "tool" && tools?.some((t) => t.kind === entry.name)) {
      problems.push(`Tool kind "${entry.name}" is both mapped and listed in cannotCarry.`);
    }
  }
  // A guard that answers "ask" must never be carried to a provider that would then run the tool.
  if (
    "value" in hooks.ask &&
    hooks.ask.value !== "supported" &&
    !lost?.some((l) => l.kind === "decision" && l.name === "ask")
  ) {
    problems.push('A provider that cannot ask must list the "ask" decision in cannotCarry.');
  }
  return problems;
}

export function checkProviderProfile(data: unknown): {
  passed: boolean;
  checks: ConformanceCheck[];
} {
  let profile: ProviderProfile;
  try {
    profile = parseProviderProfile(data);
  } catch (error) {
    return {
      passed: false,
      checks: [{ name: "shape", status: "fail", hint: (error as Error).message }],
    };
  }
  const checks: ConformanceCheck[] = [{ name: "shape", status: "pass" }];

  for (const [name, tree] of Object.entries(instructionTrees)) {
    const promised = profile.conformance.instructionLoads[name as keyof typeof instructionTrees];
    const resolved = resolveInstructions(profile, tree);
    checks.push(
      NodeUtil.isDeepStrictEqual(resolved, promised)
        ? { name: `instructions: ${name} tree`, status: "pass" }
        : {
            name: `instructions: ${name} tree`,
            status: "fail",
            hint: `The facts give ${JSON.stringify(resolved)}, but conformance.instructionLoads.${name} promises ${JSON.stringify(promised)}. Check both against the provider's docs.`,
          },
    );
  }

  const problems = hookProblems(profile);
  checks.push(
    problems.length === 0
      ? { name: "hooks: maps", status: "pass" }
      : { name: "hooks: maps", status: "fail", hint: problems.join(" ") },
    {
      name: "hooks: same verdict through the adapter",
      status: "skip",
      hint:
        "unknown" in profile.hooks.recordedInputs
          ? "No recorded hook inputs, and the Hub has no hook adapter yet."
          : "The Hub has no hook adapter yet.",
    },
    {
      name: "memory: the Hub applies the off switch",
      status: "skip",
      hint:
        "unknown" in profile.memory.offAtLaunch
          ? "The switch is unknown, so Banneret-only mode cannot be offered."
          : "The Hub does not start sessions with it yet. Only its shape is checked.",
    },
  );
  return { passed: checks.every((check) => check.status !== "fail"), checks };
}
