# Workspaces and the relay

Banneret Hub is T3 Code with a team layer on top. This page explains that layer: workspaces, the company
relay, and what each screen does. It is written for anyone who picks the product up, not only for Banneret.

- **Solo works fully today.** You need nothing else.
- **Enterprise needs a relay** that implements the `/relay/v1` contract. See
  [Using Banneret Hub outside Banneret](#using-banneret-hub-outside-banneret).

## Workspaces

The sidebar groups projects into **workspaces**. A workspace is a named scope over the projects you already
have. Threads, drafts and the command palette follow the active workspace.

- **Solo**: plain T3 Code. The default workspace is called "Personal". A Solo workspace never contacts a relay.
- **Enterprise**: joined to a **relay** that your company runs. It adds the team screens below. A section
  appears only when the relay offers it. Knowledge, Channels and direct messages are in the relay design but
  not built in the app yet.

## Joining a relay

1. Create a workspace and choose **Enterprise**.
2. Enter the relay's address. It must be https. The wizard shows the company name the relay reports, so check
   that it is the company you expect.
3. Join. Banneret Hub shows a short code and opens the relay's sign-in page in your browser. Sign in there and
   type the code. The relay page also shows the machine that is asking, so confirm only a code your own Banneret
   Hub is showing you right now.
4. A person new to the company then waits for a founder to approve.

The whole machine (this Banneret Hub server) joins, whichever workspace is active. A machine that has not
joined never contacts a relay.

**Several companies.** A machine can join several relays, for example two employers, or a company and an open
source project. Each relay gets its own Enterprise workspace, and New workspace, Enterprise always starts at the
address. If you enter a relay this machine already joined, the wizard says so and opens its workspace. Each relay
keeps its own key and token, and hears only about threads in its own workspace's projects. Leaving one company
leaves the others as they are.

**Machines.** The switcher shows this machine's status for each Enterprise workspace, and lists that company's
machines: who owns each one,
whether it is online, its Banneret Hub version, its policy fingerprint and whether its sandbox is on. You can
remove your own machines from the list. Founders can remove any.

**Leave.** Leaving tells the relay and stops this machine contacting it. If the relay cannot be reached, you
can forget the machine here instead. A founder must then remove it on the relay. The same way out applies when
a founder has approved the machine but setup cannot finish.

## What the Enterprise workspace shows

Each screen below is shown only when the relay advertises it. Screens show the active workspace's company, so
switching workspaces switches the company. When the relay cannot be reached, a screen keeps showing what the
relay last said, with its age.

### Today and Needs you

**Today** lists what needs you, what shipped since your last visit, who is working now, what is stuck and how
things are. **Needs you** is the full list of items waiting on you, most urgent first. An item that belongs to a
thread opens it when that thread is on a machine this app knows. Otherwise it tells you which machine holds it.

A stuck item can have several reasons. They are shown most important first.

### Board

The Board has five columns: Free, Taken, Validating, Stuck and Shipped. Each card shows a status mark, a short
plain reason for that status, the pull request and its checks, and who holds the claim. An empty column shrinks to
a narrow strip with its name and 0, so the others get more room.

A task is **Taken** when someone holds a claim on it or is assigned to it, and **Free** when nobody is. A task
assigned without a claim says "assigned · not claimed" with the assignee's login. Anyone may still take it.

**Mine** shows the tasks you hold or are assigned, with how many there are and how many of your claims expired.
When one of your claims has expired or stopped half way, a strip says so. **Review your expired claims** shows
only those, each with its Release button (or Finish and Withdraw for one that stopped half way).

A claim is a **lease**. It stays active while its holder works: pushes, comments and their own running agent
sessions all count. A lease turns **stale after 6 hours** without a signal, and the card moves to Stuck. It
**expires after 24 hours**. An expired lease stays in Stuck. It is not shown as Free until the claim is released
on the work tracker. A coworker's agent on the same task never refreshes someone else's lease.

The checked mark appears only when the board says it applies a sign-off rule. A person with the sign-off role
adds the check, and it counts only after the pull request merged, its checks passed and someone else approved
the review.

### Take and release

You can take and release a task from the Hub when the relay parses leases and a project here is on the task's
repository. Use **Take** in the Task tab, or the menu on a board card. The Hub writes a `claim:` comment, assigns
you and adds the `claimed` label, all on your own tracker login. It then waits about 10 seconds and reads the
issue again: if someone claimed first, they keep it and your claim is withdrawn.

**Release** asks for a reason and an optional note (Goal, Done, Next). Turn on **Free to continue** to leave the
task for someone else. It is on by default for Blocked, Handing over and Out of usage. Such tasks sit at the top
of Free with your name and reason, and **Continue** shows your note before it takes the task.

If a step fails half way, the task shows **Finish** and **Withdraw**. You need triage access to the repository,
and the tracker login must be the one the relay knows. When either is missing, the Hub says so and writes
nothing.

### Map and Rests-on

The Map shows the build in stages. Each item has a status, and each item can rest on other items. If something
an item rests on needs you, was sent back or was ruled dead, the item that rests on it needs you too, and the
reason names the blocker. The map is drawn from a [stage plan](#the-stage-plan). If the plan is broken, the Map
says so. It never shows a broken plan as an empty one.

The line on the left marks progress. The current stage is the first one that is not fully built. A later stage
that is already built keeps its check, but the line does not fill through it: it was built ahead of an earlier
stage.

### Feed and Graveyard

The **Feed** is the company's activity, newest first: claims taken and released, expired leases, pull requests
opened and merged, and tasks built, checked or sent back. The **Graveyard** lists tasks ruled dead, each with
the reason. A task never sits there without one.

### The Task tab

Opening a task shows its status, who holds it, when it opened and closed, every linked pull request and its
checks, its stage on the Map, its preview when there is one, who checked it, what it rests on, and the last
release with its note. Below that is the work tracker's own issue thread and composer.

**Edits there are made on GitHub as you.** (It says the tracker's name, which is GitHub by default.) They use
your own login, and the board's rules for claims and sign-off still apply. If none of your projects here is on
that tracker, the tab shows one row that links to the issue instead.

### The open tabs bar

A bar above the main view keeps your open threads and workspace pages (Today, Needs you, Board, Map, Feed) as
tabs.

- Click a tab to open it. Double-click keeps a preview tab. Pin keeps a tab for good.
- Middle-click closes. Drag reorders.
- A tab shown in italics is a preview. Opening something else replaces it. Sending a message keeps it.
- Up to 20 tabs are kept. Pinned tabs are never dropped.

## Ports, file transfer and Save As

These work in every workspace, Solo included.

- **Ports.** Add the Ports panel from the right panel's add menu. It lists every port listening on the
  environment's host and forwards any of them to localhost on your computer through the desktop app. You can
  label and pin a forward. The icon shows how many forwards are active.
- **File transfer.** Drag files and folders into a workspace's file view, or download from it. Transfers stream
  over signed HTTP links, so they work on every connection: local, LAN or Tailscale. If a file already exists
  you choose Replace, Keep both or Skip.
- **Save As.** A download asks where to save it. The desktop app shows the system's Save As dialog. A browser
  uses its file picker when it has one.

## Per-machine updates

The update dialog lists every machine it can update and says "Update N machines". Each machine starts ticked.
Untick the ones you want to skip. Machines that update together with this app cannot be unticked. The dialog
shows each machine's current and target version.

## What leaves the machine

A joined machine sends the relay facts and usage every 30 seconds, and nothing else:

- the machine's name, kind, hostname, operating system and Banneret Hub version;
- for threads in Enterprise projects only, each session's state, branch, provider, model, times and a hash of
  the repository name;
- how much of each usage window your own Claude and Codex logins have used.

It never sends prompts, replies, code, thread titles, local paths or remote URLs. The only thread content that
ever leaves a machine is a thread its owner chose to share. Solo projects send nothing. See
[privacy.md](privacy.md) for the full notice.

## Using Banneret Hub outside Banneret

Banneret built this for its own team, but nothing in it is specific to Banneret.

- **Solo works fully today.** Install it and use it. No relay, account or Banneret service is involved.
- **Enterprise needs a relay that implements `/relay/v1`.** Banneret's relay is written in Go. It will be
  published after it has proven itself in daily use. Until then, anyone can build a relay against the
  [spec](relay-v1/README.md). Use the [fake relay and conformance suite](relay-v1/FAKE.md) to try your relay
  and check that it follows the contract.
- **Adapters are GitHub by default** and chosen in the relay's config. See [Adapters](#adapters).
- **The stage plan is a public JSON format** that any company can produce. See
  [`stage-plan.schema.json`](relay-v1/stage-plan.schema.json). For example, Banneret generates its stage plan
  from its knowledge base. Yours can come from anywhere.
- **Sections a relay does not advertise are simply hidden.** A small relay can serve only Today and Needs you.
  The Board, Map, Feed, Graveyard and Task screens appear only when the relay offers them.
- **Self-hosters own their data's durability.** See [You own your data](#you-own-your-data).

## The stage plan

The Map is built from one machine-readable file, the stage plan. It lists stages and the items in them. Each
item can name the tracker issue behind it and the items it rests on. The plan carries no status of its own. The
relay joins each item to the tracker to work out its status. The structure is in
[`stage-plan.schema.json`](relay-v1/stage-plan.schema.json), with the rules in the
[spec](relay-v1/README.md#stage-plan-file). Where the relay finds the file is the relay's configuration.

## The relay

A relay is a small server one company runs for its own staff. Banneret Hub talks to it through an open
contract, `/relay/v1`. Anyone may build a compatible relay.

- **Spec first.** The canonical `/relay/v1` spec lives in [`relay-v1/`](relay-v1/README.md). A small
  [fake relay](relay-v1/FAKE.md) runs this repository's conformance suite against it. The fake is a test double,
  not a production server.
- **Banneret's relay is published later.** Banneret runs its relay in Go. Once it has proven itself with a
  second person using it every day, it moves to its own public repository under the MIT licence. Until then
  there is no production relay you can download.
- **Each company runs its own.** The relay is one binary with one SQLite file. Staff sign in through the
  company's staff directory, which is its GitHub org by default. Banneret hosts no relays for other companies.
- **Capabilities.** The relay publishes a capabilities document listing the sections, versions, feature
  flags and agent tools it offers. Banneret Hub shows only the sections a relay advertises.

### You own your data

The relay can always start from an empty store. Sign-in, the board, knowledge and health are rebuilt from
your work tracker and config. Channels, direct messages and shared threads exist only in the relay's
database.

**Keeping that data safe is the operator's job.** The relay offers an optional encrypted `backup` command
and a matching `restore` command. It never requires them, schedules them or refuses to run without them.
If you lose the data directory without a backup, channels, direct messages and shared threads are gone.
Backups cover channels, direct messages, staff and settings. They never include shared threads, so a
restore cannot bring back a thread whose owner stopped sharing it or that has expired. Whoever holds a
backup and its key can read every direct message in it, so tell your staff who that is.

### Shared threads

A person can share a readable copy of a thread with named colleagues. The copy is encrypted, kept for 30
days, and capped at 25 MiB per thread and 2 GiB per relay. When a thread is larger than its cap, the
owner's own Banneret Hub uploads a compacted handover plus as much recent history as fits. Over time the
oldest items roll into the handover. Compaction happens on the owner's machine; the relay never runs a
model.

## Adapters

The relay reads company data through **adapters**: the work tracker, the knowledge source, the staff
directory and health checks. Adapters are compiled into the relay and chosen in its one config file.

| Adapter         | Default                                               |
| --------------- | ----------------------------------------------------- |
| Work tracker    | GitHub issues and pull requests, with leases (claims) |
| Staff directory | Members of your GitHub org                            |
| Knowledge       | A Git repository or folder of Markdown files          |
| Health          | The relay's own health; more sources by config        |

- **GitHub is the default for everyone.** To use something else, set that adapter to `none` or to another
  adapter in the config. To add an adapter, write one against the relay's adapter interfaces and build the
  relay with it.
- Adapter interfaces pass plain data and opaque ids. GitHub-specific types stay inside the GitHub adapters.
- Messages (channels and direct messages) are not an adapter. They always live in the relay's database.
- Banneret's own configuration is a preset that adds only its specifics: repositories, domains and health
  sources.

In the Task tab, the issue thread and composer are the work tracker's own panel. Edits there are made on
the tracker (GitHub by default) as you; the board's rules for claims and sign-off still apply.

**No UI code plugins.** Banneret Hub loads no third-party code into the app. A relay extends the app only
through:

- its capabilities document;
- data-only cards inside the fixed sections (board columns and labels, map lenses, health rows);
- agent tools it advertises over MCP;
- links out.

## Machines

An Enterprise workspace shows every machine the company runs agents on: people's computers, servers and
sandbox hosts. For each one it shows the owner, whether it is online, its Banneret Hub version, its policy
fingerprint and whether its sandbox is on. Later the relay can publish one signed policy and sandbox image
pins, which each machine fetches and applies itself.

- **The relay never runs anything on a machine** and never connects to one. Starting, steering and
  stopping agents stays with T3 Code's own pairing between your app and your machine.
- **No running agents on someone else's machine.** An Enterprise workspace refuses an agent link between
  machines owned by different people, so nobody's agents run on another person's machine or provider
  login. A colleague continues your work from a shared thread instead.
