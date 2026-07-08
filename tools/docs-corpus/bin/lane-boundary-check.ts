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
//     (`<type>/plan-NNN-*` per CONTRIBUTING §Topic segment — any of the
//     §Type-segment types; Codex P2, round 5) or the diff touches
//     `docs/plans/NNN-*.md` (a plan amendment riding with code). The
//     Shipment Manifest entry itself CANNOT be required in-PR: its `sha:`
//     field is the squash SHA, so Phase E lands it via a separate
//     post-merge housekeeping PR (SKILL.md §Phase E, steps 6-8 — Codex P1
//     on this PR's first review round). The guard checks plan-doc file
//     presence, not amendment content — a semantic content check cannot
//     distinguish an amendment from a prose edit, and G6 remains the
//     fail-closed backstop for manifest completeness after merge;
//   - reverts get NO exemption (Codex P2, rounds 3-5): G6 itself has none,
//     so a merged material revert title carrying the token joins the
//     freshness population as an unmanifested shipment — the exact
//     pollution this guard exists to prevent. Both GitHub's default
//     `Revert "..."` shape and Conventional `revert:` / `revert(scope):` /
//     `revert!:` subjects (in-family: PR #49) are recognized. The
//     branch-shape shortcut does not count for reverts (the shipped token
//     rides any revert branch, including a hand-renamed plan-scoped one),
//     and the plan-doc edit must ACTUALLY touch Shipment Manifest content
//     (entry fields or the block heading) — a prose edit riding along
//     cannot stand in for the reconciliation the failure message asks for;
//   - the INVERSE mislabel fails too (Codex P2, rounds 3 + 5): a material
//     diff on a `<type>/plan-NNN-*` branch whose title does not cite that
//     SAME plan is a shipment G6 can never recover (it searches titles,
//     not branches) — whether the title has no token at all or only other
//     plans' tokens. A docs-only diff on a plan-shaped branch keeps a
//     log-only advisory.
//
// argv: none. Reads PR_TITLE and PR_BRANCH from env and the changed-file
// list from stdin — one entry per line, either a bare repo-relative path or
// a JSON object `{"filename": "...", "patch": "..."}` (the workflow sends
// JSON so revert reconciliation can check patch content; bare paths remain
// accepted and simply carry no patch). Line-oriented either way, so the
// workflow's count-vs-changed_files truncation halt keeps working. Exits 1
// on a boundary violation, 0 otherwise.

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
// topic under ANY §Type-segment type (feat|fix|hotfix|chore|docs|test —
// e.g. a workflow-only plan task legitimately rides `chore/plan-024-...`,
// and the plan-execution scaffold names `test` for test-only shipments;
// Codex P2, rounds 5-6). `release/` carries version topics, never plan
// topics.
const LANE1_BRANCH_RE = /^(feat|fix|hotfix|chore|docs|test)\/plan-(\d{3})-/;

// GitHub's default revert title plus the Conventional Commits `revert` type
// (bare, scoped, or breaking — `revert(repo): ...` is in-family, PR #49).
const REVERT_TITLE_RE = /^(Revert\s+"|revert(\([^)]*\))?!?:)/;

// A revert's plan-doc edit counts as manifest reconciliation only when the
// patch touches Shipment Manifest content: an added/removed entry field
// (`pr:` / `sha:` / `merged_at:` / `task:` / `phase:`), the `shipped:` list
// head, the block heading itself, or a hunk whose @@ context sits in the
// manifest section.
const MANIFEST_PATCH_RE =
  /^[+-].*\b(?:pr|sha|merged_at|task|phase|manifest_schema_version):\s|^[+-]\s*shipped:|^[+-]\s*### Shipment Manifest|^@@[^\n]*Shipment Manifest/m;

function lane1BranchRe(planNumber: string): RegExp {
  return new RegExp(`^(feat|fix|hotfix|chore|docs|test)/plan-${planNumber}-`);
}

export interface LaneBoundaryInput {
  title: string;
  branch: string;
  changedFiles: readonly string[];
  // filename → unified patch text, when the caller has it (the workflow's
  // JSON stdin mode). Absent entries fail closed for the one predicate that
  // needs content (revert reconciliation).
  filePatches?: ReadonlyMap<string, string>;
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
  const materialFiles = input.changedFiles.filter((file) =>
    MATERIAL_PATH_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );
  const branchPlanMatch = LANE1_BRANCH_RE.exec(input.branch);
  const branchPlanNumber = branchPlanMatch ? (branchPlanMatch[2] as string) : null;

  // Inverse mislabel: a plan-scoped branch whose title does not cite that
  // same plan. With a material diff the branch-declared shipment would be
  // permanently invisible to G6 (it searches merged TITLES) — hard failure
  // whether the title is tokenless or cites only OTHER plans (Codex P2,
  // rounds 3 + 5). Docs-only stays a log-only advisory.
  if (branchPlanNumber !== null && !tokens.includes(branchPlanNumber)) {
    if (materialFiles.length > 0) {
      return {
        ok: false,
        failures: [
          `branch "${input.branch}" declares plan-${branchPlanNumber} (<type>/plan-NNN-*) and ` +
            `the diff touches ${materialFiles.length} material file(s) ` +
            `(${MATERIAL_PATH_PREFIXES.join(" / ")}), but the PR title does not cite ` +
            `Plan-${branchPlanNumber}` +
            (tokens.length > 0 ? ` (it cites Plan-${tokens.join(", Plan-")})` : ``) +
            ` — a shipment without its title token is invisible to the manifest-freshness ` +
            `gate (G6 searches titles, not branches). If this ships Plan-${branchPlanNumber} ` +
            `work, put that token in the title (CONTRIBUTING.md §How Code Lands step 3); ` +
            `if not, rename the branch off the plan-scoped shape.`,
        ],
        advisories,
      };
    }
    advisories.push(
      `branch "${input.branch}" declares plan-${branchPlanNumber} but the PR title does not ` +
        `cite Plan-${branchPlanNumber} and the diff is docs-only. If this PR is plan-scoped ` +
        `work, put the token in the title; if not, rename the branch lane.`,
    );
  }
  if (tokens.length === 0 || materialFiles.length === 0) {
    // Tokenless (G6-invisible by design — lanes 2/3) or docs-only (outside
    // G6's material population): no title-token boundary to enforce.
    return { ok: true, failures: [], advisories };
  }
  const failures: string[] = [];
  const isRevertTitle = REVERT_TITLE_RE.test(input.title);
  for (const planNumber of tokens) {
    const planFileRe = new RegExp(`^docs/plans/${planNumber}-[^/]+\\.md$`);
    // Lane 1 is declared per cited plan: a plan-scoped branch for that NNN
    // (the normal shipment shape — the Shipment Manifest entry lands in the
    // post-merge housekeeping PR, never in the shipment PR, because its
    // `sha:` field is this PR's own squash SHA), or a plan-doc edit riding
    // in the same PR (amendment-with-code shape; presence-only by design —
    // G6 backstops manifest completeness post-merge). Reverts get neither
    // shortcut: the shipped title's token rides ANY revert branch, and the
    // failure message promises manifest RECONCILIATION, so the plan-doc
    // patch must actually touch manifest content (MANIFEST_PATCH_RE); a
    // missing patch (bare-path stdin, oversized-file API omission) fails
    // closed for reverts.
    const planDocFiles = input.changedFiles.filter((file) => planFileRe.test(file));
    const declaresLane1 = isRevertTitle
      ? planDocFiles.some((file) => MANIFEST_PATCH_RE.test(input.filePatches?.get(file) ?? ""))
      : lane1BranchRe(planNumber).test(input.branch) || planDocFiles.length > 0;
    if (!declaresLane1) {
      const revertRemedy = isRevertTitle
        ? `This is a revert: the title re-carries the shipped token — edit the title to ` +
          `drop it (reverts are not shipments; the manifest-freshness gate has no revert ` +
          `exemption) or include the actual Shipment Manifest reconciliation in ` +
          `docs/plans/${planNumber}-*.md (the edit must touch manifest entry content, ` +
          `not just the file). `
        : ``;
      failures.push(
        `PR title cites Plan-${planNumber} (case-insensitive) and the diff touches ` +
          `${materialFiles.length} material file(s) (${MATERIAL_PATH_PREFIXES.join(" / ")}), ` +
          `but nothing declares lane-1 shipment for Plan-${planNumber}: the branch ` +
          `("${input.branch}") is not <type>/plan-${planNumber}-* and ` +
          `docs/plans/${planNumber}-*.md ${isRevertTitle ? "carries no manifest reconciliation" : "is not in the diff"}. ` +
          `${revertRemedy}If this ships plan-task work, use a plan-scoped branch; if it is ` +
          `an enhancement or tooling PR (lane 2/3), drop the token from the title. ` +
          `See CONTRIBUTING.md §How Code Lands: Work Classification.`,
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
  const changedFiles: string[] = [];
  const filePatches = new Map<string, string>();
  for (const rawLine of changedFilesText.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("{")) {
      // Workflow JSON mode: {"filename": "...", "patch": "..."} per line.
      // A malformed line is a protocol error — fail closed rather than
      // misclassifying it as a path named "{...".
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return {
          exitCode: 1,
          message: `::error title=lane-boundary halt::malformed JSON changed-file line: ${line.slice(0, 120)}`,
        };
      }
      const entry = parsed as { filename?: unknown; patch?: unknown };
      if (typeof entry.filename !== "string" || entry.filename.length === 0) {
        return {
          exitCode: 1,
          message: `::error title=lane-boundary halt::JSON changed-file line missing "filename": ${line.slice(0, 120)}`,
        };
      }
      changedFiles.push(entry.filename);
      filePatches.set(entry.filename, typeof entry.patch === "string" ? entry.patch : "");
    } else {
      changedFiles.push(line);
    }
  }
  const result = checkLaneBoundary({ title, branch, changedFiles, filePatches });
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
