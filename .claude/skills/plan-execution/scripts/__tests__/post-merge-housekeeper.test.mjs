// node:test suite for post-merge-housekeeper.mjs pure parsers (Tasks 3.2-3.6).
// Run via: node --test --experimental-strip-types \
//   .claude/skills/plan-execution/scripts/__tests__/post-merge-housekeeper.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
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
} from "../post-merge-housekeeper.mjs";

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
