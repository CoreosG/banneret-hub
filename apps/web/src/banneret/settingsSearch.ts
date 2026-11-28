export const banneretSettings = [
  { id: "accounts", title: "Accounts", to: "/settings/accounts", scope: "environment-defaults" },
  {
    id: "account-github",
    title: "GitHub login",
    to: "/settings/accounts",
    scope: "environment-defaults",
  },
  {
    id: "account-tailscale",
    title: "Tailscale login",
    to: "/settings/accounts",
    scope: "environment-defaults",
  },
  {
    id: "account-relay",
    title: "Relay identity and sign-in",
    to: "/settings/accounts",
    scope: "environment-defaults",
  },
  {
    id: "account-roles",
    title: "Workspace roles",
    to: "/settings/accounts",
    scope: "environment-defaults",
  },
  { id: "memory", title: "Memory", to: "/settings/chat", scope: "environment-defaults" },
  {
    id: "banneret-memory",
    title: "Use Banneret memory",
    to: "/settings/chat",
    scope: "environment-defaults",
  },
  {
    id: "memory-import",
    title: "Import or sync memory",
    to: "/settings/chat",
    scope: "environment-defaults",
    targetId: "banneret-memory",
  },
] as const;
