# Banneret Hub privacy notice

Banneret Hub is an unofficial fork of the T3 Code source code and is not affiliated with T3 Tools,
Inc. T3 Tools' privacy policy does not apply to it.

- **No product analytics.** Banneret Hub ships with telemetry off and no analytics key.
- **No hosted relay or account.** T3 Connect sign-in and relay are not configured; remote access is
  direct (LAN or Tailscale) between your own machines.
- **Your data stays on your machines.** Projects, threads and settings live in `~/.banneret` on the
  machine that runs the server.
- **A company relay, only if you join one.** A machine joined to a company's relay (an Enterprise
  workspace) sends that relay a heartbeat every 30 seconds: the machine's name, kind, hostname,
  operating system and version; for threads in that workspace's projects only, each session's
  state, branch, provider, model, times and a hash of the repository name; and how much of each
  usage window your own Claude and Codex logins have used. Never prompts, replies, code, thread
  titles or local paths. Everyone at that company can see each session's state, provider, machine
  and task, never its content. Solo projects send nothing, and a machine that has not joined, or has
  left, contacts no relay.
- **Third parties you choose.** Coding agents you connect (Codex, Claude Code, and others) send your
  prompts and code to their providers under those providers' terms.
- **Updates.** The app checks GitHub releases of `CoreosG/banneret-hub` for updates, which reveals
  your IP address to GitHub.

Operator-configured health sources can send alarm titles, details, links and timestamps to the
relay. Enrolled staff can read active alarms. Critical alarm notifications go to configured people
or, by default, founders. Alarm records and signing secrets stay out of GitHub. Opening a dashboard
contacts its configured HTTPS address in the system browser.

The Hub never records or shows human activity times or last-seen status. It shows agent session state and machine connectivity. Today keeps its previous visit boundary only on this device, per workspace. The relay filters shipped work using that timestamp and never stores it.

When Enterprise chat is enabled, posted messages and agent handle names leave the machine. A tool call can post thread content. The relay stores chat in plaintext. The operator and anyone with a backup and its key can read channels and DMs. Each person's read position is private and has no timestamp. Agents may read their owner's DMs with people only after the owner opts in. Every participant sees which owners have opted in.
