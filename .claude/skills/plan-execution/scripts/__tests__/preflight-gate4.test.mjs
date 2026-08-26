// node:test suite for preflight.mjs Gate 4 cite-anchor semantic verification.
// Run via: node --test .claude/skills/plan-execution/scripts/__tests__/preflight-gate4.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  existsSync,
  writeFileSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  normalizeCitePayload,
  extractIdentifierTokens,
  parseCitePayload,
  extractCiteAnchors,
  findSectionHeading,
  verifyAnchorAgainstSpec,
  gateTasksBlockCites,
  runPreflight,
  classifyPhaseSize,
  extractDeclaredFilePaths,
  extractDeclaredTaskIds,
  extractTasksBlock,
  walkPhases,
  extractPhaseSection,
  G4_GRAMMAR_DEMOTE_KINDS,
  LEGACY_INLINE_EXEMPT_KINDS,
  maskInlineCodeSpans,
  maskCiteContent,
  extractInlineCitePayloads,
  classifyInvariantReference,
  countCites,
  classifyPhaseMarkers,
  surveyCorpus,
  extractDeclaredInvariantIds,
  verifyInvariantReferences,
  facetBaseId,
} from "../preflight.mjs";
import { appendManifestEntry, parseManifestBlock } from "../lib/manifest.mjs";

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "preflight-gate4-fixtures");
// `__tests__` → `scripts` → `plan-execution` → `skills` → `.claude` → repo root.
const REPO_ROOT_FOR_TESTS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
);
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

// Attribution keys on the NEAREST PRECEDING task header in ANY corpus spelling.
// The bullet recognizer once required `**` to close right after the id
// (`- **T-025d-14-1** (Files: …)`), but the corpus-dominant spelling closes it
// after the TITLE. 241 headers across 12 plans were unrecognized (220 in-phase),
// so their markers silently inherited whichever id last matched — findings got
// reported against the wrong task. `taskId` is diagnostic and never gates, which
// is exactly why this survived: the gate's verdict stayed correct while its
// finger pointed at the wrong row.
test("extractCiteAnchors attributes markers to the nearest preceding task header, any spelling", () => {
  const sec = `#### Tasks

- **T-025d-14-1** (Files: deploy/x.yml) — bold closes after the id.
  - **Spec coverage:** Spec-002 line 13 (PresenceUpdate)

- **T-025s-1 — bold closes after the TITLE, not the id.**
  - **Spec coverage:** Spec-002 line 13 (PresenceUpdate)

- [ ] **T21.1-2 — a checkbox sits between the dash and the id.**
  - **Spec coverage:** Spec-002 line 13 (PresenceUpdate)

  - **T-007r-3-15 (slice a) — indented, parenthetical after the id.**
    - **Spec coverage:** Spec-002 line 13 (PresenceUpdate)

- **Tests:** an ordinary bold field beginning with T is NOT a task header.
  - **Spec coverage:** Spec-002 line 13 (PresenceUpdate)
`;
  const { anchors } = extractCiteAnchors(sec);
  assert.deepEqual(
    anchors.map((a) => a.taskId),
    ["T-025d-14-1", "T-025s-1", "T21.1-2", "T-007r-3-15", "T-007r-3-15"],
  );
});

test("extractCiteAnchors prefers the nearest header, not the heading-form one", () => {
  // `??` used to take the `#####` match whenever one existed anywhere in the
  // prefix, even with a bullet header sitting closer to the marker.
  const sec = `#### Tasks

##### T1.1 — heading-form task

- **T2.9 — a bullet-form task that comes LATER.**
  - **Spec coverage:** Spec-002 line 13 (PresenceUpdate)
`;
  const { anchors } = extractCiteAnchors(sec);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].taskId, "T2.9");
});

// Anti-drift, over the REAL corpus. Cite attribution and Gate 3's declared-id
// extraction are two consumers of one question — "what is a task row?" — and
// they already forked once: Gate 3 was hardened on PR #190 while attribution
// kept the narrow `**id**` form, mis-labeling findings under 241 headers in 12
// plans. They now share `taskHeaderMatches`; this pins that they agree, so a
// future private copy in either consumer fails here instead of silently
// mis-routing findings again. Attribution is diagnostic and Gate 3 gates, so
// divergence never shows up as a red build on its own.
test("corpus: every marker is attributed to its nearest preceding declared task header", () => {
  const plansDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
    "..",
    "docs",
    "plans",
  );
  const planFiles = readdirSync(plansDir).filter((n) => /^\d{3}-.*\.md$/.test(n));
  assert.ok(
    planFiles.length >= 20,
    `expected the real plans corpus, saw ${planFiles.length} file(s)`,
  );

  let attributedCount = 0;
  const orphans = [];
  for (const name of planFiles) {
    const src = readFileSync(resolve(plansDir, name), "utf8");
    for (const phase of walkPhases(src)) {
      const section = extractPhaseSection(src, phase.number ?? phase);
      if (!section) continue;
      const block = extractTasksBlock(section);
      if (block === null) continue;
      const declared = extractDeclaredTaskIds(section);
      const lines = block.split("\n");
      // Independent oracle. Deliberately NOT `taskHeaderMatches` — reusing the
      // implementation would make this tautological. Instead, take Gate 3's
      // declared ids as the authority and locate each one positionally, then
      // assert attribution picked the nearest preceding one. "Attributed id is
      // SOME declared id" is too weak to catch the original defect: markers
      // under `T-025s-1` were attributed to `T-025d-19-1`, which is itself a
      // declared id, so a membership check passes over the exact bug.
      const headerIdByLine = lines.map((line) => {
        for (const id of declared) {
          const esc = id.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
          if (
            new RegExp(String.raw`^(?:#####\s+|\s*-\s+(?:\[[ xX]\]\s+)?\*\*)${esc}\b`).test(line)
          ) {
            return id;
          }
        }
        return null;
      });
      for (const anchor of extractCiteAnchors(block).anchors) {
        if (!anchor.taskId) continue;
        attributedCount++;
        let expected = null;
        for (let i = Math.min(anchor.lineNo, lines.length) - 1; i >= 0; i--) {
          if (headerIdByLine[i]) {
            expected = headerIdByLine[i];
            break;
          }
        }
        if (expected !== null && anchor.taskId !== expected) {
          orphans.push(
            `${name} Phase ${phase.number ?? phase} line ${anchor.lineNo}: ` +
              `attributed ${anchor.taskId}, nearest preceding header is ${expected}`,
          );
        }
      }
    }
  }

  // Non-vacuity floor: a zero denominator would make the assertion below pass
  // over nothing at all, which is the exact false-clean shape this suite exists
  // to catch. If attribution stops resolving ids, fail loudly here.
  assert.ok(
    attributedCount > 50,
    `expected the corpus to attribute many anchors; got ${attributedCount}`,
  );
  assert.deepEqual(
    orphans,
    [],
    `markers attributed to a task other than their nearest preceding header:\n  ${orphans.join("\n  ")}`,
  );
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
      // Declared so the dispatch-path invariant resolver has something to resolve
      // `I-100-1` against — and, since the block lives in THIS tree and nowhere in
      // the real repo, the assertion below now fails closed on repoRoot threading
      // for the resolver as well as for Gate 4's spec lookups.
      "## Invariants",
      "",
      "- **I-100-1 — Fixture invariant**",
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

test("PASS 51: §-cite to a parenthetical-suffixed heading verifies (descriptor split)", () => {
  // `### Usage Telemetry (usage_telemetry)` — the Spec-006 category-heading
  // house style. The cite grammar splits a trailing `(...)` off as descriptor,
  // so the section name arrives paren-less and exact equality against the
  // full heading can never match; the matcher's paren-stripped fallback must
  // bind it (PR #222 false-negative: 3 legitimate Plan-005 T4.7 cites
  // rejected [section-not-found]).
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "Spec-002 §Usage Telemetry (usage_telemetry)",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors[0].type, "section-only");
  assert.equal(anchors[0].section, "Usage Telemetry");
});

test("PASS 52: paren-suffixed heading + line anchor verifies", () => {
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "Spec-002 §Usage Telemetry line 51 (usage.tokens)",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors[0].line, 51);
});

test("FAIL 49: heading-prefix cite still rejects against a parenthetical-suffixed heading", () => {
  // The fallback strips parentheticals from the HEADING side only — it must
  // not reintroduce the PR #96 `.includes()` prefix laxity. `§Usage` is a
  // prefix of `Usage Telemetry (usage_telemetry)`, not a paren-only delta.
  const { verifyFailures } = verifyAll("Spec-002 §Usage line 51");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "section-not-found");
});

test("findSectionHeading: exact heading beats paren-stripped fallback", () => {
  const specLines = ["## Retention (extra)", "body a", "## Retention", "body b"];
  const hit = findSectionHeading("Retention", specLines);
  assert.equal(hit.found, true);
  assert.equal(hit.headingLine, "## Retention");
});

test("findSectionHeading: fallback fires only on paren-suffixed headings, never on prefixes", () => {
  const specLines = ["## Token Security Properties", "body"];
  assert.equal(findSectionHeading("Token", specLines).found, false);
});

test("findSectionHeading: mid-heading parenthetical stays load-bearing (no synthesized heading)", () => {
  // Codex P2 on PR #224: a global paren-strip would let `§Postgres Deletion`
  // match `Postgres (Control Plane) Deletion` — a heading that does not
  // exist under that name. Only the TRAILING suffix (the one token the cite
  // grammar's descriptor split loses) may be stripped, so the mid-paren
  // heading must NOT satisfy the paren-less cite.
  const specLines = ["## Postgres (Control Plane) Deletion", "body"];
  assert.equal(findSectionHeading("Postgres Deletion", specLines).found, false);
  // Matcher-level exact pass still binds the full name (normalization strips
  // parens symmetrically on both sides in the exact comparison).
  assert.equal(findSectionHeading("Postgres (Control Plane) Deletion", specLines).found, true);
});

test("findSectionHeading: ambiguous stripped matches fail closed", () => {
  // Codex round-2 P2 on PR #224: `§Interface` against `## Interface (V1)` +
  // `## Interface (V2)` identifies neither heading — the fallback must
  // reject rather than take the first hit.
  const specLines = ["## Interface (V1)", "body a", "## Interface (V2)", "body b"];
  assert.equal(findSectionHeading("Interface", specLines).found, false);
});

test("findSectionHeading: an explicitly cited suffix disambiguates siblings", () => {
  // The cited-suffix agreement rule turns the ambiguous pair into a unique
  // target when the cite names the suffix.
  const specLines = ["## Interface (V1)", "body a", "## Interface (V2)", "body b"];
  const hit = findSectionHeading("Interface", specLines, "(V2)");
  assert.equal(hit.found, true);
  assert.equal(hit.headingLine, "## Interface (V2)");
});

test("findSectionHeading: a contradictory cited suffix rejects", () => {
  // Codex round-2 P2 on PR #224: `§Future Delivery Mechanisms (V1)` must not
  // verify against the real `### Future Delivery Mechanisms (V2)` heading.
  const specLines = ["### Future Delivery Mechanisms (V2)", "body"];
  assert.equal(findSectionHeading("Future Delivery Mechanisms", specLines, "(V1)").found, false);
});

test("findSectionHeading: two-paren descriptor tail matches on its FIRST group", () => {
  // The `§X (suffix) (gloss)` marker-line form: the first paren group is the
  // heading suffix, later groups are free-text gloss (the PR #222 cite shape).
  const specLines = ["### Usage Telemetry (usage_telemetry)", "body"];
  const hit = findSectionHeading(
    "Usage Telemetry",
    specLines,
    "(usage_telemetry) (`usage.rate_limit_update`, cost/window fields)",
  );
  assert.equal(hit.found, true);
});

test("findSectionHeading: duplicate identical stripped headings stay first-hit", () => {
  // Two heading LINES with the same full text are one target, not an
  // ambiguity — parity with the exact pass's duplicate-heading behavior.
  const specLines = ["## Retention (audit)", "body a", "## Retention (audit)", "body b"];
  assert.equal(findSectionHeading("Retention", specLines).found, true);
});

test("PASS 53: suffix before the line anchor parses the anchor and verifies both", () => {
  // `§X (suffix) line N` — pre-fix the section-only branch swallowed the
  // whole tail as descriptor text, so the line anchor vanished (Codex
  // round-3 P2 on PR #224). The parser now consumes the suffix into
  // `sectionDescriptor` and the line anchor verifies normally.
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "Spec-002 §Usage Telemetry (usage_telemetry) line 51 (usage.tokens)",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors[0].type, "line");
  assert.equal(anchors[0].line, 51);
  assert.equal(anchors[0].sectionDescriptor, "(usage_telemetry)");
});

test("FAIL 50: suffix + out-of-range line no longer rides a section-only pass", () => {
  // The exact false-green Codex flagged: with the line anchor swallowed,
  // `line 999999` verified as a section-only cite. It must fail as a LINE
  // cite now.
  const { verifyFailures } = verifyAll("Spec-002 §Usage Telemetry (usage_telemetry) line 999999");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "line-out-of-range");
});

test("FAIL 51: contradictory suffix before a line anchor rejects the section", () => {
  const { verifyFailures } = verifyAll("Spec-002 §Usage Telemetry (wrong_suffix) line 51");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "section-not-found");
});

test("findSectionHeading: suffix comparison preserves punctuation", () => {
  // Codex round-3 P2 on PR #224: normalizeTokenForMatch strips punctuation,
  // collapsing `(v1.0)` and `(v10)` — distinct versions — into one token.
  // The suffix comparator keeps punctuation, so the pair stays ambiguous to
  // a bare cite and a cited suffix binds only its true sibling.
  const specLines = ["## Cache (v1.0)", "body a", "## Cache (v10)", "body b"];
  assert.equal(findSectionHeading("Cache", specLines).found, false);
  assert.equal(findSectionHeading("Cache", specLines, "(v1.0)").headingLine, "## Cache (v1.0)");
  assert.equal(findSectionHeading("Cache", specLines, "(v10)").headingLine, "## Cache (v10)");
  // Single-sibling collapse case: `(v10)` must not repair onto `(v1.0)`.
  const single = ["## Cache (v1.0)", "body"];
  assert.equal(findSectionHeading("Cache", single, "(v10)").found, false);
});

test("findSectionHeading: fenced example headings are not citable targets", () => {
  // Codex round-3 P2 on PR #224: a `## Phantom (v1)` inside a code fence is
  // example text, not document structure. The scan mirrors
  // findSectionBoundary's fence rules (closer = same char, >= run length,
  // bare remainder), so real headings after the fence still bind.
  const specLines = [
    "## Real Section",
    "```md",
    "## Phantom (v1)",
    "```",
    "## After Fence (real)",
    "body",
  ];
  assert.equal(findSectionHeading("Phantom", specLines).found, false);
  assert.equal(findSectionHeading("After Fence", specLines).found, true);
  // Tilde fences and mismatched closers follow the same rules: a backtick
  // run inside a tilde fence does not close it.
  const tilde = ["~~~", "```", "## Inside Tilde (x)", "~~~", "## Outside (y)"];
  assert.equal(findSectionHeading("Inside Tilde", tilde).found, false);
  assert.equal(findSectionHeading("Outside", tilde).found, true);
});

test("findSectionHeading: suffixed sibling outranks a bare exact hit; mismatches fail closed", () => {
  // Codex round-3 P2 on PR #224, calibrated on the one real governance pair
  // (Spec-020 `## Required Behavior` + `### Required Behavior (policy)`):
  // a cited suffix that names a real sibling binds it; a descriptor that
  // matches NO sibling is undecidable (free-text gloss vs wrong suffix)
  // and rejects rather than silently landing on the bare heading.
  const specLines = ["## Required Behavior", "body a", "### Required Behavior (policy)", "body b"];
  assert.equal(
    findSectionHeading("Required Behavior", specLines).headingLine,
    "## Required Behavior",
  );
  assert.equal(
    findSectionHeading("Required Behavior", specLines, "(policy)").headingLine,
    "### Required Behavior (policy)",
  );
  assert.equal(findSectionHeading("Required Behavior", specLines, "(nonexistent)").found, false);
  // The pervasive gloss idiom survives where no suffixed sibling exists:
  // `§Rate Limiting (20/session/hr)` stays a pass on a bare heading.
  const glossOnly = ["## Rate Limiting", "body"];
  assert.equal(findSectionHeading("Rate Limiting", glossOnly, "(20/session/hr)").found, true);
});

test("findSectionHeading: cited suffix may omit heading-side backticks", () => {
  // Real corpus shape: `### Contract Layer (\`packages/contracts/\`)` — the
  // suffix comparator strips markdown code/emphasis markers (but nothing
  // else), so the cite spells the path without backticks.
  const specLines = ["### Contract Layer (`packages/contracts/`)", "body"];
  const hit = findSectionHeading("Contract Layer", specLines, "(packages/contracts/)");
  assert.equal(hit.found, true);
});

test("PASS 54: nested-paren heading suffix binds bare and suffixed cites", () => {
  // Codex round-4 P2 on PR #224, live corpus shape (Plan-008 CP-008-8's
  // trailing suffix nests markdown-link parens): a `[^)]*` regex truncates
  // at the inner close, so the balanced walk is required on both the
  // heading side and the cited-descriptor side. Fixture line 54 is
  // `### Cache Policy (RFC 9111 (shared cache))`.
  const bare = verifyAll("Spec-002 §Cache Policy line 56 (cache.directives)");
  assert.equal(bare.parseFailures.length, 0);
  assert.equal(bare.verifyFailures.length, 0);
  const suffixed = verifyAll("Spec-002 §Cache Policy (RFC 9111 (shared cache)) line 56");
  assert.equal(suffixed.parseFailures.length, 0);
  assert.equal(suffixed.verifyFailures.length, 0);
  assert.equal(suffixed.anchors[0].type, "line");
  assert.equal(suffixed.anchors[0].line, 56);
  assert.equal(suffixed.anchors[0].sectionDescriptor, "(RFC 9111 (shared cache))");
});

test("FAIL 52: contradictory nested suffix still rejects", () => {
  const { verifyFailures } = verifyAll("Spec-002 §Cache Policy (RFC 9111 (private cache)) line 56");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "section-not-found");
});

test("findSectionHeading: partial nested suffix is undecidable and rejects", () => {
  // `(RFC 9111)` against the real `(RFC 9111 (shared cache))` sibling:
  // agreement is whole-suffix, so a truncated spelling matches no sibling
  // and fails closed rather than repairing onto the nested heading.
  const specLines = ["## Cache Policy (RFC 9111 (shared cache))", "body"];
  assert.equal(
    findSectionHeading("Cache Policy", specLines, "(RFC 9111 (shared cache))").found,
    true,
  );
  assert.equal(findSectionHeading("Cache Policy", specLines, "(RFC 9111)").found, false);
});

test("findSectionHeading: indented-code fence literals do not open fence state", () => {
  // Codex round-4 P2 on PR #224: CommonMark allows at most 3 spaces of
  // fence-opener indentation — a ``` at 4+ spaces is indented-code literal
  // text. Under an unrestricted \s* opener it would open phantom fence
  // state and swallow every later real heading.
  const specLines = ["Some prose.", "    ```", "    still code", "## After Indented (real)"];
  assert.equal(findSectionHeading("After Indented", specLines).found, true);
  // 1-3-space indentation (the Plan-026 list-fence shape) still opens.
  const listFence = ["   ```", "## Hidden (x)", "   ```", "## Visible (y)"];
  assert.equal(findSectionHeading("Hidden", listFence).found, false);
  assert.equal(findSectionHeading("Visible", listFence).found, true);
});

test("findSectionHeading: headings inside multi-line HTML comments are not citable", () => {
  // Codex round-4 P2 on PR #224: a commented-out `## Phantom (v1)` renders
  // as nothing, so neither the exact pass nor the suffix fallback may bind
  // it — this hole predates the fallback (the exact pass has read comment
  // interiors since PR #96).
  const specLines = ["<!--", "## Phantom (v1)", "-->", "## Real (v2)", "body"];
  assert.equal(findSectionHeading("Phantom", specLines).found, false);
  assert.equal(findSectionHeading("Phantom", specLines, "(v1)").found, false);
  assert.equal(findSectionHeading("Real", specLines).found, true);
  // A single-line comment is inline content, not a state transition.
  const inline = ["prose <!-- annotation -->", "## Next (n)"];
  assert.equal(findSectionHeading("Next", inline).found, true);
  // Comment markers inside a fence are literal — they must not open
  // comment state that outlives the fence.
  const commentInFence = ["```", "<!--", "```", "## After (z)"];
  assert.equal(findSectionHeading("After", commentInFence).found, true);
});

test("PASS 55: gloss group between the suffix and the line anchor still parses the anchor", () => {
  // Codex round-5 P2 on PR #224: the multi-group form `§X (suffix) (gloss)
  // line N` must consume the whole group run and reach the anchor parser.
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "Spec-002 §Usage Telemetry (usage_telemetry) (`usage.tokens` gloss) line 51",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors[0].type, "line");
  assert.equal(anchors[0].line, 51);
  assert.equal(anchors[0].sectionDescriptor, "(usage_telemetry) (`usage.tokens` gloss)");
});

test("FAIL 53: an impossible line after suffix + gloss groups no longer passes as section-only", () => {
  const { verifyFailures } = verifyAll(
    "Spec-002 §Usage Telemetry (usage_telemetry) (gloss) line 999999",
  );
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "line-out-of-range");
});

test("re-sectioning latches off the prefix suffix even when the section name repeats", () => {
  // Codex round-5 P2 on PR #224: `§A (sfx) line N, §B line M, §A line K` —
  // the third anchor re-declares the section by NAME; it must not inherit
  // the prefix run's `(sfx)` claim (string equality on the name is not
  // scope membership).
  const { anchors, parseFailures } = verifyAll(
    "Spec-002 §Usage Telemetry (usage_telemetry) line 51, §Acceptance Criteria line 45, §Usage Telemetry line 52",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(anchors.length, 3);
  assert.equal(anchors[0].sectionDescriptor, "(usage_telemetry)");
  assert.equal(anchors[1].sectionDescriptor, null);
  assert.equal(anchors[2].sectionDescriptor, null);
});

test("findSectionHeading: ATX closing hashes do not hide the trailing suffix", () => {
  // Codex round-5 P2 on PR #224: `## Interface (V1) ##` is structurally
  // `## Interface (V1)`; the closing-hash run must strip before the paren
  // walk or both bare and suffixed cites fail section-not-found.
  const specLines = ["## Interface (V1) ##", "body"];
  assert.equal(findSectionHeading("Interface", specLines).found, true);
  assert.equal(findSectionHeading("Interface", specLines, "(V1)").found, true);
  assert.equal(findSectionHeading("Interface", specLines, "(V2)").found, false);
});

test("findSectionHeading: punctuation-only suffixes survive exact-normalization erasure", () => {
  // Codex round-5 P2 on PR #224: normalizeTokenForMatch strips `(+)`
  // entirely, so `## Interface (+)` exact-matches the bare target and
  // previously skipped candidate collection — letting a contradictory
  // `(-)` cite pass as free-text gloss. The line now registers as both
  // exact hit and suffix candidate.
  const specLines = ["## Interface (+)", "body"];
  assert.equal(findSectionHeading("Interface", specLines).found, true);
  assert.equal(findSectionHeading("Interface", specLines, "(+)").found, true);
  assert.equal(findSectionHeading("Interface", specLines, "(-)").found, false);
});

test("findSectionHeading: blockquoted fences hide their example headings", () => {
  // Codex round-5 P2 on PR #224: `> ```md` opens a fence whose
  // lazy-continuation interior lines (no `>` prefix) are still fenced
  // content. This test pins the BEHAVIOUR; the claim that the prefix
  // handling matches tools/docs-corpus/lib/markdown-fences.ts is pinned
  // separately, and by assertion rather than by this comment, in
  // preflight-external-contracts.test.mjs.
  const specLines = ["> ```md", "## Phantom (v1)", "> ```", "## Real (v2)", "body"];
  assert.equal(findSectionHeading("Phantom", specLines).found, false);
  assert.equal(findSectionHeading("Real", specLines).found, true);
});

test("findSectionHeading: backtick-fence info strings may not contain backticks", () => {
  // Codex round-6 P2 on PR #224: a ```ts`x line is inline code, not a
  // fence opener (CommonMark 4.5; advanceScanState parity) — treating it
  // as a fence swallowed every later heading until a matching closer.
  const inlineCode = ["```ts`inline`x", "## Real (v1)", "body"];
  assert.equal(findSectionHeading("Real", inlineCode).found, true);
  // A tilde fence's info string MAY carry backticks — it still opens.
  const tilde = ["~~~ts`x", "## Phantom (v1)", "~~~", "## Real (v2)", "body"];
  assert.equal(findSectionHeading("Phantom", tilde).found, false);
  assert.equal(findSectionHeading("Real", tilde).found, true);
});

test("findSectionHeading: multi-line code spans mask comment markers", () => {
  // Codex round-6 P2 on PR #224: a code span whose equal-length backtick
  // runs sit on different lines is code in between — a raw `<!--` there
  // must not enter comment state and swallow the following headings.
  const masked = [
    "prose `span opens",
    "<!-- this is span text",
    "and closes` here",
    "## Real (v1)",
    "body",
  ];
  assert.equal(findSectionHeading("Real", masked).found, true);
  // An UNCLOSED run is literal backticks, so the `<!--` after it is a real
  // comment opener — the lookahead decides at open time, never
  // retroactively.
  const unclosed = [
    "prose `never closes",
    "<!-- opens for real",
    "## Phantom (v1)",
    "-->",
    "## Real (v2)",
    "body",
  ];
  assert.equal(findSectionHeading("Phantom", unclosed).found, false);
  assert.equal(findSectionHeading("Real", unclosed).found, true);
});

test("findSectionHeading: ATX headings cap at six hashes", () => {
  // Codex round-6 P2 on PR #224: `####### Phantom (v1)` is prose, not a
  // level-7 heading (CommonMark 4.2) — it must not seed the suffix
  // fallback.
  const specLines = ["####### Phantom (v1)", "###### Real (v1)", "body"];
  assert.equal(findSectionHeading("Phantom", specLines).found, false);
  assert.equal(findSectionHeading("Real", specLines).found, true);
});

test("findSectionHeading: unbalanced cited descriptor groups reject", () => {
  // Codex round-6 P2 on PR #224: `§Usage (wrong` starts a suffix claim
  // that never balances — treating it as a bare cite let the fallback
  // bind a heading the malformed claim may contradict.
  const specLines = ["## Usage (v1)", "body"];
  assert.equal(findSectionHeading("Usage", specLines, "(wrong").found, false);
  assert.equal(findSectionHeading("Usage", specLines, "(v1)").found, true);
  // A tail with no leading paren is still the free-text gloss path.
  const bare = ["## Usage", "body"];
  assert.equal(findSectionHeading("Usage", bare, "— free-text gloss").found, true);
});

test("findSectionHeading: underscore emphasis strips only at delimiter positions", () => {
  // Codex round-6 P2 on PR #224: `## Interface (_V1_)` renders its suffix
  // as emphasized V1, so `(V1)` must bind — while the interior underscore
  // of `(usage_telemetry)` is semantic and must stay distinct.
  const emphasized = ["## Interface (_V1_)", "body"];
  assert.equal(findSectionHeading("Interface", emphasized, "(V1)").found, true);
  const snake = ["## Events (usage_telemetry)", "## Events (usagetelemetry)", "body"];
  const bound = findSectionHeading("Events", snake, "(usage_telemetry)");
  assert.equal(bound.found, true);
  assert.equal(bound.headingLine, "## Events (usage_telemetry)");
  assert.equal(findSectionHeading("Events", snake, "(usage-telemetry)").found, false);
});

test("findSectionHeading: punctuation-only suffix siblings make a bare cite ambiguous", () => {
  // Codex round-6 P2 on PR #224: `## Interface (+)` and `## Interface (-)`
  // both erase to the bare target in the exact comparison, so the exact
  // slot is reserved for genuinely unsuffixed headings — a bare
  // `§Interface` cannot silently bind the first sibling.
  const siblings = ["## Interface (+)", "## Interface (-)", "body"];
  assert.equal(findSectionHeading("Interface", siblings).found, false);
  assert.equal(findSectionHeading("Interface", siblings, "(+)").found, true);
  // A genuinely unsuffixed heading still wins the bare cite outright.
  const withBare = ["## Interface", "## Interface (V2)", "body"];
  const bareHit = findSectionHeading("Interface", withBare);
  assert.equal(bareHit.found, true);
  assert.equal(bareHit.headingLine, "## Interface");
});

test("findSectionHeading: raw HTML blocks hide their example headings", () => {
  // Codex round-6 P2 on PR #224: a `<pre>`/`<script>` block (CommonMark
  // 4.6 type 1) and a block-tag region ended by a blank line (type 6)
  // render raw, so a `## Phantom` inside satisfies no cite.
  const typeOne = ["<pre>", "## Phantom (v1)", "</pre>", "## Real (v2)", "body"];
  assert.equal(findSectionHeading("Phantom", typeOne).found, false);
  assert.equal(findSectionHeading("Real", typeOne).found, true);
  const typeSix = ["<details>", "## Phantom (v1)", "", "## Real (v2)", "body"];
  assert.equal(findSectionHeading("Phantom", typeSix).found, false);
  assert.equal(findSectionHeading("Real", typeSix).found, true);
  // A single-line block (`<!DOCTYPE html>`, type 4) closes on its own
  // line and must not swallow the document tail.
  const singleLine = ["<!DOCTYPE html>", "## Real (v1)", "body"];
  assert.equal(findSectionHeading("Real", singleLine).found, true);
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
// These five fixtures cite PLAN-LOCAL invariant ids (`I-1`, not `I-200-1`) on
// purpose. An `I-NNN-M` id names an owning plan, and the dispatch-path invariant
// resolver looks that plan up under the RUN's `docs/plans/` — which for a
// fixture executed against the real repo root is the real corpus, where no
// Plan-2NN exists. A plan-local id names no owning document, so these stay
// tests of size-class routing rather than of invariant resolution. The resolver
// has its own on-disk dispatch fixtures (see §Dispatch-path wiring, which builds
// a temp repo whose `docs/plans/` holds the owning plan).
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
    [SIZE_CLASS_PREFLIGHT_CLI, PASSING_S_PLAN, "1", "--allow-stale-manifest", "--allow-unpromoted"],
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
    [SIZE_CLASS_PREFLIGHT_CLI, GRAMMAR_S_PLAN, "--allow-stale-manifest", "--allow-unpromoted"],
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

test("G4 tiering: demotion re-applies the existence floor — no-anchor kinds naming a missing spec stay hard (Codex, PR #190)", () => {
  const missingSpecNoAnchor = [
    "#### Tasks",
    "",
    "- **T-1** — Plan-local id at anchor position, absent spec",
    "  - **Spec coverage:** Spec-999 C5",
    "  - **Verifies invariant:** I-1",
    "",
  ].join("\n");
  assert.equal(gateTasksBlockCites(missingSpecNoAnchor, "016", 1, { sizeClass: "S" }).ok, false);
  // Same no-anchor kind on an EXISTING spec still demotes — the guard is an
  // existence floor, not a blanket re-hardening.
  const existingSpecNoAnchor = [
    "#### Tasks",
    "",
    "- **T-1** — Plan-local id at anchor position, existing spec",
    "  - **Spec coverage:** Spec-002 C5",
    "  - **Verifies invariant:** I-1",
    "",
  ].join("\n");
  const r = gateTasksBlockCites(existingSpecNoAnchor, "016", 1, { sizeClass: "S" });
  assert.equal(r.ok, true, `expected demote-pass; got halt:\n${r.halt}`);
  assert.ok(r.warnings.length >= 1);
});

test("G4 tiering: sub-token failures inherit the segment's Spec for the existence floor (Codex, PR #190)", () => {
  const missingSpecCompoundRange = [
    "#### Tasks",
    "",
    "- **T-1** — Compound range on an absent spec",
    "  - **Spec coverage:** Spec-999 lines 13-14 (Foo/Bar)",
    "  - **Verifies invariant:** I-1",
    "",
  ].join("\n");
  assert.equal(
    gateTasksBlockCites(missingSpecCompoundRange, "016", 1, { sizeClass: "S" }).ok,
    false,
  );
  const existingSpecCompoundRange = missingSpecCompoundRange.replace("Spec-999", "Spec-002");
  const r = gateTasksBlockCites(existingSpecCompoundRange, "016", 1, { sizeClass: "S" });
  assert.equal(r.ok, true, `expected demote-pass; got halt:\n${r.halt}`);
  assert.equal(r.warnings[0].kind, "compound-range-multi-subject");
});

test("extractDeclaredFilePaths counts bare root tooling directories (Codex, PR #190)", () => {
  const paths = extractDeclaredFilePaths("Files: tools/, scripts, `packages/a/src/x.ts`");
  assert.ok(paths.includes("tools/"));
  assert.ok(paths.includes("scripts"));
  assert.equal(classifyPhaseSize(["T1", "T2"], paths), "L");
});

test("extractDeclaredFilePaths counts extensionless root config files (Codex, PR #190)", () => {
  const paths = extractDeclaredFilePaths("Files: Dockerfile, .nvmrc, `packages/a/src/x.ts`");
  assert.ok(paths.includes("Dockerfile"));
  assert.ok(paths.includes(".nvmrc"));
  assert.equal(classifyPhaseSize(["T1", "T2"], paths), "L");
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
      "--allow-unpromoted",
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

// ============================================================
// `AC line N` — the by-line acceptance-criterion sub-anchor
// ============================================================
// Established corpus vocabulary (Plan-011 / Plan-014 / Plan-025, 16 marker
// payloads) that the grammar previously rejected as
// `unparseable-spec-subanchor`. It is admitted as its OWN anchor type so the
// verifier can prove the cited line is an acceptance criterion — folding it
// into a plain `line` anchor would have made Gate 4 net-LOOSER, since a line
// anchor proves only in-range + non-blank.

test("AC line N parses as an `ac-line` anchor, never a plain `line` anchor", () => {
  const { anchors, parseFailures } = verifyAll("Spec-002 AC line 45");
  assert.equal(parseFailures.length, 0);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].type, "ac-line", "must NOT degrade to the weaker `line` anchor type");
  assert.equal(anchors[0].line, 45);
  assert.equal(anchors[0].spec, 2);
});

test("AC line N verifies VALID against a real §Acceptance Criteria checkbox", () => {
  // Fixture line 45 is the first `- [ ]` bullet under `## Acceptance Criteria`.
  const { verifyFailures } = verifyAll("Spec-002 AC line 45");
  assert.equal(verifyFailures.length, 0);
});

test("AC line N rejects a line past EOF with `ac-line-out-of-range`", () => {
  const { verifyFailures } = verifyAll("Spec-002 AC line 9999");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "ac-line-out-of-range");
});

test("AC line N rejects a non-checkbox line inside §Acceptance Criteria", () => {
  // Fixture line 48 is the blank line between the last AC bullet and the next
  // heading — inside the section bounds, but not a criterion.
  const { verifyFailures } = verifyAll("Spec-002 AC line 48");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "ac-line-not-bullet");
});

test("AC line N rejects a CHECKBOX-shaped line OUTSIDE §Acceptance Criteria", () => {
  // The decisive bounds proof: without the §Acceptance Criteria line-bounds
  // check, a `- [ ]` bullet anywhere in the spec would satisfy the
  // bullet-shape test and the anchor would false-pass. Built as a temp
  // fixture because the shared 002 fixture holds no checkbox outside its AC
  // section (and adding one there would renumber every existing line cite).
  const tmp = mkdtempSync(resolve(tmpdir(), "preflight-ac-line-bounds-"));
  writeFileSync(
    resolve(tmp, "300-ac-bounds.md"),
    [
      "# Temp spec",
      "",
      "## Pitfalls To Avoid",
      "",
      "- [ ] A checkbox-shaped bullet OUTSIDE the acceptance-criteria section.",
      "",
      "## Acceptance Criteria",
      "",
      "- [ ] The one real acceptance criterion.",
      "",
    ].join("\n"),
  );
  const outside = verifyAnchorAgainstSpec(
    { type: "ac-line", spec: 300, line: 5, raw: "Spec-300 AC line 5" },
    { specsDir: tmp },
  );
  assert.equal(outside.valid, false);
  assert.equal(outside.reason, "ac-line-outside-section");
  const inside = verifyAnchorAgainstSpec(
    { type: "ac-line", spec: 300, line: 9, raw: "Spec-300 AC line 9" },
    { specsDir: tmp },
  );
  assert.equal(inside.valid, true, "the genuine criterion on line 9 must still verify");
});

test("the AC section ENDS before the following heading, not on it", () => {
  // Off-by-one pin. `lastLineNum` is derived from a slice that stops at the
  // next heading's first character, so the raw line count lands ON that
  // heading. Un-corrected, the bounds admit the heading line: the cite falls
  // through to the bullet check and reports `ac-line-not-bullet`, while the
  // `section spans lines X-Y` evidence names a line that is not in the section.
  const tmp = mkdtempSync(resolve(tmpdir(), "preflight-ac-section-end-"));
  writeFileSync(
    resolve(tmp, "301-ac-section-end.md"),
    [
      "# Temp spec", // 1
      "", // 2
      "## Acceptance Criteria", // 3
      "", // 4
      "- [ ] The one real acceptance criterion.", // 5
      "", // 6
      "## Following Section", // 7
      "", // 8
      "Prose.", // 9
      "",
    ].join("\n"),
  );
  const onHeading = verifyAnchorAgainstSpec(
    { type: "ac-line", spec: 301, line: 7, raw: "Spec-301 AC line 7" },
    { specsDir: tmp },
  );
  assert.equal(onHeading.valid, false);
  assert.equal(
    onHeading.reason,
    "ac-line-outside-section",
    "the following heading's line is OUTSIDE the section, not a non-bullet inside it",
  );
  assert.match(
    onHeading.evidence,
    /section spans lines 4-6/,
    `evidence must name the true span; got: ${onHeading.evidence}`,
  );

  const inside = verifyAnchorAgainstSpec(
    { type: "ac-line", spec: 301, line: 5, raw: "Spec-301 AC line 5" },
    { specsDir: tmp },
  );
  assert.equal(inside.valid, true, "the genuine criterion must still verify");
});

test("a fenced `#` line does not truncate the AC section (no false red)", () => {
  // Fence-awareness pin. `^#+\s+\S` matches a shell comment inside a fenced
  // block, so a fence-blind scan ends the section at line 8 and REJECTS the
  // correct criterion on line 11 as out-of-section — a gate reddening correct
  // input. Zero specs carry this shape today; the check exists so the corpus
  // can grow one without the gate lying about it.
  const tmp = mkdtempSync(resolve(tmpdir(), "preflight-ac-fence-"));
  writeFileSync(
    resolve(tmp, "302-ac-fence.md"),
    [
      "# Temp spec", // 1
      "", // 2
      "## Acceptance Criteria", // 3
      "", // 4
      "- [ ] First criterion.", // 5
      "", // 6
      "```bash", // 7
      "# a shell comment, not a heading", // 8
      "```", // 9
      "", // 10
      "- [ ] Second criterion below the fence.", // 11
      "", // 12
      "## Following Section", // 13
      "",
    ].join("\n"),
  );
  const belowFence = verifyAnchorAgainstSpec(
    { type: "ac-line", spec: 302, line: 11, raw: "Spec-302 AC line 11" },
    { specsDir: tmp },
  );
  assert.equal(
    belowFence.valid,
    true,
    `criterion below the fence must verify; got ${belowFence.reason}: ${belowFence.evidence}`,
  );

  // The heading AFTER the fence still terminates the section, so the bounds
  // did not simply run to EOF.
  const past = verifyAnchorAgainstSpec(
    { type: "ac-line", spec: 302, line: 13, raw: "Spec-302 AC line 13" },
    { specsDir: tmp },
  );
  assert.equal(past.valid, false);
  assert.equal(past.reason, "ac-line-outside-section");
});

test("a FENCED `## Acceptance Criteria` is not selectable as the real section", () => {
  // The false-CLEAN twin of the fence test above: that one pins the section
  // TERMINATOR as fence-aware, this pins the section LOCATOR. Locating the
  // heading with a raw `/^#+\s+Acceptance Criteria$/m` picks the example inside
  // the fence, so `AC line N` verifies GREEN against an example bullet in a spec
  // carrying no acceptance-criteria section at all — the gate certifying a
  // criterion that does not exist (Codex P2, PR #260 round 1).
  const tmp = mkdtempSync(resolve(tmpdir(), "preflight-ac-fenced-heading-"));
  writeFileSync(
    resolve(tmp, "303-ac-fenced-heading.md"),
    [
      "# Temp spec", // 1
      "", // 2
      "## How To Write A Spec", // 3
      "", // 4
      "```markdown", // 5
      "## Acceptance Criteria", // 6
      "", // 7
      "- [ ] An EXAMPLE criterion, not a real one.", // 8
      "```", // 9
      "", // 10
      "## Required Behavior", // 11
      "", // 12
      "Prose.", // 13
      "",
    ].join("\n"),
  );
  const fenced = verifyAnchorAgainstSpec(
    { type: "ac-line", spec: 303, line: 8, raw: "Spec-303 AC line 8" },
    { specsDir: tmp },
  );
  assert.equal(
    fenced.valid,
    false,
    `a bullet inside a fenced example must never satisfy an AC cite; got: ${fenced.evidence}`,
  );
  assert.equal(
    fenced.reason,
    "ac-section-missing",
    "the spec has no REAL §Acceptance Criteria, so the cite fails for absence — not for bounds",
  );
});

test("a nested child heading does not truncate §Acceptance Criteria", () => {
  // Terminating on the next heading of ANY level ends the section at its own
  // legitimate child, so criteria under `### API criteria` are rejected as
  // out-of-section even though Markdown containment places them inside — a gate
  // reddening correct input (Codex P2, PR #260 round 1). Containment must stop
  // only at a heading whose level is <= the AC heading's, which is how
  // sectionSpansForHeadingText has always computed the general §Section case.
  const tmp = mkdtempSync(resolve(tmpdir(), "preflight-ac-nested-child-"));
  writeFileSync(
    resolve(tmp, "304-ac-nested-child.md"),
    [
      "# Temp spec", // 1
      "", // 2
      "## Acceptance Criteria", // 3
      "", // 4
      "- [ ] A criterion directly under the parent.", // 5
      "", // 6
      "### API criteria", // 7
      "", // 8
      "- [ ] A criterion under a legitimate CHILD heading.", // 9
      "", // 10
      "## Required Behavior", // 11
      "", // 12
      "Prose.", // 13
      "",
    ].join("\n"),
  );
  const underChild = verifyAnchorAgainstSpec(
    { type: "ac-line", spec: 304, line: 9, raw: "Spec-304 AC line 9" },
    { specsDir: tmp },
  );
  assert.equal(
    underChild.valid,
    true,
    `a criterion under a child heading is INSIDE the section; got ${underChild.reason}: ${underChild.evidence}`,
  );

  // The sibling-level heading still terminates, so the bounds did not simply
  // run to EOF — the fix widened containment, it did not remove it.
  const pastSibling = verifyAnchorAgainstSpec(
    { type: "ac-line", spec: 304, line: 13, raw: "Spec-304 AC line 13" },
    { specsDir: tmp },
  );
  assert.equal(pastSibling.valid, false);
  assert.equal(pastSibling.reason, "ac-line-outside-section");
});

test("a named section must CONTAIN the acceptance criterion it points at", () => {
  // Resolving the heading proved only that it EXISTS somewhere in the spec, so
  // `§Required Behavior AC line 9` was certified by a bullet that actually sits
  // under §Acceptance Criteria — the qualifier was decorative and a stale one
  // stayed green (Codex P1, PR #260 round 2). The plain line/line-range anchors
  // had carried this check since the Plan-015 T15.1 shape; the AC family was
  // simply left behind.
  const tmp = mkdtempSync(resolve(tmpdir(), "preflight-ac-named-section-"));
  writeFileSync(
    resolve(tmp, "305-ac-named-section.md"),
    [
      "# Temp spec", // 1
      "", // 2
      "## Required Behavior", // 3
      "", // 4
      "Prose that is not an acceptance criterion.", // 5
      "", // 6
      "## Acceptance Criteria", // 7
      "", // 8
      "- [ ] First criterion.", // 9
      "- [ ] Second criterion.", // 10
      "", // 11
      "## Other", // 12
      "",
    ].join("\n"),
  );
  const dirs = { specsDir: tmp };

  const wrongSection = verifyAnchorAgainstSpec(
    {
      type: "ac-line",
      spec: 305,
      line: 9,
      section: "Required Behavior",
      sectionFromPrefix: true,
      raw: "Spec-305 §Required Behavior AC line 9",
    },
    dirs,
  );
  assert.equal(
    wrongSection.valid,
    false,
    "a section that does not contain the criterion must fail",
  );
  assert.equal(wrongSection.reason, "line-outside-section");

  // Naming the section that DOES contain it still passes — the two bounds
  // compose, they do not conflict.
  const rightSection = verifyAnchorAgainstSpec(
    {
      type: "ac-line",
      spec: 305,
      line: 9,
      section: "Acceptance Criteria",
      sectionFromPrefix: true,
      raw: "Spec-305 §Acceptance Criteria AC line 9",
    },
    dirs,
  );
  assert.equal(
    rightSection.valid,
    true,
    `expected valid; got ${rightSection.reason}: ${rightSection.evidence}`,
  );

  // The ORDINAL shape is bounded too, though it cites no line at all: the
  // criterion's own resolved line is the containment subject. Without deriving
  // it there is nothing to hold `§Required Behavior AC1` to.
  const ordinalWrong = verifyAnchorAgainstSpec(
    {
      type: "ac",
      spec: 305,
      ac: 1,
      lineHint: null,
      section: "Required Behavior",
      sectionFromPrefix: true,
      raw: "Spec-305 §Required Behavior AC1",
    },
    dirs,
  );
  assert.equal(ordinalWrong.valid, false, "AC<N> with a wrong named section must fail");
  assert.equal(ordinalWrong.reason, "line-outside-section");
});

test("a sibling's §section does not bound a trailing AC line cite", () => {
  // The negative control for the check above, and not a hypothetical: arming
  // containment without it turned a VALID Plan-011 cite red. `section` is
  // sticky across sub-tokens by design (`§Foo line 10, line 12` — both in
  // §Foo), and an `AC line N` token can never carry its own `§` because its
  // regex is anchored at `^AC`. So a mid-payload re-section leaks forward onto
  // the AC claim: Plan-011 cites `… line 68 + §Git Hosting Adapter lines
  // 118-152 (…), AC line 175`, where line 175 is a correct §Acceptance Criteria
  // bullet that has nothing to do with §Git Hosting Adapter. Only a section the
  // anchor itself claims — the payload's own `§` prefix — may bound it.
  const inherited = parseCitePayload(
    "Spec-002 line 10 (InviteCreate), §Rate Limiting lines 17-20 (rate limit thresholds), AC line 45",
  ).anchors.find((anchor) => anchor.type === "ac-line");
  assert.equal(
    inherited.section,
    "Rate Limiting",
    "the sticky section still parses onto the anchor",
  );
  assert.equal(inherited.sectionFromPrefix, false, "but it is NOT this anchor's own claim");

  const authored = parseCitePayload("Spec-002 §Rate Limiting AC line 45").anchors.find(
    (anchor) => anchor.type === "ac-line",
  );
  assert.equal(authored.sectionFromPrefix, true, "a payload-prefix section IS this anchor's claim");

  // End-to-end against the real fixture spec: the inherited shape verifies
  // clean, the authored one is held to the section it names.
  const { verifyFailures: inheritedFailures } = verifyAll(
    "Spec-002 line 10 (InviteCreate), §Rate Limiting lines 17-20 (rate limit thresholds), AC line 45",
  );
  assert.deepEqual(
    inheritedFailures.map((failure) => failure.result.reason),
    [],
    `inherited-section AC cite must not fail: ${JSON.stringify(inheritedFailures)}`,
  );
  const { verifyFailures: authoredFailures } = verifyAll("Spec-002 §Rate Limiting AC line 45");
  assert.deepEqual(
    authoredFailures.map((failure) => failure.result.reason),
    ["line-outside-section"],
    "an authored §section that does not contain the criterion must still fail",
  );
});

test("AC line N rejects a descriptor subject absent from the cited criterion", () => {
  // Fixture line 47 names `ChannelList`; `PresenceUpdate` is elsewhere in the
  // spec, so the subject rule must fire rather than accepting any AC bullet.
  const { verifyFailures } = verifyAll("Spec-002 AC line 47 (PresenceUpdate projection)");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "subject-mismatch");
  const ok = verifyAll("Spec-002 AC line 47 (ChannelList projection)");
  assert.equal(ok.verifyFailures.length, 0);
});

test("a §Section prefix must not WEAKEN the AC-line anchor it prefixes", () => {
  // The section-prefix lookahead spelled the keyword `AC\d`, which requires a
  // digit — so on the by-line shape (`AC line 45`) the lazy capture ran past
  // the bare `AC` to the following `line`. Two losses at once: the section
  // captured `Acceptance Criteria AC` (a heading that does not exist), and the
  // anchor degraded from `ac-line` to a plain `line`, silently dropping the
  // in-section / is-a-bullet / subject-match checks. Adding context to a cite
  // must never buy weaker verification than leaving it off.
  const [prefixed] = parseCitePayload("Spec-002 §Acceptance Criteria AC line 45").anchors;
  assert.equal(prefixed.type, "ac-line", "the prefixed form must stay an ac-line anchor");
  assert.equal(prefixed.section, "Acceptance Criteria");
  assert.equal(prefixed.line, 45);

  // Parity with the unprefixed spelling: same type, same strength.
  const [bare] = parseCitePayload("Spec-002 AC line 45").anchors;
  assert.equal(bare.type, prefixed.type);

  // The indexed shape (`AC4`) was already covered by the `AC\d` spelling and
  // must not regress.
  const [indexed] = parseCitePayload("Spec-002 §Acceptance Criteria AC4 (line 45)").anchors;
  assert.equal(indexed.type, "ac");
  assert.equal(indexed.section, "Acceptance Criteria");
});

test("a section-adjacent parenthetical before `AC line N` does not swallow the anchor", () => {
  // The paren-run consumer used the same digit-requiring `AC\d+` spelling, so
  // `§X (suffix) AC line N` never consumed the run; `body` still began with `(`
  // and the section-only branch took the whole tail as descriptor text. The
  // line claim then vanished entirely — not verified, not reported.
  const { anchors, failures } = parseCitePayload(
    "Spec-002 §Channel Membership (channels) AC line 45",
  );
  assert.deepEqual(
    failures.map((f) => f.kind),
    [],
  );
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].type, "ac-line", "must not collapse to section-only");
  assert.equal(
    anchors[0].line,
    45,
    "the line claim must survive rather than becoming descriptor text",
  );
});

test("AC line N composes with sibling line sub-anchors under one Spec namespace", () => {
  // The live Plan-011 / Plan-014 marker shape: comma-joined line anchors with
  // a trailing `AC line N`, plus the `+`-combined AC pair.
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "Spec-002 line 10 (`InviteCreate` payload), line 15 (`ChannelList` projection), AC line 45 + AC line 46",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.equal(anchors.filter((a) => a.type === "line").length, 2);
  assert.deepEqual(
    anchors.filter((a) => a.type === "ac-line").map((a) => a.line),
    [45, 46],
  );
});

test("AC line N is not confused with the ordinal `ACn` form", () => {
  const ordinal = verifyAll("Spec-002 AC1 (line 45)");
  assert.equal(ordinal.anchors[0].type, "ac");
  assert.equal(ordinal.parseFailures.length, 0);
  assert.equal(ordinal.verifyFailures.length, 0);
});

// ============================================================
// Quote-aware tokenization (splitWithinNamespace + splitOnSemicolon)
// ============================================================
// Quoting the spec text a cite describes is the repo's preferred anchoring
// style. Before quote tracking, a comma or semicolon inside that quoted run
// sat at bracket depth 0 and was read as an anchor separator, shattering one
// cite into several unparseable fragments.

test("a quoted descriptor's internal comma does not shatter the cite (one anchor)", () => {
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    'Spec-002 line 45 - "joins active sessions, without resetting active runs"',
  );
  // Pre-fix this split into `line 45 - "joins active sessions` (an anchor with
  // a truncated descriptor) plus `without resetting active runs"` (an
  // unparseable fragment). The quoted run is now one token.
  assert.equal(parseFailures.length, 0, "the quoted comma must not create a fragment");
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].type, "line");
  assert.equal(anchors[0].line, 45);
  assert.equal(anchors[0].descriptor, '"joins active sessions, without resetting active runs"');
  assert.equal(verifyFailures.length, 0);
});

test("a quoted descriptor's internal semicolon does not open a new namespace segment", () => {
  // splitOnSemicolon symmetry: a depth-0 `;` inside quotes would otherwise
  // start a namespace-less segment and emit `unparseable-cite`.
  const { anchors, parseFailures } = verifyAll('Spec-002 line 45 - "accepted; not reset"');
  assert.equal(parseFailures.length, 0);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].descriptor, '"accepted; not reset"');
});

test("quote tracking keeps a multi-comma quoted sentence as ONE sub-token", () => {
  // Regression pin for the shatter case: the Plan-015 shape quoted a spec
  // sentence carrying four commas at bracket depth 0, which produced FIVE
  // fragments. It is now exactly one — still unparseable as an anchor (a
  // quoted sentence is not a sub-anchor shape), but no longer multiplied.
  const { parseFailures } = verifyAll(
    'Spec-002 "must include session events, queue state, approvals, runtime bindings, and command receipts"',
  );
  assert.equal(parseFailures.length, 1, "one fragment, not one per quoted comma");
  assert.equal(
    parseFailures[0].raw,
    '"must include session events, queue state, approvals, runtime bindings, and command receipts"',
  );
});

test("an UNBALANCED quote fails closed — collapses the tail, never a silent pass", () => {
  // Documented failure posture: the toggle stays open through end-of-payload,
  // so the tail buffers into one token that matches no sub-anchor shape. The
  // gate still fires, and the single forward pass cannot hang.
  const { anchors, parseFailures } = verifyAll('Spec-002 line 45, "unterminated, line 46');
  assert.ok(
    parseFailures.some((f) => f.severity !== "warn"),
    "an unbalanced quote must still produce a blocking failure",
  );
  assert.ok(
    !anchors.some((a) => a.line === 46),
    "the swallowed tail must NOT silently emit a line-46 anchor",
  );
});

test("an ASCII apostrophe is inert and never opens a quoted region", () => {
  // `don't` must not swallow the rest of the payload; the following comma is
  // still a live sub-anchor separator.
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "Spec-002 line 10 (the driver doesn't reset), line 15 (`ChannelList` projection)",
  );
  assert.equal(parseFailures.length, 0);
  assert.equal(verifyFailures.length, 0);
  assert.deepEqual(
    anchors.map((a) => a.line),
    [10, 15],
  );
});

// ============================================================
// Malformed quoted runs (`unbalanced-cite-quote`)
// ============================================================
// Quote tracking bought comma/semicolon protection inside a quoted spec
// sentence, and with it a new false-clean. ONE hole, TWO signatures — the
// checks are complementary and neither alone is sufficient:
//
//   1. ODD count. `"` is a single toggling delimiter with no escape form, so a
//      STRAY one stays open through end-of-payload and absorbs every separator
//      behind it. Caught by parity.
//   2. EVEN count STRADDLING a bracket. Both splitters toggle `inQuote` and
//      `continue` BEFORE consulting `bracketDelta`, so a `"` opened inside
//      `(...)` suppresses that group's `)`; depth never returns to 0 and the
//      next depth-0 separator is ignored. Parity is blind to it — the count is
//      even. Caught by the negative-local-depth signature.
//
// Either way the claims behind the quote are never extracted, so they are never
// verified, and the payload reports nothing — exactly the shape this gate
// exists to prevent. Parity between the quoted and unquoted spellings of the
// same text is the test for both.

test("an unbalanced quote absorbed as a DESCRIPTOR still gates (parity with unquoted)", () => {
  // The pre-existing unbalanced-quote test puts the tail in its own token, so
  // it fails as an unparseable sub-anchor and never exercised absorption. Here
  // the stray quote opens mid-descriptor and swallows the following separator
  // whole: without the parity guard this payload yields ONE anchor and ZERO
  // failures while the same text unquoted yields two anchors and gates on the
  // past-EOF line.
  const quoted = verifyAll('Spec-002 line 10 — "oops, line 99999 (`PresenceRead`)');
  assert.ok(
    quoted.parseFailures.some((f) => f.kind === "unbalanced-cite-quote"),
    `expected unbalanced-cite-quote, got ${quoted.parseFailures.map((f) => f.kind).join(", ") || "no failures"}`,
  );

  // Parity control: strip the stray quote and the second claim becomes visible
  // to the verifier, which gates on it. Either spelling must gate; the quoted
  // one must not be the quiet path.
  const unquoted = verifyAll("Spec-002 line 10 — oops, line 99999 (`PresenceRead`)");
  assert.equal(unquoted.parseFailures.length, 0);
  assert.equal(unquoted.verifyFailures.length, 1);
  assert.equal(unquoted.verifyFailures[0].result.reason, "line-out-of-range");
});

test("anchors AHEAD of a stray quote still parse — the guard gates without discarding", () => {
  const { anchors, parseFailures } = verifyAll(
    'Spec-002 line 10 (`InviteCreate`), line 15 — "oops',
  );
  assert.ok(parseFailures.some((f) => f.kind === "unbalanced-cite-quote"));
  assert.ok(
    anchors.some((a) => a.line === 10),
    "the legible anchor ahead of the stray quote must survive",
  );
});

test("a BALANCED quoted run does not trip the parity guard (negative control)", () => {
  // Proves the guard keys on parity, not on the mere presence of a quote —
  // otherwise it would break the very anchoring style quote tracking enabled.
  const { parseFailures, verifyFailures } = verifyAll(
    'Spec-002 line 10 ("session id, inviter, expiry")',
  );
  assert.deepEqual(
    parseFailures.map((f) => f.kind),
    [],
  );
  assert.equal(verifyFailures.length, 0);
});

test("an EVEN quote count straddling a bracket still gates (parity is blind to it)", () => {
  // Signature 2. The quote opens inside `(...)` and closes inside the NEXT
  // `(...)`, so the first group's `)` is consumed while `inQuote` and the
  // splitters' depth never returns to 0 — the `, ` separator is ignored and
  // both cites merge into one. The count is EVEN, so the parity check cannot
  // see this; without the depth signature the payload yields ONE anchor and
  // ZERO failures.
  const payload = 'Spec-002 AC1 ("a), AC7 (b")';
  assert.equal(
    (payload.split('"').length - 1) % 2,
    0,
    "fixture must carry an EVEN quote count or it proves nothing about parity blindness",
  );

  const quoted = verifyAll(payload);
  assert.ok(
    quoted.parseFailures.some((f) => f.kind === "unbalanced-cite-quote"),
    `expected unbalanced-cite-quote, got ${quoted.parseFailures.map((f) => f.kind).join(", ") || "no failures"}`,
  );
});

test("the realistic inch-mark straddle gates instead of dropping the second claim", () => {
  // The shape a plan author actually produces: `5"` and `30"` as inch/second
  // marks. Nothing looks quoted, the count is even, and the run nets back to
  // bracket depth 0 — which is why end-of-payload depth is the WRONG test. The
  // `line 99999` claim is silently discarded; unquoted, the verifier gates on
  // it. Either spelling must gate; the quoted one must not be the quiet path.
  const quoted = verifyAll('Spec-002 line 10 (5" heartbeat window), line 99999 (30" grace window)');
  assert.ok(
    quoted.parseFailures.some((f) => f.kind === "unbalanced-cite-quote"),
    `expected unbalanced-cite-quote, got ${quoted.parseFailures.map((f) => f.kind).join(", ") || "no failures"}`,
  );
  assert.ok(
    quoted.anchors.some((a) => a.line === 10),
    "the legible anchor ahead of the straddling quote must survive",
  );

  // Parity control: the same claims without the inch marks split into two
  // anchors and the past-EOF one is caught by the verifier.
  const unquoted = verifyAll("Spec-002 line 10 (heartbeat window), line 99999 (grace window)");
  assert.equal(unquoted.parseFailures.length, 0);
  assert.equal(unquoted.verifyFailures.length, 1);
  assert.equal(unquoted.verifyFailures[0].result.reason, "line-out-of-range");
});

test("a quoted run that opens a bracket but swallows NO separator is not flagged", () => {
  // The discriminator against an over-eager symmetric check, and the reason the
  // net-non-zero signature below is CONJOINED with "the run carried a
  // separator". Here the quoted run drives the local depth positive (`(` with
  // no `)`) and so ends net non-zero — but it contains no `,`/`;`/`+`, strands
  // no separator, and both anchors parse. A check keying on "local depth != 0
  // at close" ALONE, or on end-of-payload depth, would falsely flag this.
  // Dropping the runHasSeparator conjunct turns this test red.
  const { anchors, parseFailures } = verifyAll('Spec-002 line 10 ("foo (bar"), line 20');
  assert.deepEqual(
    parseFailures.map((f) => f.kind),
    [],
  );
  assert.deepEqual(
    anchors.map((a) => a.line),
    [10, 20],
    "a run that swallows no separator must leave BOTH claims extracted and verifiable",
  );
});

test("a nested opener inside the run does not hide the straddle", () => {
  // The hole the dip test alone left open. This run consumes a closer for a
  // group opened BEFORE it, but an opener inside the run keeps the running
  // local depth from ever going negative: `(` +1, `)` 0, `(` +1. The dip test
  // sees nothing, the quote count is even so parity sees nothing, and the
  // splitters emit ONE anchor for line 10 with ZERO failures — the `line 99999`
  // claim is silently discarded (Codex P2, PR #260 round 2). What catches it is
  // the second signature: the run ends net non-zero AND carried a separator.
  const quoted = verifyAll('Spec-002 line 10 (5" (window), line 99999 (30" grace)');
  assert.ok(
    quoted.parseFailures.some((f) => f.kind === "unbalanced-cite-quote"),
    `expected unbalanced-cite-quote, got ${quoted.parseFailures.map((f) => f.kind).join(", ") || "no failures"}`,
  );
});

test("brackets fully nested INSIDE a quoted run do not trip the depth signature", () => {
  // The local depth resets to 0 at each quote-open, so a balanced parenthetical
  // inside a quoted spec sentence goes +1 then back to 0 and never negative.
  // Without the reset, a quoted run following an earlier group would inherit a
  // stale depth and misfire on correct corpus idiom.
  const { parseFailures, verifyFailures } = verifyAll(
    'Spec-002 line 10 ("the daemon (local) pushes, then acks")',
  );
  assert.deepEqual(
    parseFailures.map((f) => f.kind),
    [],
  );
  assert.equal(verifyFailures.length, 0);
});

test("unbalanced-cite-quote is in NO demote/exempt allowlist — it gates on every path", () => {
  // All three classification sets are allowlists, so a kind absent from each
  // stays a hard error for every size class and every plan. Pinning the absence
  // keeps a future "add the new kind to the demote set" edit from silently
  // reopening the false-clean. (INLINE_SHAPE_PARSE_KINDS is module-private; the
  // gate-level test below covers that path behaviorally.)
  assert.equal(G4_GRAMMAR_DEMOTE_KINDS.has("unbalanced-cite-quote"), false);
  assert.equal(LEGACY_INLINE_EXEMPT_KINDS.has("unbalanced-cite-quote"), false);
});

test("gateTasksBlockCites halts on an unbalanced cite quote (size-class S, the demote path)", () => {
  // S is the size class that demotes grammar-shaped kinds to warnings, so a
  // halt here proves the kind is not riding that demotion.
  const sec = `#### Tasks

##### T9.1 — cite carrying a stray quote

- **Spec coverage:** Spec-002 line 10 — "oops, line 99999
- **Verifies invariant:** I-024-3
`;
  const r = gateTasksBlockCites(sec, 2, 9, { repoRoot: resolveFixtureRepoRoot() });
  assert.equal(r.ok, false);
  assert.match(r.halt, /unbalanced-cite-quote/);
  assert.match(r.halt, /T9\.1/);
});

// ============================================================
// §Section ↔ line containment
// ============================================================
// A cite naming BOTH a section and a line asserts the line sits under that
// heading. Verifying only that the heading EXISTS let the halves drift apart
// silently — Plan-015 T15.1 cited `§Two-Phase Receipt Commit lines 79-110`
// against a subsection starting at 81 and the armed gate passed it. Fixture
// spans (nested model: a heading runs until the next heading of level <= its
// own): `## Interfaces and Contracts` 8-42, `### Rate Limiting` 17-24,
// `### Rate Limit Response` 25-36, `### Token Security Properties` 37-42.

test("a line OUTSIDE its named section is rejected with line-outside-section", () => {
  // Line 39 is a Token Security Properties bullet, not a Rate Limiting row.
  const { verifyFailures } = verifyAll("Spec-002 §Rate Limiting line 39");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "line-outside-section");
  assert.match(verifyFailures[0].result.evidence, /section spans 17-24/);
});

test("a line RANGE starting above its named section is rejected (the T15.1 shape)", () => {
  // `lines 21-30` under a section that begins at 25 — the exact Plan-015 defect
  // shape, where the range straddles the heading it names.
  const { verifyFailures } = verifyAll("Spec-002 §Rate Limit Response lines 21-30");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "line-range-outside-section");
  assert.match(verifyFailures[0].result.evidence, /section spans 25-36/);
});

test("a line range spilling PAST its section's end is rejected", () => {
  const { verifyFailures } = verifyAll("Spec-002 §Rate Limiting lines 21-30");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "line-range-outside-section");
});

test("containment is NESTED — a line in a `###` child satisfies its `##` parent", () => {
  // The load-bearing model test. Under a FLAT model (section ends at the next
  // heading of ANY level) `## Interfaces and Contracts` would stop at line 16
  // and this correct cite would be rejected — the false-violation shape that
  // showed up on two real corpus cites during measurement.
  const { anchors, parseFailures, verifyFailures } = verifyAll(
    "Spec-002 §Interfaces and Contracts line 21",
  );
  assert.equal(parseFailures.length, 0);
  assert.deepEqual(
    verifyFailures.map((f) => f.result.reason),
    [],
  );
  assert.equal(anchors[0].line, 21);
});

test("a line range fully inside its named section stays VALID (negative control)", () => {
  const { verifyFailures } = verifyAll("Spec-002 §Rate Limit Response lines 28-33");
  assert.deepEqual(
    verifyFailures.map((f) => f.result.reason),
    [],
  );
});

test("an out-of-file line reports line-out-of-range, not line-outside-section", () => {
  // Ordering pin: containment is checked AFTER the range/blank guards so the
  // report names the more specific cause. A line past EOF is outside every
  // section too, and the less useful reason must not win.
  const { verifyFailures } = verifyAll("Spec-002 §Rate Limiting line 9999");
  assert.equal(verifyFailures.length, 1);
  assert.equal(verifyFailures[0].result.reason, "line-out-of-range");
});

test("a DUPLICATED section heading accepts a line under EITHER occurrence", () => {
  // findSectionHeading resolves to the FIRST match, so containment re-scans by
  // heading TEXT and collects every same-named span. Without that, a cite into
  // the second occurrence of a repeated heading would be a false violation.
  const root = mkdtempSync(resolve(tmpdir(), "preflight-dup-heading-"));
  const specsDir = resolve(root, "docs", "specs");
  mkdirSync(specsDir, { recursive: true });
  writeFileSync(
    resolve(specsDir, "077-dup-heading.md"),
    [
      "# Spec-077: duplicate headings", // 1
      "", // 2
      "## Retry Policy", // 3
      "", // 4
      "- first occurrence body", // 5
      "", // 6
      "## Unrelated", // 7
      "", // 8
      "- filler", // 9
      "", // 10
      "## Retry Policy", // 11
      "", // 12
      "- second occurrence body", // 13
      "", // 14
    ].join("\n"),
  );
  const opts = { specsDir, adrsDir: specsDir, archDocsDir: specsDir };

  const second = parseCitePayload("Spec-077 §Retry Policy line 13").anchors[0];
  assert.equal(verifyAnchorAgainstSpec(second, opts).valid, true);

  const first = parseCitePayload("Spec-077 §Retry Policy line 5").anchors[0];
  assert.equal(verifyAnchorAgainstSpec(first, opts).valid, true);

  // Negative control: line 9 sits under `## Unrelated`, between the two
  // occurrences — inside neither span, so it must still be rejected.
  const between = parseCitePayload("Spec-077 §Retry Policy line 9").anchors[0];
  const verdict = verifyAnchorAgainstSpec(between, opts);
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, "line-outside-section");
  assert.match(verdict.evidence, /section spans 3-6, 11-14/);
});

// ---------------------------------------------------------------------------
// Codex PR #262 round 5 — the cite content boundary and the empty-payload skip.
// ---------------------------------------------------------------------------

test("maskInlineCodeSpans blanks span interiors and preserves byte length", () => {
  const line = "Write `**Spec coverage:** Spec-1 §A` in the block.";
  const masked = maskInlineCodeSpans(line);
  assert.equal(masked.length, line.length, "length must be preserved — offsets are load-bearing");
  assert.ok(!masked.includes("Spec coverage"), "span interior was not blanked");
  assert.ok(masked.startsWith("Write `"), "the opening delimiter must survive");
  assert.ok(masked.endsWith("` in the block."), "text after the span must survive");
});

test("maskInlineCodeSpans leaves unbalanced and mismatched backtick runs alone", () => {
  const lone = "a lone ` backtick with **Spec coverage:** after it";
  assert.equal(maskInlineCodeSpans(lone), lone, "an unpaired run is prose, not a span");
  const mismatched = "``double open with **Spec coverage:** and ` single close";
  assert.equal(maskInlineCodeSpans(mismatched), mismatched, "runs must be equal length to pair");
});

test("maskInlineCodeSpans masks a double-backtick span wrapping literal backticks (2/1/1/2)", () => {
  // The canonical CommonMark idiom for showing code that itself contains a
  // backtick. Runs are [2, 1, 1, 2]: the len-2 closer sits two runs away, so
  // positional pairing rejects (2,1) and (1,2) on length and the illustrated
  // marker inside counts as audit output (Codex P2, PR #262 round 6).
  const line = "An outer span: `` `**Spec coverage:** Spec-999 §Missing` `` illustrates the form.";
  const masked = maskInlineCodeSpans(line);
  assert.equal(masked.length, line.length, "length must be preserved — offsets are load-bearing");
  assert.ok(!masked.includes("Spec coverage"), "the wrapped illustration must be blanked");
  const { anchors, failures } = extractCiteAnchors(`${line}\n`);
  assert.equal(anchors.length, 0, "an illustrated marker must not be extracted");
  assert.equal(failures.length, 0, "an illustration is not a defect either");
});

test("survey denominator and unit gates share one content boundary", () => {
  // The complement's ONLY marker-shaped text is an inline-code illustration.
  // Counting the denominator through a laxer mask than the unit gates let the
  // survey report that marker as "screened via the complement path" while the
  // same plan sat in `markerlessPlans` as having nothing to verify — two
  // censuses, one marker, contradictory verdicts (Codex P2, PR #262 round 6).
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), "preflight-census-"));
  const planDir = resolve(fixtureRoot, "docs", "plans");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(
    resolve(planDir, "101-census-fixture.md"),
    [
      "# Plan-101 census fixture",
      "",
      "Authoring guidance: write `**Spec coverage:** Spec-001 §Goals` on each task row.",
      "",
      "### Phase 1 — No markers",
      "",
      "#### Tasks",
      "",
      "- **T-101-1.1** — A row with no cite markers.",
      "",
    ].join("\n"),
  );
  const survey = surveyCorpus({ repoRoot: fixtureRoot });
  assert.deepEqual(
    survey.complementMarkerPlans,
    [],
    "an illustrated marker must not enter the complement-screened denominator",
  );
  assert.ok(
    survey.markerlessPlans.includes("101-census-fixture.md"),
    "the one honest census entry is markerless — swept, nothing to verify",
  );
  assert.deepEqual(
    survey.uncoveredPlans ?? [],
    [],
    "the fixture must be swept, or the census assertions above are vacuous",
  );
});

test("maskInlineCodeSpans honors escaped backticks — escaped runs never open a span", () => {
  // CommonMark: `\`` is a literal backtick, so a REAL marker wrapped in escaped
  // backticks is prose, not a code span. Pairing the escaped runs blanked the
  // marker out of every counter and let the survey pass without verifying its
  // anchor (Codex P2, PR #262 round 7).
  const doc = "- **T1.1 — Row.** \\`**Spec coverage:** Spec-002 AC1\\` escaped rendering.\n";
  assert.equal(maskInlineCodeSpans(doc), doc, "escaped backticks must not pair");
  assert.equal(countCites(doc).spec_coverage, 1, "the real marker must still count");
  // The stray `\`` in the payload keeps this from parsing as a clean anchor —
  // fine. The invariant is VISIBILITY: the gate extracts it or flags it, and
  // under escape-blind pairing it did neither (marker blanked, 0 + 0).
  const { anchors, failures } = extractCiteAnchors(doc);
  assert.ok(
    anchors.length + failures.length >= 1,
    "the marker must be visible to the gate — extracted or flagged, never vanished",
  );
});

test("maskInlineCodeSpans does not escape-check closers — no escapes inside spans", () => {
  // CommonMark: backslash escapes do not work inside code spans, so in
  // `code\` the trailing backtick CLOSES the span even though a backslash
  // precedes it; the backslash is span content and is blanked with it.
  const line = "Span: `code\\` then **Spec coverage:** outside.";
  const masked = maskInlineCodeSpans(line);
  assert.equal(masked.length, line.length, "length must be preserved — offsets are load-bearing");
  assert.ok(!masked.includes("code"), "the span interior including the backslash must be blanked");
  assert.ok(masked.includes("**Spec coverage:**"), "prose after the closer must survive");
});

test("maskInlineCodeSpans finds a closer past an unmatched run (no positional pairing)", () => {
  // Runs are [2, 1, 1]. Pairing off two at a time compares (2,1), skips BOTH on
  // the length mismatch, and leaves the REAL span at (1,2) unmasked — so its
  // marker counts as audit output. Forward search pairs (1,2) correctly.
  const line = "Use `` for empty, and `**Spec coverage:** Spec-1 §A` here.";
  const masked = maskInlineCodeSpans(line);
  assert.equal(masked.length, line.length, "length must be preserved — offsets are load-bearing");
  assert.ok(!masked.includes("Spec coverage"), "the span after the unmatched run must be blanked");
  assert.ok(masked.startsWith("Use `` for empty, and `"), "text before the span must survive");
  assert.equal(
    classifyPhaseMarkers(`### Phase 1 — X\n\n${line}\n`).boldSpec,
    0,
    "the relaxed floor must not count a marker the mask should have removed",
  );
});

test("a marker inside a same-line code span is neither extracted nor counted", () => {
  const illustrated = "Prose showing the form: `**Spec coverage:** Spec-999 §Nope` inline.\n";
  const { anchors, failures } = extractCiteAnchors(illustrated);
  assert.equal(anchors.length, 0, "an illustrated marker must not be extracted");
  assert.equal(failures.length, 0, "an illustration is not a defect either");
  assert.equal(countCites(illustrated).spec_coverage, 0, "the strict floor must not count it");
  assert.equal(
    classifyPhaseMarkers(illustrated).boldSpec,
    0,
    "the relaxed floor must not count it",
  );
});

test("NEGATIVE CONTROL: a real marker whose payload contains inline code keeps it intact", () => {
  // The regression this pins was live for one edit: masking the bytes a payload
  // is sliced from blanked backticked identifiers inside `(descriptor)` tails.
  // 196 live anchors carry one. `raw` is not cosmetic — demotionKeepsExistenceFloor
  // greps it for `Spec-NNN`, so a blanked cite silently leaves that floor.
  const real = "- **T1.1** **Spec coverage:** Spec-001 §Goals (`SessionSchema` shape)\n";
  const { anchors } = extractCiteAnchors(real);
  assert.equal(anchors.length, 1, "the real marker must still be extracted");
  assert.ok(
    anchors[0].raw.includes("`SessionSchema`"),
    `payload lost its backticked identifier: ${anchors[0].raw}`,
  );
  assert.equal(anchors[0].section, "Goals", "the section anchor must be unaffected");
});

test("an empty-payload bold marker is a finding, not a silent skip", () => {
  const emptyPayload = "#### Tasks\n\n- **T1.1 — Row.** **Spec coverage:**\n";
  const { anchors, failures } = extractCiteAnchors(emptyPayload);
  assert.equal(anchors.length, 0, "there is no cite to extract");
  assert.equal(failures.length, 1, "but the marker must not vanish silently");
  assert.equal(failures[0].kind, "empty-cite-payload");
  assert.equal(failures[0].field, "Spec coverage");
  assert.equal(failures[0].taskId, "T1.1", "the finding must attribute to the enclosing row");
  assert.equal(failures[0].severity, "error");
});

test("NEGATIVE CONTROL: the same marker WITH a payload produces no empty-payload finding", () => {
  const withPayload = "#### Tasks\n\n- **T1.1 — Row.** **Spec coverage:** Spec-001 §Goals\n";
  const { anchors, failures } = extractCiteAnchors(withPayload);
  assert.equal(anchors.length, 1);
  assert.equal(
    failures.filter((f) => f.kind === "empty-cite-payload").length,
    0,
    "a populated marker must not trip the empty-payload screen",
  );
});

test("empty-cite-payload stays HARD for S/M — it is not in the demote set", () => {
  assert.ok(
    !G4_GRAMMAR_DEMOTE_KINDS.has("empty-cite-payload"),
    "demoting this kind reopens the false clean for the least-reviewed size classes",
  );
});

test("a complement whose only marker has an empty payload no longer reports clean", () => {
  // The exact CAT-10 shape: floor admits the marker, extractor produced nothing,
  // and the unit returned {ok: true, hasCiteMarkers: true, findings: []}.
  const complement = "Some narrative.\n\n- **T9.1 — Row.** **Spec coverage:**\n";
  const result = gateTasksBlockCites(complement, "025", 1, {
    repoRoot: resolveFixtureRepoRoot(),
    requireBothMarkers: false,
  });
  assert.equal(result.hasCiteMarkers, true, "the marker IS present — this is not the missing case");
  assert.equal(result.ok, false, "a marker that verified nothing must not pass");
  assert.ok(
    result.findings.some((f) => f.kind === "empty-cite-payload"),
    "the verdict must name why it failed",
  );
});

test("INTERACTION: illustrated marker + empty-payload marker yields exactly one finding", () => {
  // Ordering guard. The two round-5 fixes touch the same path in opposite
  // directions: the content boundary REMOVES illustrated markers, the
  // empty-payload screen ADDS findings for admitted ones. Applied in the wrong
  // order the illustration itself is flagged — a false positive replacing a
  // false clean, and neither single-fix test above can catch it because each
  // exercises only one shape.
  const both = [
    "Narrative that documents the form: `**Spec coverage:** Spec-999 §Nope`.",
    "",
    "- **T9.1 — Real row.** **Spec coverage:**",
    "",
  ].join("\n");
  const { anchors, failures } = extractCiteAnchors(both);
  assert.equal(anchors.length, 0, "the illustration must not be extracted");
  assert.equal(failures.length, 1, `expected exactly one finding, got ${failures.length}`);
  assert.equal(failures[0].kind, "empty-cite-payload");
  assert.equal(
    failures[0].taskId,
    "T9.1",
    "the finding must name the REAL row, not the illustration",
  );
});

// ---------- Invariant-reference resolution ----------
//
// Gate 4 minted a `plan-local-id` anchor for every `**Verifies invariant:**` id
// and passed it on the grounds that a plan-local id has "no external document to
// verify". True for `C5`/`P3`; false for `I-024-4`, which names Plan-024 in its
// own bytes. These cover the resolution that premise was skipping.

// A tmp repoRoot whose docs/plans holds exactly the given `NNN-name.md` sources.
function makeInvariantRepoRoot(plans) {
  const root = mkdtempSync(resolve(tmpdir(), "preflight-invariants-"));
  const plansDir = resolve(root, "docs", "plans");
  mkdirSync(plansDir, { recursive: true });
  for (const [name, body] of Object.entries(plans)) {
    writeFileSync(resolve(plansDir, name), body);
  }
  return root;
}

const marker = (payload) => `- **T1.1 — x.** **Verifies invariant:** ${payload}`;

// The legacy compact-inline spelling — the ONLY form Plan-008 and Plan-023 use.
// `extractCiteAnchors` cannot see it, which is how 58 references reached no
// screen while the gate printed a clean total.
const inlineMarker = (payload, taskId = "T-100r-1-1") =>
  `- **${taskId}** (Files: \`x.ts\` (CREATE); Verifies invariant: ${payload}; Spec coverage: \`Spec-100 §Interfaces And Contracts\`) — Do the thing.`;

test("declaration extractor reads all four corpus spellings", () => {
  const { ids, hasBlock } = extractDeclaredInvariantIds(
    [
      "## Invariants",
      "",
      "### I-100-1 — heading form",
      "",
      "- **I-100-2 — bullet+bold form**",
      "",
      "| ID | What |",
      "| --- | --- |",
      "| I-100-3 | plain table row |",
      "| **I-100-4** | bolded table row |",
      "",
      "## Next Section",
      "### I-100-99 — outside the block, must NOT be declared",
    ].join("\n"),
  );
  assert.equal(hasBlock, true);
  assert.deepEqual(ids, ["I-100-1", "I-100-2", "I-100-3", "I-100-4"]);
});

test("declaration extractor distinguishes NO block from an UNPARSED block", () => {
  // The two zero-cases must not resolve the same way: an absent block declares
  // nothing, an unreadable one means the extractor failed. Collapsing them to
  // `[]` would report every reference to the plan as undeclared, burying one
  // extractor defect under a flood of findings against innocent lines.
  const absent = extractDeclaredInvariantIds("## Overview\n\nNo invariants here.\n");
  assert.deepEqual(absent, { ids: [], hasBlock: false });

  const unparsed = extractDeclaredInvariantIds(
    "## Invariants\n\nProse only — mentions I-100-1 but declares nothing structurally.\n",
  );
  assert.equal(unparsed.hasBlock, true);
  assert.deepEqual(unparsed.ids, []);
});

test("a `### I-NNN-M` declaration does not terminate its own `## Invariants` block", () => {
  // Nested bound: the block runs to the next SAME-OR-HIGHER heading. A strict
  // "next heading of any level" reading would end the block at the first
  // declaration and silently declare exactly one id.
  const { ids } = extractDeclaredInvariantIds(
    "## Invariants\n\n### I-100-1 — first\n\n### I-100-2 — second\n\n### I-100-3 — third\n",
  );
  assert.deepEqual(ids, ["I-100-1", "I-100-2", "I-100-3"]);
});

test("references resolve within a plan and ACROSS plans", () => {
  const root = makeInvariantRepoRoot({
    "100-a.md": "## Invariants\n\n### I-100-1 — a\n",
    "101-b.md": "## Invariants\n\n### I-101-1 — b\n",
  });
  const r = verifyInvariantReferences(marker("I-100-1, I-101-1"), { repoRoot: root });
  assert.deepEqual(r.findings, []);
  assert.equal(r.bold.resolved, 2);
  assert.equal(r.legacy.resolved, 0);
});

test("an undeclared id fires, and names the declaring set", () => {
  const root = makeInvariantRepoRoot({ "100-a.md": "## Invariants\n\n### I-100-1 — a\n" });
  const r = verifyInvariantReferences(marker("I-100-9"), { repoRoot: root });
  assert.equal(r.bold.resolved, 0);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, "invariant-undeclared");
  assert.match(r.findings[0].evidence, /I-100-1/);
});

test("an id naming a nonexistent plan fires plan-not-found", () => {
  const root = makeInvariantRepoRoot({ "100-a.md": "## Invariants\n\n### I-100-1 — a\n" });
  const r = verifyInvariantReferences(marker("I-777-1"), { repoRoot: root });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, "invariant-plan-not-found");
});

test("a TEST id is named as a test id, not as an undeclared invariant", () => {
  // Plan-001:393/:709 spelled `I5` — a declared INTEGRATION TEST row from
  // `## Test And Verification Plan`, not a dangling pointer. Calling it
  // "undeclared invariant" sends the next author hunting for a declaration that
  // should never exist, and the obvious way to silence that is to mint a fake
  // invariant id. The message has to name the namespace collision instead.
  const root = makeInvariantRepoRoot({ "100-a.md": "## Invariants\n\n### I-100-1 — a\n" });
  const r = verifyInvariantReferences(marker("I5"), { repoRoot: root });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, "invariant-test-id");
  assert.match(r.findings[0].evidence, /looks like a test id, not an invariant id/);
  assert.doesNotMatch(r.findings[0].evidence, /undeclared/);
});

test("`none` is counted on its own arm, and a test id in its DESCRIPTOR does not fire", () => {
  // The live negative fixture: Plan-003:517 and :525 spell
  // `none (I1 is an AC-coverage test — no Plan-003 invariant exclusively
  // verified here)`. The value is `none`; the test id sits in the parenthetical.
  // A line-scoped net flags these; the gate must key on the VALUE.
  const root = makeInvariantRepoRoot({ "100-a.md": "## Invariants\n\n### I-100-1 — a\n" });
  const r = verifyInvariantReferences(
    marker("none (I1 is an AC-coverage test — no Plan-100 invariant exclusively verified here)"),
    { repoRoot: root },
  );
  assert.deepEqual(r.findings, []);
  assert.equal(r.bold.noneArm, 1);
  assert.equal(r.bold.resolved, 0);
});

test("plan-local ids that name no owning document are silent", () => {
  const root = makeInvariantRepoRoot({ "100-a.md": "## Invariants\n\n### I-100-1 — a\n" });
  const r = verifyInvariantReferences(marker("C5, P3"), { repoRoot: root });
  assert.deepEqual(r.findings, []);
  assert.equal(r.bold.resolved, 0);
});

test("a FENCED marker is not resolved (masking is preserved)", () => {
  const root = makeInvariantRepoRoot({ "100-a.md": "## Invariants\n\n### I-100-1 — a\n" });
  const fenced = "```\n" + marker("I-100-9") + "\n```";
  const r = verifyInvariantReferences(fenced, { repoRoot: root });
  assert.deepEqual(r.findings, []);
  assert.equal(r.bold.resolved, 0);
});

test("a structural failure is reported ONCE per plan, not once per reference", () => {
  const root = makeInvariantRepoRoot({
    "100-a.md": "## Invariants\n\nProse only, nothing structural.\n",
  });
  const section = [marker("I-100-1"), marker("I-100-2"), marker("I-100-3")].join("\n\n");
  const r = verifyInvariantReferences(section, { repoRoot: root });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, "invariant-block-unparsed");
});

test("a plan with no Invariants block at all is distinguished from an unparsed one", () => {
  const root = makeInvariantRepoRoot({ "100-a.md": "## Overview\n\nNothing.\n" });
  const r = verifyInvariantReferences(marker("I-100-1"), { repoRoot: root });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, "invariant-block-absent");
});

test("CORPUS ORACLE: every invariant reference in docs/plans resolves, with a floor", () => {
  // Non-vacuity floor first — a zero denominator would make the clean verdict
  // below meaningless, which is the failure mode this whole screen exists to
  // close. The floor is deliberately well under the live count (574) so ordinary
  // corpus churn does not trip it, but a screen that stops running does.
  const plansDir = resolve(REPO_ROOT_FOR_TESTS, "docs", "plans");
  const cache = new Map();
  let boldTotal = 0;
  let legacyTotal = 0;
  const findings = [];
  for (const name of readdirSync(plansDir).filter(
    (n) => /^\d{3}-.+\.md$/.test(n) && !n.startsWith("000-"),
  )) {
    const r = verifyInvariantReferences(readFileSync(resolve(plansDir, name), "utf8"), { cache });
    boldTotal += r.bold.resolved;
    legacyTotal += r.legacy.resolved;
    for (const f of r.findings) findings.push(`${name} [${f.kind}] ${f.evidence}`);
  }
  assert.ok(
    boldTotal > 400,
    `expected the corpus to resolve >400 BOLD invariant references, got ${boldTotal} — the screen is not running`,
  );
  // A SEPARATE floor for the legacy channel, and this is the load-bearing one.
  // A single combined floor is exactly what let the legacy channel sit at zero
  // undetected: 574 bold references sailed over any plausible total-floor while
  // Plan-008's entire contribution was missing. Each channel must prove it ran.
  assert.ok(
    legacyTotal > 40,
    `expected the corpus to resolve >40 LEGACY compact-inline invariant references, got ${legacyTotal} — the legacy channel is not running (this is how Plan-008 went unscreened)`,
  );
  // Asserted STRICT, with no known-defect allowlist. The corpus holds exactly
  // one violation today — `I5` at Plan-001 T5.3, a declared integration-test id
  // in an invariant field — and the repair is one line the line itself already
  // spells in two other fields (`I-024-4`). Allowlisting it would build
  // scaffolding around a one-line fix, and an allowlist that keeps a new
  // screen's first real finding from turning anything red is the same
  // report-clean-over-real-debt shape this screen was written to close.
  assert.deepEqual(findings, [], `unresolved invariant references:\n${findings.join("\n")}`);
});

test("CORPUS ORACLE negative control: perturbing a real id makes the oracle fail", () => {
  // Proves the oracle above can fail. Without this, a resolver that silently
  // returned no findings would pass it forever.
  const plansDir = resolve(REPO_ROOT_FOR_TESTS, "docs", "plans");
  const real = readFileSync(
    resolve(plansDir, "006-session-event-taxonomy-and-audit-log.md"),
    "utf8",
  );
  const perturbed = real.replace(
    /\*\*Verifies invariant:\*\* I-006-/,
    "**Verifies invariant:** I-006-99999-",
  );
  assert.notEqual(perturbed, real, "perturbation did not apply — the fixture shape moved");
  const r = verifyInvariantReferences(perturbed, { cache: new Map() });
  assert.ok(
    r.findings.some((f) => f.kind === "invariant-undeclared"),
    "perturbed corpus produced no undeclared finding — the oracle cannot fail",
  );
});

// ---------- Second marker channel: legacy compact-inline ----------

test("legacy compact-inline markers resolve, on their OWN channel", () => {
  const root = makeInvariantRepoRoot({ "100-a.md": "## Invariants\n\n### I-100-1 — a\n" });
  const r = verifyInvariantReferences(inlineMarker("I-100-1"), { repoRoot: root });
  assert.deepEqual(r.findings, []);
  assert.equal(r.legacy.resolved, 1);
  assert.equal(r.bold.resolved, 0, "a compact-inline marker must not be counted as bold");
});

test("an undeclared id in a legacy marker fires, attributed to its task", () => {
  const root = makeInvariantRepoRoot({ "100-a.md": "## Invariants\n\n### I-100-1 — a\n" });
  const r = verifyInvariantReferences(inlineMarker("I-100-9", "T-100r-2-3"), { repoRoot: root });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, "invariant-undeclared");
  // Attribution is derived from an INCLUSIVE line slice: the compact-inline
  // shape puts the task header and the field on ONE line, so an exclusive slice
  // would name the previous task — the mis-attribution class the round-2
  // `taskHeaderMatches` fix closed on the bold path.
  assert.match(r.findings[0].evidence, /^T-100r-2-3: /);
});

test("the two channels are DISJOINT — a section holding both counts each once", () => {
  // The disjointness argument is a reading of two regexes (`(?!\*)` plus a
  // lead-in the bold form never presents). That is the shape of reasoning that
  // has been wrong twice on this surface, so it is asserted rather than argued.
  const root = makeInvariantRepoRoot({ "100-a.md": "## Invariants\n\n### I-100-1 — a\n" });
  const both = [marker("I-100-1"), "", inlineMarker("I-100-1")].join("\n");
  const r = verifyInvariantReferences(both, { repoRoot: root });
  assert.deepEqual(r.findings, []);
  assert.equal(r.bold.resolved, 1, "bold marker double-counted or missed");
  assert.equal(r.legacy.resolved, 1, "inline marker double-counted or missed");
});

test("`none` on a legacy marker lands on the legacy none arm", () => {
  const root = makeInvariantRepoRoot({ "100-a.md": "## Invariants\n\n### I-100-1 — a\n" });
  const r = verifyInvariantReferences(inlineMarker("none"), { repoRoot: root });
  assert.deepEqual(r.findings, []);
  assert.equal(r.legacy.noneArm, 1);
  assert.equal(r.bold.noneArm, 0);
});

// ---------- Facet roll-up ----------

test("facetBaseId strips a sub-clause letter, and ONLY that", () => {
  assert.equal(facetBaseId("I-008-7c"), "I-008-7");
  assert.equal(facetBaseId("I-008-12d"), "I-008-12");
  assert.equal(facetBaseId("I-006-4-01a"), "I-006-4-01");
  // The `.raw` a failure carries is a SEGMENT, not a bare token — the trailing
  // descriptor must not defeat the match.
  assert.equal(facetBaseId("I-008-7c (substrate - the rows correlate)"), "I-008-7");
  assert.equal(facetBaseId("  I-008-7c  "), "I-008-7");
});

test("facetBaseId returns null for every NON-facet shape", () => {
  // These negatives cannot be drawn from the corpus: today every
  // `plan-local-id-unparseable` in an invariant field IS a facet (measured:
  // zero non-facet instances), so a wrong null arm would fire on nothing and
  // look correct forever. A roll-up that fired on one of these would mint a
  // resolution out of text nobody checked.
  for (const notAFacet of [
    "I-008-7", // already a clean id — no letter to strip
    "I-008-7cc", // two letters is not the facet shape
    "I-008-7-c", // hyphenated, not a suffix
    "I-008-7c-1", // letter mid-id, not terminal
    "I-008-7class", // word, not a sub-clause letter
    "C5", // plan-local, different namespace
    "Pr-3.5",
    "I5", // test id
    "not an id at all",
    "",
  ]) {
    assert.equal(facetBaseId(notAFacet), null, `expected null for ${JSON.stringify(notAFacet)}`);
  }
});

test("a facet reference rolls up to its declared PARENT and is counted as parent-only", () => {
  const root = makeInvariantRepoRoot({ "100-a.md": "## Invariants\n\n### I-100-7 — parent\n" });
  const r = verifyInvariantReferences(inlineMarker("I-100-7c"), { repoRoot: root });
  assert.deepEqual(r.findings, []);
  assert.equal(r.legacy.resolved, 1);
  // Counted separately because it is a WEAKER claim wearing the same word: the
  // parent is declared, the sub-clause letter is declared nowhere and so is not
  // verified by anything. `I-100-7z` would resolve identically.
  assert.equal(r.legacy.parentResolved, 1);
});

test("a facet whose PARENT is undeclared fires, naming what the author wrote", () => {
  const root = makeInvariantRepoRoot({ "100-a.md": "## Invariants\n\n### I-100-1 — a\n" });
  const r = verifyInvariantReferences(inlineMarker("I-100-7c"), { repoRoot: root });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, "invariant-undeclared");
  // The message must name the facet the author actually typed, and disclose the
  // roll-up — pointing only at a base they never wrote sends them hunting.
  assert.match(r.findings[0].evidence, /I-100-7c/);
  assert.match(r.findings[0].evidence, /rolled up to parent/);
});

test("the roll-up is INERT on the parent's own honest spelling", () => {
  // `I-008-7 (a/b/c)` — base plus descriptor — parses to a clean anchor and must
  // resolve on the ordinary path, contributing nothing to the parent-only count.
  const root = makeInvariantRepoRoot({ "100-a.md": "## Invariants\n\n### I-100-7 — parent\n" });
  const r = verifyInvariantReferences(inlineMarker("I-100-7 (a/b/c)"), { repoRoot: root });
  assert.deepEqual(r.findings, []);
  assert.equal(r.legacy.resolved, 1);
  assert.equal(r.legacy.parentResolved, 0);
});

test("CORPUS: Plan-008 is screened — the plan that had ZERO bold markers", () => {
  // The regression guard for the coverage hole itself. Plan-008 carries 41
  // compact-inline markers and no bold ones; before the legacy channel existed
  // it contributed 0 resolved references while the gate printed a clean total.
  const plan008 = readFileSync(
    resolve(REPO_ROOT_FOR_TESTS, "docs", "plans", "008-control-plane-relay-and-session-join.md"),
    "utf8",
  );
  const r = verifyInvariantReferences(plan008, { cache: new Map() });
  assert.equal(r.bold.resolved, 0, "Plan-008 has no bold markers — if this moved, the fixture did");
  assert.ok(
    r.legacy.resolved > 50,
    `Plan-008 must resolve >50 references on the legacy channel, got ${r.legacy.resolved}`,
  );
  assert.deepEqual(r.findings, []);
  // Pins the facet roll-up to its ONLY live instance in the corpus: `I-008-7c`
  // at Plan-008 task T-008r-1-4. Without this the roll-up rots SILENTLY, and measurably so:
  // degrade that one token to its base and `parentResolved` goes 1 → 0 while
  // `legacy.resolved` stays at 58 and `findings` stays empty — because the base
  // id still resolves, it is simply no longer a facet. Every other assertion in
  // this test stays green. The roll-up becomes dead code reporting success, and
  // this line is the only thing that notices.
  //
  // Concretely load-bearing against content masking: `consumeFailure` reads
  // `failure.raw`, so the roll-up REQUIRES raw to carry unmasked payload bytes.
  // T-008r-1-4's payload is backticked (`relay_connections`), one of 8 such among the
  // 48 legacy payloads. The ids there precede the first backtick, so masking
  // code spans should not reach them — this assertion is what proves that
  // holds rather than assuming it.
  assert.equal(
    r.legacy.parentResolved,
    1,
    `Plan-008 must roll up exactly one facet (I-008-7c), got ${r.legacy.parentResolved} — if 0, check that failure.raw still carries unmasked bytes`,
  );
});

test("CORPUS negative control: perturbing a real LEGACY marker makes Plan-008 fail", () => {
  // The test above asserts a CLEAN result on real corpus text, and a clean
  // result is worth exactly what the checker's failure mode is worth. The
  // bold-channel oracle has its own negative control at "CORPUS ORACLE negative
  // control" above; this is the legacy channel's, and it is not redundant with
  // the synthetic one. The synthetic control feeds `inlineMarker()`, whose shape
  // I chose; Plan-008 writes the field unbolded, inside a parenthetical, after a
  // task-header lead-in. Proving the screen fires on MY shape does not prove it
  // fires on the corpus's — that gap is how the original coverage hole survived.
  const plan008 = readFileSync(
    resolve(REPO_ROOT_FOR_TESTS, "docs", "plans", "008-control-plane-relay-and-session-join.md"),
    "utf8",
  );
  const perturbed = plan008.replace(
    /Verifies invariant: I-008-/,
    "Verifies invariant: I-008-99999-",
  );
  assert.notEqual(perturbed, plan008, "perturbation did not apply — the fixture shape moved");
  const r = verifyInvariantReferences(perturbed, { cache: new Map() });
  assert.ok(
    r.findings.some((f) => f.kind === "invariant-undeclared"),
    "perturbed Plan-008 produced no undeclared finding — the legacy screen cannot fail",
  );
  assert.equal(r.bold.resolved, 0, "the finding must have come through the legacy channel");
});

// ---------- Range references (`I-NNN-A..B`) ----------
//
// `parsePlanLocalIdSegment` has always minted a `plan-local-id` for a range
// token and the resolver's owning-id regex has always rejected it, so
// `I-024-999..1000` reached the screen, matched nothing, and returned in
// silence — zero findings on an armed survey, for a citation of two invariants
// that do not exist. A supported parser spelling met an unsupported resolver
// shape and nothing spoke in between.
//
// The corpus writes NO ranges today (233 distinct ids across every `Verifies
// invariant` field, all owning-shaped), so these tests are direct evidence about
// the MECHANISM. No corpus-impact claim is made because none is available.

test("classifyInvariantReference sorts every reference shape into its own arm", () => {
  // Table-driven because the three arms are mutually exclusive by construction
  // and the interesting failures are CROSSINGS — a malformed id read as
  // plan-local goes silent (the defect this closes), and a plan-local id read as
  // malformed fires on `C5`/`Pr-3`, which name no owning document and never
  // could resolve.
  const kindOf = (id) => classifyInvariantReference(id).kind;

  assert.deepEqual(classifyInvariantReference("I-024-4"), { kind: "members", ids: ["I-024-4"] });
  assert.deepEqual(classifyInvariantReference("I-024-1..3").ids, ["I-024-1", "I-024-2", "I-024-3"]);
  // The last segment is the range; earlier segments ride along verbatim, and the
  // START endpoint's width sets the padding — `01..04` must not expand to `1`.
  assert.deepEqual(classifyInvariantReference("I-006-2-01..04").ids, [
    "I-006-2-01",
    "I-006-2-02",
    "I-006-2-03",
    "I-006-2-04",
  ]);

  for (const planLocal of ["I-1", "I5", "I5..7", "C5", "P3", "Pr-3"]) {
    assert.equal(kindOf(planLocal), "plan-local", `${planLocal} must stay on the plan-local arm`);
  }
  for (const malformed of ["I-24-3", "I-008-", "I-024..025-1", "I-024-9..2", "I-024-1..999"]) {
    assert.equal(kindOf(malformed), "malformed", `${malformed} must fail closed, not go silent`);
  }

  // The ceiling is a real boundary, so both sides of it are pinned. A one-sided
  // assertion passes on a ceiling of 1 and on no ceiling at all.
  assert.equal(classifyInvariantReference("I-024-1..64").ids.length, 64);
  assert.equal(kindOf("I-024-1..65"), "malformed");
});

test("a fully declared range is ONE resolved reference, not one per member", () => {
  // THE UNIT OF COUNT IS THE REFERENCE. `575 resolved` means 575 citations were
  // checked; counting members instead would move the published census whenever a
  // plan respelled a list as a range — a number that changed while the corpus
  // did not.
  const root = makeInvariantRepoRoot({
    "100-a.md": "## Invariants\n\n### I-100-1 — a\n### I-100-2 — b\n### I-100-3 — c\n",
  });
  const r = verifyInvariantReferences(marker("I-100-1..3"), { repoRoot: root });
  assert.deepEqual(r.findings, []);
  assert.equal(r.bold.resolved, 1, "a 3-member range must count as ONE resolved reference");
});

test("an undeclared range member fires, naming the member AND what was written", () => {
  const root = makeInvariantRepoRoot({
    "100-a.md": "## Invariants\n\n### I-100-1 — a\n### I-100-2 — b\n",
  });
  const r = verifyInvariantReferences(marker("I-100-1..3"), { repoRoot: root });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, "invariant-undeclared");
  // Both halves matter: the author has to find the token they typed, and the
  // reader has to learn WHICH member of it is undeclared.
  assert.match(r.findings[0].evidence, /`I-100-1\.\.3`/);
  assert.match(r.findings[0].evidence, /range member `I-100-3`/);
  assert.equal(r.bold.resolved, 0, "a partially declared range is not a partial resolution");
});

test("REGRESSION: the range that passed an armed survey now reports every member", () => {
  // `I-024-999..1000` verbatim — the reproduction from the finding. Before this
  // change it produced `findings: []` and `resolved: 0`: a citation of nothing,
  // accepted by a gate whose whole purpose is to reject citations of nothing.
  const root = makeInvariantRepoRoot({ "024-a.md": "## Invariants\n\n### I-024-1 — a\n" });
  const r = verifyInvariantReferences(marker("I-024-999..1000"), { repoRoot: root });
  assert.equal(r.findings.length, 2, "each undeclared member reports on its own");
  assert.deepEqual(
    r.findings.map((f) => f.kind),
    ["invariant-undeclared", "invariant-undeclared"],
  );
  assert.match(r.findings[0].evidence, /range member `I-024-999`/);
  assert.match(r.findings[1].evidence, /range member `I-024-1000`/);
});

test("a malformed range gates, and the message names WHY it could not expand", () => {
  const root = makeInvariantRepoRoot({ "100-a.md": "## Invariants\n\n### I-100-1 — a\n" });
  // Three distinct malformations, three distinct reasons. A single generic
  // "malformed" string would leave an author guessing which of the three they
  // wrote, and would let two of the arms rot into the third undetected.
  const reversed = verifyInvariantReferences(marker("I-100-9..2"), { repoRoot: root });
  assert.equal(reversed.findings.length, 1);
  assert.equal(reversed.findings[0].kind, "invariant-reference-malformed");
  assert.match(reversed.findings[0].evidence, /ends at 2 but starts at 9/);

  const huge = verifyInvariantReferences(marker("I-100-1..999"), { repoRoot: root });
  assert.equal(huge.findings[0].kind, "invariant-reference-malformed");
  assert.match(huge.findings[0].evidence, /past the 64-member ceiling/);

  const shortPlan = verifyInvariantReferences(marker("I-24-3"), { repoRoot: root });
  assert.equal(shortPlan.findings[0].kind, "invariant-reference-malformed");
  assert.match(shortPlan.findings[0].evidence, /three-digit plan segment/);
});

test("invariant-reference-malformed is in NO demote or exempt allowlist", () => {
  // Same argument as `unbalanced-cite-quote` above: a new fail-closed kind that
  // any allowlist quietly captures is a finding that never turns anything red.
  assert.equal(G4_GRAMMAR_DEMOTE_KINDS.has("invariant-reference-malformed"), false);
  assert.equal(LEGACY_INLINE_EXEMPT_KINDS.has("invariant-reference-malformed"), false);
});

test("CORPUS CENSUS: the six published invariant counts do not move", () => {
  // The range work rewrote the counting path, and the census it feeds is printed
  // by `--survey` as the only evidence the screen ran. Every one of these six is
  // pinned EXACTLY — a floor would let the unit of count silently change from
  // references to members (575 → more) while still reading as "the screen ran".
  const plansDir = resolve(REPO_ROOT_FOR_TESTS, "docs", "plans");
  const cache = new Map();
  const census = { bold: {}, legacy: {} };
  for (const channel of ["bold", "legacy"]) {
    census[channel] = { resolved: 0, noneArm: 0, parentResolved: 0 };
  }
  for (const name of readdirSync(plansDir).filter(
    (n) => /^\d{3}-.+\.md$/.test(n) && !n.startsWith("000-"),
  )) {
    const r = verifyInvariantReferences(readFileSync(resolve(plansDir, name), "utf8"), { cache });
    for (const channel of ["bold", "legacy"]) {
      for (const field of ["resolved", "noneArm", "parentResolved"]) {
        census[channel][field] += r[channel][field];
      }
    }
  }
  assert.deepEqual(census, {
    // 576/104 -> 577/106 (2026-08-01, PR #278): the Plan-006 T4.10 audit delta
    // minted T1.11 + T1.12 (each a bold none-arm) and added I-006-4-09 to the
    // T4.10 row (one more bold resolved reference).
    // 577/58 -> 585/59 (2026-08-03, PR #284): the V1 product-vision
    // reconciliation amendments added bold resolved references across the six
    // amended plans (Plans 002/003/004/008/012/016 — new invariants I-002-5/6,
    // I-008-13/14, I-016-21/22 and their task-row references), plus one
    // legacy-channel reference from Plan-008's T-008r-4-10 growth.
    // 585/59 -> 587/59 (2026-08-03, PR #284 round 2): the Codex round-2 fixes
    // added I-004-19 to Plan-004's T3.4 and T3.5 `Verifies invariant:` rows —
    // two more bold resolved references.
    // 587/59 -> 588/59 (2026-08-08, PR #298): the Codex round-1 fix added
    // I-010-19 (daemon half) to Plan-010's T2.5 `Verifies invariant:` row,
    // aligning it with the row's own Tests prose — one more bold resolved
    // reference.
    // 588/59 -> 589/59 (2026-08-09, PR #307): the sparse-root capture-closure
    // amendment added Plan-010 Phase 6 / T6.1 with its `Verifies invariant:`
    // I-010-24 row — one more bold resolved reference.
    // 589/106 -> 708/126 (2026-08-11, PR #318): the Tier-8 plan-readiness audit
    // (NS-20) added audit-derived Tasks blocks across Plans 013/017/019/020/023
    // — 119 more bold resolved references and 20 more bold none-arms from the
    // new `Verifies invariant:` rows; the legacy channel is unchanged.
    // 708/126 -> 709/131 (2026-08-11, PR #318 Codex review round): Plan-019's
    // emission re-split narrowed T3.1 to I-019-1 (-1 resolved) and added T3.2
    // with I-019-2 + I-019-3 (+2 resolved) plus the T2.6 none-arm; Plan-020
    // added the T1.4/T2.10 none-arms; Plan-013 added the T4.4/T4.5 meter
    // none-arms — net +1 resolved, +5 none-arms; the legacy channel is
    // unchanged.
    // 709/131 -> 712/131 (2026-08-11, chat-start amendment): Plan-017's T5.8,
    // T5.9, and T5.10 each carry a `Verifies invariant:` row (I-017-17 once,
    // I-017-18 twice) — three more bold resolved references; the legacy
    // channel is unchanged.
    // 712/131 -> 713/131 (2026-08-11, channel-directory delta): Plan-016's
    // T2.14 carries a `Verifies invariant:` row (I-016-23) — one more bold
    // resolved reference; the legacy channel is unchanged.
    // 713/131 -> 717/134 (2026-08-11, PR #322 membership delta): Plan-002's
    // T3.7 (I-002-7, I-002-3) and T3.8 (I-002-6, I-002-7) each carry a
    // two-id `Verifies invariant:` row — four more bold resolved references —
    // and T2.6/T2.7/T2.8 each carry a `Verifies invariant: none (...)` row —
    // three more bold none-arms; the legacy channel is unchanged.
    // legacy 59 -> 61 (2026-08-11, PR #323 relay delta): Plan-008's new
    // T-008r-4-14 carries a compact-inline `Verifies invariant:` row naming
    // I-008-13 and I-008-14(b) — two more legacy resolved references; the
    // bold channel is unchanged.
    // 717/134 -> 724/134 (2026-08-12, PR #326 relay-scope delta): Plan-014's
    // invariant↔task marker-symmetry repair restored I-014-6/7/8/9 across the
    // Tasks 7–10 `Verifies invariant:` rows (that plan's bold references
    // 12 → 19) — seven more bold resolved references; the legacy channel is
    // unchanged.
    // 724/134 -> 733/134 (2026-08-12, PR #327 dual-scope caller-authorization
    // delta): Plan-003's new T3.10, T3.11, and T3.12 each carry a three-id
    // `Verifies invariant:` row (I-003-3 and I-003-6 in all three, plus
    // I-003-5 twice and I-003-1 once) — nine more bold resolved references;
    // the legacy channel is unchanged.
    // 733/134 -> 773/145 (2026-08-12, Plan-028 targeted readiness audit): the
    // audit authored `#### Tasks` blocks across all five Plan-028 Phases —
    // 43 tasks, each carrying one bold `Verifies invariant:` row (32 resolved
    // arms carrying 40 id references, 11 none-arms); the legacy channel is
    // unchanged.
    // 773/145 -> 821/149 (2026-08-12, Tier-9 plan-readiness audit — PR #331):
    // the audit backfilled `#### Tasks` blocks across Plan-026 (six Phases,
    // 22 tasks — 26 resolved references + 3 none-arms) and Plan-027 (six
    // Phases, 12 tasks — 22 resolved references + 1 none-arm); the legacy
    // channel is unchanged.
    // 821/149 -> 831/149 (2026-08-15, Plan-018 NS-62 promotion delta —
    // PR #334): the promotion pass authored Plan-018 Phase 5 (T5.1–T5.8) —
    // eight tasks whose bold `Verifies invariant:` rows carry ten id
    // references (I-018-10 ×4, I-018-12 ×2, I-018-11, I-018-13, I-018-14,
    // and I-018-8 on the T5.8 relay handlers); the legacy channel is
    // unchanged.
    // 831/149 -> 831/152 (2026-08-15, Tier-7 phases backfill): the backfill
    // restored marker symmetry on Plan-014's Tasks 1/5/6 — the three NS-19-era
    // rows that carried no `Verifies invariant:` marker at all (NS-59's repair
    // covered Tasks 7-10 only) — each an explicit none-arm, matching the
    // §Invariants cells, which name none of the three; three more bold
    // none-arms, resolved references unchanged; the legacy channel is
    // unchanged.
    // 831/152 -> 839/152 (2026-08-16/17, PR #340 repo-identity delta): the
    // Spec-009/Plan-009 targeted readiness-audit delta authored Phase 2B
    // (T-009-2B-1..4), whose four bold `Verifies invariant:` rows carry seven
    // id references (I-009-15 ×2, I-009-16 ×2, I-009-1, I-009-3, I-009-5),
    // and the PR's Codex round-1 run-boundary repair added I-009-3 to the
    // T-009-2B-4 row — eight more bold resolved references in total; the
    // legacy channel is unchanged.
    // 839/152 -> 843/152 (2026-08-16/17, Plan-014 artifact-lifecycle amendment
    // + its in-swap NS-64 delta): three new tasks, each with a RESOLVED
    // `Verifies invariant:` arm carrying four id references in total —
    // T14.11 (I-014-11), T14.12 (I-014-12, I-014-2), T14.13 (I-014-13).
    // T14.8's row is rewritten in prose but its six-id set is unchanged, so
    // it contributes no delta; no none-arm is added or removed, and the
    // legacy channel is unchanged.
    // 843/152 -> 844/152 (2026-08-17, Spec-009/Plan-009 carried-findings
    // adjudication + its in-swap NS-65 delta): one new task with a RESOLVED
    // `Verifies invariant:` arm carrying one id reference — T-009-2B-5
    // (I-009-17). The four existing Phase-2B rows grow in prose but their
    // id sets are unchanged, so they contribute no delta; no none-arm is
    // added or removed, and the legacy channel is unchanged.
    // 844/152 -> 848/152 (2026-08-17, Spec-016/Plan-016 cost display-
    // consistency amendment + its in-swap NS-66 delta): no new task — the
    // amendment adds I-016-24 to four existing RESOLVED `Verifies invariant:`
    // rows (T2.5, T3.1, T3.2, T4.1), four more bold resolved id references;
    // no none-arm is added or removed, and the legacy channel is unchanged.
    // 848/152 -> 852/152 (2026-08-17, the Spec-004/Plan-004 rewind-hardening
    // amendment + its in-swap NS-67 delta): two new tasks, each with a
    // RESOLVED `Verifies invariant:` arm, carrying four id references in
    // total — T3.16 (I-004-20), T3.17 (I-004-21, I-004-3, I-004-18). T4.7's
    // row grows in prose (the --replace-message option) but its single-id set
    // is unchanged, and I-004-10's Verified-by column gains T4.7, which is a
    // table cell rather than a marker line and so contributes no delta; no
    // none-arm is added or removed, and the legacy channel is unchanged.
    // 852/152 -> 855/152 (2026-08-17, the rewind-hardening PR's Codex round-2
    // fold): no new task — the two-point boundary classification and the
    // run-bound drain add I-004-20 + I-004-21 to T3.5's RESOLVED `Verifies
    // invariant:` row and I-004-20 to T3.13's, three more bold resolved id
    // references, with the matching Verified-by cells grown symmetrically
    // (table cells, no marker delta). T3.16/T3.17's rows grow in prose but
    // their id sets are unchanged; no none-arm is added or removed, and the
    // legacy channel is unchanged.
    // 855/152 -> 863/152 (2026-08-17, the Spec-017/Plan-017 workflow-hardening
    // amendment + its in-swap NS-68 delta): six new tasks, each with a
    // RESOLVED `Verifies invariant:` arm, carrying eight id references in
    // total — T1.9 (I-017-12), T2.5 (I-017-19, I-017-23), T2.6 (I-017-20),
    // T5.11 (I-017-21), T5.12 (I-017-24), T5.13 (I-017-4, I-017-22); no
    // none-arm is added or removed, and the legacy channel is unchanged.
    // 863/152 -> 873/152 (2026-08-18, the admitting-principal carrier +
    // queue-PII envelope amendment and its in-swap NS-71 delta): no new task —
    // I-004-22 and I-004-23 join five existing Plan-004 RESOLVED `Verifies
    // invariant:` rows (T1.4 both, T2.4 I-004-22, T2.9 I-004-23, T3.5 both,
    // T3.17 both = 8 references) and I-012-25 joins two Plan-012 rows (T2.2,
    // T2.7 = 2 references), ten more bold resolved id references, with the
    // matching Verified-by cells grown symmetrically (table cells, no marker
    // delta); no none-arm is added or removed, and the legacy channel is
    // unchanged.
    // 873/152 -> 876/152 (2026-08-18, the Spec-017/Plan-017 park-surface +
    // operator-controls amendment and its in-swap NS-72 delta, landing after
    // NS-71 above): two new tasks, each carrying a RESOLVED `Verifies
    // invariant:` arm — T5.14 (I-017-25, I-017-26) and T5.15 (I-017-26) — three
    // more bold resolved id references. Both ids are declared by the same
    // amendment, so every reference resolves; no none-arm is added or removed,
    // and the legacy channel is unchanged.
    // 876/152 -> 877/152 (2026-08-18, the Plan-004/Plan-013 desktop
    // edit-affordance placement amendment + its in-swap NS-73 delta, landing
    // after NS-72 above): one new task, Plan-004 T4.8, with a RESOLVED
    // `Verifies invariant:` arm carrying a single id reference (I-004-24).
    // Plan-013 T4.2 grows in prose and gains Files/Provides/Tests bullets but
    // its `Verifies invariant:` line is untouched; I-004-24's Verified-by cell
    // names T4.8 symmetrically (a table cell, no marker delta). No none-arm is
    // added or removed, and the legacy channel is unchanged.
    // 877/152 -> 901/158 (2026-08-18, the Spec-029/Plan-029 provider-account
    // package + the Spec-016/Plan-016 session cost receipt + the Spec-005/
    // Plan-005 account-seam amendment, all in one swap — §6 node NS-74, landing
    // after NS-73 above): Plan-029 is a NEW plan contributing sixteen tasks
    // across Phases 1-4 and the 4B supplement, several carrying two id
    // references (T3.4 I-029-6 + I-029-2, T3.5 I-029-7 + I-029-8), plus five
    // none arms (T2.3, T4.1, T4.2, T4.3, T4.4); Plan-016 adds T2.15 (I-016-24),
    // T3.9 (I-016-16, I-016-24), and T4.6 (I-016-19, I-016-24) in its new Phase
    // 4B; Plan-005 adds T3.16 (I-005-6) and T3.17 (none) in its new Phase 3B.
    // The none-arm delta is exactly +6 and matches the six new `none` markers
    // one-for-one; the legacy channel is unchanged.
    // 901/158 -> 912/158 (2026-08-25, the Spec-023/Plan-023 deep-link
    // invite-confirmation amendment — §6 node NS-81, landing after NS-74
    // above): three NEW tasks carry RESOLVED `Verifies invariant:` arms —
    // T-023r-5-5 (I-023-9, I-023-10, I-023-5), T-023r-6-3 (I-023-9,
    // I-023-10), and T-023r-8-5 (I-023-9, I-023-10) — and three existing
    // rows widen onto the two new invariants: T-023r-2-5 (+I-023-10),
    // T-023r-5-3 (+I-023-9), and the T-023r-8-1 E2E row (+I-023-9,
    // +I-023-10). Exactly +11 bold resolved references, every one in
    // Plan-023. No none arm moves — all three new tasks carry ids rather
    // than `none` — and the legacy channel is unchanged.
    // 912/158 -> 914/158 (2026-08-25, the Plan-007 clipanion terminal-pin
    // amendment + its in-swap NS-78 delta, landing after NS-81 above): no new
    // task — I-007-20 joins two existing Plan-007 RESOLVED `Verifies
    // invariant:` rows (T-007r-3-1 and T-007r-3-2), two more bold resolved id
    // references. T-007r-3-3's row grows in prose but its single-id set is
    // unchanged; no none-arm is added or removed, and the legacy channel is
    // unchanged. The figure is read off a live survey run on the rebased tree,
    // not reconciled by arithmetic against a predecessor.
    // 914/158 -> 917/159 bold, legacy 61 -> 64 (2026-08-25, the rate-limit
    // wiring amendment — §6 node NS-80, landing after NS-81 and NS-78 above;
    // the bold baseline is stated post-rebase because both merged first, while
    // the legacy baseline is invariant under both — neither moved a legacy
    // reference. Both figures are read off a live survey run on the rebased
    // tree, never reconciled by arithmetic against a predecessor bullet):
    // Plan-014's
    // new T14.14 and T14.15 each carry a bold RESOLVED `Verifies invariant:`
    // row naming I-014-14, and T14.9's existing row gains I-014-14 beside its
    // three — three more bold resolved references. Plan-002's new T4.3 carries
    // a bold `none` arm (the cap is Plan-021 substrate consumption; the
    // lock-order clause is I-002-4's, already verified elsewhere) — one more
    // bold none-arm. Plan-008's new Phase R5 adds three compact-inline task
    // rows (T-008r-5-1 naming I-008-15(a)+(c)+(d), T-008r-5-2 naming
    // I-008-15(b), T-008r-5-3 naming I-008-15(c)) — three more LEGACY resolved
    // references, which is also what moves the legacy-marker population 49 ->
    // 52 in the alignment arm below.
    // 917/159 -> 927/159 (2026-08-25, the first-run provider-authentication
    // surfacing amendment and its in-swap NS-77 delta, landing after NS-80
    // above): five new tasks, every one carrying a RESOLVED `Verifies
    // invariant:` arm with two id references — Plan-026's new Phase 7 adds T7.1
    // (I-026-11, I-026-13), T7.2 (I-026-12, I-026-13), T7.3 (I-026-12,
    // I-026-13), and T7.4 (I-026-11, I-026-12), and Plan-029 Phase 2 adds T2.5
    // (I-029-9, I-029-10) — ten more bold resolved id references. All five ids
    // are declared by the same amendment, so every reference resolves; no
    // none-arm is added or removed, and the legacy channel is unchanged. Four
    // 2026-08-25 amendments (NS-81, NS-78, NS-80, NS-77) land in one develop,
    // so this figure is READ OFF a live survey run on the rebased tree rather
    // than reconciled by arithmetic against any predecessor; it happens to
    // agree with 917 + 10 and is pinned on the strength of the count.
    bold: { resolved: 927, noneArm: 159, parentResolved: 0 },
    legacy: { resolved: 64, noneArm: 3, parentResolved: 1 },
  });
});

// ---------- Fenced `verifies_invariant:` YAML disclosure ----------
//
// The count is DISCLOSURE, not verification: these ids sit inside fenced YAML,
// which the maskers hide from both extractors, so the survey prints how many
// references it did not screen. That makes an UNDERCOUNT the worst possible
// defect — it understates the unscreened surface while looking precise. The
// count once read 48 while 67 existed, because it read only the ids on the
// `verifies_invariant:` key line and the corpus writes many of them on
// CONTINUATION lines. The three synthetic-fixture tests below are what pin that
// counter property, and they are append-stable by construction.
//
// CONSTRAINT ON THE LIVE-CORPUS ARM. In a committed plan, `verifies_invariant:`
// is a Shipment-Manifest schema key (`../lib/manifest.mjs`): the post-merge
// housekeeper appends one entry per phase ship, each carrying a fresh id list. A
// task DAG is a dispatch-time artifact and never lands in `docs/plans/`, so the
// live fenced total is a function of how many phases have shipped — any test
// pinning its VALUE is re-pinned by every ship, and becomes a changelog of the
// housekeeper rather than a check on the counter.
//
// What is append-stable, and what this arm therefore asserts, is that the two
// readers of the same bytes ACCOUNT FOR THE SAME IDS — compared by identity, in
// both directions, never by comparing totals. Subtracting cardinalities is the
// tempting form and it is unsound: a manifest id the fenced reader missed
// cancels a task-DAG id it counted, so the difference reads zero precisely when
// the two readers disagree. Identity splits that into two named residues:
//
//   unaccounted  fenced ids the Shipment Manifest does not claim — a task DAG
//                committed into a plan file, i.e. a change in the unscreened
//                surface. Not unambiguously a bug, but it must be adjudicated
//                rather than silently absorbed, since those ids sit outside the
//                manifest schema where no consumer of the manifest sees them.
//   unread       manifest ids the fenced reader did not see — drift between the
//                two readers of one block, which is always a bug.
//
// An append extends both readers' id lists identically and moves neither
// residue. The disclosure total is still surveyed and printed; it is simply not
// pinned, because no assertion can pin a housekeeper-written number and stay
// meaningful.

function manifestInvariantRefs(planSource) {
  const parsed = parseManifestBlock(planSource);
  // Fails CLOSED by identity rather than by a throw: an unparseable manifest
  // claims no ids, so every fenced id lands in `unaccounted` and the arm reddens.
  if (!parsed.ok) return [];
  return (parsed.shipped ?? []).flatMap((entry) => entry.verifies_invariant ?? []);
}

// id -> occurrence count. Deliberately not a Set: one invariant id legitimately
// appears in several manifest entries (successive phases verifying the same
// invariant), so collapsing duplicates would let a dropped repeat read as
// agreement.
function tallyById(ids) {
  const tally = new Map();
  for (const id of ids) tally.set(id, (tally.get(id) ?? 0) + 1);
  return tally;
}

// Occurrences of `left` not covered by `right`, as a plain object so a failure
// names the offending ids instead of printing a bare number.
function excessById(left, right) {
  const excess = {};
  for (const [id, occurrences] of left) {
    const surplus = occurrences - (right.get(id) ?? 0);
    if (surplus > 0) excess[id] = surplus;
  }
  return excess;
}

// Pure set logic, kept separate from the pipeline below so the cancellation case
// can be driven directly — a correct fenced reader cannot produce it.
function reconcile(fencedIds, manifestIds) {
  const fenced = tallyById(fencedIds);
  const manifest = tallyById(manifestIds);
  return {
    unaccounted: excessById(fenced, manifest),
    unread: excessById(manifest, fenced),
    fencedTotal: fencedIds.length,
    manifestTotal: manifestIds.length,
  };
}

function reconcileFencedRefs(planSource) {
  const { fencedYamlRefIds } = verifyInvariantReferences(planSource, { cache: new Map() });
  return reconcile(fencedYamlRefIds, manifestInvariantRefs(planSource));
}

// Which plans MUST each contribute at least one manifest reference.
//
// Identity reconciliation is blind to a whole manifest DISAPPEARING: a plan with
// no manifest and no fenced ids has both readers return nothing, so both
// residues are empty and the plan passes — vacuously — while the surviving
// plans keep any global total comfortably positive. Deleting Plan-001's
// Shipment Manifest wholesale leaves every residue check green and the corpus
// total at 84. This floor is the detection for that.
//
// PINNED, not derived, and that is the whole point: a set derived from the same
// bytes under test IS the vacuity hole — a plan whose manifest vanished simply
// drops out of the derived expectation, and the check congratulates itself.
//
// APPEND-STABLE because it is a floor, not an equality. A plan that newly starts
// carrying a manifest never fails it; only a listed plan's contribution going to
// zero does. Add a number here when a plan ships its first manifest entry;
// removing one is a claim that the plan is no longer expected to contribute, and
// should be argued for rather than done to quiet a failure.
const PLANS_THAT_MUST_CARRY_MANIFEST_REFS = [
  "001",
  "002",
  "003",
  "005",
  "006",
  "007",
  "008",
  "009",
  "010",
  "024",
];

// Shared by the live-corpus arm and its negative control, so the control drives
// the same code the corpus arm gates on rather than restating the condition.
function missingFloorContributors(contributingPlanNumbers) {
  return PLANS_THAT_MUST_CARRY_MANIFEST_REFS.filter(
    (planNumber) => !contributingPlanNumbers.has(planNumber),
  );
}

test("every fenced invariant ref is accounted for by the Shipment Manifest", () => {
  const plansDir = resolve(REPO_ROOT_FOR_TESTS, "docs", "plans");
  const planNames = readdirSync(plansDir).filter(
    (n) => /^\d{3}-.+\.md$/.test(n) && !n.startsWith("000-"),
  );
  // Without this, a corpus that failed to load leaves every check below
  // vacuously green — nothing reconciled against nothing agrees.
  assert.ok(planNames.length >= 20, `expected the plan corpus, read ${planNames.length} files`);

  const unaccountedByPlan = {};
  const unreadByPlan = {};
  const contributingPlans = new Set();
  for (const name of planNames) {
    const { unaccounted, unread, manifestTotal } = reconcileFencedRefs(
      readFileSync(resolve(plansDir, name), "utf8"),
    );
    const planNumber = name.slice(0, 3);
    if (manifestTotal > 0) contributingPlans.add(planNumber);
    if (Object.keys(unaccounted).length > 0) unaccountedByPlan[planNumber] = unaccounted;
    if (Object.keys(unread).length > 0) unreadByPlan[planNumber] = unread;
  }
  assert.deepEqual(
    unaccountedByPlan,
    {},
    "fenced ids the Shipment Manifest does not claim (a task DAG committed into a plan)",
  );
  assert.deepEqual(
    unreadByPlan,
    {},
    "manifest ids the fenced reader did not see (drift between the two readers)",
  );
  // Both residue checks above are satisfied by silence, so the arm needs a floor
  // that silence cannot satisfy. Per-plan rather than a global total: a global
  // count stays healthy while any one plan's manifest quietly disappears.
  assert.deepEqual(
    missingFloorContributors(contributingPlans),
    [],
    "a plan expected to carry Shipment-Manifest refs contributed none — manifest lost, or the parser stopped reading it",
  );
});

test("NEGATIVE CONTROL: a manifest append leaves the residues still, a task-DAG edit moves them", () => {
  // The property the reconciliation exists to establish, driven both directions
  // on one synthetic plan. Proving the check can FAIL is the point: the
  // live-corpus arm above asserts empty objects, which a broken reconciliation
  // would also produce.
  const planWithBoth = [
    "#### Tasks",
    "",
    "```yaml",
    "tasks:",
    "  - id: T1",
    "    verifies_invariant: [I-100-1, I-100-2]",
    "```",
    "",
    "### Shipment Manifest",
    "",
    "```yaml",
    "manifest_schema_version: 1",
    "shipped:",
    "  - phase: 1",
    "    task: T1.1",
    "    pr: 4242",
    "    sha: abc1234",
    "    merged_at: 2026-01-01",
    "    files: [packages/x/src/a.ts]",
    "    verifies_invariant: [I-100-8, I-100-9]",
    "    spec_coverage: []",
    "```",
    "",
  ].join("\n");

  const before = reconcileFencedRefs(planWithBoth);
  assert.deepEqual(before.unaccounted, { "I-100-1": 1, "I-100-2": 1 }, "the task-DAG ids, named");
  assert.deepEqual(before.unread, {}, "the fenced reader saw both manifest ids");
  assert.equal(before.fencedTotal, 4);
  assert.equal(before.manifestTotal, 2);

  // (a) A housekeeper append — the motion this redesign exists to absorb. Driven
  // through the production writer, so a change to the serialized id spelling is
  // exercised here rather than assumed.
  const afterAppend = reconcileFencedRefs(
    appendManifestEntry(planWithBoth, {
      phase: 2,
      task: "T2.1",
      pr: 4243,
      sha: "def5678",
      merged_at: "2026-02-02",
      files: ["packages/x/src/b.ts"],
      verifies_invariant: ["I-100-3", "I-100-4", "I-100-5"],
      spec_coverage: [],
    }),
  );
  assert.deepEqual(
    afterAppend.unaccounted,
    before.unaccounted,
    "an append must not move the unaccounted residue",
  );
  assert.deepEqual(afterAppend.unread, {}, "and must leave the two readers in agreement");
  assert.equal(afterAppend.manifestTotal, before.manifestTotal + 3);
  assert.equal(
    afterAppend.fencedTotal,
    before.fencedTotal + 3,
    "both readers must rise by the same three",
  );

  // (b) A task-DAG edit — the motion it must NOT absorb. If the reconciliation
  // were wired to compare everything, or to read the manifest fence twice, this
  // arm would stay still and the check above would be asserting nothing.
  const afterTaskDagEdit = reconcileFencedRefs(
    planWithBoth.replace(
      "    verifies_invariant: [I-100-1, I-100-2]",
      "    verifies_invariant: [I-100-1, I-100-2, I-100-6]",
    ),
  );
  assert.deepEqual(
    afterTaskDagEdit.unaccounted,
    { ...before.unaccounted, "I-100-6": 1 },
    "the residue must NAME the new task-DAG id",
  );
  assert.deepEqual(afterTaskDagEdit.unread, {}, "and must not be charged to the manifest");
});

test("NEGATIVE CONTROL: equal totals with divergent ids redden both directions", () => {
  // The defect identity comparison exists to catch, and the reason this arm
  // calls `reconcile` directly rather than going through a plan fixture: a
  // CORRECT fenced reader always sees the manifest's own ids, so this state is
  // unreachable through the pipeline. It models a reader that missed one
  // manifest id while counting one task-DAG id — cardinalities then agree
  // exactly, and the subtraction this test used to perform reported success.
  const manifestIds = ["I-100-8", "I-100-9"];
  const fencedIdsFromADriftedReader = ["I-100-8", "I-100-1"];
  assert.equal(
    fencedIdsFromADriftedReader.length,
    manifestIds.length,
    "the totals must cancel — that is the premise of the arm",
  );

  const cancelled = reconcile(fencedIdsFromADriftedReader, manifestIds);
  assert.deepEqual(cancelled.unaccounted, { "I-100-1": 1 }, "the task-DAG id must still be named");
  assert.deepEqual(cancelled.unread, { "I-100-9": 1 }, "and the missed manifest id named too");

  // The multiset property `tallyById` exists for: a dropped REPEAT is a real
  // divergence that a Set-based comparison would report as agreement.
  const droppedRepeat = reconcile(["I-100-8"], ["I-100-8", "I-100-8"]);
  assert.deepEqual(droppedRepeat.unread, { "I-100-8": 1 }, "a dropped repeat is a divergence");
});

test("NEGATIVE CONTROL: a vanished Shipment Manifest passes both residues and is caught only by the floor", () => {
  // Half one — the vacuity itself. A plan carrying no manifest and no fenced ids
  // reconciles perfectly clean, because BOTH readers return nothing and nothing
  // is therefore in excess either way. This is not a contrived shape: deleting a
  // real plan's manifest wholesale produces exactly it.
  const planWithNoManifest = ["## Invariants", "", "### I-100-1 — a declared invariant", ""].join(
    "\n",
  );
  const vacuous = reconcileFencedRefs(planWithNoManifest);
  assert.deepEqual(vacuous.unaccounted, {}, "no fenced ids, so nothing reads as unaccounted");
  assert.deepEqual(vacuous.unread, {}, "and no manifest ids, so nothing reads as unread");
  assert.equal(vacuous.fencedTotal, 0);
  assert.equal(vacuous.manifestTotal, 0, "it contributes nothing — the silence the floor owns");

  // Half two — the floor turning that silence into a failure, driven through the
  // same helper the corpus arm gates on. Plan-006 stands in for "a listed plan
  // whose manifest vanished".
  const everyPlanButOne = new Set(
    PLANS_THAT_MUST_CARRY_MANIFEST_REFS.filter((planNumber) => planNumber !== "006"),
  );
  assert.deepEqual(
    missingFloorContributors(everyPlanButOne),
    ["006"],
    "a listed plan that stopped contributing must be named",
  );

  // And the append-stability the pin depends on: a plan NOT on the list that
  // starts carrying a manifest must never fail the floor, or every new manifest
  // would break the suite and the list would rot into a rubber stamp.
  const withUnlistedNewcomer = new Set([...PLANS_THAT_MUST_CARRY_MANIFEST_REFS, "099"]);
  assert.deepEqual(
    missingFloorContributors(withUnlistedNewcomer),
    [],
    "an unlisted plan newly carrying a manifest must not fail the floor",
  );
});

test("all three YAML list spellings are counted, on continuation lines too", () => {
  const section = [
    "#### Tasks",
    "",
    "```yaml",
    "tasks:",
    "  - id: T1",
    "    verifies_invariant: [I-100-1, I-100-2]",
    "  - id: T2",
    "    verifies_invariant:",
    "      - I-100-3",
    "      - I-100-4",
    "  - id: T3",
    "    verifies_invariant:",
    "      [",
    "        I-100-5,",
    "        I-100-6,",
    "      ]",
    "  - id: T4",
    "    verifies_invariant: I-100-7",
    "```",
    "",
  ].join("\n");
  const { fencedYamlRefs } = verifyInvariantReferences(section, { cache: new Map() });
  assert.equal(fencedYamlRefs, 7, "inline flow + block sequence + wrapped flow + bare scalar");
});

test("a block sequence stops at the next mapping key, not at the next blank line", () => {
  // The scan skips blank lines rather than ending on them, because the
  // fencedness oracle is a line-diff against the mask and a whitespace-only line
  // masks to ITSELF — invisible in both directions. Ending the scan there would
  // drop a list that YAML permits to span one. Ending it too LATE is the
  // opposite error, so the terminator is asserted as well.
  const section = [
    "```yaml",
    "tasks:",
    "  - id: T1",
    "    verifies_invariant:",
    "      - I-100-1",
    "",
    "      - I-100-2",
    "    depends_on: [I-100-99]",
    "  - id: T2",
    "    verifies_invariant: I-100-3",
    "```",
    "",
  ].join("\n");
  const { fencedYamlRefs } = verifyInvariantReferences(section, { cache: new Map() });
  assert.equal(fencedYamlRefs, 3, "`depends_on:`'s ids must not be folded into the count");
});

test("NEGATIVE CONTROL: an UNFENCED verifies_invariant: block counts zero", () => {
  // The oracle is `masked !== raw` applied PER COUNTED LINE, so an unfenced key
  // and an unfenced continuation list are both invisible to it. That matters in
  // both directions: unfenced YAML is a DIFFERENT defect (it is not hidden from
  // the extractors, so it is not unscreened surface), and folding it into a
  // disclosure count would overstate what the screen missed.
  const section = ["#### Tasks", "", "verifies_invariant:", "  - I-100-1", "  - I-100-2", ""].join(
    "\n",
  );
  const { fencedYamlRefs } = verifyInvariantReferences(section, { cache: new Map() });
  assert.equal(fencedYamlRefs, 0);
});

// ---------- Inline-code examples in the legacy channel ----------

test("a compact-inline marker inside a code span is not extracted or resolved", () => {
  // `extractInlineCitePayloads` masked only FENCES, so documentation that shows
  // the marker shape inside a same-line code span was read as a live citation
  // and reported `invariant-plan-not-found` against an id nobody claimed. The
  // bold extractor has never had this hole — it scans `maskCiteContent`, and the
  // detection view here is now that same boundary.
  const illustrated = [
    "#### Tasks",
    "",
    "- The legacy spelling looks like `- **T-1** (Files: `x.ts`; Verifies invariant: I-999-1) — example`.",
    "",
  ].join("\n");
  assert.deepEqual(extractInlineCitePayloads(illustrated), []);
  const r = verifyInvariantReferences(illustrated, { cache: new Map() });
  assert.deepEqual(r.findings, [], "a documentation example must not resolve as a citation");
  assert.equal(r.legacy.resolved, 0);
});

test("NEGATIVE CONTROL: a real marker beside the example is still extracted", () => {
  // Both directions in one section, because a masker that blanked everything
  // would pass the test above forever.
  const root = makeInvariantRepoRoot({ "100-a.md": "## Invariants\n\n### I-100-1 — a\n" });
  const mixed = [
    "- Example: `- **T-1** (Files: `x.ts`; Verifies invariant: I-999-1) — example`.",
    inlineMarker("I-100-1"),
    "",
  ].join("\n");
  const payloads = extractInlineCitePayloads(mixed);
  assert.equal(payloads.filter((p) => p.field === "Verifies invariant").length, 1);
  const r = verifyInvariantReferences(mixed, { repoRoot: root });
  assert.deepEqual(r.findings, []);
  assert.equal(r.legacy.resolved, 1);
});

test("PAYLOAD BYTES still come from raw — a backticked payload survives detection masking", () => {
  // The reason detection and extraction read DIFFERENT views. Plan-008 task
  // T-008r-1-4's payload is `I-008-9, I-008-11, I-008-7c (substrate — the `relay_connections`
  // rows …)`; slicing it out of the masked view would blank the backticked run,
  // and `consumeFailure` reads `failure.raw`. This is the assertion that the
  // split was preserved rather than collapsed to one view for tidiness.
  const plan008 = readFileSync(
    resolve(REPO_ROOT_FOR_TESTS, "docs", "plans", "008-control-plane-relay-and-session-join.md"),
    "utf8",
  );
  const backticked = extractInlineCitePayloads(plan008).filter((p) => p.payload.includes("`"));
  assert.ok(
    backticked.length >= 8,
    `expected the live backticked-payload class to survive extraction, got ${backticked.length}`,
  );
  assert.ok(
    backticked.some((p) => p.payload.includes("`relay_connections`")),
    "Plan-008 task T-008r-1-4's payload lost its backticked bytes — extraction is reading the masked view",
  );
});

test("the composed detection view is byte-length-identical to its input", () => {
  // LOAD-BEARING, not incidental. `lineNo` is derived by counting newlines in the
  // detection view while `nearestTaskIdAt` indexes RAW lines; a masker that
  // changed length by one byte would shift every finding onto a neighbouring
  // task silently. `extractInlineCitePayloads` throws on a mismatch at runtime —
  // this proves the property holds across the whole live corpus, which is the
  // only place the throw could ever fire.
  const plansDir = resolve(REPO_ROOT_FOR_TESTS, "docs", "plans");
  for (const name of readdirSync(plansDir).filter((n) => /^\d{3}-.+\.md$/.test(n))) {
    const source = readFileSync(resolve(plansDir, name), "utf8");
    assert.equal(maskCiteContent(source).length, source.length, `${name} changed length`);
  }
});

test("CORPUS: every legacy marker's lineNo lands on its own raw line", () => {
  // The alignment the comment on `nearestTaskIdAt` asserts, re-verified under the
  // composed detection view: 52 of 52 live `Verifies invariant` compact-inline
  // markers (48 -> 49 at PR #323: Plan-008's new T-008r-4-14 row joins the
  // population; 49 -> 52 at the 2026-08-25 rate-limit wiring amendment, §6 node
  // NS-80: Plan-008's Phase R5 rows T-008r-5-1/2/3 join it). (That figure is the LEGACY-MARKER population — unrelated to
  // the fenced YAML count above, which also read 48 before this change; two
  // different figures that happened to collide. The fenced count's live value
  // is now pinned by NO test — it moves on every Shipment-Manifest append, so
  // the arm above asserts the append-stable partition instead. No surface
  // should quote the value.)
  const plansDir = resolve(REPO_ROOT_FOR_TESTS, "docs", "plans");
  let markers = 0;
  const misaligned = [];
  for (const name of readdirSync(plansDir).filter((n) => /^\d{3}-.+\.md$/.test(n))) {
    const source = readFileSync(resolve(plansDir, name), "utf8");
    const lines = source.split("\n");
    for (const payload of extractInlineCitePayloads(source)) {
      if (payload.field !== "Verifies invariant") continue;
      markers += 1;
      // INCLUSIVE slice: `lines[lineNo - 1]` is the marker's own line.
      if (!(lines[payload.lineNo - 1] ?? "").includes("Verifies invariant")) {
        misaligned.push(`${name}:${payload.lineNo}`);
      }
    }
  }
  assert.deepEqual(misaligned, [], "a marker's lineNo does not index its own raw line");
  assert.equal(markers, 52, "the legacy marker population moved — re-derive the alignment claim");
});

// ---------- Malformed ids in the structured namespace ----------

test("a near-miss facet id gates instead of being silently discarded", () => {
  // `I-008-7cc` is one keystroke from the live `I-008-7c`. It parses to
  // `plan-local-id-unparseable` (warn severity, so the inline floor skips it),
  // is not a recognized one-letter facet (so the roll-up drops it), and the
  // legacy-inline exemption diverts the marker-shape finding that would
  // otherwise have carried it — `--survey --enforce-cites` accepted it.
  const root = makeInvariantRepoRoot({ "008-a.md": "## Invariants\n\n### I-008-7 — a\n" });
  const r = verifyInvariantReferences(marker("I-008-7cc"), { repoRoot: root });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, "invariant-reference-malformed");
  assert.match(r.findings[0].evidence, /`I-008-7cc`/);
  // The one-letter form beside it must still roll up — the discriminator is the
  // facet SHAPE, and a fix that gated both would have deleted a working feature.
  const facet = verifyInvariantReferences(marker("I-008-7c"), { repoRoot: root });
  assert.deepEqual(facet.findings, []);
  assert.equal(facet.bold.parentResolved, 1);
});

test("the screen is scoped by SHAPE — a prose descriptor is not a malformed id", () => {
  // Scoped by semantic shape, not by call site. Every parse failure in a
  // `Verifies invariant` field reaches `consumeFailure`; only the ones in the
  // structured invariant namespace are references this screen was ever supposed
  // to resolve. `substrate boots` (Plan-023:275) is formatting debt on an exempt
  // plan, and firing a non-divertable finding at it would gate on a defect this
  // change was not asked to adjudicate.
  const root = makeInvariantRepoRoot({ "100-a.md": "## Invariants\n\n### I-100-1 — a\n" });
  const r = verifyInvariantReferences(marker("substrate boots"), { repoRoot: root });
  assert.deepEqual(
    r.findings.filter((f) => f.kind === "invariant-reference-malformed"),
    [],
  );
});

test("CORPUS: Plan-023's three Spec-§ invariant fields produce no gating finding", () => {
  // Plan-023:271/:272/:274 spell `Verifies invariant: Spec-023 §Security
  // Hardening Baseline …` — a SPEC clause in an invariant field. Whether the
  // field may name a spec at all is a field-CONTENT question under separate
  // adjudication; it is a different defect class from "an invariant id that
  // cannot be resolved", and answering it here would have gated Plan-023 on a
  // question this change never asked. Pinned so a later widening of the
  // malformed-id screen cannot swallow them by accident.
  const plan023 = readFileSync(
    resolve(REPO_ROOT_FOR_TESTS, "docs", "plans", "023-desktop-shell-and-renderer.md"),
    "utf8",
  );
  assert.ok(
    plan023.includes("Verifies invariant: Spec-023 §Security Hardening Baseline"),
    "the Plan-023 spec-reference shape moved — re-derive this pin before trusting it",
  );
  const r = verifyInvariantReferences(plan023, { cache: new Map() });
  assert.deepEqual(r.findings, []);
});

// ---------- Dispatch-path wiring ----------
//
// The resolver ran only under `--survey`. `preflight.mjs <plan> <phase>` — the
// gate a dispatch actually passes through — called only `gateTasksBlockCites`,
// whose verifier accepts any `plan-local-id` without asking whether an owning
// plan declares it. A phase citing `I-999-1` was dispatch-eligible.

// A minimal single-phase repo whose Gate-4 cites all resolve, so the only thing
// that can halt it is the invariant resolver. Mirrors PASS 30's fixture shape.
function makeDispatchRepo(taskLines, invariantLines = ["- **I-100-1 — Fixture invariant**"]) {
  const root = mkdtempSync(resolve(tmpdir(), "preflight-dispatch-invariants-"));
  const docsSpecs = resolve(root, "docs", "specs");
  mkdirSync(dirname(docsSpecs), { recursive: true });
  symlinkSync(FIXTURE_DIR, docsSpecs);
  const skillMd = resolve(root, "fake-skill.md");
  writeFileSync(skillMd, "---\nname: fake-skill\n---\n\nNo requires_files frontmatter.\n");
  const plansDir = resolve(root, "docs", "plans");
  mkdirSync(plansDir, { recursive: true });
  const planFile = resolve(plansDir, "100-fixture-plan.md");
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
      ...taskLines,
      "",
      "## Invariants",
      "",
      ...invariantLines,
      "",
      "",
    ].join("\n"),
  );
  return { planFile, root, skillMd };
}

const DISPATCH_BOLD_TASK = [
  "- **T-100-1.1** — Identifier surface",
  "  - **Spec coverage:** Spec-100 line 10 (FixtureIdentifier)",
  "  - **Verifies invariant:** I-100-1",
];

test("DISPATCH: a phase citing an unowned invariant no longer passes preflight", () => {
  const undeclared = DISPATCH_BOLD_TASK.map((line) =>
    line.replace("**Verifies invariant:** I-100-1", "**Verifies invariant:** I-999-1"),
  );
  const { planFile, root, skillMd } = makeDispatchRepo(undeclared);
  const r = runPreflight(planFile, 1, { repoRoot: root, skillMd });
  assert.equal(r.exit, 1, `dispatch must halt on a reference to Plan-999; got:\n${r.stdout}`);
  assert.match(r.stdout, /Gate 4 invariant-reference resolution failed/);
  assert.match(r.stdout, /\[invariant-plan-not-found\]/);
});

test("DISPATCH: the LEGACY compact-inline channel is screened too", () => {
  // The dispatch path has to screen BOTH channels or it reproduces the original
  // coverage hole one layer down: Plan-008 writes no bold markers at all, so a
  // bold-only dispatch screen would be a gate that never looks at the plan with
  // the most invariant citations in the corpus.
  const { planFile, root, skillMd } = makeDispatchRepo([
    "- **T-100-1.1** (Files: `x.ts` (CREATE); Verifies invariant: I-999-1; Spec coverage: Spec-100 line 10 (FixtureIdentifier)) — Do the thing.",
  ]);
  const r = runPreflight(planFile, 1, { repoRoot: root, skillMd });
  assert.equal(r.exit, 1, `dispatch must halt on the legacy channel too; got:\n${r.stdout}`);
  assert.match(r.stdout, /Gate 4 invariant-reference resolution failed/);
});

test("DISPATCH: a declared reference passes, and prints no survey census", () => {
  // Both halves are regressions. The first is the obvious one — a screen that
  // halted on everything would pass the two tests above and block every real
  // dispatch. The second guards the OUTPUT contract: `runPreflight` prints the
  // phase number and nothing else, and the resolver's counts are survey-scoped
  // reporting that a dispatch has no business emitting.
  const { planFile, root, skillMd } = makeDispatchRepo(DISPATCH_BOLD_TASK);
  const r = runPreflight(planFile, 1, { repoRoot: root, skillMd });
  assert.equal(r.exit, 0, `a declared reference must pass dispatch; got:\n${r.stdout}`);
  assert.equal(r.stdout, "1");
});

test("DISPATCH: a malformed id gates on the dispatch path, not just under survey", () => {
  const { planFile, root, skillMd } = makeDispatchRepo(
    DISPATCH_BOLD_TASK.map((line) =>
      line.replace("**Verifies invariant:** I-100-1", "**Verifies invariant:** I-100-999..1000"),
    ),
  );
  const r = runPreflight(planFile, 1, { repoRoot: root, skillMd });
  assert.equal(r.exit, 1, `dispatch must halt on an unexpandable range; got:\n${r.stdout}`);
  assert.match(r.stdout, /\[invariant-undeclared\]/);
});

test("DISPATCH SMOKE: a live corpus phase is not halted by the new screen", () => {
  // The synthetic fixtures above prove the screen fires. This proves it does not
  // fire on real plan text, which is the failure mode that would be discovered
  // by a blocked dispatch rather than by a test.
  const planFile = resolve(
    REPO_ROOT_FOR_TESTS,
    "docs",
    "plans",
    "006-session-event-taxonomy-and-audit-log.md",
  );
  const r = runPreflight(planFile, 1, {});
  assert.doesNotMatch(
    r.stdout,
    /invariant-reference resolution/,
    `a live plan phase was halted by the invariant screen:\n${r.stdout}`,
  );
});
