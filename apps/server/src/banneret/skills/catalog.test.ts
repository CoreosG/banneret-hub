// @effect-diagnostics nodeBuiltinImport:off - exercise the checkout layout in a temporary directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { defaults, mergeSkills, projectSkills } from "./catalog.ts";

it("resolves layers by scope and keeps the company's locked procedure", () => {
  const baseline = defaults[0]!;
  const company = { ...baseline, layer: "company" };
  const project = { ...baseline, layer: "project" };
  const personal = { ...baseline, layer: "personal" };
  const chosen = (...layers: Parameters<typeof mergeSkills>) =>
    mergeSkills(defaults, ...layers).get(baseline.name);
  expect(chosen([company])).toEqual(company);
  expect(chosen([company], [project])).toEqual(project);
  expect(chosen([company], [project], [personal])).toEqual(personal);
  expect(chosen([{ ...company, locked: true }], [project], [personal])).toMatchObject({
    layer: "company",
    locked: true,
  });
  expect(new Set(defaults.map((s) => s.name)).size).toBe(8);
});

it("loads project procedures from the calling checkout and ignores links out of it", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hub-skills-"));
  try {
    const folder = NodePath.join(root, "skills", "release");
    await NodeFSP.mkdir(folder, { recursive: true });
    const text = "---\nname: release\ndescription: Release the app.\n---\nCheck the tag.";
    await NodeFSP.writeFile(NodePath.join(folder, "SKILL.md"), text);
    await NodeFSP.symlink(root, NodePath.join(root, "skills", "outside"));
    expect(await projectSkills(root)).toMatchObject([{ name: "release", text, layer: "project" }]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
