// node:test suite for lib/manifest.mjs.
// Run via:
//   node --test --experimental-strip-types \
//     .claude/skills/plan-execution/scripts/__tests__/manifest.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MANIFEST_SCHEMA_VERSION,
  parseManifestBlock,
  validateEntry,
  appendManifestEntry,
  serializeEntry,
} from "../lib/manifest.mjs";

const EMPTY_PLAN = `# Plan-001: Foo

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped: []
# Entry shape (illustrative — authoritative schema in lib/manifest.mjs):
# - phase: 5
#   task: T5.1
\`\`\`

### Notes

<!-- empty -->

## Done Checklist
`;

const SINGLE_ENTRY_PLAN = `# Plan-001: Foo

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
  - phase: 5
    task: T5.1
    pr: 30
    sha: 7e4ae47
    merged_at: 2026-05-05
    files:
      - packages/client-sdk/src/sessionClient.ts
    verifies_invariant: [I-001-1]
    spec_coverage: ["Spec-001 row 4"]
    notes: |
      Lane A only — T5.5 / T5.6 still pending.
\`\`\`

### Notes
`;

const MULTI_TASK_PLAN = `# Plan-007: Bar

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
  - phase: 3
    task: [T-007p-3-1, T-007p-3-2, T-007p-3-4]
    pr: 19
    sha: abcdef1
    merged_at: 2026-04-30
    files:
      - packages/runtime-daemon/src/foo.ts
    verifies_invariant: []
    spec_coverage: []
\`\`\`
`;

// ---------- parseManifestBlock ----------

test("parseManifestBlock: empty manifest returns version=1 and empty shipped[]", () => {
  const r = parseManifestBlock(EMPTY_PLAN);
  assert.equal(r.ok, true);
  assert.equal(r.version, 1);
  assert.deepEqual(r.shipped, []);
});

test("parseManifestBlock: single-entry manifest parses all fields", () => {
  const r = parseManifestBlock(SINGLE_ENTRY_PLAN);
  assert.equal(r.ok, true);
  assert.equal(r.shipped.length, 1);
  const e = r.shipped[0];
  assert.equal(e.phase, 5);
  assert.equal(e.task, "T5.1");
  assert.equal(e.pr, 30);
  assert.equal(e.sha, "7e4ae47");
  assert.equal(e.merged_at, "2026-05-05");
  assert.deepEqual(e.files, ["packages/client-sdk/src/sessionClient.ts"]);
  assert.deepEqual(e.verifies_invariant, ["I-001-1"]);
  assert.deepEqual(e.spec_coverage, ["Spec-001 row 4"]);
  assert.match(e.notes, /Lane A only/);
});

test("parseManifestBlock: multi-task array form parses as string[]", () => {
  const r = parseManifestBlock(MULTI_TASK_PLAN);
  assert.equal(r.ok, true);
  assert.equal(r.shipped.length, 1);
  assert.deepEqual(r.shipped[0].task, ["T-007p-3-1", "T-007p-3-2", "T-007p-3-4"]);
});

test("parseManifestBlock: multi-entry manifest parses every entry", () => {
  const plan = `### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
  - phase: 1
    task: T1.1
    pr: 6
    sha: 1111111
    merged_at: 2026-04-26
    files: [a.ts]
    verifies_invariant: []
    spec_coverage: []
  - phase: 2
    task: T2.1
    pr: 8
    sha: 2222222
    merged_at: 2026-04-27
    files: [b.ts]
    verifies_invariant: []
    spec_coverage: []
\`\`\`
`;
  const r = parseManifestBlock(plan);
  assert.equal(r.ok, true);
  assert.equal(r.shipped.length, 2);
  assert.equal(r.shipped[0].pr, 6);
  assert.equal(r.shipped[1].pr, 8);
});

test("parseManifestBlock: missing section returns no_section reason", () => {
  const r = parseManifestBlock("# Plan with no manifest\n");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_section");
});

test("parseManifestBlock: section without yaml fence returns no_yaml_fence", () => {
  const plan = `### Shipment Manifest

free-form text but no yaml block.

### Notes
`;
  const r = parseManifestBlock(plan);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_yaml_fence");
});

test("parseManifestBlock: missing schema_version returns missing_schema_version", () => {
  const plan = `### Shipment Manifest

\`\`\`yaml
shipped: []
\`\`\`
`;
  const r = parseManifestBlock(plan);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing_schema_version");
});

test("parseManifestBlock: schema-version 2 is parsed fail-open", () => {
  const plan = `### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 2
shipped: []
\`\`\`
`;
  const r = parseManifestBlock(plan);
  assert.equal(r.ok, true);
  assert.equal(r.version, 2);
  assert.deepEqual(r.shipped, []);
});

// Codex P2 finding on PR #35 round 3: a naive `inner.split(",")` in
// parseInlineScalar corrupted flow-array elements containing quoted commas
// (e.g., spec_coverage: ["Spec-001 rows 4,5"]) by splitting them into two
// items. splitFlowArray now respects quote pairing.
test("parseManifestBlock: flow-array preserves commas inside quoted strings", () => {
  const plan = `### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
  - phase: 5
    task: T5.1
    pr: 30
    sha: 7e4ae47
    merged_at: 2026-05-05
    files: [a.ts, b.ts]
    verifies_invariant: ["I-001-1", "I-001-2,maybe"]
    spec_coverage: ["Spec-001 rows 4,5", "Spec-001 row 6"]
\`\`\`
`;
  const r = parseManifestBlock(plan);
  assert.equal(r.ok, true);
  assert.equal(r.shipped.length, 1);
  assert.deepEqual(r.shipped[0].spec_coverage, ["Spec-001 rows 4,5", "Spec-001 row 6"]);
  assert.deepEqual(r.shipped[0].verifies_invariant, ["I-001-1", "I-001-2,maybe"]);
});

// ---------- validateEntry ----------

const OK_ENTRY = {
  phase: 5,
  task: "T5.1",
  pr: 30,
  sha: "7e4ae47",
  merged_at: "2026-05-05",
  files: ["a.ts"],
  verifies_invariant: ["I-001-1"],
  spec_coverage: ["Spec-001 row 4"],
};

test("validateEntry: happy path returns ok", () => {
  assert.deepEqual(validateEntry(OK_ENTRY), { ok: true });
});

test("validateEntry: missing required field reports error", () => {
  const { sha, ...partial } = OK_ENTRY;
  void sha;
  const r = validateEntry(partial);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /missing required field: sha/.test(e)));
});

test("validateEntry: invalid sha format reports error", () => {
  const r = validateEntry({ ...OK_ENTRY, sha: "not-hex-XYZ" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /sha must be a hex string/.test(e)));
});

test("validateEntry: invalid date format reports error", () => {
  const r = validateEntry({ ...OK_ENTRY, merged_at: "2026-5-5" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /merged_at/.test(e)));
});

test("validateEntry: task as non-empty array passes", () => {
  const r = validateEntry({ ...OK_ENTRY, task: ["T-007p-3-1", "T-007p-3-2"] });
  assert.deepEqual(r, { ok: true });
});

test("validateEntry: task as empty array fails", () => {
  const r = validateEntry({ ...OK_ENTRY, task: [] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /task array must be non-empty/.test(e)));
});

test("validateEntry: unknown field reports error", () => {
  const r = validateEntry({ ...OK_ENTRY, bogus: "value" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown field: bogus/.test(e)));
});

// ---------- appendManifestEntry ----------

test("appendManifestEntry: append to empty manifest replaces shipped: []", () => {
  const next = appendManifestEntry(EMPTY_PLAN, OK_ENTRY);
  assert.match(next, /shipped:\n {2}- phase: 5/);
  assert.doesNotMatch(next, /shipped:\s*\[\s*\]/);
  // Round-trip parse to verify shape
  const r = parseManifestBlock(next);
  assert.equal(r.shipped.length, 1);
  assert.equal(r.shipped[0].pr, 30);
});

test("appendManifestEntry: idempotency on pr — same pr is a no-op", () => {
  const once = appendManifestEntry(EMPTY_PLAN, OK_ENTRY);
  const twice = appendManifestEntry(once, OK_ENTRY);
  assert.equal(once, twice);
});

test("appendManifestEntry: append second entry preserves first", () => {
  const once = appendManifestEntry(EMPTY_PLAN, OK_ENTRY);
  const twice = appendManifestEntry(once, { ...OK_ENTRY, pr: 31, sha: "abc1234", task: "T5.2" });
  const r = parseManifestBlock(twice);
  assert.equal(r.shipped.length, 2);
  assert.equal(r.shipped[0].pr, 30);
  assert.equal(r.shipped[1].pr, 31);
});

test("appendManifestEntry: preserves illustrative trailing comments", () => {
  const once = appendManifestEntry(EMPTY_PLAN, OK_ENTRY);
  // The `# Entry shape (illustrative...)` block in EMPTY_PLAN should
  // still appear after the appended entry.
  assert.match(once, /verifies_invariant: \[I-001-1\][\s\S]*# Entry shape \(illustrative/);
});

test("appendManifestEntry: throws on invalid entry", () => {
  assert.throws(() => appendManifestEntry(EMPTY_PLAN, { phase: 5 }), /missing required field/);
});

test("appendManifestEntry: throws on missing section", () => {
  assert.throws(() => appendManifestEntry("# plan with no manifest\n", OK_ENTRY), /no_section/);
});

// ---------- serializeEntry ----------

test("serializeEntry: emits expected YAML lines for typical entry", () => {
  const lines = serializeEntry(OK_ENTRY);
  assert.equal(lines[0], "  - phase: 5");
  assert.equal(lines[1], "    task: T5.1");
  assert.equal(lines[2], "    pr: 30");
  assert.equal(lines[3], "    sha: 7e4ae47");
  assert.equal(lines[4], "    merged_at: 2026-05-05");
  assert.equal(lines[5], "    files:");
  assert.equal(lines[6], "      - a.ts");
  assert.equal(lines[7], "    verifies_invariant: [I-001-1]");
  assert.equal(lines[8], `    spec_coverage: ["Spec-001 row 4"]`);
});

test("serializeEntry: multi-task array uses flow form", () => {
  const lines = serializeEntry({ ...OK_ENTRY, task: ["a", "b", "c"] });
  assert.equal(lines[1], "    task: [a, b, c]");
});

test("serializeEntry: notes block scalar emits | with 6-space indent", () => {
  const lines = serializeEntry({ ...OK_ENTRY, notes: "first line\nsecond line" });
  const notesIdx = lines.findIndex((l) => l === "    notes: |");
  assert.ok(notesIdx > 0);
  assert.equal(lines[notesIdx + 1], "      first line");
  assert.equal(lines[notesIdx + 2], "      second line");
});

test("MANIFEST_SCHEMA_VERSION constant equals 1", () => {
  assert.equal(MANIFEST_SCHEMA_VERSION, 1);
});
