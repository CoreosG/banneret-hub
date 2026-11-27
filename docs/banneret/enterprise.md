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

**Joins in progress.** You can start a second join while the first still waits. The switcher lists every join
that is not finished yet, each with its own status and code, for example "Waiting for sign-in · code
ABCD2345". Pick one to get back to its join screen.

**Copy details.** The join screen has a quiet "Copy details" link. It copies the relay address, the pairing id,
the environment id, the hostname and the Banneret Hub version. These are what the relay's `pairings list`
shows, so support can find your join.

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

**Today** lists what needs you, what shipped since your last visit, which agents are working, what is stuck and how
things are. **Needs you** is the full list of items waiting on you, most urgent first. An item that belongs to a
thread opens it when that thread is on a machine this app knows. Otherwise it tells you which machine holds it.

The Hub never records or shows human activity times or last-seen status. It shows agent session state and machine connectivity. Today keeps its previous visit boundary only on this device, per workspace. The relay filters shipped work using that timestamp and never stores it.

A stuck item can have several reasons. They are shown most important first.

### Board

A company can have **several boards**, for example one per team. The relay's settings list them; the Hub does not
find them on its own. When there is more than one, a selector in the Board header picks one and shows each board's
size. The Hub remembers the last board per workspace in this browser. With one board there is no selector. A task
is the same task on every board that shows it, with the same claim.

A board has five columns: Free, Taken, Validating, Stuck and Shipped. Each card shows a status mark, a short
plain reason for that status, the pull request and its checks, and who holds the claim. An empty column shrinks to
a narrow strip with its name and 0, so the others get more room.

A task is **Taken** when someone holds a claim on it or is assigned to it, and **Free** when nobody is. A task
assigned without a claim says "assigned · not claimed" with the assignee's login. Anyone may still take it.

**Mine** shows the tasks you hold or are assigned on the board you are looking at, with how many there are and how
many of your claims expired. It stays on when you switch boards.
When one of your claims has expired or stopped half way, a strip says so. **Review your expired claims** shows
only those, each with its Release button (or Finish and Withdraw for one that stopped half way).

A claim is a **lease**. Its chip says **live** while the latest signal is within the stale window, **quiet** when stale, or **paused** for a paused lease. Expiry and conflicting claims have their own warning. It stays active while its holder works: pushes, comments and their own running agent
sessions all count. By default a lease turns **stale after 6 hours** without a signal, and the card moves to Stuck. It
**expires after 24 hours**. Operators can change both clocks in the relay config. An expired lease stays in Stuck. It is not shown as Free until the claim is released
on the work tracker. A coworker's agent on the same task never refreshes someone else's lease.

**Filters** narrow the board you are looking at: a text box (title, repository and number, people, status), and
Repo, Person (who holds the claim or is assigned) and Status. **Clear filters** removes them all. The board and its
filters are part of the page address, so a link, a reload or a tab keeps them. Opening Map from the sidebar restores the view and selection last chosen in that workspace during this window's session. The Hub also remembers the last
filters of each board, and of the Map and the Feed, for as long as the window is open. Opening the page again from
the sidebar brings them back. A link that names its own filters wins, and **Clear filters** forgets them.

Validating shows which GitHub approvals each open pull request still needs and whether you can
approve. Open the task to see the base branch and its review rule. When approval alone holds up
a merge, Needs you lists the pull request for eligible reviewers and shows the author that it
is waiting for an approver.

Checked is a separate company label after merge. A sign-off role holder can add it after checks
pass, including someone who reviewed the pull request. Merge approvals follow the repository's
own branch protection, rulesets and CODEOWNERS.

### Take and release

Choose **Take** from a board card or its Task tab. Any of your joined machines can claim, even without a checkout. The picker defaults to this machine. The selected machine uses its GitHub login to add a claim comment, assign you and label the issue `claimed`. The login must match your company identity and have triage access. The Hub waits about ten seconds and reads back the issue. The first valid claim wins. Edited claim and release comments do not count.

A successful Take sends the task to your orchestrator. Choose **Open** to follow it, or check **Just claim it** before confirming to skip the message. You can choose where to work later or ask your agent to move an ongoing task to another machine.

Each machine remembers one main orchestrator per company and one project orchestrator per project in that company. Use the thread menu to designate a thread, retire the main orchestrator, demote a project orchestrator, or choose a replacement. The company sidebar pins the main thread above Today and marks project orchestrators beside their titles.

| State on the selected machine                  | Event                     | Result                                                                                                                            |
| ---------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Any                                            | Set or clear a role       | Replace or remove that role in this machine's workspace file.                                                                     |
| Matching project orchestrator                  | Take                      | Send the task and last hand-off to that project thread with `banneret_start_task`.                                                |
| Main orchestrator only, or no matching project | Take                      | Send to the main thread with `banneret_route_task`.                                                                               |
| Neither role can receive the task              | Take                      | Create a No project main thread with the person's default model and send there.                                                   |
| Any                                            | Just claim it             | Claim the issue and skip the message.                                                                                             |
| Designated thread                              | Settle, archive or delete | Clear every role held by the thread on this machine.                                                                              |
| Thread moved outside its workspace             | Next Take                 | Skip the invalid designation and use the next destination.                                                                        |
| Restart                                        | Open workspace            | Read roles from local state and the lease from GitHub. Pending sends already accepted by the inbox follow normal thread delivery. |

**Release** asks for a reason and an optional note (Goal, Done, Next). Turn on **Free to continue** to leave the
task for someone else. It is on by default for Blocked, Handing over and Out of usage. Such tasks sit at the top
of Free with your name and reason, and **Continue** shows your note before it takes the task.

If a step fails half way, the task shows **Finish** and **Withdraw**. You need triage access to the repository,
and the tracker login must be the one the relay knows. When either is missing, the Hub says so and writes
nothing.

**Agents take tasks too.** Coding agents in your company's threads get tools for the board and for leases, and
follow the same rules as these buttons. Paste one line into each repository's agent instructions. See
[Agents and leases](agents.md).

### Map and Rests-on

The Map shows the build in stages. Each item has a status, and each item can rest on other items. If something
an item rests on needs you, was sent back or was ruled dead, the item that rests on it is blocked, and the
reason names the blocker. The map is drawn from a [stage plan](#the-stage-plan). If the plan is broken, the Map
says so. It never shows a broken plan as an empty one.

The Map has three views. The view, the stage or item you picked and the filter are part of the page address,
so a link, a reload or a tab keeps them. Opening Map from the sidebar restores the view and selection last chosen in that workspace during this window's session.

- **List** shows one row per stage on a line that marks progress. The current stage is the first one that is
  not fully built. A later stage that is already built keeps its check, but the line does not fill through it:
  it was built ahead of an earlier stage. The text box hides the items that do not match, and the stages left
  empty.
- **Stages** draws each stage as a bubble, in plan order. A bigger bubble holds more items. The ring shows how
  many items are in each status, and each dot is one item. Lines join stages whose items rest on each other.
  A line turns amber while something on it blocks. Hover or focus a bubble for its full name. Select a bubble or its entry in the stage legend to see its items.
- **Neighbourhood** shows one item in the middle. What it rests on is on the left and what rests on it is on
  the right, two steps each way. Arrows point from a blocker to the item waiting on it. An amber arrow means
  the blocker needs you, was sent back or was dropped. A dashed amber arrow means the blocker is itself
  blocked. The small round button at a node's outer edge shows the next step out, and pressing it again hides
  that step. The target button puts that node in the middle. A node with a task opens the task. The
  Neighbourhood view appears only when the relay offers rests-on.

Picking an item in the List, in a stage, in search or in a task's **Rests on** opens its neighbourhood. If the
relay does not offer rests-on, an item with a task opens the task instead.

### Feed and Graveyard

The **Feed** is the company's activity, newest first: claims taken and released, expired leases, pull requests
opened and merged, and tasks built, checked or sent back. The **Graveyard** lists tasks ruled dead, each with
the reason. A task never sits there without one. A text box narrows the entries already loaded.

### Team

**Team** answers "who is working on what right now". It is the first page to open when you join a company.

- **One row per person:** their role, their machines with a dot for online or offline, the tasks they hold a
  claim on, and their live agents counted by state.
- **Four states, most urgent first:**
  - **Needs you:** one of your own agents waits on your permission or your answer.
  - **Waiting on someone else:** another person's agent waits on them.
  - **Not heard from:** the agent's machine has gone quiet for 90 seconds. It is drawn grey and dashed, never as
    stopped, because the agent may still be running.
  - **Working:** a run is going.
- **Helpers count under their lead.** A lead session takes the most urgent state among its helpers, so a helper
  waiting on a permission makes its lead "waiting". An idle agent, one that finished its turn and waits for a next
  message, shows only when you expand the person.
- **Expand a person** to see the working tree: each lead agent, the helpers under it, and the task each one works
  on, with its machine and how long it has been in its state. A task opens in the Task dialog. A claim chip opens
  its task too.
- **Find a person** filters by login, role, machine, or a task they hold or work on. The filter and the expanded
  person are part of the page address. In `/` search, an exact login or the start of a login puts the person first.

The page uses only what the relay already sends: the relay's team file for people and sessions, its machines list,
and the boards for claims and task titles. It makes no tracker call and never checks a claim, so opening it costs
nothing. When the relay cannot be reached, it keeps showing what the relay last said, with its age.

Two people with several machines each is the shape Banneret runs. A larger company sees the same page with more
rows; the filter is there for that.

### Search

Press **/** anywhere outside a text box to search the company: the cards of every board, the Map's items, the
Feed's entries and the people on Team, grouped by kind. The **Search** button at the top of each company page and "Search the company…"
in the command palette open it too. The key is the one your keyboard layout types `/` with, AltGr included. Use the arrow keys and **Enter** to open a result. A card or an item with a task
opens in the Task tab. A Map item opens its neighbourhood on the Map (without rests-on: its task, or the Map
filtered to it), and a Feed entry without a task opens its link. A person opens on Team, expanded. Search looks only at what the Hub already holds, so it asks the relay for nothing.

### The Task tab

Opening a task shows its status, who holds it, when it opened and closed, every linked pull request and its
checks, its stage on the Map, its preview when there is one, who checked it, what it rests on, and the last
release with its note. The stage and each item it rests on open that item's neighbourhood on the Map. Below that is the work tracker's own issue thread and composer.

**Edits there are made on GitHub as you.** (It says the tracker's name, which is GitHub by default.) They use
your own login, and the board's rules for claims and sign-off still apply. If none of your projects here is on
that tracker, the tab shows one row that links to the issue instead.

### The open tabs bar

A bar above the main view keeps your open threads and workspace pages (Today, Needs you, Board, Map, Feed, Team)
as tabs. A page tab keeps the page's board and filters.

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

It never sends prompts, replies, code, thread titles, local paths or remote URLs. Everyone at the company sees
each session's state, provider, machine and task on the Team page, never its content. Thread content leaves through explicit sharing or a chat post. Solo projects send nothing. See
[privacy.md](privacy.md) for the full notice.

When Enterprise chat is enabled, posted messages and agent handle names leave the machine. A tool call can post thread content. The relay stores chat in plaintext. The operator and anyone with a backup and its key can read channels and DMs. Each person's read position is private and has no timestamp. Agents may read their owner's DMs with people only after the owner opts in. Every participant sees which owners have opted in.

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
  The Board, Map, Feed, Graveyard, Team and Task screens appear only when the relay offers them.
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
your work tracker and config. Alarm history, channels, direct messages and shared threads exist only in the relay's
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
| Health          | Off until the operator configures sources             |

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

### Today integrations

Health appears when the operator enables a source. Each check names its source and kind.
Signed webhook alarms appear with their severity until resolved. Critical alarms also appear
in Needs you for founders or configured recipients. Dashboard links open in the system browser.
The [relay contract](relay-v1/README.md#optional-health-sources-dashboards-and-alarms) describes configuration and payloads.

## Shared machines

Each member has a separate OS account and signs in to Claude, Codex, Git and Banneret Hub in that account.
Their sandboxes run as that user. The admin of this machine can read everything on it.

Your desktop reads live resource measurements directly from your workspace Hub over the linked machine.
The relay shows you your disk and inode quota and warning flags. Other members can see host pressure.
