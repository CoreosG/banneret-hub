// The two fixed file trees every profile is checked against. They exist only in memory.
// No folder holds two names whose order the docs may leave open, such as CLAUDE.md and .claude/CLAUDE.md.
import type { InstructionTree } from "./resolve.ts";

const home = "/home/ada";
const repo = "/home/ada/work/acme";
const startFolder = `${repo}/services`;

export const instructionTrees = {
  /** A provider's own files and AGENTS.md side by side, with a client folder above the repository. */
  mixed: {
    home,
    startFolder,
    files: [
      "/etc/claude-code/CLAUDE.md",
      "/home/ada/.claude/CLAUDE.md",
      "/home/ada/.codex/AGENTS.md",
      "/home/ada/work/CLAUDE.md",
      "/home/ada/work/AGENTS.md",
      `${repo}/.git/HEAD`,
      `${repo}/CLAUDE.md`,
      `${repo}/AGENTS.md`,
      `${startFolder}/AGENTS.md`,
      `${startFolder}/AGENTS.override.md`,
      `${startFolder}/CLAUDE.local.md`,
      `${startFolder}/payments/CLAUDE.md`,
      `${startFolder}/payments/AGENTS.md`,
      `${startFolder}/payments/invoice.ts`,
    ],
    emptyFiles: [],
    actions: [{ path: `${startFolder}/payments/invoice.ts`, action: "read" }],
  },
  /** AGENTS.md only on the way to the start folder, with empty overrides and folders below. */
  agentsOnly: {
    home,
    startFolder,
    files: [
      "/home/ada/.claude/CLAUDE.md",
      "/home/ada/.codex/AGENTS.override.md",
      "/home/ada/.codex/AGENTS.md",
      "/home/ada/work/AGENTS.md",
      `${repo}/.git/HEAD`,
      `${repo}/AGENTS.override.md`,
      `${repo}/AGENTS.md`,
      `${startFolder}/.claude/AGENTS.md`,
      `${startFolder}/payments/AGENTS.md`,
      `${startFolder}/payments/invoice.ts`,
      `${startFolder}/ledger/AGENTS.md`,
      `${startFolder}/ledger/entry.ts`,
      `${startFolder}/reports/AGENTS.md`,
      `${startFolder}/reports/CLAUDE.md`,
      `${startFolder}/reports/total.ts`,
    ],
    emptyFiles: ["/home/ada/.codex/AGENTS.override.md", `${repo}/AGENTS.override.md`],
    actions: [
      { path: `${startFolder}/payments/invoice.ts`, action: "read" },
      { path: `${startFolder}/ledger/entry.ts`, action: "edit" },
      { path: `${startFolder}/reports/total.ts`, action: "read" },
    ],
  },
} as const satisfies Record<string, InstructionTree>;
