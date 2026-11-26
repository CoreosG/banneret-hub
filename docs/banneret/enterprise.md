# Workspaces and the relay

This page describes where Banneret Hub is heading for teams. Joining a relay, Today and Needs you are
built; the other team sections are not yet. It records the design decisions so contributors and other companies know what to expect.

## Workspaces

The sidebar groups projects into **workspaces**. A workspace is a named scope over the projects you already
have.

- **Solo** (the default, called "Personal"): plain T3 Code. It never contacts a relay.
- **Enterprise**: joined to a **relay** that your company runs. It adds Today, Needs you, Board, Map,
  Knowledge, Channels and direct messages, and Team.

**Today and Needs you.** Once this machine has joined, the Enterprise workspace shows Today and Needs you
above the thread list, if the relay offers them. Today lists what needs you, what shipped since your last
visit, who is working now, what is stuck and how things are. An item that belongs to a thread opens it when
that thread is on a machine this app knows; otherwise it says which machine holds it. When the relay cannot
be reached, both keep showing what the relay last said, with its age.

**Joining.** Create a workspace and choose Enterprise. Enter the relay's address (https only), check the
company name, and join. Banneret Hub shows a short code and opens the relay's sign-in page in your browser,
where you sign in and type the code. A person new to the company then waits for a founder to approve. The
whole machine (this Banneret Hub server) joins once, whichever workspace is active; an environment that has
not joined never contacts a relay. The switcher shows the machine's status, the company's machines, and
Leave. Leaving tells the relay; if the relay cannot be reached you can forget the machine here instead, and
a founder must then remove it on the relay. The same way out applies when a founder has approved the machine
but setup cannot finish.

Enterprise is **Banneret-only for now**. The relay it talks to is Banneret's own and is not yet published
(see [The relay](#the-relay)). Solo is the full product for everyone else today.

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
  company's GitHub org. Banneret hosts no relays for other companies.
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
