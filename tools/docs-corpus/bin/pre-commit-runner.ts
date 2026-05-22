#!/usr/bin/env -S node --experimental-strip-types
// pre-commit-runner — single entry point for the doc-corpus regression hooks.
//
// Composes the lib/ check functions into one process so the lefthook chain has
// one job per chain phase (path-canonical, mermaid-set-coherence, cite-target-
// existence) instead of three. Same coverage; one less layer of config.
//
// argv: zero or more file paths. Files are filtered to staged `.md` for the
// per-file checks (mermaid + cite); path-canonical-ripple runs unconditionally
// (it does its own whole-repo grep via the registry's `scope` globs).
//
// Cite-target-existence runs against the staged files PLUS any governance-
// corpus file whose outbound `:NNN` cites resolve into the staged set — see
// `../lib/inbound-cite-discovery.ts`. This widens local pre-commit coverage to
// match the inbound-ripple class CI's `custom-checks` repo-wide sweep catches.

import { statSync } from "node:fs";

import {
  checkCiteTargetExistence,
  formatCiteTargetViolations,
} from "../lib/cite-target-existence.ts";
import { expandToInboundCiteCorpus } from "../lib/inbound-cite-discovery.ts";
import { checkMermaidSetCoherence, formatMermaidViolations } from "../lib/mermaid-set-coherence.ts";
import {
  checkPathCanonicalRipple,
  formatPathRippleViolations,
} from "../lib/path-canonical-ripple.ts";

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

  if (stagedMd.length > 0) {
    const mermaidHits = checkMermaidSetCoherence(stagedMd);
    if (mermaidHits.length > 0) {
      messages.push(formatMermaidViolations(mermaidHits));
      exitCode = 1;
    }
    const expanded = expandToInboundCiteCorpus(stagedMd);
    const citeHits = checkCiteTargetExistence(expanded);
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
// doesn't trigger `process.exit`. `import.meta.url` is a file:// URL; argv[1]
// is the script path the runtime invoked. Match the resolved file paths so
// symlinked test layouts also bypass cleanly.
const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  process.exit(main());
}
