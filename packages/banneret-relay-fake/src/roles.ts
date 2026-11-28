export interface RoleWrite {
  name: string;
  forOutside: boolean;
  permissions: Record<string, true | string | string[]>;
}
const enabled = (keys: string) =>
  Object.fromEntries(keys.split(" ").map((key) => [key, true as const]));
const contractor = {
  ...enabled("dm.group agents.mention agents.ask agents.dm agents.wakeOthers hub.team"),
  "dm.start": "anyone",
  "scope.people": "all",
  "scope.boards": "all",
};
const staff = {
  ...contractor,
  ...enabled(
    "channels.seePublic channels.createPublic channels.createPrivate channels.invite dm.outsiders hub.health hub.pool",
  ),
};
export const templates: Record<string, RoleWrite> = {
  founder: {
    name: "Founder",
    forOutside: false,
    permissions: {
      ...staff,
      ...enabled(
        "channels.manageAll channels.openToOutside channels.directoryAll hub.machinesAll relay.admin",
      ),
    },
  },
  staff: { name: "Staff", forOutside: false, permissions: staff },
  contractor: { name: "Contractor", forOutside: false, permissions: contractor },
  outside: {
    name: "Outside collaborator",
    forOutside: true,
    permissions: {
      "agents.mention": true,
      "dm.start": "shared_channel",
      "scope.people": "shared_channels",
      "scope.boards": "all",
    },
  },
};
