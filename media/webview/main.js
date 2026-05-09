// @ts-check
/* eslint-disable no-undef */
//
// SSH Fleet Console webview client.
//
// Owns: output rendering (block grouping, drillable paths), cwd breadcrumb,
//       command input, right-click menus on output, clickable paths.
//
// Does NOT own: server / task lists. Those live in the native TreeView; we
// only consume the resulting selection state from the extension.
//

const vscode = acquireVsCodeApi();

// `state` accumulates fields from `PanelStateSnapshot` via spread merge on
// every `init` / `state` message. The initial literal only seeds a few; the
// `@type {any}` opts out of TS narrowing so adding new snapshot fields on
// the extension side doesn't require touching this declaration.
/** @type {any} */
let state = {
  selectedCount: 0,
  connectedCount: 0,
  totalServers: 0,
  cwdCommon: undefined,
  cwdMixed: false,
  bookmarks: [],
  activeConfig: undefined,
  availableConfigs: [],
  archiveMinDepth: 2
};

let outputElem;
let cmdInput;
let runStatus;
let selectionStatus;
/** @type {any} */
let ctxMenu;

const lineMeta = new WeakMap();

const history = [];
let historyIdx = -1;
let historyDraft = '';

// Alias auto-suggest. Filled with `[{name, expansion}]` matching the first
// word the user is currently typing. Negative `selectedIdx` means no row is
// highlighted yet (Tab still completes against the longest prefix).
const aliasSuggest = {
  visible: false,
  matches: [],
  selectedIdx: -1
};

// Path completion suggest (Level 2 Tab). Filled by responses to
// `pathComplete` requests; rendered in a dropdown styled like the
// alias suggest but anchored to the current path token in the textarea.
const pathSuggest = {
  visible: false,
  matches: [],         // [{ name, isDir }]
  selectedIdx: -1,
  partial: '',         // path token being completed (e.g. `/etc/h`)
  tokenStart: 0,       // index in cmdInput.value where the token begins
  tokenEnd: 0,         // exclusive end (cursor pos at request time)
  reqId: 0             // increment per request; reject stale responses
};
let pathSuggestNextReqId = 1;

/**
 * Output is grouped into blocks — one per user command. A block has a coloured
 * header (cmd-input or cmd-warn) and a body where stream / info / header lines
 * accumulate until the next 'cmd' arrives or the panel is cleared.
 */
let currentBlock = null;

let filterTextDebounce = null;

// Flips true the first time the user manually clicks an ls-flag checkbox so
// later config-driven snapshots don't clobber their runtime preference.
let lsFlagsUserDirty = false;

// Upload row state — populated when user picks files via the extension-side
// open dialog. Lives in the webview so the dest input + exec checkbox can
// stay always-visible inline.
let uploadPickedPaths = [];
let uploadPickedNames = [];

/**
 * Multi-tab output state.
 * - `outputLog`: ring buffer of every received message (for replay on tab switch).
 * - `tabs`: active tab definitions, keyed by id. The 'main' tab is permanent.
 * - `activeTabId`: which tab's view is currently rendered into outputElem.
 */
const outputLog = [];
const MAX_LOG = 5000;
const tabs = new Map();
let activeTabId = 'main';
tabs.set('main', { id: 'main', label: 'Output', filter: () => true, warn: false });

document.addEventListener('DOMContentLoaded', () => {
  outputElem = document.getElementById('output');
  bindAutoFollowScroll();
  cmdInput = document.getElementById('cmdInput');
  // Header status spans were removed — getElementById returns null and the
  // assignments below stay null-safe via optional chaining at the call sites.
  runStatus = document.getElementById('runStatus');
  selectionStatus = document.getElementById('selectionStatus');
  ctxMenu = document.getElementById('ctxMenu');

  bindUI();
  renderTabBar();
  vscode.postMessage({ type: 'ready' });
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  // Coalesced batch from the extension (cuts postMessage IPC cost under
  // high-volume streams). Unpack and dispatch each item via the same
  // top-level switch — everything else is identical.
  if (msg && msg.type === 'outputBatch' && Array.isArray(msg.items)) {
    for (const item of msg.items) dispatchExtMessage(item);
    return;
  }
  dispatchExtMessage(msg);
});

function dispatchExtMessage(msg) {
  switch (msg.type) {
    case 'init':
    case 'state':
      applyState(msg.state);
      break;
    case 'output':
      appendOutput(msg);
      break;
    case 'outputClear':
      removeAllChildren(outputElem);
      currentBlock = null;
      outputLog.length = 0;
      // Drop any queued-but-unrendered messages too — they belong to the
      // run we're clearing. Section cache is a WeakMap keyed by block
      // elements; removed blocks GC their entries automatically.
      renderQueue.length = 0;
      break;
    case 'runStarted':
      if (runStatus) runStatus.textContent = `▶ ${msg.label} on ${msg.serverNames.length}`;
      showProgress(msg.serverNames.length);
      break;
    case 'runProgress':
      updateProgress(msg.doneCount, msg.failedCount, msg.totalCount);
      break;
    case 'runDone':
      if (runStatus) runStatus.textContent = `${msg.failed > 0 ? '✗' : '✓'} ${msg.label} (${msg.ok}/${msg.ok + msg.failed})`;
      hideProgress();
      setTimeout(() => { if (runStatus) runStatus.textContent = ''; }, 5000);
      break;
    case 'scheduleStatus':
      onScheduleStatus(msg);
      break;
    case 'aliasesList':
      onAliasesList(msg);
      break;
    case 'pathCompleteResult':
      onPathCompleteResult(msg);
      break;
    case 'commandCompleteResult':
      onCommandCompleteResult(msg);
      break;
    case 'uploadFilesPicked':
      // Append to the existing picked list rather than replacing — operator
      // can build up a multi-file batch across several picks (e.g. one
      // file from /tmp, another from ~/Downloads). Dedup by path so the
      // same file picked twice doesn't appear twice in the upload list.
      {
        const seen = new Set(uploadPickedPaths);
        const incoming = msg.paths || [];
        const incomingNames = msg.names || [];
        for (let i = 0; i < incoming.length; i++) {
          if (seen.has(incoming[i])) continue;
          seen.add(incoming[i]);
          uploadPickedPaths.push(incoming[i]);
          uploadPickedNames.push(incomingNames[i] ?? '');
        }
      }
      // Auto-show the upload row when files arrive — the operator may
      // have collapsed the row mid-pick; not popping it back open here
      // would land files into a hidden UI with no obvious feedback.
      if (uploadPickedPaths.length > 0) {
        document.getElementById('uploadRow')?.classList.remove('hidden');
      }
      renderUploadRow();
      break;
  }
}

/**
 * Render the upload row's picked-files list as a row of badges, one per
 * file, each with a per-item ✕ to remove just that entry. Tooltip on each
 * badge carries the full local path (the basename is enough on the
 * surface to keep the row scannable but not let huge paths overflow).
 * Empty state hides the clear-all button.
 */
function renderUploadRow() {
  const count = document.getElementById('uploadFileCount');
  const clear = document.getElementById('btnUploadClear');
  const dest = document.getElementById('uploadDest');
  if (!count || !clear || !dest) return;
  removeAllChildren(count);
  if (uploadPickedPaths.length === 0) {
    clear.classList.add('hidden');
    // Crucial: even when there are no files left, refresh the preview
    // so its previously-rendered "src → dst" lines disappear. Skipping
    // this leaves stale rows on screen after Clear / per-badge ✕ delete.
    renderUploadPreview();
    syncUploadToggleLabel();
    return;
  }
  // One badge per file. wrap on overflow via flex-wrap on .file-count.
  for (let i = 0; i < uploadPickedPaths.length; i++) {
    const badge = document.createElement('span');
    badge.className = 'upload-file-badge';
    badge.title = uploadPickedPaths[i];
    const name = document.createElement('span');
    name.className = 'upload-file-name';
    name.textContent = uploadPickedNames[i] || uploadPickedPaths[i];
    badge.appendChild(name);
    const del = document.createElement('span');
    del.className = 'upload-file-del';
    del.textContent = '✕';
    del.title = `Remove ${uploadPickedNames[i] || uploadPickedPaths[i]}`;
    const idx = i;
    del.onclick = (ev) => {
      ev.stopPropagation();
      uploadPickedPaths.splice(idx, 1);
      uploadPickedNames.splice(idx, 1);
      renderUploadRow();
    };
    badge.appendChild(del);
    count.appendChild(badge);
  }
  clear.classList.remove('hidden');
  // Helpful hint: if the operator just picked multiple files and the dest
  // doesn't end in `/`, append one — common-case automation.
  if (uploadPickedPaths.length > 1 && dest.value.trim() && !dest.value.trim().endsWith('/')) {
    dest.value = dest.value.trim() + '/';
  }
  renderUploadPreview();
  syncUploadToggleLabel();
  // Defer to next frame so the browser has laid out the new badges and
  // scrollWidth/clientWidth reflect reality.
  requestAnimationFrame(syncBadgeFade);
}

/**
 * Toggle fade-edge classes on the badges row to hint at horizontally
 * scrolled-out content. Three states:
 *   - has-overflow + not at end → fade right (more on right)
 *   - has-overflow + scrolled past start → fade left (more on left)
 *   - has-overflow + middle → both fades
 *   - no overflow → no fade
 */
/**
 * Reflect upload state on the toolbar toggle button:
 *   - hidden row, no files: "📎 Upload"
 *   - hidden row, N files queued: "📎 Upload (N)"  ← visual reminder
 *   - visible row: "📎 Upload" + .active class for selected styling
 */
function syncUploadToggleLabel() {
  const btn = document.getElementById('btnUploadToggle');
  const row = document.getElementById('uploadRow');
  if (!btn || !row) return;
  const isOpen = !row.classList.contains('hidden');
  const count = uploadPickedPaths.length;
  btn.textContent = count > 0 && !isOpen ? `📎 Upload (${count})` : '📎 Upload';
  // aria-pressed is the HTML toggle-button standard. CSS hooks off this
  // attribute, and screen readers announce "pressed / not pressed".
  btn.setAttribute('aria-pressed', isOpen ? 'true' : 'false');
}

function syncBadgeFade() {
  const fc = document.getElementById('uploadFileCount');
  if (!fc) return;
  const hasOverflow = fc.scrollWidth > fc.clientWidth + 1;
  const atStart = fc.scrollLeft <= 1;
  const atEnd = fc.scrollLeft + fc.clientWidth >= fc.scrollWidth - 1;
  fc.classList.toggle('fade-right', hasOverflow && !atEnd);
  fc.classList.toggle('fade-left', hasOverflow && !atStart);
}

/**
 * Render the live dest preview under the upload row. Shows the resolved
 * remote path for each picked file given the current dest input. When
 * dest ends in `/` (or there are multiple files), `<dest>/<basename>` is
 * computed and shown — confirms the auto-basename-append visually.
 */
function renderUploadPreview() {
  const preview = document.getElementById('uploadPreview');
  const dest = document.getElementById('uploadDest');
  if (!preview || !dest) return;
  // Tie preview visibility to the upload-row toggle. When the row is
  // collapsed, the preview must be too — otherwise the operator collapses
  // expecting to reclaim space and the "src → dst" lines stay rendered.
  const row = document.getElementById('uploadRow');
  if (row?.classList.contains('hidden')) {
    preview.classList.add('hidden');
    removeAllChildren(preview);
    return;
  }
  const trimmed = dest.value.trim();
  if (uploadPickedPaths.length === 0 || !trimmed.startsWith('/')) {
    preview.classList.add('hidden');
    removeAllChildren(preview);
    return;
  }
  preview.classList.remove('hidden');
  removeAllChildren(preview);
  const multi = uploadPickedPaths.length > 1;
  const cap = Math.min(uploadPickedPaths.length, 5);
  for (let i = 0; i < cap; i++) {
    const baseName = uploadPickedNames[i] || basenameOf(uploadPickedPaths[i]);
    const remotePath = multi || trimmed.endsWith('/')
      ? trimmed.replace(/\/+$/, '') + '/' + baseName
      : trimmed;
    const line = document.createElement('span');
    line.className = 'upload-preview-line';
    line.appendChild(document.createTextNode(baseName));
    const arrow = document.createElement('span');
    arrow.className = 'upload-preview-arrow';
    arrow.textContent = '→';
    line.appendChild(arrow);
    line.appendChild(document.createTextNode(remotePath));
    preview.appendChild(line);
  }
  if (uploadPickedPaths.length > cap) {
    const more = document.createElement('span');
    more.className = 'upload-preview-line';
    more.textContent = `…and ${uploadPickedPaths.length - cap} more`;
    preview.appendChild(more);
  }
}

/**
 * Refresh derived UI based on cmdInput's current value:
 *   - modifying-command warning border + ⚠ hint
 *   - alias auto-suggest dropdown
 *   - path-completion dropdown (hidden when text changes — re-Tab to refresh)
 *   - ad-hoc countdown reset (any keystroke counts as activity)
 *
 * Called from both the user-typed `input` event AND every programmatic
 * `cmdInput.value = ...` mutation (Run-clear, history nav, alias accept,
 * Tab-completion accept). The HTML `input` event does NOT fire on
 * programmatic value sets, so without this helper the modifying border
 * sticks after a destructive command is Run-then-cleared.
 */
function syncCmdInputState() {
  if (!adhocUnlocked) return;
  resetAdhocCountdown();
  const text = cmdInput.value.trim();
  const isModifying = text !== '' && detectModifyingClient(text);
  cmdInput.classList.toggle('modifying', isModifying);
  document.getElementById('modifyHint').classList.toggle('hidden', !isModifying);
  updateAliasSuggest();
  hidePathSuggest();
}

function showProgress(total) {
  document.getElementById('runProgress').classList.remove('hidden');
  document.getElementById('runProgressFill').style.width = '0%';
  document.getElementById('runProgressFill').classList.remove('has-failure');
  document.getElementById('runProgressText').textContent = `0/${total}`;
}

function updateProgress(done, failed, total) {
  const pct = total > 0 ? Math.round(((done + failed) / total) * 100) : 0;
  const fill = document.getElementById('runProgressFill');
  fill.style.width = pct + '%';
  fill.classList.toggle('has-failure', failed > 0);
  document.getElementById('runProgressText').textContent =
    `${done + failed}/${total}${failed > 0 ? ` (${failed}✗)` : ''}`;
}

function hideProgress() {
  document.getElementById('runProgress').classList.add('hidden');
}

function bindUI() {
  // (Config reload / edit moved to the CONFIGS sidebar view title bar.
  //  Help is reachable via the `:help` special command in the cmd input —
  //  the title-bar `?` button was removed to reclaim header space.)

  // Filter UI now lives in the Servers TreeView (sidebar) as inline rows —
  // see ServerTreeProvider. The main panel no longer hosts filter controls.

  document.getElementById('btnRunCmd').onclick = sendCommand;
  cmdInput.addEventListener('keydown', onCmdKeydown);
  cmdInput.addEventListener('input', () => autoGrow(cmdInput));

  document.getElementById('btnToggleTs').onclick = () => {
    outputElem.classList.toggle('hide-ts');
    vscode.postMessage({
      type: 'prefsSet',
      hideTimestamps: outputElem.classList.contains('hide-ts')
    });
  };
  // (Deselect-after-run is now toggled from the Tasks view overflow menu;
  //  the cmd-area checkbox was removed.)
  document.getElementById('btnCopyAll').onclick = () => {
    navigator.clipboard?.writeText(outputElem.innerText).catch(() => {});
  };
  document.getElementById('btnScrollBottom').onclick = () => {
    autoFollow = true;
    forceScrollToBottom();
  };
  document.getElementById('btnClear').onclick = () => {
    removeAllChildren(outputElem);
    currentBlock = null;
    outputLog.length = 0;
  };
  document.getElementById('btnCancelRun').onclick = () => {
    vscode.postMessage({ type: 'cancelRun' });
  };

  // Ad-hoc lock + 60-second auto-relock countdown.
  document.getElementById('adhocToggle').onchange = (ev) => {
    if (ev.target.checked) unlockAdhoc(); else lockAdhoc();
  };
  // Reset countdown whenever the user types — they're actively working.
  cmdInput.addEventListener('input', syncCmdInputState);
  // Hide suggestions on blur (with a small delay so click-to-accept lands).
  cmdInput.addEventListener('blur', () => {
    setTimeout(hideAliasSuggest, 150);
  });

  // Modal triggers.
  document.getElementById('btnSchedule').onclick = () => {
    openScheduleModal();
  };
  document.getElementById('btnAliases').onclick = () => {
    openAliasesModal();
  };
  // Upload row — picker is extension-side (showOpenDialog), all other
  // state (file list, dest path, exec flag) lives inline in the webview.
  document.getElementById('btnUploadFiles').onclick = () => {
    vscode.postMessage({ type: 'uploadPickFiles' });
  };
  // Toggle visibility of the upload row from the cmd toolbar — row is
  // hidden by default to save vertical space for the more-frequent
  // command runner. Toggle button label shows file count when there
  // are queued files so the operator doesn't lose track.
  document.getElementById('btnUploadToggle').onclick = () => {
    const row = document.getElementById('uploadRow');
    const opening = row.classList.contains('hidden');
    row.classList.toggle('hidden');
    syncUploadToggleLabel();
    if (opening) {
      // Re-evaluate preview based on current state (will show "src → dst"
      // lines if files are still queued from before the collapse).
      renderUploadPreview();
      requestAnimationFrame(() => syncBadgeFade());
      const dest = document.getElementById('uploadDest');
      if (uploadPickedPaths.length > 0) dest?.focus();
    } else {
      // Collapsing: also stash away the preview so the operator gets
      // back the vertical space they were expecting.
      document.getElementById('uploadPreview')?.classList.add('hidden');
    }
  };
  document.getElementById('btnUploadClear').onclick = () => {
    uploadPickedPaths = [];
    uploadPickedNames = [];
    renderUploadRow();
  };
  // Re-render the dest preview as the operator types so they can see
  // exactly where each file will land before clicking Upload.
  document.getElementById('uploadDest').addEventListener('input', renderUploadPreview);
  // Update fade-edge hints as the operator scrolls the badges row, so
  // the gradient masks accurately reflect "more content on this side".
  document.getElementById('uploadFileCount').addEventListener('scroll', syncBadgeFade);
  document.getElementById('btnUploadGo').onclick = () => {
    if (uploadPickedPaths.length === 0) {
      flashStatus('Pick file(s) first via 📎 Files');
      return;
    }
    if (state.selectedCount === 0) {
      flashStatus('Tick at least one server in the sidebar first');
      return;
    }
    const dest = document.getElementById('uploadDest').value.trim();
    if (!dest) {
      flashStatus('Enter a remote destination path');
      return;
    }
    if (!dest.startsWith('/')) {
      flashStatus('Destination must be an absolute path (start with /)');
      return;
    }
    // Note: no client-side check for "multi-file needs trailing /". The
    // extension stat()'s the dest per-server and treats `/home/admin`
    // (existing dir) the same as `/home/admin/`. Failing servers get a
    // pointed error from the prep phase.
    const exec = document.getElementById('uploadExec').checked;
    vscode.postMessage({
      type: 'uploadAdhoc',
      paths: uploadPickedPaths,
      dest,
      exec
    });
    // Don't auto-clear the form — operator might want to upload to a
    // sibling path next, with the same files. Click ✕ when done.
  };
  document.getElementById('modalClose').onclick = closeModal;
  document.getElementById('modalBackdrop').addEventListener('click', (ev) => {
    if (ev.target === document.getElementById('modalBackdrop')) closeModal();
  });

  document.getElementById('btnHome').onclick = () => navigateToDir('~');
  // Copy current cwd to clipboard. Disabled when nothing is selected or
  // selections have mixed cwds — there's no single path to copy in those
  // cases. Brief "✓" feedback on the button confirms the copy landed.
  const btnCopyCwd = document.getElementById('btnCopyCwd');
  btnCopyCwd.onclick = async () => {
    const cwd = state.cwdMixed
      ? null
      : (state.selectedCount === 0 ? null : (state.cwdCommon || '~'));
    if (!cwd) return;
    try {
      await navigator.clipboard.writeText(cwd);
      const orig = btnCopyCwd.title;
      btnCopyCwd.classList.add('copied');
      btnCopyCwd.title = `Copied: ${cwd}`;
      setTimeout(() => {
        btnCopyCwd.classList.remove('copied');
        btnCopyCwd.title = orig;
      }, 1200);
    } catch { /* clipboard denied — silent; user will retry */ }
  };
  // Click the 🛡 backup badge to ls the configured backupDir on every
  // selected server — quickest path to "show me what backups exist".
  // Reuses pathOpenOnSelected so the same broadcast logic and `:se`
  // affordance apply. When nothing's ticked, ask the host to surface a
  // VSCode info toast rather than silently swallowing the click.
  document.getElementById('backupBadge').onclick = () => {
    if (!(state.backupEnabled && state.backupHealth?.overall === 'ok' && state.backupDir)) return;
    if (state.selectedCount === 0) {
      vscode.postMessage({ type: 'notify', level: 'info', text: 'Select at least one server first.' });
      return;
    }
    vscode.postMessage({ type: 'lsRemoteDir', path: state.backupDir });
  };
  document.getElementById('btnLsOpts').onclick = () => toggleDropdown('lsDd');
  // Bookmarks combo: clicking ★ both opens the saved list AND renders an
  // "Add current directory" entry at the top — one control covers add and
  // recall, replacing the previous separate add-button + saved-list pair.
  document.getElementById('btnBookmarks').onclick = () => {
    renderBookmarksDd();
    toggleDropdown('bookmarksDd');
  };
  document.getElementById('btnCwdHistory').onclick = () => {
    renderCwdHistoryDd();
    toggleDropdown('cwdHistoryDd');
  };
  for (const id of ['ls_l', 'ls_t', 'ls_r', 'ls_a', 'ls_h']) {
    document.getElementById(id).addEventListener('change', () => {
      lsFlagsUserDirty = true;
      updateLsPreview();
      // Persist the operator's override to the FILE-BACKED workdir
      // state via the extension. Storing here in webview-state would
      // also work but lives under the user profile — which can reset
      // between sessions in some environments. The extension writes
      // through to `<workdir>/.ssh-fleet-state.json`, which lives with
      // the operator's chosen workdir.
      let opts = '';
      for (const c of ['l', 't', 'r', 'a', 'h']) {
        if (document.getElementById('ls_' + c).checked) opts += c;
      }
      vscode.postMessage({ type: 'lsFlagsChanged', flags: opts });
    });
  }
  document.getElementById('btnLsRun').onclick = () => {
    const cmd = computeLsCommand();
    document.getElementById('lsDd').classList.add('hidden');
    runRaw(cmd);
  };
  updateLsPreview();

  // (Active-config picker moved to the CONFIGS sidebar TreeView.)
  outputElem.addEventListener('contextmenu', onOutputContextMenu);

  document.addEventListener('click', (ev) => {
    if (!ctxMenu.contains(ev.target)) ctxMenu.classList.add('hidden');
    closeAllDropdowns(ev);
  });
}

function applyState(s) {
  const prevCwd = state.cwdCommon;
  state = { ...state, ...s };
  // Drive the recent-cwd history off cwdCommon transitions: any well-defined
  // single-cwd change (not "mixed") records the new cwd at the top. Skip
  // when cwdCommon is undefined (mixed servers) or unchanged.
  if (state.cwdCommon && state.cwdCommon !== prevCwd && !state.cwdMixed) {
    rememberCwd(state.cwdCommon);
  }
  renderConfigSelect();
  renderCwdBar();
  updateSelectionStatus();
  updateBookmarksCount();
  // If the bookmarks dropdown is open while state updates land (e.g. the
  // operator just clicked × on a row), re-render it so the change is
  // visible without having to close + reopen.
  const bookmarksDd = document.getElementById('bookmarksDd');
  if (bookmarksDd && !bookmarksDd.classList.contains('hidden')) {
    renderBookmarksDd();
  }
  syncLsFlagsFromConfig();
  // Schedule button shows live connected-server count in its tooltip,
  // so refresh it whenever the state snapshot changes.
  updateScheduleHeaderBadge();

  // Backup badge in cwd bar — green when probes ok, gray + tooltip when
  // any selected/connected server's backupDir probe failed (so the operator
  // sees "backup is on, but it's not actually going to work" before they
  // run something destructive).
  const backupBadge = document.getElementById('backupBadge');
  backupBadge.classList.toggle('hidden', !state.backupEnabled);
  const bh = state.backupHealth || { overall: 'unchecked' };
  const degraded = state.backupEnabled && bh.overall === 'failed';
  backupBadge.classList.toggle('degraded', degraded);
  // Badge becomes clickable only when probe ok AND backupDir is known —
  // gives a discoverable "ls the backup dir" affordance without ever
  // surfacing it when it would just fail.
  const clickable = state.backupEnabled && bh.overall === 'ok' && !!state.backupDir;
  backupBadge.classList.toggle('clickable', clickable);
  if (degraded) {
    backupBadge.title = `backup probe failed: ${bh.failedDetail || 'unknown'}`;
  } else if (clickable) {
    backupBadge.title = `click to list ${state.backupDir} on selected servers`;
  } else if (state.backupEnabled) {
    backupBadge.title = 'auto-backup enabled in safety config';
  }

  // Restore persisted prefs (timestamps + auto-deselect) into UI controls.
  if (state.hideTimestamps) {
    outputElem.classList.add('hide-ts');
  } else {
    outputElem.classList.remove('hide-ts');
  }


  // Tab warn-state reflects current safety patterns.
  for (const [id, tab] of tabs) {
    if (id === 'main') continue;
    const serverName = id.replace(/^server:/, '');
    tab.warn = !!state.warnByServer?.[serverName];
  }
  renderTabBar();
}

// renderConfigSelect was retired alongside the header dropdown — the CONFIGS
// sidebar TreeView now owns the active-config switcher.
function renderConfigSelect() { /* no-op kept so applyState callers don't break */ }

function renderCwdBar() {
  const crumb = document.getElementById('cwdCrumb');
  removeAllChildren(crumb);

  if (state.selectedCount === 0) {
    const empty = document.createElement('span');
    empty.className = 'cwd-empty';
    empty.textContent = 'no servers selected';
    crumb.appendChild(empty);
    return;
  }
  if (state.cwdMixed) {
    const m = document.createElement('span');
    m.className = 'cwd-mixed';
    m.textContent = '~mixed~ (run :cwd to inspect)';
    m.style.cursor = 'pointer';
    m.onclick = () => runSpecial(':cwd');
    crumb.appendChild(m);
    return;
  }
  const cwd = state.cwdCommon || '~';

  // Every segment — including the leaf "current" one — is clickable. Clicking
  // re-runs `cd <segment> && <lsCommand>` so any level of the breadcrumb
  // produces a directory listing in the output area.
  if (cwd === '~' || !cwd.startsWith('/')) {
    const node = document.createElement('span');
    node.className = 'cwd-segment current';
    node.textContent = cwd;
    node.title = `cd ${cwd} && list`;
    node.onclick = () => navigateToDir(cwd);
    crumb.appendChild(node);
    return;
  }

  const parts = cwd.split('/').filter(p => p.length > 0);
  const root = document.createElement('span');
  root.className = 'cwd-segment' + (parts.length === 0 ? ' current' : '');
  root.textContent = '/';
  root.title = 'cd / && list';
  root.onclick = () => navigateToDir('/');
  crumb.appendChild(root);

  // (The always-visible home button at the left of the cwd-bar is the
  //  shortcut to `cd ~`; the breadcrumb just renders every path segment
  //  literally so the user sees the actual current directory.)
  let acc = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    acc += '/' + p;
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'cwd-sep';
      sep.textContent = '/';
      crumb.appendChild(sep);
    }
    const seg = document.createElement('span');
    seg.className = 'cwd-segment' + (i === parts.length - 1 ? ' current' : '');
    seg.textContent = p;
    const target = acc;
    seg.title = `cd ${target} && list`;
    seg.onclick = () => navigateToDir(target);
    crumb.appendChild(seg);
  }
}

function updateSelectionStatus() {
  const sel = state.selectedCount;
  const tot = state.totalServers;
  const conn = state.connectedCount;
  if (selectionStatus) {
    selectionStatus.textContent = `${sel}/${tot} selected · ${conn} connected`;
  }
  document.getElementById('selectedCount').textContent = String(sel);
}

function updateBookmarksCount() {
  document.getElementById('bookmarksCount').textContent = String(state.bookmarks?.length ?? 0);
}

function renderBookmarksDd() {
  const dd = document.getElementById('bookmarksDd');
  removeAllChildren(dd);
  const list = state.bookmarks ?? [];
  const cwd = state.cwdCommon;
  const canAdd = cwd && cwd.startsWith('/') && !list.includes(cwd);

  // "Add current directory" row at the top — only shown when there is a
  // single common cwd that isn't already bookmarked. Replaces the old
  // dedicated ★ button.
  const addItem = document.createElement('div');
  addItem.className = 'cwd-dd-item cwd-dd-add';
  if (canAdd) {
    addItem.textContent = `★ Bookmark ${cwd}`;
    addItem.onclick = () => {
      dd.classList.add('hidden');
      vscode.postMessage({ type: 'bookmarkAdd', path: cwd });
      flashStatus(`★ bookmarked ${cwd}`);
    };
  } else if (cwd && list.includes(cwd)) {
    addItem.textContent = `(already bookmarked: ${cwd})`;
    addItem.classList.add('cwd-dd-add-disabled');
  } else {
    addItem.textContent = '(no common cwd to bookmark — pick a single server first)';
    addItem.classList.add('cwd-dd-add-disabled');
  }
  dd.appendChild(addItem);

  if (list.length === 0) {
    const e = document.createElement('div');
    e.className = 'cwd-dd-empty';
    e.textContent = '(no saved bookmarks)';
    dd.appendChild(e);
    return;
  }
  // Saved list — clicking the row navigates; the trailing × removes the
  // bookmark. Wrapper is flex so the × stays right-aligned.
  for (const p of list) {
    const item = document.createElement('div');
    item.className = 'cwd-dd-item cwd-dd-row';
    const label = document.createElement('span');
    label.className = 'cwd-dd-label';
    label.textContent = p;
    label.onclick = () => {
      dd.classList.add('hidden');
      navigateToDir(p);
    };
    const del = document.createElement('span');
    del.className = 'cwd-dd-del';
    del.textContent = '×';
    del.title = `Remove bookmark ${p}`;
    del.onclick = (ev) => {
      // Stop propagation so the row's navigate handler doesn't also fire.
      ev.stopPropagation();
      vscode.postMessage({ type: 'bookmarkRemove', path: p });
      flashStatus(`Removed bookmark ${p}`);
    };
    item.appendChild(label);
    item.appendChild(del);
    dd.appendChild(item);
  }
}

function updateLsPreview() {
  document.getElementById('lsDdPreview').textContent = computeLsCommand();
}

function computeLsCommand() {
  let opts = '';
  if (document.getElementById('ls_l').checked) opts += 'l';
  if (document.getElementById('ls_t').checked) opts += 't';
  if (document.getElementById('ls_r').checked) opts += 'r';
  if (document.getElementById('ls_a').checked) opts += 'a';
  if (document.getElementById('ls_h').checked) opts += 'h';
  return opts ? `ls -${opts}` : 'ls';
}

/**
 * Seed the dropdown checkboxes from `settings.lsCommand` in the active
 * config — once. After the user toggles any checkbox in this session,
 * runtime intent wins over config.
 */
function syncLsFlagsFromConfig() {
  if (lsFlagsUserDirty) return;
  // File-backed override (from `<workdir>/.ssh-fleet-state.json` via the
  // extension) wins over the config default. Falls back to
  // `settings.lsCommand`'s flag string when there's no override yet.
  let flags;
  if (typeof state.lsFlagsOverride === 'string') {
    flags = state.lsFlagsOverride;
    lsFlagsUserDirty = true; // freeze further config-driven overwrites
  } else {
    const cmd = state.lsCommand || 'ls -ltr';
    const m = /^ls(?:\s+-([A-Za-z]+))?\b/.exec(cmd.trim());
    flags = m ? m[1] || '' : '';
  }
  for (const c of ['l', 't', 'r', 'a', 'h']) {
    const el = document.getElementById('ls_' + c);
    if (el) el.checked = flags.includes(c);
  }
  updateLsPreview();
}

function toggleDropdown(id) {
  const dd = document.getElementById(id);
  for (const other of document.querySelectorAll('.cwd-dd')) {
    if (other.id !== id) other.classList.add('hidden');
  }
  dd.classList.toggle('hidden');
}

function closeAllDropdowns(ev) {
  for (const dd of document.querySelectorAll('.cwd-dd')) {
    if (!dd.contains(ev.target) && !dd.classList.contains('hidden')) {
      const btn = dd.parentElement?.querySelector('.cwd-btn');
      if (!btn || !btn.contains(ev.target)) {
        dd.classList.add('hidden');
      }
    }
  }
}

// ---------- Output rendering with block grouping ----------

// Trim `outputLog` only when it overshoots the cap by a meaningful margin —
// `Array.shift()` is O(n), and doing it per-line under high-volume `tail -f`
// dominates the hot path. Splicing once per ~200 lines is amortised O(1).
const LOG_TRIM_HYSTERESIS = 200;

function appendOutput(msg) {
  outputLog.push(msg);
  if (outputLog.length > MAX_LOG + LOG_TRIM_HYSTERESIS) {
    outputLog.splice(0, outputLog.length - MAX_LOG);
  }

  // Only render in the DOM if the active tab's filter accepts this message.
  const tab = tabs.get(activeTabId);
  if (!tab || !tab.filter(msg)) return;
  enqueueRender(msg);
}

// rAF-coalesced render queue. All filtered-in messages land here; one
// `requestAnimationFrame` runs them in order and calls `trimAndScroll` ONCE
// at the end, instead of per-line. This is the single biggest lever for
// keeping the UI smooth under busy streams (e.g. `tail -f` of a hot log).
const renderQueue = [];
let renderScheduled = false;
const RENDER_HARD_FLUSH_AT = 500;

function enqueueRender(msg) {
  renderQueue.push(msg);
  // Hard flush if the queue gets unreasonably long (panel hidden for a
  // long stretch — rAF doesn't fire on hidden tabs, so the queue can
  // accumulate. Sync-flush keeps memory bounded.)
  if (renderQueue.length > RENDER_HARD_FLUSH_AT) {
    flushRenderQueue();
    return;
  }
  if (!renderScheduled) {
    renderScheduled = true;
    (typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16))(flushRenderQueue);
  }
}

function flushRenderQueue() {
  renderScheduled = false;
  if (renderQueue.length === 0) return;
  // Splice into a local buffer first — `renderMessageInDom` could
  // theoretically re-enter (it doesn't today, but be defensive).
  const batch = renderQueue.splice(0, renderQueue.length);
  for (const m of batch) renderMessageInDomCore(m);
  trimAndScroll();
}

/** Public entry — used when re-rendering a single message outside the
 *  rAF batch (e.g. tab-switch replay). Calls `trimAndScroll` itself. */
function renderMessageInDom(msg) {
  renderMessageInDomCore(msg);
  trimAndScroll();
}

/**
 * Robust "scroll to the very bottom" — does the assignment three times
 * across rAF frames. Why: very long wrapped lines (e.g. the 16KB phase
 * in the stress test) lay out incrementally. A single `scrollTop =
 * scrollHeight` reads the height at "what's laid out right now" — if
 * the line is still wrapping, that's smaller than the eventual final
 * height, so we land in the middle. Re-running across two more frames
 * catches the post-layout settling.
 *
 * Also: increments `suppressAutoFollowScrollDepth` for the duration of
 * the rAF chain. Without this, the browser sometimes dispatches a
 * scroll event AFTER our `scrollTop = scrollHeight` but reporting a
 * scrollTop slightly LOWER than what we set (post-wrap layout
 * adjustment). The follow detector would interpret that as "user
 * scrolled up" and flip `autoFollow = false`, killing auto-scroll
 * mid-stream. Suppressing during the assignment window avoids this.
 */
function forceScrollToBottom() {
  suppressAutoFollowScrollDepth++;
  outputElem.scrollTop = outputElem.scrollHeight;
  requestAnimationFrame(() => {
    outputElem.scrollTop = outputElem.scrollHeight;
    requestAnimationFrame(() => {
      outputElem.scrollTop = outputElem.scrollHeight;
      // Macrotask, not microtask — scroll events are queued on the task
      // queue, so a Promise.then would re-enable BEFORE pending events
      // dispatch. setTimeout(_, 0) re-enables AFTER they all flush.
      setTimeout(() => {
        lastScrollTop = outputElem.scrollTop;
        if (suppressAutoFollowScrollDepth > 0) suppressAutoFollowScrollDepth--;
      }, 0);
    });
  });
}

function isNearBottom() {
  // Threshold raised from 100 → 200px so a single very long line
  // (Phase 4 in the stress test wraps to ~80px tall by itself) doesn't
  // accidentally drop us out of "at bottom" before the next batch.
  return outputElem.scrollHeight - outputElem.clientHeight - outputElem.scrollTop < 200;
}

// Sticky auto-follow tracking. The signal we trust is "scrollTop went
// DOWN" (user scrolled up to read history) — not isNearBottom() at scroll
// event time. Why: when very large lines arrive in burst, scrollHeight
// grows faster than the browser can settle scrollTop. The scroll event
// fires AFTER our programmatic `scrollTop = scrollHeight` but with
// scrollHeight already changed by the next line's layout, so
// isNearBottom() returns false even though we're still at the visual
// bottom. Watching scrollTop direction avoids that false negative.
let autoFollow = true;
let lastScrollTop = 0;
/** Depth counter — when > 0, the scroll listener ignores events.
 *  Incremented before any programmatic scroll (`forceScrollToBottom`,
 *  tab-swap restore) and decremented after the rAF chain settles.
 *  Counter rather than boolean because multiple programmatic scrolls
 *  can overlap (e.g. forceScrollToBottom firing again before the
 *  previous one's rAF chain finishes); a boolean re-enables too early
 *  and the second call's settling events leak through. */
let suppressAutoFollowScrollDepth = 0;
/** Stricter than isNearBottom — used by the scroll-direction follow
 *  detector. We only resume auto-follow when the operator actually scrolls
 *  to the actual bottom, not just into the lenient 200px window. */
function isAtBottom() {
  return outputElem.scrollHeight - outputElem.clientHeight - outputElem.scrollTop < 30;
}
function bindAutoFollowScroll() {
  outputElem.addEventListener('scroll', () => {
    if (suppressAutoFollowScrollDepth > 0) {
      lastScrollTop = outputElem.scrollTop;
      return;
    }
    const now = outputElem.scrollTop;
    if (now < lastScrollTop - 10) {
      // Scrolled up — user is reading history. (10px tolerance for
      // momentum / sub-pixel jitter.)
      autoFollow = false;
    } else if (now > lastScrollTop + 5 && isAtBottom()) {
      // Scrolled DOWN by >5px AND landed at the actual bottom.
      // Both conditions matter: a small upward bounce that lands inside
      // the lenient 200px isNearBottom window must NOT flip follow back
      // on. Programmatic scroll-to-bottom satisfies both (big jump
      // upward in scrollTop value, lands at bottom).
      autoFollow = true;
    }
    lastScrollTop = now;
  }, { passive: true });
}

/** Core renderer with NO trim/scroll side effect — the rAF batch caller
 *  invokes `trimAndScroll` once at the end of the batch instead of per
 *  message, which is the throughput win. */
function renderMessageInDomCore(msg) {
  // `▶ Running task ...` and `▶ Broadcast ...` headers act as run
  // boundaries — promote them to block headers so each run gets its own
  // per-server-section scope. Without this, the WeakMap-keyed-by-block
  // cache accumulates dev-nodeN sections across unrelated task runs and
  // every later run's output lands in the original block's sections.
  const isRunBoundary = msg.kind === 'header' && /^▶/.test(msg.text);
  if (msg.kind === 'cmd' || msg.kind === 'cmdWarn' || isRunBoundary) {
    currentBlock = createCmdBlock(msg);
    outputElem.appendChild(currentBlock);
    return;
  }
  const body = currentBlock
    ? currentBlock.querySelector('.cmd-block-body')
    : outputElem;
  const line = renderOutputLine(msg);
  lineMeta.set(line, { serverName: msg.serverName, kind: msg.kind, text: msg.text });
  // Per-server lines go into a per-server sub-section so output stays in
  // SELECTION ORDER (the order servers are listed in the tree) regardless
  // of which server's bytes arrived first over the wire. Lines without a
  // serverName (headers, info, cmd-echo replies) flow at the top level.
  const target = msg.serverName && currentBlock
    ? getOrCreateServerSection(currentBlock, msg.serverName)
    : body;
  target.appendChild(line);
  domLineCount++;
}

/**
 * Find or create a `.server-section` div inside the current block's body,
 * keyed by `serverName`. Sections are created lazily on first
 * appearance, but their *position* among siblings is fixed by selection
 * rank (read from `state.cwdByServer`'s insertion order), so 3 servers
 * responding out of order still render in the order the operator sees
 * in the Servers tree.
 *
 * Per-block lookups are cached in a WeakMap so we don't query the DOM on
 * every line — under high-volume streams a per-line `querySelector` was
 * a measurable hot-path cost.
 */
const blockServerSections = new WeakMap();

function getOrCreateServerSection(block, serverName) {
  let perServer = blockServerSections.get(block);
  if (!perServer) {
    perServer = new Map();
    blockServerSections.set(block, perServer);
  }
  let section = perServer.get(serverName);
  if (section) return section;

  const body = block.querySelector('.cmd-block-body');
  section = document.createElement('div');
  section.className = 'server-section';
  section.dataset.server = serverName;

  // Selection order = insertion order of state.cwdByServer keys (panel
  // builds it by iterating ctx.selection.servers, preserving config
  // order). Servers not in current selection get rank Infinity → end.
  const ranks = Object.keys(state.cwdByServer ?? {});
  const myRank = ranks.indexOf(serverName);
  const myKey = myRank < 0 ? Number.MAX_SAFE_INTEGER : myRank;

  // Walk cached sections in this block to find the insertion slot — no
  // DOM `querySelectorAll` and no `cssEscape` quoting cost.
  let inserted = false;
  for (const [otherName, otherSection] of perServer) {
    const otherRank = ranks.indexOf(otherName);
    const otherKey = otherRank < 0 ? Number.MAX_SAFE_INTEGER : otherRank;
    if (myKey < otherKey) {
      body.insertBefore(section, otherSection);
      inserted = true;
      break;
    }
  }
  if (!inserted) body.appendChild(section);
  perServer.set(serverName, section);
  return section;
}

// Total `.line` count rendered in the active tab's DOM. Tracked
// incrementally instead of querySelectorAll-counting on every batch:
// `tail -f` shoves all output into one big block, so the previous
// "5000 child blocks" cap left a single block to balloon to millions
// of lines. This per-line counter caps actual rendered nodes.
let domLineCount = 0;
const MAX_DOM_LINES = 10000;

function trimAndScroll() {
  // Drop oldest blocks while total rendered lines exceed the cap. Block
  // granularity is intentional — losing the oldest commands keeps the
  // session-recent context intact, matching the operator's "scrollback
  // for what I just ran" mental model.
  while (domLineCount > MAX_DOM_LINES && outputElem.firstChild) {
    const block = outputElem.firstChild;
    domLineCount -= block.querySelectorAll('.line').length;
    outputElem.removeChild(block);
  }
  // Belt-and-braces: keep the legacy block-count cap too, in case a
  // session has many tiny blocks (lots of one-line commands).
  while (outputElem.childElementCount > 5000) {
    const block = outputElem.firstChild;
    domLineCount -= block.querySelectorAll('.line').length;
    outputElem.removeChild(block);
  }
  // Sole authority: sticky autoFollow. We deliberately do NOT also force
  // a scroll-to-bottom based on a "was within Npx of bottom" proximity
  // check — that proximity check used to fight the operator during a
  // mouse drag (autoFollow correctly says "user scrolled up", but a
  // 200px proximity window said "still near bottom, force scroll" → the
  // triple-rAF inside forceScrollToBottom yanked the scrollbar back to
  // bottom mid-drag, manifesting as scrollbar lag). autoFollow is sticky
  // and reflects user intent — trust it.
  if (autoFollow) {
    forceScrollToBottom();
  }
}

function createCmdBlock(msg) {
  const block = document.createElement('div');
  // 'run-block' is the task-run variant — same structure but no `>` prompt
  // glyph (the text already has its own `▶` lead-in), and a softer style
  // hook for CSS to differentiate from typed-cmd blocks if desired.
  const isRunBlock = msg.kind === 'header';
  block.className = 'cmd-block'
    + (msg.kind === 'cmdWarn' ? ' warn' : '')
    + (isRunBlock ? ' run-block' : '');

  // If this command is a `ls [-flags] /abs/dir` (or `cd /x && ls ...`),
  // capture the explicit listing dir on the block so subsequent ls-output
  // lines build clickable paths against it instead of the (possibly stale)
  // virtual cwd. Without this, clicking `status.sh` after `ls /opt/app/`
  // resolves to `<cwd>/status.sh` which is the wrong path.
  const lsDir = extractLsDir(msg.text);
  if (lsDir) {
    block.dataset.lsDir = lsDir;
  }

  const header = document.createElement('div');
  header.className = 'cmd-block-header';

  const prompt = document.createElement('span');
  prompt.className = 'cmd-prompt';
  // Run-block headers (`▶ Running task...`) carry their own visual lead;
  // suppress the prompt glyph so we don't render `> ▶ Running...`.
  prompt.textContent = isRunBlock || msg.text.startsWith('>') ? '' : '>';
  header.appendChild(prompt);

  const text = document.createElement('span');
  text.className = 'cmd-text';
  text.textContent = msg.text;
  header.appendChild(text);

  const actions = document.createElement('span');
  actions.className = 'cmd-block-actions';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-block';
  copyBtn.textContent = '⎘ Copy';
  copyBtn.title = 'Copy this block\'s output';
  copyBtn.onclick = (ev) => {
    ev.stopPropagation();
    const body = block.querySelector('.cmd-block-body');
    const text = body ? body.innerText : '';
    navigator.clipboard?.writeText(text).then(() => {
      copyBtn.classList.add('copied');
      copyBtn.textContent = '✓ Copied';
      setTimeout(() => {
        copyBtn.classList.remove('copied');
        copyBtn.textContent = '⎘ Copy';
      }, 1500);
    }).catch(() => {});
  };
  actions.appendChild(copyBtn);
  header.appendChild(actions);

  block.appendChild(header);

  const body = document.createElement('div');
  body.className = 'cmd-block-body';
  block.appendChild(body);

  return block;
}

function renderOutputLine(msg) {
  const line = document.createElement('div');
  line.className = 'line';

  if (msg.kind === 'header') {
    line.classList.add('header-line');
    line.textContent = msg.text;
    return line;
  }

  if (msg.ts) {
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = formatTs(msg.ts);
    line.appendChild(ts);
  }
  if (msg.serverName) {
    const sp = document.createElement('span');
    sp.className = 'server-prefix';
    const shortened = displayServerName(msg.serverName);
    sp.textContent = `[${shortened}]`;
    // Tooltip preserves the full name when shortening kicked in. Always-
    // present is fine since the title attribute renders no UI when text
    // matches the visible content.
    if (shortened !== msg.serverName) sp.title = msg.serverName;
    // Color comes from the .server-prefix CSS rule (theme's
    // descriptionForeground) — single unified hue for all servers.
    line.appendChild(sp);
    line.appendChild(document.createTextNode(' '));
  }

  // Strip ANSI then test for ls -l shape so coloured `ls --color` output
  // also gets the clickable-name treatment.
  // Resolution priority: block-level lsDir (explicit `ls /abs/path` arg) >
  // per-server virtual cwd > common cwd. Block-level wins because the
  // operator may run `ls /opt/app/` without first cd'ing — virtual cwd
  // would resolve filenames against the wrong parent.
  const blockLsDir = currentBlock?.dataset?.lsDir;
  const cwdForServer = msg.serverName
    ? (state.cwdByServer?.[msg.serverName] ?? state.cwdCommon)
    : state.cwdCommon;
  const lsParent = blockLsDir ?? cwdForServer;
  const lsParts = lsParent ? parseLsLine(stripAnsi(msg.text), lsParent) : null;
  if (lsParts) {
    renderLsLine(line, lsParts, msg.serverName);
  } else {
    appendTextWithLinks(line, msg.text, msg.kind, msg.serverName);
  }
  return line;
}

// Drop ANSI SGR codes before regex matching — keeps the parser simple while
// still allowing colour parsing later in appendTextWithLinks.
function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Best-effort extract the explicit listing directory from an ls/ll command
 * echo, so subsequent rows resolve filenames against it instead of cwd.
 *
 * Recognised patterns (in priority order):
 *   - `ls /abs/path`              → /abs/path
 *   - `ls -lah /abs/path/`        → /abs/path
 *   - `ll /opt/app`               → /opt/app   (alias for `ls -ltrah`)
 *   - `cd /foo && ls -l`          → /foo       (cd-prefix without explicit
 *                                                ls arg — listing happens in
 *                                                the cd target dir)
 *
 * Returns null if the command isn't an ls or has no detectable directory
 * argument. Caller falls back to virtual cwd in that case.
 */
function extractLsDir(cmdText) {
  if (!cmdText) return null;
  // Strip leading `> ` cmd echo glyph + trim.
  let cmd = cmdText.replace(/^>\s*/, '').trim();

  // Pull out `cd /target && ` prefix if present — captures the target.
  let cdTarget = null;
  const cdMatch = cmd.match(/^cd\s+(\S+)\s*&&\s*(.*)$/);
  if (cdMatch) {
    cdTarget = cdMatch[1];
    cmd = cdMatch[2];
  }

  // Recognise ls / ll / la / dir as listing verbs.
  const verbMatch = cmd.match(/^(ls|ll|la|dir)\b\s*(.*)$/);
  if (!verbMatch) return cdTarget && cdTarget.startsWith('/') ? trimTrailingSlash(cdTarget) : null;
  const args = verbMatch[2].split(/\s+/).filter(a => a.length > 0);
  // Last absolute-path arg wins. `ls -l /a /b` — we pick /b which is
  // technically ambiguous; that's fine for typical workflows where one
  // dir is meant.
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i];
    if (a.startsWith('-')) continue; // flag
    if (a.startsWith('/')) return trimTrailingSlash(a);
  }
  // No absolute arg in ls; fall back to cd target if any.
  return cdTarget && cdTarget.startsWith('/') ? trimTrailingSlash(cdTarget) : null;
}

function trimTrailingSlash(p) {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

const LS_L_MONTH_RE = /^([dlcbpsrwxstST-]{10})[.+@]?\s+\d+\s+\S+\s+\S+\s+\S+\s+[A-Z][a-z]{2}\s+\d+\s+\S+\s+(.+?)(?:\s+->\s+(\S.*))?$/;
const LS_L_ISO_RE   = /^([dlcbpsrwxstST-]{10})[.+@]?\s+\d+\s+\S+\s+\S+\s+\S+\s+\d{4}-\d{2}-\d{2}\s+\S+\s+(.+?)(?:\s+->\s+(\S.*))?$/;

/**
 * Recognise an `ls -l` line and split it into:
 *   - prefix (mode + ownership + size + date as plain text)
 *   - kind (dir | file | link)
 *   - name (the file/dir at this row)
 *   - target (only for symlinks; absolute or relative)
 * Returns null if the line doesn't match either common date format.
 */
function parseLsLine(plain, cwd) {
  const m = LS_L_MONTH_RE.exec(plain) || LS_L_ISO_RE.exec(plain);
  if (!m) return null;
  const mode = m[1];
  const name = m[2];
  const target = m[3];
  // Map mode bits to a kind tag used for both colour and click behaviour.
  // Directories and symlinks key off mode[0]; "executable" is any regular
  // file with at least one of the user/group/other x bits set (matching
  // GNU `ls --color` defaults).  Setuid (`s` / `S`) and setgid bits also
  // count as executable for the colour tag.
  let kind;
  if (mode[0] === 'd') {
    kind = 'dir';
  } else if (mode[0] === 'l') {
    kind = 'link';
  } else if (/[xsSt]/.test(mode[3]) || /[xsSt]/.test(mode[6]) || /[xt]/.test(mode[9])) {
    kind = 'exec';
  } else {
    kind = 'file';
  }
  const namePos = plain.lastIndexOf(name);
  const prefix = plain.slice(0, namePos);
  // If `ls` printed an absolute path as the name (e.g. `ls /opt/foo/x` →
  // row name is `/opt/foo/x`), use it verbatim. Otherwise resolve
  // against the listing directory. Without this guard, an absolute name
  // gets the cwd prepended (`/home/admin//opt/foo/x`), breaking every
  // downstream Cd-to-containing / Open / Delete action.
  const fullPath = name.startsWith('/')
    ? name
    : (cwd === '/' ? '/' + name : `${cwd}/${name}`);
  return { prefix, kind, name, target, fullPath };
}

/**
 * Render an `ls -l` row: prefix as plain text, name as a clickable segment
 * (cd+ls for dirs, open-in-editor for files), symlink target as another
 * clickable segment when present.
 */
function renderLsLine(line, parts, serverName) {
  line.classList.add('ls-line');
  line.appendChild(document.createTextNode(parts.prefix));
  // Pass the real kind ('dir' | 'file' | 'link') so CSS can colour symlinks
  // differently from regular files; the click handler still treats anything
  // non-dir as "let the extension stat()".
  line.appendChild(makeLsName(parts.name, parts.fullPath, parts.kind, serverName));
  if (parts.target !== undefined && parts.target !== null) {
    line.appendChild(document.createTextNode(' -> '));
    // Symlink target: absolute → render as a drillable path; relative →
    // resolve against the link's parent dir for the click target.
    if (parts.target.startsWith('/')) {
      line.appendChild(renderDrillablePath(parts.target, serverName));
    } else {
      const parent = parts.fullPath.slice(0, parts.fullPath.lastIndexOf('/')) || '/';
      const abs = parent === '/' ? '/' + parts.target : `${parent}/${parts.target}`;
      line.appendChild(makeLsName(parts.target, abs, 'file', serverName));
    }
  }
}

function makeLsName(label, fullPath, kind, serverName) {
  const span = document.createElement('span');
  span.className = 'ls-name ls-' + kind;
  span.textContent = label;
  span.dataset.path = fullPath;
  span.dataset.kind = kind;
  if (serverName) span.dataset.server = serverName;
  if (serverName) {
    span.onclick = (ev) => onSegmentClick(ev, fullPath, kind, serverName);
  }
  return span;
}

// ---------- Drillable per-segment path rendering ----------

const PATH_RE = /(?:^|[\s'"=])(\/[A-Za-z0-9_./-]+)/g;

function appendTextWithLinks(container, text, kind, serverName) {
  const wrap = document.createElement('span');
  if (kind === 'stderr' || kind === 'error') wrap.classList.add('err');
  else if (kind === 'warn') wrap.classList.add('warn');
  else if (kind === 'info') wrap.classList.add('info');

  // Parse ANSI SGR colour codes (the `\x1b[…m` sequences) into styled segments
  // first; non-SGR escapes (cursor moves, erase) are stripped silently. Path
  // detection then runs *within* each segment so coloured tool output (e.g.
  // `ls --color`, `grep --color`) keeps its colours and stays clickable.
  for (const seg of parseAnsi(text)) {
    if (!seg.text) continue;
    const segSpan = applyAnsiStyle(seg);
    appendPlainWithLinks(segSpan, seg.text, serverName);
    wrap.appendChild(segSpan);
  }
  container.appendChild(wrap);
}

function appendPlainWithLinks(container, text, serverName) {
  let i = 0;
  for (const m of text.matchAll(PATH_RE)) {
    const pathText = m[1];
    const pathStart = m.index + (m[0].length - pathText.length);
    if (pathStart > i) {
      container.appendChild(document.createTextNode(text.slice(i, pathStart)));
    }
    container.appendChild(renderDrillablePath(pathText, serverName));
    i = pathStart + pathText.length;
  }
  if (i < text.length) {
    container.appendChild(document.createTextNode(text.slice(i)));
  }
}

// ---------- ANSI SGR parsing ----------

const ANSI_BASIC = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5'];
const ANSI_BRIGHT = ['#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];

function ansi256(n) {
  if (n < 8) return ANSI_BASIC[n];
  if (n < 16) return ANSI_BRIGHT[n - 8];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const x = n - 16;
  const r = Math.floor(x / 36) * 51;
  const g = Math.floor((x % 36) / 6) * 51;
  const b = (x % 6) * 51;
  return `rgb(${r},${g},${b})`;
}

/**
 * Walk a string, splitting it into segments at SGR (`\x1b[…m`) boundaries.
 * Each segment carries the active style at that point. Non-SGR escape
 * sequences (cursor-move, erase, etc.) are dropped — we don't model a
 * terminal, just enough colouring to keep `--color` output legible.
 */
function parseAnsi(text) {
  const segments = [];
  const cur = { text: '', fg: null, bg: null, bold: false, italic: false, underline: false, dim: false };
  const flush = () => {
    if (cur.text.length > 0) {
      segments.push({ ...cur });
      cur.text = '';
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch !== 0x1b) {
      cur.text += text[i];
      i++;
      continue;
    }
    // ESC seen — only `\x1b[…<letter>` (CSI) is meaningful here.
    if (text[i + 1] !== '[') { i++; continue; }
    let j = i + 2;
    while (j < text.length && (text[j] === ';' || (text[j] >= '0' && text[j] <= '9'))) j++;
    if (j >= text.length) { i = j; continue; }
    const finalChar = text[j];
    const params = text.slice(i + 2, j);
    if (finalChar === 'm') {
      flush();
      applyCsiM(cur, params);
    }
    // Skip the entire escape regardless (non-SGR finals like 'K', 'H' just drop).
    i = j + 1;
  }
  flush();
  return segments;
}

function applyCsiM(cur, params) {
  const codes = params === '' ? [0] : params.split(';').map(s => parseInt(s, 10) || 0);
  let k = 0;
  while (k < codes.length) {
    const c = codes[k];
    if (c === 0) {
      cur.fg = null; cur.bg = null;
      cur.bold = false; cur.italic = false; cur.underline = false; cur.dim = false;
    } else if (c === 1) cur.bold = true;
    else if (c === 2) cur.dim = true;
    else if (c === 3) cur.italic = true;
    else if (c === 4) cur.underline = true;
    else if (c === 22) { cur.bold = false; cur.dim = false; }
    else if (c === 23) cur.italic = false;
    else if (c === 24) cur.underline = false;
    else if (c >= 30 && c <= 37) cur.fg = ANSI_BASIC[c - 30];
    else if (c === 38 && codes[k + 1] === 5) { cur.fg = ansi256(codes[k + 2] || 0); k += 2; }
    else if (c === 38 && codes[k + 1] === 2) {
      cur.fg = `rgb(${codes[k + 2] || 0},${codes[k + 3] || 0},${codes[k + 4] || 0})`;
      k += 4;
    }
    else if (c === 39) cur.fg = null;
    else if (c >= 40 && c <= 47) cur.bg = ANSI_BASIC[c - 40];
    else if (c === 48 && codes[k + 1] === 5) { cur.bg = ansi256(codes[k + 2] || 0); k += 2; }
    else if (c === 48 && codes[k + 1] === 2) {
      cur.bg = `rgb(${codes[k + 2] || 0},${codes[k + 3] || 0},${codes[k + 4] || 0})`;
      k += 4;
    }
    else if (c === 49) cur.bg = null;
    else if (c >= 90 && c <= 97) cur.fg = ANSI_BRIGHT[c - 90];
    else if (c >= 100 && c <= 107) cur.bg = ANSI_BRIGHT[c - 100];
    k++;
  }
}

function applyAnsiStyle(seg) {
  const span = document.createElement('span');
  if (seg.fg) span.style.color = seg.fg;
  if (seg.bg) span.style.backgroundColor = seg.bg;
  if (seg.bold) span.style.fontWeight = '600';
  if (seg.italic) span.style.fontStyle = 'italic';
  if (seg.underline) span.style.textDecoration = 'underline';
  if (seg.dim) span.style.opacity = '0.7';
  return span;
}

/**
 * Render an absolute path as a chain of clickable segments. Each segment and
 * each separator is clickable: clicking a segment cd's to that level (or
 * opens the file if it's the last segment and is a file).
 */
function renderDrillablePath(pathText, serverName) {
  const wrap = document.createElement('span');
  wrap.className = 'path-segments';
  wrap.dataset.fullPath = pathText;
  if (serverName) wrap.dataset.server = serverName;

  // Root '/'
  const root = document.createElement('span');
  root.className = 'path-seg';
  root.dataset.path = '/';
  root.dataset.kind = 'dir';
  if (serverName) root.dataset.server = serverName;
  root.textContent = '/';
  root.onclick = serverName ? (ev) => onSegmentClick(ev, '/', 'dir', serverName) : null;
  wrap.appendChild(root);

  const parts = pathText.split('/').filter(p => p.length > 0);
  let acc = '';
  parts.forEach((part, idx) => {
    acc += '/' + part;
    // Snapshot acc into per-iteration constants — without this the onclick
    // closures all capture the same `acc` reference and every segment ends
    // up navigating to the final (deepest) path. Classic loop-closure trap.
    const ownPath = acc;
    if (idx > 0) {
      const sep = document.createElement('span');
      sep.className = 'path-sep';
      sep.textContent = '/';
      const beforeSep = parts.slice(0, idx).reduce((a, p) => a + '/' + p, '');
      if (serverName) {
        sep.onclick = (ev) => onSegmentClick(ev, beforeSep, 'dir', serverName);
      }
      wrap.appendChild(sep);
    }
    const seg = document.createElement('span');
    seg.className = 'path-seg';
    seg.dataset.path = ownPath;
    if (serverName) seg.dataset.server = serverName;
    seg.textContent = part;
    const isLast = idx === parts.length - 1;
    if (isLast) {
      seg.classList.add('is-file');
      seg.dataset.kind = 'leaf';
    } else {
      seg.dataset.kind = 'dir';
    }
    if (serverName) {
      const kind = isLast ? 'leaf' : 'dir';
      seg.onclick = (ev) => onSegmentClick(ev, ownPath, kind, serverName);
    }
    wrap.appendChild(seg);
  });

  return wrap;
}

function onSegmentClick(ev, path, kind, server) {
  ev.stopPropagation();
  if (kind === 'dir') {
    // Cd + ls in one shot — clicking a directory should land you somewhere
    // with the new directory's contents already visible.
    navigateToDir(path);
  } else {
    // Leaf: let extension stat to pick file-open vs cd.
    vscode.postMessage({ type: 'pathClick', server, path });
  }
}

// ---------- Context menu on output lines ----------

function onOutputContextMenu(ev) {
  // Suppress the browser/webview native Cut/Copy/Paste menu unconditionally
  // inside the output area — operators expect right-click to be ours
  // (path / line actions). Native selection menu was leaking through on
  // clicks that landed outside a recognised line because the previous
  // `preventDefault()` came AFTER the early returns.
  ev.preventDefault();
  const lineElem = findClosestLine(ev.target);
  if (!lineElem) return;
  const meta = lineMeta.get(lineElem);
  if (!meta) return;

  const items = [];
  let pathTarget;
  // `pathKind`: 'dir' when we know the target is a directory (e.g. an ls -l
  // row whose mode starts with `d`), 'file' for a regular file, undefined
  // when we only inferred the path from the line text and don't know.
  let pathKind;
  let pathServer = meta.serverName;
  if (ev.target.classList?.contains('path-seg') || ev.target.classList?.contains('path-sep')) {
    pathTarget = ev.target.dataset.path;
    pathKind = ev.target.dataset.kind;
    if (ev.target.dataset.server) pathServer = ev.target.dataset.server;
  } else if (ev.target.classList?.contains('ls-name')) {
    pathTarget = ev.target.dataset.path;
    pathKind = ev.target.dataset.kind;
    if (ev.target.dataset.server) pathServer = ev.target.dataset.server;
  } else {
    const m = (meta.text ?? '').match(/(\/[A-Za-z0-9_./-]+)/);
    if (m) pathTarget = m[1];
  }

  // Retro-classify: `renderDrillablePath` defaults the last segment to
  // 'leaf' since text alone can't tell file from dir. But certain line
  // patterns are unambiguous directory echoes — promote 'leaf' to 'dir'
  // so the menu shows directory actions (Open dir, Bookmark dir, etc.)
  // instead of file ones (Open file in editor, Delete file…).
  // Patterns covered: `cd → /x`, `cd -> /x`, raw `cd /x` echo.
  if (pathKind === 'leaf' && meta.text) {
    const trimmed = meta.text.trim();
    if (/^cd\s+(?:→|->)\s+\//.test(trimmed) || /^cd\s+\//.test(trimmed)) {
      pathKind = 'dir';
    }
  }

  // Menu structure with explicit scope groups so the operator never
  // wonders "wait, does this run on this one server or all of them?":
  //   - context label: server:path
  //   - Reference (scope-agnostic copy actions)
  //   - "On {server}" group: file ops on the server right-clicked
  //   - "On all selected (N)" group: broadcast file ops (only when N>1)
  //   - "Navigate" group: cd / bookmark (cd is broadcast by design,
  //     bookmark is workspace-scoped)
  //   - Tab navigation at the bottom
  if (pathTarget && pathServer) {
    const selectedCount = state.selectedCount ?? 0;
    items.push({ kind: 'label', label: `${pathServer}:${pathTarget}` });
    items.push({ label: 'Copy path', action: () => copyToClipboard(pathTarget) });
    items.push({ label: 'Copy name', action: () => copyToClipboard(basenameOf(pathTarget)) });

    if (pathKind === 'dir') {
      const depth = pathTarget.split('/').filter(Boolean).length;
      const minDepth = state.archiveMinDepth ?? 2;
      const archiveBlocked = depth < minDepth;
      // ── On {server} ── (single-host only file ops)
      items.push({ kind: 'sep' });
      items.push({ kind: 'group', label: `On ${pathServer}` });
      items.push({
        label: 'Download as archive…',
        disabled: archiveBlocked,
        title: archiveBlocked
          ? `Path too shallow (depth ${depth} < settings.archiveMinDepth ${minDepth})`
          : undefined,
        action: () => vscode.postMessage({ type: 'pathDownloadTar', server: pathServer, path: pathTarget })
      });
      items.push({
        label: 'Delete directory…',
        danger: true,
        action: () => {
          vscode.postMessage({ type: 'pathDelete', server: pathServer, path: pathTarget, isDir: true });
        }
      });
      // ── On all selected (N) ── multi-server dir actions, gated on N>1.
      if (selectedCount > 1) {
        items.push({ kind: 'sep' });
        items.push({ kind: 'group', label: `On all selected (${selectedCount})` });
        items.push({
          label: 'Download as archive from all selected…',
          disabled: archiveBlocked,
          title: archiveBlocked
            ? `Path too shallow (depth ${depth} < settings.archiveMinDepth ${minDepth})`
            : undefined,
          action: () => vscode.postMessage({ type: 'pathDownloadTarMany', path: pathTarget })
        });
        items.push({
          label: 'Delete directory on all selected…',
          danger: true,
          action: () => vscode.postMessage({ type: 'pathDeleteMany', path: pathTarget, isDir: true })
        });
      }
      // ── Navigate ── cd is inherently broadcast to all selected
      // servers (the cwd bar tracks them all), and Bookmark is
      // workspace-scoped — neither is per-server even though they're
      // triggered from a path on one server.
      items.push({ kind: 'sep' });
      items.push({ kind: 'group', label: 'Navigate' });
      items.push({
        label: 'Open directory (cd & ls)',
        action: () => navigateToDir(pathTarget)
      });
      // Hide "Cd to parent" when the parent IS the current cwd — that's
      // the common case for paths shown by `ls` of the current dir, and
      // the menu item would be a no-op there. When cwdCommon is
      // undefined (servers have mixed cwds) we keep the item, since
      // any single global "current" doesn't exist to compare against.
      const dirParent = dirOf(pathTarget);
      if (state.cwdCommon !== dirParent) {
        items.push({
          label: 'Cd to parent directory',
          action: () => navigateToDir(dirParent)
        });
      }
      items.push({
        label: 'Bookmark this directory',
        action: () => vscode.postMessage({ type: 'bookmarkAdd', path: pathTarget })
      });
    } else {
      // File or unknown — extension stat() picks file-open vs cd at runtime.
      // ── On {server} ──
      items.push({ kind: 'sep' });
      items.push({ kind: 'group', label: `On ${pathServer}` });
      items.push({
        label: 'Open file in editor',
        action: () => vscode.postMessage({ type: 'pathOpen', server: pathServer, path: pathTarget })
      });
      items.push({
        label: 'Download…',
        action: () => vscode.postMessage({ type: 'pathDownload', server: pathServer, path: pathTarget })
      });
      items.push({
        label: 'Delete file…',
        danger: true,
        action: () => {
          vscode.postMessage({ type: 'pathDelete', server: pathServer, path: pathTarget, isDir: false });
        }
      });
      // ── On all selected (N) ── only when N > 1 to avoid clutter.
      // Extension owns the modal confirms for these — see :se /
      // pathDownloadMany / pathDeleteMany handlers.
      if (selectedCount > 1) {
        items.push({ kind: 'sep' });
        items.push({ kind: 'group', label: `On all selected (${selectedCount})` });
        items.push({
          label: 'Open file on all selected…',
          action: () => runSpecial(`:se ${pathTarget}`)
        });
        items.push({
          label: 'Download from all selected…',
          action: () => vscode.postMessage({ type: 'pathDownloadMany', path: pathTarget })
        });
        items.push({
          label: 'Delete on all selected…',
          danger: true,
          action: () => vscode.postMessage({ type: 'pathDeleteMany', path: pathTarget, isDir: false })
        });
      }
      // ── Navigate ──
      items.push({ kind: 'sep' });
      items.push({ kind: 'group', label: 'Navigate' });
      // Hide "Cd to containing directory" when the containing dir IS
      // the current cwd — that's the common case when files came from
      // `ls` of the current dir, and the menu item would be a no-op.
      const fileParent = dirOf(pathTarget);
      if (state.cwdCommon !== fileParent) {
        items.push({
          label: 'Cd to containing directory',
          action: () => navigateToDir(fileParent)
        });
      }
      items.push({
        label: 'Bookmark containing directory',
        action: () => vscode.postMessage({ type: 'bookmarkAdd', path: fileParent })
      });
    }
  }
  // Tab switch goes at the bottom — a low-frequency contextual nav.
  if (meta.serverName) {
    const tabId = `server:${meta.serverName}`;
    if (!tabs.has(tabId)) {
      if (items.length > 0) items.push({ kind: 'sep' });
      items.push({
        label: `Open new tab for [${meta.serverName}]`,
        action: () => openTabFor(meta.serverName)
      });
    } else if (activeTabId !== tabId) {
      if (items.length > 0) items.push({ kind: 'sep' });
      items.push({
        label: `Switch to [${meta.serverName}] tab`,
        action: () => switchTab(tabId)
      });
    }
  }

  showCtxMenu(ev.clientX, ev.clientY, items);
}

function findClosestLine(node) {
  while (node && node !== document.body) {
    if (node.classList?.contains('line')) return node;
    node = node.parentNode;
  }
  return null;
}

function showCtxMenu(x, y, items) {
  removeAllChildren(ctxMenu);
  for (const it of items) {
    if (it.kind === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      ctxMenu.appendChild(sep);
    } else if (it.kind === 'label') {
      const label = document.createElement('div');
      label.className = 'ctx-label';
      label.textContent = it.label;
      ctxMenu.appendChild(label);
    } else if (it.kind === 'group') {
      // Section header — like ctx-label but smaller and dimmed, used to
      // declare scope for the items below ("On {server}" vs "On all
      // selected"). Helps the operator see at a glance which actions
      // affect one host vs all of them.
      const g = document.createElement('div');
      g.className = 'ctx-group';
      g.textContent = it.label;
      ctxMenu.appendChild(g);
    } else {
      const btn = document.createElement('button');
      btn.className = 'ctx-item' + (it.danger ? ' danger' : '');
      btn.textContent = it.label;
      if (it.title) btn.title = it.title;
      if (it.disabled) {
        btn.disabled = true;
        btn.classList.add('disabled');
      } else {
        btn.onclick = () => {
          ctxMenu.classList.add('hidden');
          it.action();
        };
      }
      ctxMenu.appendChild(btn);
    }
  }
  ctxMenu.style.left = `${x}px`;
  ctxMenu.style.top = `${y}px`;
  ctxMenu.classList.remove('hidden');
  const r = ctxMenu.getBoundingClientRect();
  if (r.right > window.innerWidth) {
    ctxMenu.style.left = `${window.innerWidth - r.width - 4}px`;
  }
  if (r.bottom > window.innerHeight) {
    ctxMenu.style.top = `${window.innerHeight - r.height - 4}px`;
  }
}

function onCmdKeydown(ev) {
  // Alias-suggest takes priority over history when the dropdown is open.
  if (aliasSuggest.visible) {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      moveAliasSelection(1);
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      moveAliasSelection(-1);
      return;
    }
    if (ev.key === 'Tab' || (ev.key === 'Enter' && aliasSuggest.selectedIdx >= 0)) {
      ev.preventDefault();
      acceptAliasSuggestion();
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      hideAliasSuggest();
      return;
    }
  }

  // L1: Tab without an open alias dropdown — try to trigger one. If the
  // cursor is in the first token and any alias matches the prefix, the
  // dropdown opens and the best (alphabetically-first) match is selected.
  // L2: if alias didn't match, fall through to path completion.
  // We *always* preventDefault so Tab never moves focus to the Run
  // button — operators expect Tab to be a shell-style completion key
  // here, not a form-navigation key.
  if (ev.key === 'Tab' && !aliasSuggest.visible && !pathSuggest.visible) {
    ev.preventDefault();
    updateAliasSuggest();
    if (aliasSuggest.visible) {
      // Don't auto-accept here — leave dropdown open so user can pick.
      // Tab a 2nd time accepts the highlighted item via the visible-mode
      // branch above; ESC dismisses.
      return;
    }
    // Cascade: path completion first (cursor in path-shaped token),
    // then command-name completion (first token, command-name shape).
    // The two are mutually exclusive token shapes — `cat /etc/h` vs `ca` —
    // so at most one fires.
    if (tryStartPathCompletion()) return;
    tryStartCommandCompletion();
    return;
  }
  // Path suggest dropdown navigation mirrors alias suggest semantics.
  if (pathSuggest.visible) {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      movePathSelection(1);
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      movePathSelection(-1);
      return;
    }
    if (ev.key === 'Tab' || (ev.key === 'Enter' && pathSuggest.selectedIdx >= 0)) {
      ev.preventDefault();
      acceptPathSuggestion();
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      hidePathSuggest();
      return;
    }
  }

  if (ev.key === 'Enter' && !ev.shiftKey) {
    // Backslash line-continuation — if the line up to the cursor ends in
    // an unescaped `\`, treat Enter as "insert newline" instead of submit.
    // The remote shell handles `\<LF>` natively, so the joined value gets
    // sent as one multi-line command:
    //   ls /etc \         ➜  bash sees: `ls /etc \⏎  /tmp \⏎  /var`
    //     /tmp \              and runs it as the single command
    //     /var                `ls /etc /tmp /var`.
    if (endsInBackslashContinuation(cmdInput)) {
      // Insert a newline at the cursor and let autoGrow expand the box.
      ev.preventDefault();
      insertAtCursor(cmdInput, '\n');
      autoGrow(cmdInput);
      return;
    }
    ev.preventDefault();
    sendCommand();
    return;
  }
  if (ev.key === 'ArrowUp' && !ev.shiftKey) {
    if (history.length === 0) return;
    if (historyIdx === -1) historyDraft = cmdInput.value;
    historyIdx = Math.min(historyIdx + 1, history.length - 1);
    cmdInput.value = history[history.length - 1 - historyIdx] ?? '';
    autoGrow(cmdInput);
    syncCmdInputState();
    ev.preventDefault();
    return;
  }
  if (ev.key === 'ArrowDown' && !ev.shiftKey) {
    if (historyIdx === -1) return;
    historyIdx -= 1;
    cmdInput.value = historyIdx === -1 ? historyDraft : history[history.length - 1 - historyIdx];
    autoGrow(cmdInput);
    syncCmdInputState();
    ev.preventDefault();
    return;
  }
  historyIdx = -1;
  autoGrow(cmdInput);
}

function sendCommand() {
  const command = cmdInput.value.trim();
  if (!command) return;
  if (state.selectedCount === 0) {
    flashStatus('Tick at least one server in the sidebar first');
    return;
  }
  hideAliasSuggest();
  history.push(command);
  if (history.length > 200) history.shift();
  historyIdx = -1;
  historyDraft = '';

  // Operator just hit Enter on a command → they want to see the output.
  // See `runRaw` for the rationale; this covers the typed-command path
  // including `:run xxx` task dispatches that go via `runSpecial`.
  autoFollow = true;
  if (command.startsWith(':')) {
    runSpecial(command);
  } else {
    vscode.postMessage({ type: 'runCommand', command });
  }
  cmdInput.value = '';
  autoGrow(cmdInput);
  syncCmdInputState();
}

// ---------- Alias auto-suggest ----------

/**
 * Recompute the suggest dropdown from the current cmdInput value. Runs on
 * every keystroke. Only fires when the cursor sits in the *first word* of
 * the line — once you've moved past the initial token, alias completion is
 * out of scope (the rest is shell args).
 */
function updateAliasSuggest() {
  const aliases = state.aliases || {};
  const value = cmdInput.value;
  const cursorAt = cmdInput.selectionStart ?? value.length;
  const head = value.slice(0, cursorAt);
  // Cursor must be in the first whitespace-bounded token.
  if (/\s/.test(head)) {
    hideAliasSuggest();
    return;
  }
  if (head.length === 0 || head.startsWith(':')) {
    hideAliasSuggest();
    return;
  }
  const matches = Object.keys(aliases)
    .filter(name => name.toLowerCase().startsWith(head.toLowerCase()) && name !== head)
    .sort()
    .slice(0, 8)
    .map(name => ({ name, expansion: aliases[name] }));
  if (matches.length === 0) {
    hideAliasSuggest();
    return;
  }
  aliasSuggest.matches = matches;
  // Keep the previously-highlighted alias if it's still in the list.
  if (aliasSuggest.selectedIdx >= matches.length) aliasSuggest.selectedIdx = 0;
  if (aliasSuggest.selectedIdx < 0) aliasSuggest.selectedIdx = 0;
  showAliasSuggest();
}

function showAliasSuggest() {
  aliasSuggest.visible = true;
  renderAliasSuggest();
}

function hideAliasSuggest() {
  if (!aliasSuggest.visible) return;
  aliasSuggest.visible = false;
  aliasSuggest.matches = [];
  aliasSuggest.selectedIdx = -1;
  const dd = document.getElementById('aliasSuggest');
  if (dd) dd.classList.add('hidden');
}

function renderAliasSuggest() {
  const dd = document.getElementById('aliasSuggest');
  if (!dd) return;
  dd.classList.remove('hidden');
  removeAllChildren(dd);
  aliasSuggest.matches.forEach((m, i) => {
    const item = document.createElement('div');
    item.className = 'alias-item' + (i === aliasSuggest.selectedIdx ? ' selected' : '');
    const name = document.createElement('span');
    name.className = 'alias-name';
    name.textContent = m.name;
    item.appendChild(name);
    const exp = document.createElement('span');
    exp.className = 'alias-expansion';
    exp.textContent = m.expansion;
    item.appendChild(exp);
    item.onmousedown = (ev) => {
      // mousedown (not click) so we accept before the textarea blur fires.
      ev.preventDefault();
      aliasSuggest.selectedIdx = i;
      acceptAliasSuggestion();
    };
    dd.appendChild(item);
  });
  const hint = document.createElement('div');
  hint.className = 'alias-hint';
  hint.textContent = 'Tab / Enter to expand · Esc to dismiss';
  dd.appendChild(hint);
}

function moveAliasSelection(delta) {
  if (aliasSuggest.matches.length === 0) return;
  const n = aliasSuggest.matches.length;
  aliasSuggest.selectedIdx = ((aliasSuggest.selectedIdx + delta) % n + n) % n;
  renderAliasSuggest();
}

function acceptAliasSuggestion() {
  const m = aliasSuggest.matches[Math.max(0, aliasSuggest.selectedIdx)];
  if (!m) return;
  const value = cmdInput.value;
  const cursorAt = cmdInput.selectionStart ?? value.length;
  // Fill the alias *name* (not the expansion). Tab is "complete the
  // token I'm typing" — the expansion is the remote shell's job at run
  // time (aliases are installed in the shell on connect, so `ll` runs
  // as `ls -ltr` server-side). The dropdown still shows the expansion
  // as preview text so the operator knows what `ll` will do.
  const tail = value.slice(cursorAt);
  const next = m.name + (tail.startsWith(' ') ? '' : ' ') + tail;
  cmdInput.value = next;
  const newPos = m.name.length + (tail.startsWith(' ') ? 0 : 1);
  cmdInput.setSelectionRange(newPos, newPos);
  hideAliasSuggest();
  cmdInput.focus();
  syncCmdInputState();
  autoGrow(cmdInput);
}

// ---------- Path completion (Level 2 Tab) ----------

/**
 * Try to start a path-completion request based on the token at the cursor.
 * Returns true if a request was sent (caller should preventDefault on Tab),
 * false if no path token / no server / no match conditions.
 */
function tryStartPathCompletion() {
  const value = cmdInput.value;
  const cursor = cmdInput.selectionStart ?? value.length;
  const head = value.slice(0, cursor);
  // Match the last whitespace-bounded run that *looks* like a path: starts
  // with `/` or `~`, contains path-safe chars. Conservative — won't catch
  // quoted paths with spaces, but those are rare in this UI.
  const m = head.match(/(?:^|\s)([\/~][\w\/.-]*)$/);
  if (!m) return false;
  const partial = m[1];
  const tokenStart = head.length - partial.length;
  // Pick the first selected server. Multi-server: extension uses this one
  // and operator can ESC if its filesystem doesn't match the others.
  const servers = Object.keys(state.cwdByServer || {});
  if (servers.length === 0) return false;
  const server = servers[0];
  pathSuggest.partial = partial;
  pathSuggest.tokenStart = tokenStart;
  pathSuggest.tokenEnd = cursor;
  pathSuggest.reqId = pathSuggestNextReqId++;
  vscode.postMessage({
    type: 'pathComplete',
    server,
    partial,
    reqId: pathSuggest.reqId
  });
  return true;
}

/**
 * Try to start a command-name completion at the first token. Called when
 * Tab is pressed and the cursor is on the first token AND the token isn't
 * a path-shaped prefix AND no alias matched the prefix. Fires `compgen -c`
 * on the first selected server. Reuses pathSuggest's dropdown UI.
 */
function tryStartCommandCompletion() {
  const value = cmdInput.value;
  const cursor = cmdInput.selectionStart ?? value.length;
  const head = value.slice(0, cursor);
  // First token only — no whitespace before the prefix.
  if (/\s/.test(head)) return false;
  // Must look like a command name (letters/digits/dash/underscore/dot only).
  if (!/^[A-Za-z0-9_.\-]+$/.test(head)) return false;
  const servers = Object.keys(state.cwdByServer || {});
  if (servers.length === 0) return false;
  pathSuggest.partial = head;
  pathSuggest.tokenStart = 0;
  pathSuggest.tokenEnd = cursor;
  pathSuggest.reqId = pathSuggestNextReqId++;
  vscode.postMessage({
    type: 'commandComplete',
    server: servers[0],
    prefix: head,
    reqId: pathSuggest.reqId
  });
  return true;
}

function onCommandCompleteResult(msg) {
  if (msg.reqId !== pathSuggest.reqId) return;
  if (msg.prefix !== pathSuggest.partial) return;
  if (msg.matches.length === 0) {
    hidePathSuggest();
    return;
  }
  // Reuse the path-suggest dropdown — same UI, same keyboard nav. Mark
  // every entry as `isDir: false` so the renderer doesn't append `/`.
  pathSuggest.matches = msg.matches.map(name => ({ name, isDir: false }));
  pathSuggest.selectedIdx = 0;
  if (pathSuggest.matches.length === 1) {
    acceptPathSuggestion();
  } else {
    pathSuggest.visible = true;
    renderPathSuggest();
  }
}

function onPathCompleteResult(msg) {
  // Drop stale responses (operator typed more after sending request).
  if (msg.reqId !== pathSuggest.reqId) return;
  if (msg.partial !== pathSuggest.partial) return;
  if (msg.matches.length === 0) {
    hidePathSuggest();
    return;
  }
  pathSuggest.matches = msg.matches;
  pathSuggest.selectedIdx = 0;
  // Single match → auto-accept; multi → show dropdown.
  if (msg.matches.length === 1) {
    acceptPathSuggestion();
  } else {
    pathSuggest.visible = true;
    renderPathSuggest();
  }
}

function movePathSelection(delta) {
  const n = pathSuggest.matches.length;
  if (n === 0) return;
  pathSuggest.selectedIdx = (pathSuggest.selectedIdx + delta + n) % n;
  renderPathSuggest();
}

function acceptPathSuggestion() {
  const m = pathSuggest.matches[pathSuggest.selectedIdx];
  if (!m) return;
  // Compute the replacement: parent + new basename (+ '/' if dir).
  const lastSlash = pathSuggest.partial.lastIndexOf('/');
  const parent = lastSlash >= 0 ? pathSuggest.partial.slice(0, lastSlash + 1) : '';
  const replacement = parent + m.name + (m.isDir ? '/' : '');
  const value = cmdInput.value;
  cmdInput.value =
    value.slice(0, pathSuggest.tokenStart) +
    replacement +
    value.slice(pathSuggest.tokenEnd);
  const newPos = pathSuggest.tokenStart + replacement.length;
  cmdInput.setSelectionRange(newPos, newPos);
  hidePathSuggest();
  cmdInput.focus();
  autoGrow(cmdInput);
  syncCmdInputState();
}

function hidePathSuggest() {
  if (!pathSuggest.visible && pathSuggest.matches.length === 0) return;
  pathSuggest.visible = false;
  pathSuggest.matches = [];
  pathSuggest.selectedIdx = -1;
  const dd = document.getElementById('pathSuggest');
  if (dd) dd.classList.add('hidden');
}

function renderPathSuggest() {
  let dd = document.getElementById('pathSuggest');
  if (!dd) {
    // Lazily create the dropdown container — same parent as alias suggest
    // so it positions over the cmd input area.
    const aliasDd = document.getElementById('aliasSuggest');
    dd = document.createElement('div');
    dd.id = 'pathSuggest';
    dd.className = 'alias-suggest hidden';
    aliasDd?.parentNode?.insertBefore(dd, aliasDd.nextSibling);
  }
  removeAllChildren(dd);
  pathSuggest.matches.forEach((m, i) => {
    const item = document.createElement('div');
    item.className = 'alias-item' + (i === pathSuggest.selectedIdx ? ' selected' : '');
    const name = document.createElement('span');
    name.className = 'alias-name';
    name.textContent = m.name + (m.isDir ? '/' : '');
    item.appendChild(name);
    item.onmouseenter = () => {
      pathSuggest.selectedIdx = i;
      renderPathSuggest();
    };
    item.onclick = () => {
      pathSuggest.selectedIdx = i;
      acceptPathSuggestion();
    };
    dd.appendChild(item);
  });
  dd.classList.remove('hidden');
}

function runRaw(cmd) {
  if (state.selectedCount === 0) {
    flashStatus('Tick at least one server in the sidebar first');
    return;
  }
  history.push(cmd);
  if (history.length > 200) history.shift();
  // The operator just initiated an action that produces output — they
  // want to see it. Reset auto-follow even if they had scrolled up to
  // read scrollback; otherwise the new ls / cd-and-ls / etc. lands
  // below the fold silently. Covers path-link clicks, bookmark clicks,
  // cwd-history dropdown picks, custom-ls Run, etc.
  autoFollow = true;
  vscode.postMessage({ type: 'runCommand', command: cmd });
}

// Breadcrumb / bookmark / right-click "go here" navigation: chains the cd
// with the user's currently-configured ls so the new directory's contents
// land in the output as a single combined operation.
// Session-only memory of where the operator has cd'd this session.
// Driven by `state.cwdCommon` updates rather than per-navigateToDir calls
// so all paths-to-cwd (home button `~`, path click, raw `cd /x` echo,
// schedule cd, broadcast cd) consistently land in history once the
// remote has acknowledged. `cwdMixed` (different cwd per server) is
// skipped — we only record well-defined common cwd.
const cwdHistory = [];
function rememberCwd(target) {
  if (!target) return;
  const idx = cwdHistory.indexOf(target);
  if (idx >= 0) cwdHistory.splice(idx, 1);
  cwdHistory.unshift(target);
  if (cwdHistory.length > 10) cwdHistory.length = 10;
}

function navigateToDir(target) {
  // history is updated via the post-cd state push (see applyState). Calling
  // rememberCwd here would record the literal `~` instead of the resolved
  // home path, leaving home stuck at the bottom forever.
  runRaw(`cd ${target} && ${computeLsCommand()}`);
}

function renderCwdHistoryDd() {
  const dd = document.getElementById('cwdHistoryDd');
  removeAllChildren(dd);
  if (cwdHistory.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cwd-dd-empty';
    empty.textContent = 'No recent directories yet — navigate via ★ bookmarks or path clicks to populate.';
    dd.appendChild(empty);
    return;
  }
  for (const path of cwdHistory) {
    const item = document.createElement('div');
    item.className = 'cwd-dd-item';
    item.textContent = path;
    item.title = `cd ${path} && ls`;
    item.onclick = () => {
      document.getElementById('cwdHistoryDd').classList.add('hidden');
      navigateToDir(path);
    };
    dd.appendChild(item);
  }
}

function runSpecial(line) {
  vscode.postMessage({ type: 'runSpecial', line });
}

/** Shorten an FQDN to its first label for display: `aaa.bbb.example.com`
 *  → `aaa`. Skips IPv4/IPv6 addresses (truncating `127.0.0.1` to `127`
 *  is useless) and short names without dots. Honours
 *  `state.shortenHostnames` — defaults true if state hasn't loaded yet
 *  (matches the schema default). */
function displayServerName(name) {
  if (!name) return name;
  if (state.shortenHostnames === false) return name;
  if (!name.includes('.')) return name;
  // IPv4 (all numeric labels separated by dots)
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(name)) return name;
  // IPv6 (contains ':')
  if (name.includes(':')) return name;
  return name.slice(0, name.indexOf('.'));
}

function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 240) + 'px';
}

/**
 * Detect shell-style line-continuation at the cursor: the last character
 * of the *current line* (the line containing the cursor) is a `\` that
 * isn't itself escaped by another `\`. Used to decide whether Enter
 * submits or extends the command.
 */
function endsInBackslashContinuation(textarea) {
  const cursor = textarea.selectionStart ?? textarea.value.length;
  const upToCursor = textarea.value.slice(0, cursor);
  const lineStart = upToCursor.lastIndexOf('\n') + 1;
  const lineSoFar = upToCursor.slice(lineStart);
  // Count trailing backslashes — odd count means the last `\` is unescaped
  // and acts as the continuation marker.
  let trailingBs = 0;
  for (let i = lineSoFar.length - 1; i >= 0 && lineSoFar[i] === '\\'; i--) trailingBs++;
  return trailingBs % 2 === 1;
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const v = textarea.value;
  textarea.value = v.slice(0, start) + text + v.slice(end);
  const pos = start + text.length;
  textarea.setSelectionRange(pos, pos);
}

function formatTs(ms) {
  const d = new Date(ms);
  const pad = (n) => n < 10 ? '0' + n : String(n);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function removeAllChildren(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

function copyToClipboard(s) {
  navigator.clipboard?.writeText(s).catch(() => {});
}

function flashStatus(text) {
  if (!runStatus) {
    // Header status row was removed — surface short warnings via the cmd
    // echo so the user still sees "tick at least one server" etc. instead
    // of silently dropping them.
    appendOutput({ kind: 'cmdWarn', text: `(${text})`, ts: Date.now() });
    return;
  }
  runStatus.textContent = text;
  setTimeout(() => { if (runStatus) runStatus.textContent = ''; }, 3000);
}

function dirOf(p) {
  if (!p.startsWith('/')) return '/';
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function basenameOf(p) {
  const trimmed = p.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

// ---------- Help modal ----------

function openHelpModal() {
  openModal('SSH Fleet — Help', (body) => {
    body.style.fontSize = '12px';
    body.style.lineHeight = '1.6';
    const sections = [
      ['Keyboard',
        'Enter — run command on selected servers',
        'Shift+Enter — newline in command',
        '↑ / ↓ — cycle command history',
        'Cmd/Ctrl+F (in output) — VSCode native search'
      ],
      ['Special : commands',
        ':tasks — list available tasks',
        ':run <task-name> — run a task on selected servers',
        ':se <remote-path> — open the file on each selected server',
        ':dl <remote-path> — download the file from each selected server',
        ':status — selection + connection summary',
        ':cwd — per-server cwd breakdown (when ~mixed~)',
        ':clear — clear console output',
        ':help — this list'
      ],
      ['Selection',
        'Tick boxes in TreeView (left sidebar) to choose targets.',
        'Group checkbox toggles all members.',
        'Title-bar 🔍 / filter actions narrow what\'s shown; hidden servers auto-deselect.'
      ],
      ['CWD bar',
        'Each segment is clickable: click "var" to cd /var, "log" to cd /var/log, etc.',
        '★ bookmarks current cwd · ↻ saved opens saved bookmark list.',
        '"ls ▾" dropdown builds and runs ls -ltrah variants.'
      ],
      ['Output',
        'Each command renders as a bordered block; modifying commands have a red header.',
        'Hover a block → ⎘ Copy on the right copies that block\'s output.',
        'Right-click a line → Copy / Open file / Cd / Bookmark / Open new tab for [server].',
        'Per-server tab filter shows only that server\'s lines + command echoes.'
      ],
      ['Files',
        'Cmd-click a path in output → file opens in editor / dir cd\'s.',
        'TreeView right-click on a server → Browse / Download / Mount / Upload.',
        'Group right-click → Open File on Selected Servers (split editors + Save All).'
      ],
      ['Ad-hoc / Schedule / Aliases',
        'Ad-hoc lock: tick the checkbox to enable cmd input for 60s.',
        '⏰ Schedule: run a periodic command on captured selection.',
        'Aliases: edit aliases inline and save back to active config YAML.'
      ]
    ];
    for (const [title, ...lines] of sections) {
      const h = document.createElement('div');
      h.style.fontWeight = '600';
      h.style.marginTop = '10px';
      h.style.color = 'var(--vscode-textLink-foreground)';
      h.textContent = title;
      body.appendChild(h);
      for (const line of lines) {
        const p = document.createElement('div');
        p.textContent = line;
        p.style.padding = '2px 0 2px 8px';
        body.appendChild(p);
      }
    }
  }, (footer) => {
    footer.appendChild(makeBtn('Close', 'primary', closeModal));
  });
}

// ---------- Output tab management ----------

function renderTabBar() {
  const bar = document.getElementById('outputTabs');
  if (!bar) return;
  removeAllChildren(bar);
  // Hide the bar entirely when only the implicit "Output" tab exists —
  // a single-tab strip is just chrome with no choice. Per-server tabs
  // (opened via right-click → "Open new tab for [server]") bring the bar
  // back automatically.
  if (tabs.size <= 1) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  for (const [id, tab] of tabs) {
    const el = document.createElement('div');
    el.className = 'output-tab' + (id === activeTabId ? ' active' : '') + (tab.warn ? ' warn' : '');
    el.dataset.tabId = id;
    const label = document.createElement('span');
    label.className = 'output-tab-label';
    label.textContent = tab.label;
    el.appendChild(label);
    if (id !== 'main') {
      const close = document.createElement('span');
      close.className = 'output-tab-close';
      close.textContent = '✕';
      close.title = `Close ${tab.label} tab`;
      close.onclick = (ev) => { ev.stopPropagation(); closeTab(id); };
      el.appendChild(close);
    }
    el.onclick = () => switchTab(id);
    bar.appendChild(el);
  }
}

// DOM cache per tab. Switching back to a previously-visited tab restores
// its DOM children directly instead of rebuilding from `outputLog` (which
// at 2000+ messages × ANSI parsing was visibly slow). New messages that
// arrived while the tab was inactive get caught up at switch time.
//
//   { children: Node[],   // detached DOM children, ready to re-attach
//     currentBlock,       // the cmd-block currently being appended into
//     logLen,             // outputLog length when cached (catch-up cursor)
//     domLineCount }      // .line nodes total — drives DOM cap
//
// Capped via FIFO eviction (Map preserves insertion order). Without
// this, every visited tab over a long session retains a full DOM tree
// and total node count multiplies. 3 tabs is enough for typical
// "Output + main server + secondary server" navigation; less-recent
// tabs rebuild on next visit at the cost of a one-time replay.
const tabDOMCache = new Map();
const MAX_CACHED_TABS = 3;
function trimTabCache() {
  while (tabDOMCache.size > MAX_CACHED_TABS) {
    const oldestKey = tabDOMCache.keys().next().value;
    tabDOMCache.delete(oldestKey);
  }
}

/** Invalidate all tab DOM caches. Called when outputLog is trimmed —
 *  the indexed catch-up cursor becomes meaningless once the front of
 *  the log is gone. Caches will rebuild on next switch (slow but rare). */
function invalidateAllTabCaches() {
  tabDOMCache.clear();
}

function switchTab(id) {
  if (!tabs.has(id) || activeTabId === id) {
    activeTabId = id;
    renderTabBar();
    return;
  }
  // Stash the current tab's DOM before tearing down — moving the children
  // out via removeAllChildren detaches them from the document but they
  // remain reachable from the cache, so swap-back is O(1) attach.
  if (activeTabId) {
    // Cache distance-from-bottom rather than scrollTop. For an append-
    // only log "I was N pixels above the latest line" is the meaningful
    // intent — and it survives the transient scrollTop=0 that
    // replaceChildren causes when the destination tab has a different
    // height during swap-in.
    const distFromBottom = Math.max(
      0,
      outputElem.scrollHeight - outputElem.clientHeight - outputElem.scrollTop
    );
    tabDOMCache.set(activeTabId, {
      children: Array.from(outputElem.childNodes),
      currentBlock,
      logLen: outputLog.length,
      domLineCount,
      distFromBottom,
      autoFollow,
    });
    trimTabCache();
  }
  activeTabId = id;
  const cached = tabDOMCache.get(id);
  // Suppress the scroll listener for the duration of this swap. Without
  // this guard, replaceChildren() momentarily forces scrollTop down (the
  // new content is shorter than the old until layout settles), then our
  // scrollTop= assignment fires a second event the listener interprets
  // as "scrolled DOWN, landed at bottom" → autoFollow=true. Repeating
  // the swap a few times pinned every tab to the bottom even though the
  // operator had scrolled them up.
  suppressAutoFollowScrollDepth++;
  // Cache is only valid when outputLog hasn't shrunk below the cursor.
  // Trim invalidates via `invalidateAllTabCaches`, so this check is
  // belt-and-braces.
  if (cached && cached.logLen <= outputLog.length) {
    // Atomic content swap. `replaceChildren(...nodes)` is a single DOM
    // operation: removes all existing children + attaches the new ones
    // in one tick. Replaces the previous "removeAllChildren + N×
    // appendChild" pattern that briefly painted an empty outputElem
    // (visible as flicker) and triggered N reflows.
    outputElem.replaceChildren(...cached.children);
    currentBlock = cached.currentBlock;
    domLineCount = cached.domLineCount;
    autoFollow = cached.autoFollow;
    // Replay catch-up FIRST so scrollHeight reflects final content; then
    // we can compute scrollTop from the cached distance-from-bottom.
    // Doing it the other way (scrollTop, then replay) means the bottom
    // moved out from under the operator during catch-up.
    const tab = tabs.get(id);
    for (let i = cached.logLen; i < outputLog.length; i++) {
      if (tab.filter(outputLog[i])) renderMessageInDomCore(outputLog[i]);
    }
    if (autoFollow) {
      forceScrollToBottom();
    } else {
      const target = outputElem.scrollHeight - outputElem.clientHeight - cached.distFromBottom;
      outputElem.scrollTop = Math.max(0, target);
    }
    lastScrollTop = outputElem.scrollTop;
  } else {
    // First visit (or cache invalidated) — build from scratch. Clear
    // outputElem first (atomic op), then render into the live tree.
    outputElem.replaceChildren();
    currentBlock = null;
    domLineCount = 0;
    autoFollow = true;
    const tab = tabs.get(id);
    for (const m of outputLog) {
      if (tab.filter(m)) renderMessageInDomCore(m);
    }
    // autoFollow=true was set above — trimAndScroll's autoFollow branch
    // handles the scroll-to-bottom.
    trimAndScroll();
    lastScrollTop = outputElem.scrollTop;
  }
  // Re-enable the listener after async scroll events from the swap have
  // flushed. A microtask isn't enough (scroll events are queued on the
  // task queue), so use a macrotask via setTimeout(_, 0).
  setTimeout(() => {
    lastScrollTop = outputElem.scrollTop;
    if (suppressAutoFollowScrollDepth > 0) suppressAutoFollowScrollDepth--;
  }, 0);
  renderTabBar();
}

function openTabFor(serverName) {
  const id = `server:${serverName}`;
  if (!tabs.has(id)) {
    tabs.set(id, {
      id,
      // Tab label honours the same shortening as the line prefix, with
      // the full hostname always available via the title attribute when
      // the tab bar renders.
      label: displayServerName(serverName),
      fullName: serverName,
      filter: (m) => m.serverName === serverName || m.kind === 'cmd' || m.kind === 'cmdWarn',
      warn: !!state.warnByServer?.[serverName]
    });
  }
  switchTab(id);
}

function closeTab(id) {
  if (id === 'main') return;
  tabs.delete(id);
  if (activeTabId === id) {
    switchTab('main');
  } else {
    renderTabBar();
  }
}

// ---------- Ad-hoc lock state machine ----------

const ADHOC_TIMEOUT_SEC = 60;
let adhocUnlocked = false;
let adhocSecondsLeft = 0;
let adhocCountdownHandle = null;

function unlockAdhoc() {
  adhocUnlocked = true;
  document.getElementById('cmdArea').classList.remove('locked');
  resetAdhocCountdown();
  cmdInput.focus();
}
function lockAdhoc() {
  adhocUnlocked = false;
  document.getElementById('cmdArea').classList.add('locked');
  document.getElementById('adhocToggle').checked = false;
  if (adhocCountdownHandle) {
    clearInterval(adhocCountdownHandle);
    adhocCountdownHandle = null;
  }
  document.getElementById('adhocCountdown').textContent = '';
  cmdInput.classList.remove('modifying');
  document.getElementById('modifyHint').classList.add('hidden');
}
function resetAdhocCountdown() {
  adhocSecondsLeft = ADHOC_TIMEOUT_SEC;
  document.getElementById('adhocCountdown').textContent = `${adhocSecondsLeft}s`;
  if (adhocCountdownHandle) clearInterval(adhocCountdownHandle);
  adhocCountdownHandle = setInterval(() => {
    adhocSecondsLeft -= 1;
    document.getElementById('adhocCountdown').textContent = `${adhocSecondsLeft}s`;
    if (adhocSecondsLeft <= 0) {
      lockAdhoc();
    }
  }, 1000);
}

// ---------- Realtime modifying-command detection (mirror of src/features/safety.ts) ----------

const MOD_COMMANDS = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'sed', 'chmod', 'chown', 'chgrp',
  'kill', 'killall', 'pkill', 'reboot', 'shutdown', 'halt', 'poweroff', 'init',
  'mkfs', 'fdisk', 'parted', 'dd',
  'userdel', 'useradd', 'usermod', 'groupdel', 'groupadd',
  'iptables', 'firewall-cmd', 'ufw',
  'yum', 'apt', 'apt-get', 'dnf', 'rpm', 'dpkg', 'pip', 'pip3'
]);
const MOD_PATTERNS = [
  /\bsystemctl\s+(restart|stop|start|enable|disable|reload)\b/,
  /\bservice\s+\S+\s+(restart|stop|start)\b/,
  /\brm\s/,
  /\bmkdir\b/,
  /\btee\b/,
  />[^>]/
];
function detectModifyingClient(cmd) {
  if (!cmd.trim()) return false;
  const parts = cmd.trim().split(/\s+/);
  const base = (parts[0] || '').split(/[\\/]/).pop() || '';
  if (MOD_COMMANDS.has(base)) return true;
  if (base === 'sudo' && parts[1]) {
    const sudoBase = parts[1].split(/[\\/]/).pop() || '';
    if (MOD_COMMANDS.has(sudoBase)) return true;
  }
  for (const re of MOD_PATTERNS) if (re.test(cmd)) return true;
  return false;
}

// ---------- Modal infrastructure ----------

function openModal(title, bodyBuilder, footerBuilder) {
  document.getElementById('modalTitle').textContent = title;
  const body = document.getElementById('modalBody');
  removeAllChildren(body);
  bodyBuilder(body);
  const footer = document.getElementById('modalFooter');
  removeAllChildren(footer);
  if (footerBuilder) footerBuilder(footer);
  document.getElementById('modalBackdrop').classList.remove('hidden');
}
function closeModal() {
  document.getElementById('modalBackdrop').classList.add('hidden');
}
function makeBtn(text, cls, onClick) {
  const b = document.createElement('button');
  b.className = `btn ${cls || ''}`;
  b.textContent = text;
  b.onclick = onClick;
  return b;
}

// ---------- Schedule modal ----------

// Cached for the always-visible header indicator and re-render of the modal.
let scheduleState = { enabled: false, intervalSec: 60, command: '', silent: false, lastTickAt: 0 };

function openScheduleModal() {
  vscode.postMessage({ type: 'scheduleGet' });
  openModal('Schedule a periodic command', (body) => {
    body.innerHTML = '';

    // Live status banner at the top — shows whether a schedule is running
    // RIGHT NOW (the modal can be opened to inspect current state without
    // restarting). Filled in on first scheduleStatus message.
    const live = document.createElement('div');
    live.id = 'schedLive';
    live.className = 'sched-live';
    body.appendChild(live);

    const explain = document.createElement('div');
    explain.className = 'info-line';
    explain.innerHTML =
      'Runs the command every N seconds against <b>all currently-connected servers</b>. ' +
      'Servers that connect later automatically join the rotation; disconnected servers drop out. ' +
      'Selection in the Servers tree does NOT affect targets.';
    body.appendChild(explain);

    const intervalLabel = document.createElement('label');
    intervalLabel.textContent = 'Interval (seconds, minimum 5)';
    body.appendChild(intervalLabel);
    const intervalInput = document.createElement('input');
    intervalInput.type = 'number';
    intervalInput.min = '5';
    intervalInput.id = 'schedInterval';
    intervalInput.value = '60';
    body.appendChild(intervalInput);
    const intervalNote = document.createElement('div');
    intervalNote.className = 'info-line';
    intervalNote.textContent =
      'Below 5s the runs overlap with their own SSH-channel handshake; pick something realistic for the command duration.';
    body.appendChild(intervalNote);

    const cmdLabel = document.createElement('label');
    cmdLabel.textContent = 'Command';
    body.appendChild(cmdLabel);
    const cmdField = document.createElement('textarea');
    cmdField.id = 'schedCmd';
    cmdField.rows = 3;
    cmdField.placeholder = 'uptime';
    body.appendChild(cmdField);

    // Silent-mode checkbox.
    const silentWrap = document.createElement('label');
    silentWrap.className = 'sched-silent';
    const silentBox = document.createElement('input');
    silentBox.type = 'checkbox';
    silentBox.id = 'schedSilent';
    silentWrap.appendChild(silentBox);
    silentWrap.appendChild(document.createTextNode(' Silent mode (suppress per-tick output; failures still print)'));
    body.appendChild(silentWrap);
  }, (footer) => {
    const stopBtn = makeBtn('Stop', 'danger', () => {
      vscode.postMessage({ type: 'scheduleStop' });
    });
    stopBtn.id = 'schedStopBtn';
    // Hidden by default — onScheduleStatus reveals it once it knows
    // a schedule is currently active. Avoids the "Not active + Stop"
    // mismatch where Stop has nothing to act on.
    stopBtn.classList.add('hidden');
    footer.appendChild(stopBtn);
    const startBtn = makeBtn('Start', 'primary', () => {
      const i = parseInt(document.getElementById('schedInterval').value, 10);
      const c = document.getElementById('schedCmd').value.trim();
      const silent = !!document.getElementById('schedSilent').checked;
      // Inline form validation — show errors INSIDE the modal so they
      // aren't hidden behind it (flashStatus's fallback path writes to
      // the output panel which is occluded by the modal backdrop).
      const showInModalError = (text) => {
        let err = document.getElementById('schedModalErr');
        if (!err) {
          err = document.createElement('div');
          err.id = 'schedModalErr';
          err.className = 'modal-error';
          // Insert at the very top of the modal body so it's the first
          // thing the operator sees on validation failure.
          const live = document.getElementById('schedLive');
          live?.parentNode?.insertBefore(err, live);
        }
        err.textContent = text;
      };
      if (!Number.isFinite(i) || i < 5) {
        showInModalError('Interval must be ≥ 5 seconds');
        return;
      }
      if (!c) {
        showInModalError('Command cannot be empty');
        return;
      }
      vscode.postMessage({ type: 'scheduleStart', intervalSec: i, command: c, silent });
      closeModal();
    });
    startBtn.id = 'schedStartBtn';
    footer.appendChild(startBtn);
    footer.appendChild(makeBtn('Cancel', '', closeModal));
  });
}

function onScheduleStatus(msg) {
  // Cache for the always-visible button label even when the modal is closed.
  scheduleState = {
    enabled: !!msg.enabled,
    intervalSec: msg.intervalSec,
    command: msg.command,
    silent: !!msg.silent,
    lastTickAt: msg.lastTickAt || 0
  };
  updateScheduleHeaderBadge();

  // Modal might be open — fill it in if the inputs exist.
  const i = document.getElementById('schedInterval');
  const c = document.getElementById('schedCmd');
  const live = document.getElementById('schedLive');
  const silent = document.getElementById('schedSilent');
  if (i) i.value = String(msg.intervalSec || 60);
  if (c) c.value = msg.command || '';
  if (silent) silent.checked = !!msg.silent;
  if (live) {
    if (msg.enabled) {
      const lastTxt = msg.lastTickAt
        ? ` · last tick ${humanAgo(msg.lastTickAt)}`
        : ' · waiting for first tick';
      live.className = 'sched-live active';
      live.innerHTML = `⏱ <b>Active</b> — every ${msg.intervalSec}s${msg.silent ? ' (silent)' : ''}${lastTxt}`;
    } else {
      live.className = 'sched-live';
      live.textContent = 'Not active.';
    }
  }
  // Stop button visibility tracks active state — no point offering it
  // when there's nothing to stop.
  const stopBtn = document.getElementById('schedStopBtn');
  if (stopBtn) stopBtn.classList.toggle('hidden', !msg.enabled);
  // When already running, "Start" actually means "replace current with
  // these params" — the underlying ScheduleStore.armTimer clears the
  // existing timer before arming the new one. Relabel to make that
  // intent explicit so operators don't think "wait, am I starting it
  // again?".
  const startBtn = document.getElementById('schedStartBtn');
  if (startBtn) startBtn.textContent = msg.enabled ? 'Update' : 'Start';
}

function updateScheduleHeaderBadge() {
  const btn = document.getElementById('btnSchedule');
  if (!btn) return;
  if (scheduleState.enabled) {
    btn.classList.add('sched-active');
    // Live target count = currently connected servers (the schedule runs
    // on all of them at each tick). Include in tooltip so the operator
    // can see "schedule is on and N hosts will receive each tick".
    const conn = state.connectedCount ?? 0;
    const lastLine = scheduleState.lastTickAt
      ? `\nLast tick: ${humanAgo(scheduleState.lastTickAt)}`
      : '\nWaiting for first tick.';
    btn.title =
      `Schedule ACTIVE\n` +
      `Command: ${scheduleState.command}\n` +
      `Interval: ${scheduleState.intervalSec}s${scheduleState.silent ? ' (silent)' : ''}\n` +
      `Targets: ${conn} currently-connected server(s)` +
      lastLine;
    // Compact "● 60s" — green dot is the active signal, interval is
    // the only useful info to keep visible. Full state lives in the
    // tooltip.
    removeAllChildren(btn);
    const dot = document.createElement('span');
    dot.className = 'sched-dot';
    dot.textContent = '●';
    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(` ${scheduleState.intervalSec}s`));
  } else {
    btn.classList.remove('sched-active');
    btn.title = 'Schedule a periodic command';
    btn.textContent = '⏰ Schedule';
  }
}

function humanAgo(ts) {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

// ---------- Aliases modal ----------

function openAliasesModal() {
  vscode.postMessage({ type: 'aliasesGet' });
  openModal('Aliases', (body) => {
    const info = document.createElement('div');
    info.className = 'info-line';
    info.textContent = 'Saved to the active config YAML. Server aliases install via shell on next connect.';
    body.appendChild(info);
    const table = document.createElement('table');
    table.id = 'aliasTable';
    body.appendChild(table);
    const addBtn = document.createElement('button');
    addBtn.className = 'btn';
    addBtn.textContent = '+ Add row';
    addBtn.style.marginTop = '6px';
    addBtn.onclick = () => addAliasRow('', '');
    body.appendChild(addBtn);
  }, (footer) => {
    footer.appendChild(makeBtn('Save', 'primary', () => {
      const aliases = collectAliases();
      vscode.postMessage({ type: 'aliasesSave', aliases });
      closeModal();
    }));
    footer.appendChild(makeBtn('Cancel', '', closeModal));
  });
}
function onAliasesList(msg) {
  const table = document.getElementById('aliasTable');
  if (!table) return;
  removeAllChildren(table);
  for (const [k, v] of Object.entries(msg.aliases)) {
    addAliasRow(k, v);
  }
  if (Object.keys(msg.aliases).length === 0) addAliasRow('', '');
}
function addAliasRow(key, value) {
  const table = document.getElementById('aliasTable');
  if (!table) return;
  const tr = document.createElement('tr');
  const tdKey = document.createElement('td');
  const inK = document.createElement('input');
  inK.type = 'text';
  inK.value = key;
  inK.placeholder = 'name';
  inK.style.width = '40%';
  tdKey.appendChild(inK);
  tr.appendChild(tdKey);

  const tdVal = document.createElement('td');
  const inV = document.createElement('input');
  inV.type = 'text';
  inV.value = value;
  inV.placeholder = 'expansion (e.g. ls -ltrah)';
  inV.style.width = '95%';
  tdVal.appendChild(inV);
  tr.appendChild(tdVal);

  const tdDel = document.createElement('td');
  tdDel.style.width = '20px';
  const del = document.createElement('button');
  del.className = 'row-del';
  del.textContent = '✕';
  del.onclick = () => tr.remove();
  tdDel.appendChild(del);
  tr.appendChild(tdDel);

  table.appendChild(tr);
}
function collectAliases() {
  const out = {};
  const table = document.getElementById('aliasTable');
  if (!table) return out;
  for (const tr of table.querySelectorAll('tr')) {
    const inputs = tr.querySelectorAll('input');
    const k = (inputs[0]?.value ?? '').trim();
    const v = (inputs[1]?.value ?? '').trim();
    if (k && v) out[k] = v;
  }
  return out;
}

