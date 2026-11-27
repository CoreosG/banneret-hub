import type { BanneretTeam, BanneretTeamPerson } from "@t3tools/contracts";
import { matchesText } from "./boards.logic";
import { roleLabel } from "./enterprise.logic";

export function nameRank(login: string, query: string) {
  const name = login.toLowerCase();
  const term = query.trim().toLowerCase();
  return name === term ? 0 : name.startsWith(term) ? 1 : 2;
}

/** People for the `/` search: login, role or machine label. */
export function searchPeople(
  team: BanneretTeam | null | undefined,
  query: string,
  limit = 8,
): Array<BanneretTeamPerson> {
  if (query.trim() === "" || team == null) return [];
  return team.people
    .filter((person) =>
      matchesText(query, [
        person.login,
        roleLabel(person.role),
        ...person.machines.map((machine) => machine.label),
      ]),
    )
    .sort((a, b) => nameRank(a.login, query) - nameRank(b.login, query))
    .slice(0, limit);
}
