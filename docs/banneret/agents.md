# Agents and leases

Most tasks are taken by coding agents, not by people. Banneret Hub gives the agents in your company's threads a
small set of tools, so they follow the same leases as the Board's Take and Release buttons. This works for any
company that runs a relay. Nothing in it is specific to Banneret.

## The join line

Paste this line into the agent instructions of each company repository (`AGENTS.md`, `CLAUDE.md` or similar):

```text
Work in this repository is leased: before you change anything, read the MCP resource banneret://join and follow it (the banneret_* tool descriptions give the same rules). If you have no banneret_* tools, this is not a company workspace, so work as usual.
```

`banneret://join` is a resource on the Hub's own MCP server, which every agent in a Hub thread already has. It
names the company and the person the agent works for, and states the rules:

1. **Check before you start.** Pick work from the board or the needs list, then check the lease once.
2. **Take before you edit.** Change nothing until the take answers `taken`.
3. **Release with a reason when you stop,** for any reason.
4. **Leave it free to continue** when someone else should finish it. Release before usage runs out, because a
   stopped agent cannot call any tool. Put Goal, Done and Next in the note.
5. **Finish what stopped half way,** or withdraw your own take.

The same line works outside a company. A Solo thread has no `banneret_*` tools and no resource, so the agent
simply works as usual.

## The tools

| Tool                      | What it does                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `banneret_board`          | The board from the relay's last snapshot. Filters: column, mine, repo.                    |
| `banneret_needs`          | What waits on the person, most urgent first.                                              |
| `banneret_task`           | One task: status, lease, pull requests, preview, sign-off and the last release note.      |
| `banneret_lease_check`    | Who holds a task now, read from the tracker, and what the agent may do.                   |
| `banneret_lease_take`     | Take a task: claim comment, assignee, `claimed` label, then a check of who claimed first. |
| `banneret_lease_release`  | Release with a reason, a note and free to continue.                                       |
| `banneret_lease_withdraw` | Undo the person's own take that stopped half way, or a claim that lost.                   |

- **Same rules as the buttons.** Take and release run the same code as the Board: the claim grammar, the
  10-second read-back, the settle window, and the checks for the right tracker account and triage access.
- **The person's own login.** Writes use the machine's tracker login, which must be the person the relay knows.
  So an agent can release only a lease its own person holds. Running take or release again finishes one that
  stopped half way.
- **The claim names the session:** `claim: <login>/<provider>-<start of the thread id>`, such as
  `claim: ada-example/claude-1a2b3c4d`. The thread title never leaves the machine.
- **Checking costs tracker calls.** `banneret_lease_check` makes one GitHub call for each lease comment on the
  issue. Agents call it once before a take or release, never in a loop. The board shows leases for free.

## When agents get the tools

A thread gets the tools only when all of these hold:

- its project is in an Enterprise workspace;
- this machine has joined that workspace's relay;
- the relay names the tool in its capabilities (`mcpTools`), at or below the person's role.

Otherwise the thread sees none of them, and calling one fails as unknown. A thread outside a company, or a
machine that never joined, makes no relay call at all. Each tool works on the relay of its own thread's
workspace, so a machine that joined two companies keeps them apart.

**For relay builders.** List the tool names above in `mcpTools` to switch them on, each with the lowest role
that may call it. The Hub keeps its own descriptions and schemas. See the
[capabilities section of the spec](relay-v1/README.md#capabilities).
