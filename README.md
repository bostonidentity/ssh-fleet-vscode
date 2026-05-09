# SSH Fleet

A Visual Studio Code extension for managing multiple SSH servers from inside the editor — interactive terminals, running the same command on a group of servers, remote-file editing via SFTP, and a YAML-driven config you commit to git.

Built on standard VS Code APIs (TreeView, Pseudoterminal, OutputChannel, QuickPick, FileSystemProvider, SecretStorage). The aggregated "console" panel is a Webview using VS Code theme variables so light/dark themes both look native. Connections use the `ssh2` library to talk to standard OpenSSH servers — no custom server-side software required.

## Install

**From VS Code Marketplace** (recommended):

```
ext install BostonIdentity.ssh-fleet-vscode
```

Or search for **"SSH Fleet"** in VS Code's Extensions view (`Cmd+Shift+X` / `Ctrl+Shift+X`).

**From source** (for development or sideloading a pre-release build):

```bash
git clone <this-repo>
cd ssh-fleet-vscode
npm install
npm run build
# F5 in VS Code to launch an Extension Development Host
```

The published VSIX works on macOS / Linux / Windows from the same artifact — native crypto bindings are excluded so `ssh2` falls back to its pure-JS implementation.

## Quick start

1. Click the **SSH Fleet** icon in the Activity Bar.
2. **First-run wizard**: pick a working directory — this is where all configs, downloaded files, and the host-key trust store live. Three options:
   - Reuse `~/.ssh-fleet` (offered if it already has content)
   - Create a new folder (default: `~/SSH Fleet`)
   - Pick an existing folder
3. The wizard scaffolds the layout and a `default.yml` config. Edit it via **Open Config File**, or drop existing YAML configs into `<workdir>/config/`.
4. Reload (auto on save) → TreeView populates → hover a server row and click the **terminal icon** (or run `SSH Fleet: Open Terminal` from the Command Palette). The first connection prompts for host-key verification and any required password / 2FA codes.

### Working directory layout

```
<workdir>/
├── config/
│   ├── default.yml        # active config (controlled by .last_config)
│   ├── docker-test.yml    # alternative configs — switch via "Switch Active Config…"
│   └── .last_config       # plain-text basename of the active config
├── tasks/
│   └── *.yml              # task library, all loaded; same-name overrides inline
├── mirror/
│   └── <server>/<path>    # downloaded remote files (Finder-browsable)
└── known_hosts.json       # host-key trust store
```

**Migrating an existing YAML config?** A best-effort compatibility layer accepts common alternate field names so a legacy config can be dropped in unchanged: `username` → `user`, `key_file` → `auth.keyPath`, `server_warn_patterns` → `serverWarnPatterns`, `user@host:port` shorthand strings, `environment`/`module` → server `meta`. Legacy `password: ENC(...)` placeholders from a deprecated master-password scheme are detected and rerouted to per-server `passwordRef` — the extension prompts you on first connect, and the new password lands in the OS keychain via VS Code's `SecretStorage`.

## Features

| Capability | What it gives you |
|---|---|
| **Interactive Terminal** | A reusable SSH shell channel per server in a native VS Code Terminal tab. Tab completion, ANSI colors, vim/top/tmux all work because we use `client.shell()` with a real PTY. |
| **Run on Multiple Servers** | QuickPick multi-select → run the same command across N servers in parallel. Output is streamed to a single OutputChannel with `[server-name]` prefixes and per-server line buffering (no interleaving). |
| **Tasks** | Declarative tasks in YAML: `command` (run shell command), `upload` (SFTP write + chmod), `script` (upload + run + cleanup). Run on any subset of servers via QuickPick. |
| **Remote file editing — direct** | `ssh-fleet://<server>/<path>` URI scheme. Open any remote file in the editor with full language support. Save writes back via SFTP. mtime conflict guard warns if the remote was modified externally. |
| **Remote file editing — mirror** | Safer for production configs. **Download** a remote file into a local mirror; edit locally with zero network round-trips per save; **Push to Remote** (cloud-upload icon in editor title) when ready. Diff view on conflict. |
| **Mount remote folder** | Add `ssh-fleet://<server>/<path>` as a workspace folder — the entire remote tree shows up in the Explorer with normal cmd+P file-find. |
| **File upload** | Right-click any local file in the Explorer → **Upload Local File to Server…**. Tracks the upload in the mirror manifest so subsequent push/pull/diff work. |
| **Auto-reconnect** | TCP drops trigger 1s → 30s exponential-backoff reconnect (6 attempts). Explicit disconnect is honored. |
| **Aliases** | YAML-defined aliases (`ll: "ls -ltrah"`) auto-installed in every shell on connect. |
| **Auto-backup** | When the user types a destructive command (`rm`, `mv`, `cp`, `sed -i`, `> /path/file`), the extension wraps it with a best-effort `cp -a $TARGET $BACKUP_DIR/$(date)_<name>` prefix. Wildcards skipped with a warning. |
| **Dest-check** | Before `cp` / `mv` / `tee` / `>` runs, the extension stats the destination path on every target server; if it already exists, a modal asks for explicit overwrite confirmation (skipped per-server when the path is missing). |
| **Safety patterns** | Glob-pattern server tags (`*prod*` → label `PROD` color `#dc2626`). Renders as a colored emoji badge in the TreeView. Modal confirmation before any destructive command on a tagged server. |
| **Bookmarks** | Saved remote paths, available via QuickPick to insert into the active SSH terminal. |
| **Command history** | Per-server history in `globalState`. "Run From History…" QuickPick filters by server, dates, and content. |
| **Standalone task files** | Drop `*.yml` files into `<workdir>/tasks/` (the working-directory you set during the first-run wizard). Auto-loaded; same-name tasks override the active config's inline `tasks:` block. The Tasks tree groups rows by source file so you can see which file a task came from at a glance. |
| **Authentication** | Public key (with passphrase via SecretStorage), password (via SecretStorage), SSH agent (`SSH_AUTH_SOCK`), and **keyboard-interactive** for 2FA / Duo / SecurID / PAM-challenge servers. |
| **Host-key verification** | Trust-on-first-use prompt on first connect; refuses connection if the fingerprint changes (defends against MITM). Manage trusted hosts via the **Manage Known Hosts…** command. |

## Configuration

Configs live in `<workdir>/config/*.yml`. One file is active at a time —
switch via **SSH Fleet: Switch Active Config…** (writes the basename to
`.last_config` for next session). Set the workspace root via
`ssh-fleet.workspaceDir` setting or the **Setup Workspace…** command.

### Minimal example

```yaml
servers:
  - name: web-01
    host: 10.1.2.3
    user: deploy
    auth:
      type: key
      keyPath: ~/.ssh/id_ed25519
    groups: [prod, web]

  - name: dev-box
    host: 192.168.1.50
    user: dev
    auth:
      type: agent
    groups: [dev]
```

`auth.type` can be `key`, `password`, or `agent`. Keyboard-interactive (2FA / OTP) is automatic — the server requests it mid-handshake and we surface a VS Code input box.

### Auth examples

```yaml
# Key with passphrase (passphrase stored in keychain on first prompt)
auth:
  type: key
  keyPath: ~/.ssh/id_rsa
  passphraseRef: prod-key

# Password via keychain (extension prompts on first connect)
auth:
  type: password
  passwordRef: web-01-password

# Dynamic password / OTP / TOTP — never cached, prompts every connect.
# Use this when the "password" the server expects is actually a one-time
# code (RSA SecurID, Duo OTP, time-based code, etc.) — caching would
# always be stale.
auth:
  type: password
  cachePassword: false

# Config-wide default: every server in this file opts out of caching.
# Useful when the whole config is OTP-only.  Put this at the top level
# of the YAML, NOT inside auth:
#
#   settings:
#     cachePassword: false
#   servers:
#     - name: prod-1
#       auth: { type: password }       # inherits cachePassword: false
#     - name: dev-1
#       auth:
#         type: password
#         cachePassword: true          # this one DOES cache (override)
#
# Cascade order:  per-server  >  settings.cachePassword  >  default (true)

# SSH agent — uses $SSH_AUTH_SOCK
auth:
  type: agent

# Auto-detect key (no auth block at all):
# Tries ~/.ssh/id_ed25519 → id_rsa → id_ecdsa → falls back to agent
```

### Server shorthand strings

```yaml
servers:
  - "deploy@web-01.example.com"
  - "deploy@web-02.example.com:2222"
```

### Tasks

```yaml
tasks:
  # Plain shell command
  - name: uptime
    command: uptime
    timeout: 10

  # Upload a local file
  - name: deploy-script
    src: ./scripts/setup.sh
    dest: /usr/local/bin/setup.sh
    mode: "0755"

  # Upload + run + cleanup
  - name: rotate-logs
    src: ./scripts/rotate.sh
    args: "--keep 7"
    timeout: 60

  # Confirm before running destructive operations
  - name: restart-nginx
    command: sudo systemctl restart nginx
    confirmBeforeRun: true
```

Type is auto-detected: `src + dest` → `upload`, `src` alone → `script`, otherwise `command`.

### Aliases, bookmarks, safety

```yaml
aliases:
  ll: "ls -ltrah"
  ports: "ss -tulpn"

bookmarks:
  - /var/log/
  - /opt/app/

safety:
  serverWarnPatterns:
    - pattern: "*prod*"
      label: PROD
      color: "#dc2626"
    - pattern: "*staging*"
      label: STAGE
      color: "#eab308"
  autoBackup:
    enabled: true
    backupDir: /opt/backup
    commands: [rm, mv, cp, sed, ">"]
  destCheck:
    enabled: true
    commands: [cp, mv, ">"]
```

### Standalone task library

Drop `*.yml` files into `<workdir>/tasks/`. Each file may use a bare list **or** a wrapped `{ tasks: [...] }` form (both supported):

```yaml
# <workdir>/tasks/maintenance.yml
tasks:
  - name: disk-usage
    command: df -h
    timeout: 15
  - name: free-mem
    command: free -h
    timeout: 5
```

Override hierarchy (last wins by task name):

1. `tasks:` block in the active config (`<workdir>/config/<active>.yml`)
2. `<workdir>/tasks/*.yml` (task library)

The TreeView and Run Task command auto-refresh when you add, edit, or delete a task file.

## Commands

All commands are prefixed `SSH Fleet:` in the Command Palette.

### Connection
- **Connect**, **Disconnect**, **Disconnect All**
- **Open Terminal** (also: click the server name in TreeView)
- **Show Active Connections** (status bar click target)

### Files
- **Open Remote File…** — direct edit via `ssh-fleet://` URI
- **Mount Remote Folder as Workspace…** — browse the whole remote tree
- **Browse Files…** — combined file/folder picker
- **Download Remote File…** — start tracking; edit locally
- **Push to Remote** — appears in editor title for tracked files (☁⬆)
- **Pull from Remote** — refresh local copy with conflict guard (☁⬇)
- **Stop Tracking**, **Show Mirrored Files…**, **Reveal Mirror Folder in OS**
- **Upload Local File to Server…** — also via right-click on local files

### Run
- **Run Command on Server…** — single-server one-shot
- **Run Command on Multiple Servers…** — multi-select fan-out
- **Run Task…** — pick from configured tasks
- **Run From History…** — re-issue a previous command

### Workspace
- **Setup Workspace…** — first-run wizard (also runs automatically if unset)
- **Switch Workspace…** — re-pick the working directory
- **Switch Active Config…** — pick which `<workdir>/config/*.yml` is active
- **Reveal Workspace in OS** — open `<workdir>` in Finder/Explorer

### Config
- **Open Config File** — creates from template if missing
- **Reload Config**
- **Open Tasks Folder…** — opens `<workdir>/tasks/`
- **Add Server** — interactive wizard
- **Bookmarks…** — add / remove / insert into terminal
- **Manage Known Hosts…** — list / forget trusted host fingerprints

## Settings

| Setting | Default | Description |
|---|---|---|
| `ssh-fleet.workspaceDir` | `""` | Working directory holding `config/`, `tasks/`, `mirror/`, `known_hosts.json`. Empty = first-run wizard prompts. |
| `ssh-fleet.defaultTimeout` | `60` | Default command timeout (seconds, 0 = none). |
| `ssh-fleet.keepaliveInterval` | `30` | TCP keepalive interval (seconds) for active SSH connections. |

### Config-file `settings:` block

A few cross-cutting defaults live in the active config YAML rather than in
VS Code settings, so they ride along with the config and stay in git:

```yaml
settings:
  defaultTimeout: 60
  keepaliveSeconds: 30
  lsCommand: "ls -ltr"
  cachePassword: false           # config-wide opt-out of password caching
                                 # (per-server `auth.cachePassword` overrides)
  maxServersPerAction: 20        # hard cap on servers per single action;
                                 # 0 = unlimited (you accept the blast radius)
  maxFileOpenSize: 50            # MB; warn before opening files larger
                                 # than this in editor; 0 = no warning
  maxFileDownloadSize: 500       # MB; hard refuse click / `:dl` over
                                 # this; 0 = unlimited (raise at your own risk)
  archiveFormat: auto            # 'auto' | 'zip' | 'tar.gz' — controls the
                                 # right-click "Download as archive…" output.
                                 # 'auto' tries zip first, falls back to
                                 # tar.gz when `zip` isn't installed on the
                                 # remote. Set 'zip' to force (fails loudly
                                 # if zip is missing) or 'tar.gz' to force
                                 # the always-available format.
  archiveMinDepth: 2             # refuse to archive paths with fewer than
                                 # N segments. Default 2 blocks `/`, `/tmp`,
                                 # `/etc`, etc.; lower to 1 to allow first-
                                 # level dirs or 0 to disable the guard.
  shortenHostnames: true         # `[aaa.bbb.example.com]` output prefixes
                                 # display as `[aaa]` to save horizontal
                                 # space; full name kept on hover. IPv4/
                                 # IPv6 are never truncated. Set false to
                                 # keep the full hostname inline.
  preventSleep: false            # if true, prevents the LOCAL workstation
                                 # from sleeping while you're operating
                                 # SSH Fleet in this window — latches on the
                                 # first sign of use (TreeView visible,
                                 # first connect, or Console open) and
                                 # holds until the window closes. mac uses
                                 # caffeinate, Linux uses systemd-inhibit,
                                 # Windows spawns python.exe with a small
                                 # ctypes script (requires python.exe on
                                 # PATH on Windows).
```

`maxServersPerAction` defends against fat-finger Select-All on a large
fleet — the TreeView refuses ticks past the cap and the dispatch path
re-checks defensively. To run a one-off action on more servers, raise the
cap in the config file (deliberately no in-UI override).

`maxFileOpenSize` / `maxFileDownloadSize` defend against accidentally
clicking a 2 GB log or binary in `ls -l` output. Click-to-open also
refuses extensions that look binary (`.so`, `.tar.gz`, `.png`, `.pdf`, …)
unless you confirm a modal — those would render as garbage in the
editor. Raise the caps if you genuinely need to open / download larger
files; you accept the consequence (slow editor, RAM use, disk fill).

## Two file-editing models — when to use which

| | **Direct** (`Open Remote File`) | **Mirror** (`Download Remote File`) |
|---|---|---|
| Save | Each Cmd+S writes via SFTP | Each Cmd+S writes locally only |
| Network | Per save | Only on Push / Pull |
| Conflict guard | Modal warning before overwrite | Modal + diff view; pre-flight stat |
| Best for | Quick edits, exploration, log peek | Production configs, multi-step edits |
| Auto-save risk | High (each pause = SFTP write) | None |
| Underlying mechanism | `vscode.FileSystemProvider` | Local file + SFTP read/write on demand |

## Architecture

- **One ssh2 Client per server**, kept open until you disconnect
- **Three channel types** coexist on each Client: `shell` for interactive Terminal, `exec` for batch one-shots, `sftp` for remote files
- **TCP keepalive** (30s by default) keeps NAT/firewalls from killing idle sockets
- **Auto-reconnect** with exponential backoff handles TCP drops without losing the user's logical session
- **State** is kept in VS Code's `globalState` (command history, bookmarks, mirror manifest, known hosts). Sensitive values (passwords, key passphrases) go to the OS keychain via VS Code's `SecretStorage` API.

## Development

```bash
npm install              # install deps
npm run typecheck        # tsc --noEmit
npm run build            # esbuild bundle to dist/extension.js
npm run watch            # esbuild watch mode

npm test                 # vitest unit suites (no SSH needed)
npm run smoke:up         # bring up local docker sshd
npm run smoke            # run smoke harness against it
npm run smoke:down       # tear down

# F5 in VS Code → launches Extension Development Host
```

## License

MIT — see [LICENSE](LICENSE).
