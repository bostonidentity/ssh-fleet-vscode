// Detection of "interactive" (TTY-required) and "modifying" (destructive) commands.

const INTERACTIVE_COMMANDS = new Set([
  // Monitors / TUI dashboards
  'top', 'htop', 'iotop', 'atop', 'nmon', 'glances',
  // Editors
  'vi', 'vim', 'nvim', 'nano', 'emacs', 'pico', 'joe', 'mcedit',
  // Pagers
  'less', 'more', 'man',
  // Network / file
  'ssh', 'telnet', 'ftp', 'sftp', 'mc',
  // Multiplexers
  'screen', 'tmux', 'byobu',
  // Auth / privilege escalation that always prompts
  'passwd', 'su',
  // Interactive system editors
  'visudo', 'vipw',
  // Debuggers
  'gdb', 'lldb'
]);

/** Commands that are interactive ONLY when invoked bare (no script /
 *  -c / -e / file argument). With those flags they run non-interactively
 *  and finish — so we only block when the operator typed *just* the
 *  command name and possibly minor connection flags (e.g. `mysql -h x`
 *  alone would still prompt for password). The `parts.length === 1`
 *  check is a deliberate trade-off: false negatives for "mysql -h x"
 *  beats false positives for "mysql -e 'select 1'". */
const BARE_INTERACTIVE_COMMANDS = new Set([
  // Database REPLs
  'mysql', 'psql', 'redis-cli', 'mongo', 'mongosh', 'sqlite3',
  // Language REPLs
  'python', 'python3', 'node', 'irb', 'ruby', 'php', 'lua',
  // Calculators
  'bc', 'dc',
  // Misc interactive
  'nslookup'
]);

const INTERACTIVE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\btail\b.*\s-[^\s]*f/, 'tail -f (follow mode)'],
  [/\bping\b(?!.*\s-c\b)/, 'ping without -c'],
  [/\bwatch\b/, 'watch'],
  [/\bcrontab\s+-e\b/, 'crontab -e'],
  [/\bsudo\s+-[isI]\b/, 'sudo -i / -s (interactive shell)']
];

const MODIFYING_COMMANDS = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'sed', 'chmod', 'chown', 'chgrp',
  'kill', 'killall', 'pkill',
  'reboot', 'shutdown', 'halt', 'poweroff', 'init',
  'mkfs', 'fdisk', 'parted', 'dd',
  'userdel', 'useradd', 'usermod', 'groupdel', 'groupadd',
  'iptables', 'firewall-cmd', 'ufw',
  'yum', 'apt', 'apt-get', 'dnf', 'rpm', 'dpkg', 'pip', 'pip3'
]);

const MODIFYING_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsystemctl\s+(restart|stop|start|enable|disable|reload)\b/,
  /\bservice\s+\S+\s+(restart|stop|start)\b/,
  /\brm\s/,
  /\bmkdir\b/,
  /\btee\b/,
  />[^>]/  // overwrite redirect, but not >>
];

const SHELL_SPLIT = /\s*(?:\|\||&&|[|;])\s*/;

function baseName(token: string): string {
  return token.split(/[\\/]/).pop() ?? token;
}

/** Returns a human-readable reason if the command needs an interactive TTY. */
export function detectInteractive(command: string): string | undefined {
  if (!command.trim()) {
    return undefined;
  }
  for (const sub of command.trim().split(SHELL_SPLIT)) {
    const parts = sub.trim().split(/\s+/);
    if (parts.length === 0 || !parts[0]) {
      continue;
    }
    const base = baseName(parts[0]);
    if (INTERACTIVE_COMMANDS.has(base)) {
      return base;
    }
    // REPLs are interactive ONLY when bare. `mysql` alone → block;
    // `mysql -e "select 1"` → pass through.
    if (BARE_INTERACTIVE_COMMANDS.has(base) && parts.length === 1) {
      return `${base} (REPL — pass -e/-c or a script file)`;
    }
  }
  for (const [re, label] of INTERACTIVE_PATTERNS) {
    if (re.test(command)) {
      return label;
    }
  }
  return undefined;
}

/** Shell builtins that produce surprising results over non-interactive
 *  SSH (the dispatch mode we use). These all run without error but
 *  return empty / useless output because the relevant shell state
 *  (history list, job table, dir stack, alias table) isn't populated
 *  in a non-interactive shell.
 *
 *  We don't block these — operator might be running them deliberately
 *  to confirm the empty state — but we surface a hint so they aren't
 *  left wondering "why is the output blank?".
 */
const SHELL_BUILTIN_HINTS: Record<string, string> = {
  history: 'history is a shell builtin and the in-memory list is empty over non-interactive SSH. Try `cat ~/.bash_history` or `tail -n 100 ~/.bash_history` instead.',
  fc: 'fc reads the in-memory history list which is empty over non-interactive SSH. Try `cat ~/.bash_history` instead.',
  alias: 'alias only shows results in an interactive shell. Try `bash -ic alias` to force interactive mode, or grep your shell rc files (e.g. `grep -E "^alias" ~/.bashrc`).',
  jobs: 'jobs shows processes of the current interactive shell — non-interactive SSH has none. Try `ps -ef | grep <pattern>` for remote process listing.',
  dirs: 'dirs shows the directory stack of the current interactive shell — non-interactive SSH has none.'
};

export interface ShellBuiltinHint {
  /** The matched builtin name. */
  name: string;
  /** Human-readable explanation + suggested alternative. */
  hint: string;
}

/** Returns a hint if the command's first token is a known builtin that
 *  produces surprising results over non-interactive SSH. */
export function detectShellBuiltinPitfall(command: string): ShellBuiltinHint | undefined {
  if (!command.trim()) return undefined;
  // Walk left-to-right past leading env-var assignments (`FOO=1 history`).
  const tokens = command.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (i >= tokens.length) return undefined;
  const head = baseName(tokens[i]);
  // sudo passes through to its argument's basename.
  const target = head === 'sudo' && tokens[i + 1] ? baseName(tokens[i + 1]) : head;
  const hint = SHELL_BUILTIN_HINTS[target];
  if (hint) return { name: target, hint };
  return undefined;
}

/** Commands that read from stdin and would hang the SSH session forever
 *  waiting for input we never send. The dispatch path doesn't allocate
 *  stdin, so these commands sit blocked until our task timeout fires
 *  (60s default) — wasting an entire run window per attempt. We surface
 *  a hint and let the operator cancel/retype rather than wait.
 *
 *  Detection is conservative: only the most obvious cases. `xargs` /
 *  `grep` / `sort` are skipped because they're nearly always used in
 *  pipe contexts where stdin DOES have input.
 */
export interface StdinBlockingHint {
  name: string;
  hint: string;
}

export function detectStdinBlocking(command: string): StdinBlockingHint | undefined {
  if (!command.trim()) return undefined;
  // Walk each `&&`/`||`/`;`-separated chain. Within each chain, only the
  // FIRST command of a pipeline (`|`) reads stdin from us — later piped
  // commands get input from the prior command's stdout, so they're fine.
  const chains = command.trim().split(/\s*(?:&&|\|\||;)\s*/);
  for (const chain of chains) {
    const firstPipeStage = chain.split(/\s*\|\s*/)[0]?.trim() ?? '';
    if (!firstPipeStage) continue;
    const tokens = firstPipeStage.split(/\s+/);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    const cmd = tokens[i];
    if (!cmd) continue;
    const base = baseName(cmd);
    const argCount = tokens.length - i - 1;
    // `read` (bash builtin) — always reads stdin, no file-arg form.
    if (base === 'read') {
      return {
        name: 'read',
        hint: '`read` is a shell builtin that waits for stdin — non-interactive SSH never provides any, so the command will hang until task timeout. Use `read VAR < file` if you need to read from a file.'
      };
    }
    // Bare `cat` (no file args) reads stdin.
    if (base === 'cat' && argCount === 0) {
      return {
        name: 'cat',
        hint: 'Bare `cat` reads stdin which non-interactive SSH does not provide — it will hang until task timeout. Pass a file: `cat /path/to/file`.'
      };
    }
    // `tee` always reads stdin. If `tee FILE` is the FIRST stage of its
    // chain, no piped input → hangs. (`echo x | tee f` is fine: tee is
    // not the first stage there.)
    if (base === 'tee') {
      return {
        name: 'tee',
        hint: '`tee` reads stdin which non-interactive SSH does not provide. Pipe input first, e.g. `echo "hello" | tee /tmp/file`.'
      };
    }
  }
  return undefined;
}

/** Returns true if the command is likely to modify state on the remote host. */
export function detectModifying(command: string): boolean {
  if (!command.trim()) {
    return false;
  }
  const parts = command.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) {
    return false;
  }
  const base = baseName(parts[0]);
  if (MODIFYING_COMMANDS.has(base)) {
    return true;
  }
  if (base === 'sudo' && parts[1]) {
    if (MODIFYING_COMMANDS.has(baseName(parts[1]))) {
      return true;
    }
  }
  for (const re of MODIFYING_PATTERNS) {
    if (re.test(command)) {
      return true;
    }
  }
  return false;
}

/** fnmatch-style glob match — wildcards * ? [abc]. */
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
}
