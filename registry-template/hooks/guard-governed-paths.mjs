#!/usr/bin/env node
/**
 * PreToolUse guard: refuse AI-assisted edits to governed content.
 *
 * This is a convenience layer, not a security boundary — a developer can edit
 * those files by hand, and CI will catch it. What this prevents is the common
 * accident: an agent "helpfully" relaxing a rule in .governance/ while fixing
 * an unrelated finding, and nobody noticing until the merge is blocked.
 *
 * Reads the PreToolUse payload on stdin, writes a permission decision on stdout.
 */

const PROTECTED = [
  /(^|\/)\.governance\//,
  /(^|\/)governance\.json$/,
  /(^|\/)\.github\/workflows\/governance-verify\.yml$/,
  /(^|\/)CODEOWNERS$/,
];

const FIX_HINT =
  "Governed content is centrally managed. To change a rule, open a PR against the governance registry; " +
  "to update this project, run 'govctl sync'. To repair a local edit, run 'govctl restore'.";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function pathsFrom(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return [];
  const out = [];
  for (const key of ['file_path', 'notebook_path', 'path']) {
    if (typeof toolInput[key] === 'string') out.push(toolInput[key]);
  }
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (edit && typeof edit.file_path === 'string') out.push(edit.file_path);
    }
  }
  return out;
}

function allow() {
  process.stdout.write('{}');
  process.exit(0);
}

const raw = await readStdin();

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  // Fail open on a malformed payload: this hook must never wedge a session.
  // The authoritative check runs server-side regardless.
  allow();
}

const targets = pathsFrom(payload.tool_input);
const blocked = targets.find((p) => PROTECTED.some((re) => re.test(p.replace(/\\/g, '/'))));

if (!blocked) allow();

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${blocked} is governed content and cannot be edited in place. ${FIX_HINT}`,
    },
  }),
);
process.exit(0);
