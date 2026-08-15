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
  hasPlanTitleToken,
  runPreflight,
  setGhImpl,
  resetGhImpl,
  FRESHNESS_FETCH_LIMIT,
} from "../preflight.mjs";

// Fixture titles CARRY the plan's `Plan-NNN` token throughout. That is not
// decoration: `gh pr list --search "Plan-NNN in:title"` only ever returns
// title matches, and the gate re-filters the rows through `hasPlanTitleToken`
// (GitHub's tokenizer is looser than a word boundary — see the §Tokenizer
// post-filter block below). A token-less fixture title models a row the real
// search cannot produce, and would silently exercise the drop path instead of
// the behavior each test names.

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
    listResult: [
      { number: 10, title: "feat(x): fixture (Plan-001 T1.1)", mergedAt: "2026-05-01T00:00:00Z" },
    ],
  });
  const r = gateManifestFreshness(PLAN_SOURCE, 1);
  assert.equal(r.ok, true);
});

test("missing doc-only PR does not count as stale (material-path filter)", () => {
  // Root files are included in the fixture deliberately: real governance PRs
  // whose titles cite plans also ship root files (PR #1: .gitignore, README.md,
  // AGENTS.md under a Plan-001 title). An exclude-docs inversion of the filter
  // would classify that PR material and permanently false-halt Plan-001 — this
  // test pins the allow-list semantics against that regression.
  stubGh({
    listResult: [
      { number: 10, title: "feat(x): fixture (Plan-001 T1.1)", mergedAt: "2026-05-01T00:00:00Z" },
      { number: 11, title: "docs(repo): plan-001 governance", mergedAt: "2026-05-02T00:00:00Z" },
    ],
    viewFilesByPr: {
      11: {
        files: [
          "docs/plans/001-fixture.md",
          "docs/backlog.md",
          ".gitignore",
          "README.md",
          "AGENTS.md",
        ],
      },
    },
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

test("missing material PR halts with rebuild remediation", () => {
  stubGh({
    listResult: [
      { number: 10, title: "feat(x): fixture (Plan-001 T1.1)", mergedAt: "2026-05-01T00:00:00Z" },
      {
        number: 87,
        title: "feat(x): close residuals (Plan-001 T1.2)",
        mergedAt: "2026-05-21T01:34:33Z",
      },
    ],
    viewFilesByPr: { 87: { files: ["packages/x/src/b.ts", "docs/plans/001-fixture.md"] } },
  });
  const r = gateManifestFreshness(PLAN_SOURCE, 1);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "manifest_stale");
  assert.match(r.halt, /PR #87/);
  assert.match(r.halt, /merged 2026-05-21/);
  assert.match(r.halt, /1 material file\(s\)/);
  assert.match(r.halt, /rebuild-shipment-manifest\.mjs/);
  assert.match(r.halt, /--plan 001 --dry-run/);
  assert.match(r.halt, /--allow-stale-manifest/);
});

test("apps/ paths count as material", () => {
  stubGh({
    listResult: [
      {
        number: 74,
        title: "fix(desktop): gc lift (Plan-001 T5.2)",
        mergedAt: "2026-05-18T00:00:00Z",
      },
    ],
    viewFilesByPr: { 74: { files: ["apps/desktop/src/main/index.ts"] } },
  });
  const r = gateManifestFreshness(PLAN_SOURCE, 1);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "manifest_stale");
});

test("workflow-only PR counts as material (Plan-024 T-024-4-1 class)", () => {
  // Plan-024 Phase 4 ships tasks whose ONLY file is a .github/workflows/*.yml
  // (sidecar-build.yml). A packages/apps-only allow-list would classify such a
  // shipment doc-only and let Gate 3 re-open shipped work (Codex P2, PR #182).
  stubGh({
    listResult: [
      {
        number: 200,
        title: "ci(repo): sidecar build matrix (Plan-024 T-024-4-1)",
        mergedAt: "2026-08-01T00:00:00Z",
      },
    ],
    viewFilesByPr: { 200: { files: [".github/workflows/sidecar-build.yml"] } },
  });
  // Plan number 24, matching the fixture title's token — the manifest block is
  // plan-agnostic (it records PR 10 only), so the Plan-001 fixture source works
  // unchanged and the title/search/plan-number triple stays self-consistent.
  const r = gateManifestFreshness(PLAN_SOURCE, 24);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "manifest_stale");
  assert.match(r.halt, /PR #200/);
});

test("deploy/-only PR counts as material (Plan-025 T-025d-14-1 class)", () => {
  // Plan-025's T-025d-14-1 ships only deploy/self-host/* (compose file +
  // cert-init script). Before deploy/ joined MATERIAL_PATH_PREFIXES the gate
  // classified such a shipment doc-only — the G6 blind spot the token-first
  // rebuild redesign (PR #192 rounds 2-4) could only work around downstream.
  stubGh({
    listResult: [
      {
        number: 210,
        title: "feat(relay): self-host compose reference (Plan-025 T-025d-14-1)",
        mergedAt: "2026-08-01T00:00:00Z",
      },
    ],
    viewFilesByPr: { 210: { files: ["deploy/self-host/docker-compose.yml"] } },
  });
  const r = gateManifestFreshness(PLAN_SOURCE, 25);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "manifest_stale");
  assert.match(r.halt, /PR #210/);
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
    listResult: [
      { number: 12, title: "feat(x): a (Plan-001 T1.3)", mergedAt: "2026-05-01T00:00:00Z" },
    ],
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
    listResult: [
      { number: 13, title: "feat(x): b (Plan-001 T1.4)", mergedAt: "2026-05-01T00:00:00Z" },
    ],
    viewFilesByPr: { 13: { raw: "<html>rate limited</html>" } },
  });
  const r = gateManifestFreshness(PLAN_SOURCE, 1);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "freshness_gh_malformed");
});

test("fetch saturation halts rather than silently truncating", () => {
  const saturated = Array.from({ length: FRESHNESS_FETCH_LIMIT }, (_, i) => ({
    number: 1000 + i,
    title: `feat(x): pr ${i} (Plan-001 T9.${i})`,
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
    listResult: [
      { number: 14, title: "feat(x): c (Plan-001 T1.5)", mergedAt: "2026-05-01T00:00:00Z" },
    ],
    viewFilesByPr: { 14: { files: ["packages/x/src/c.ts"], changedFiles: 150 } },
  });
  const r = gateManifestFreshness(PLAN_SOURCE, 1);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "freshness_files_truncated");
  assert.match(r.halt, /1 of/);
  assert.match(r.halt, /150 changed files/);
});

// ============================================================
// Tokenizer post-filter (hasPlanTitleToken)
// ============================================================

// GitHub's `in:title` search is a TOKENIZER match, so `gh pr list` returns rows
// whose titles carry no literal `Plan-NNN`. `rebuild-shipment-manifest.mjs` —
// the tool this gate's halt prescribes as the remedy — imports this same
// predicate; when the two disagreed on the population the pair DEADLOCKED
// (2026-08-15, PR #216: the gate halted naming a PR the remedy refused to emit
// an entry for). These arms pin the contract from both sides.

const COMPOUND_TITLE = "chore(repo): retire Plan-007/025 compact-inline cite exemptions";

test("compound Plan-007/025 title is NOT a Plan-025 token (the PR #216 deadlock class)", () => {
  // GitHub tokenized `Plan-007/025` and returned this row for
  // `Plan-025 in:title` even though the literal token `Plan-025` never occurs.
  assert.equal(hasPlanTitleToken(COMPOUND_TITLE, "025"), false);
});

test("the SAME compound title IS a Plan-007 token (word-boundary truth, not over-broad)", () => {
  // `/` is a word boundary, so `Plan-007` really is cited here. The filter must
  // not "fix" this by loosening — that residual is what `non_shipment_prs`
  // exists for, and a predicate that dropped this row would blind the gate to
  // every genuine compound-title shipment.
  assert.equal(hasPlanTitleToken(COMPOUND_TITLE, "007"), true);
});

test("canonical lane-1 title is matched (the filter does not blind the gate)", () => {
  assert.equal(
    hasPlanTitleToken("feat(daemon): spawn-cwd-translator (Plan-025 T5.4)", "025"),
    true,
  );
});

test("case-insensitive: a lowercase plan-001 title stays visible", () => {
  // GitHub's search matches case-insensitively, so a local filter that did not
  // would drop rows the gate is supposed to judge.
  assert.equal(hasPlanTitleToken("docs(repo): plan-001 governance", "001"), true);
});

test("numeric-collision titles are rejected (ADR-NNN / cp-NNN-N tokenizer artifacts)", () => {
  // Both are real corpus titles the 2026-08-15 sweep found the tokenizer
  // returning; neither cites the plan.
  assert.equal(hasPlanTitleToken("feat(repo): add ADR-024 and plan-execution skill", "024"), false);
  assert.equal(
    hasPlanTitleToken("docs(repo): register plan-006 sourceEpoch carrier (cp-004-12)", "004"),
    false,
  );
});

test("a non-string title is not a token (gh JSON with a null title)", () => {
  assert.equal(hasPlanTitleToken(undefined, "001"), false);
  assert.equal(hasPlanTitleToken(null, "001"), false);
});

test("Gate 6 drops a tokenizer-artifact row BEFORE spending a gh pr view call", () => {
  const calls = stubGh({
    listResult: [{ number: 216, title: COMPOUND_TITLE, mergedAt: "2026-07-18T00:00:00Z" }],
  });
  const r = gateManifestFreshness(PLAN_SOURCE, 25);
  assert.equal(r.ok, true);
  // No stub is registered for #216, so a per-PR fetch would have thrown; assert
  // the absence directly too, since the saving is part of the contract.
  assert.equal(
    calls.filter((c) => c.includes("gh pr view")).length,
    0,
    "filtered rows must not cost an API call",
  );
});

// ============================================================
// Ratified non-shipments (non_shipment_prs)
// ============================================================

// The residual the tokenizer filter cannot close: a GENUINE title token on a PR
// that shipped no task of the plan. Ratification is explicit and greppable —
// an unratified PR of the same shape still halts.

const RATIFIED_PLAN_SOURCE = PLAN_SOURCE.replace(
  "manifest_schema_version: 1",
  "manifest_schema_version: 1\nnon_shipment_prs: [216]",
);

test("a ratified non-shipment is subtracted from the population (no halt, no fetch)", () => {
  const calls = stubGh({
    listResult: [{ number: 216, title: COMPOUND_TITLE, mergedAt: "2026-07-18T00:00:00Z" }],
  });
  // Plan 007: the title IS a real token here, so ONLY the ratification can
  // clear it — this arm cannot pass by accident through the tokenizer filter.
  const r = gateManifestFreshness(RATIFIED_PLAN_SOURCE, 7);
  assert.equal(r.ok, true);
  assert.equal(calls.filter((c) => c.includes("gh pr view")).length, 0);
});

test("the same PR halts when NOT ratified (the escape is the only thing clearing it)", () => {
  stubGh({
    listResult: [{ number: 216, title: COMPOUND_TITLE, mergedAt: "2026-07-18T00:00:00Z" }],
    viewFilesByPr: { 216: { files: [".github/workflows/docs-corpus.yml"] } },
  });
  const r = gateManifestFreshness(PLAN_SOURCE, 7);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "manifest_stale");
  assert.match(r.halt, /PR #216/);
  // The halt must teach the ratification path, or an operator facing a
  // no-honest-entry-shape PR has a halt and no move.
  assert.match(r.halt, /non_shipment_prs/);
});

test("ratification is per-PR, not a blanket mute (an unlisted material PR still halts)", () => {
  stubGh({
    listResult: [
      { number: 216, title: COMPOUND_TITLE, mergedAt: "2026-07-18T00:00:00Z" },
      {
        number: 217,
        title: "feat(daemon): real shipment (Plan-007 T-007p-9-1)",
        mergedAt: "2026-07-19T00:00:00Z",
      },
    ],
    viewFilesByPr: { 217: { files: ["packages/runtime-daemon/src/x.ts"] } },
  });
  const r = gateManifestFreshness(RATIFIED_PLAN_SOURCE, 7);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "manifest_stale");
  assert.match(r.halt, /PR #217/);
  assert.doesNotMatch(r.halt, /PR #216/);
});

test("a malformed non_shipment_prs value defers to Gate 3 rather than passing silently", () => {
  // parseManifestBlock fails closed on a bad value, and Gate 6 routes every
  // unparseable manifest to Gate 3's richer halt — so a typo can never widen
  // the exemption, it stops the run.
  const malformed = PLAN_SOURCE.replace(
    "manifest_schema_version: 1",
    'manifest_schema_version: 1\nnon_shipment_prs: ["216"]',
  );
  const calls = stubGh({ listResult: [] });
  const r = gateManifestFreshness(malformed, 7);
  assert.equal(r.ok, true);
  assert.equal(r.reason, "deferred_to_gate3");
  assert.equal(calls.length, 0);
});

test("saturation is measured on the RAW fetch, before either filter", () => {
  // Ordering guard: if the filters ran first, a saturated page of rows that all
  // get dropped would look like a clean empty result and the gate would pass on
  // a possibly-truncated page.
  const saturated = Array.from({ length: FRESHNESS_FETCH_LIMIT }, (_, i) => ({
    number: 2000 + i,
    title: `chore(repo): unrelated ${i}`,
    mergedAt: "2026-05-01T00:00:00Z",
  }));
  stubGh({ listResult: saturated });
  const r = gateManifestFreshness(PLAN_SOURCE, 1);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "freshness_fetch_saturated");
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
    listResult: [
      {
        number: 87,
        title: "feat(x): residuals (Plan-001 T1.2)",
        mergedAt: "2026-05-21T00:00:00Z",
      },
    ],
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
