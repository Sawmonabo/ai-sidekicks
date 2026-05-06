// node:test suite for post-merge-housekeeper.mjs pure parsers (Tasks 3.2-3.6).
// Run via: node --test --experimental-strip-types \
//   .claude/skills/plan-execution/scripts/__tests__/post-merge-housekeeper.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseNsHeading,
  parseSubFields,
  parsePRsBlock,
  computeStatusFromPRs,
  extractFileReferences,
  parseArgs,
  ParseArgsError,
  verifyTypeSignature,
  verifyFileOverlap,
  verifyPlanIdentity,
  applyStatusFlipSinglePr,
  applyMultiPrTickAndRecompute,
  applyMermaidClassSwap,
  tickPlanDoneChecklist,
  emitManifest,
  reserveNextFreeNs,
  checkDuplicateTitle,
  runHousekeeper,
} from "../post-merge-housekeeper.mjs";
import {
  listFixtures,
  readArgs,
  readExpectedManifest,
  expectFilesEqual,
} from "./helpers/fixture-loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// .claude/skills/plan-execution/scripts/__tests__ → repo root is 5 levels up.
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..");
const ENTRY_FILE = join(REPO_ROOT, "docs/architecture/cross-plan-dependencies.md");

// ---------- parseNsHeading (Task 3.2) ----------

test("parseNsHeading parses plain numeric NS heading", () => {
  const result = parseNsHeading("### NS-01: Plan-024 Phase 1 — Rust crate scaffolding");
  assert.deepEqual(result, {
    nsNum: 1,
    suffix: null,
    rangeUpperNum: null,
    title: "Plan-024 Phase 1 — Rust crate scaffolding",
  });
});

test("parseNsHeading parses NS heading with suffix letter", () => {
  const result = parseNsHeading("### NS-13a: Spec-status promotion gate clarification");
  assert.deepEqual(result, {
    nsNum: 13,
    suffix: "a",
    rangeUpperNum: null,
    title: "Spec-status promotion gate clarification",
  });
});

test("parseNsHeading parses range-form NS heading", () => {
  const result = parseNsHeading("### NS-15..NS-21: Tier 3-9 plan-readiness audits");
  assert.deepEqual(result, {
    nsNum: 15,
    suffix: null,
    rangeUpperNum: 21,
    title: "Tier 3-9 plan-readiness audits",
  });
});

test("parseNsHeading returns null for non-NS heading", () => {
  assert.equal(parseNsHeading("### 1.1 The §6 NS-XX convention"), null);
  assert.equal(parseNsHeading("- Status: `todo`"), null);
});

// ---------- parseSubFields (Task 3.3) ----------

test("parseSubFields extracts the seven required sub-fields", () => {
  const body = `- Status: \`todo\`
- Type: code
- Priority: \`P1\`
- Upstream: none
- References: [Plan-024](../plans/024-rust-pty-sidecar.md)
- Summary: prose
- Exit Criteria: ticked`;
  const result = parseSubFields(body);
  assert.equal(result.status.atomic, "todo");
  assert.equal(result.type, "code");
  assert.equal(result.priority.atomic, "P1");
  assert.equal(result.upstream, "none");
  assert.match(result.references, /Plan-024/);
  assert.equal(result.summary, "prose");
  assert.equal(result.exit_criteria, "ticked");
});

test("parseSubFields returns null sub-fields when absent (don't throw)", () => {
  const body = `- Status: \`todo\`
- Type: code`;
  const result = parseSubFields(body);
  assert.equal(result.priority, null);
  assert.equal(result.references, null);
});

test("parseSubFields preserves prose alongside backticked atomic for Status", () => {
  const body = "- Status: `completed` (resolved 2026-05-05 via PR #31 — schema amendment)";
  const result = parseSubFields(body);
  assert.equal(result.status.atomic, "completed");
  assert.equal(result.status.prose, "(resolved 2026-05-05 via PR #31 — schema amendment)");
});

// ---------- parsePRsBlock (Task 3.4) ----------

test("parsePRsBlock parses unchecked + checked items with PR annotations", () => {
  const body = `- PRs:
  - [x] T5.1 — sessionClient + I1-I4 integration tests (PR #34, merged 2026-05-04)
  - [ ] T5.5 — pg.Pool-backed Querier composition
  - [ ] T5.6 — strengthen createSession lock-ordering test`;
  const result = parsePRsBlock(body);
  assert.equal(result.length, 3);
  assert.deepEqual(result[0], {
    taskId: "T5.1",
    description: "sessionClient + I1-I4 integration tests",
    checked: true,
    prNumber: 34,
    mergedAt: "2026-05-04",
  });
  assert.deepEqual(result[1], {
    taskId: "T5.5",
    description: "pg.Pool-backed Querier composition",
    checked: false,
    prNumber: null,
    mergedAt: null,
  });
});

test("parsePRsBlock returns null when no PRs: block present", () => {
  assert.equal(parsePRsBlock("- Status: `todo`\n- Type: code"), null);
});

test("parsePRsBlock throws on malformed checked-item missing PR annotation", () => {
  const body = `- PRs:\n  - [x] T5.1 — but no annotation`;
  assert.throws(() => parsePRsBlock(body), /missing.*PR.*annotation/i);
});

// ---------- computeStatusFromPRs (Task 3.5 — §3a.2 matrix) ----------

test("computeStatusFromPRs row 1: absent PRs returns single-pr completion", () => {
  const result = computeStatusFromPRs({
    prsBlock: null,
    upstreamBlocked: false,
    today: "2026-05-10",
    prNumber: 42,
  });
  assert.match(
    result,
    /^- Status: `completed` \(resolved 2026-05-10 via PR #42 — <TODO subagent prose>\)/,
  );
});

test("computeStatusFromPRs row 2: all unchecked + no upstream → todo", () => {
  const prsBlock = [{ checked: false }, { checked: false }];
  const result = computeStatusFromPRs({ prsBlock, upstreamBlocked: false });
  assert.equal(result, "- Status: `todo`");
});

test("computeStatusFromPRs row 3: all unchecked + upstream blocked → blocked", () => {
  const prsBlock = [{ checked: false }, { checked: false }];
  const result = computeStatusFromPRs({ prsBlock, upstreamBlocked: true });
  assert.equal(result, "- Status: `blocked`");
});

test("computeStatusFromPRs row 4: partial + no upstream → in_progress (last shipped)", () => {
  const prsBlock = [{ checked: true, prNumber: 34, mergedAt: "2026-05-04" }, { checked: false }];
  const result = computeStatusFromPRs({ prsBlock, upstreamBlocked: false });
  assert.match(result, /^- Status: `in_progress` \(last shipped: PR #34, 2026-05-04\)/);
});

test("computeStatusFromPRs row 5: partial + upstream blocked → blocked override", () => {
  const prsBlock = [{ checked: true }, { checked: false }];
  const result = computeStatusFromPRs({ prsBlock, upstreamBlocked: true });
  assert.match(result, /^- Status: `blocked` \(overrides — see Upstream:/);
});

test("computeStatusFromPRs row 6: all checked → completed (resolved via last sub-task)", () => {
  const prsBlock = [
    { checked: true, prNumber: 34, mergedAt: "2026-05-04" },
    { checked: true, prNumber: 38, mergedAt: "2026-05-10" },
  ];
  const result = computeStatusFromPRs({
    prsBlock,
    upstreamBlocked: false,
    today: "2026-05-10",
    prNumber: 38,
  });
  assert.match(
    result,
    /^- Status: `completed` \(resolved 2026-05-10 via PR #38 — last sub-task; <TODO subagent prose>\)/,
  );
});

// ---------- extractFileReferences (Task 3.6 — §3a.4) ----------

test("extractFileReferences: markdown link in References extracts .md path", () => {
  const result = extractFileReferences({
    references: "[Plan-024](../plans/024-rust-pty-sidecar.md)",
    summary: "",
    repoRoot: REPO_ROOT,
    entryFile: ENTRY_FILE,
  });
  assert.deepEqual(result.files, ["docs/plans/024-rust-pty-sidecar.md"]);
  assert.deepEqual(result.directories, []);
});

test("extractFileReferences: bare-path token in Summary extracts source-file path", () => {
  const result = extractFileReferences({
    references: "",
    summary: "Modify packages/runtime-daemon/src/bootstrap/secure-defaults-events.ts:24,35,59",
    repoRoot: REPO_ROOT,
    entryFile: ENTRY_FILE,
  });
  assert.ok(
    result.files.includes("packages/runtime-daemon/src/bootstrap/secure-defaults-events.ts"),
  );
});

test("extractFileReferences: directory-token (trailing slash) goes to directories not files", () => {
  const result = extractFileReferences({
    references: "",
    summary: "diff touches packages/runtime-daemon/src/bootstrap/",
    repoRoot: REPO_ROOT,
    entryFile: ENTRY_FILE,
  });
  assert.deepEqual(result.directories, ["packages/runtime-daemon/src/bootstrap/"]);
  assert.deepEqual(result.files, []);
});

test("extractFileReferences: brace expansion produces Cartesian product (5 extant paths)", () => {
  // Synthetic test against EXTANT packages — every expanded path verified at write-time.
  const summary =
    "Refactor packages/{contracts/src/{session,event,error}.ts,runtime-daemon/src/{index,bootstrap/secure-defaults}.ts}";
  const result = extractFileReferences({
    references: "",
    summary,
    repoRoot: REPO_ROOT,
    entryFile: ENTRY_FILE,
  });
  assert.equal(result.files.length, 5);
  assert.ok(result.files.includes("packages/contracts/src/session.ts"));
  assert.ok(result.files.includes("packages/contracts/src/event.ts"));
  assert.ok(result.files.includes("packages/contracts/src/error.ts"));
  assert.ok(result.files.includes("packages/runtime-daemon/src/index.ts"));
  assert.ok(result.files.includes("packages/runtime-daemon/src/bootstrap/secure-defaults.ts"));
  assert.equal(result.unresolvable.length, 0);
});

test("extractFileReferences: skips Upstream / Type / Status / Priority / Exit Criteria sub-fields", () => {
  // Per spec §3a.4 step 5 scoping note: only References + Summary are scanned.
  const result = extractFileReferences({
    references: "",
    summary: "",
    upstream: "Plan-024:267 — packages/contracts/src/session.ts referenced inline",
    repoRoot: REPO_ROOT,
    entryFile: ENTRY_FILE,
  });
  assert.deepEqual(result.files, []);
});

test("extractFileReferences: filesystem-resolution filter discards typos at top level", () => {
  const result = extractFileReferences({
    references: "",
    summary: "Modify packages/this-package-does-not-exist/src/foo.ts",
    repoRoot: REPO_ROOT,
    entryFile: ENTRY_FILE,
  });
  assert.equal(result.files.length, 0);
  assert.equal(result.unresolvable.length, 1);
  assert.equal(result.unresolvable[0].path, "packages/this-package-does-not-exist/src/foo.ts");
  assert.equal(result.unresolvable[0].path_kind, "file");
});

test("extractFileReferences: filter discards typo'd entries inside brace expansion", () => {
  // Brace-expansion + filter interaction: 3 extant + 1 typo from one token.
  const summary = "Touches packages/contracts/src/{session,event,error,session-typo}.ts";
  const result = extractFileReferences({
    references: "",
    summary,
    repoRoot: REPO_ROOT,
    entryFile: ENTRY_FILE,
  });
  assert.equal(result.files.length, 3);
  assert.ok(result.files.includes("packages/contracts/src/session.ts"));
  assert.ok(result.files.includes("packages/contracts/src/event.ts"));
  assert.ok(result.files.includes("packages/contracts/src/error.ts"));
  assert.equal(result.unresolvable.length, 1);
  assert.equal(result.unresolvable[0].path, "packages/contracts/src/session-typo.ts");
});

// ---------- parseArgs (Task 3.7 — §5.1 step 0) ----------

test("parseArgs requires --candidate-ns OR --auto-create (mutual exclusion)", () => {
  assert.throws(
    () => parseArgs(["30"]),
    /must pass exactly one of --candidate-ns or --auto-create/,
  );
  assert.throws(
    () => parseArgs(["30", "--candidate-ns", "NS-01", "--auto-create"]),
    /mutually exclusive/,
  );
});

test("parseArgs requires at-least-one of --plan / --task / --tier (non-cleanup default)", () => {
  assert.throws(() => parseArgs(["30", "--auto-create"]), /at least one of --plan, --task, --tier/);
});

test("parseArgs accepts pure --candidate-ns (cleanup carve-out — runtime check enforces Type)", () => {
  const args = parseArgs(["30", "--candidate-ns", "NS-22"]);
  assert.equal(args.candidateNs, "NS-22");
  assert.equal(args.plan, null);
  assert.equal(args.task, null);
  assert.equal(args.tier, null);
  assert.equal(args.autoCreate, false);
  assert.equal(args.prNumber, 30);
});

test("parseArgs accepts comma-list --candidate-ns (NS-XX,NS-YY)", () => {
  const args = parseArgs(["30", "--candidate-ns", "NS-04,NS-08"]);
  assert.equal(args.candidateNs, "NS-04,NS-08");
});

test("parseArgs validates --candidate-ns token shape (NS-NN, NS-NNa, NS-NN..NS-NN)", () => {
  assert.equal(parseArgs(["30", "--candidate-ns", "NS-13a"]).candidateNs, "NS-13a");
  assert.equal(parseArgs(["30", "--candidate-ns", "NS-15..NS-21"]).candidateNs, "NS-15..NS-21");
  assert.throws(() => parseArgs(["30", "--candidate-ns", "X-01"]), /--candidate-ns/);
  assert.throws(() => parseArgs(["30", "--candidate-ns", "NS-01,bogus"]), /--candidate-ns/);
});

test("parseArgs validates --plan shape (NNN or NNN-partial)", () => {
  assert.equal(parseArgs(["30", "--plan", "024", "--auto-create"]).plan, "024");
  assert.equal(parseArgs(["30", "--plan", "023-partial", "--auto-create"]).plan, "023-partial");
  assert.throws(() => parseArgs(["30", "--plan", "abc", "--auto-create"]), /--plan/);
});

test("parseArgs validates --phase shape (digit or [A-Z])", () => {
  assert.equal(parseArgs(["30", "--plan", "024", "--phase", "1", "--auto-create"]).phase, "1");
  assert.equal(parseArgs(["30", "--plan", "024", "--phase", "B", "--auto-create"]).phase, "B");
  assert.throws(
    () => parseArgs(["30", "--plan", "024", "--phase", "ab", "--auto-create"]),
    /--phase/,
  );
});

test("parseArgs validates --task shape (D-4 three forms: T<N>, T-NNN-N-N, tier-K)", () => {
  assert.equal(parseArgs(["30", "--plan", "001", "--task", "T5.1", "--auto-create"]).task, "T5.1");
  assert.equal(parseArgs(["30", "--plan", "001", "--task", "T5", "--auto-create"]).task, "T5");
  assert.equal(
    parseArgs(["30", "--plan", "024", "--task", "T-024-2-1", "--auto-create"]).task,
    "T-024-2-1",
  );
  assert.equal(parseArgs(["30", "--task", "tier-3", "--auto-create"]).task, "tier-3");
  assert.throws(
    () => parseArgs(["30", "--plan", "024", "--task", "5.1", "--auto-create"]),
    /--task/,
  );
  assert.throws(() => parseArgs(["30", "--task", "tier-3-9", "--auto-create"]), /--task/);
});

test("parseArgs validates --tier shape (single digit) + accepts as identity token", () => {
  assert.equal(parseArgs(["30", "--tier", "5", "--auto-create"]).tier, "5");
  assert.throws(() => parseArgs(["30", "--tier", "five", "--auto-create"]), /--tier/);
});

test("parseArgs accepts --pr-tag passthrough (no shape validation)", () => {
  const args = parseArgs([
    "30",
    "--plan",
    "002",
    "--pr-tag",
    "plan-readiness-audit-tier-2-complete",
    "--auto-create",
  ]);
  assert.equal(args.prTag, "plan-readiness-audit-tier-2-complete");
});

test("parseArgs validates <PR#> is positive integer (positional)", () => {
  assert.throws(() => parseArgs([]), /missing positional/);
  assert.throws(() => parseArgs(["abc", "--auto-create", "--plan", "024"]), /<PR#>/);
});

test("parseArgs rejects unknown flags (defense against orchestrator drift)", () => {
  assert.throws(
    () => parseArgs(["30", "--candidate-ns", "NS-01", "--bogus"]),
    /unknown flag.*--bogus/,
  );
});

test("parseArgs: mutual-exclusion violations carry exit code ≥6 (Plan Invariant I-7)", () => {
  let err;
  try {
    parseArgs(["30", "--candidate-ns", "NS-01", "--auto-create"]);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ParseArgsError, "expected ParseArgsError");
  assert.ok(typeof err.exitCode === "number", "ParseArgsError must carry exitCode");
  assert.ok(err.exitCode >= 6, `expected exitCode ≥6, got ${err.exitCode}`);

  err = undefined;
  try {
    parseArgs(["30"]);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ParseArgsError);
  assert.ok(err.exitCode >= 6);
});

test("parseArgs: shape-validation violations also carry exit code ≥6", () => {
  let err;
  try {
    parseArgs(["30", "--plan", "abc", "--auto-create"]);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ParseArgsError);
  assert.ok(err.exitCode >= 6);
});

// ---------- verifyTypeSignature (Task 3.8 — §5.1 step 3 first sub-bullet) ----------

test("verifyTypeSignature: code Type accepts packages/ + apps/ touches", () => {
  assert.deepEqual(
    verifyTypeSignature({ type: "code", touchedFiles: ["packages/runtime-daemon/src/foo.ts"] }),
    { ok: true },
  );
  assert.deepEqual(
    verifyTypeSignature({ type: "code", touchedFiles: ["apps/desktop/src/main.ts"] }),
    { ok: true },
  );
  assert.deepEqual(
    verifyTypeSignature({
      type: "code",
      touchedFiles: [".github/workflows/ci.yml", "packages/sidecar-rust-pty/Cargo.toml"],
    }),
    { ok: true },
  );
});

test("verifyTypeSignature: code Type rejects pure-doc diff", () => {
  assert.equal(
    verifyTypeSignature({ type: "code", touchedFiles: ["docs/plans/024-rust-pty-sidecar.md"] }).ok,
    false,
  );
});

test("verifyTypeSignature: audit (doc-only) rejects packages/ touches", () => {
  assert.equal(
    verifyTypeSignature({
      type: "audit (doc-only)",
      touchedFiles: ["packages/contracts/src/foo.ts"],
    }).ok,
    false,
  );
  assert.equal(
    verifyTypeSignature({ type: "audit (doc-only)", touchedFiles: ["docs/plans/002-foo.md"] }).ok,
    true,
  );
});

test("verifyTypeSignature: code + governance requires BOTH docs/ and packages|apps/", () => {
  assert.equal(
    verifyTypeSignature({
      type: "code + governance",
      touchedFiles: ["docs/plans/024-foo.md", "packages/foo/src/bar.ts"],
    }).ok,
    true,
  );
  assert.equal(
    verifyTypeSignature({ type: "code + governance", touchedFiles: ["packages/foo/src/bar.ts"] })
      .ok,
    false,
  );
});

test("verifyTypeSignature: cleanup is permissive with cleanup_diff_unverified concern", () => {
  const result = verifyTypeSignature({ type: "cleanup", touchedFiles: ["any/file.ts"] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.concerns, [{ kind: "cleanup_diff_unverified" }]);
});

// ---------- verifyFileOverlap (Task 3.9 — §5.1 step 3 second sub-bullet) ----------

test("verifyFileOverlap (code, file-path entry): PASS when intersect non-empty", () => {
  const refs = { files: ["packages/sidecar-rust-pty/src/main.rs"], directories: [] };
  const touched = ["packages/sidecar-rust-pty/src/main.rs"];
  assert.deepEqual(verifyFileOverlap({ type: "code", refs, touched }), {
    ok: true,
    kind: "pass_file_path",
  });
});

test("verifyFileOverlap (code, dir-prefix entry): PASS when any touched file starts with dir", () => {
  const refs = { files: [], directories: ["packages/runtime-daemon/src/pty/"] };
  const touched = ["packages/runtime-daemon/src/pty/node-pty-host.ts"];
  assert.deepEqual(verifyFileOverlap({ type: "code", refs, touched }), {
    ok: true,
    kind: "pass_dir_prefix",
  });
});

test("verifyFileOverlap (code, refs non-empty + intersection empty): halt file_overlap_zero", () => {
  const refs = { files: ["packages/sidecar-rust-pty/src/main.rs"], directories: [] };
  const touched = ["docs/plans/007-foo.md"];
  const result = verifyFileOverlap({ type: "code", refs, touched });
  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, "file_overlap_zero");
});

test("verifyFileOverlap (code, refs empty): SOFT-WARN file_overlap_unverifiable_for_sparse_body", () => {
  const refs = { files: [], directories: [] };
  const result = verifyFileOverlap({ type: "code", refs, touched: ["packages/foo/src/bar.ts"] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.concerns, [{ kind: "file_overlap_unverifiable_for_sparse_body" }]);
});

test("verifyFileOverlap (audit Types): SKIP unconditionally", () => {
  const result = verifyFileOverlap({
    type: "audit (doc-only)",
    refs: { files: [], directories: [] },
    touched: [],
  });
  assert.deepEqual(result, { ok: true, kind: "skip" });
});

test("verifyFileOverlap (governance / cleanup Types): SKIP unconditionally", () => {
  for (const t of [
    "cleanup",
    "cleanup (doc-only)",
    "governance",
    "governance (doc-only)",
    "governance (load-bearing)",
  ]) {
    assert.deepEqual(
      verifyFileOverlap({ type: t, refs: { files: [], directories: [] }, touched: [] }),
      { ok: true, kind: "skip" },
    );
  }
});

test("verifyFileOverlap: doc-path-only PASS for NS-04-shape (References plan-link only)", () => {
  const refs = {
    files: ["docs/plans/001-shared-session-core.md", "docs/plans/024-rust-pty-sidecar.md"],
    directories: [],
  };
  const touched = [
    "docs/plans/001-shared-session-core.md",
    "packages/runtime-daemon/src/session/spawn-cwd-translator.ts",
  ];
  const result = verifyFileOverlap({
    type: "code (cross-plan PR pair, internally a 3-step sequence)",
    refs,
    touched,
  });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "pass_doc_path_only");
});

// ---------- verifyPlanIdentity (Task 3.10 — §5.1 step 3 third sub-bullet) ----------

test("verifyPlanIdentity: passes when --plan substring present in heading", () => {
  const result = verifyPlanIdentity({
    headingTitle: "Plan-024 Phase 1 — Rust crate scaffolding",
    args: { plan: "024" },
    type: "code",
  });
  assert.equal(result.ok, true);
});

test("verifyPlanIdentity: fails when --plan substring missing", () => {
  const result = verifyPlanIdentity({
    headingTitle: "Plan-024 Phase 1",
    args: { plan: "007" },
    type: "code",
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, "plan_identity_missing");
});

test("verifyPlanIdentity: --task substring branch", () => {
  assert.equal(
    verifyPlanIdentity({
      headingTitle: "Plan-001 T5.4 cwd-translator + Plan-024 T-024-2-1",
      args: { plan: "001", task: "T5.4" },
      type: "code (cross-plan PR pair, internally a 3-step sequence)",
    }).ok,
    true,
  );
});

test("verifyPlanIdentity: --tier substring branch (rule 3)", () => {
  assert.equal(
    verifyPlanIdentity({
      headingTitle: "Tier 2 plan-readiness audit — Plan-002",
      args: { plan: "002", tier: "2" },
      type: "audit (doc-only)",
    }).ok,
    true,
  );
});

test("verifyPlanIdentity: --tier range-arithmetic branch (rule 4) — Tier 5 in [3, 9]", () => {
  assert.equal(
    verifyPlanIdentity({
      headingTitle: "Tier 3-9 plan-readiness audits",
      args: { tier: "5" },
      type: "audit (doc-only chain)",
      rangeBoundaries: { K1: 3, K2: 9 },
    }).ok,
    true,
  );
  assert.equal(
    verifyPlanIdentity({
      headingTitle: "Tier 3-9 plan-readiness audits",
      args: { tier: "12" },
      type: "audit (doc-only chain)",
      rangeBoundaries: { K1: 3, K2: 9 },
    }).ok,
    false,
  );
});

test("verifyPlanIdentity: cleanup/governance Types SKIP the check", () => {
  for (const t of [
    "cleanup",
    "cleanup (doc-only)",
    "governance",
    "governance (doc-only)",
    "governance (load-bearing)",
  ]) {
    const result = verifyPlanIdentity({
      headingTitle: "anything no plan no tier",
      args: {},
      type: t,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.concerns, [{ kind: "plan_identity_skipped_for_manual_dispatch" }]);
  }
});

// ---------- applyStatusFlipSinglePr (Task 3.11 — step 5a) ----------

test("applyStatusFlipSinglePr replaces todo status with completed-with-placeholder", () => {
  const lines = ["### NS-01: Plan-024 Phase 1", "- Status: `todo`", "- Type: code"];
  const result = applyStatusFlipSinglePr({
    lines,
    statusLineIndex: 1,
    prNumber: 30,
    today: "2026-05-10",
  });
  assert.equal(
    result[1],
    "- Status: `completed` (resolved 2026-05-10 via PR #30 — <TODO subagent prose>)",
  );
});

test("applyStatusFlipSinglePr handles in_progress status (not just todo)", () => {
  const lines = ["...", "- Status: `in_progress` (last shipped: PR #20, 2026-05-01)", "..."];
  const result = applyStatusFlipSinglePr({
    lines,
    statusLineIndex: 1,
    prNumber: 30,
    today: "2026-05-10",
  });
  assert.equal(
    result[1],
    "- Status: `completed` (resolved 2026-05-10 via PR #30 — <TODO subagent prose>)",
  );
});

// ---------- applyMultiPrTickAndRecompute (Task 3.12 — step 5b) ----------

test("applyMultiPrTickAndRecompute: tick T5.5 row, recompute Status to in_progress", () => {
  const lines = [
    "### NS-02: Plan-001 Phase 5 Lane A",
    "- Status: `in_progress` (last shipped: PR #34, 2026-05-04)",
    "- ... other fields ...",
    "- PRs:",
    "  - [x] T5.1 — sessionClient (PR #34, merged 2026-05-04)",
    "  - [ ] T5.5 — pg.Pool-backed Querier composition",
    "  - [ ] T5.6 — strengthen createSession lock-ordering test",
  ];
  const result = applyMultiPrTickAndRecompute({
    lines,
    statusLineIndex: 1,
    prsBlockStartIndex: 3,
    taskId: "T5.5",
    prNumber: 38,
    today: "2026-05-10",
    upstreamBlocked: false,
  });
  assert.match(
    result[5],
    /^ {2}- \[x\] T5\.5 — pg\.Pool-backed Querier composition \(PR #38, merged 2026-05-10\)$/,
  );
  assert.match(result[1], /^- Status: `in_progress` \(last shipped: PR #38, 2026-05-10\)/);
});

test("applyMultiPrTickAndRecompute: tick last unchecked → recompute Status to completed", () => {
  const lines = [
    "...",
    "- Status: `in_progress` (last shipped: PR #38, 2026-05-10)",
    "...",
    "- PRs:",
    "  - [x] T5.1 — sessionClient (PR #34, merged 2026-05-04)",
    "  - [x] T5.5 — pg.Pool-backed Querier composition (PR #38, merged 2026-05-10)",
    "  - [ ] T5.6 — strengthen createSession lock-ordering test",
  ];
  const result = applyMultiPrTickAndRecompute({
    lines,
    statusLineIndex: 1,
    prsBlockStartIndex: 3,
    taskId: "T5.6",
    prNumber: 41,
    today: "2026-05-15",
    upstreamBlocked: false,
  });
  assert.match(
    result[1],
    /^- Status: `completed` \(resolved 2026-05-15 via PR #41 — last sub-task; <TODO subagent prose>\)/,
  );
});

test("applyMultiPrTickAndRecompute: blocked-override sets Status to blocked when upstreamBlocked true (row 5)", () => {
  const lines = [
    "### NS-02: Plan-001 Phase 5 Lane A",
    "- Status: `in_progress` (last shipped: PR #34, 2026-05-04)",
    "- Upstream: NS-04 (blocked)",
    "- PRs:",
    "  - [x] T5.1 — sessionClient (PR #34, merged 2026-05-04)",
    "  - [ ] T5.5 — pg.Pool-backed Querier composition",
    "  - [ ] T5.6 — strengthen createSession lock-ordering test",
  ];
  const result = applyMultiPrTickAndRecompute({
    lines,
    statusLineIndex: 1,
    prsBlockStartIndex: 3,
    taskId: "T5.5",
    prNumber: 38,
    today: "2026-05-10",
    upstreamBlocked: true,
    upstreamNsRef: "NS-04",
  });
  assert.match(
    result[5],
    /^ {2}- \[x\] T5\.5 — pg\.Pool-backed Querier composition \(PR #38, merged 2026-05-10\)$/,
  );
  assert.match(
    result[1],
    /^- Status: `blocked` \(blocked-on NS-04; last shipped: PR #38, 2026-05-10\)/,
  );
});

test("applyMultiPrTickAndRecompute: blocked-override does NOT fire when all checked (row 6 wins)", () => {
  const lines = [
    "### NS-02: Plan-001 Phase 5 Lane A",
    "- Status: `in_progress` (last shipped: PR #38, 2026-05-10)",
    "- Upstream: NS-04 (blocked)",
    "- PRs:",
    "  - [x] T5.1 — sessionClient (PR #34, merged 2026-05-04)",
    "  - [x] T5.5 — pg.Pool-backed Querier composition (PR #38, merged 2026-05-10)",
    "  - [ ] T5.6 — strengthen createSession lock-ordering test",
  ];
  const result = applyMultiPrTickAndRecompute({
    lines,
    statusLineIndex: 1,
    prsBlockStartIndex: 3,
    taskId: "T5.6",
    prNumber: 41,
    today: "2026-05-15",
    upstreamBlocked: true,
    upstreamNsRef: "NS-04",
  });
  assert.match(
    result[6],
    /^ {2}- \[x\] T5\.6 — strengthen createSession lock-ordering test \(PR #41, merged 2026-05-15\)$/,
  );
  assert.match(
    result[1],
    /^- Status: `completed` \(resolved 2026-05-15 via PR #41 — last sub-task; <TODO subagent prose>\)/,
  );
});

// ---------- applyMermaidClassSwap (Task 3.13 — step 6) ----------

test("applyMermaidClassSwap: changes :::ready to :::completed for matching node", () => {
  const lines = [
    "```mermaid",
    "    NS01[NS-01: Plan-024 Phase 1<br/>Rust crate scaffolding]:::ready",
    "```",
  ];
  const result = applyMermaidClassSwap({ lines, nsNum: 1, newClass: "completed" });
  assert.match(result[1], /:::completed$/);
});

test("applyMermaidClassSwap: handles edge syntax following the class attachment", () => {
  const lines = ["    NS01[NS-01: foo]:::ready --> NS02[NS-02: bar]:::ready"];
  const result = applyMermaidClassSwap({ lines, nsNum: 1, newClass: "completed" });
  assert.match(result[0], /NS01\[NS-01: foo\]:::completed --> NS02\[NS-02: bar\]:::ready/);
});

test("applyMermaidClassSwap: never modifies classDef definitions", () => {
  const lines = ["    classDef ready fill:#fff", "    NS01[NS-01: foo]:::ready"];
  const result = applyMermaidClassSwap({ lines, nsNum: 1, newClass: "completed" });
  assert.equal(result[0], "    classDef ready fill:#fff");
});

// ---------- tickPlanDoneChecklist (Task 3.14 — step 7) ----------

test("tickPlanDoneChecklist: ticks all unchecked boxes in the matched Phase's checklist", () => {
  const lines = [
    "### Phase 1 — Rust crate scaffolding",
    "...",
    "#### Done Checklist",
    "",
    "- [ ] First item",
    "- [ ] Second item",
    "- [x] Third item already done",
    "",
    "### Phase 2 — Other",
    "#### Done Checklist",
    "",
    "- [ ] Should NOT be ticked (different phase)",
  ];
  const { lines: result, ticksApplied } = tickPlanDoneChecklist({ lines, phase: "1" });
  assert.equal(ticksApplied, 2);
  assert.equal(result[4], "- [x] First item");
  assert.equal(result[5], "- [x] Second item");
  assert.equal(result[11], "- [ ] Should NOT be ticked (different phase)");
});

test("tickPlanDoneChecklist: returns ticksApplied=0 + flag when no checklist found", () => {
  const lines = ["### Phase 1 — Foo", "no checklist sub-section"];
  const { ticksApplied, notFound } = tickPlanDoneChecklist({ lines, phase: "1" });
  assert.equal(ticksApplied, 0);
  assert.equal(notFound, true);
});

// ---------- emitManifest (Task 3.15 — §5.3 schema) ----------

test("emitManifest writes JSON matching spec §5.3 shape (--candidate-ns mode)", () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), "manifest-emit-"));
  try {
    const result = emitManifest({
      repoRoot: tmpRepo,
      prNumber: 30,
      plan: "024",
      phase: "1",
      taskId: null,
      scriptExitCode: 0,
      matchedEntry: {
        nsId: "NS-01",
        heading: "### NS-01: Plan-024 Phase 1 — Rust crate scaffolding",
        shape: "single-pr",
        file: "docs/architecture/cross-plan-dependencies.md",
        headingLine: 342,
      },
      mechanicalEdits: {},
      schemaViolations: [],
      affectedFiles: [
        "docs/architecture/cross-plan-dependencies.md",
        "docs/plans/024-rust-pty-sidecar.md",
      ],
      semanticWorkPending: [
        "compose_status_completion_prose",
        "ready_set_re_derivation",
        "line_cite_sweep",
      ],
    });
    const written = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    assert.equal(written.pr_number, 30);
    assert.equal(written.script_exit_code, 0);
    assert.equal(written.result, null);
    assert.deepEqual(written.semantic_edits, {});
    assert.deepEqual(written.concerns, []);
    assert.equal(written.subagent_completed_at, null);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("emitManifest writes auto-create stub manifest when scriptExitCode=0 + autoCreate set", () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), "manifest-ac-"));
  try {
    const result = emitManifest({
      repoRoot: tmpRepo,
      prNumber: 50,
      plan: "029",
      phase: "2",
      taskId: null,
      scriptExitCode: 0,
      autoCreate: { reservedNsNn: 24, derivedTitleSeed: "Plan-029 Phase 2 — example" },
      mechanicalEdits: {
        plan_checklist_ticks: [{ file: "docs/plans/029-foo.md", phase: "2", items_ticked: 4 }],
      },
      schemaViolations: [],
      affectedFiles: ["docs/architecture/cross-plan-dependencies.md", "docs/plans/029-foo.md"],
      semanticWorkPending: [
        "auto_create_compose_entry",
        "auto_create_compose_mermaid_node",
        "auto_create_derive_upstream",
      ],
    });
    const written = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    assert.equal(written.auto_create.reserved_ns_nn, 24);
    assert.equal(written.auto_create.derived_title_seed, "Plan-029 Phase 2 — example");
    assert.equal(written.mechanical_edits.status_flip, undefined);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("emitManifest emits auto_create:null sentinel in --candidate-ns mode (P5 fix)", () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), "manifest-cn-null-"));
  try {
    const result = emitManifest({
      repoRoot: tmpRepo,
      prNumber: 31,
      plan: "024",
      phase: "1",
      taskId: null,
      scriptExitCode: 0,
      matchedEntry: {
        nsId: "NS-01",
        heading: "### NS-01: Plan-024 Phase 1 — Rust crate scaffolding",
        shape: "single-pr",
        file: "docs/architecture/cross-plan-dependencies.md",
        headingLine: 342,
      },
      mechanicalEdits: { status_flip: { from: "ready", to: "completed" } },
      schemaViolations: [],
      affectedFiles: ["docs/architecture/cross-plan-dependencies.md"],
      semanticWorkPending: [],
      // autoCreate omitted — must serialize as JSON null sentinel
    });
    const raw = readFileSync(result.manifestPath, "utf8");
    const written = JSON.parse(raw);
    assert.ok(
      Object.prototype.hasOwnProperty.call(written, "auto_create"),
      "manifest must include auto_create key even in --candidate-ns mode (spec §5.3)",
    );
    assert.equal(written.auto_create, null);
    assert.match(raw, /"auto_create":\s*null/);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// ---------- reserveNextFreeNs (Task 3.16 — auto-create step 1') ----------

test("reserveNextFreeNs returns max(NN)+1 across all NS-NN headings", () => {
  const content = "### NS-01: a\n### NS-22: z\n### NS-13a: b\n### NS-15..NS-21: r";
  assert.equal(reserveNextFreeNs(content), 23);
});

test("reserveNextFreeNs treats range upper bound as the integer (NS-15..NS-21 → 22)", () => {
  // Defensive: ensures range syntax NS-15..NS-21 contributes integer 21 to the max.
  const content = "### NS-15..NS-21: r";
  assert.equal(reserveNextFreeNs(content), 22);
});

test("reserveNextFreeNs skips NS-23 if already reserved per §3a.3", () => {
  const content = "### NS-22: z\n### NS-23: §6 schema amendment";
  assert.equal(reserveNextFreeNs(content), 24);
});

test("reserveNextFreeNs throws on collision (defensive numbering race)", () => {
  // Two NS-23 headings somehow present.
  const content = "### NS-22: z\n### NS-23: first\n### NS-23: second";
  assert.throws(() => reserveNextFreeNs(content), /duplicate.*NS-23/i);
});

test("reserveNextFreeNs returns 1 when content has no NS-NN headings (defensive)", () => {
  const content = "# Some other heading\n## Nothing relevant\nplain text";
  assert.equal(reserveNextFreeNs(content), 1);
});

// ---------- checkDuplicateTitle (Task 3.17 — auto-create step 2') ----------

test("checkDuplicateTitle returns ok when title is novel", () => {
  assert.deepEqual(
    checkDuplicateTitle({
      existingTitles: ["Plan-024 Phase 1 — Rust crate scaffolding"],
      newTitle: "Plan-029 Phase 2 — example",
    }),
    { ok: true },
  );
});

test("checkDuplicateTitle returns failure on substring-match collision (new contains existing)", () => {
  const result = checkDuplicateTitle({
    existingTitles: ["Plan-024 Phase 1 — Rust crate scaffolding"],
    newTitle: "Plan-024 Phase 1 — Rust crate scaffolding (refresh)",
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, "auto_create_duplicate_title");
});

test("checkDuplicateTitle catches reverse substring direction (existing contains new)", () => {
  // "Plan-024 Phase 1" is a substring of the existing heading title.
  const result = checkDuplicateTitle({
    existingTitles: ["Plan-024 Phase 1 — Rust crate scaffolding"],
    newTitle: "Plan-024 Phase 1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, "auto_create_duplicate_title");
});

test("checkDuplicateTitle handles empty existingTitles list (no collision possible)", () => {
  assert.deepEqual(
    checkDuplicateTitle({
      existingTitles: [],
      newTitle: "Plan-029 Phase 2 — example",
    }),
    { ok: true },
  );
});

// ---------- emitManifest generated_at field (Task 3.18 prerequisite) ----------

test("emitManifest writes generated_at as the first key when provided", () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), "manifest-genat-"));
  try {
    const result = emitManifest({
      repoRoot: tmpRepo,
      prNumber: 42,
      generatedAt: "2026-05-03T00:00:00Z",
      scriptExitCode: 0,
    });
    const raw = readFileSync(result.manifestPath, "utf8");
    const written = JSON.parse(raw);
    assert.equal(written.generated_at, "2026-05-03T00:00:00Z");
    // Ordering matters for spec §5.3 readability — assert generated_at is first.
    assert.equal(Object.keys(written)[0], "generated_at");
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// ---------- runHousekeeper end-to-end smoke (Task 3.18) ----------

test("runHousekeeper: end-to-end --candidate-ns NS-01 happy path on minimal fixture", async () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), "rh-smoke-"));
  try {
    const fixtureInput = join(HERE, "fixtures", "01-single-pr-happy-path", "input");
    cpSync(fixtureInput, tmpRepo, { recursive: true });
    const result = await runHousekeeper({
      args: { prNumber: 30, plan: "024", phase: "1", candidateNs: "NS-01" },
      repoRoot: tmpRepo,
      today: "2026-05-03",
    });
    assert.equal(result.exitCode, 0);
    assert.ok(existsSync(join(tmpRepo, ".agents/tmp/housekeeper-manifest-PR30.json")));
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// ---------- Fixture-driven byte-for-byte equality (Task 3.20) ----------
//
// Per spec §5.2 the housekeeper script is a deterministic transform: given the
// same args + corpus + plan tree, the same files must come out + the same
// manifest must be written. Each fixture under __tests__/fixtures/ encodes one
// shape (single-pr / multi-pr / skip / verifier-violation / auto-create); the
// loop below runs the orchestrator against `input/`, compares the post-mutation
// tree to `expected/` byte-for-byte, and deep-equals the emitted manifest to
// `expected-manifest.json`. Adding a fixture is a data-only change — no test
// edit required.

const FIXTURES_DIR = join(HERE, "fixtures");
const FIXTURE_TODAY = "2026-05-03";
// Convention: fixtures whose name starts with `00-` are loader-helper stubs
// (used only by helpers/__tests__/fixture-loader.test.mjs); runnable
// housekeeper fixtures are numbered `01-` and up.
const RUNNABLE_FIXTURE = (f) => !f.name.startsWith("00-");

for (const fixture of listFixtures(FIXTURES_DIR).filter(RUNNABLE_FIXTURE)) {
  test(`fixture ${fixture.name}: byte-for-byte equality`, async () => {
    const args = readArgs(fixture);
    const expectedManifest = readExpectedManifest(fixture);
    const tmpRepo = mkdtempSync(join(tmpdir(), `fix-${fixture.name}-`));
    try {
      cpSync(fixture.inputDir, tmpRepo, { recursive: true });
      const result = await runHousekeeper({
        args,
        repoRoot: tmpRepo,
        today: FIXTURE_TODAY,
      });
      assert.equal(
        result.exitCode,
        expectedManifest.script_exit_code,
        `fixture ${fixture.name}: exit code mismatch`,
      );
      expectFilesEqual(tmpRepo, fixture.expectedDir);
      const manifestPath = join(
        tmpRepo,
        ".agents",
        "tmp",
        `housekeeper-manifest-PR${args.prNumber}.json`,
      );
      assert.ok(existsSync(manifestPath), `manifest not written: ${manifestPath}`);
      const actualManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      assert.deepEqual(
        actualManifest,
        expectedManifest,
        `fixture ${fixture.name}: manifest mismatch`,
      );
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
}
