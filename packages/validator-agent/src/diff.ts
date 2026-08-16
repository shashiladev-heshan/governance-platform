/**
 * Minimal unified-diff parser. Deliberately dependency-free and deliberately
 * dumb: it only needs to answer "which files changed, and what are the added
 * lines", because that is all the agent is allowed to look at.
 */

export interface FileDiff {
  path: string;
  hunks: Hunk[];
  addedLines: number;
  text: string;
}

export interface Hunk {
  /** First line number in the NEW file for this hunk. */
  newStart: number;
  lines: string[];
}

/** Paths never worth agent tokens — generated, vendored, or governed content. */
const SKIP_PATTERNS: RegExp[] = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)coverage\//,
  /(^|\/)\.governance\//,
  /(^|\/)vendor\//,
  /\.(lock|snap|min\.js|map)$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /\.(png|jpg|jpeg|gif|svg|ico|pdf|woff2?)$/i,
  /(^|\/)generated\//,
  /\.generated\.[a-z]+$/,
];

/** Only these are reviewed — the skills are about TypeScript services. */
const REVIEWABLE = /\.(ts|tsx|js|jsx|mts|cts)$/;

export function shouldSkip(path: string): boolean {
  if (SKIP_PATTERNS.some((re) => re.test(path))) return true;
  return !REVIEWABLE.test(path);
}

export function parseDiff(text: string): { files: FileDiff[]; skipped: string[] } {
  const files: FileDiff[] = [];
  const skipped: string[] = [];

  let current: FileDiff | null = null;
  let currentHunk: Hunk | null = null;

  const flush = (): void => {
    if (!current) return;
    if (shouldSkip(current.path)) skipped.push(current.path);
    else if (current.addedLines > 0) files.push(current);
    current = null;
    currentHunk = null;
  };

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      const path = parseGitHeaderPath(line);
      current = path ? { path, hunks: [], addedLines: 0, text: '' } : null;
      continue;
    }

    if (!current) continue;

    // `+++ b/path` is authoritative for renames; prefer it when present.
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).replace(/^b\//, '').trim();
      if (path && path !== '/dev/null') current.path = path;
      continue;
    }
    if (line.startsWith('--- ')) continue;

    if (line.startsWith('@@')) {
      const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      currentHunk = { newStart: match ? Number(match[1]) : 1, lines: [] };
      current.hunks.push(currentHunk);
      current.text += line + '\n';
      continue;
    }

    if (currentHunk) {
      currentHunk.lines.push(line);
      current.text += line + '\n';
      if (line.startsWith('+') && !line.startsWith('+++')) current.addedLines++;
    }
  }
  flush();

  return { files, skipped };
}

function parseGitHeaderPath(line: string): string | null {
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  return match?.[2] ?? null;
}

/**
 * Group files into review chunks. Files are reviewed together when they are
 * small, so the agent can see a controller and its service in one pass — that
 * context is exactly what the layering rules need.
 */
export function chunkFiles(files: FileDiff[], maxCharsPerChunk = 12_000): FileDiff[][] {
  const chunks: FileDiff[][] = [];
  let current: FileDiff[] = [];
  let size = 0;

  for (const file of files) {
    const fileSize = file.text.length;
    if (current.length > 0 && size + fileSize > maxCharsPerChunk) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += fileSize;
  }
  if (current.length) chunks.push(current);

  return chunks;
}

/** Render a chunk for the prompt, annotated with new-file line numbers. */
export function renderChunk(files: FileDiff[]): string {
  const parts: string[] = [];
  for (const file of files) {
    parts.push(`FILE: ${file.path}`);
    for (const hunk of file.hunks) {
      let lineNo = hunk.newStart;
      parts.push(`  @@ new file lines from ${hunk.newStart} @@`);
      for (const line of hunk.lines) {
        if (line.startsWith('-')) {
          parts.push(`  ---      | ${line.slice(1)}`);
        } else if (line.startsWith('+')) {
          parts.push(`  +${String(lineNo).padStart(6)} | ${line.slice(1)}`);
          lineNo++;
        } else {
          parts.push(`   ${String(lineNo).padStart(6)} | ${line.slice(1)}`);
          lineNo++;
        }
      }
    }
    parts.push('');
  }
  return parts.join('\n');
}
