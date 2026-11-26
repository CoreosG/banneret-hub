// @effect-diagnostics nodeBuiltinImport:off - reads the canonical schema from disk, like spec.ts.
import * as NodeFS from "node:fs";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { specDirectory } from "./spec.ts";

/** A stage plan (README, "Stage plan file"). */
export interface StagePlan {
  readonly version: 1;
  readonly generatedAt: string;
  readonly source?: string;
  readonly stages: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly order: number;
  }>;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly stageId: string;
    readonly title: string;
    readonly restsOn?: ReadonlyArray<string>;
    readonly task?: {
      readonly tracker: string;
      readonly host?: string;
      readonly scope: string;
      readonly key: string;
    };
  }>;
}

export type StagePlanCheck =
  | { readonly ok: true; readonly plan: StagePlan }
  | { readonly ok: false; readonly detail: string };

const validateSchema = (() => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats.default(ajv);
  return ajv.compile(
    JSON.parse(NodeFS.readFileSync(`${specDirectory}stage-plan.schema.json`, "utf8")) as object,
  );
})();

const duplicate = (ids: ReadonlyArray<string>): string | undefined =>
  ids.find((id, index) => ids.indexOf(id) !== index);

/** The first item id on a `restsOn` cycle, or undefined. Depth-first with three colours. */
const findCycle = (plan: StagePlan): ReadonlyArray<string> | undefined => {
  const edges = new Map(plan.items.map((item) => [item.id, item.restsOn ?? []] as const));
  const colour = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (id: string): ReadonlyArray<string> | undefined => {
    colour.set(id, "visiting");
    path.push(id);
    for (const next of edges.get(id) ?? []) {
      if (colour.get(next) === "visiting") return [...path.slice(path.indexOf(next)), next];
      if (colour.get(next) === undefined) {
        const found = visit(next);
        if (found !== undefined) return found;
      }
    }
    path.pop();
    colour.set(id, "done");
    return undefined;
  };
  for (const item of plan.items) {
    if (colour.get(item.id) === undefined) {
      const found = visit(item.id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

/**
 * The structure (stage-plan.schema.json) plus the rules a schema cannot express: unique ids, `stageId` and `restsOn`
 * references that exist, and no cycle. `detail` is one plain sentence naming the first failure.
 */
export const checkStagePlan = (value: unknown): StagePlanCheck => {
  if (!validateSchema(value)) {
    const first = validateSchema.errors?.[0];
    return {
      ok: false,
      detail: `The plan does not match the format: ${first?.instancePath || "/"} ${first?.message ?? "is invalid"}.`,
    };
  }
  const plan = value as unknown as StagePlan;
  const twinStage = duplicate(plan.stages.map((stage) => stage.id));
  if (twinStage !== undefined)
    return { ok: false, detail: `Two stages share the id ${twinStage}.` };
  const twinItem = duplicate(plan.items.map((item) => item.id));
  if (twinItem !== undefined) return { ok: false, detail: `Two items share the id ${twinItem}.` };
  const stageIds = new Set(plan.stages.map((stage) => stage.id));
  const itemIds = new Set(plan.items.map((item) => item.id));
  for (const item of plan.items) {
    if (!stageIds.has(item.stageId))
      return {
        ok: false,
        detail: `Item ${item.id} is in stage ${item.stageId}, which does not exist.`,
      };
    for (const target of item.restsOn ?? []) {
      if (!itemIds.has(target))
        return { ok: false, detail: `Item ${item.id} rests on ${target}, which does not exist.` };
      if (target === item.id) return { ok: false, detail: `Item ${item.id} rests on itself.` };
    }
  }
  const cycle = findCycle(plan);
  if (cycle !== undefined)
    return { ok: false, detail: `The plan has a cycle: ${cycle.join(" rests on ")}.` };
  return { ok: true, plan };
};
