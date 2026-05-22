// node:test suite for preflight.mjs Gate 4 cite-anchor semantic verification.
// Run via: node --test .claude/skills/plan-execution/scripts/__tests__/preflight-gate4.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  normalizeCitePayload,
  extractIdentifierTokens,
  parseCitePayload,
  extractCiteAnchors,
  verifyAnchorAgainstSpec,
  gateTasksBlockCites,
  runPreflight,
} from "../preflight.mjs";

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "preflight-gate4-fixtures");
const FIXTURE_CROSS_PLAN_DEPS = resolve(FIXTURE_DIR, "cross-plan-dependencies.md");

function verifyAll(payload) {
  const { anchors, failures } = parseCitePayload(payload);
  const verifyFailures = anchors
    .map((a) => ({
      anchor: a,
      result: verifyAnchorAgainstSpec(a, {
        specsDir: FIXTURE_DIR,
        adrsDir: FIXTURE_DIR,
        archDocsDir: FIXTURE_DIR,
        crossPlanDepsFile: FIXTURE_CROSS_PLAN_DEPS,
      }),
    }))
    .filter(({ result }) => !result.valid);
  return { anchors, parseFailures: failures, verifyFailures };
}

// ============================================================
// Lexical helpers
// ============================================================

test("normalizeCitePayload normalizes en-dash U+2013 to ASCII hyphen", () => {
  assert.equal(normalizeCitePayload("lines 85–86"), "lines 85-86");
});

test("normalizeCitePayload normalizes em-dash U+2014 to ASCII hyphen", () => {
  assert.equal(normalizeCitePayload("lines 85—86"), "lines 85-86");
});

test("extractIdentifierTokens returns distinct CamelCase tokens", () => {
  assert.deepEqual(extractIdentifierTokens("(PresenceUpdate/PresenceRead JSON-RPC surface)"), [
    "PresenceUpdate",
    "PresenceRead",
    "JSON",
    "RPC",
  ]);
});

test("extractIdentifierTokens picks up dotted identifiers", () => {
  assert.deepEqual(extractIdentifierTokens("see presence.heartbeat docs"), ["presence.heartbeat"]);
});

// ============================================================
// Pass cases — 14 accepted grammar branches
// ============================================================

test("PASS 1: valid line cite with subject (Spec-002 line 13 (PresenceUpdate))", () => {
  const { anchors, parseFailures, verifyFailures } = verifyAll("Spec-002 line 13 (PresenceUpdate)");
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors[0].type, "line");
  assert.equal(anchors[0].line, 13);
  assert.equal(anchors[0].subject, "PresenceUpdate");
});

test("PASS 2: bare AC cite (Spec-002 AC1)", () => {
  const { anchors, parseFailures, verifyFailures } = verifyAll("Spec-002 AC1");
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors[0].type, "ac");
  assert.equal(anchors[0].ac, 1);
});

test("PASS 3: AC with explicit line hint (Spec-002 AC1 (line 45))", () => {
  const { anchors, parseFailures, verifyFailures } = verifyAll("Spec-002 AC1 (line 45)");
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors[0].lineHint, 45);
});

test("PASS 4: §Section + comma-separated lines emits N anchors", () => {
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "Spec-002 §Token Security Properties lines 39, 40, 41",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors.length, 3);
  assert.deepEqual(
    anchors.map((a) => a.line),
    [39, 40, 41],
  );
  assert.equal(anchors[0].section, "Token Security Properties");
});

test("PASS 5: line + AC combined (Spec-002 line 15 + AC3) splits into 2 anchors", () => {
  const { anchors, parseFailures, verifyFailures } = verifyAll("Spec-002 line 15 + AC3");
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].type, "line");
  assert.equal(anchors[0].line, 15);
  assert.equal(anchors[1].type, "ac");
  assert.equal(anchors[1].ac, 3);
});

test("PASS 6: ADR cite is out-of-scope for Gate 4 spec-verification", () => {
  const { anchors, parseFailures, verifyFailures } = verifyAll("ADR-019 §Decision item 1");
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors[0].type, "adr-section");
});

test("PASS 7: architecture-doc cite passes (verification out-of-scope)", () => {
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "error-contracts.md (cross-cutting C-7 channel)",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors[0].type, "arch-doc");
  assert.equal(anchors[0].file, "error-contracts.md");
});

test("PASS 8: cross-plan-deps cite parses with row", () => {
  const { anchors, parseFailures, verifyFailures } = verifyAll("cross-plan-deps §3 row 113");
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors[0].type, "cross-plan-deps");
  assert.equal(anchors[0].section, "3");
  assert.equal(anchors[0].row, "113");
});

test("PASS 9: 'none' literal with descriptor passes", () => {
  const { anchors, parseFailures, verifyFailures } = verifyAll("none (forward-compat scaffold)");
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors[0].type, "none-literal");
});

test("PASS 10: Plan-local ID with Spec inside paren — nested verification succeeds", () => {
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "C5 (Spec-002 line 15 — ChannelList)",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].type, "plan-local-id");
  assert.equal(anchors[0].id, "C5");
  assert.equal(anchors[1].type, "line");
  assert.equal(anchors[1].line, 15);
  assert.equal(anchors[1].subject, "ChannelList");
});

test("PASS 11: semicolon splits into different-namespace anchors", () => {
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "Spec-002 AC1 (wire shape); ADR-018 §Decision #4",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].type, "ac");
  assert.equal(anchors[1].type, "adr-section");
});

test("PASS 12: Plan-NNN §Section (no colon-line-number) inside Spec-NNN paren is legitimate", () => {
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "Spec-002 §Rate Limiting (per Plan-021 §RateLimitResponse canonical shape)",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors[0].type, "section-only");
  assert.equal(anchors[0].section, "Rate Limiting");
});

test("PASS 13: single-subject line-range emits one anchor (no compound-range fail)", () => {
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "Spec-002 lines 27-35 (RateLimitResponse canonical shape)",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors[0].type, "line-range");
  assert.equal(anchors[0].start, 27);
  assert.equal(anchors[0].end, 35);
  assert.equal(anchors[0].subject, "RateLimitResponse");
});

test("PASS 14: structured plan-local invariant ID (I-024-3) parses as plan-local-id", () => {
  const { anchors, parseFailures, verifyFailures } = verifyAll("I-024-3");
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors[0].type, "plan-local-id");
  assert.equal(anchors[0].id, "I-024-3");
});

test("PASS 14b: Plan-NNN cross-ref in paren does not inflate subject count on a single-subject line-range", () => {
  // Regression guard for nonPlanLocalSubjects: NAMESPACE_PREFIX_RE strips
  // `Plan-021` before identifier extraction, so the lone real subject is
  // `RateLimitResponse`. Without the strip, `Plan` (from `Plan-021`) is
  // extracted as a second identifier-token and the line-range falsely
  // trips compound-range-multi-subject. Mirrors Plan-002 T4.2 cite shape.
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "Spec-002 §Rate Limit Response lines 28-34 (`RateLimitResponse` canonical shape; returned with 429 per Plan-021 §RateLimitResponse canonical shape)",
  );
  assert.equal(
    parseFailures.filter((f) => f.kind === "compound-range-multi-subject").length,
    0,
    `expected no compound-range-multi-subject failure; got: ${JSON.stringify(parseFailures)}`,
  );
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors[0].type, "line-range");
  assert.equal(anchors[0].subject, "RateLimitResponse");
});

// ============================================================
// Fail cases — 6 rejection classes
// ============================================================

test("FAIL 15: subject mismatch (Spec-002 line 12 (PresenceUpdate) — line 12 = PresenceHeartbeat)", () => {
  const { verifyFailures } = verifyAll("Spec-002 line 12 (PresenceUpdate)");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "subject-mismatch");
  assert.match(verifyFailures[0].result.evidence, /PresenceHeartbeat/);
});

test("FAIL 16: compound-range with distinct subjects (en-dash forces normalization)", () => {
  // Input uses en-dash U+2013 between line numbers — must be normalized
  // BEFORE the compound-range rule fires, else this defect class slips.
  const { parseFailures } = verifyAll("Spec-002 lines 13–14 (PresenceUpdate/PresenceRead)");
  assert.ok(
    parseFailures.some((f) => f.kind === "compound-range-multi-subject"),
    `expected compound-range-multi-subject failure; got: ${JSON.stringify(parseFailures)}`,
  );
});

test("FAIL 17: Plan-NNN:LLL inside Spec-NNN paren — namespace violation", () => {
  const { parseFailures } = verifyAll("Spec-002 AC1 (I1 — Plan-002:166)");
  assert.ok(
    parseFailures.some((f) => f.kind === "namespace-violation"),
    `expected namespace-violation failure; got: ${JSON.stringify(parseFailures)}`,
  );
});

test("FAIL 18: Plan-local ID at first anchor position (Spec-002 C5)", () => {
  const { parseFailures } = verifyAll("Spec-002 C5");
  assert.ok(
    parseFailures.some((f) => f.kind === "plan-local-id-as-spec-anchor"),
    `expected plan-local-id-as-spec-anchor failure; got: ${JSON.stringify(parseFailures)}`,
  );
});

test("FAIL 19: phantom §Section heading (Spec-002 §Manual Verification)", () => {
  const { verifyFailures } = verifyAll("Spec-002 §Manual Verification");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "section-not-found");
});

test("FAIL 20: spec file missing (Spec-999 line 10)", () => {
  const { verifyFailures } = verifyAll("Spec-999 line 10");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "spec-file-not-found");
});

test("PASS 21: comma-separated sub-anchors with re-section emit one anchor per section", () => {
  // Regression for Codex P1 (PR #96 review): pre-fix, the second `§B line ZZ`
  // sub-token fell through to a warn-only fallback and Gate 4 false-greened.
  // Post-fix: re-section sub-anchor pattern emits a second line anchor with
  // the new section attached.
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "Spec-002 §Interfaces and Contracts line 13, §Rate Limiting line 21",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].section, "Interfaces and Contracts");
  assert.equal(anchors[0].line, 13);
  assert.equal(anchors[1].section, "Rate Limiting");
  assert.equal(anchors[1].line, 21);
});

test("FAIL 22: unparseable Spec sub-anchor now blocks the gate (error severity)", () => {
  // Regression for Codex P1: warn-only severity false-greened malformed
  // second sub-anchors. Post-fix the failure is error-severity and blocks.
  const { parseFailures } = verifyAll("Spec-002 §A line 12, §B junk");
  const blocking = parseFailures.filter((f) => f.kind === "unparseable-spec-subanchor");
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].severity, "error");
});

test("FAIL 23: top-level unparseable cite now blocks the gate (error severity)", () => {
  // Regression for the anti-spiral sweep: §Pre-3 implication 6 mandates
  // error-severity reporting for tokens matching no namespace pattern.
  // Pre-fix severity was warn (false-green); post-fix is error.
  const { parseFailures } = verifyAll("xyz random junk");
  const blocking = parseFailures.filter((f) => f.kind === "unparseable-cite");
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].severity, "error");
});

test("PASS 24: ADR anchor with existing file passes (adr-file-exists)", () => {
  // Fixture file: preflight-gate4-fixtures/019-test-adr.md.
  const { verifyFailures } = verifyAll("ADR-019 §Decision item 1");
  assert.equal(verifyFailures.length, 0);
});

test("FAIL 25: ADR anchor with missing file (ADR-999) fails with adr-file-not-found", () => {
  // Regression for Codex P2: ADR file existence is now enforced.
  const { verifyFailures } = verifyAll("ADR-999 §Decision item 1");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "adr-file-not-found");
});

test("FAIL 26: arch-doc with missing filename fails with arch-doc-not-found", () => {
  // Regression for Codex P2: typo like `missing-doc.md` no longer silently
  // passes. Existing fixture: error-contracts.md (PASS path); this one fails.
  const { verifyFailures } = verifyAll("missing-doc.md (descriptor)");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "arch-doc-not-found");
});

test("PASS 27: arch-doc with existing filename passes (arch-doc-exists)", () => {
  // Fixture file: preflight-gate4-fixtures/error-contracts.md.
  const { verifyFailures } = verifyAll("error-contracts.md (cross-cutting C-7 channel)");
  assert.equal(verifyFailures.length, 0);
});

test("PASS 28: cross-plan-deps anchor against existing file passes", () => {
  // Fixture file: preflight-gate4-fixtures/cross-plan-dependencies.md.
  const { verifyFailures } = verifyAll("cross-plan-deps §3 row 113");
  assert.equal(verifyFailures.length, 0);
});

test("PASS 29: repeated-namespace shape splits into independent top-level segments", () => {
  // Plan-002 T5.1/T5.3 use `Spec-NNN X, Spec-NNN Y` to disambiguate
  // `(line N + AC M)` sub-anchor groups. The top-level splitter sees
  // `, Spec-NNN` as a segment boundary so each clause parses against
  // its own namespace context.
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "Spec-002 AC1 (line 45), Spec-002 line 15 + AC2",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  // Three anchors: AC1 with line hint, then line 15 + AC2 expand into 2.
  assert.equal(anchors.length, 3);
  assert.equal(anchors[0].type, "ac");
  assert.equal(anchors[0].ac, 1);
  assert.equal(anchors[1].type, "line");
  assert.equal(anchors[1].line, 15);
  assert.equal(anchors[2].type, "ac");
  assert.equal(anchors[2].ac, 2);
});

// ============================================================
// Integration — extractCiteAnchors + gateTasksBlockCites
// ============================================================

test("extractCiteAnchors picks up both Spec coverage and Verifies invariant payloads", () => {
  const sec = `#### Tasks

##### T1.1 — Sample task

- Goal: x.
- **Spec coverage:** Spec-002 line 13 (PresenceUpdate)
- **Verifies invariant:** I-024-3
`;
  const { anchors, failures } = extractCiteAnchors(sec);
  assert.equal(failures.length, 0);
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].field, "Spec coverage");
  assert.equal(anchors[0].taskId, "T1.1");
  assert.equal(anchors[1].field, "Verifies invariant");
});

test("gateTasksBlockCites passes on clean Tasks block with verified anchors", () => {
  const sec = `#### Tasks

##### T1.1 — Sample task

- **Spec coverage:** Spec-002 line 13 (PresenceUpdate)
- **Verifies invariant:** I-024-3
`;
  const r = gateTasksBlockCites(sec, 2, 1, { repoRoot: resolveFixtureRepoRoot() });
  assert.equal(r.ok, true);
});

test("gateTasksBlockCites fails when a cite carries the compound-range defect", () => {
  const sec = `#### Tasks

##### T3.3 — Compound-range defect

- **Spec coverage:** Spec-002 lines 13–14 (PresenceUpdate/PresenceRead)
- **Verifies invariant:** I-024-3
`;
  const r = gateTasksBlockCites(sec, 2, 3, { repoRoot: resolveFixtureRepoRoot() });
  assert.equal(r.ok, false);
  assert.match(r.halt, /compound-range-multi-subject/);
  assert.match(r.halt, /T3\.3/);
});

test("gateTasksBlockCites preserves token-presence floor (returns the original halt when missing)", () => {
  const sec = `Spec coverage: row 4`;
  const r = gateTasksBlockCites(sec, 1, 5);
  assert.equal(r.ok, false);
  assert.match(r.halt, /missing G4 cites/);
});

// gateTasksBlockCites internally resolves specs via `${repoRoot}/docs/specs/`.
// To point it at FIXTURE_DIR without duplicating fixture content, we build a
// tmp repo whose docs/specs/ is a symlink to the fixture dir. Cached across
// integration tests so the symlink isn't re-created per case.
let _cachedFixtureRepoRoot = null;
function resolveFixtureRepoRoot() {
  if (_cachedFixtureRepoRoot) return _cachedFixtureRepoRoot;
  const root = mkdtempSync(resolve(tmpdir(), "preflight-gate4-"));
  const docsSpecs = resolve(root, "docs", "specs");
  mkdirSync(dirname(docsSpecs), { recursive: true });
  if (!existsSync(docsSpecs)) symlinkSync(FIXTURE_DIR, docsSpecs);
  _cachedFixtureRepoRoot = root;
  return root;
}

// Regression for the `_checkPhase → gateTasksBlockCites` opts-threading bug
// (Codex P2 on PR #96 line 1456): without threading, runPreflight's repoRoot
// silently falls back to REPO_ROOT, so Gate 4 file-existence checks hit the
// wrong tree. The Spec-100 cite below resolves only in FIXTURE_DIR — real
// REPO_ROOT/docs/specs has no 100-*.md — so the assertion fails closed if
// threading regresses.
test("PASS 30: runPreflight threads opts.repoRoot into Gate 4 file lookups", () => {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), "preflight-runPreflight-"));
  const docsSpecs = resolve(fixtureRoot, "docs", "specs");
  mkdirSync(dirname(docsSpecs), { recursive: true });
  symlinkSync(FIXTURE_DIR, docsSpecs);

  const fakeSkillMd = resolve(fixtureRoot, "fake-skill.md");
  writeFileSync(fakeSkillMd, "---\nname: fake-skill\n---\n\nNo requires_files frontmatter.\n");

  const planDir = resolve(fixtureRoot, "docs", "plans");
  mkdirSync(planDir, { recursive: true });
  const planFile = resolve(planDir, "100-fixture-plan.md");
  writeFileSync(
    planFile,
    [
      "---",
      "status: approved",
      "audit_complete: true",
      "---",
      "",
      "# Plan-100 fixture",
      "",
      "## Status Promotion",
      "",
      "- [x] **Plan-readiness audit complete**",
      "",
      "### Shipment Manifest",
      "",
      "```yaml",
      "manifest_schema_version: 1",
      "shipped: []",
      "```",
      "",
      "### Phase 1 — Fixture phase",
      "",
      "#### Tasks",
      "",
      "- **T-100-1.1** — Identifier surface",
      "  - **Spec coverage:** Spec-100 line 10 (FixtureIdentifier)",
      "  - **Verifies invariant:** I-100-1",
      "",
      "",
    ].join("\n"),
  );

  const r = runPreflight(planFile, 1, { repoRoot: fixtureRoot, skillMd: fakeSkillMd });
  assert.equal(r.exit, 0, `runPreflight should pass with threaded opts; got halt:\n${r.stdout}`);
  assert.equal(r.stdout, "1");
});

// Phantom-section-on-line / -line-range / -AC false-green guards
// (Codex P2 on PR #96 line 1301). The parser attaches `.section` to line /
// line-range / AC anchors; the verifier now rejects when that section
// heading is not present in the spec, instead of routing straight to the
// line / AC content check.

test("FAIL 31: §NotARealSection line N rejects with section-not-found", () => {
  const { verifyFailures } = verifyAll("Spec-002 §NotARealSection line 11 (MembershipUpdate)");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "section-not-found");
});

test("FAIL 32: §NotARealSection lines N-M rejects with section-not-found", () => {
  const { verifyFailures } = verifyAll("Spec-002 §NotARealSection lines 27-35 (RateLimitResponse)");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "section-not-found");
});

test("FAIL 33: §NotARealSection AC-N rejects with section-not-found", () => {
  const { verifyFailures } = verifyAll("Spec-002 §NotARealSection AC1 (line 45)");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "section-not-found");
});

test("PASS 34: real §Section + line passes when section exists in spec", () => {
  const { verifyFailures, parseFailures } = verifyAll(
    "Spec-002 §Token Security Properties line 39 (HS256)",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
});
