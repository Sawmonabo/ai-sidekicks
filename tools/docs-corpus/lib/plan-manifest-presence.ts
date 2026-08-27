// plan-manifest-presence — every dispatchable plan must carry a parseable
// Shipment Manifest block.
//
// /plan-execution preflight Gate 3 (classifyPhaseShipment) HALTS when a plan
// lacks a parseable `### Shipment Manifest` block: it cannot determine which
// phases already shipped, so it refuses to risk re-dispatching shipped work.
// 20 of the 27 plans authored before the manifest section was added to the plan
// template carried this gap — a plan acquired a manifest only by shipping a
// phase through the Phase E housekeeper (or a one-off backfill). This check
// shifts that detection LEFT, from a mid-run execution-time halt to a PR-time
// red gate, so a plan can never reach a dispatchable status without one.
//
// Read source: the git INDEX (`git show :<path>`), consistent with the
// `git ls-files` enumeration (listPlanFiles) and with sibling
// path-canonical-ripple's `--cached` read. A pre-commit gate must validate
// exactly what the next commit
// would contribute. Reading the working tree instead is wrong in BOTH
// directions: it (a) MASKS a staged manifest-less promotion behind an unstaged
// manifest edit on disk — the false-negative this gate exists to prevent — and
// (b) FALSE-POSITIVE blocks an unrelated commit over an unstaged WIP promotion.
// The index is correct on both. In CI the working tree equals HEAD after
// checkout, so the two modes are identical there; the index read is additive.
//
// Parser: the canonical `parseManifestBlock` from the plan-execution skill — the
// SAME function preflight Gate 3 runs — so this guard and the runtime gate
// cannot drift. The parser is untyped `.mjs`; a colocated `manifest.d.mts`
// ambient declaration (nodenext resolves it for the `.mjs` import) types the
// parser without pulling the `.mjs` in as compiled source. That declaration
// route — not `allowJs` — is deliberate: `allowJs` pulled the `.mjs` across
// this package's rootDir and widened the `ok` discriminant so the
// success/failure union stopped narrowing. The drift test in
// __tests__ pins the parser's two return branches to its runtime behavior, so
// the hand-written declaration cannot silently diverge from the `.mjs`. That
// pin must cover every field a consumer READS, not just the discriminant: the
// failure branch's `errors?` is optional in the declaration, so tsc alone would
// not notice a runtime that stopped emitting it — only the drift test would.

import { execFileSync } from "node:child_process";

import {
  MANIFEST_SCHEMA_VERSION,
  parseManifestBlock,
  validateEntry,
} from "../../../.claude/skills/plan-execution/scripts/lib/manifest.mjs";
import { getRepoRoot } from "./inbound-cite-discovery.ts";

// Plan statuses from which /plan-execution can dispatch, or which are otherwise
// stable enough that a missing machine-read manifest is a defect rather than an
// in-progress gap. `draft` is exempt (mid-authoring — the manifest is added
// before promotion to review, mirroring the audit-gate's draft→review block);
// `superseded` is exempt (archived; never dispatched). See CLAUDE.md
// "Documentation Corpus" for the status lifecycle.
const MANIFEST_REQUIRED_STATUSES: ReadonlySet<string> = new Set([
  "review",
  "approved",
  "completed",
]);

// The plan metadata table's status row: `| **Status** | `approved` |`. Uniform
// across the corpus; the value backticks are optional in the match so a future
// unbackticked row still resolves rather than silently exempting the plan.
const STATUS_ROW_RE = /\|\s*\*\*Status\*\*\s*\|\s*`?([A-Za-z-]+)`?\s*\|/;

export interface PlanManifestViolation {
  file: string;
  status: string;
  // parseManifestBlock failure reason (no_section | no_yaml_fence |
  // missing_schema_version | missing_shipped | invalid_non_shipment_prs), or
  // "invalid_entries" when the block parses but a shipped[] entry fails
  // validateEntry — mirroring preflight Gate 3's manifest_invalid_entries halt.
  reason: string;
  // Per-failure diagnostics, when the reason carries any. For
  // "invalid_entries": one `shipped[i]: <errors>` line per failing entry,
  // mirroring Gate 3's per-index diagnostic. For a parse failure that returns
  // an `errors` array (today: "invalid_non_shipment_prs"), the parser's own
  // per-value messages — forwarded rather than dropped, because the generic
  // "append the block from the template" remediation is actively wrong for a
  // block that is present and merely has one bad value.
  detail?: string[];
}

// Exported for reuse by the sibling plan-scoped checks (today:
// plan-status-readability). Sharing the enumeration is the point — two checks
// that each re-derived "which files are plans" would eventually disagree about
// the corpus they claim to cover. `checkName` only labels the fail-closed
// error so the caller that surfaces it is named accurately.
export function listPlanFiles(repoRoot: string, checkName = "plan-manifest-presence"): string[] {
  // `git ls-files` bounds the scan to tracked + staged-new plans (an untracked
  // private draft must not gate a commit). The three-digit-prefix glob excludes
  // `000-plan-template.md`, which intentionally ships the empty manifest as a
  // copy-me example and is not itself a dispatchable plan.
  let out: string;
  try {
    out = execFileSync("git", ["ls-files", "docs/plans/[0-9][0-9][0-9]-*.md"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      // Pipe stderr: with no stdio option, execFileSync ALSO passes the
      // child's stderr through to the parent, so a deliberate not-a-repo
      // probe (the fail-closed test) bleeds a raw `fatal:` line into suite
      // output. Piping keeps the output clean while losing nothing — Node
      // folds the captured stderr into the Error message it throws, so the
      // diagnosis still reaches the wrapped error below. `"ignore"` for
      // stderr would silence the bleed too, but by stripping that diagnosis.
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // Fail closed: a presence gate that cannot enumerate the corpus must surface
    // the failure, not report "all clear". Mirrors path-canonical-ripple's
    // fail-closed stance on a missing registry.
    throw new Error(
      `${checkName}: could not enumerate plans via git ls-files: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return out
    .split("\n")
    .filter(Boolean)
    .filter((p) => !p.endsWith("000-plan-template.md"));
}

// Exported alongside listPlanFiles, for the same reason: the two plan-scoped
// checks must read the SAME bytes (the staged blob), not one the index and one
// the worktree.
export function readPlanFromIndex(
  repoRoot: string,
  file: string,
  checkName = "plan-manifest-presence",
): string {
  // Read the staged (index) blob, not the working tree — see the header note on
  // read-source. `file` is repo-relative (from `git ls-files`), so `:<file>`
  // addresses its index entry directly. Every path listPlanFiles returned has an
  // index entry (git ls-files lists the index), so a non-zero exit is a real
  // fault (e.g. an unmerged path); fail closed by surfacing it with context.
  try {
    return execFileSync("git", ["show", `:${file}`], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      // Piped for the same reason as listPlanFiles above.
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(
      `${checkName}: could not read ${file} from the git index: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

function parseStatus(source: string): string | null {
  const m = source.match(STATUS_ROW_RE);
  return m ? m[1].toLowerCase() : null;
}

/**
 * The staged source of every dispatchable plan, keyed by repo-relative path.
 *
 * Exists so the plan-scoped checks can share ONE pass over the corpus. Each
 * plan costs a `git show` spawn, so a second check re-reading them doubled the
 * pre-commit plan scan (measured ~550ms each on the 30-plan corpus). Passing
 * this to both `checkPlanManifestPresence` and `checkPlanStatusReadability`
 * makes the second check free. Both still read the corpus themselves when
 * called with no argument, so a standalone call (tests, ad-hoc probes) needs no
 * ceremony.
 */
export type PlanCorpus = ReadonlyMap<string, string>;

export function readPlanCorpus(repoRoot: string, checkName = "plan-manifest-presence"): PlanCorpus {
  const corpus = new Map<string, string>();
  for (const file of listPlanFiles(repoRoot, checkName)) {
    corpus.set(file, readPlanFromIndex(repoRoot, file, checkName));
  }
  return corpus;
}

export function checkPlanManifestPresence(corpus?: PlanCorpus): PlanManifestViolation[] {
  const plans = corpus ?? readPlanCorpus(getRepoRoot());
  const violations: PlanManifestViolation[] = [];
  for (const [file, source] of plans) {
    const status = parseStatus(source);
    // A plan whose status cannot be read is itself malformed — fail closed by
    // treating it as required (an unparseable metadata table is a defect, not an
    // exemption). Only an explicit non-dispatchable status exempts the plan.
    if (status !== null && !MANIFEST_REQUIRED_STATUSES.has(status)) continue;
    const result = parseManifestBlock(source);
    if (!result.ok) {
      // Forward the parser's per-value messages when it produced any. Without
      // this the operator gets a bare reason plus a remediation telling them to
      // replace a manifest block that is present and structurally fine.
      const parseErrors = result.errors ?? [];
      violations.push({
        file,
        status: status ?? "unknown",
        reason: result.reason,
        ...(parseErrors.length > 0 ? { detail: parseErrors } : {}),
      });
      continue;
    }
    // The block parses, but Gate 3 (classifyPhaseShipment) ALSO halts on a
    // manifest whose shipped[] entries fail validateEntry. Mirror its exact
    // order: fail OPEN on an unknown future schema (Gate 3's
    // manifest_future_schema — treat as opaque rather than judge a v2 entry by
    // v1 rules), THEN validate every entry. An empty `shipped: []` (every
    // never-shipped plan) makes the loop a no-op, so the corpus stays green.
    if (result.version > MANIFEST_SCHEMA_VERSION) continue;
    const detail: string[] = [];
    for (let i = 0; i < result.shipped.length; i++) {
      const entry = validateEntry(result.shipped[i]);
      if (!entry.ok) detail.push(`shipped[${i}]: ${entry.errors.join("; ")}`);
    }
    if (detail.length > 0) {
      violations.push({ file, status: status ?? "unknown", reason: "invalid_entries", detail });
    }
  }
  return violations;
}

export function formatPlanManifestViolations(violations: PlanManifestViolation[]): string {
  if (violations.length === 0) return "";
  const lines: string[] = [];
  lines.push(
    "plan-manifest-presence: dispatchable plans with an absent or invalid Shipment Manifest",
  );
  lines.push("");
  for (const v of violations) {
    lines.push(`  ${v.file} (status: ${v.status}) — ${v.reason}`);
    if (v.detail) for (const d of v.detail) lines.push(`    ${d}`);
  }
  lines.push("");
  lines.push(
    `plan-manifest-presence: ${violations.length} plan(s) would HALT /plan-execution preflight Gate 3. ` +
      "For `no_section` / `no_yaml_fence`, append the `## Progress Log` / `### Shipment Manifest` " +
      "block from `docs/plans/000-plan-template.md` (an empty `shipped: []` manifest for a plan " +
      "that has shipped no phases). For `invalid_entries`, fix the listed shipped[] entries — the " +
      "schema is authoritative in " +
      "`.claude/skills/plan-execution/scripts/lib/manifest.mjs` §validateEntry. For the " +
      "value-level reasons (`missing_schema_version`, `missing_shipped`, " +
      "`invalid_non_shipment_prs`) the block is PRESENT — fix the named key in place; do not " +
      "replace the block.",
  );
  return lines.join("\n");
}
