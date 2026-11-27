// Shared machine wire types. The canonical schemas live in relay-v1/openapi.yaml.

export type PoolSlots = {
  readonly small: number;
  readonly large: number;
};

export type PoolHostLimits = {
  readonly id: string;
  readonly level: "staff" | "community";
  readonly workspaces: {
    readonly max: number;
    readonly each: {
      readonly cpu: number;
      readonly memory_floor: string;
      readonly memory_max: string;
      readonly disk: string;
      readonly tasks: number;
    };
  };
  readonly sandbox_slots: PoolSlots;
};

export type PoolWarnings = {
  readonly quota_percent: number;
  readonly memory_percent: number;
  readonly cpu_throttled_percent: number;
  readonly pids_percent: number;
  readonly pressure: {
    readonly cpu: number;
    readonly memory: number;
    readonly io: number;
  };
  readonly host_busy: {
    readonly memory_full_avg60: number;
    readonly io_some_avg60: number;
    readonly cpu_some_avg60: number;
  };
};

export type PoolConfig = {
  readonly enabled: boolean;
  readonly hosts: ReadonlyArray<PoolHostLimits>;
  readonly warnings: PoolWarnings;
  readonly sandboxes: {
    readonly sizes: {
      readonly small: {
        readonly cpu: number;
        readonly memory: string;
        readonly disk: string;
      };
      readonly large: {
        readonly cpu: number;
        readonly memory: string;
        readonly disk: string;
      };
    };
    readonly time_limit: string;
    readonly idle_limit: string;
    readonly extend: string;
    readonly per_person: {
      readonly running: number;
      readonly waiting: number;
    };
    readonly images: ReadonlyArray<{
      readonly name: string;
      readonly digest: string;
    }>;
  };
};

export type PoolMeter = {
  readonly used: number;
  readonly limit: number | null;
  readonly warn: boolean;
};

export type PoolPsi = {
  readonly some: {
    readonly avg10: number;
    readonly avg60: number;
  };
  readonly full: {
    readonly avg10: number;
    readonly avg60: number;
  };
};

export type PoolQuota = {
  readonly notMeasured: "macos" | "windows" | "missing_files" | null;
  readonly disk: PoolMeter | null;
  readonly inodes: PoolMeter | null;
  readonly warnings: {
    readonly memory: boolean;
    readonly cpu: boolean;
    readonly pids: boolean;
    readonly pressure: boolean;
  };
};

export type Resources = {
  readonly measuredAt: string;
  readonly notMeasured: "macos" | "windows" | "missing_files" | null;
  readonly disk: PoolMeter | null;
  readonly inodes: PoolMeter | null;
  readonly memory: {
    readonly used: number;
    readonly limit: number | null;
    readonly floor: number;
    readonly oomKills: number;
    readonly warn: boolean;
  } | null;
  readonly cpu: {
    readonly throttledPercent: number;
    readonly quotaUsec: number | null;
    readonly periodUsec: number;
    readonly warn: boolean;
  } | null;
  readonly pids: PoolMeter | null;
  readonly pressure: {
    readonly memory: {
      readonly sample: PoolPsi;
      readonly limit: number;
      readonly warn: boolean;
    } | null;
    readonly cpu: {
      readonly sample: PoolPsi;
      readonly limit: number;
      readonly warn: boolean;
    } | null;
    readonly io: {
      readonly sample: PoolPsi;
      readonly limit: number;
      readonly warn: boolean;
    } | null;
  };
};

export type HostContention = {
  readonly measuredAt: string;
  readonly notMeasured: "macos" | "windows" | "missing_files" | null;
  readonly pressure: {
    readonly memory: PoolPsi | null;
    readonly cpu: PoolPsi | null;
    readonly io: PoolPsi | null;
  };
  readonly memAvailableBytes: number | null;
  readonly poolMemoryUsedBytes: number | null;
  readonly poolMemoryLimitBytes: number | null;
  readonly freeSlots: PoolSlots;
  readonly busy: boolean;
};

export type PoolSandbox = {
  readonly id: string;
  readonly state:
    | "waiting"
    | "offered"
    | "starting"
    | "running"
    | "ending"
    | "ended"
    | "cleanup_failed";
  readonly place: number | null;
  readonly waitSeconds: number | null;
  readonly machineId: string | null;
  readonly endsAt: string | null;
  readonly reason: string | null;
};

export type PoolWorkspace = {
  readonly hostId: string;
  readonly state: "asked" | "approved" | "ready_to_join" | "active" | "suspended" | "removed";
};

export type PoolDirective = {
  readonly sandboxId: string;
  readonly offerId: string;
} & ({ readonly action: "cancel" } | { readonly action: "extend"; readonly endsAt: string });

export type PoolCurrent = {
  readonly sandboxId: string;
  readonly state: PoolSandbox["state"];
  readonly offerId?: string;
};

export type PoolPolicy = PoolLimitsPolicy & { readonly directives: readonly PoolDirective[] };

export type PoolLimitsPolicy = {
  readonly limits: PoolHostLimits;
  readonly sizes: PoolConfig["sandboxes"]["sizes"];
  readonly warnings: PoolWarnings;
};

export type PoolView = {
  readonly sandboxes: PoolConfig["sandboxes"] | null;
  readonly bookings: ReadonlyArray<{ readonly id: string; readonly hostId: string }>;
  readonly hosts: ReadonlyArray<{
    readonly hostId: string;
    readonly level: "staff" | "community";
    readonly policy: PoolLimitsPolicy | null;
    readonly reporting: boolean;
    readonly contention: HostContention | null;
    readonly holders: ReadonlyArray<{
      readonly id: string;
      readonly personId: string;
      readonly size: "small" | "large";
      readonly taskId: string | null;
    }>;
    readonly line: ReadonlyArray<{
      readonly id: string;
      readonly personId: string;
      readonly size: "small" | "large";
      readonly taskId: string | null;
    }>;
    readonly heldCount: number;
    readonly waitingCount: number;
  }>;
  readonly me: {
    readonly workspaces: ReadonlyArray<{
      readonly hostId: string;
      readonly state: "asked" | "approved" | "ready_to_join" | "active" | "suspended" | "removed";
      readonly resources: PoolQuota | null;
    }>;
  };
};

export type PoolWorkspaceRequest = {
  readonly hostId: string;
};

export type PoolSandboxRequest = {
  readonly hostId: string;
  readonly size: "small" | "large";
  readonly image: string;
  readonly taskId?: string | null;
};

export type PoolHostFacts = {
  readonly limits: PoolHostLimits;
  readonly sizes: PoolConfig["sandboxes"]["sizes"];
  readonly contention: HostContention;
  readonly workspaces: ReadonlyArray<{
    readonly personId: string;
    readonly state: "asked" | "approved" | "ready_to_join" | "active" | "suspended" | "removed";
    readonly resources: PoolQuota;
  }>;
  readonly running: ReadonlyArray<string>;
};

export type PoolNextRequest = {
  readonly size: "small" | "large";
};

export type PoolOffer = {
  readonly publicKey: string;
  readonly offerId: string;
  readonly id: string;
  readonly personId: string;
  readonly machineId: string;
  readonly deadline: string;
  readonly counter: string;
  readonly sentAt: string;
  readonly signature: string;
  readonly bodyBase64: string;
} | null;

export type PoolNextResponse = {
  readonly offer: PoolOffer;
  readonly directives: readonly PoolDirective[];
};

export type PoolStateUpdate = {
  readonly endsAt?: string;
  readonly offerId: string;
  readonly state: "starting" | "running" | "ending" | "ended" | "cleanup_failed";
  readonly machineId: string | null;
  readonly reason: string | null;
};
