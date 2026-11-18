# Local Computer

The Local Computer is the resident Daemon on a user's machine, its
`linger-computer` control CLI, the outbound Runner Gateway transport, and the
workspace grants. Both programs are Go binaries built from `local-daemon/`; the
release bundle also ships a pinned Node runtime for the `teamhub` CLI and the
managed Computer tools.

## Install

Install from the Computers page of the Linger Web app, or run the installer
the Web origin serves. On macOS and Linux:

```bash
curl -fsSL "http://localhost:3000/install/linger-computer.sh" | bash
linger-computer login
```

On Windows, in an ordinary (non-elevated) PowerShell:

```powershell
irm "http://localhost:3000/install/linger-computer.ps1" | iex
linger-computer login
```

`linger-computer login` authorizes the computer in the browser and starts the
Daemon. A server connection token from the Web app works too:
`linger-computer login --token-stdin`. Then use `linger-computer daemon status`,
`linger-computer runtime check <codex|claude|pi>`, and `linger-computer doctor`;
`linger-computer --help` lists every command.

### Computers from before the Linger rename

A Computer installed by the Simplex-era installer (`simplex-computer-<environment>`,
versions 0.43 to 0.50) cannot update itself to Linger. The macOS and Linux
installer converts it once, in place, when it finds one:

- It converts the Simplex Computer installed from the same Web origin, or the
  one whose existing credential the Web origin's Runner Gateway accepts (HTTPS
  origins only; the probe closes the connection before `runner.hello`). For any
  other Simplex Computer it stops before changing anything and asks for
  `LINGER_COMPUTER_MIGRATE_FROM=simplex-computer-<environment>` to convert it or
  `LINGER_COMPUTER_MIGRATE_FROM=none` to install a separate new Computer.
- It never converts when this environment already has a Linger launcher or
  enrollment, when `LINGER_COMPUTER_DATA_DIR` or `LINGER_COMPUTER_CONFIG` is
  set, or during the Daemon's self-update.
- It refuses while an Agent Operation runs, stops the Simplex Daemon with its
  own launcher, and installs the Linger bundle into the Simplex install root,
  which the new `linger-computer-<environment>` launcher then names. `config.json`,
  the credential and `state/` stay byte-identical, so the Computer keeps its ID
  and Agents; the root keeps its `simplexai` path because Codex and Claude Code
  session stores and Context views record absolute paths under it.
- A Simplex Daemon that was running is replaced by the Linger Daemon, which must
  reconnect, reconcile, and report the same Runtimes and Agents ready within
  30 seconds. Then the installer deletes the Simplex bundles, upgrade markers, launcher, and (once no Simplex
  environment is left) the `simplex-computer` dispatcher. Any failure before
  that restores the Simplex installation and restarts its Daemon.

The Simplex CLI installed no system service, so there is none to replace.
Windows Simplex installs are not converted yet.

Conventions and boundaries are in [AGENTS.md](./AGENTS.md).
