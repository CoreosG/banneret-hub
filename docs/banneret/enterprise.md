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
  appears only when the relay offers it. When the relay offers chat, open **Channels** to join a channel, write a message, or reply in its thread. Use the plus beside **Direct messages** to choose recipients. A group can include eight people, including you. In a channel, choose All, Mentions or Nothing for desktop alerts. DMs always notify. Filter Needs you by Questions, Mentions or Reviews. Sending keeps the tab open. The unread line follows your own read position across machines.

## Shared machines

1. In your company workspace, open **Pool** and select **Request a workspace on a shared machine**
   under a staff host. The page shows your request status, host pressure, capacity and free sandbox slots.
2. A founder approves the request. The host administrator provisions your seat and gives you an SSH
   login and port. Your workspace then shows **Ready to join**.
3. From your desktop, forward that port and log into your seat. For example, for port 24101 use
   `ssh -o ExitOnForwardFailure=yes -L 127.0.0.1:24101:127.0.0.1:24101 alice@host`.
   Keep the session open while using the workspace.
4. In the seat shell run `banneret pair`. Open the printed app link in Banneret Hub desktop.
   In your company workspace open **Machines…**, choose **Join** beside the seat, sign in as
   yourself and confirm the displayed code. Select the seat environment when opening a project.
5. To let agents on your desktop use the seat, turn on **Linked environments** in the desktop
   host's Labs settings. In **Settings → Environments**, link from the desktop using **Another
   address**. Enter the forwarded address (for example, `http://127.0.0.1:24101`) and a fresh
   code from `banneret pair` on the seat. Choose the access you want to grant.
   Reconnect the SSH forward on future visits.

The Pool page appears when the company relay advertises it. Host readings are shared. Storage
and inode bars show only your own workspace. Administrators can follow the [host runbook](pool-host.md).

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

**Join a linked machine from your desktop.** Select the company workspace, open the switcher and choose
**Machines…**. Under **Your machines**, choose **Join** beside the server you want. Check the machine
and company in the wizard, then sign in from the desktop. You can change the target with the machine
picker. Return to **Machines…** to see each pending code, copy its details or leave from a joined machine.

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

For **A new sandbox**, Take opens a hand-off to your orchestrator before any claim. Open the thread for your place in line and pairing instructions. Your sandbox thread claims when the booking is running.

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

The Team list shows people, their agents and their claims. Helpers count under their lead. A waiting helper
makes the lead count as waiting. Claim chips say live, paused or quiet.

Team version 2 supplies the same facts for the planned Office, Floor and List views. Each board is one room.
You set your own presence (Available, Focusing, Away or Off), status line and chosen room. The relay keeps
these until you change them. Founders can set a meeting link for each room and the office. Links open in
your browser. The Hub hosts no calls.

Agents only is the default machine sharing choice. Sharing the machine name adds its name, kind and online dot
for colleagues. Hidden machines share no agents. Agent and machine heartbeat times describe those devices and
processes. Founders retain the machine list for administration.

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

A joined machine sends the relay agent facts, its sharing choice and usage every 30 seconds:

- the machine's name, kind, hostname, operating system and Banneret Hub version;
- for threads in Enterprise projects only, each session's state, branch, provider, model, times and a hash of
  the repository name;
- how much of each usage window your own Claude and Codex logins have used.

It never sends prompts, replies, code, thread titles, local paths or remote URLs. Colleagues see each shared session's state, provider and task, and the machine's name only when you share it. The Hub sends nothing about what you do. Your presence and status line are values you set yourself. Thread content leaves through explicit sharing or a chat post. Solo projects send nothing. See
[privacy.md](privacy.md) for the full notice.

When Enterprise chat is enabled, posted messages and agent handle names leave the machine. A tool call can post thread content. The relay stores chat in plaintext. The operator and anyone with a backup and its key can read channels and DMs. Each person's read position is private and has no timestamp. Agents may read their owner's DMs with people only after the owner opts in. Every participant sees which owners have opted in.

Mention an agent by its full handle or choose it under Direct messages. Other people's agents answer questions. Your own agent can take instructions. The agent's owner controls which messages wake its thread. Under Direct messages, **My agents can read my DMs** shares your people-only DMs with your agents. It starts off.

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

Choose **Launch a sandbox** on a Pool host, or use the same action in a board
task's menu to associate the booking with that task. Select the image and size.
The card shows your place in line and the time and idle limits. During startup,
pair and join the sandbox Hub from your own host login as described in the
[host guide](pool-host.md#sandbox-runner). Once running, select its environment
and open a project to start a thread. Extend a running booking when the line is
empty, or cancel it from the card. Push commits or copy files out before the
booking ends. Cleanup deletes the sandbox's local work.

With chat search enabled, press `/` and choose Search all messages to filter by channel, author, kind, linked task or date. Open a result to jump to the message. With posting enabled, choose Post to GitHub on a message, select the issue and confirm.

In Settings → Chat, **Use Banneret memory** turns off Claude and Codex memory in new
Hub sessions on the selected environment. It defaults to off. Hub memory tools
and the Memory line are available in either mode.
