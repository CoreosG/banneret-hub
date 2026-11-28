// Works out which instruction files a profile says are read, from a list of paths it is handed.
// It reads no disk. It never names a provider.
import {
  instructionLevels,
  type InstructionLevel,
  type InstructionLoads,
  type ProviderProfile,
} from "./schema.ts";

export interface InstructionTree {
  /** The person's home folder, as an absolute POSIX path. */
  readonly home: string;
  /** The folder the session runs in. */
  readonly startFolder: string;
  readonly files: ReadonlyArray<string>;
  /** Which of `files` have no content. */
  readonly emptyFiles: ReadonlyArray<string>;
  /** File actions during the session, in order. */
  readonly actions: ReadonlyArray<{ path: string; action: "read" | "write" | "edit" }>;
}

type NameRule = { names: ReadonlyArray<string>; take: "all" | "firstNonEmpty" };
type Fact<T> = { value: T } | { unknown: string };

const known = <T>(fact: Fact<T>): T | undefined => ("value" in fact ? fact.value : undefined);

const join = (folder: string, name: string) => `${folder === "/" ? "" : folder}/${name}`;
const parent = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

/** `folder` and every folder above it, outermost first. */
function ancestors(folder: string): string[] {
  return folder === "/" ? ["/"] : [...ancestors(parent(folder)), folder];
}

export function resolveInstructions(
  profile: ProviderProfile,
  tree: InstructionTree,
): InstructionLoads {
  const { instructions } = profile;
  const files = new Set(tree.files);
  const empty = new Set(tree.emptyFiles);
  const pick = (folder: string, rule: NameRule) => {
    const present = rule.names.map((n) => join(folder, n)).filter((p) => files.has(p));
    return rule.take === "all" ? present : present.filter((p) => !empty.has(p)).slice(0, 1);
  };

  const unknownLevels = new Set<InstructionLevel>();
  const atStart: Partial<Record<"managed" | "user" | "project", string[]>> = {};

  const managed = known(instructions.managed);
  if (managed === undefined) unknownLevels.add("managed");
  else atStart.managed = managed && files.has(managed.linux) ? [managed.linux] : [];

  const homeFolder = known(instructions.homeFolder);
  const userRule = known(instructions.user);
  if (homeFolder === undefined || userRule === undefined) unknownLevels.add("user");
  else atStart.user = pick(join(tree.home, homeFolder.path.slice(2)), userRule);

  // A walk through the home folder meets the personal files again. They are not project files.
  const notProject = new Set([...(atStart.managed ?? []), ...(atStart.user ?? [])]);
  const projectPick = (folder: string, rule: NameRule) =>
    pick(folder, rule).filter((p) => !notProject.has(p));

  const walk = known(instructions.project.walk);
  const names = known(instructions.project.names);
  const fallback = known(instructions.project.fallback);
  let fallbackOnWalk: boolean | undefined;
  if (walk && names && fallback) {
    const outer = walk.startsAt === "startFolder" ? walk.stopsAt : walk.startsAt;
    let folders: string[] | undefined;
    if (outer === "filesystemRoot") folders = ancestors(tree.startFolder);
    else {
      const root = known(instructions.project.root);
      if (root) {
        const chain = ancestors(tree.startFolder);
        const at = chain.findLastIndex((folder) =>
          root.markers.some((marker) =>
            tree.files.some(
              (p) => p === join(folder, marker) || p.startsWith(`${join(folder, marker)}/`),
            ),
          ),
        );
        folders = at === -1 ? [tree.startFolder] : chain.slice(at);
      }
    }
    if (folders) {
      const hasPrimary = folders.some(
        (folder) => projectPick(folder, { names: names.names, take: "all" }).length > 0,
      );
      fallbackOnWalk = fallback.when === "noPrimaryFileOnTheWalk" && !hasPrimary;
      atStart.project = folders.flatMap((folder) => {
        if (fallback.when === "afterPrimaryNamesInEachFolder") {
          return projectPick(folder, {
            names: [...names.names, ...fallback.names],
            take: names.take,
          });
        }
        return fallbackOnWalk && fallback.when === "noPrimaryFileOnTheWalk"
          ? projectPick(folder, { names: fallback.names, take: "all" })
          : projectPick(folder, names);
      });
    }
  }
  if (!atStart.project) unknownLevels.add("project");

  const onDemand: string[] = [];
  const undetermined: string[] = [];
  const add = (list: string[], paths: ReadonlyArray<string>) => {
    for (const path of paths) {
      if (!list.includes(path) && !atStart.project?.includes(path)) list.push(path);
    }
  };
  const below = known(instructions.subdirectory);
  if (below === undefined || (below.load === "onDemand" && below.fallback && !atStart.project)) {
    unknownLevels.add("subdirectory");
  } else if (below.load === "onDemand") {
    const prefix = join(tree.startFolder, "");
    for (const { path, action } of tree.actions) {
      if (!path.startsWith(prefix)) continue;
      const folders = ancestors(parent(path)).filter((folder) => folder.startsWith(prefix));
      for (const [index, folder] of folders.entries()) {
        const found: string[] = [];
        if (below.triggers.includes(action)) found.push(...pick(folder, below.names));
        if (
          fallbackOnWalk &&
          below.fallback?.triggers.includes(action) &&
          !below.fallback.blockedBy.some((name) => files.has(join(folder, name)))
        ) {
          found.push(...pick(folder, { names: below.fallback.names, take: "all" }));
        }
        const touched = index === folders.length - 1;
        add(touched || below.foldersBetween === "loaded" ? onDemand : undetermined, found);
      }
    }
  }

  // Without a known order no start list can be promised.
  const precedence = known(instructions.precedence);
  for (const level of ["managed", "user", "project"] as const) {
    if (atStart[level] && !precedence?.order.includes(level)) unknownLevels.add(level);
  }

  return {
    atStart: (precedence?.order ?? []).flatMap((level) => atStart[level] ?? []),
    onDemand,
    undetermined: undetermined.filter((path) => !onDemand.includes(path)),
    unknownLevels: instructionLevels.filter((level) => unknownLevels.has(level)),
  };
}
