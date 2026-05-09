/**
 * Build a shell snippet that installs the configured aliases.
 *
 * Aliases are installed inside the remote shell (POSIX-compatible `alias`
 * builtin) so they work for the entire interactive session — vim, top,
 * tab completion, history all behave the same as if the user had set
 * the alias in their own ~/.bashrc.
 *
 * Returns an empty string when there are no aliases to install.
 */
export function aliasInitScript(aliases: Record<string, string>): string {
  const entries = Object.entries(aliases);
  if (entries.length === 0) {
    return '';
  }
  const lines = entries.map(([name, value]) => {
    const escaped = value.replace(/'/g, `'\\''`);
    return `alias ${name}='${escaped}'`;
  });
  return lines.join('; ');
}
