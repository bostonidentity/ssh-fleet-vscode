# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [0.4.0] — 2026-06-17

### Added
- All "Download" right-click outputs (single file, multi-server, archive) now land in `<workspace>/download/` with `<base>_<server>_<ts><ext>` filenames — multi-server downloads sit side-by-side in one folder, and the timestamp suffix means re-downloads never silently overwrite previous copies.
- Real progress bars for remote file open / download / archive download — `mirror.download` now streams via SFTP read stream + pipe, emits byte-level progress events, and shows `12.4 MB / 50.0 MB (24%)` instead of a frozen-looking click.

### Changed
- Removed the cloud-download inline icon from server rows (still reachable via command palette).
- `Open file in editor` (push/pull-tracked) is unchanged; only the "Download…" menu items relocated.

### Fixed
- Ad-hoc command history (↑↓ arrow recall + "Run from History") no longer pollutes with navigation clicks, breadcrumb cd's, `lsRemoteDir`, recursive cd suffixes, or task runs — only operator-typed input from the Ad-hoc input box is recorded.

## [0.3.0] — 2026-06-17

### Added
- **Recent Connections** filter row — lists the last 10 servers connected this workspace, sorted by recency. Same icons / checkbox / right-click menu as the main server list. Bypasses the active filter so you can reconnect to a recently-used server even when filtered to a narrower env/module.
- Server tooltip shows `last connected: 5min ago` when there's a recorded connection.

### Fixed
- `Copy All` now copies the full output buffer instead of just the visible portion. Manual selection (Cmd+C / Ctrl+C) of off-screen lines also works again.

## [0.2.0] — 2026-05-13

### Added
- **Filter history per config** — env + module combos auto-captured into a `Recent` row above the servers list. Click to re-apply; pin to keep across the 10-item cap.
- **Server tooltip shows `environment` and `module`** from `meta` (in addition to groups).
- **Right-click a server → "Filter by Environment & Module"** sets the filter to that server's metadata.
- **Connected / connecting / error servers stay visible** even when the active filter would hide them.

### Changed
- `Connect Selected` and `Reconnect All Disconnected` now respect the active filter — they no longer reach into hidden servers.
- The active config row in the Task Files list is hidden when the config declares no `tasks:` block.
- Filter history only captures env + module combinations (text filter no longer pollutes the list); empty selections are skipped.

### Fixed
- Selection ↔ filter reconcile at activation — fixes a stale-selection bug where `Connect Selected` would silently resurrect hidden servers after a window reload.

## [0.1.0] — 2026-05-05

Initial release.

- Multi-server SSH management with TreeView, parallel command broadcast, and aggregated output.
- Remote file editing — direct via `ssh-fleet://` URI scheme, or via local mirror with explicit push/pull.
- Tasks (command / upload / script) loaded from the active config and from `<workdir>/tasks/*.yml`.
- YAML-driven config with legacy compat layer for `username` / `key_file` / `password: ENC(...)` / snake_case fields.
- Auth: key, password, SSH agent, keyboard-interactive (2FA / OTP).
- Host-key trust-on-first-use; auto-reconnect with exponential backoff.
- Safety: glob-based warn patterns, auto-backup wrap for destructive commands, dest-check pre-flight.
- File-backed state at `<workdir>/.ssh-fleet-state.json` so selection / filter / bookmarks / schedule / command history survive user-profile resets.
- Optional `preventSleep` keeps the workstation awake while operating SSH Fleet (caffeinate / systemd-inhibit / `python.exe` ctypes script).
