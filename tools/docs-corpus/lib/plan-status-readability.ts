// plan-status-readability — every dispatchable plan's header Status cell must
// stay machine-readable.
//
// The CAT-10 class (a gate reporting clean over work it did not do).
// /plan-execution preflight Gate 7 (`gateStatusPromotion`) reads the
// header-table `| **Status** | `approved` |` row to enforce the
// review -> approved promotion gate, and fails CLOSED on a row it cannot
// parse. That is the right stance but it arrives late: the defect is authored
// in a docs PR and only surfaces when someone tries to dispatch code from that
// plan, potentially weeks later and in a different session.
//
// The gap is wider than "late", though, and that is why this is its own check
// rather than a note. The sibling plan-manifest-presence reads the SAME row
// through its own, looser `STATUS_ROW_RE` and treats an unreadable status as
// "manifest required" — fail-closed for ITS question, but it reports nothing
// about the cell, so a plan whose Status cell Gate 7 cannot read passes every
// pre-commit gate green today. This check closes that: it is the surface that
// actually says the cell is broken.
//
// Scope: the "status unreadable" condition ONLY. It deliberately does NOT flag
// Gate 7's second condition ("plan not promoted"). `draft` and `review` are
// legitimate authoring states that every plan passes through, and a gate that
// denied them would block plan authoring itself.
//
// Read source: the git INDEX, through plan-manifest-presence's `readPlanCorpus`
// — reused rather than re-implemented so the two plan-scoped checks cannot come
// to disagree about which files are plans or which bytes are the commit's. The
// runner makes that pass ONCE and hands the result to both checks, so this one
// adds no `git show` spawns to a commit. That enumeration already excludes
// `000-plan-template.md`, whose Status cell is a fill-me-in placeholder by
// design and which Gate 7 therefore reports unreadable (verified: it is the
// only plan-shaped file in the corpus that does).
//
// Matcher: Gate 7's own two-step — scope to the pre-`^## ` header region, then
// match the `^`-anchored lowercase row — duplicated here rather than imported.
// `preflight.mjs` is a 7000+-line untyped ESM module, and importing it would
// force this whole sync check surface (and `runChecks` with it) to become
// async for a 4-line matcher. The duplication is pinned BEHAVIORALLY instead:
// the drift test in `__tests__/plan-status-readability.test.ts` imports the
// real `gateStatusPromotion` and asserts the two agree across a matrix of
// readable, unreadable, and not-yet-promoted headers, so a change to the gate
// that this file did not follow turns that test red.
//
// The divergence from plan-manifest-presence's `STATUS_ROW_RE` (unanchored,
// whole-document, `[A-Za-z-]+`) is deliberate and must not be "unified": that
// regex is looser because its question is looser. Mirroring it here would make
// this check green on rows Gate 7 rejects, which is exactly the fail-open the
// check exists to close.

import { getRepoRoot } from "./inbound-cite-discovery.ts";
import { type PlanCorpus, readPlanCorpus } from "./plan-manifest-presence.ts";

const CHECK_NAME = "plan-status-readability";

// Mirrors `gateStatusPromotion` in
// `.claude/skills/plan-execution/scripts/preflight.mjs`. Neither literal
// carries the `g` flag, so neither holds `lastIndex` state across calls.
const SECTION_HEADING_RE = /^## /m;
const HEADER_STATUS_ROW_RE = /^\|\s*\*\*Status\*\*\s*\|\s*`?([a-z][a-z-]*)`?\s*\|/m;

// Locates what the author probably meant to be the Status row, for the
// diagnostic only. Intentionally permissive — its job is to quote the offending
// text back, never to decide anything.
const STATUS_LOOKALIKE_RE = /^.*\*\*Status\*\*.*$/m;

export interface PlanStatusViolation {
  file: string;
  // The header-region line that looks like a Status row but does not match
  // Gate 7's shape, when one exists — quoted back so the remediation is
  // self-evident (an inline annotation after the value is the common cause).
  // Absent when the header region carries no `**Status**` line at all, which
  // is the different defect of a missing row.
  offendingLine?: string;
}

// The header region Gate 7 scopes its match to: everything before the first
// `##` section heading. A whole-document match could hit an embedded example
// or matrix row later in the body and green-light a plan whose actual header
// row is missing.
function headerRegionOf(planSource: string): string {
  const sectionStart = planSource.search(SECTION_HEADING_RE);
  return sectionStart === -1 ? planSource : planSource.slice(0, sectionStart);
}

/**
 * Gate 7's status read, as a pure function over a plan's source.
 *
 * Returns the lowercase status token, or `null` when the header table carries
 * no parseable Status row — the condition Gate 7 halts on as
 * "plan status unreadable". Exported so the drift test can compare this
 * matcher against the real gate without re-deriving it.
 */
export function readHeaderStatus(planSource: string): string | null {
  const row = headerRegionOf(planSource).match(HEADER_STATUS_ROW_RE);
  return row ? row[1] : null;
}

/**
 * @param corpus Pre-read plan sources, when the caller already made the pass —
 *   the runner does, so this check adds no `git show` spawns to a commit. Read
 *   here when omitted.
 */
export function checkPlanStatusReadability(corpus?: PlanCorpus): PlanStatusViolation[] {
  const plans = corpus ?? readPlanCorpus(getRepoRoot(), CHECK_NAME);
  const violations: PlanStatusViolation[] = [];
  for (const [file, source] of plans) {
    if (readHeaderStatus(source) !== null) continue;
    const lookalike = headerRegionOf(source).match(STATUS_LOOKALIKE_RE);
    violations.push({
      file,
      ...(lookalike ? { offendingLine: lookalike[0].trim() } : {}),
    });
  }
  return violations;
}

export function formatPlanStatusViolations(violations: PlanStatusViolation[]): string {
  if (violations.length === 0) return "";
  const lines: string[] = [];
  lines.push(`${CHECK_NAME}: plans whose header-table Status row is not machine-readable`);
  lines.push("");
  for (const v of violations) {
    lines.push(`  ${v.file}`);
    lines.push(
      v.offendingLine
        ? `    found: ${v.offendingLine}`
        : "    found: no `**Status**` row in the header region (before the first `##` heading)",
    );
  }
  lines.push("");
  lines.push(
    `${CHECK_NAME}: ${violations.length} plan(s) would HALT /plan-execution preflight Gate 7 ` +
      "with `plan status unreadable`. Restore the `docs/plans/000-plan-template.md` shape — " +
      "`| **Status** | `approved` |` — with the status token alone in the cell. Dated notes, " +
      "restore annotations, and parenthetical commentary belong in the plan's `§Decision Log` " +
      "or `§Progress Log`, not inside the cell the gate parses. Only the readability of the " +
      "cell is checked here: `draft` and `review` are legitimate values and never fail.",
  );
  return lines.join("\n");
}
