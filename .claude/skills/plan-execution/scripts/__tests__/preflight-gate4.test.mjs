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
  // content. Prefix handling mirrors tools/docs-corpus/lib/
  // markdown-fences.ts stripBlockquotePrefix.
  const specLines = ["> ```md", "## Phantom (v1)", "> ```", "## Real (v2)", "body"];
  assert.equal(findSectionHeading("Phantom", specLines).found, false);
  assert.equal(findSectionHeading("Real", specLines).found, true);
});

test("findSectionHeading: backtick-fence info strings may not contain backticks", () => {
  // Codex round-6 P2 on PR #224: a ```ts`x line is inline code, not a
  // fence opener (CommonMark 4.5; advanceFenceState parity) — treating it
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
