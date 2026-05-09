function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

export function timestamp(): string {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

const MAX_LINE_BYTES = 4096;

export function clipLine(line: string): { text: string; clipped: boolean } {
  if (Buffer.byteLength(line, 'utf-8') <= MAX_LINE_BYTES) {
    return { text: line, clipped: false };
  }
  // Slice by codepoints, not bytes — close enough for visual purposes.
  return {
    text: line.slice(0, MAX_LINE_BYTES) + ' …[truncated; open Terminal for full output]',
    clipped: true
  };
}

export function prefixLines(label: string, chunk: string, kind: 'stdout' | 'stderr'): string[] {
  const out: string[] = [];
  const ts = timestamp();
  const tag = kind === 'stderr' ? ' err' : '';
  for (const raw of chunk.split('\n')) {
    if (raw === '') {
      continue;
    }
    const { text } = clipLine(raw.replace(/\r$/, ''));
    out.push(`[${label}]${tag} ${ts} │ ${text}`);
  }
  return out;
}
