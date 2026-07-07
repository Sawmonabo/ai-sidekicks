// node:test suite for rebuild-shipment-manifest.mjs.
// Run via:
//   node --test --experimental-strip-types \
//     .claude/skills/plan-execution/scripts/__tests__/rebuild-shipment-manifest.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import {
  parseArgs,
  parsePhaseFromPr,
  parseTaskFromPr,
  buildEntryFromPr,
  fetchMergedPrNumbers,
  fetchPrDetails,
  resolvePlanFile,
  rebuildManifest,
} from "../rebuild-shipment-manifest.mjs";

// ---------- parseArgs ----------

test("parseArgs: requires --plan", () => {
  assert.throws(() => parseArgs([]), /--plan is required/);
});

test("parseArgs: rejects malformed --plan", () => {
  assert.throws(() => parseArgs(["--plan", "1"]), /--plan requires a 3-digit value/);
  assert.throws(() => parseArgs(["--plan", "abc"]), /--plan requires a 3-digit value/);
});

test("parseArgs: happy path", () => {
  assert.deepEqual(parseArgs(["--plan", "001"]), {
    plan: "001",
    dryRun: false,
    force: false,
    includeBodyMatches: false,
  });
});

test("parseArgs: --dry-run + --force", () => {
  assert.deepEqual(parseArgs(["--plan", "001", "--dry-run", "--force"]), {
    plan: "001",
    dryRun: true,
    force: true,
    includeBodyMatches: false,
  });
});

test("parseArgs: rejects unknown flag", () => {
  assert.throws(() => parseArgs(["--plan", "001", "--bogus"]), /unknown flag: --bogus/);
});

// ---------- parsePhaseFromPr ----------

test("parsePhaseFromPr: extracts from title (Phase N)", () => {
  assert.equal(parsePhaseFromPr({ title: "feat: Phase 5 work", body: null }), 5);
});

test("parsePhaseFromPr: extracts from body when title silent", () => {
  assert.equal(parsePhaseFromPr({ title: "feat: misc", body: "Plan-001 Phase 3" }), 3);
});

test("parsePhaseFromPr: extracts from PN.M form", () => {
  assert.equal(parsePhaseFromPr({ title: "feat: P5.1 client SDK", body: null }), 5);
});

// Codex P2 finding on PR #35 round 5: the bare /\bP\d+\b/ matcher collided
// with review-priority labels (P1/P2/P3) that Codex itself emits. A PR body
// quoting Codex feedback ("addresses Codex P1 finding") would have P1 parsed
// as a phase number, writing a syntactically valid but semantically wrong
// manifest entry. The matcher now requires the `.M` task suffix (the only
// shape Plan-001 actually uses).
test("parsePhaseFromPr: bare P1 in body does NOT match (priority-label collision)", () => {
  assert.equal(
    parsePhaseFromPr({
      title: "fix: bug",
      body: "addresses Codex P1 finding from prior PR review",
    }),
    null,
  );
});

test("parsePhaseFromPr: bare P2 in title does NOT match", () => {
  assert.equal(parsePhaseFromPr({ title: "fix: P2 priority cleanup", body: null }), null);
});

test("parsePhaseFromPr: P5.1 (Plan-001 style) still matches after tightening", () => {
  assert.equal(parsePhaseFromPr({ title: "feat: P5.1 client SDK", body: null }), 5);
});

// Codex P2 finding on PR #35 round 6: parsePhaseFromPr previously had no
// cross-plan scoping (parseTaskFromPr already had it from round 1). A PR
// body citing "see Plan-001 Phase 5" in a Plan-024 PR could leak phase 5
// into Plan-024's manifest. The fix mirrors parseTaskFromPr's defense:
// when the matched text contains a Plan-NNN reference NOT equal to the
// target plan, that text is skipped.
test("parsePhaseFromPr: cross-plan citation in body does NOT leak into target plan", () => {
  // Plan-024 PR whose body references Plan-001 Phase 5 for context
  const r = parsePhaseFromPr({
    title: "feat(rust-crate): scaffolding",
    body: "Cross-plan note: see Plan-001 Phase 5 for the SDK consumer surface.",
    plan: "024",
  });
  assert.equal(r, null);
});

test("parsePhaseFromPr: same text with target Plan-NNN ref still captures", () => {
  // Same shape as above but the body cites the TARGET plan — capture proceeds.
  const r = parsePhaseFromPr({
    title: "feat(rust-crate): scaffolding",
    body: "Plan-024 Phase 1 — scaffolding the rust crate.",
    plan: "024",
  });
  assert.equal(r, 1);
});

test("parsePhaseFromPr: bare phase text with no Plan ref still captures (back-compat)", () => {
  // Most PR titles are bare "Phase N" with no Plan ref — those must still match.
  const r = parsePhaseFromPr({
    title: "feat: Phase 3 work",
    body: null,
    plan: "001",
  });
  assert.equal(r, 3);
});

test("parsePhaseFromPr: returns null when no marker", () => {
  assert.equal(parsePhaseFromPr({ title: "fix: bug", body: "no markers here" }), null);
});

test("parsePhaseFromPr: title wins over body", () => {
  assert.equal(parsePhaseFromPr({ title: "Phase 2 fix", body: "Phase 9" }), 2);
});

// ---------- parseTaskFromPr ----------

test("parseTaskFromPr: extracts T-NNN-N-N form constrained to plan", () => {
  const r = parseTaskFromPr({ title: "Plan-007 T-007p-3-1", body: null, plan: "007" });
  assert.equal(r, "T-007p-3-1");
});

test("parseTaskFromPr: ignores T-NNN cite for different plan", () => {
  const r = parseTaskFromPr({ title: "Plan-024 fix; refs T-007p-3-1", body: null, plan: "024" });
  assert.equal(r, null);
});

test("parseTaskFromPr: extracts TN.M form when text references the target plan", () => {
  const r = parseTaskFromPr({
    title: "feat: T5.1 sessionClient (Plan-001)",
    body: null,
    plan: "001",
  });
  assert.equal(r, "T5.1");
});

test("parseTaskFromPr: returns array for multi-task PR", () => {
  const r = parseTaskFromPr({
    title: "Plan-007 multi: T-007p-3-1, T-007p-3-2, T-007p-3-4",
    body: null,
    plan: "007",
  });
  assert.deepEqual(r, ["T-007p-3-1", "T-007p-3-2", "T-007p-3-4"]);
});

test("parseTaskFromPr: dedupes across title and body", () => {
  const r = parseTaskFromPr({
    title: "feat: T5.1 sessionClient (Plan-001)",
    body: "Plan-001 — implements T5.1; see commit history.",
    plan: "001",
  });
  assert.equal(r, "T5.1");
});

test("parseTaskFromPr: returns null when no task ID", () => {
  assert.equal(parseTaskFromPr({ title: "Phase 1 bootstrap", body: null, plan: "001" }), null);
});

test("parseTaskFromPr: ignores TN.M cite when text references multiple plans (cross-plan defense)", () => {
  // Codex P2 finding on PR #35: a Plan-024 PR cross-referencing "Plan-001
  // T5.1" must NOT mis-record T5.1 as Plan-024's shipped task.
  const r = parseTaskFromPr({
    title: "feat: Plan-024 fix; refs Plan-001 T5.1 for context",
    body: null,
    plan: "024",
  });
  assert.equal(r, null);
});

test("parseTaskFromPr: ignores TN.M cite when text has no Plan-NNN reference", () => {
  // Same defense: TN.M without an in-text plan anchor is too ambiguous to
  // auto-bind. The operator-confirmation path takes over instead.
  const r = parseTaskFromPr({ title: "feat: T5.1 sessionClient", body: null, plan: "001" });
  assert.equal(r, null);
});

test("parseTaskFromPr: still extracts plan-scoped T-NNNp?-N-N even when other plans are referenced", () => {
  // The plan-scoped pattern carries the plan id inline, so it stays safe
  // regardless of cross-plan text references.
  const r = parseTaskFromPr({
    title: "feat: Plan-007 T-007p-3-1 — see Plan-001 T5.1 for context",
    body: null,
    plan: "007",
  });
  assert.equal(r, "T-007p-3-1");
});

// ---------- buildEntryFromPr ----------

const SAMPLE_DETAILS = {
  title: "feat(client-sdk): add sessionClient transports (Plan-001 T5.1)",
  body: "Implements T5.1 of Plan-001 Phase 5.",
  mergedAt: "2026-05-05T18:34:11Z",
  mergeCommit: { oid: "7e4ae47abc1234" },
  files: [{ path: "packages/client-sdk/src/sessionClient.ts" }],
};

test("buildEntryFromPr: happy path with all fields", () => {
  const { entry, ambiguities } = buildEntryFromPr({ pr: 30, details: SAMPLE_DETAILS, plan: "001" });
  assert.deepEqual(ambiguities, []);
  assert.equal(entry.phase, 5);
  assert.equal(entry.task, "T5.1");
  assert.equal(entry.pr, 30);
  assert.equal(entry.sha, "7e4ae47");
  assert.equal(entry.merged_at, "2026-05-05");
  assert.deepEqual(entry.files, ["packages/client-sdk/src/sessionClient.ts"]);
  assert.match(entry.notes, /Backfill from PR #30/);
});

test("buildEntryFromPr: surfaces ambiguity for missing phase", () => {
  const details = { ...SAMPLE_DETAILS, title: "fix: bug", body: "no marker" };
  const { entry, ambiguities } = buildEntryFromPr({ pr: 99, details, plan: "001" });
  assert.equal(entry.phase, 0);
  assert.ok(ambiguities.some((a) => /phase not in title\/body/.test(a)));
  assert.match(entry.notes, /Operator confirmed/);
});

test("buildEntryFromPr: surfaces ambiguity for missing task", () => {
  const details = { ...SAMPLE_DETAILS, title: "feat: Phase 1 bootstrap", body: "" };
  const { entry, ambiguities } = buildEntryFromPr({ pr: 6, details, plan: "001" });
  assert.equal(entry.phase, 1);
  assert.equal(entry.task, "");
  assert.ok(ambiguities.some((a) => /no task-id/.test(a)));
});

test("buildEntryFromPr: array task form passes through", () => {
  const details = {
    ...SAMPLE_DETAILS,
    title: "feat: Plan-007 multi T-007p-3-1, T-007p-3-2, T-007p-3-4",
    body: null,
  };
  const { entry } = buildEntryFromPr({ pr: 19, details, plan: "007" });
  assert.deepEqual(entry.task, ["T-007p-3-1", "T-007p-3-2", "T-007p-3-4"]);
});

test("buildEntryFromPr: empty files array when gh returns empty", () => {
  const details = { ...SAMPLE_DETAILS, files: [] };
  const { entry } = buildEntryFromPr({ pr: 30, details, plan: "001" });
  assert.deepEqual(entry.files, []);
});

// ---------- fetchMergedPrNumbers + fetchPrDetails (gh runner injection) ----------

test("fetchMergedPrNumbers: passes gh args verbatim and parses JSON", () => {
  let calledWith = null;
  const ghRunner = (cmd) => {
    calledWith = cmd;
    return JSON.stringify([{ number: 30 }, { number: 6 }, { number: 9 }]);
  };
  const result = fetchMergedPrNumbers({ plan: "001", ghRunner });
  assert.deepEqual(result, [6, 9, 30]);
  assert.match(calledWith, /gh pr list --state merged/);
  assert.match(calledWith, /--search "Plan-001 in:title,body"/);
  assert.match(calledWith, /--limit 1000/);
});

test("fetchMergedPrNumbers: search query is constrained to title/body fields", () => {
  // Codex P2 finding on PR #35 round 2: without `in:title,body`, the GitHub
  // search default also matches PR comments / discussion threads — an
  // unrelated PR mentioning "Plan-001" in passing would land in the result
  // set and corrupt the rebuilt manifest. The qualifier keeps the source
  // set deterministic.
  let calledWith = null;
  const ghRunner = (cmd) => {
    calledWith = cmd;
    return JSON.stringify([]);
  };
  fetchMergedPrNumbers({ plan: "024", ghRunner });
  assert.match(calledWith, /in:title,body/);
});

test("fetchMergedPrNumbers: throws exitCode=6 when result hits FETCH_LIMIT (saturation)", () => {
  // Codex P1 finding on PR #35: gh pr list silently truncates at --limit, so
  // a saturated result MAY be incomplete. Loud failure beats silent omission.
  const saturated = Array.from({ length: 1000 }, (_, i) => ({ number: i + 1 }));
  const ghRunner = () => JSON.stringify(saturated);
  let caught = null;
  try {
    fetchMergedPrNumbers({ plan: "001", ghRunner });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "expected throw on saturation");
  assert.equal(caught.exitCode, 6);
  assert.match(caught.message, /maximum 1000 matches/);
  assert.match(caught.message, /MAY be truncated/);
});

test("fetchMergedPrNumbers: does NOT throw when result is below FETCH_LIMIT", () => {
  // 999 is below the cap → safe.
  const ghRunner = () => JSON.stringify(Array.from({ length: 999 }, (_, i) => ({ number: i + 1 })));
  const result = fetchMergedPrNumbers({ plan: "001", ghRunner });
  assert.equal(result.length, 999);
});

test("fetchPrDetails: forwards PR number into command", () => {
  let calledWith = null;
  const ghRunner = (cmd) => {
    calledWith = cmd;
    return JSON.stringify(SAMPLE_DETAILS);
  };
  const result = fetchPrDetails({ pr: 30, ghRunner });
  assert.deepEqual(result, SAMPLE_DETAILS);
  assert.match(calledWith, /gh pr view 30 --json title,body,mergedAt,mergeCommit,files/);
});

// Codex P2 finding on PR #35 round 4: gh pr view --json files issues a single
// pullRequest.files(first: 100) GraphQL query with no internal pagination, so
// PRs above the 100-file ceiling silently truncate. fetchPrDetails now also
// requests changedFiles (the authoritative count) and halts with exit 7 when
// returned files.length is below it.
test("fetchPrDetails: requests changedFiles alongside files", () => {
  let calledWith = null;
  const ghRunner = (cmd) => {
    calledWith = cmd;
    return JSON.stringify({ ...SAMPLE_DETAILS, changedFiles: 1 });
  };
  fetchPrDetails({ pr: 30, ghRunner });
  assert.match(calledWith, /--json title,body,mergedAt,mergeCommit,files,changedFiles/);
});

test("fetchPrDetails: throws exitCode=7 when files.length < changedFiles (truncation)", () => {
  const ghRunner = () =>
    JSON.stringify({
      ...SAMPLE_DETAILS,
      files: Array.from({ length: 100 }, (_, i) => ({ path: `f${i}.ts` })),
      changedFiles: 137,
    });
  try {
    fetchPrDetails({ pr: 99, ghRunner });
    assert.fail("expected fetchPrDetails to throw on truncation");
  } catch (e) {
    assert.equal(e.exitCode, 7);
    assert.match(e.message, /returned 100 of 137 changed files/);
  }
});

test("fetchPrDetails: does NOT throw when files.length === changedFiles", () => {
  const ghRunner = () =>
    JSON.stringify({
      ...SAMPLE_DETAILS,
      files: [{ path: "a.ts" }, { path: "b.ts" }],
      changedFiles: 2,
    });
  const r = fetchPrDetails({ pr: 30, ghRunner });
  assert.equal(r.changedFiles, 2);
  assert.equal(r.files.length, 2);
});

// ---------- resolvePlanFile ----------

test("resolvePlanFile: returns the matching plan path", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rsm-plans-"));
  try {
    mkdirSync(join(tmp, "docs", "plans"), { recursive: true });
    writeFileSync(join(tmp, "docs", "plans", "001-shared-session-core.md"), "# Plan-001\n");
    const r = resolvePlanFile({ plan: "001", plansDir: join(tmp, "docs", "plans") });
    assert.equal(r, join(tmp, "docs", "plans", "001-shared-session-core.md"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolvePlanFile: returns null when missing", () => {
  const r = resolvePlanFile({ plan: "999", plansDir: "/no/such/dir" });
  assert.equal(r, null);
});

test("resolvePlanFile: returns null when ambiguous", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rsm-plans-"));
  try {
    mkdirSync(join(tmp, "docs", "plans"), { recursive: true });
    writeFileSync(join(tmp, "docs", "plans", "001-a.md"), "");
    writeFileSync(join(tmp, "docs", "plans", "001-b.md"), "");
    const r = resolvePlanFile({ plan: "001", plansDir: join(tmp, "docs", "plans") });
    assert.equal(r, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- rebuildManifest end-to-end (with fake gh runner) ----------

const PLAN_TEMPLATE = `# Plan-001: Shared Session Core

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped: []
\`\`\`

### Notes

`;

function makeGhRunner({ prList, prDetails }) {
  return (cmd) => {
    if (/gh pr list/.test(cmd)) return JSON.stringify(prList.map((n) => ({ number: n })));
    const m = /gh pr view (\d+)/.exec(cmd);
    if (!m) throw new Error(`unexpected gh cmd: ${cmd}`);
    const pr = Number(m[1]);
    const details = prDetails[pr];
    if (!details) throw new Error(`no fixture for PR #${pr}`);
    return JSON.stringify(details);
  };
}

test("rebuildManifest: dry-run emits YAML, writes nothing", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rsm-e2e-"));
  try {
    const planDir = join(tmp, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    const planFile = join(planDir, "001-shared-session-core.md");
    writeFileSync(planFile, PLAN_TEMPLATE);

    const ghRunner = makeGhRunner({
      prList: [30],
      prDetails: { 30: SAMPLE_DETAILS },
    });

    const stdout = {
      lines: [],
      write(s) {
        this.lines.push(s);
      },
    };
    const r = await rebuildManifest({
      plan: "001",
      dryRun: true,
      force: false,
      ghRunner,
      plansDir: planDir,
      stdout,
    });
    assert.equal(r.exitCode, 0);
    const out = stdout.lines.join("");
    assert.match(out, /manifest_schema_version: 1/);
    assert.match(out, /- phase: 5/);
    assert.match(out, /task: T5\.1/);
    // Plan file unchanged.
    assert.equal(readFileSync(planFile, "utf8"), PLAN_TEMPLATE);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("rebuildManifest: write mode appends entries to plan file", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rsm-e2e-"));
  try {
    const planDir = join(tmp, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    const planFile = join(planDir, "001-shared-session-core.md");
    writeFileSync(planFile, PLAN_TEMPLATE);

    const ghRunner = makeGhRunner({
      prList: [30],
      prDetails: { 30: SAMPLE_DETAILS },
    });

    const r = await rebuildManifest({
      plan: "001",
      dryRun: false,
      force: false,
      ghRunner,
      plansDir: planDir,
    });
    assert.equal(r.exitCode, 0);
    const after = readFileSync(planFile, "utf8");
    assert.match(after, /- phase: 5/);
    assert.match(after, /task: T5\.1/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("rebuildManifest: refuses to overwrite existing entries without --force", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rsm-e2e-"));
  try {
    const planDir = join(tmp, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    const planFile = join(planDir, "001-shared-session-core.md");
    // Pre-existing entry for PR #30.
    const seeded = PLAN_TEMPLATE.replace(
      "shipped: []",
      `shipped:
  - phase: 5
    task: T5.1
    pr: 30
    sha: 7e4ae47
    merged_at: 2026-05-05
    files:
      - packages/client-sdk/src/sessionClient.ts
    verifies_invariant: []
    spec_coverage: []`,
    );
    writeFileSync(planFile, seeded);

    const ghRunner = makeGhRunner({
      prList: [30],
      prDetails: { 30: SAMPLE_DETAILS },
    });

    const r = await rebuildManifest({
      plan: "001",
      dryRun: false,
      force: false,
      ghRunner,
      plansDir: planDir,
    });
    assert.equal(r.exitCode, 4);
    assert.match(r.message, /manifest already has entries for: #30/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("rebuildManifest: --force allows skipping existing entries", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rsm-e2e-"));
  try {
    const planDir = join(tmp, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    const planFile = join(planDir, "001-shared-session-core.md");
    const seeded = PLAN_TEMPLATE.replace(
      "shipped: []",
      `shipped:
  - phase: 5
    task: T5.1
    pr: 30
    sha: 7e4ae47
    merged_at: 2026-05-05
    files:
      - packages/client-sdk/src/sessionClient.ts
    verifies_invariant: []
    spec_coverage: []`,
    );
    writeFileSync(planFile, seeded);

    const ghRunner = makeGhRunner({
      prList: [30],
      prDetails: { 30: SAMPLE_DETAILS },
    });

    const r = await rebuildManifest({
      plan: "001",
      dryRun: false,
      force: true,
      ghRunner,
      plansDir: planDir,
    });
    assert.equal(r.exitCode, 0);
    // Idempotency: entry already present → 0 new appended.
    assert.match(r.message, /appended 0 new entries/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("rebuildManifest: missing plan file returns exit 3", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rsm-e2e-"));
  try {
    const planDir = join(tmp, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    const r = await rebuildManifest({
      plan: "999",
      dryRun: true,
      force: false,
      ghRunner: () => "[]",
      plansDir: planDir,
      stdout: { write() {} },
    });
    assert.equal(r.exitCode, 3);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("rebuildManifest: validation failure on incomplete PR data returns exit 5", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rsm-e2e-"));
  try {
    const planDir = join(tmp, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    const planFile = join(planDir, "001-shared-session-core.md");
    writeFileSync(planFile, PLAN_TEMPLATE);

    // PR with no merge SHA — fails validateEntry.sha check.
    const broken = { ...SAMPLE_DETAILS, mergeCommit: null };
    const ghRunner = makeGhRunner({
      prList: [30],
      prDetails: { 30: broken },
    });

    const r = await rebuildManifest({
      plan: "001",
      dryRun: true,
      force: false,
      ghRunner,
      plansDir: planDir,
      stdout: { write() {} },
    });
    assert.equal(r.exitCode, 5);
    assert.match(r.message, /PR #30:.*sha/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("rebuildManifest: empty PR list returns exit 0 with message", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rsm-e2e-"));
  try {
    const planDir = join(tmp, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "001-shared-session-core.md"), PLAN_TEMPLATE);
    const r = await rebuildManifest({
      plan: "001",
      dryRun: true,
      force: false,
      ghRunner: () => "[]",
      plansDir: planDir,
      stdout: { write() {} },
    });
    assert.equal(r.exitCode, 0);
    assert.match(r.message, /no merged PRs found/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function makeCaptureStream() {
  return {
    lines: [],
    write(s) {
      this.lines.push(s);
    },
    text() {
      return this.lines.join("");
    },
  };
}

test("rebuildManifest excludes PRs whose title lacks the Plan-NNN token (lane-2 bodies)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rsm-e2e-"));
  try {
    const planDir = join(tmp, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    const planFile = join(planDir, "001-shared-session-core.md");
    writeFileSync(planFile, PLAN_TEMPLATE);

    const ghRunner = makeGhRunner({
      prList: [30, 42],
      prDetails: {
        30: SAMPLE_DETAILS,
        42: {
          title: "feat(daemon): improve session cleanup",
          body: "Tightens idle-session teardown.\n\nRefs: Plan-001",
          mergedAt: "2026-07-01T12:00:00Z",
          mergeCommit: { oid: "abc9876def0000" },
          files: [{ path: "packages/runtime-daemon/src/session-cleanup.ts" }],
        },
      },
    });

    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const r = await rebuildManifest({
      plan: "001",
      dryRun: true,
      force: false,
      ghRunner,
      plansDir: planDir,
      stdout,
      stderr,
    });
    assert.equal(r.exitCode, 0);
    assert.match(stderr.text(), /skipped \(no title token\): PR #42/i); // lane-2 PR listed informationally
    assert.doesNotMatch(stdout.text(), /^\s*pr: 42$/m); // and NEVER synthesized into an entry
    // dry-run stdout is a pure YAML stream — diagnostics never leak into it
    assert.doesNotMatch(stdout.text(), /skipped \(no title token\)/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("rebuildManifest skips a body-only PR before the truncation-sensitive details fetch", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rsm-e2e-"));
  try {
    const planDir = join(tmp, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    const planFile = join(planDir, "001-shared-session-core.md");
    writeFileSync(planFile, PLAN_TEMPLATE);

    const ghRunner = makeGhRunner({
      prList: [30, 42],
      prDetails: {
        30: SAMPLE_DETAILS,
        42: {
          title: "feat(daemon): improve session cleanup",
          body: "Sweeping refactor.\n\nRefs: Plan-001",
          mergedAt: "2026-07-01T12:00:00Z",
          mergeCommit: { oid: "abc9876def0000" },
          // files truncated far below changedFiles — fetchPrDetails would halt
          // with exit 7 if it ran; the title-only probe must skip PR #42 first.
          changedFiles: 200,
          files: [{ path: "packages/runtime-daemon/src/session-cleanup.ts" }],
        },
      },
    });

    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const r = await rebuildManifest({
      plan: "001",
      dryRun: true,
      force: false,
      ghRunner,
      plansDir: planDir,
      stdout,
      stderr,
    });
    assert.equal(r.exitCode, 0);
    assert.match(stderr.text(), /skipped \(no title token\): PR #42/i);
    assert.doesNotMatch(stdout.text(), /^\s*pr: 42$/m);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Pre-mandate squash text: carries the Plan-001 ref in the body but NO
// parseable Phase/T-markers — synthesis would yield phase 0 / empty task
// (the real shape of Plan-001 PR #6/#8/#9/#10 squash bodies).
const UNPARSEABLE_BODY_DETAILS = {
  title: "feat(daemon): improve session cleanup",
  body: "Sweeping refactor.\n\nRefs: Plan-001",
  mergedAt: "2026-07-01T12:00:00Z",
  mergeCommit: { oid: "abc9876def0000" },
  files: [{ path: "packages/runtime-daemon/src/session-cleanup.ts" }],
};

const PARSEABLE_BACKFILL_DETAILS = {
  ...UNPARSEABLE_BODY_DETAILS,
  body: "Backfill of Phase 2 T2.9 work.\n\nRefs: Plan-001",
};

test("rebuildManifest reuses the on-disk entry for a body-only PR the manifest records (no re-synthesis)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rsm-e2e-"));
  try {
    const planDir = join(tmp, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    const planFile = join(planDir, "001-shared-session-core.md");
    writeFileSync(
      planFile,
      PLAN_TEMPLATE.replace(
        "shipped: []",
        [
          "shipped:",
          "  - phase: 2",
          "    task: T2.9",
          "    pr: 42",
          "    sha: abc9876",
          "    merged_at: 2026-07-01",
          "    files:",
          "      - packages/runtime-daemon/src/session-cleanup.ts",
          "    notes: legacy pre-title-mandate shipment",
        ].join("\n"),
      ),
    );

    // Squash text is UNPARSEABLE — re-synthesis would degrade the entry to
    // phase 0 / empty task and fail validation. Reuse must win instead.
    const ghRunner = makeGhRunner({
      prList: [42],
      prDetails: { 42: UNPARSEABLE_BODY_DETAILS },
    });

    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const r = await rebuildManifest({
      plan: "001",
      dryRun: true,
      force: false,
      ghRunner,
      plansDir: planDir,
      stdout,
      stderr,
    });
    assert.equal(r.exitCode, 0);
    assert.match(stderr.text(), /reused existing manifest entry \(body-only title\): PR #42/i);
    assert.match(stdout.text(), /^\s*pr: 42$/m); // legacy shipment stays in the rebuilt manifest
    assert.match(stdout.text(), /^\s*task: T2\.9$/m); // ...with its on-disk fields, not phase-0 synthesis
    assert.match(stdout.text(), /^\s*- phase: 2$/m);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("rebuildManifest --include-body-matches admits parseable body-only PRs for pre-mandate backfill", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rsm-e2e-"));
  try {
    const planDir = join(tmp, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    const planFile = join(planDir, "001-shared-session-core.md");
    writeFileSync(planFile, PLAN_TEMPLATE);

    const ghRunner = makeGhRunner({
      prList: [42],
      prDetails: { 42: PARSEABLE_BACKFILL_DETAILS },
    });

    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const r = await rebuildManifest({
      plan: "001",
      dryRun: true,
      force: false,
      includeBodyMatches: true,
      ghRunner,
      plansDir: planDir,
      stdout,
      stderr,
    });
    assert.equal(r.exitCode, 0);
    assert.match(stderr.text(), /included body-only match \(--include-body-matches/i);
    assert.match(stderr.text(), /operator MUST confirm/i);
    assert.match(stdout.text(), /^\s*pr: 42$/m);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("rebuildManifest --include-body-matches emits operator-confirmation YAML for unparseable candidates", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rsm-e2e-"));
  try {
    const planDir = join(tmp, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    const planFile = join(planDir, "001-shared-session-core.md");
    writeFileSync(planFile, PLAN_TEMPLATE);

    const ghRunner = makeGhRunner({
      prList: [42],
      prDetails: { 42: UNPARSEABLE_BODY_DETAILS },
    });

    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const r = await rebuildManifest({
      plan: "001",
      dryRun: true,
      force: false,
      includeBodyMatches: true,
      ghRunner,
      plansDir: planDir,
      stdout,
      stderr,
    });
    // Pre-redesign this exited 5 (validation failure) with no editable output.
    assert.equal(r.exitCode, 0);
    assert.match(r.message, /operator confirmation/i);
    const out = stdout.text();
    assert.match(out, /# Operator confirmation needed \(body-only matches, unparseable markers\):/);
    assert.match(out, /^#\s+pr: 42$/m); // commented, editable YAML for the candidate
    assert.match(out, /\^ unresolved: /);
    assert.doesNotMatch(out, /^\s*pr: 42$/m); // never written as a live shipped[] entry
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseArgs accepts --include-body-matches", () => {
  const r = parseArgs(["--plan", "001", "--dry-run", "--include-body-matches"]);
  assert.equal(r.includeBodyMatches, true);
  assert.equal(parseArgs(["--plan", "001"]).includeBodyMatches, false);
});

test("CLI --dry-run keeps stdout a pure YAML stream (summary on stderr)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rsm-cli-"));
  try {
    const planDir = join(tmp, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "001-shared-session-core.md"), PLAN_TEMPLATE);

    // PATH-shimmed gh: the CLI path uses defaultGhRunner (real shell-outs),
    // so the fake binary serves the three command shapes the script issues.
    // The full-details case is matched FIRST — its --json list is a superset
    // of the title-only probe's.
    const binDir = join(tmp, "bin");
    mkdirSync(binDir);
    const detailsJson = JSON.stringify({ ...SAMPLE_DETAILS, changedFiles: 1 });
    writeFileSync(
      join(binDir, "gh"),
      [
        "#!/bin/sh",
        'case "$*" in',
        `  *"pr list"*) printf '%s' '[{"number":30}]' ;;`,
        `  *"--json title,body,"*) printf '%s' '${detailsJson}' ;;`,
        `  *"--json title"*) printf '%s' '{"title":"feat(client-sdk): add sessionClient transports (Plan-001 T5.1)"}' ;;`,
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(join(binDir, "gh"), 0o755);

    const scriptPath = fileURLToPath(new URL("../rebuild-shipment-manifest.mjs", import.meta.url));
    const r = spawnSync(process.execPath, [scriptPath, "--plan", "001", "--dry-run"], {
      cwd: tmp,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^# Rebuilt manifest for Plan-001 \(dry run\)/);
    assert.match(r.stdout, /^\s*pr: 30$/m);
    assert.doesNotMatch(r.stdout, /entries emitted/); // summary must not corrupt redirected YAML
    assert.match(r.stderr, /entries emitted/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("rebuildManifest --include-body-matches routes >100-file candidates to operator confirmation", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rsm-e2e-"));
  try {
    const planDir = join(tmp, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    const planFile = join(planDir, "001-shared-session-core.md");
    writeFileSync(planFile, PLAN_TEMPLATE);

    // Legacy monorepo-bootstrap shape: body-only, file list truncated at the
    // 100-file page. Pre-fix the include path threw exit 7 here.
    const ghRunner = makeGhRunner({
      prList: [42],
      prDetails: {
        42: { ...UNPARSEABLE_BODY_DETAILS, changedFiles: 200 },
      },
    });

    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const r = await rebuildManifest({
      plan: "001",
      dryRun: true,
      force: false,
      includeBodyMatches: true,
      ghRunner,
      plansDir: planDir,
      stdout,
      stderr,
    });
    assert.equal(r.exitCode, 0);
    assert.match(
      stderr.text(),
      /file list truncated at the 100-file page — PR #42 routed to operator confirmation/,
    );
    const out = stdout.text();
    assert.match(out, /# Operator confirmation needed \(body-only matches, unparseable markers\):/);
    assert.match(out, /^#\s+pr: 42$/m);
    assert.match(out, /unresolved: file list truncated at the 100-file GraphQL page/);
    assert.doesNotMatch(out, /^\s*pr: 42$/m); // never a live shipped[] entry with partial files
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
