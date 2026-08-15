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
  serializeNonShipmentPrs,
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

// Codex P1 finding on PR #35 round 10: parser previously returned
// `{ ok: true, version, shipped: [] }` whenever the version line was
// present even if the `shipped:` top-level key was absent. That silent
// pass produced an empty shipment-set and re-opened Gate 3 for already-
// shipped phases. Strict halt now matches `missing_schema_version`.
test("parseManifestBlock: missing shipped key returns missing_shipped", () => {
  const plan = `### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
\`\`\`
`;
  const r = parseManifestBlock(plan);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing_shipped");
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

// Codex P2 finding on PR #35 round 4: parseChildBlock previously only
// recognized `- item` block lists; an indented multi-line flow array
// (e.g., `spec_coverage:` followed by `[`, items, `]` on subsequent
// indented lines — Plan-007's backfilled style) fell through to the
// raw-string return path, then validateEntry failed on "must be an
// array of strings". This test reproduces Plan-007 PR #17/#19's shape.
test("parseManifestBlock: indented multi-line flow array parses as string[]", () => {
  const plan = `### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
  - phase: 3
    task: T-007p-3-2
    pr: 17
    sha: deadbee
    merged_at: 2026-05-05
    files: [a.ts]
    verifies_invariant: [I-007-6]
    spec_coverage:
      [
        "Spec-007 §Wire Format",
        "Spec-007 §Required Behavior",
        "Spec-007 §Fallback Behavior",
        ADR-009,
      ]
\`\`\`
`;
  const r = parseManifestBlock(plan);
  assert.equal(r.ok, true);
  assert.equal(r.shipped.length, 1);
  assert.deepEqual(r.shipped[0].spec_coverage, [
    "Spec-007 §Wire Format",
    "Spec-007 §Required Behavior",
    "Spec-007 §Fallback Behavior",
    "ADR-009",
  ]);
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

// ---------- non_shipment_prs (optional top-level key) ----------

// Operator-ratified exemptions from preflight Gate 6 freshness: merged PRs that
// carry the plan's `Plan-NNN` title token but shipped none of its tasks (the
// 2026-08-15 PR #216 class). Additive and optional — it does NOT bump the
// schema version — and parsed STRICTLY, because a typo that widened the
// exemption would silently disarm a fail-closed gate.

function planWithNonShipment(literal) {
  return `### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
${literal}
shipped: []
\`\`\`
`;
}

test("non_shipment_prs: absent key yields an empty array (never undefined)", () => {
  const r = parseManifestBlock(EMPTY_PLAN);
  assert.equal(r.ok, true);
  assert.deepEqual(r.nonShipmentPrs, []);
});

test("non_shipment_prs: inline flow array parses to numbers", () => {
  const r = parseManifestBlock(planWithNonShipment("non_shipment_prs: [216]"));
  assert.equal(r.ok, true);
  assert.deepEqual(r.nonShipmentPrs, [216]);
});

test("non_shipment_prs: trailing comment and multiple values parse", () => {
  const r = parseManifestBlock(
    planWithNonShipment("non_shipment_prs: [216, 217] # ratified 2026-08-15"),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.nonShipmentPrs, [216, 217]);
});

test("non_shipment_prs: indented block-list spelling parses identically", () => {
  const r = parseManifestBlock(planWithNonShipment("non_shipment_prs:\n  - 216\n  - 217"));
  assert.equal(r.ok, true);
  assert.deepEqual(r.nonShipmentPrs, [216, 217]);
});

test("non_shipment_prs: an explicit empty list is allowed", () => {
  const r = parseManifestBlock(planWithNonShipment("non_shipment_prs: []"));
  assert.equal(r.ok, true);
  assert.deepEqual(r.nonShipmentPrs, []);
});

test("non_shipment_prs: parses when placed AFTER shipped[] entries", () => {
  // `shipped:` entry parsing stops at the first column-0 key, so placement is
  // free. Pin both orders — the corpus writes it above `shipped:`, but a
  // hand-edit below must not silently parse as nothing.
  const plan = `### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
  - phase: 5
    task: T5.1
    pr: 30
    sha: 7e4ae47
    merged_at: 2026-05-05
    files: [a.ts]
non_shipment_prs: [216]
\`\`\`
`;
  const r = parseManifestBlock(plan);
  assert.equal(r.ok, true);
  assert.equal(r.shipped.length, 1);
  assert.deepEqual(r.nonShipmentPrs, [216]);
});

test("non_shipment_prs: quoted strings are REJECTED (fail closed on a typo)", () => {
  const r = parseManifestBlock(planWithNonShipment('non_shipment_prs: ["216"]'));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid_non_shipment_prs");
  assert.match(r.errors.join(" "), /positive integers/);
});

test("non_shipment_prs: negative and zero PR numbers are REJECTED", () => {
  const negative = parseManifestBlock(planWithNonShipment("non_shipment_prs: [-216]"));
  assert.equal(negative.ok, false);
  assert.equal(negative.reason, "invalid_non_shipment_prs");
  const zero = parseManifestBlock(planWithNonShipment("non_shipment_prs: [0]"));
  assert.equal(zero.ok, false);
  assert.equal(zero.reason, "invalid_non_shipment_prs");
});

test("non_shipment_prs: a bare scalar is REJECTED (not silently wrapped)", () => {
  const r = parseManifestBlock(planWithNonShipment("non_shipment_prs: 216"));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid_non_shipment_prs");
});

test("non_shipment_prs: a valueless key is REJECTED rather than read as empty", () => {
  const r = parseManifestBlock(planWithNonShipment("non_shipment_prs:"));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid_non_shipment_prs");
});

test("non_shipment_prs: the structural reasons still win over a bad value", () => {
  // A block missing `shipped:` is a more fundamental defect; diagnosing the
  // exemption key first would send the operator down the wrong remediation.
  const plan = `### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
non_shipment_prs: ["216"]
\`\`\`
`;
  const r = parseManifestBlock(plan);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing_shipped");
});

test("non_shipment_prs: a PR ALSO recorded in shipped[] is REJECTED", () => {
  // The two keys make opposite assertions about one merge. Unchecked, the
  // contradiction is not inert: rebuild-shipment-manifest.mjs skips ratified
  // PRs ahead of its existing-entry reuse path, so #30 would silently vanish
  // from the --dry-run stream the Gate 6 halt tells the operator to apply back.
  const plan = `### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
non_shipment_prs: [30]
shipped:
  - phase: 5
    task: T5.1
    pr: 30
    sha: 7e4ae47
    merged_at: 2026-05-05
    files: [a.ts]
\`\`\`
`;
  const r = parseManifestBlock(plan);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid_non_shipment_prs");
  assert.match(r.errors.join(" "), /PR #30 is listed in non_shipment_prs AND recorded in shipped/);
});

test("non_shipment_prs: the shipped[]-overlap check sees the key BELOW shipped too", () => {
  // Placement-independent by construction — the check runs at the return site,
  // after the whole block is resolved, not at the key's own line.
  const plan = `### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
  - phase: 5
    task: T5.1
    pr: 30
    sha: 7e4ae47
    merged_at: 2026-05-05
    files: [a.ts]
non_shipment_prs: [216, 30]
\`\`\`
`;
  const r = parseManifestBlock(plan);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid_non_shipment_prs");
  // Only the overlapping number is named; #216 is a legitimate ratification.
  assert.match(r.errors.join(" "), /PR #30 /);
  assert.doesNotMatch(r.errors.join(" "), /PR #216 /);
});

test("non_shipment_prs: a DISJOINT key and shipped[] still parse cleanly", () => {
  // Negative control for the overlap check — it must not reject the normal shape.
  const plan = `### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
non_shipment_prs: [216]
shipped:
  - phase: 5
    task: T5.1
    pr: 30
    sha: 7e4ae47
    merged_at: 2026-05-05
    files: [a.ts]
\`\`\`
`;
  const r = parseManifestBlock(plan);
  assert.equal(r.ok, true);
  assert.deepEqual(r.nonShipmentPrs, [216]);
  assert.deepEqual(
    r.shipped.map((e) => e.pr),
    [30],
  );
});

test("serializeNonShipmentPrs: emits a parseable inline flow array (round trip)", () => {
  const line = serializeNonShipmentPrs([216, 217]);
  assert.equal(line, "non_shipment_prs: [216, 217]");
  const reparsed = parseManifestBlock(planWithNonShipment(line));
  assert.equal(reparsed.ok, true);
  assert.deepEqual(reparsed.nonShipmentPrs, [216, 217]);
});

test("appendManifestEntry preserves non_shipment_prs above AND below shipped[]", () => {
  // The append path splices into the existing YAML lines rather than
  // re-rendering the block, so unrelated top-level keys survive — but only if
  // the splice point respects them. A dropped key silently re-arms every Gate 6
  // halt the operator ratified away.
  const entry = {
    phase: 1,
    task: "T1.1",
    pr: 42,
    sha: "abc1234",
    merged_at: "2026-08-15",
    files: ["packages/x/src/a.ts"],
  };
  const above = parseManifestBlock(
    appendManifestEntry(planWithNonShipment("non_shipment_prs: [216]"), entry),
  );
  assert.equal(above.ok, true);
  assert.deepEqual(above.nonShipmentPrs, [216]);
  assert.deepEqual(
    above.shipped.map((e) => e.pr),
    [42],
  );
  const belowSource = `### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
  - phase: 5
    task: T5.1
    pr: 30
    sha: 7e4ae47
    merged_at: 2026-05-05
    files: [a.ts]
non_shipment_prs: [216]
\`\`\`
`;
  const below = parseManifestBlock(appendManifestEntry(belowSource, entry));
  assert.equal(below.ok, true);
  assert.deepEqual(below.nonShipmentPrs, [216]);
  assert.deepEqual(
    below.shipped.map((e) => e.pr),
    [30, 42],
  );
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

// Codex P2 finding on PR #35 round 10: parser fail-opens on future
// schema versions so read-side tooling keeps working during partial
// migrations, but the writer MUST refuse — the v1 entry shape this
// module emits could violate constraints that vN added. Asymmetric
// reader/writer policy, documented in the module header.
test("appendManifestEntry: throws on future schema version", () => {
  const futurePlan = `### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 2
shipped: []
\`\`\`
`;
  assert.throws(
    () => appendManifestEntry(futurePlan, OK_ENTRY),
    /manifest schema version 2 > writer version 1/,
  );
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
