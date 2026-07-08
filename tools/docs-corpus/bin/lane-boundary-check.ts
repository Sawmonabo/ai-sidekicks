#!/usr/bin/env -S node --experimental-strip-types
// lane-boundary-check — CI guard for the lane-1 title-token boundary
// (CONTRIBUTING.md §How Code Lands: Work Classification).
//
// The plan-execution manifest-freshness gate (G6) recovers shipment drift by
// searching merged PR titles for `Plan-NNN` and counting any hit that touches
// material paths. That makes a mislabeled title the one way to re-create
// drift: a lane-2/3 PR carrying the token pollutes recovery, and a lane-1
// shipment is only coherent when the same PR lands its Shipment Manifest
// entry (a `docs/plans/NNN-*.md` edit). This guard enforces exactly that
// boundary, with G6's own narrowings so the two predicates cannot disagree:
//
//   - token match is case-insensitive (GitHub search is, and
//     rebuild-shipment-manifest.mjs filters with the `i` flag);
//   - a docs-only diff passes (G6 counts only PRs touching
//     MATERIAL_PATH_PREFIXES, so docs PRs may legitimately name plans);
//   - a material diff with a title token MUST touch every cited plan's
//     `docs/plans/NNN-*.md` (the manifest-entry surface). Reverts satisfy
//     this naturally — reverting a shipment also reverts its manifest entry.
//
// A `feat/plan-NNN-*` branch whose title lacks the token gets a log-only
// advisory (exit 0): the shipment would be invisible to G6, but branch names
// are not load-bearing the way merged titles are, so the guard warns rather
// than blocks.
//
// argv: none. Reads PR_TITLE and PR_BRANCH from env and the changed-file
// list from stdin (one repo-relative path per line — arg-length-safe on
// large PRs). Exits 1 on a boundary violation, 0 otherwise.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Sync contract with `.claude/skills/plan-execution/scripts/preflight.mjs`
// (G6's MATERIAL_PATH_PREFIXES): the guard must classify "material" exactly
// as the gate does or the boundary drifts. Enforced by a deep-equality test
// in `__tests__/lane-boundary-check.test.ts`, not by this comment.
export const MATERIAL_PATH_PREFIXES: readonly string[] = ["packages/", "apps/", ".github/"];

// Case-insensitive; `\b` on both sides keeps `workplan-001` and 4-digit
// `plan-0011` shapes out, matching the 3-digit padded form G6 searches.
const TITLE_TOKEN_RE = /\bplan-(\d{3})\b/gi;

const LANE1_BRANCH_RE = /^feat\/plan-\d{3}-/;

export interface LaneBoundaryInput {
  title: string;
  branch: string;
  changedFiles: readonly string[];
}

export interface LaneBoundaryResult {
  ok: boolean;
  failures: string[];
  advisories: string[];
}

export function extractTitlePlanTokens(title: string): string[] {
  const tokens = new Set<string>();
  for (const match of title.matchAll(TITLE_TOKEN_RE)) {
    tokens.add(match[1] as string);
  }
  return [...tokens].sort();
}

export function checkLaneBoundary(input: LaneBoundaryInput): LaneBoundaryResult {
  const tokens = extractTitlePlanTokens(input.title);
  const advisories: string[] = [];
  if (tokens.length === 0) {
    if (LANE1_BRANCH_RE.test(input.branch)) {
      advisories.push(
        `branch "${input.branch}" is lane-1-shaped (feat/plan-NNN-*) but the PR title ` +
          `carries no Plan-NNN token — a lane-1 shipment without the title token is ` +
          `invisible to the manifest-freshness gate (G6). If this PR ships plan-task ` +
          `work, put the token in the title; if not, rename the branch lane.`,
      );
    }
    return { ok: true, failures: [], advisories };
  }
  const materialFiles = input.changedFiles.filter((file) =>
    MATERIAL_PATH_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );
  if (materialFiles.length === 0) {
    // Docs-only diffs are invisible to G6 by the same narrowing, so a title
    // that names a plan (e.g. a plan-amendment PR) is not a lane violation.
    return { ok: true, failures: [], advisories };
  }
  const failures: string[] = [];
  for (const planNumber of tokens) {
    const planFileRe = new RegExp(`^docs/plans/${planNumber}-[^/]+\\.md$`);
    if (!input.changedFiles.some((file) => planFileRe.test(file))) {
      failures.push(
        `PR title cites Plan-${planNumber} (case-insensitive) and the diff touches ` +
          `${materialFiles.length} material file(s) (${MATERIAL_PATH_PREFIXES.join(" / ")}), ` +
          `but docs/plans/${planNumber}-*.md is not in the diff. Lane 1 ships a Shipment ` +
          `Manifest entry (touch docs/plans/${planNumber}-*.md in the same PR); lane-2/3 ` +
          `PRs must drop the token from the title. See CONTRIBUTING.md §How Code Lands: ` +
          `Work Classification.`,
      );
    }
  }
  return { ok: failures.length === 0, failures, advisories };
}

export interface RunResult {
  exitCode: number;
  message: string;
}

export function runLaneBoundaryCheck(
  title: string,
  branch: string,
  changedFilesText: string,
): RunResult {
  const changedFiles = changedFilesText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const result = checkLaneBoundary({ title, branch, changedFiles });
  const lines: string[] = [];
  for (const advisory of result.advisories) {
    lines.push(`::warning title=lane-boundary advisory::${advisory}`);
  }
  for (const failure of result.failures) {
    lines.push(`::error title=lane-boundary violation::${failure}`);
  }
  return { exitCode: result.ok ? 0 : 1, message: lines.join("\n") };
}

function main(): number {
  const title = process.env["PR_TITLE"] ?? "";
  const branch = process.env["PR_BRANCH"] ?? "";
  // fd 0 — the changed-file list is piped in by the workflow step; an empty
  // stream means zero changed files, which no real PR has, and the step's
  // `set -euo pipefail` already kills the run if the upstream `gh api` fails.
  const changedFilesText = readFileSync(0, "utf8");
  const { exitCode, message } = runLaneBoundaryCheck(title, branch, changedFilesText);
  if (message.length > 0) {
    console.log(message);
  }
  return exitCode;
}

// Direct-invocation guard so importing the predicate in tests doesn't trigger
// `process.exit` (mirrors table-total-check.ts — realpathSync for the macOS
// `/tmp` → `/private/tmp` symlink case).
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
