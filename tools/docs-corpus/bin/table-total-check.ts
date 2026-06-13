#!/usr/bin/env -S node --experimental-strip-types
// table-total-check — standalone arithmetic gate for `corpus:total-check` tables.
//
// Runs ONLY the table-total-coherence check over the argv-named `.md` files —
// deliberately NOT the full docs-corpus runner. It exists as its own entry
// point for two reasons:
//
//   1. Decomposition. The plan-readiness-audit runbook's gate G7 is named for
//      "table-total arithmetic clean." A gate with that name must red-light ONLY
//      on a table-total mismatch — not on an unrelated mermaid, cite-target, or
//      manifest finding the full runner also reports. Routing G7 through the
//      whole runner would conflate "every marked table reconciles" with "every
//      docs-corpus check passes."
//   2. Path safety on pre-swap working copies. G7 runs BEFORE the audit swaps
//      working copies into the corpus, so its inputs are files under
//      `.agents/tmp/.../working/`. The full runner's cite-target-existence
//      resolves `../specs/...`-relative links from each file's own directory,
//      which under that base points outside the corpus and mints false
//      missing-target failures — blocking G7 even when the arithmetic is clean.
//      table-total-coherence is within-document only: it reads each file's own
//      bytes and resolves nothing relative, so it is correct wherever the
//      working copy lives.
//
// argv: zero or more file paths; non-`.md` and unreadable paths are skipped.
// Exits 1 if any marked table fails to reconcile (or carries a malformed
// marker), 0 otherwise. See `../lib/table-total-coherence.ts` for the check and
// the marker convention.

import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  checkTableTotalCoherence,
  formatTableTotalViolations,
} from "../lib/table-total-coherence.ts";

function isMdFile(path: string): boolean {
  try {
    return statSync(path).isFile() && path.endsWith(".md");
  } catch {
    return false;
  }
}

export interface RunResult {
  exitCode: number;
  message: string;
}

export function runTableTotalCheck(args: string[]): RunResult {
  const mdFiles = args.filter(isMdFile);
  const violations = checkTableTotalCoherence(mdFiles);
  if (violations.length === 0) {
    return { exitCode: 0, message: "" };
  }
  return { exitCode: 1, message: formatTableTotalViolations(violations) };
}

function main(): number {
  const { exitCode, message } = runTableTotalCheck(process.argv.slice(2));
  if (message.length > 0) {
    console.error(message);
  }
  return exitCode;
}

// Direct-invocation guard so `import { runTableTotalCheck } from "..."` in tests
// doesn't trigger `process.exit`. Compare via `realpathSync` so symlinked
// invocations match (the macOS `/tmp` → `/private/tmp` case and any repo checked
// out under a symlink). A silent guard misfire would disable G7's arithmetic
// gate — the vacuous-pass failure mode this check exists to prevent.
function isDirectlyInvoked(): boolean {
  const arg = process.argv[1];
  if (typeof arg !== "string") return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectlyInvoked()) {
  process.exit(main());
}
