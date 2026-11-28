export type RelayCapability = "tasks" | "skills" | "memory" | "chat" | "search" | "health";

type Owner = { owner: "banneret" | "off" } | { owner: "external"; source: string };
type TasksOwner =
  | { owner: "off" }
  | { owner: "banneret"; leases: "banneret" }
  | { owner: "external"; source: string; leases: "provider" };

export type RelayOwners = Record<Exclude<RelayCapability, "tasks">, Owner> & { tasks: TasksOwner };

export interface RelaySource {
  id: string;
  title: string;
  url: string;
  prefix?: string;
  provides: readonly RelayCapability[];
  auth: { kind: "none" | "oauth" } | { kind: "bearer_per_person"; help?: string };
  check: {
    state:
      | "unchecked"
      | "checking"
      | "ok"
      | "shape_missing"
      | "degraded"
      | "auth_failed"
      | "reachable"
      | "down";
    checkedAt?: string;
    shape?: Partial<
      Record<
        RelayCapability,
        {
          required: "complete" | readonly string[];
          optional: readonly string[];
        }
      >
    >;
  };
}

/** Fields on the enrolled capabilities response. Older relays omit them. */
export interface RelayOwnershipFields {
  owners?: RelayOwners;
  sources?: readonly RelaySource[];
}
