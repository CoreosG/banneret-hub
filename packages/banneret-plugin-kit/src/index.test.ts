import { describe, expect, it } from "vite-plus/test";
import task from "../../../docs/banneret/relay-v1/examples/task.json" with { type: "json" };
import { fakeHub, manifestSchema, tools } from "./index.ts";

import { referenceSkills } from "./referenceSkills.fixture.ts";

describe("external plugin contract", () => {
  const config = {
    source: "acme",
    description: "Release playbooks",
    capabilities: ["skills"],
    auth: "service",
    toolPrefix: "acme_",
  } as const;
  it("reads the same SKILL.md through both MCP entry points", async () => {
    const hub = fakeHub({ ...config, capabilities: [...config.capabilities] }, referenceSkills());
    const { skills } = await hub.call("skills_list", {});
    const skill = await hub.call("skills_get", { name: skills[0]!.name });
    expect(await hub.readSkill(skill.name)).toBe(skill.text);
    await expect(hub.call("skills_get", { name: "missing" })).rejects.toThrow();
    await expect(hub.call("tasks_list_boards", {})).rejects.toThrow();
  });
  it("requires task providers to disclose whether claims are atomic", () => {
    const manifest = { ...config, capabilities: ["tasks"] };
    expect(manifestSchema.safeParse(manifest).success).toBe(false);
    expect(manifestSchema.parse({ ...manifest, atomicClaim: false }).atomicClaim).toBe(false);
  });
  it("preserves relay TaskRead fields while ignoring extensions", () => {
    expect(tools.tasks_read.output.parse({ ...task, task: { ...task.task, priority: 3 } })).toEqual(
      task,
    );
    expect(tools.tasks_read.output.safeParse({ ...task, assignees: ["ada"] }).success).toBe(false);
    const { preview: _preview, checked: _checked, ...card } = task;
    expect(tools.tasks_list_tasks.output.parse({ tasks: [card] })).toEqual({ tasks: [card] });
  });
  it("discards attempted confirmation and resolution fields", () => {
    const proposal = {
      key: "deploy",
      scope: "project",
      kind: "project",
      source: "README",
      why: "Keep releases consistent.",
      text: "Run checks first.",
    };
    expect(tools.banneret_memory_propose.input.parse({ ...proposal, confirmed: true })).toEqual(
      proposal,
    );
    const result = (trust: string) => ({
      data: JSON.stringify({ ...proposal, trust, useCount: 0 }),
    });
    expect(tools.banneret_memory_propose.output.safeParse(result("proposed")).success).toBe(true);
    expect(tools.banneret_memory_propose.output.safeParse(result("confirmed")).success).toBe(false);
    expect(tools.banneret_memory_flag.output.safeParse(result("disputed")).success).toBe(true);
    expect(tools.banneret_memory_flag.output.safeParse(result("confirmed")).success).toBe(false);
    expect(
      tools.banneret_memory_flag.input.parse({ key: "deploy", reason: "Outdated", resolve: true }),
    ).toEqual({ key: "deploy", reason: "Outdated" });
  });
});
