#!/usr/bin/env -S node --experimental-strip-types
// pre-commit-runner — single entry point for the doc-corpus regression hooks.
//
// Composes the lib/ check functions into one process so the lefthook chain has
// one job instead of one per check (path-canonical-ripple, plan-manifest-
// presence, mermaid-set-coherence, cite-target-existence). Same coverage; one
// less layer of config.
//
// argv: zero or more file paths. Files are filtered to staged `.md` for the
// per-file checks (mermaid + cite); path-canonical-ripple and plan-manifest-
// presence run unconditionally (each does its own whole-repo enumeration —
// path-ripple greps the registry `scope` globs, manifest-presence walks
// `git ls-files docs/plans/`).
//
// Cite-target-existence runs against the staged files PLUS any governance-
// corpus file whose outbound `:NNN` cites resolve into the staged set — see
// `../lib/inbound-cite-discovery.ts`. This widens local pre-commit coverage to
// match the inbound-ripple class CI's `custom-checks` repo-wide sweep catches.

import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkCiteTargetExistence,
  formatCiteTargetViolations,
} from "../lib/cite-target-existence.ts";
import {
  expandToInboundCiteCorpus,
  getRepoRoot,
  makeIndexAwareReader,
} from "../lib/inbound-cite-discovery.ts";
import { checkMermaidSetCoherence, formatMermaidViolations } from "../lib/mermaid-set-coherence.ts";
import {
  checkPathCanonicalRipple,
  formatPathRippleViolations,
} from "../lib/path-canonical-ripple.ts";
import {
  checkPlanManifestPresence,
  formatPlanManifestViolations,
} from "../lib/plan-manifest-presence.ts";

function isMdFile(p: string): boolean {
  try {
    return statSync(p).isFile() && p.endsWith(".md");
  } catch {
    return false;
  }
}

// Per-file checks (mermaid + cite) are scoped to governance corpus only.
// `docs/archive/` is frozen historical content (CLAUDE.md "Documentation
// Corpus") and `docs/reference/` is excerpted upstream materials (CLAUDE.md
// non-governance docs). Citations there describe other projects' source
// files, not ours, so cite-target-existence's missing-target check would
// generate false positives on path-shapes that happen to coincide with our
// own. path-canonical-ripple has its own per-entry scope/exclude in the
// registry and is unaffected.
const PER_FILE_CHECK_EXCLUDED_PREFIXES = ["docs/archive/", "docs/reference/"];

function isInGovernanceCorpus(p: string): boolean {
  return !PER_FILE_CHECK_EXCLUDED_PREFIXES.some((prefix) => p.startsWith(prefix));
}

export interface RunChecksResult {
  exitCode: number;
  messages: string[];
}

export function runChecks(args: string[]): RunChecksResult {
  const stagedMd = args.filter(isMdFile).filter(isInGovernanceCorpus);
  const messages: string[] = [];
  let exitCode = 0;

  const pathHits = checkPathCanonicalRipple();
  if (pathHits.length > 0) {
    messages.push(formatPathRippleViolations(pathHits));
    exitCode = 1;
  }

  // Whole-repo, like path-canonical-ripple above: enforces a parseable Shipment
  // Manifest on every dispatchable plan regardless of which files are staged, so
  // a plan can never reach review/approved/completed without one (preflight
  // Gate 3 would otherwise HALT mid-run).
  const manifestHits = checkPlanManifestPresence();
  if (manifestHits.length > 0) {
    messages.push(formatPlanManifestViolations(manifestHits));
    exitCode = 1;
  }

  if (stagedMd.length > 0) {
    const mermaidHits = checkMermaidSetCoherence(stagedMd);
    if (mermaidHits.length > 0) {
      messages.push(formatMermaidViolations(mermaidHits));
      exitCode = 1;
    }
    // Argv-staged paths read the working tree (the developer's explicit
    // opt-in); auto-expanded citers read the git index (`git show :path`) so
    // unstaged WIP and worktree-only deletions do not leak into validation.
    // Build the reader once and share it across expansion + cite-checking.
    const repoRoot = getRepoRoot();
    const stagedAbsolute = new Set(stagedMd.map((p) => resolve(p)));
    const reader = makeIndexAwareReader(repoRoot, stagedAbsolute);
    const expanded = expandToInboundCiteCorpus(stagedMd, repoRoot, reader);
    const citeHits = checkCiteTargetExistence(expanded, reader);
    if (citeHits.length > 0) {
      messages.push(formatCiteTargetViolations(citeHits));
      exitCode = 1;
    }
  }

  return { exitCode, messages };
}

function main(): number {
  const { exitCode, messages } = runChecks(process.argv.slice(2));
  if (messages.length > 0) {
    console.error(messages.join("\n\n"));
  }
  return exitCode;
}

// Direct-invocation guard so `import { runChecks } from "..."` in tests
// doesn't trigger `process.exit`. Compare via `realpathSync` so symlinked
// invocations match (string-comparing `file://${argv[1]}` against
// `import.meta.url` fails on macOS `/tmp` → `/private/tmp` and any repo
// checked out under a symlink — the URL resolves symlinks, raw argv[1] does
// not). Silent guard misfire would disable every pre-commit check.
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
