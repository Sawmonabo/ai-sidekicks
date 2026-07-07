#!/usr/bin/env -S node --experimental-strip-types
// pre-commit-runner — single entry point for the doc-corpus regression hooks.
//
// Composes the lib/ check functions into one process so the lefthook chain has
// one job instead of one per check (path-canonical-ripple, plan-manifest-
// presence, mermaid-set-coherence, cite-target-existence). Same coverage; one
// less layer of config.
//
// argv: zero or more file paths, partitioned by extension into two disjoint
// per-file lanes: staged `.md` governance docs (mermaid + cite) and staged
// `packages/**`+`apps/**` TypeScript (the label-cite floor).
// path-canonical-ripple and plan-manifest-presence run unconditionally (each
// does its own whole-repo enumeration — path-ripple greps the registry `scope`
// globs, manifest-presence walks `git ls-files docs/plans/`).
//
// Cite-target-existence runs against the staged `.md` files PLUS any
// governance-corpus file whose outbound `:NNN` cites resolve into the staged
// set — see `../lib/inbound-cite-discovery.ts`. This widens local pre-commit
// coverage to match the inbound-ripple class CI's `custom-checks` repo-wide
// sweep catches.
//
// label-cite runs against staged code files: governance LABEL cites
// (`Spec-NNN:LL`) in comments get the SAME deterministic floor as markdown
// `file.md:NNN` cites — closing the gap where a spec amendment silently
// invalidated code-comment line cites (PR #139). See `../lib/label-cite.ts`.
//
// table-total-coherence runs against staged `.md` files: a breakdown table
// marked `<!-- corpus:total-check column="..." -->` has that column re-summed
// and reconciled against the in-table **Total** row and any declared prose
// total — failing the census-drift class from the PR #152 retrospective (a
// summary asserting a count while its own column summed to a different one).
// Opt-in by marker, within-document only. See `../lib/table-total-coherence.ts`.

import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkCiteTargetExistence,
  formatCiteTargetViolations,
} from "../lib/cite-target-existence.ts";
import {
  expandToInboundCiteCorpus,
  findGovernanceCitersOfCode,
  getRepoRoot,
  makeIndexAwareReader,
} from "../lib/inbound-cite-discovery.ts";
import {
  checkLabelCiteTargets,
  checkSectionCites,
  extractLabelCites,
  formatLabelCiteViolations,
} from "../lib/label-cite.ts";
import { checkMermaidSetCoherence, formatMermaidViolations } from "../lib/mermaid-set-coherence.ts";
import {
  checkPathCanonicalRipple,
  formatPathRippleViolations,
} from "../lib/path-canonical-ripple.ts";
import {
  checkPlanManifestPresence,
  formatPlanManifestViolations,
} from "../lib/plan-manifest-presence.ts";
import {
  checkTableTotalCoherence,
  formatTableTotalViolations,
} from "../lib/table-total-coherence.ts";

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

// Code files carry governance LABEL cites (`Spec-NNN:LL`) in comments; they get
// the deterministic floor via label-cite, NOT the markdown-only per-file checks
// (mermaid, inbound-expansion). Scoped to first-party TypeScript under
// `packages/` + `apps/`; `dist/` is generated output and `.d.ts` are emitted
// declarations — neither hand-authored, so both are excluded to keep the
// required gate to source a developer actually edits.
const CODE_FILE_RE = /\.(ts|tsx|mts|cts)$/;

function isCodeFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
  } catch {
    return false;
  }
  if (!CODE_FILE_RE.test(p) || p.endsWith(".d.ts")) return false;
  if (p.includes("/dist/") || p.startsWith("dist/")) return false;
  return p.startsWith("packages/") || p.startsWith("apps/");
}

export interface RunChecksResult {
  exitCode: number;
  messages: string[];
}

export function runChecks(args: string[]): RunChecksResult {
  const stagedMd = args.filter(isMdFile).filter(isInGovernanceCorpus);
  const stagedCode = args.filter(isCodeFile);
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
  }

  // Arithmetic guard for opt-in `<!-- corpus:total-check ... -->` breakdown
  // tables: re-sum the marked column and reconcile it against the in-table
  // **Total** row and any declared prose total. Closes the F-4 gap from the
  // PR #152 retrospective (a census summary that drifted from its own column).
  if (stagedMd.length > 0) {
    const totalHits = checkTableTotalCoherence(stagedMd);
    if (totalHits.length > 0) {
      messages.push(formatTableTotalViolations(totalHits));
      exitCode = 1;
    }
  }

  // Cite-target floor for BOTH surfaces (markdown `file.md:NNN` + code
  // `Spec-NNN:LL`) shares one index-aware reader so a commit that amends a
  // spec AND fixes its dependent cites validates the STAGED spec, not the
  // worktree. Argv-staged paths (md + code) read the working tree (the
  // developer's explicit opt-in); auto-expanded governance citers read the git
  // index (`git show :path`) so unstaged WIP and worktree-only deletions do not
  // leak into validation. Build the reader once and share it across both.
  if (stagedMd.length > 0 || stagedCode.length > 0) {
    const repoRoot = getRepoRoot();
    const stagedAbsolute = new Set([...stagedMd, ...stagedCode].map((p) => resolve(p)));
    const reader = makeIndexAwareReader(repoRoot, stagedAbsolute);

    if (stagedMd.length > 0) {
      // §-form citers reach the expansion via the extractor callback — their
      // cite shape lives in label-cite, not extractCites (a staged heading
      // rename must pull in the unstaged `Spec-NNN §Old Heading` citer).
      const sectionCiteTargets = (candidate: string): string[] =>
        extractLabelCites(candidate, reader)
          .filter((cite) => cite.section !== undefined)
          .map((cite) => cite.targetPath);
      const expanded = expandToInboundCiteCorpus(stagedMd, repoRoot, reader, sectionCiteTargets);
      const citeHits = checkCiteTargetExistence(expanded, reader);
      if (citeHits.length > 0) {
        messages.push(formatCiteTargetViolations(citeHits));
        exitCode = 1;
      }
      // Backticked `Spec-NNN §Heading` cites in DOCS verify against the
      // resolved doc's headings, same as code citers — a section-only walk
      // (raw label-form md floors stay cite-target-existence's beat above).
      const sectionHits = checkSectionCites(expanded, reader);
      if (sectionHits.length > 0) {
        messages.push(formatLabelCiteViolations(sectionHits));
        exitCode = 1;
      }
    }

    if (stagedCode.length > 0) {
      // Governance LABEL cites (`Spec-NNN:LL`) — the deterministic floor the
      // markdown-only walk never reached. checkLabelCiteTargets resolves each
      // citer to an absolute path internally, so the shared index-aware reader's
      // staged-set test (keyed on absolute paths) matches and reads the working
      // tree rather than the index. No inbound-expansion for code: CI's full-tree
      // sweep re-checks every code cite on each PR, the backstop for the doc-
      // only-amend case (a spec shifts with no code file staged), so code-side
      // inbound discovery would only duplicate it.
      //
      // Backtick PATH-form cites (`docs/specs/003-x.md:12`) are deliberately NOT
      // floored here: that extractor resolves the target repo-root-relative —
      // correct for governance docs, but it mints false positives on the
      // package-relative code-to-code refs that dominate comments
      // (`internal/branded.ts:25` → `packages/contracts/src/internal/branded.ts`).
      // The lone governance path-cite in code was normalized to the LABEL form;
      // path + line-word forms are audit-layer (CAT-07) via /ripple-check — the
      // same CAT-06/CAT-07 split governance docs already use.
      const labelHits = checkLabelCiteTargets(stagedCode, reader);
      if (labelHits.length > 0) {
        messages.push(formatLabelCiteViolations(labelHits));
        exitCode = 1;
      }

      // C-lite reverse-direction advisory (never blocks): a staged code file
      // that governance docs cite may have moved/removed the cited content —
      // tell the developer which citers to eyeball. CI's full sweep remains
      // the enforcement backstop.
      const reverseCiters = findGovernanceCitersOfCode(stagedCode, repoRoot, reader);
      if (reverseCiters.size > 0) {
        const warnLines = [
          "WARNING (advisory): staged code is cited by governance docs — if this edit moved or removed the cited content, update the citing docs:",
        ];
        for (const [citer, targets] of reverseCiters) {
          warnLines.push(`  ${citer} → ${targets.join(", ")}`);
        }
        messages.push(warnLines.join("\n"));
        // exitCode deliberately NOT set.
      }
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
