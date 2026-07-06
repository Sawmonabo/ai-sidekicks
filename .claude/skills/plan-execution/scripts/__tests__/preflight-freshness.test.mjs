// node:test suite for preflight.mjs Gate 6 — manifest freshness (BL-110).
// Run via: node --test .claude/skills/plan-execution/scripts/__tests__/preflight-freshness.test.mjs
//
// Every gh interaction goes through the setGhImpl seam; no test touches the
// network. The stub dispatches on the command string, mirroring how the Gate 5
// pr_merged tests stub `gh pr view`.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  gateManifestFreshness,
  runPreflight,
  setGhImpl,
  resetGhImpl,
  FRESHNESS_FETCH_LIMIT,
} from "../preflight.mjs";

afterEach(() => {
  resetGhImpl();
});

const MANIFEST_BLOCK = [
  "## Progress Log",
  "",
  "### Shipment Manifest",
  "",
  "```yaml",
  "manifest_schema_version: 1",
  "shipped:",
  "  - phase: 1",
  "    task: T1.1",
  "    pr: 10",
  "    sha: abc1234",
  "    merged_at: 2026-05-01",
  "    files:",
  "      - packages/x/src/a.ts",
  "```",
].join("\n");

const PLAN_SOURCE = `# Plan-001 Fixture\n\n${MANIFEST_BLOCK}\n`;

// Stub builder: responds to the freshness list/view commands and records every
// command it sees. viewFilesByPr maps PR number -> {files, changedFiles}.
function stubGh({ listResult, viewFilesByPr = {}, listThrows = false }) {
  const calls = [];
  setGhImpl((cmd) => {
    calls.push(cmd);
    if (cmd.includes("gh pr list")) {
      if (listThrows) throw new Error("gh: network unreachable");
      return typeof listResult === "string" ? listResult : JSON.stringify(listResult);
    }
    const viewMatch = cmd.match(/gh pr view (\d+)/);
    if (viewMatch) {
      const pr = Number(viewMatch[1]);
      const spec = viewFilesByPr[pr];
      if (!spec) throw new Error(`gh: no stub for pr ${pr}`);
      if (spec.throws) throw new Error("gh: view unreachable");
      if (spec.raw !== undefined) return spec.raw;
      return JSON.stringify({
        files: spec.files.map((path) => ({ path })),
        changedFiles: spec.changedFiles ?? spec.files.length,
      });
    }
    throw new Error(`unexpected gh command: ${cmd}`);
  });
  return calls;
}

// ============================================================
// Pass paths
// ============================================================

test("fresh manifest — every merged in-title PR has an entry", () => {
  stubGh({
    listResult: [{ number: 10, title: "feat(x): T1.1", mergedAt: "2026-05-01T00:00:00Z" }],
  });
  const r = gateManifestFreshness(PLAN_SOURCE, 1);
  assert.equal(r.ok, true);
});

test("missing doc-only PR does not count as stale (code-touching filter)", () => {
  stubGh({
    listResult: [
      { number: 10, title: "feat(x): T1.1", mergedAt: "2026-05-01T00:00:00Z" },
      { number: 11, title: "docs(repo): plan-001 governance", mergedAt: "2026-05-02T00:00:00Z" },
    ],
    viewFilesByPr: { 11: { files: ["docs/plans/001-fixture.md", "docs/backlog.md"] } },
  });
  const r = gateManifestFreshness(PLAN_SOURCE, 1);
  assert.equal(r.ok, true);
});

test("unparseable manifest defers to Gate 3 (no gh call, no halt here)", () => {
  const calls = stubGh({ listResult: [] });
  const r = gateManifestFreshness("# Plan without manifest\n", 1);
  assert.equal(r.ok, true);
  assert.equal(r.reason, "deferred_to_gate3");
  assert.equal(calls.length, 0);
});

test("future manifest schema stays opaque (fail-open per lib/manifest.mjs policy)", () => {
  const futureSource = PLAN_SOURCE.replace(
    "manifest_schema_version: 1",
    "manifest_schema_version: 99",
  );
  const calls = stubGh({ listResult: [] });
  const r = gateManifestFreshness(futureSource, 1);
  assert.equal(r.ok, true);
  assert.equal(r.reason, "manifest_future_schema");
  assert.equal(calls.length, 0);
});

test("plan number is zero-padded in the search string", () => {
  const calls = stubGh({ listResult: [] });
  gateManifestFreshness(PLAN_SOURCE, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /"Plan-001 in:title"/);
});

// ============================================================
// Stale detection
// ============================================================

test("missing code-touching PR halts with rebuild remediation", () => {
  stubGh({
    listResult: [
      { number: 10, title: "feat(x): T1.1", mergedAt: "2026-05-01T00:00:00Z" },
      { number: 87, title: "feat(x): close residuals", mergedAt: "2026-05-21T01:34:33Z" },
    ],
    viewFilesByPr: { 87: { files: ["packages/x/src/b.ts", "docs/plans/001-fixture.md"] } },
  });
  const r = gateManifestFreshness(PLAN_SOURCE, 1);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "manifest_stale");
  assert.match(r.halt, /PR #87/);
  assert.match(r.halt, /merged 2026-05-21/);
  assert.match(r.halt, /1 code file\(s\)/);
  assert.match(r.halt, /rebuild-shipment-manifest\.mjs/);
  assert.match(r.halt, /--plan 001 --dry-run/);
  assert.match(r.halt, /--allow-stale-manifest/);
});

test("apps/ paths count as code-touching", () => {
  stubGh({
    listResult: [{ number: 74, title: "fix(desktop): gc lift", mergedAt: "2026-05-18T00:00:00Z" }],
    viewFilesByPr: { 74: { files: ["apps/desktop/src/main/index.ts"] } },
  });
  const r = gateManifestFreshness(PLAN_SOURCE, 1);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "manifest_stale");
});

// ============================================================
// Fail-closed paths
// ============================================================

test("gh list failure fails closed and names the escape flag", () => {
  stubGh({ listResult: [], listThrows: true });
  const r = gateManifestFreshness(PLAN_SOURCE, 1);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "freshness_gh_unreachable");
  assert.match(r.halt, /fails closed/);
  assert.match(r.halt, /--allow-stale-manifest/);
});

test("gh view failure mid-loop fails closed", () => {
  stubGh({
    listResult: [{ number: 12, title: "feat: x", mergedAt: "2026-05-01T00:00:00Z" }],
    viewFilesByPr: { 12: { throws: true } },
  });
  const r = gateManifestFreshness(PLAN_SOURCE, 1);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "freshness_gh_unreachable");
});

test("malformed gh list output fails closed", () => {
  stubGh({ listResult: "not json {" });
  const r = gateManifestFreshness(PLAN_SOURCE, 1);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "freshness_gh_malformed");
});

test("non-array gh list output fails closed", () => {
  stubGh({ listResult: '{"number": 1}' });
  const r = gateManifestFreshness(PLAN_SOURCE, 1);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "freshness_gh_malformed");
});

test("malformed gh view output fails closed", () => {
  stubGh({
    listResult: [{ number: 13, title: "feat: y", mergedAt: "2026-05-01T00:00:00Z" }],
    viewFilesByPr: { 13: { raw: "<html>rate limited</html>" } },
  });
  const r = gateManifestFreshness(PLAN_SOURCE, 1);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "freshness_gh_malformed");
});

test("fetch saturation halts rather than silently truncating", () => {
  const saturated = Array.from({ length: FRESHNESS_FETCH_LIMIT }, (_, i) => ({
    number: 1000 + i,
    title: `feat: pr ${i}`,
    mergedAt: "2026-05-01T00:00:00Z",
  }));
  stubGh({ listResult: saturated });
  const r = gateManifestFreshness(PLAN_SOURCE, 1);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "freshness_fetch_saturated");
  assert.match(r.halt, /MAY be truncated/);
});

test("truncated file list halts (files.length < changedFiles)", () => {
  stubGh({
    listResult: [{ number: 14, title: "feat: z", mergedAt: "2026-05-01T00:00:00Z" }],
    viewFilesByPr: { 14: { files: ["packages/x/src/c.ts"], changedFiles: 150 } },
  });
  const r = gateManifestFreshness(PLAN_SOURCE, 1);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "freshness_files_truncated");
  assert.match(r.halt, /1 of/);
  assert.match(r.halt, /150 changed files/);
});

// ============================================================
// runPreflight wiring
// ============================================================

function writePlanFixture() {
  const dir = mkdtempSync(join(tmpdir(), "preflight-freshness-"));
  const skillMd = join(dir, "SKILL.md");
  writeFileSync(skillMd, "---\nname: fixture\n---\n");
  const planFile = join(dir, "001-fixture.md");
  writeFileSync(
    planFile,
    [
      "# Plan-001 Fixture",
      "",
      "- [x] **Plan-readiness audit complete** (fixture)",
      "",
      "### Phase 1 — Fixture Phase",
      "",
      "**Precondition:** none.",
      "",
      "#### Tasks",
      "",
      "##### T1.1 — fixture task",
      "",
      "- Spec coverage: none (fixture)",
      "- Verifies invariant: none (fixture)",
      "",
      MANIFEST_BLOCK,
      "",
    ].join("\n"),
  );
  return { dir, skillMd, planFile };
}

test("runPreflight with checkFreshness halts on a stale manifest before the phase walk", () => {
  const { dir, skillMd, planFile } = writePlanFixture();
  stubGh({
    listResult: [{ number: 87, title: "feat(x): residuals", mergedAt: "2026-05-21T00:00:00Z" }],
    viewFilesByPr: { 87: { files: ["packages/x/src/b.ts"] } },
  });
  const result = runPreflight(planFile, undefined, {
    repoRoot: dir,
    skillMd,
    checkFreshness: true,
  });
  assert.equal(result.exit, 1);
  assert.match(result.stdout, /Gate 6 — manifest freshness/);
});

test("runPreflight default leaves the freshness cross-check off (fixture suites stay network-free)", () => {
  const { dir, skillMd, planFile } = writePlanFixture();
  const calls = stubGh({ listResult: [] });
  runPreflight(planFile, undefined, { repoRoot: dir, skillMd });
  const freshnessCalls = calls.filter((c) => c.includes("gh pr list"));
  assert.equal(freshnessCalls.length, 0);
});
