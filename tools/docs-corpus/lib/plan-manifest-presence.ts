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
// Read source: the WORKING TREE (readFileSync) — the mirror image of
// path-canonical-ripple's `--cached` index read. That check hunts FORBIDDEN
// content and reads the index so unstaged WIP cannot block an unrelated commit;
// this check requires PRESENT content, so it reads the working tree to the same
// end — an unstaged manifest addition on disk (a plan being fixed on a parallel
// branch) must not block an unrelated commit. In CI the working tree equals
// HEAD after checkout, so the gate is authoritative there regardless.
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
// the hand-written declaration cannot silently diverge from the `.mjs`.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseManifestBlock } from "../../../.claude/skills/plan-execution/scripts/lib/manifest.mjs";
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
  // parseManifestBlock failure reason: no_section | no_yaml_fence |
  // missing_schema_version | missing_shipped.
  reason: string;
}

function listPlanFiles(repoRoot: string): string[] {
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
    });
  } catch (err) {
    // Fail closed: a presence gate that cannot enumerate the corpus must surface
    // the failure, not report "all clear". Mirrors path-canonical-ripple's
    // fail-closed stance on a missing registry.
    throw new Error(
      `plan-manifest-presence: could not enumerate plans via git ls-files: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return out
    .split("\n")
    .filter(Boolean)
    .filter((p) => !p.endsWith("000-plan-template.md"));
}

function parseStatus(source: string): string | null {
  const m = source.match(STATUS_ROW_RE);
  return m ? m[1].toLowerCase() : null;
}

export function checkPlanManifestPresence(): PlanManifestViolation[] {
  const repoRoot = getRepoRoot();
  const violations: PlanManifestViolation[] = [];
  for (const file of listPlanFiles(repoRoot)) {
    const source = readFileSync(resolve(repoRoot, file), "utf8");
    const status = parseStatus(source);
    // A plan whose status cannot be read is itself malformed — fail closed by
    // treating it as required (an unparseable metadata table is a defect, not an
    // exemption). Only an explicit non-dispatchable status exempts the plan.
    if (status !== null && !MANIFEST_REQUIRED_STATUSES.has(status)) continue;
    const result = parseManifestBlock(source);
    if (!result.ok) {
      violations.push({ file, status: status ?? "unknown", reason: result.reason });
    }
  }
  return violations;
}

export function formatPlanManifestViolations(violations: PlanManifestViolation[]): string {
  if (violations.length === 0) return "";
  const lines: string[] = [];
  lines.push("plan-manifest-presence: dispatchable plans missing a parseable Shipment Manifest");
  lines.push("");
  for (const v of violations) {
    lines.push(`  ${v.file} (status: ${v.status}) — ${v.reason}`);
  }
  lines.push("");
  lines.push(
    `plan-manifest-presence: ${violations.length} plan(s) would HALT /plan-execution preflight Gate 3. ` +
      "Append the `## Progress Log` / `### Shipment Manifest` block from " +
      "`docs/plans/000-plan-template.md` — an empty `shipped: []` manifest for a plan " +
      "that has shipped no phases.",
  );
  return lines.join("\n");
}
