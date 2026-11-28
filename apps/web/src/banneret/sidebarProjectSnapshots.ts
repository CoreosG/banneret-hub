// Banneret Hub: the sidebar's project snapshots. Upstream puts every machine's No project home in
// one group. Another group can still read "No project": a folder its server no longer uses as the
// home (such as a database brought from another data directory), or a machine whose config names no
// home. Such twins say where they are.
import {
  buildSidebarProjectSnapshots as buildUpstreamSnapshots,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";

/** The title the server gives a No project home. */
const HOME_TITLE = "No project";

type Group = Pick<
  SidebarProjectSnapshot,
  "displayName" | "isScratch" | "memberProjects" | "workspaceRoot"
>;

/** A machine's No project home, or another folder that reads like one. */
export const isNoProjectGroup = (group: Pick<Group, "displayName" | "isScratch">) =>
  group.isScratch || group.displayName === HOME_TITLE;

const machinesOf = (group: Group) =>
  [...new Set(group.memberProjects.flatMap((member) => member.environmentLabel ?? []))]
    .toSorted()
    .join(", ");

function labelNoProjectTwins<TGroup extends Group>(groups: ReadonlyArray<TGroup>): TGroup[] {
  const twins = groups.filter(isNoProjectGroup);
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

export const buildSidebarProjectSnapshots = (...args: Parameters<typeof buildUpstreamSnapshots>) =>
  labelNoProjectTwins(buildUpstreamSnapshots(...args));
