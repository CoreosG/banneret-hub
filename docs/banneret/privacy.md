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
  titles or local paths. Solo projects send nothing, and a machine that has not joined, or has
  left, contacts no relay.
- **Third parties you choose.** Coding agents you connect (Codex, Claude Code, and others) send your
  prompts and code to their providers under those providers' terms.
- **Updates.** The app checks GitHub releases of `CoreosG/banneret-hub` for updates, which reveals
  your IP address to GitHub.
