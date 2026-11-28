// Banneret Hub: every machine's No project home is one sidebar group. Another group can still read
// "No project": a folder its server no longer uses as the home (a database brought from another
// data directory), or a machine whose config names no home. Such twins say where they are.
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";

/** The title the server gives a No project home. */
const HOME_TITLE = "No project";

type Group = Pick<
  SidebarProjectSnapshot,
  "displayName" | "isScratch" | "memberProjects" | "workspaceRoot"
>;

const machinesOf = (group: Group) =>
  [...new Set(group.memberProjects.flatMap((member) => member.environmentLabel ?? []))]
    .toSorted()
    .join(", ");

export function labelNoProjectTwins<TGroup extends Group>(groups: ReadonlyArray<TGroup>): TGroup[] {
  const twins = groups.filter((group) => group.isScratch || group.displayName === HOME_TITLE);
  if (twins.length < 2) return [...groups];
  return groups.map((group) => {
    if (!twins.includes(group)) return group;
    const machines = machinesOf(group);
    const namesIt = machines !== "" && twins.filter((t) => machinesOf(t) === machines).length === 1;
    // On the same machine only the folder differs, and the home keeps the plain name.
    const where = namesIt ? machines : group.isScratch ? null : group.workspaceRoot;
    return where === null ? group : { ...group, displayName: `${group.displayName} · ${where}` };
  });
}
