// node:test suite for preflight.mjs Gate 4 cite-anchor semantic verification.
// Run via: node --test .claude/skills/plan-execution/scripts/__tests__/preflight-gate4.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  normalizeCitePayload,
  extractIdentifierTokens,
  parseCitePayload,
  extractCiteAnchors,
  verifyAnchorAgainstSpec,
  gateTasksBlockCites,
  runPreflight,
  classifyPhaseSize,
  extractDeclaredFilePaths,
  extractDeclaredTaskIds,
  G4_GRAMMAR_DEMOTE_KINDS,
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

test("PASS 13: identifier on intro line within ±2 ambient window passes (intro-above-block authoring pattern)", () => {
  // Fixture 003-test-spec.md has `RateLimitResponse` on line 16; cite range
  // is 18-25 (the fenced shape block). Identifier sits exactly 2 lines above
  // start — at the lower ambient-window boundary. Mirrors real Spec-002
  // §Rate Limiting line 125 above lines 127-133 (the Plan-002 T4.2 shape).
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "Spec-003 §Rate Limiting lines 18-25 (RateLimitResponse canonical shape)",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors[0].type, "line-range");
  assert.equal(anchors[0].start, 18);
  assert.equal(anchors[0].end, 25);
  assert.equal(anchors[0].subject, "RateLimitResponse");
});

test("PASS 13b: identifier within ±2 ambient AFTER cited range passes (post-range ambient coverage)", () => {
  // Same fixture + cite range as PASS 13; subject `PostAmbient` lives on
  // line 27 — exactly 2 lines below the cited range end (25), at the upper
  // ambient-window boundary. Proves the rule is symmetric.
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "Spec-003 §Rate Limiting lines 18-25 (PostAmbient post-range identifier)",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors[0].type, "line-range");
  assert.equal(anchors[0].subject, "PostAmbient");
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

test("FAIL 13c: identifier outside ±2 ambient window fails subject-mismatch-in-range (regression guard)", () => {
  // Fixture 003-test-spec.md has `OutOfWindow` on line 12. Cite range 18-25
  // with ambient ±2 covers lines 16-27, so line 12 is 4 lines below the
  // lower ambient bound — must still reject. Guards the ±2 bound from
  // accidentally inflating to over-permissive on future edits.
  const { verifyFailures } = verifyAll(
    "Spec-003 §Rate Limiting lines 18-25 (OutOfWindow distant identifier)",
  );
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "subject-mismatch-in-range");
  assert.match(verifyFailures[0].result.evidence, /±2 ambient = 16-27/);
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

// Corpus regressions surfaced by sweeping `node preflight.mjs` across every
// approved plan after the Codex iteration (Codex P1 on PR #96 line 873).
// Each shape below was already on develop pre-PR and must parse without
// halting.

test("PASS 35: TS-object-literal descriptor doesn't break sub-anchor splitting", () => {
  // Plan-002 T1.3 shape: braces inside a Plan-local-ID descriptor that
  // wraps a Spec-NNN cite. Pre-fix, the splitter treated commas inside
  // `{deviceType, focusedSessionId, ...}` as sub-anchor separators.
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "C4 (Spec-002 line 12 — `PresenceHeartbeat` carries 5 required metadata fields `{deviceType, focusedSessionId, focusedChannelId, lastActivityAt, appVisible}`)",
  );
  // 1 plan-local-id + 1 nested Spec-002 line anchor.
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors.filter((a) => a.type === "line").length, 1);
});

test("PASS 36: §Section lines N1 (desc1), N2 (desc2), N3 (desc3) per-line descriptors", () => {
  // Plan-002 T2.1 shape. Fixture line 39 = `HS256`, line 40 = `1-hour
  // expiry`, line 41 = `keychain storage`. Use those three to validate
  // the parser emits 3 anchors with section=Token Security Properties.
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "Spec-002 §Token Security Properties lines 39 (HS256), 40 (expiry), 41 (keychain)",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  const lineAnchors = anchors.filter((a) => a.type === "line");
  assert.equal(lineAnchors.length, 3);
  assert.ok(lineAnchors.every((a) => a.section === "Token Security Properties"));
});

test("PASS 37: multi-§Section with bare-digit continuations (T2.2-shape)", () => {
  // Plan-002 T2.2 shape: AC anchors + §A lines list + §B lines list,
  // each list using per-line descriptors and bare-digit continuations.
  // Fixture has §Acceptance Criteria (3 ACs at lines 45-47) and we
  // re-use §Token Security Properties for both §A and §B (one section
  // is enough to assert the section-context-tracking works).
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "Spec-002 AC1, AC3, §Token Security Properties lines 39 (HS256), 40 (expiry), 41 (keychain)",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors.filter((a) => a.type === "ac").length, 2);
  assert.equal(anchors.filter((a) => a.type === "line").length, 3);
});

test("FAIL 38: AC line-hint outside §Acceptance Criteria rejects", () => {
  // Fixture line 10 = `InviteCreate` payload bullet. AC1 maps to fixture
  // line 45. A hint pointing at line 10 (`(line 10)`) sits in §Interfaces
  // and Contracts, not §Acceptance Criteria — pre-fix this passed
  // because line 10 starts with `- ` (a checkbox-ish bullet shape in the
  // looser regex match). Now rejects with `ac-line-hint-outside-section`.
  const { verifyFailures } = verifyAll("Spec-002 AC1 (line 10)");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "ac-line-hint-outside-section");
});

// ============================================================
// Multi-match fail-closed regressions (Codex P2 on PR #96 line 1364)
// ============================================================
// Each test builds a temp directory containing two `NNN-*.md` siblings
// that share the same numeric prefix (or in the arch-doc case, two
// `<filename>.md` files at different paths) and asserts the verifier
// fails-closed with the `*-ambiguous` reason rather than silently
// picking the first match — the original Codex flag was that the
// prior singular helpers (`findPaddedFile` / `findArchDocFile`)
// returned whichever entry the filesystem listed first, masking a
// botched rename / bad merge. Those singular helpers are now deleted
// (zero callers); only the plural fail-closed variants remain.

test("FAIL 39: spec-file-ambiguous when two NNN-*.md files share a prefix", () => {
  const tmp = mkdtempSync(resolve(tmpdir(), "preflight-spec-ambiguous-"));
  writeFileSync(resolve(tmp, "100-spec-one.md"), "# stub one\n");
  writeFileSync(resolve(tmp, "100-spec-two.md"), "# stub two\n");
  const result = verifyAnchorAgainstSpec(
    { type: "line", spec: 100, line: 1, raw: "Spec-100 line 1" },
    { specsDir: tmp },
  );
  assert.equal(result.valid, false);
  assert.equal(result.reason, "spec-file-ambiguous");
  assert.match(result.evidence, /100-spec-one\.md/);
  assert.match(result.evidence, /100-spec-two\.md/);
});

test("FAIL 40: adr-file-ambiguous when two NNN-*.md ADR files share a prefix", () => {
  const tmp = mkdtempSync(resolve(tmpdir(), "preflight-adr-ambiguous-"));
  writeFileSync(resolve(tmp, "099-adr-one.md"), "# stub one\n");
  writeFileSync(resolve(tmp, "099-adr-two.md"), "# stub two\n");
  const result = verifyAnchorAgainstSpec(
    { type: "adr-section", adr: 99, section: "Decision", raw: "ADR-099 §Decision" },
    { adrsDir: tmp },
  );
  assert.equal(result.valid, false);
  assert.equal(result.reason, "adr-file-ambiguous");
  assert.match(result.evidence, /099-adr-one\.md/);
  assert.match(result.evidence, /099-adr-two\.md/);
});

test("PASS 38b: comma-separated plan-local-ids split into N anchors at top level", () => {
  // Pre-fix the top-level splitter only recognized `, Spec-`/`, ADR-`/
  // `, <file>.md`/`, cross-plan-deps` as boundaries, so `I-024-1, I-024-2,
  // I-024-3` folded into one anchor with the trailing IDs swallowed into
  // the descriptor (Codex P1 on PR #96 line 620). Now `, I-` is a
  // recognized boundary and the payload yields 5 separate plan-local-id
  // anchors.
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "I-024-1, I-024-2, I-024-3, I-024-4, I-024-5 (inherited from Phase 3 sidecar)",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors.length, 5);
  assert.deepEqual(
    anchors.map((a) => a.id),
    ["I-024-1", "I-024-2", "I-024-3", "I-024-4", "I-024-5"],
  );
});

test("FAIL 43: plan-local-id-malformed-trailer rejects `I-024-3, typo`", () => {
  // Pre-fix this passed because parsePlanLocalIdSegment greedily accepted
  // the comma-prefixed trailer as a descriptor (Codex P1 on PR #96 line
  // 620). Now the trailer must be empty / parenthetical / whitespace-
  // prefixed, so a bare comma trailer fails closed.
  const { parseFailures } = verifyAll("I-024-3, typo");
  assert.equal(parseFailures.length, 1);
  assert.equal(parseFailures[0].kind, "plan-local-id-malformed-trailer");
  assert.match(parseFailures[0].message, /malformed trailing text/);
});

test("FAIL 44: phantom §-prefix rejects when only a heading substring matches", () => {
  // Pre-fix findSectionHeading used `.includes()` so `§Token` matched the
  // real heading `Token Security Properties` and the cite false-passed
  // (Codex P2 on PR #96 line 1435). Exact-after-normalize equality now
  // rejects the partial heading.
  const { verifyFailures } = verifyAll("Spec-002 §Token line 39");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "section-not-found");
});

test("FAIL 42: ac-line-hint-wrong-bullet binds the hint to the cited AC-N", () => {
  // Fixture AC bullets sit at lines 45 (AC1), 46 (AC2), 47 (AC3). A cite
  // like `AC3 (line 45)` is the false-green class Codex flagged on PR #96
  // line 1571 — the hint is an AC bullet (passes ac-line-hint-not-bullet)
  // and sits inside §Acceptance Criteria (passes ac-line-hint-outside-
  // section), but it does not point at AC3. The new check now ties the
  // hint to the specific AC-N index so traceability is per-anchor.
  const { verifyFailures } = verifyAll("Spec-002 AC3 (line 45)");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "ac-line-hint-wrong-bullet");
  assert.match(verifyFailures[0].result.evidence, /AC3 sits at line 47/);
});

test("FAIL 41: arch-doc-ambiguous when filename collides across subdirs", () => {
  const tmp = mkdtempSync(resolve(tmpdir(), "preflight-arch-ambiguous-"));
  mkdirSync(resolve(tmp, "contracts"));
  mkdirSync(resolve(tmp, "schemas"));
  writeFileSync(resolve(tmp, "contracts", "duplicate.md"), "# contracts version\n");
  writeFileSync(resolve(tmp, "schemas", "duplicate.md"), "# schemas version\n");
  const result = verifyAnchorAgainstSpec(
    { type: "arch-doc", file: "duplicate.md", raw: "duplicate.md" },
    { archDocsDir: tmp },
  );
  assert.equal(result.valid, false);
  assert.equal(result.reason, "arch-doc-ambiguous");
  assert.match(result.evidence, /contracts\/duplicate\.md/);
  assert.match(result.evidence, /schemas\/duplicate\.md/);
});

// ============================================================
// Range sub-tokens inside comma-lists
// ============================================================
// The standalone range handler fires only when `lines N1-N2` is the
// entire cite body. Pre-fix, the comma-list sub-token loop had no range
// branch, so a mid-list range halted as unparseable-spec-subanchor even
// though the fallback's accepted-shapes message advertised
// `lines N1-N2 (single-subject)` as accepted (a Plan-003 T3.9
// Spec-coverage cite halted Gate 4 on exactly this).

test("PASS 45: range sub-token inside a comma-list parses (Plan-003 T3.9 halt shape)", () => {
  const { anchors, failures } = parseCitePayload(
    "Spec-016 §Channel Lifecycle line 52 (create path), line 57 (archive path), lines 65-72 (rename ripple)",
  );
  assert.equal(failures.length, 0, `expected clean parse; got: ${JSON.stringify(failures)}`);
  assert.equal(anchors.length, 3);
  assert.equal(anchors[0].type, "line");
  assert.equal(anchors[1].type, "line");
  assert.equal(anchors[2].type, "line-range");
  assert.equal(anchors[2].start, 65);
  assert.equal(anchors[2].end, 72);
  assert.equal(anchors[2].section, "Channel Lifecycle");
});

test("PASS 46: §Section-qualified range sub-token re-sections mid-list", () => {
  const { anchors, failures } = parseCitePayload(
    "Spec-002 §Interfaces and Contracts line 13 (PresenceUpdate), §Rate Limiting lines 28-34 (RateLimitResponse)",
  );
  assert.equal(failures.length, 0, `expected clean parse; got: ${JSON.stringify(failures)}`);
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].section, "Interfaces and Contracts");
  assert.equal(anchors[1].type, "line-range");
  assert.equal(anchors[1].section, "Rate Limiting");
  assert.equal(anchors[1].subject, "RateLimitResponse");
});

test("PASS 47: spaced range sub-token parses as a range, not line + swallowed descriptor", () => {
  // The single-line re-section branch's ` - dash-descriptor` alternative
  // would otherwise claim `§A lines 39 - 41 (...)` as line 39 with
  // descriptor "41 (token rules)" — a silent wrong-anchor false-green.
  // The range branch precedes it specifically to prevent that.
  const { anchors, failures } = parseCitePayload(
    "Spec-002 line 11, §Token Security Properties lines 39 - 41 (token rules)",
  );
  assert.equal(failures.length, 0, `expected clean parse; got: ${JSON.stringify(failures)}`);
  const rangeAnchor = anchors.find((a) => a.type === "line-range");
  assert.ok(rangeAnchor, `expected a line-range anchor; got: ${JSON.stringify(anchors)}`);
  assert.equal(rangeAnchor.start, 39);
  assert.equal(rangeAnchor.end, 41);
  assert.ok(!anchors.some((a) => a.type === "line" && a.line === 39));
});

test("FAIL 48: mid-list compound range with distinct subjects still rejects", () => {
  // The range branch carries the standalone handler's one-anchor-per-
  // behavior rejection — accepting multi-subject ranges mid-list would
  // weaken the gate relative to the standalone form.
  const { failures } = parseCitePayload(
    "Spec-002 line 11 (InviteCreate), lines 13-14 (PresenceUpdate/PresenceRead)",
  );
  assert.ok(
    failures.some((f) => f.kind === "compound-range-multi-subject"),
    `expected compound-range-multi-subject failure; got: ${JSON.stringify(failures)}`,
  );
});

test("PASS 49: bare-digit continuation after a mid-list range keeps the lines-list context", () => {
  // A range sub-token uses the `lines` keyword, so per the established
  // continuation rule it admits trailing bare-digit entries.
  const { anchors, failures } = parseCitePayload(
    "Spec-002 §Token Security Properties lines 39-40 (token policy), 41 (keychain)",
  );
  assert.equal(failures.length, 0, `expected clean parse; got: ${JSON.stringify(failures)}`);
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].type, "line-range");
  assert.equal(anchors[1].type, "line");
  assert.equal(anchors[1].line, 41);
  assert.equal(anchors[1].section, "Token Security Properties");
});

test("PASS 50: mid-list range verifies end-to-end against the spec fixture", () => {
  // Fixture 003: `RateLimitResponse` intro on line 16, fenced shape block
  // at 18-25 (same ambient-window geometry PASS 13 pins down).
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "Spec-003 §Rate Limiting line 16 (RateLimitResponse), lines 18-25 (RateLimitResponse canonical shape)",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(
    verifyFailures.length,
    0,
    `expected clean verify; got: ${JSON.stringify(verifyFailures)}`,
  );
  assert.equal(anchors.length, 2);
  assert.equal(anchors[1].type, "line-range");
  assert.equal(anchors[1].subject, "RateLimitResponse");
});

// ============================================================
// Size-classed ceremony (PR-5, design memo §5): classifyPhaseSize /
// extractDeclaredFilePaths units, G4 tiering by size class, preflight
// sizeClass surfacing, CLI two-line stdout contract, and the auto-walk
// selection-semantics regression pins (PM-31b/PM-31c).
// ============================================================

const SIZE_CLASS_PREFLIGHT_CLI = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "preflight.mjs",
);
const PASSING_S_PLAN = resolve(FIXTURE_DIR, "200-passing-s-plan.md");
const GRAMMAR_S_PLAN = resolve(FIXTURE_DIR, "201-grammar-defect-s-plan.md");
const GRAMMAR_L_PLAN = resolve(FIXTURE_DIR, "202-grammar-defect-l-plan.md");
const MISSING_SPEC_S_PLAN = resolve(FIXTURE_DIR, "203-missing-spec-s-plan.md");
const WARNINGS_CARRY_WALK_PLAN = resolve(FIXTURE_DIR, "204-warnings-carry-walk-plan.md");

test("classifyPhaseSize: 1 task is S regardless of paths", () => {
  assert.equal(classifyPhaseSize(["T1"], ["packages/a/src/x.ts"]), "S");
});

test("classifyPhaseSize: 2-3 tasks in a single package root is M; non-code paths don't count", () => {
  assert.equal(
    classifyPhaseSize(
      ["T1", "T2"],
      ["packages/a/src/x.ts", "packages/a/src/y.ts", "docs/plans/001-x.md"],
    ),
    "M",
  );
});

test("classifyPhaseSize: two package roots is L", () => {
  assert.equal(
    classifyPhaseSize(["T1", "T2"], ["packages/a/src/x.ts", "packages/b/src/y.ts"]),
    "L",
  );
});

test("classifyPhaseSize: >3 tasks is L even in one root", () => {
  assert.equal(classifyPhaseSize(["T1", "T2", "T3", "T4"], ["packages/a/src/x.ts"]), "L");
});

test("classifyPhaseSize: zero parsed task IDs FAILS CLOSED to L (unrecognized shape gets full ceremony)", () => {
  assert.equal(classifyPhaseSize([], []), "L");
});

test("extractDeclaredTaskIds parses the em-dash-inside-bold row shape audited plans use (Codex P1, PR #190)", () => {
  const block = [
    "#### Tasks",
    "",
    "- **T1.1 — `repo.ts` contract core: branded IDs + canonical enums.**",
    "- **T1.2 — `RepoAttach` + `RepoMountRead` schemas.**",
    "- **T-100-1.3** — bold-closes-after-id shape still parses",
    "- [ ] **T21.1-4 — checkbox row shape (Plan-021) parses too.**",
    "",
  ].join("\n");
  assert.deepEqual(extractDeclaredTaskIds(block), ["T-100-1.3", "T1.1", "T1.2", "T21.1-4"]);
});

test("extractDeclaredTaskIds rejects prose bolds starting with T — no phantom ids (Codex P1, PR #190)", () => {
  const block = [
    "#### Tasks",
    "",
    "- **T1.1 — real task.**",
    "- **Test (C1):** metadata bullet that must NOT count as a task id",
    "- **Tooling note:** neither must this",
    "",
    "##### Testing strategy",
    "",
  ].join("\n");
  assert.deepEqual(extractDeclaredTaskIds(block), ["T1.1"]);
});

test("extractDeclaredFilePaths counts directory and glob targets as root-bearing (Codex, PR #190)", () => {
  const paths = extractDeclaredFilePaths(
    "Files: `packages/runtime-daemon/src/ipc/handlers/`, `apps/desktop/src/renderer/src/participants/`",
  );
  assert.deepEqual(paths, [
    "packages/runtime-daemon/src/ipc/handlers/",
    "apps/desktop/src/renderer/src/participants/",
  ]);
  assert.equal(classifyPhaseSize(["T1", "T2"], paths), "L");
  assert.deepEqual(extractDeclaredFilePaths("Files: `packages/a/src/**/*.ts`"), [
    "packages/a/src/**/*.ts",
  ]);
});

test("extractDeclaredFilePaths survives inline annotations between paths (Codex, PR #190)", () => {
  const paths = extractDeclaredFilePaths(
    "Files: `packages/a/src/x.ts` (CREATE) + `apps/b/src/y.ts` (EXTEND); Verifies invariant: I-1",
  );
  assert.deepEqual(paths, ["packages/a/src/x.ts", "apps/b/src/y.ts"]);
  assert.equal(classifyPhaseSize(["T1", "T2"], paths), "L");
});

test("extractDeclaredFilePaths covers the sub-header bold-field layout and strips markup", () => {
  assert.deepEqual(extractDeclaredFilePaths("Files: `packages/a/src/x.ts`, docs/plans/001-x.md"), [
    "packages/a/src/x.ts",
    "docs/plans/001-x.md",
  ]);
});

test("extractDeclaredFilePaths covers the parenthesized inline layout, dedups, stays order-stable", () => {
  const section = [
    "- **T-1** (Files: `packages/a/src/x.ts` `packages/a/src/y.ts`; Verifies invariant: I-1) — desc",
    "- **T-2** — other",
    "  - **Files:** `packages/a/src/x.ts`",
  ].join("\n");
  assert.deepEqual(extractDeclaredFilePaths(section), [
    "packages/a/src/x.ts",
    "packages/a/src/y.ts",
  ]);
});

const grammarDefectSection = [
  "#### Tasks",
  "",
  "- **T-1** — Task with an unparseable cite form",
  "  - **Spec coverage:** xyz random junk",
  "  - **Verifies invariant:** I-1",
  "",
].join("\n");

const missingSpecSection = [
  "#### Tasks",
  "",
  "- **T-1** — Task citing a spec absent from the corpus",
  "  - **Spec coverage:** Spec-100 line 3 (MissingFixtureIdentifier)",
  "  - **Verifies invariant:** I-1",
  "",
].join("\n");

test("G4 tiering: grammar-shaped kind demotes to warnings for size-class S", () => {
  const r = gateTasksBlockCites(grammarDefectSection, "016", 1, { sizeClass: "S" });
  assert.equal(r.ok, true, `expected demote-pass; got halt:\n${r.halt}`);
  assert.ok(r.warnings.length >= 1, "demoted findings must ride the warnings channel");
  assert.equal(r.warnings[0].kind, "unparseable-cite");
});

test("G4 tiering: the SAME grammar defect stays a hard halt for size-class L", () => {
  assert.equal(gateTasksBlockCites(grammarDefectSection, "016", 1, { sizeClass: "L" }).ok, false);
});

test("G4 tiering: the grammar defect stays a hard halt when no sizeClass is passed", () => {
  assert.equal(gateTasksBlockCites(grammarDefectSection, "016", 1, {}).ok, false);
});

test("G4 tiering: existence-shaped kind halts for EVERY class (fail-closed set polarity)", () => {
  const r = gateTasksBlockCites(missingSpecSection, "016", 1, { sizeClass: "S" });
  assert.equal(r.ok, false);
  assert.match(r.halt, /spec-file-not-found|spec-file/);
});

test("G4 tiering: a halting S-class run still lists demoted grammar findings (never silent)", () => {
  const mixedSection = [
    "#### Tasks",
    "",
    "- **T-1** — Task with one grammar defect and one existence defect",
    "  - **Spec coverage:** xyz random junk",
    "  - **Spec coverage:** Spec-100 line 3 (MissingFixtureIdentifier)",
    "  - **Verifies invariant:** I-1",
    "",
  ].join("\n");
  const r = gateTasksBlockCites(mixedSection, "016", 1, { sizeClass: "S" });
  assert.equal(r.ok, false, "existence defect must still halt S");
  assert.match(r.halt, /Demoted to warnings under size-class S/);
  assert.match(r.halt, /unparseable-cite/);
});

test("runPreflight surfaces sizeClass on the explicit-phase success path", () => {
  const r = runPreflight(PASSING_S_PLAN, 1, {});
  assert.equal(r.exit, 0, `expected pass; got:\n${r.stdout}`);
  assert.equal(r.stdout, "1");
  assert.equal(r.sizeClass, "S");
});

test("CLI prints size-class as stdout line 2 (line 1 UNCHANGED; spawn — the bin guard requires it)", () => {
  const cli = spawnSync(
    process.execPath,
    [SIZE_CLASS_PREFLIGHT_CLI, PASSING_S_PLAN, "1", "--allow-stale-manifest"],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 0, `status=${cli.status} stdout=${cli.stdout} stderr=${cli.stderr}`);
  assert.equal(cli.stdout, "1\nsize-class: S\n");
});

// AUTO-WALK selection semantics pinned (PM-31b — next-task-detection integrity):
// (a) S-class grammar defect: walk SELECTS the phase (was: strict-halt) and the
//     demoted findings surface on the WARNINGS channel, never silently dropped.
test("auto-walk (a): S-class grammar defect selects the phase with warnings riding the return", () => {
  const walkS = runPreflight(GRAMMAR_S_PLAN, undefined, {});
  assert.equal(walkS.exit, 0, `expected select; got halt:\n${walkS.stdout}`);
  assert.equal(walkS.stdout, "1");
  assert.ok(walkS.warnings.length >= 1, "demoted findings ride the return");
});

test("auto-walk (a) CLI: two-line stdout contract + demoted warnings on STDERR", () => {
  const cliWalk = spawnSync(
    process.execPath,
    [SIZE_CLASS_PREFLIGHT_CLI, GRAMMAR_S_PLAN, "--allow-stale-manifest"],
    { encoding: "utf8" },
  );
  assert.equal(
    cliWalk.status,
    0,
    `status=${cliWalk.status} stdout=${cliWalk.stdout} stderr=${cliWalk.stderr}`,
  );
  assert.equal(cliWalk.stdout, "1\nsize-class: S\n");
  assert.match(cliWalk.stderr, /demoted.*grammar/i);
});

// (b) same Tasks-block defect in an L-shaped phase (4 tasks): strict-halt preserved verbatim.
test("auto-walk (b): the SAME grammar defect in an L-shaped phase strict-halts", () => {
  const walkL = runPreflight(GRAMMAR_L_PLAN, undefined, {});
  assert.equal(walkL.exit, 1);
  assert.match(walkL.stdout, /Gate 4 cite-anchor semantic check failed/);
});

// (c) existence-shaped defect (nonexistent spec): halts for EVERY class.
test("auto-walk (c): existence-shaped defect halts even for an S-class phase", () => {
  assert.equal(runPreflight(MISSING_SPEC_S_PLAN, undefined, {}).exit, 1);
});

// (d) eligibility invariance (PM-31c): every pre-existing fixture's runPreflight
//     outcome (exit + stdout line 1 + halt text) is byte-identical to pre-change —
//     asserted by the untouched pre-existing suite above; only the new sizeClass
//     field / stdout line 2 / warnings channel may differ.

test("extractDeclaredFilePaths strips trailing sentence punctuation (Codex PR #190: plan-024 Phase 2 shape)", () => {
  assert.deepEqual(extractDeclaredFilePaths("Files: `packages/contracts/src/pty-host.ts`."), [
    "packages/contracts/src/pty-host.ts",
  ]);
  // Dropping the root demoted a real two-root phase to M; with the strip it is L.
  assert.equal(
    classifyPhaseSize(
      ["T1", "T2", "T3"],
      extractDeclaredFilePaths(
        "Files: `packages/contracts/src/pty-host.ts`.\nFiles: `packages/runtime-daemon/src/pty/node-pty-host.ts`",
      ),
    ),
    "L",
  );
});

test("classifyPhaseSize: non-package CODE paths (tools/, .claude/, .github/) fail closed to L (Codex, PR #190)", () => {
  assert.equal(
    classifyPhaseSize(["T1", "T2"], [".claude/skills/plan-execution/scripts/preflight.mjs"]),
    "L",
  );
  assert.equal(classifyPhaseSize(["T1", "T2"], ["tools/docs-corpus/lib/label-cite.ts"]), "L");
  // docs-ish paths stay exempt: alone → M; alongside a single package root → M
  assert.equal(classifyPhaseSize(["T1", "T2"], ["docs/specs/002-x.md", "CONTRIBUTING.md"]), "M");
  assert.equal(
    classifyPhaseSize(["T1", "T2"], ["packages/a/src/x.ts", "docs/specs/002-x.md"]),
    "M",
  );
});

test("G4 tiering: subject-mismatch stays a HARD error even for size-class S (Codex, PR #190)", () => {
  assert.ok(!G4_GRAMMAR_DEMOTE_KINDS.has("subject-mismatch"));
  assert.ok(!G4_GRAMMAR_DEMOTE_KINDS.has("subject-mismatch-in-range"));
});

test("classifyPhaseSize: root-level files count as non-exempt targets — package.json forces L (Codex, PR #190)", () => {
  const paths = extractDeclaredFilePaths("Files: package.json, `packages/a/src/x.ts`");
  assert.ok(paths.includes("package.json"), "slash-less root file must be path-shaped");
  assert.equal(classifyPhaseSize(["T1", "T2"], paths), "L");
});

test("classifyPhaseSize: wildcard package roots never prove single-root confinement (Codex, PR #190)", () => {
  assert.equal(classifyPhaseSize(["T1", "T2"], ["packages/*/src/index.ts"]), "L");
  // a glob confined WITHIN one literal package still earns M
  assert.equal(classifyPhaseSize(["T1", "T2"], ["packages/a/src/**/*.ts"]), "M");
});

test("G4 tiering: no-anchor Spec parse failure stays HARD for S — it can mask a missing spec (Codex, PR #190)", () => {
  assert.ok(!G4_GRAMMAR_DEMOTE_KINDS.has("unparseable-spec-subanchor"));
  const section = [
    "#### Tasks",
    "",
    "- **T-1** — Task with a no-anchor spec cite naming an absent spec",
    "  - **Spec coverage:** Spec-999 row 4",
    "  - **Verifies invariant:** I-1",
    "",
  ].join("\n");
  assert.equal(gateTasksBlockCites(section, "016", 1, { sizeClass: "S" }).ok, false);
});

test("classifyPhaseSize: bare packages/<name> and apps/<name> tokens are root-bearing (Codex, PR #190)", () => {
  assert.equal(classifyPhaseSize(["T1", "T2"], ["packages/a", "apps/b"]), "L");
  assert.equal(classifyPhaseSize(["T1", "T2"], ["packages/a"]), "M");
});

test("extractDeclaredFilePaths keeps semicolon-separated paths, still truncating at metadata markers (Codex, PR #190)", () => {
  assert.deepEqual(
    extractDeclaredFilePaths("Files: packages/a/src/x.ts (NEW); apps/b/src/y.ts (EXTEND)"),
    ["packages/a/src/x.ts", "apps/b/src/y.ts"],
  );
  assert.deepEqual(
    extractDeclaredFilePaths(
      "(Files: `packages/a/src/x.ts`; Verifies invariant: docs/specs/002-x.md)",
    ),
    ["packages/a/src/x.ts"],
  );
});

test("extractDeclaredTaskIds keeps ids whose bold titles contain a literal star (Codex P1, PR #190)", () => {
  const block = [
    "#### Tasks",
    "",
    "- **T1.4 — Typed repo error classes carrying the canonical `repo.*` code strings.**",
    "- [ ] **T4.6 — Register `participant.*` handlers.**",
    "",
  ].join("\n");
  assert.deepEqual(extractDeclaredTaskIds(block), ["T1.4", "T4.6"]);
});

test("extractDeclaredTaskIds unions ALL #### Tasks blocks in a phase (refinement-lane shape, PR #190)", () => {
  const section = [
    "### Phase 3 — Split-lane phase",
    "",
    "#### Tasks",
    "",
    "- **T3.1 — main-lane task.**",
    "",
    "#### Deliverables",
    "",
    "- prose that is not a task row",
    "",
    "#### Tasks",
    "",
    "- **T-007r-1-1** — refinement-lane task",
    "",
  ].join("\n");
  assert.deepEqual(extractDeclaredTaskIds(section), ["T-007r-1-1", "T3.1"]);
});

test("extractDeclaredFilePaths stops at BOLD metadata labels — cite prose slash-tokens stay out (Codex, PR #190)", () => {
  assert.deepEqual(
    extractDeclaredFilePaths(
      "- **Files:** `packages/a/src/x.ts` **Spec coverage:** Spec-002 §Rate Limiting (20/session/hr + membership/presence)",
    ),
    ["packages/a/src/x.ts"],
  );
  // `Files: none` + trailing cite prose must yield ZERO paths (fail-closed L),
  // not a nonzero non-code list that would award M.
  assert.deepEqual(
    extractDeclaredFilePaths(
      "- **Files:** none **Spec coverage:** Spec-002 line 88 (20/session/hr)",
    ),
    [],
  );
});

test("classifyPhaseSize: 2-3 tasks with ZERO parsed paths fail closed to L; docs-only keeps M (Codex, PR #190)", () => {
  assert.equal(classifyPhaseSize(["T1", "T2", "T3"], []), "L");
  assert.equal(classifyPhaseSize(["T1", "T2"], ["docs/specs/002-x.md"]), "M");
});

test("explicit-phase halt still surfaces the phase's demoted warnings (Codex, PR #190)", () => {
  const r = runPreflight(WARNINGS_CARRY_WALK_PLAN, 1, {});
  assert.equal(r.exit, 1, "phase 1 is precondition-blocked");
  assert.match(r.stdout, /[Pp]recondition/);
  assert.ok(
    r.warnings.some((w) => w.kind === "unparseable-cite"),
    "the demoted grammar finding must ride the halt, not vanish behind it",
  );
});

test("CLI folds demoted warnings INTO the stdout halt text (Codex, PR #190)", () => {
  const spawned = spawnSync(
    process.execPath,
    [
      resolve(FIXTURE_DIR, "../../preflight.mjs"),
      WARNINGS_CARRY_WALK_PLAN,
      "1",
      "--allow-stale-manifest",
    ],
    { encoding: "utf8" },
  );
  assert.equal(spawned.status, 1);
  // Orchestrators surface stdout verbatim on non-zero exit — the warnings
  // must live there, not on stderr where that contract never looks.
  assert.match(spawned.stdout, /Demoted grammar warnings \(non-blocking, carried by the halt\):/);
  assert.match(spawned.stdout, /\[unparseable-cite\]/);
});

test("auto-walk carries demoted warnings from SKIPPED phases into the selection (Codex PR #190)", () => {
  const walk = runPreflight(WARNINGS_CARRY_WALK_PLAN, undefined, {});
  assert.equal(walk.exit, 0, `expected select; got halt:\n${walk.stdout}`);
  assert.equal(walk.stdout, "2", "phase 1 is precondition-blocked; walk selects phase 2");
  assert.ok(
    walk.warnings.some((w) => w.kind === "unparseable-cite"),
    "phase 1's demoted grammar finding must ride the phase-2 selection, never silently dropped",
  );
});
