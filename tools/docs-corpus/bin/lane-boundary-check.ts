#!/usr/bin/env -S node --experimental-strip-types
// lane-boundary-check — CI guard for the lane-1 title-token boundary
// (CONTRIBUTING.md §How Code Lands: Work Classification).
//
// The plan-execution manifest-freshness gate (G6) recovers shipment drift by
// searching merged PR titles for `Plan-NNN` and counting any hit that touches
// material paths. That makes a mislabeled title the one way to re-create
// drift: a lane-2/3 PR carrying the token pollutes recovery. This guard
// enforces the boundary with G6's own narrowings so the two predicates
// cannot disagree:
//
//   - token match is case-insensitive (GitHub search is, and
//     rebuild-shipment-manifest.mjs filters with the `i` flag);
//   - a docs-only diff passes (G6 counts only PRs touching
//     MATERIAL_PATH_PREFIXES, so docs PRs may legitimately name plans);
//   - a material diff with a title token must DECLARE lane 1 for every
//     cited plan: either the branch is plan-scoped for that same NNN
//     (`feat|fix/plan-NNN-*` per CONTRIBUTING §Topic segment) or the diff
//     touches `docs/plans/NNN-*.md` (a plan amendment riding with code).
//     The Shipment Manifest entry itself CANNOT be required in-PR: its
//     `sha:` field is the squash SHA, so Phase E lands it via a separate
//     post-merge housekeeping PR (SKILL.md §Phase E, steps 6-8 — Codex P1
//     on this PR's first review round);
//   - a `Revert "..."`-titled PR passes with an advisory: the manifest
//     reconciliation for a reverted shipment is owed to the housekeeping /
//     rebuild path, not to the revert PR itself.
//
// A `feat|fix/plan-NNN-*` branch whose title lacks the token gets a log-only
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

// CONTRIBUTING §Topic segment: plan-scoped work embeds `plan-NNN-` in the
// topic; `feat/` ships new plan tasks and `fix/` ships plan-scoped fixes
// (`fix/plan-023-renderer-leak` is CONTRIBUTING's own example).
const LANE1_BRANCH_RE = /^(feat|fix)\/plan-\d{3}-/;

const REVERT_TITLE_RE = /^Revert "/;

function lane1BranchRe(planNumber: string): RegExp {
  return new RegExp(`^(feat|fix)/plan-${planNumber}-`);
}

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
        `branch "${input.branch}" is lane-1-shaped (feat|fix/plan-NNN-*) but the PR title ` +
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
  if (REVERT_TITLE_RE.test(input.title)) {
    // A revert of a lane-1 shipment re-carries the shipped title's token but
    // cannot carry a manifest edit any more than the shipment could — the
    // reconciliation is owed post-merge (housekeeping or rebuild).
    advisories.push(
      `revert PR carries Plan-${tokens.join("/Plan-")} in its title; after merge, ` +
        `reconcile the plan's Shipment Manifest for the reverted work (post-merge ` +
        `housekeeping or rebuild-shipment-manifest.mjs).`,
    );
    return { ok: true, failures: [], advisories };
  }
  const failures: string[] = [];
  for (const planNumber of tokens) {
    const planFileRe = new RegExp(`^docs/plans/${planNumber}-[^/]+\\.md$`);
    // Lane 1 is declared per cited plan: a plan-scoped branch for that NNN
    // (the normal shipment shape — the Shipment Manifest entry lands in the
    // post-merge housekeeping PR, never in the shipment PR, because its
    // `sha:` field is this PR's own squash SHA), or a plan-doc edit riding
    // in the same PR (amendment-with-code shape).
    const declaresLane1 =
      lane1BranchRe(planNumber).test(input.branch) ||
      input.changedFiles.some((file) => planFileRe.test(file));
    if (!declaresLane1) {
      failures.push(
        `PR title cites Plan-${planNumber} (case-insensitive) and the diff touches ` +
          `${materialFiles.length} material file(s) (${MATERIAL_PATH_PREFIXES.join(" / ")}), ` +
          `but nothing declares lane-1 shipment for Plan-${planNumber}: the branch ` +
          `("${input.branch}") is not (feat|fix)/plan-${planNumber}-* and ` +
          `docs/plans/${planNumber}-*.md is not in the diff. If this ships plan-task ` +
          `work, use a plan-scoped branch; if it is an enhancement or tooling PR ` +
          `(lane 2/3), drop the token from the title. See CONTRIBUTING.md ` +
          `§How Code Lands: Work Classification.`,
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
