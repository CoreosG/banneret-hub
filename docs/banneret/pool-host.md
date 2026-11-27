# Join a Linux pool host

The host kit uses a dedicated ext4 data disk, XFS project quotas, cgroup v2 and systemd.
Run these commands from a root administrator shell on the approved shared machine.
The kit has its own executable under /opt so the member's Banneret Hub launcher stays available.
Each subcommand previews its action by default. Add `--apply` to execute it.

1. Install the distro packages for Python 3, python3-cryptography, xfsprogs, curl and util-linux.
   From the repository root install the kit and configure its host ID, installed Hub version,
   relay origin, local capacity and initial warning thresholds. For example, using jq and
   the example configuration for the staff host named dev:

   ```sh
   install -d /opt/banneret-pool
   install -m 755 scripts/banneret/pool/banneret /opt/banneret-pool/
   install -m 644 scripts/banneret/pool/{facts,provision,relay,sandbox}.py /opt/banneret-pool/
   install -m 644 scripts/banneret/pool/banneret-pool.service /etc/systemd/system/
   jq --arg origin https://relay.example.org --arg host dev --arg version 0.1.1300 \
     '{origin:$origin,hubVersion:$version,limits:(.hosts[]|select(.id==$host)),sizes:.sandboxes.sizes,warnings}' \
     docs/banneret/relay-v1/examples/pool-config.json > /etc/banneret-pool.json
   cd /opt/banneret-pool
   ```

2. Mount the dedicated ext4 data volume at /srv/banneret-data and configure that volume to mount at boot.
   Choose an image size that fits its available space. For a 256 GiB image:

   ```sh
   ./banneret pool filesystem 256G
   ./banneret pool filesystem 256G --apply
   ```

   For boot persistence add the following entry once to /etc/fstab. Verify it with
   `findmnt --verify` and reload systemd. The kit checks the backing image and quota
   mount options before provisioning a seat.

   ```fstab
   /srv/banneret-data/member-homes.xfs /srv/banneret-homes xfs loop,prjquota,nodev,nosuid,x-systemd.requires-mounts-for=/srv/banneret-data 0 0
   ```

3. Run `./banneret pool join --apply`. Give the displayed pairing URL and code to the
   founder. In the company workspace the founder opens **Offer a machine**, matches the pairing ID
   from the URL, and enters the code. The command polls until confirmation and saves the host credential in
   /var/lib/banneret-pool. An interrupted join resumes with the same key.

4. Run `./banneret pool agent --once --apply` and inspect /var/lib/banneret-pool/policy.json.
   Then run `systemctl daemon-reload` and `systemctl enable --now banneret-pool.service`.
   The agent sends full snapshots every 30 seconds. Host memory totals come from
   /proc/meminfo and user.slice. A workspace row contains quota meters and warning flags.
   The agent advertises zero free sandbox slots until the sandbox runner is configured.

5. After the founder approves a workspace request, install the verified Banneret Hub runtime for this host's architecture
   in a root-owned directory under /opt and link its executable (t3 in the release archive)
   as /usr/local/bin/banneret. Verify that an ordinary account can run its --version command.
   Reserve an unused login, UID and loopback TCP port in the site's seat range (20000 to 29999).
   Keep these ports reserved for seat services. Each seat slice can bind only its own
   TCP port within this range. Other ports remain available for member development servers.
   The founder can enter these values beside the approved request to display your exact command.
   For example, run `./banneret pool seat p_alice alice 24001 24101`, then
   `./banneret pool seat p_alice alice 24001 24101 --apply`. The UID doubles as the project number
   on this dedicated image. The command applies the returned workspace ceilings, including
   the disk hard limit, creates the OS account, and starts banneret-seat-24001.service in user-24001.slice.
   The service has the member's UID, home and relay identity. Its poolHostId is the
   host ID from the policy. Check the unit with `systemctl status banneret-seat-24001.service`.
   Once it starts, the next host report publishes the seat as ready to join.
   Give the member their SSH login, host address and assigned port. The member signs
   into Claude, Codex and Banneret Hub from their own account.

To exercise the kit in a checkout, install workspace dependencies and run
`/usr/bin/python3 scripts/banneret/pool/test_pool.py`. The tests inject the OS command runner,
use temporary Linux fixture trees and enrol against the loopback fake relay.

## Sandbox runner

Enable the runner only on a host validated by the M5 runtime spike. Install
`sandbox.py` alongside the agent. Each participating member needs a provisioned
seat, a running systemd user manager, rootless Podman with runsc, subordinate UID
and GID ranges, and a quota-capable container store inside their own home.
Preload the approved image by digest into each participating member's store.
It must contain the Banneret Hub executable and Node with node:sqlite support.

In the root-owned host config, set `runner.images` to a map from approved SHA-256
digests to fully qualified repository names. Copy `runner.time_limit` and
`runner.idle_limit` from the relay's sandbox configuration. The agent checks the
signed request against that local image map. It uses the member's systemd user
manager to run the container and publishes the Hub on a loopback port. Each
booking has its own writable container layer. No host home is mounted inside.
The idle timer uses only the presence of an active sandbox turn. It sends no
activity sample to the relay. A cleanup failure reserves the slot for inspection.

From the member's SSH login, find the container with
`podman ps --filter label=banneret.sandbox=SANDBOX_ID`. Use
`podman port CONTAINER 3793/tcp` to find the host loopback port. Forward
desktop port 3793 to that host port, then run `podman exec CONTAINER banneret pair`
and open its link on the desktop. Join the sandbox environment to the same
company and sign in as the requesting member during the three-minute startup
window. The Pool card shows its machine ID when enrolment completes.

For members without managed workspace seats, set `runner.accounts` to a map
from relay person IDs to their dedicated OS logins on this host. After correcting
a cleanup failure, stop the agent and run `banneret pool cleanup SANDBOX_ID
OFFER_ID --apply` using the kit executable. Restart the agent. Cleanup verifies
container removal before releasing the slot.
