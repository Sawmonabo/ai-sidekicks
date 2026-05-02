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

import { statSync } from "node:fs";

import {
  checkCiteTargetExistence,
  formatCiteTargetViolations,
} from "../lib/cite-target-existence.ts";
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

function main(): number {
  const stagedMd = process.argv.slice(2).filter(isMdFile);
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
    const citeHits = checkCiteTargetExistence(stagedMd);
    if (citeHits.length > 0) {
      messages.push(formatCiteTargetViolations(citeHits));
      exitCode = 1;
    }
  }

  if (messages.length > 0) {
    console.error(messages.join("\n\n"));
  }
  return exitCode;
}

process.exit(main());
