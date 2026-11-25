<p align="center"><img src="../assets/prod/black-universal-1024.png" width="96" alt="Banneret Hub pennant logo"></p>

# Banneret Hub

> [!IMPORTANT]
> **Banneret Hub is an unofficial fork of the [T3 Code](https://github.com/pingdotgg/t3code) source code.** It is not affiliated with, endorsed by, or maintained by T3 Tools, Inc. Nearly all of the code is the T3 team's work, used under the MIT license (see [LICENSE](../LICENSE)). For the official app, support and the mobile apps, use [T3 Code](https://t3.codes). Bugs that also happen in T3 Code belong [upstream](https://github.com/pingdotgg/t3code/issues).

Banneret Hub is a personal build of T3 Code that installs **beside** official T3 Code without sharing anything with it:

|                   | T3 Code                   | Banneret Hub                                                             |
| ----------------- | ------------------------- | ------------------------------------------------------------------------ |
| Data folder       | `~/.t3`                   | `~/.banneret`                                                            |
| Command           | `t3`                      | `banneret`                                                               |
| App id            | `com.t3tools.t3code`      | `com.coreosg.banneret-hub`                                               |
| Updates from      | pingdotgg/t3code releases | [this repo's releases](https://github.com/CoreosG/banneret-hub/releases) |
| Product analytics | on by default             | off                                                                      |

It follows upstream **stable** releases: each new `vX.Y.Z` tag is merged into `main`, and a Banneret Hub release is built from it.

## What Banneret Hub adds

Planned:

- **Remote files, VS Code style:** drag files from your computer onto a folder in the file tree to upload them, drag inside the tree to move them, and right-click to download files or whole folders.
- **Ports panel:** every listening port on the connected machine in one place, with auto-forwarding and labels.
- **Tailscale-first connections:** no T3 Connect account needed.

## Install

Download the build for your platform from [Releases](https://github.com/CoreosG/banneret-hub/releases). Builds are unsigned for now:

- **Windows:** SmartScreen asks once; choose **More info → Run anyway**. The app updates itself.
- **Linux:** the AppImage updates itself.
- **macOS:** clear the quarantine flag once with `xattr -dr com.apple.quarantine "/Applications/Banneret Hub.app"`. Updates are manual until builds are signed.

Remote machines you open over SSH get the Banneret Hub server automatically. To run one by hand, install the `banneret` command from the release's `install.sh` / `install.ps1`.

## Maintaining the fork

See [docs/banneret/maintaining.md](../docs/banneret/maintaining.md).
