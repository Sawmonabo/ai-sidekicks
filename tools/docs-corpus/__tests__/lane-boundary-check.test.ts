// lane-boundary-check tests — the lane-1 title-token boundary guard.
//
// The predicate must mirror G6 (preflight.mjs gateManifestFreshness) exactly:
// case-insensitive token, material-path narrowing, manifest-entry surface.
// The sync test at the bottom imports G6's constant so divergence fails CI
// rather than waiting for a drifted incident.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  MATERIAL_PATH_PREFIXES,
  checkLaneBoundary,
  extractTitlePlanTokens,
  runLaneBoundaryCheck,
} from "../bin/lane-boundary-check.ts";
// The skill script is plain ESM with a direct-invocation guard, so importing
// it here executes nothing.
// @ts-expect-error TS7016 — the skill script ships no declarations; this test
// only reads one exported const, and the parity assertion types it locally.
import { MATERIAL_PATH_PREFIXES as G6_MATERIAL_PATH_PREFIXES } from "../../../.claude/skills/plan-execution/scripts/preflight.mjs";

const BIN_PATH = fileURLToPath(new URL("../bin/lane-boundary-check.ts", import.meta.url));

describe("extractTitlePlanTokens", () => {
  it("extracts case variants and dedupes", () => {
    expect(
      extractTitlePlanTokens("feat(daemon): Plan-004 run handlers (see PLAN-004, plan-007)"),
    ).toEqual(["004", "007"]);
  });

  it("ignores non-token shapes: word-prefixed, 4-digit, missing dash", () => {
    expect(extractTitlePlanTokens("docs: workplan-001 + plan-0011 + plan 004 + plans-004")).toEqual(
      [],
    );
  });

  it("returns empty for the release-please title", () => {
    expect(extractTitlePlanTokens("chore: release develop")).toEqual([]);
  });
});

describe("checkLaneBoundary", () => {
  const materialFile = "packages/runtime-daemon/src/ipc/handlers/run.ts";

  it("passes a tokenless PR outright", () => {
    const result = checkLaneBoundary({
      title: "chore(repo): lane-boundary CI guard for plan-titled PRs",
      branch: "chore/lane-boundary-ci-guard",
      changedFiles: [materialFile],
    });
    expect(result).toEqual({ ok: true, failures: [], advisories: [] });
  });

  it("passes a docs-only diff whose title names a plan (G6 material narrowing)", () => {
    const result = checkLaneBoundary({
      title: "docs(repo): spec-016 amendment referenced by plan-016",
      branch: "docs/spec-016-amendment",
      changedFiles: ["docs/specs/016-multi-agent-channels.md"],
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("passes the normal lane-1 shipment: token + material + plan-scoped branch, NO plan-doc edit (manifest lands post-merge via housekeeping)", () => {
    const result = checkLaneBoundary({
      title: "feat(daemon): Plan-004 run lifecycle handlers",
      branch: "feat/plan-004-run-handlers",
      changedFiles: [materialFile],
    });
    expect(result).toEqual({ ok: true, failures: [], advisories: [] });
  });

  it("passes the fix-typed lane-1 branch (CONTRIBUTING's own fix/plan-NNN example)", () => {
    const result = checkLaneBoundary({
      title: "fix(desktop): Plan-023 renderer leak",
      branch: "fix/plan-023-renderer-leak",
      changedFiles: ["apps/desktop/src/renderer/leak.ts"],
    });
    expect(result.ok).toBe(true);
  });

  it("passes the amendment-with-code shape: plan-doc edit rides with material on a non-plan branch", () => {
    const result = checkLaneBoundary({
      title: "feat(daemon): Plan-004 run lifecycle handlers",
      branch: "feat/run-handlers",
      changedFiles: [materialFile, "docs/plans/004-agent-runs-and-lifecycle.md"],
    });
    expect(result.ok).toBe(true);
  });

  it("fails a material diff with no lane-1 declaration (non-plan branch, no plan-doc edit)", () => {
    const result = checkLaneBoundary({
      title: "chore(repo): tooling cleanup mentioning Plan-004",
      branch: "chore/tooling-cleanup",
      changedFiles: [materialFile],
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("Plan-004");
    expect(result.failures[0]).toContain("<type>/plan-004-*");
    expect(result.failures[0]).toContain("CONTRIBUTING.md");
  });

  it("fails when the branch is plan-scoped for a DIFFERENT plan than the title cites (branch plan invisible to G6 — Codex r5)", () => {
    const result = checkLaneBoundary({
      title: "feat(daemon): Plan-004 run lifecycle handlers",
      branch: "feat/plan-007-ipc-host",
      changedFiles: [materialFile],
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    // The inverse rule fires: the branch-declared Plan-007 shipment would be
    // invisible to G6's title search even though Plan-004 is properly cited.
    expect(result.failures[0]).toContain("plan-007");
    expect(result.failures[0]).toContain("does not cite Plan-007");
    expect(result.failures[0]).toContain("(it cites Plan-004)");
  });

  it("passes any CONTRIBUTING §Type-segment branch type as a lane-1 shape (chore/plan-024 workflow-only task — Codex r5)", () => {
    const result = checkLaneBoundary({
      title: "chore(ci): Plan-024 sidecar cross-compile workflow",
      branch: "chore/plan-024-sidecar-build",
      changedFiles: [".github/workflows/sidecar-build.yml"],
    });
    expect(result).toEqual({ ok: true, failures: [], advisories: [] });
  });

  it("passes the test/ scaffold branch type for test-only material shipments (Codex r6)", () => {
    const result = checkLaneBoundary({
      title: "test(daemon): Plan-004 run-handler conformance suite",
      branch: "test/plan-004-conformance",
      changedFiles: ["packages/runtime-daemon/src/__tests__/run-handlers.test.ts"],
    });
    expect(result).toEqual({ ok: true, failures: [], advisories: [] });
  });

  it("multi-token: the branch declares one plan; the other needs its plan-doc edit", () => {
    const result = checkLaneBoundary({
      title: "feat(daemon): Plan-004 + Plan-007 handler split",
      branch: "feat/plan-004-handler-split",
      changedFiles: [materialFile],
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("Plan-007");
  });

  it("fails a token-carrying material revert (G6 has no revert exemption) with the revert remedy", () => {
    // GitHub's default revert head (`revert-<pr>-<branch>`) is not
    // lane-1-shaped, so a default material revert must drop the token or
    // carry the manifest reconciliation — otherwise the merged title joins
    // G6's freshness population as an unmanifested shipment.
    const result = checkLaneBoundary({
      title: 'Revert "feat(daemon): Plan-004 run lifecycle handlers"',
      branch: "revert-199-feat/plan-004-run-handlers",
      changedFiles: [materialFile],
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("This is a revert");
    expect(result.failures[0]).toContain("no revert exemption");
  });

  it("fails a material revert even on a hand-renamed plan-scoped branch (branch shortcut void for reverts)", () => {
    const result = checkLaneBoundary({
      title: 'Revert "feat(daemon): Plan-004 run lifecycle handlers"',
      branch: "fix/plan-004-revert-run-handlers",
      changedFiles: [materialFile],
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("This is a revert");
  });

  it("passes a material revert whose plan-doc patch actually touches manifest content", () => {
    const result = checkLaneBoundary({
      title: 'Revert "feat(daemon): Plan-004 run lifecycle handlers"',
      branch: "revert-199-feat/plan-004-run-handlers",
      changedFiles: [materialFile, "docs/plans/004-agent-runs-and-lifecycle.md"],
      filePatches: new Map([
        [
          "docs/plans/004-agent-runs-and-lifecycle.md",
          "@@ -410,7 +410,0 @@ ### Shipment Manifest\n-  - phase: 2\n-    task: T2.1\n-    pr: 199\n-    sha: abc1234\n",
        ],
      ]),
    });
    expect(result).toEqual({ ok: true, failures: [], advisories: [] });
  });

  it("fails a material revert whose plan-doc edit is prose-only (file presence is not reconciliation — Codex r5)", () => {
    const result = checkLaneBoundary({
      title: 'Revert "feat(daemon): Plan-004 run lifecycle handlers"',
      branch: "revert-199-feat/plan-004-run-handlers",
      changedFiles: [materialFile, "docs/plans/004-agent-runs-and-lifecycle.md"],
      filePatches: new Map([
        [
          "docs/plans/004-agent-runs-and-lifecycle.md",
          "@@ -12,1 +12,1 @@ ## Overview\n-typo\n+fixed typo\n",
        ],
      ]),
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("carries no manifest reconciliation");
  });

  it("fails a material revert when no patch content is available (fail closed)", () => {
    const result = checkLaneBoundary({
      title: 'Revert "feat(daemon): Plan-004 run lifecycle handlers"',
      branch: "revert-199-feat/plan-004-run-handlers",
      changedFiles: [materialFile, "docs/plans/004-agent-runs-and-lifecycle.md"],
    });
    expect(result.ok).toBe(false);
  });

  it("recognizes Conventional revert subjects (revert(repo): — in-family, PR #49) via the plan-scoped branch shortcut being void", () => {
    const result = checkLaneBoundary({
      title: "revert(daemon): Plan-004 undo run handlers",
      branch: "fix/plan-004-revert-handlers",
      changedFiles: [materialFile],
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("This is a revert");
  });

  it("passes a docs-only revert (token in title, no material paths — invisible to G6)", () => {
    const result = checkLaneBoundary({
      title: 'Revert "docs(repo): Plan-004 phase notes"',
      branch: "revert-201-docs/plan-004-phase-notes",
      changedFiles: ["docs/plans/004-agent-runs-and-lifecycle.md"],
    });
    expect(result).toEqual({ ok: true, failures: [], advisories: [] });
  });

  it("a plans/ doc edit for another NNN does not declare lane 1 for the cited plan", () => {
    const result = checkLaneBoundary({
      title: "feat(daemon): Plan-004 run lifecycle handlers",
      branch: "feat/run-handlers",
      changedFiles: [materialFile, "docs/plans/007-local-ipc-and-daemon-control.md"],
    });
    expect(result.ok).toBe(false);
  });

  it("fails a MATERIAL diff on a lane-1-shaped branch with a tokenless title (invisible to G6)", () => {
    const result = checkLaneBoundary({
      title: "feat(daemon): run lifecycle handlers",
      branch: "feat/plan-004-run-handlers",
      changedFiles: [materialFile, "docs/plans/004-agent-runs-and-lifecycle.md"],
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("invisible to the manifest-freshness gate");
  });

  it("advises (exit-0) on a DOCS-ONLY diff on a lane-1-shaped branch with a tokenless title", () => {
    const result = checkLaneBoundary({
      title: "docs(repo): plan amendment notes",
      branch: "feat/plan-004-run-handlers",
      changedFiles: ["docs/plans/004-agent-runs-and-lifecycle.md"],
    });
    expect(result.ok).toBe(true);
    expect(result.advisories).toHaveLength(1);
    expect(result.advisories[0]).toContain("docs-only");
  });
});

describe("runLaneBoundaryCheck (stdin parsing + annotations)", () => {
  it("parses newline-separated files, tolerating blanks and whitespace", () => {
    const { exitCode } = runLaneBoundaryCheck(
      "feat(daemon): Plan-004 run lifecycle handlers",
      "feat/plan-004-run-handlers",
      "packages/runtime-daemon/src/a.ts\n\n  docs/plans/004-agent-runs-and-lifecycle.md  \n",
    );
    expect(exitCode).toBe(0);
  });

  it("emits ::error:: annotations and exit 1 on violation", () => {
    const { exitCode, message } = runLaneBoundaryCheck(
      "chore(repo): tooling cleanup mentioning Plan-004",
      "chore/tooling-cleanup",
      "packages/runtime-daemon/src/a.ts\n",
    );
    expect(exitCode).toBe(1);
    expect(message).toContain("::error title=lane-boundary violation::");
  });

  it("emits ::warning:: annotations with exit 0 for the docs-only branch advisory", () => {
    const { exitCode, message } = runLaneBoundaryCheck(
      "docs(repo): plan amendment notes",
      "feat/plan-004-run-handlers",
      "docs/plans/004-agent-runs-and-lifecycle.md\n",
    );
    expect(exitCode).toBe(0);
    expect(message).toContain("::warning title=lane-boundary advisory::");
  });

  it("parses JSON lines ({filename, patch}) and honors revert manifest reconciliation through them", () => {
    const manifestPatch =
      "@@ -410,4 +410,0 @@ ### Shipment Manifest\\n-  - phase: 2\\n-    pr: 199\\n";
    const { exitCode } = runLaneBoundaryCheck(
      'Revert "feat(daemon): Plan-004 run lifecycle handlers"',
      "revert-199-feat/plan-004-run-handlers",
      `{"filename": "packages/runtime-daemon/src/a.ts", "patch": ""}\n` +
        `{"filename": "docs/plans/004-agent-runs-and-lifecycle.md", "patch": "${manifestPatch}"}\n`,
    );
    expect(exitCode).toBe(0);
  });

  it("halts (exit 1) on a malformed JSON changed-file line instead of misreading it as a path", () => {
    const { exitCode, message } = runLaneBoundaryCheck(
      "feat(daemon): Plan-004 run handlers",
      "feat/plan-004-run-handlers",
      '{"filename": "packages/a.ts", broken\n',
    );
    expect(exitCode).toBe(1);
    expect(message).toContain("malformed JSON changed-file line");
  });

  it("emits ::error:: and exit 1 for the tokenless material diff on a plan-scoped branch", () => {
    const { exitCode, message } = runLaneBoundaryCheck(
      "feat(daemon): run lifecycle handlers",
      "feat/plan-004-run-handlers",
      "packages/runtime-daemon/src/a.ts\ndocs/plans/004-agent-runs-and-lifecycle.md\n",
    );
    expect(exitCode).toBe(1);
    expect(message).toContain("::error title=lane-boundary violation::");
  });
});

describe("CLI (spawned — the direct-invocation path tests cannot reach via import)", () => {
  function spawnCli(env: Record<string, string>, stdin: string): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, ["--experimental-strip-types", BIN_PATH], {
      input: stdin,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }

  it("exits 0 on the normal lane-1 shape (plan-scoped branch, no plan-doc edit)", () => {
    const run = spawnCli(
      { PR_TITLE: "feat(daemon): Plan-004 run handlers", PR_BRANCH: "feat/plan-004-run-handlers" },
      "packages/runtime-daemon/src/a.ts\n",
    );
    expect(run.status).toBe(0);
  });

  it("exits 1 with an ::error:: annotation on a violation", () => {
    const run = spawnCli(
      {
        PR_TITLE: "chore(repo): tooling cleanup mentioning Plan-004",
        PR_BRANCH: "chore/tooling-cleanup",
      },
      "packages/runtime-daemon/src/a.ts\n",
    );
    expect(run.status).toBe(1);
    expect(String(run.stdout)).toContain("::error title=lane-boundary violation::");
  });

  it("exits 1 on a deploy/-only diff with an undeclared plan title (deploy/ is material — Plan-025 T-025d-14-1 class)", () => {
    const run = spawnCli(
      {
        PR_TITLE: "chore(repo): self-host compose tweaks mentioning Plan-025",
        PR_BRANCH: "chore/self-host-compose",
      },
      "deploy/self-host/docker-compose.yml\n",
    );
    expect(run.status).toBe(1);
    expect(String(run.stdout)).toContain("::error title=lane-boundary violation::");
  });
});

describe("G6 sync contract", () => {
  it("MATERIAL_PATH_PREFIXES is identical to preflight.mjs's (the guard must classify material exactly as the gate does)", () => {
    expect([...MATERIAL_PATH_PREFIXES]).toEqual([...G6_MATERIAL_PATH_PREFIXES]);
  });
});
