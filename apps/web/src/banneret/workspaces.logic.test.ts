import {
  EnvironmentId,
  ProjectId,
  type BanneretWorkspace,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { Project } from "../types";
import {
  assignProjects,
  autoSwitchTarget,
  deleteWorkspace,
  filterProjectsForWorkspace,
  projectIdentityKeys,
  resolveWorkspaces,
  staleOnEnvironment,
  workspaceProjectKey,
} from "./workspaces.logic";

function project(
  id: string,
  options: { environment?: string; repo?: string; scratch?: boolean } = {},
): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make(options.environment ?? "local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: options.repo
      ? ({ canonicalKey: options.repo, rootPath: `/projects/${id}` } as RepositoryIdentity)
      : null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...(options.scratch ? { isScratch: true as const } : {}),
  };
}

const workspace = (overrides: Partial<BanneretWorkspace>): BanneretWorkspace => ({
  id: "w1",
  name: "Client",
  kind: "solo",
  projectKeys: [],
  updatedAt: "2026-11-26T10:00:00.000Z",
  ...overrides,
});

describe("resolveWorkspaces", () => {
  it("keeps the newest copy per id across environments, and drops tombstones", () => {
    const older = workspace({ name: "Old" });
    const newer = workspace({ name: "New", updatedAt: "2026-11-26T11:00:00.000Z" });
    const gone = workspace({ id: "w2", deleted: true, updatedAt: "2026-11-26T12:00:00.000Z" });
    const stale = workspace({ id: "w2", name: "Still here" });
    expect(resolveWorkspaces([older, gone], [newer, stale])).toEqual([newer]);
    expect(resolveWorkspaces([newer, stale], [older, gone])).toEqual([newer]);
  });

  it("gives a project claimed twice to the newest workspace", () => {
    const a = workspace({ id: "a", name: "A", projectKeys: ["repo:x", "repo:y"] });
    const b = workspace({
      id: "b",
      name: "B",
      projectKeys: ["repo:y"],
      updatedAt: "2026-11-26T11:00:00.000Z",
    });
    expect(resolveWorkspaces([a, b]).map((entry) => entry.projectKeys)).toEqual([
      ["repo:x"],
      ["repo:y"],
    ]);
  });
});

describe("filterProjectsForWorkspace", () => {
  const site = project("site", { repo: "github.com/acme/site" });
  const siteRemote = project("site-remote", { environment: "vps", repo: "github.com/acme/site" });
  const notes = project("notes");
  const scratch = project("scratch", { scratch: true });
  const projects = [site, siteRemote, notes, scratch];
  const client = workspace({ projectKeys: [workspaceProjectKey(site)] });

  it.each([
    { label: "no workspaces shows everything", workspaces: [], active: null, shown: projects },
    {
      label: "a workspace shows its repository on every environment, plus scratch",
      workspaces: [client],
      active: "w1",
      shown: [site, siteRemote, scratch],
    },
    {
      label: "Personal shows the rest",
      workspaces: [client],
      active: null,
      shown: [notes, scratch],
    },
    {
      label: "a deleted active workspace falls back to Personal",
      workspaces: [client],
      active: "deleted-id",
      shown: [notes, scratch],
    },
  ])("$label", ({ workspaces, active, shown }) => {
    expect(filterProjectsForWorkspace(projects, workspaces, active)).toEqual(shown);
  });

  it("matches a project by path while its repository identity has not arrived", () => {
    const pathOnly = project("site");
    const byPath = workspace({ projectKeys: [workspaceProjectKey(pathOnly)] });
    expect(filterProjectsForWorkspace([site], [byPath], "w1")).toEqual([site]);
  });
});

describe("assignProjects and deleteWorkspace", () => {
  it("moves projects out of other workspaces and stamps only changed records", () => {
    const a = workspace({ id: "a", projectKeys: ["repo:x", "repo:y"] });
    const b = workspace({ id: "b", projectKeys: [] });
    const c = workspace({ id: "c", projectKeys: ["repo:z"] });
    const now = "2026-11-26T13:00:00.000Z";
    expect(
      assignProjects({ workspaces: [a, b, c], workspace: b, projectKeys: ["repo:y"], now }),
    ).toEqual([
      { ...b, projectKeys: ["repo:y"], updatedAt: now },
      { ...a, projectKeys: ["repo:x"], updatedAt: now },
    ]);
    // A project stored by path before its repository identity arrived still moves out of `a`.
    const site = project("site", { repo: "github.com/acme/site" });
    const byPath = workspace({ id: "a", projectKeys: [`path:local:/projects/site`] });
    const [, released] = assignProjects({
      workspaces: [byPath, b],
      workspace: b,
      projectKeys: [workspaceProjectKey(site)],
      claimedKeys: projectIdentityKeys(site),
      now,
    });
    expect(released?.projectKeys).toEqual([]);
    expect(deleteWorkspace(a, now)).toEqual({
      ...a,
      projectKeys: [],
      deleted: true,
      updatedAt: now,
    });
  });
});

describe("autoSwitchTarget", () => {
  const site = project("site", { repo: "github.com/acme/site" });
  const client = workspace({ projectKeys: [workspaceProjectKey(site)] });
  it.each([
    { label: "into the thread's workspace", p: site, active: null, expected: { switchTo: "w1" } },
    { label: "already there", p: site, active: "w1", expected: null },
    { label: "back to Personal", p: project("notes"), active: "w1", expected: { switchTo: null } },
    {
      label: "never for a thread without a project",
      p: project("s", { scratch: true }),
      active: "w1",
      expected: null,
    },
  ])("$label", ({ p, active, expected }) => {
    expect(autoSwitchTarget({ project: p, workspaces: [client], activeId: active })).toEqual(
      expected,
    );
  });
});

describe("staleOnEnvironment", () => {
  it("lists what an environment lacks or holds older", () => {
    const current = workspace({ updatedAt: "2026-11-26T11:00:00.000Z" });
    const other = workspace({ id: "w2" });
    expect(staleOnEnvironment([current, other], [workspace({}), other])).toEqual([current]);
  });
});
