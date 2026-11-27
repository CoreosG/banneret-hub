import { expect, it } from "vite-plus/test";
import { searchPeople } from "./team.logic";
const TEAM = {
  people: [
    {
      id: "p_ada",
      login: "ada-example",
      role: { id: "founder", name: "Founder" },
      admission: "member" as const,
      sessions: [],
      machines: [{ id: "m", label: "Ada server", connected: true, kind: "server" }],
    },
  ],
};
it("finds people for the / search, and nobody for an empty query", () => {
  expect(searchPeople(TEAM, "server").map((person) => person.login)).toEqual(["ada-example"]);
  expect(searchPeople(TEAM, "  ")).toEqual([]);
  expect(searchPeople(null, "ada")).toEqual([]);
});
