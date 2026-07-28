// node:test suite for preflight.mjs --survey (two-sided corpus screen).
//
// The real-corpus test is the institutionalized form of the omission survey
// that caught the second-`#### Tasks`-block extractor bug on PR #190: every
// future extractor/classifier edit AND every newly authored plan re-runs the
// screen in CI (ci.yml runs this suite). Fixture tests pin the oracle's
// looseness (star-tolerant, tail-free, head-anchored) against the two
// historical miss classes and the Plan-003 prose-bullet false-positive shape.
//
// Run via:
//   node --test --experimental-strip-types \
//     .claude/skills/plan-execution/scripts/__tests__/preflight-survey.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  cpSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  surveyPhase,
  surveyCorpus,
  formatSurvey,
  classifyPhaseMarkers,
  countCites,
  LEGACY_INLINE_CITE_EXEMPT,
  extractInlineCitePayloads,
  verifyInlineAnchorFloor,
  walkPhases,
  extractPhaseSection,
  gateTasksBlockCites,
} from "../preflight.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..", "..");
const PREFLIGHT = resolve(__dirname, "..", "preflight.mjs");

// ---------- surveyPhase (unit) ----------

const CLEAN_PHASE = `### Phase 1 — Example

#### Tasks

- **T1.1 — first task** (Files: packages/a/src/x.ts)
- [ ] **T1.2 — checkbox row** (Files: packages/a/src/y.ts)

##### T1.3 — heading row

Body prose mentioning T1.1 again is fine.
`;

test("surveyPhase: clean phase — both directions reconcile", () => {
  const result = surveyPhase(CLEAN_PHASE);
  assert.deepEqual(result.ids, ["T1.1", "T1.2", "T1.3"]);
  assert.deepEqual(result.omissions, []);
  assert.deepEqual(result.phantoms, []);
});

test("surveyPhase: bold-italic task row surfaces as omission (oracle looser than extractor)", () => {
  const section = `### Phase 1 — Example

#### Tasks

- **T1.1 — parsed fine**
- ***T1.9 — bold-italic row the extractor cannot parse***
`;
  const result = surveyPhase(section);
  assert.deepEqual(result.ids, ["T1.1"]);
  assert.equal(result.omissions.length, 1);
  assert.match(result.omissions[0], /T1\.9/);
});

test("surveyPhase: parsed T1.1 does NOT cover an unparseable T1.10 row (boundary-aware reconciliation — Codex r2)", () => {
  // With bare substring matching, the `T1.1` prefix inside `T1.10` marked the
  // bold-italic row as covered and the screen stayed green on a real
  // extractor miss. The boundary rule (id not followed by digit / `.` / `-`)
  // must surface it as an omission.
  const section = `### Phase 1 — Example

#### Tasks

- **T1.1 — parsed fine**
- ***T1.10 — bold-italic row the extractor cannot parse***
`;
  const result = surveyPhase(section);
  assert.deepEqual(result.ids, ["T1.1"]);
  assert.equal(result.omissions.length, 1);
  assert.match(result.omissions[0], /T1\.10/);
});

test("surveyPhase: a cross-reference in an unparseable row's tail does NOT cover it (head-id equality — Codex r5)", () => {
  const section = `### Phase 2 — Example

#### Tasks

- **T2.1 — parsed fine**
- ***T2.7 — depends on T2.1***
`;
  const result = surveyPhase(section);
  assert.ok(result.ids.includes("T2.1"));
  assert.equal(result.omissions.length, 1);
  assert.match(result.omissions[0], /T2\.7/);
});

test("surveyPhase: parsed T-025 does NOT cover a lettered T-025d-14-1 row (letters extend ids — Codex r3)", () => {
  const section = `### Phase 1 — Example

#### Tasks

- **T-025 — parsed fine**
- ***T-025d-14-1 — lettered id the extractor cannot parse***
`;
  const result = surveyPhase(section);
  assert.ok(result.ids.includes("T-025") || result.ids.length >= 1);
  assert.equal(result.omissions.length, 1);
  assert.match(result.omissions[0], /T-025d-14-1/);
});

test("surveyPhase: boundary rule does not over-fire — ids followed by em-dash/space/paren still count as covered", () => {
  const section = `### Phase 1 — Example

#### Tasks

- **T1.1 — plain**
- **T1.2** (Files: \`packages/a/x.ts\`) — parenthesized
`;
  const result = surveyPhase(section);
  assert.deepEqual(result.ids, ["T1.1", "T1.2"]);
  assert.deepEqual(result.omissions, []);
  assert.deepEqual(result.phantoms, []);
});

test("surveyPhase: star-in-title rows stay covered (the PR #190 miss class, now parsed)", () => {
  const section = `### Phase 1 — Example

#### Tasks

- **T2.1 — wire \`repo.*\` namespace** (Files: packages/a/src/x.ts)
`;
  const result = surveyPhase(section);
  assert.deepEqual(result.ids, ["T2.1"]);
  assert.deepEqual(result.omissions, []);
});

test("surveyPhase: prose detail bullets mentioning task ids are NOT oracle rows (Plan-003 shape)", () => {
  const section = `### Phase 1 — Example

#### Tasks

- **T1.1 — real row**
- **Step:** conformance assertion against Plan-001 T2.3; gives T4.1's SDK a schema.
- **Files:** \`packages/contracts/src/__tests__/runtime-node.test.ts\`
- **Contract dependency:** ratified by the Tier-3 audit (T3.8).
`;
  const result = surveyPhase(section);
  assert.deepEqual(result.ids, ["T1.1"]);
  assert.deepEqual(result.omissions, []);
  assert.deepEqual(result.phantoms, []);
});

test("surveyPhase: phase without a Tasks block yields no oracle rows and no anomalies", () => {
  const result = surveyPhase("### Phase 1 — Example\n\nProse only.\n");
  assert.deepEqual(result.ids, []);
  assert.deepEqual(result.oracleLines, []);
  assert.deepEqual(result.omissions, []);
  assert.deepEqual(result.phantoms, []);
  assert.equal(result.sizeClass, "L"); // fail-closed classifier default
});

// ---------- surveyCorpus (fixture tree) ----------

function makeFixtureCorpus(planFiles) {
  const tmp = mkdtempSync(join(tmpdir(), "survey-corpus-"));
  const plansDir = join(tmp, "docs", "plans");
  mkdirSync(plansDir, { recursive: true });
  // Inline anchor-existence floor substrate: the legacy-inline fixtures cite
  // Spec-050, so the fixture tree carries a real spec file — the floor then
  // verifies file + section existence exactly as it does on the live corpus
  // (no fixture-only fail-open path). `Framing (V1 Pairwise)` exists to pin
  // the heading-side trailing-parenthetical tolerance.
  const specsDir = join(tmp, "docs", "specs");
  mkdirSync(specsDir, { recursive: true });
  // The trailing table pins the row-claim leg (`Spec-050 rows 1 + 7a`);
  // appended last so the line-anchor fixtures' numbering stays stable.
  writeFileSync(
    join(specsDir, "050-fixture-spec.md"),
    "# Spec-050: Fixture\n\n## Required Behavior\n\nBody.\n\n## Framing (V1 Pairwise)\n\nBody.\n\n## Acceptance Criteria\n\n- [ ] AC1 body\n- [ ] AC2 body\n\n## Behavior Rows\n\n| # | Behavior |\n| --- | --- |\n| 1 | first |\n| 7a | lettered |\n",
  );
  for (const [name, content] of Object.entries(planFiles)) {
    writeFileSync(join(plansDir, name), content);
  }
  return tmp;
}

test("surveyCorpus: zero-phase plan is a notice, not an anomaly; template is skipped", () => {
  const tmp = makeFixtureCorpus({
    "000-plan-template.md": "### Phase 1 — template noise\n",
    "050-cluster-shaped.md": "### Cluster 1 — no phase headings\n\n#### Tasks\n\n- **T1.1 — x**\n",
    "051-clean.md": CLEAN_PHASE,
  });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.equal(survey.planCount, 2); // template excluded
    assert.equal(survey.phaseCount, 1); // the fallback unit is not a dispatchable phase
    assert.equal(survey.notices.length, 1);
    assert.match(survey.notices[0], /050-cluster-shaped\.md/);
    assert.deepEqual(survey.anomalies, []);
    // The notice names the walkPhases gap, but the plan is still SWEPT — it is
    // counted as covered via the whole-document fallback, never skipped.
    assert.deepEqual(survey.fallbackPlans, ["050-cluster-shaped.md"]);
    assert.deepEqual(survey.uncoveredPlans, []);
    assert.equal(survey.surveyedPlanCount, 2);
    const text = formatSurvey(survey);
    assert.match(text, /notices \(1\):/);
    assert.match(text, /anomalies: none/);
    assert.match(text, /coverage: 2\/2 plan\(s\) cite-swept, 0 uncovered/);
    assert.match(text, /whole-document fallback \(1\): 050-cluster-shaped\.md/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- coverage: the whole-document fallback (false-clean verdict fix) ----------
//
// Phase-scoped sweeping used to `continue` past any plan without a `### Phase N`
// heading BEFORE running a single cite screen, then print `cite anomalies: none`
// — a false-clean verdict over 9 of the live corpus's 28 plans. These tests pin
// the three properties that make the verdict honest again: the fallback CATCHES
// what the skip hid, coverage is reported as a first-class number, and no third
// silent-skip path survives.

const PHASELESS_BAD_CITE_PLAN = `## Implementation Steps

Prose-shaped plan with no \`### Phase N\` heading anywhere.

#### Tasks

- **T1.1 — task whose cites point at nothing**
  - **Spec coverage:** Spec-999 §Nonexistent Section
  - **Verifies invariant:** Spec-050 §Also Nonexistent Heading
`;

test("surveyCorpus: a phase-less plan's broken cites are CAUGHT, not skipped behind a clean verdict", () => {
  const tmp = makeFixtureCorpus({ "062-phaseless-bad-cite.md": PHASELESS_BAD_CITE_PLAN });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.deepEqual(survey.anomalies, []); // two-sided screen stays clean
    assert.equal(survey.citeAnomalies.length, 2, survey.citeAnomalies.join("\n"));
    assert.match(
      survey.citeAnomalies[0],
      /062-phaseless-bad-cite\.md \(whole document\) \[spec-file-not-found\]/,
    );
    assert.match(
      survey.citeAnomalies[1],
      /062-phaseless-bad-cite\.md \(whole document\) \[section-not-found\]/,
    );
    // Not a vacuous pass: this plan carries markers, so it is verified, not skipped.
    assert.deepEqual(survey.markerlessPlans, []);
    assert.doesNotMatch(formatSurvey(survey), /cite anomalies: none/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("surveyCorpus: a markerless fallback plan is reported as a VACUOUS pass, not a verified one", () => {
  const tmp = makeFixtureCorpus({
    "063-phaseless-no-markers.md": "## Implementation Steps\n\nProse only, no cite markers.\n",
  });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.deepEqual(survey.citeAnomalies, []);
    assert.deepEqual(survey.fallbackPlans, ["063-phaseless-no-markers.md"]);
    assert.deepEqual(survey.markerlessPlans, ["063-phaseless-no-markers.md"]);
    // "clean" here must be legible as "nothing to check", never as "verified".
    const text = formatSurvey(survey);
    assert.match(text, /swept but no cite markers to verify — vacuous pass \(1\)/);
    assert.match(text, /063-phaseless-no-markers\.md/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a PHASE-based plan with no cite markers is a vacuous pass too, not silent coverage", () => {
  // The fourth path the coverage contract says cannot exist. Vacuous-pass
  // disclosure used to be gated on `isWholeDocument`, but a plan with even one
  // `### Phase` heading never takes the whole-document fallback (that fires only
  // at `surveyUnits.length === 0`), and every markerless phase is skipped by
  // `hasCiteMarkers`. Nothing recorded it, so the plan landed inside
  // `N/N plan(s) cite-swept, 0 uncovered` with zero anomalies — swept on paper,
  // never screened in fact. Two real plans (023, 028) were hidden this way.
  const tmp = makeFixtureCorpus({
    "064-phases-no-markers.md":
      "### Phase 1 — work\n\n#### Tasks\n\n- **T1.1 something** — prose only, no cite markers.\n" +
      "\n### Phase 2 — more work\n\n#### Tasks\n\n- **T2.1 something else** — also prose only.\n",
  });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.deepEqual(
      survey.fallbackPlans,
      [],
      "a phase-based plan must NOT take the whole-document fallback — that is what hid it",
    );
    assert.deepEqual(survey.markerlessPlans, ["064-phases-no-markers.md"]);
    assert.match(
      formatSurvey(survey),
      /swept but no cite markers to verify — vacuous pass \(1\): 064-phases-no-markers\.md/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// The fifth path, and this screen committing its OWN defect class. The
// remainder/supplement label scan is a loose `### Phase (R\d+|\d+[A-Z])`, but
// `extractPhaseSection` additionally demands a ` — Title` separator. A heading
// that matches the first and fails the second used to have its null coerced to
// `""` — a silent-empty exactly like the `?? []` this PR closes elsewhere. The
// empty unit kept `surveyUnits` nonempty, which permanently suppressed the
// whole-document fallback, so every cite under the malformed heading went
// unparsed while `--survey --enforce-cites` exited 0 calling the plan
// cite-swept (Codex P1, PR #260 round 1).

// Task id follows the live remainder-phase idiom (Plan-008's `T-008r-1-1`), so
// the fixture exercises the label defect and nothing else. The heading is the
// only malformed thing here: real remainder headings carry the ` — Title` the
// extractor requires, and this one deliberately does not.
const UNEXTRACTABLE_LABEL_PLAN = `### Phase R1

#### Tasks

- **T-066r-1-1 — task whose cites point at nothing**
  - **Spec coverage:** Spec-999 §Nonexistent Section
  - **Verifies invariant:** Spec-050 §Also Nonexistent Heading
`;

test("surveyCorpus: an unextractable phase label gates AND leaves its cites screened", () => {
  const tmp = makeFixtureCorpus({ "066-unextractable-label.md": UNEXTRACTABLE_LABEL_PLAN });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    // Half one — VISIBLE. `anomalies`, not `citeAnomalies`: a heading the
    // extractor cannot read is a structural failure of the screen, so it gates
    // without waiting for --enforce-cites to be armed.
    assert.equal(survey.anomalies.length, 1, survey.anomalies.join("\n"));
    assert.match(survey.anomalies[0], /066-unextractable-label\.md \[phase-unextractable\]/);
    assert.match(survey.anomalies[0], /### Phase R1/);
    // Half two — SCREENED. Dropping the failed label lets the whole-document
    // fallback fire, so the broken cite underneath is actually caught. Reporting
    // alone would have left it unread.
    assert.deepEqual(survey.fallbackPlans, ["066-unextractable-label.md"]);
    assert.equal(survey.citeAnomalies.length, 2, survey.citeAnomalies.join("\n"));
    assert.match(
      survey.citeAnomalies[0],
      /066-unextractable-label\.md \(whole document\) \[spec-file-not-found\]/,
    );
    assert.match(
      survey.citeAnomalies[1],
      /066-unextractable-label\.md \(whole document\) \[section-not-found\]/,
    );
    const text = formatSurvey(survey);
    assert.doesNotMatch(text, /cite anomalies: none/);
    assert.match(text, /all 1 phase label\(s\) failed extraction/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("surveyCorpus: one unextractable label among GOOD phases still gates", () => {
  // Mixed shape: the fallback correctly does NOT fire (a real phase extracted),
  // so the malformed heading's cites are genuinely unswept. The run must then
  // fail loudly on the anomaly rather than report a clean verdict over them —
  // refusing is honest, exiting 0 is the false clean.
  const tmp = makeFixtureCorpus({
    "067-mixed-extractable.md":
      "### Phase 1 — real work\n\n#### Tasks\n\n" +
      "- **T1.1 thing** — **Spec coverage:** Spec-050 §Required Behavior\n" +
      "\n### Phase R1\n\n#### Tasks\n\n- **T-067r-1-1 thing** — **Spec coverage:** Spec-999 §Nope\n",
  });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.equal(survey.anomalies.length, 1, survey.anomalies.join("\n"));
    assert.match(survey.anomalies[0], /\[phase-unextractable\]/);
    assert.deepEqual(
      survey.fallbackPlans,
      [],
      "a plan with one good phase must NOT take the whole-document fallback",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a plan with markers in SOME phases is verified, not reported vacuous", () => {
  // Boundary control for the per-plan rollup: the flag must key on "no unit
  // anywhere had markers", not "some unit lacked them". Otherwise every plan
  // with one markerless phase would be mislabelled as unverified and the
  // vacuous-pass list would stop meaning anything.
  const tmp = makeFixtureCorpus({
    "065-mixed-markers.md":
      "### Phase 1 — cited work\n\n#### Tasks\n\n" +
      "- **T1.1 thing** — **Spec coverage:** Spec-050 §Required Behavior\n" +
      "  **Verifies invariant:** Spec-050 §Framing (V1 Pairwise)\n" +
      "\n### Phase 2 — prose only\n\n#### Tasks\n\n- **T2.1 something else** — no markers here.\n",
  });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.deepEqual(
      survey.markerlessPlans,
      [],
      "one markerless phase must not mark the whole plan unverified",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("surveyCorpus: a remainder-ONLY plan (### Phase R1, no numeric phase) is surveyed, not dropped", () => {
  // The zero-phase guard used to key on walkPhases alone and `continue` BEFORE
  // remainderLabels was computed, so a plan carrying only remainder/supplement
  // headings was skipped whole — a second silent-skip path behind the same
  // clean verdict. Keying the fallback on the COMBINED label set closes it, and
  // this plan must take the normal PHASE route (no fallback, no notice).
  const tmp = makeFixtureCorpus({
    "064-remainder-only.md": `### Phase R1 — remainder work

#### Tasks

- **T-064-R1-1 — task with a phantom section cite**
  - **Spec coverage:** Spec-050 §No Such Section
  - **Verifies invariant:** Spec-050 §Required Behavior
`,
  });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.equal(survey.phaseCount, 1);
    assert.deepEqual(survey.fallbackPlans, []);
    assert.deepEqual(survey.notices, []);
    assert.equal(survey.citeAnomalies.length, 1, survey.citeAnomalies.join("\n"));
    assert.match(survey.citeAnomalies[0], /064-remainder-only\.md Phase R1 \[section-not-found\]/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("surveyCorpus: an unreadable plan is UNCOVERED and gates via anomalies (no silent third path)", () => {
  // The residual leg of the fail-closed contract: when the sweep cannot reach a
  // plan at all it must be named and gated, never folded into a clean verdict.
  // A directory at a plan path makes readFileSync throw EISDIR deterministically.
  const tmp = makeFixtureCorpus({ "065-fine.md": CLEAN_PHASE });
  try {
    mkdirSync(join(tmp, "docs", "plans", "066-unreadable.md"));
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.equal(survey.planCount, 2);
    assert.equal(survey.surveyedPlanCount, 1);
    assert.equal(survey.uncoveredPlans.length, 1);
    assert.equal(survey.uncoveredPlans[0].name, "066-unreadable.md");
    // Gates unconditionally — it rides `anomalies`, so plain --survey blocks too.
    assert.equal(survey.anomalies.length, 1);
    assert.match(survey.anomalies[0], /066-unreadable\.md \[survey-uncovered\]/);
    const text = formatSurvey(survey);
    assert.match(text, /coverage: 1\/2 plan\(s\) cite-swept, 1 uncovered/);
    assert.match(text, /uncovered \(1\) — gated via anomalies:/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("surveyCorpus: omission in one plan surfaces with plan + phase attribution", () => {
  const tmp = makeFixtureCorpus({
    "052-broken.md": `### Phase 2 — broken

#### Tasks

- ***T2.7 — unparseable bold-italic***
`,
  });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.equal(survey.anomalies.length, 1);
    assert.match(survey.anomalies[0], /052-broken\.md Phase 2 \[omission\]/);
    const text = formatSurvey(survey);
    assert.match(text, /anomalies \(1\):/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("surveyCorpus: supplement phase (### Phase 3B) is surveyed, and its omissions surface (campaign B16)", () => {
  // Negative control for the supplement-label sweep: the ONLY malformed row
  // sits inside the 3B section, so if the sweep regex misses the heading the
  // anomaly vanishes and this test fails.
  const tmp = makeFixtureCorpus({
    "053-supplemented.md": `### Phase 3 — core

#### Tasks

- **T-053-3-1 — clean row**

### Phase 3B — supplement

#### Tasks

- **T-053-3B-1 — clean row**
- ***T-053-3B-2 — unparseable bold-italic***

### Phase 4 — after

#### Tasks

- **T-053-4-1 — clean row**
`,
  });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.equal(survey.phaseCount, 3); // 3, 3B, 4 all surveyed
    assert.equal(survey.anomalies.length, 1);
    assert.match(survey.anomalies[0], /053-supplemented\.md Phase 3B \[omission\]/);
    assert.match(survey.anomalies[0], /T-053-3B-2/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- the real corpus (the load-bearing screen) ----------

test("surveyCorpus: REAL corpus has zero two-sided anomalies", () => {
  const survey = surveyCorpus({ repoRoot: REPO_ROOT });
  assert.deepEqual(
    survey.anomalies,
    [],
    "extractor/classifier drift against the live plan corpus:\n" + survey.anomalies.join("\n"),
  );
  assert.ok(survey.planCount >= 27, `expected ≥27 plans, saw ${survey.planCount}`);
  assert.ok(survey.phaseCount >= 63, `expected ≥63 walked phases, saw ${survey.phaseCount}`);
});

test("REAL corpus: no phase label ever yields an empty survey unit", () => {
  // The generalized form of a defect this screen has now shipped three times —
  // `?? []` on a survey field, `?? planCount` on the coverage line, `?? ""` on a
  // failed phase extraction. Every instance is the same move: a nullish default
  // converting "could not determine" into "determined to be empty", which reads
  // downstream as verified-and-clean. The per-instance fixtures pin the three
  // known spellings; this pins the PROPERTY, so a fourth spelling — by any
  // mechanism, `??`, a silent catch, a bad slice — reds here without anyone
  // having predicted it.
  //
  // An empty unit is never legitimate: a phase label exists because a heading
  // matched, and a matched heading always has a body before the next boundary.
  //
  // The emptiness test is on the BODY, not the returned section, and that
  // distinction is the whole check. `extractPhaseSection` slices from
  // `startIdx` — the heading line itself — so its result contains the heading
  // even when the body is empty and `section.trim() === ""` can therefore never
  // be true. Writing it that way produces a check that cannot fail: a
  // vacuously-green assertion, which is the same silently-disabled-gate class
  // this whole PR is about, reproduced inside the guard meant to prevent it.
  // Verified by perturbation: forcing `endIdx = bodyStart` (every body empty)
  // leaves the section-level spelling GREEN and reds only this body-level one.
  //
  // Measured across the live corpus: 85 units, 0 null extractions, smallest
  // body 414 chars. If a real plan ever trips this, the plan is malformed and
  // the right response is to fix the plan, not to relax the assertion.
  const planDir = resolve(REPO_ROOT, "docs", "plans");
  const offenders = [];
  let unitCount = 0;
  for (const file of readdirSync(planDir).filter((name) => /^\d{3}-.*\.md$/.test(name))) {
    const source = readFileSync(resolve(planDir, file), "utf8");
    const labels = [
      ...walkPhases(source).map((phase) => phase.number),
      ...[...source.matchAll(/^### Phase (R\d+|\d+[A-Z])\b/gm)].map((match) => match[1]),
    ];
    for (const label of labels) {
      unitCount += 1;
      const section = extractPhaseSection(source, label);
      if (section == null) {
        offenders.push(`${file} Phase ${label}: extraction returned null`);
        continue;
      }
      // `indexOf` returns -1 when the section is a bare heading with no newline
      // — exactly the empty-body case — and `slice(-1 + 1)` is `slice(0)`, which
      // hands back the whole heading and reads as a healthy body. Treating the
      // sentinel as "no body" rather than letting it fall through is what makes
      // this assertion falsifiable at all.
      const newlineIndex = section.indexOf("\n");
      const body = newlineIndex === -1 ? "" : section.slice(newlineIndex + 1).trim();
      if (body === "") offenders.push(`${file} Phase ${label}: unit body is empty`);
    }
  }
  assert.deepEqual(offenders, [], `silently-empty survey unit(s):\n${offenders.join("\n")}`);
  assert.ok(unitCount >= 80, `expected ≥80 phase units on the live corpus, saw ${unitCount}`);
});

// The gated Gate-4 cite channel on the live corpus is EMPTY, and this pin is
// what keeps it that way.
//
// History: the whole-document fallback (coverage fix) first exposed 53 gated
// findings across Plan-011 / Plan-014 / Plan-015 — real debt the phase-scoped
// sweep had never reached, because those plans carry no `### Phase N` heading.
// They were pinned here as a temporary BASELINE and have since been healed:
//   - the grammar learned the `AC line N` sub-anchor (corpus vocabulary shared
//     by Plan-011 / Plan-014 / Plan-025) and gained quote-region tokenization;
//   - Plan-011 moved its sub-anchor separators from `;` (unconditional
//     new-namespace) to `,` (same-namespace continuation);
//   - Plan-014 dropped a singular `line N-M` range and a `line N + M` bare-plus
//     continuation, both one-plan idioms;
//   - Plan-015 converted its `(`docs/specs/…md:LINE`)` prose anchors into the
//     marker grammar, every line number preserved verbatim.
//
// Pinned as an exact SET (now empty), not a count, so the guard keeps teeth in
// BOTH directions: a plan gaining cite debt lands here as an unexpected name.
// The correct response is to FIX the cite — never to re-add a name to this
// list, and never to widen LEGACY_INLINE_CITE_EXEMPT (its divert is scoped to
// legacy marker-SHAPE kinds and deliberately excludes `unparseable-cite` /
// `unparseable-spec-subanchor`).
//
// One non-obvious way this pin fails: `[stale-exemption]` findings ride the same
// `citeAnomalies` channel keyed by bare basename, so re-authoring Plan-008 or
// Plan-023 clean adds ITS name here. That failure is correct (the exemption must
// be deleted in the same PR) but reads as a cite defect — check for
// `[stale-exemption]` in the diff output before hunting for a malformed cite.

test("surveyCorpus: REAL corpus — zero gated cite anomalies; legacy-inline debt diverted + visible", () => {
  const survey = surveyCorpus({ repoRoot: REPO_ROOT });
  // Attribution ratchet on the gated channel (what --enforce-cites folds into
  // the exit). A newly authored plan with a cite defect, or an exemption gone
  // stale, lands right here as an unexpected plan name.
  const plansWithGatedCiteAnomalies = [
    ...new Set(survey.citeAnomalies.map((anomaly) => anomaly.split(" ")[0])),
  ].sort();
  assert.deepEqual(
    plansWithGatedCiteAnomalies,
    [],
    "gated cite anomalies on the live corpus:\n" + survey.citeAnomalies.join("\n"),
  );
  // The diverted debt is real and printed (visible debt), never silently dropped.
  assert.ok(
    survey.exemptCiteAnomalies.length > 0,
    "expected the legacy-inline plans to still carry suppressed cite anomalies",
  );
  // Every configured exemption is present in the corpus and still earning its place
  // (>0 suppressed) — this recovers dead-entry detection (a renamed/removed exempt
  // plan drops exemptFiles below the list length) and the clean-scan ratchet.
  assert.equal(survey.exemptFiles.length, LEGACY_INLINE_CITE_EXEMPT.length);
  for (const { base, count } of survey.exemptFiles) {
    assert.ok(
      count > 0,
      `${base}: exempt but scans clean — remove it from LEGACY_INLINE_CITE_EXEMPT`,
    );
  }
});

// ---------- CLI ----------

test("preflight --survey: exit 0 on the real corpus, report on stdout", () => {
  const run = spawnSync(process.execPath, [PREFLIGHT, "--survey"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /distribution: L=\d+ M=\d+ S=\d+ across \d+ phase\(s\)/);
  assert.match(run.stdout, /anomalies: none/);
});

test("preflight --survey: rejects mixed invocations (exit 2, no survey run)", () => {
  const run = spawnSync(
    process.execPath,
    [PREFLIGHT, "docs/plans/001-shared-session-core.md", "5", "--survey"],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stderr, /--survey runs alone/);
  assert.doesNotMatch(run.stdout, /distribution:/); // the survey must not have run
});

test("preflight --survey: exit 1 with anomaly listing on a broken fixture corpus", () => {
  const tmp = makeFixtureCorpus({
    "052-broken.md": `### Phase 2 — broken

#### Tasks

- ***T2.7 — unparseable bold-italic***
`,
  });
  try {
    // The CLI derives repoRoot from its own location, so point a copy at the
    // fixture tree via a scripted import instead of relocating the script.
    const runner = join(tmp, "run-survey.mjs");
    writeFileSync(
      runner,
      `import { surveyCorpus, formatSurvey } from ${JSON.stringify(PREFLIGHT)};\n` +
        `const survey = surveyCorpus({ repoRoot: ${JSON.stringify(tmp)} });\n` +
        `console.log(formatSurvey(survey));\n` +
        `process.exit(survey.anomalies.length > 0 ? 1 : 0);\n`,
    );
    const run = spawnSync(process.execPath, [runner], { encoding: "utf8" });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /anomalies \(1\):/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- cite anomalies (per-phase Gate-4 screen) ----------
//
// The survey runs gateTasksBlockCites per walked phase and records every
// finding (all kinds) in a SEPARATE `citeAnomalies` channel, kept out of the
// two-sided `anomalies` the real-corpus guard pins to []. Warn-only under plain
// `--survey`; `--enforce-cites` folds them into the exit. Enforcement is
// fixture-tested only — the live corpus still carries pre-existing cite debt.

const BAD_CITE_PLAN = `### Phase 1 — bad cite

#### Tasks

- **T1.1 — malformed spec-coverage payload**
  - **Spec coverage:** just prose with no anchor
  - **Verifies invariant:** none (probe)
`;

test("surveyCorpus: a malformed cite surfaces in citeAnomalies, not in anomalies", () => {
  const tmp = makeFixtureCorpus({ "060-bad-cite.md": BAD_CITE_PLAN });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.deepEqual(survey.anomalies, []); // two-sided screen stays clean
    assert.ok(survey.citeAnomalies.length >= 1, "expected a cite anomaly");
    assert.match(survey.citeAnomalies[0], /060-bad-cite\.md Phase 1 \[unparseable-cite\]/);
    assert.match(formatSurvey(survey), /cite anomalies \(\d+\) \[warn-only/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("surveyCorpus: a phase without cite markers is skipped, not a cite anomaly", () => {
  const tmp = makeFixtureCorpus({ "061-no-markers.md": CLEAN_PHASE });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.deepEqual(survey.citeAnomalies, []);
    assert.match(formatSurvey(survey), /cite anomalies: none/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- W3/W4 marker-coverage classes (partial + legacy-unbold) ----------
//
// classifyPhaseMarkers is line-anchored, so it separates real field markers
// (bold `**Spec coverage:**` and unbold/inline `; Spec coverage:`) from prose
// that merely mentions the words — the miss that makes the dispatch gate's bare
// countCites read markers where there are none. Both classes land in the
// warn-only citeAnomalies channel, never in the two-sided `anomalies`.

test("classifyPhaseMarkers: separates bold, unbold, and prose (line-anchored)", () => {
  const bold =
    "  - **Spec coverage:** Spec-005 §Required Behavior\n  - **Verifies invariant:** I-005-1\n";
  assert.deepEqual(classifyPhaseMarkers(bold), {
    boldSpec: 1,
    boldInvariant: 1,
    unboldSpec: 0,
    unboldInvariant: 0,
  });

  const inline = "- **T-1** (Files: a.ts; Verifies invariant: none; Spec coverage: Spec-5 §X)\n";
  assert.deepEqual(classifyPhaseMarkers(inline), {
    boldSpec: 0,
    boldInvariant: 0,
    unboldSpec: 1,
    unboldInvariant: 1,
  });

  // Prose mentions carry no field colon: the bare-substring countCites the
  // dispatch gate keys on is fooled (spec_coverage === 1), the line-anchored
  // classifier is not — the W4 prose caution made executable.
  const prose = "We improved Spec coverage and Verifies invariant discipline this quarter.\n";
  assert.equal(countCites(prose).spec_coverage, 1);
  assert.deepEqual(classifyPhaseMarkers(prose), {
    boldSpec: 0,
    boldInvariant: 0,
    unboldSpec: 0,
    unboldInvariant: 0,
  });
});

const SPEC_ONLY_PHASE = `### Phase 1 — spec only

#### Tasks

- **T1.1 — one marker side**
  - **Spec coverage:** Spec-005 §Required Behavior (probe)
`;

test("surveyCorpus: a partial-marker phase (Codex repro — spec present, invariant absent) is a [markers-partial] cite anomaly", () => {
  const tmp = makeFixtureCorpus({ "062-partial.md": SPEC_ONLY_PHASE });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.deepEqual(survey.anomalies, []); // two-sided screen stays clean
    assert.equal(survey.citeAnomalies.length, 1);
    assert.match(
      survey.citeAnomalies[0],
      /062-partial\.md Phase 1 \[markers-partial\] has a Spec coverage marker but no Verifies invariant marker/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const INVARIANT_ONLY_PHASE = `### Phase 1 — invariant only

#### Tasks

- **T1.1 — substrate scaffold**
  - **Verifies invariant:** none (substrate)
`;

test("surveyCorpus: the reverse partial (invariant present, spec absent — the substrate shape) is also [markers-partial]", () => {
  const tmp = makeFixtureCorpus({ "063-partial-rev.md": INVARIANT_ONLY_PHASE });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.deepEqual(survey.anomalies, []);
    assert.equal(survey.citeAnomalies.length, 1);
    assert.match(
      survey.citeAnomalies[0],
      /063-partial-rev\.md Phase 1 \[markers-partial\] has a Verifies invariant marker but no Spec coverage marker/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const LEGACY_UNBOLD_PHASE = `### Phase 1 — legacy inline

#### Tasks

- **T-050p-1-1** (Files: \`packages/a/x.ts\`; Verifies invariant: none; Spec coverage: Spec-050 §Required Behavior) — inline unbold markers the bold extractor skips.
`;

test("surveyCorpus: an inline/unbold-marker phase is a [legacy-unbold-marker] cite anomaly (the Plan-008 false-green class)", () => {
  const tmp = makeFixtureCorpus({ "064-legacy.md": LEGACY_UNBOLD_PHASE });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.deepEqual(survey.anomalies, []); // the task-row oracle still reconciles
    assert.equal(survey.citeAnomalies.length, 1);
    assert.match(
      survey.citeAnomalies[0],
      /064-legacy\.md Phase 1 \[legacy-unbold-marker\] 2 unbold field marker\(s\)/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("surveyCorpus: prose that merely mentions the marker words yields no cite anomaly (line-anchored negative control)", () => {
  const prosePhase = `### Phase 1 — prose only

#### Tasks

- **T1.1 — real task** (Files: \`packages/a/x.ts\`)

This phase materially improved Spec coverage and Verifies invariant discipline, but names no cite markers.
`;
  const tmp = makeFixtureCorpus({ "065-prose.md": prosePhase });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.deepEqual(survey.anomalies, []);
    assert.deepEqual(survey.citeAnomalies, []); // prose ≠ marker
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("preflight --survey --enforce-cites: warn-only plain vs armed exit on a bad-cite fixture", () => {
  const tmp = makeFixtureCorpus({ "060-bad-cite.md": BAD_CITE_PLAN });
  try {
    // Mirrors the CLI exit formula: plain gates on `anomalies` only;
    // `--enforce-cites` folds `citeAnomalies` in. The CLI derives repoRoot from
    // its own location, so a scripted import points at the fixture tree.
    const runner = join(tmp, "run-enforce.mjs");
    writeFileSync(
      runner,
      `import { surveyCorpus } from ${JSON.stringify(PREFLIGHT)};\n` +
        `const s = surveyCorpus({ repoRoot: ${JSON.stringify(tmp)} });\n` +
        `const enforce = process.argv.includes("--enforce-cites");\n` +
        `process.exit((s.anomalies.length + (enforce ? s.citeAnomalies.length : 0)) > 0 ? 1 : 0);\n`,
    );
    const plain = spawnSync(process.execPath, [runner], { encoding: "utf8" });
    assert.equal(plain.status, 0, "plain survey is warn-only on cite anomalies");
    const armed = spawnSync(process.execPath, [runner, "--enforce-cites"], { encoding: "utf8" });
    assert.equal(armed.status, 1, "armed survey gates on cite anomalies");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("preflight --survey --enforce-cites: clean fixture exits 0 even when armed", () => {
  const tmp = makeFixtureCorpus({ "061-clean.md": CLEAN_PHASE });
  try {
    const runner = join(tmp, "run-enforce.mjs");
    writeFileSync(
      runner,
      `import { surveyCorpus } from ${JSON.stringify(PREFLIGHT)};\n` +
        `const s = surveyCorpus({ repoRoot: ${JSON.stringify(tmp)} });\n` +
        `process.exit((s.anomalies.length + s.citeAnomalies.length) > 0 ? 1 : 0);\n`,
    );
    const run = spawnSync(process.execPath, [runner], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("surveyCorpus: legacy marker-shape debt at an exempt path diverts out of the gated channel", () => {
  // The core carve-out: a LEGACY_INLINE_EXEMPT_KINDS defect ([legacy-unbold-marker]
  // here) in an exempt plan is suppressed from the --enforce-cites exit (printed as
  // visible debt) instead of blocking it.
  const exemptBase = LEGACY_INLINE_CITE_EXEMPT[0].slice("docs/plans/".length);
  const tmp = makeFixtureCorpus({ [exemptBase]: LEGACY_UNBOLD_PHASE });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.deepEqual(
      survey.citeAnomalies,
      [],
      "exempt legacy debt must not reach the gated channel",
    );
    assert.equal(survey.exemptCiteAnomalies.length, 1, survey.exemptCiteAnomalies.join("\n"));
    assert.match(survey.exemptCiteAnomalies[0], /\[legacy-unbold-marker\]/);
    assert.equal(survey.exemptFiles.length, 1);
    assert.equal(survey.exemptFiles[0].base, exemptBase);
    assert.equal(survey.exemptFiles[0].count, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a cite gate that THREW gates unconditionally, not only under --enforce-cites", () => {
  // A screen that failed to RUN is a structural failure of the survey, not a
  // judgement about cite quality — the same class the outer catch already
  // routes to `anomalies`. Parked in `citeAnomalies` it waited for
  // --enforce-cites to be armed, so a plain `--survey` run exited 0 over a unit
  // that was never screened: a green verdict covering work that did not happen.
  const tmp = makeFixtureCorpus({ "071-gate-throws.md": CLEAN_PHASE });
  try {
    const survey = surveyCorpus({
      repoRoot: tmp,
      runCiteGate: () => {
        throw new Error("synthetic gate explosion");
      },
    });
    assert.equal(
      survey.citeAnomalies.filter((a) => a.includes("[cite-check-threw]")).length,
      0,
      "a thrown gate must not sit in the channel that only gates when armed",
    );
    const structural = survey.anomalies.filter((a) => a.includes("[cite-check-threw]"));
    assert.equal(structural.length, 1, survey.anomalies.join("\n"));
    assert.match(structural[0], /synthetic gate explosion/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("an inline-anchor-floor throw also gates unconditionally", () => {
  // Second catch arm, same policy. Pinned separately because the two screens
  // are independent — the floor deliberately runs even when the cite gate threw.
  const tmp = makeFixtureCorpus({ "072-floor-throws.md": CLEAN_PHASE });
  try {
    const survey = surveyCorpus({
      repoRoot: tmp,
      runInlineAnchorFloor: () => {
        throw new Error("synthetic floor explosion");
      },
    });
    assert.equal(survey.citeAnomalies.filter((a) => a.includes("[cite-check-threw]")).length, 0);
    const structural = survey.anomalies.filter((a) => a.includes("[cite-check-threw]"));
    assert.equal(structural.length, 1, survey.anomalies.join("\n"));
    assert.match(structural[0], /inline anchor floor: synthetic floor explosion/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the injected screens default to the real ones (the seam is test-only)", () => {
  // Guards the seam itself: a default that silently pointed at a no-op would
  // disable the entire cite screen in production while every fixture above
  // still passed. Same fixture, no injection — the real gate must produce the
  // real finding.
  const tmp = makeFixtureCorpus({ "073-real-default.md": BAD_CITE_PLAN });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.ok(
      survey.citeAnomalies.length > 0,
      "the un-injected survey must run the REAL cite gate and find the malformed payload",
    );
    assert.equal(
      survey.anomalies.filter((a) => a.includes("[cite-check-threw]")).length,
      0,
      "the real gate is fail-closed internally and must not throw",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("an exempt plan the survey could NOT read is never ratcheted as re-authored", () => {
  // A plan that fails to scan emits zero cite anomalies, so by COUNT ALONE it
  // is indistinguishable from one that was scanned and found clean. The ratchet
  // acting on that count told the author to delete the exemption — dropping
  // real debt coverage on evidence that was never gathered.
  const exemptBase = LEGACY_INLINE_CITE_EXEMPT[0].slice("docs/plans/".length);
  const tmp = makeFixtureCorpus({ [exemptBase]: LEGACY_UNBOLD_PHASE });
  try {
    // Replace the plan file with a directory of the same name so readFileSync
    // throws EISDIR — a portable way to force the scan to fail.
    const planPath = join(tmp, "docs", "plans", exemptBase);
    rmSync(planPath);
    mkdirSync(planPath);

    const survey = surveyCorpus({ repoRoot: tmp });
    assert.equal(
      survey.uncoveredPlans.length,
      1,
      "fixture must actually fail the scan or it proves nothing",
    );
    assert.equal(survey.uncoveredPlans[0].name, exemptBase);

    assert.deepEqual(
      survey.citeAnomalies.filter((a) => a.includes("[stale-exemption]")),
      [],
      "an unscanned exempt plan must not be ratcheted as clean",
    );
    // It still gates — via the unconditional survey-uncovered channel, so
    // withholding the ratchet verdict hides nothing.
    assert.ok(
      survey.anomalies.some((a) => a.includes("[survey-uncovered]")),
      "the unreadable plan must still gate",
    );
    // The dead-entry detector keeps its meaning: the row is present, flagged.
    assert.equal(survey.exemptFiles.length, 1);
    assert.equal(survey.exemptFiles[0].uncovered, true);
    assert.match(formatSurvey(survey), /not scanned \(see uncovered\) — exemption retained/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("surveyCorpus: a verifier-class defect at an exempt path GATES — the divert is kind-scoped (Codex P1, PR #214)", () => {
  // Regression control for the kind-blind divert: the exemption hides only the
  // legacy marker-SHAPE classes. An extractor/verifier finding (here
  // [unparseable-cite]; [section-not-found] rides the same finding.kind routing)
  // lands in the GATED channel even on an exempt path — and with zero legacy-class
  // debt left, the stale-exemption ratchet fires alongside it.
  const exemptBase = LEGACY_INLINE_CITE_EXEMPT[0].slice("docs/plans/".length);
  const tmp = makeFixtureCorpus({ [exemptBase]: BAD_CITE_PLAN });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.deepEqual(survey.exemptCiteAnomalies, [], "a verifier-class finding must never divert");
    assert.ok(
      survey.citeAnomalies.some((anomaly) => /\[unparseable-cite\]/.test(anomaly)),
      survey.citeAnomalies.join("\n"),
    );
    assert.ok(
      survey.citeAnomalies.some((anomaly) => /\[stale-exemption\]/.test(anomaly)),
      "no legacy-class debt left means the exemption itself is stale",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const LEGACY_INVARIANT_ONLY_PHASE = `### Phase 1 — legacy substrate

#### Tasks

- **T-051p-1-1** (Files: \`packages/a/y.ts\`; Verifies invariant: none) — substrate row with no Spec side, the Plan-023/025 shape.
`;

test("surveyCorpus: a partial phase with zero bold markers is [legacy-markers-partial] (evidence-carrying kind)", () => {
  // The evidence split at emission: partiality proven to come from the legacy
  // inline shape (no bold markers anywhere) gets the legacy kind. At a
  // NON-exempt path both the unbold screen and the legacy partial still gate.
  const tmp = makeFixtureCorpus({ "066-legacy-partial.md": LEGACY_INVARIANT_ONLY_PHASE });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.deepEqual(survey.anomalies, []);
    assert.equal(survey.citeAnomalies.length, 2, survey.citeAnomalies.join("\n"));
    assert.ok(survey.citeAnomalies.some((anomaly) => /\[legacy-unbold-marker\]/.test(anomaly)));
    assert.ok(
      survey.citeAnomalies.some((anomaly) =>
        /\[legacy-markers-partial\] has a Verifies invariant marker but no Spec coverage marker \(all markers unbold/.test(
          anomaly,
        ),
      ),
      survey.citeAnomalies.join("\n"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("surveyCorpus: a bold-marker partial at an exempt path GATES — half-finished restructures cannot ship (Codex P2, PR #214 round 2)", () => {
  // A phase holding ONLY a new bold **Spec coverage:** marker classifies as
  // partial, but the bold marker proves new-grammar authoring, not legacy debt:
  // the kind stays [markers-partial], which is not in LEGACY_INLINE_EXEMPT_KINDS,
  // so it lands in the gated channel even on an exempt path — and with zero
  // diverted legacy debt left, the stale-exemption ratchet fires alongside it.
  const exemptBase = LEGACY_INLINE_CITE_EXEMPT[0].slice("docs/plans/".length);
  const tmp = makeFixtureCorpus({ [exemptBase]: SPEC_ONLY_PHASE });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.deepEqual(survey.exemptCiteAnomalies, [], "a bold-evidence partial must never divert");
    assert.ok(
      survey.citeAnomalies.some((anomaly) =>
        /\[markers-partial\] has a Spec coverage marker but no Verifies invariant marker \(1 bold marker\(s\) present/.test(
          anomaly,
        ),
      ),
      survey.citeAnomalies.join("\n"),
    );
    assert.ok(
      survey.citeAnomalies.some((anomaly) => /\[stale-exemption\]/.test(anomaly)),
      "no diverted legacy debt left means the exemption itself is stale",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("surveyCorpus: the real 023/025 shape (unbold invariant-only) still diverts at an exempt path", () => {
  // Divert control for the evidence split: the live Plan-023/025 Phase-1 shape —
  // inline Verifies-invariant rows, no Spec side, zero bold markers — must keep
  // diverting both its [legacy-unbold-marker] and [legacy-markers-partial] rows,
  // or the split would un-arm the real corpus.
  const exemptBase = LEGACY_INLINE_CITE_EXEMPT[0].slice("docs/plans/".length);
  const tmp = makeFixtureCorpus({ [exemptBase]: LEGACY_INVARIANT_ONLY_PHASE });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.deepEqual(survey.citeAnomalies, [], survey.citeAnomalies.join("\n"));
    assert.equal(survey.exemptCiteAnomalies.length, 2, survey.exemptCiteAnomalies.join("\n"));
    assert.ok(
      survey.exemptCiteAnomalies.some((anomaly) => /\[legacy-unbold-marker\]/.test(anomaly)),
    );
    assert.ok(
      survey.exemptCiteAnomalies.some((anomaly) => /\[legacy-markers-partial\]/.test(anomaly)),
    );
    assert.equal(survey.exemptFiles[0].count, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verifyInlineAnchorFloor: real grammar + salvage discipline (unit — Codex P2, PR #214 round 5)", () => {
  // The floor parses inline payloads with the REAL Gate-4 grammar (after
  // backtick strip) and verifies parsed anchors with the REAL verifier —
  // there is no floor-private token grammar left to under-cover a claim type.
  const tmp = makeFixtureCorpus({});
  const row = (payload) =>
    `### Phase 1 — unit\n\n#### Tasks\n\n- **T-050u-1-1** (Files: \`packages/a/x.ts\`; Verifies invariant: none; Spec coverage: ${payload})\n`;
  try {
    // Backticked cite parses after idiom strip; a parenthetical-qualified
    // heading salvages with zero dropped words (`§Framing` against
    // `## Framing (V1 Pairwise)`) — clean, no finding.
    assert.deepEqual(verifyInlineAnchorFloor(row("`Spec-050 §Framing`"), { repoRoot: tmp }), []);
    // A resolving heading with trailing legacy prose classifies as the
    // divertable tail kind — never silently accepted, never a hard gate here.
    const tail = verifyInlineAnchorFloor(row("Spec-050 §Required Behavior extra words"), {
      repoRoot: tmp,
    });
    assert.equal(tail.length, 1, JSON.stringify(tail));
    assert.equal(tail[0].kind, "legacy-inline-descriptor-tail");
    assert.match(tail[0].evidence, /resolves §Required Behavior with 2 trailing descriptor/);
    // Salvage never skips the anchor's primary claim: the section salvages,
    // but the line anchor re-verifies at full fidelity and still gates.
    const salvagedLine = verifyInlineAnchorFloor(
      row("Spec-050 §Required Behavior step 3 line 999"),
      { repoRoot: tmp },
    );
    assert.equal(salvagedLine.length, 1, JSON.stringify(salvagedLine));
    assert.equal(salvagedLine[0].kind, "inline-anchor-not-found");
    assert.match(salvagedLine[0].evidence, /line-out-of-range/);
    // Plan-NNN has no Gate-4 namespace (shape debt on the bold path), but the
    // floor still existence-checks plan references so a typo'd plan number
    // cannot hide behind the shape divert.
    const planRef = verifyInlineAnchorFloor(
      row("Spec-050 §Required Behavior (extends Plan-999 §Steps)"),
      { repoRoot: tmp },
    );
    assert.equal(planRef.length, 1, JSON.stringify(planRef));
    assert.equal(planRef[0].kind, "inline-doc-missing");
    assert.match(planRef[0].evidence, /Plan-999 — plan file resolves to 0 match/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const LEGACY_BROKEN_ANCHOR_PHASE = `### Phase 1 — legacy inline broken anchor

#### Tasks

- **T-052p-1-1** (Files: \`packages/a/z.ts\`; Verifies invariant: none; Spec coverage: Spec-050 §Definitely Missing) — legacy row whose inline anchor names a phantom section.
`;

test("surveyCorpus: a broken inline anchor at an exempt path GATES via the anchor-existence floor (Codex P2, PR #214 round 3)", () => {
  // The exemption hides marker SHAPE only. An inline payload citing a phantom
  // section lands [inline-anchor-not-found] in the GATED channel while the
  // shape debt still diverts — so the ratchet stays quiet but the armed survey
  // fails on the broken anchor.
  const exemptBase = LEGACY_INLINE_CITE_EXEMPT[0].slice("docs/plans/".length);
  const tmp = makeFixtureCorpus({ [exemptBase]: LEGACY_BROKEN_ANCHOR_PHASE });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.ok(
      survey.citeAnomalies.some((anomaly) =>
        /\[inline-anchor-not-found\].*Spec-050 §Definitely Missing.*section-not-found/.test(
          anomaly,
        ),
      ),
      survey.citeAnomalies.join("\n"),
    );
    assert.ok(
      survey.exemptCiteAnomalies.some((anomaly) => /\[legacy-unbold-marker\]/.test(anomaly)),
      "shape debt still diverts",
    );
    assert.ok(
      !survey.citeAnomalies.some((anomaly) => /\[stale-exemption\]/.test(anomaly)),
      "diverted shape debt keeps the ratchet quiet",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const LEGACY_MISSING_DOC_PHASE = `### Phase 1 — legacy inline missing doc

#### Tasks

- **T-053p-1-1** (Files: \`packages/a/w.ts\`; Verifies invariant: none; Spec coverage: Spec-999 §Anything) — legacy row citing a spec file that does not exist.
`;

test("surveyCorpus: an inline cite naming a missing document GATES [inline-doc-missing] even at an exempt path", () => {
  const exemptBase = LEGACY_INLINE_CITE_EXEMPT[0].slice("docs/plans/".length);
  const tmp = makeFixtureCorpus({ [exemptBase]: LEGACY_MISSING_DOC_PHASE });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.ok(
      survey.citeAnomalies.some((anomaly) =>
        /\[inline-doc-missing\].*Spec-999.*spec-file-not-found/.test(anomaly),
      ),
      survey.citeAnomalies.join("\n"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const LEGACY_TOLERANT_ANCHOR_PHASE = `### Phase 1 — legacy inline tolerant anchors

#### Tasks

- **T-054p-1-1** (Files: \`packages/a/v.ts\`; Verifies invariant: Spec-050 AC2; Spec coverage: \`Spec-050 §Framing\`) — an in-range AC index and a parenthetical-qualified heading both resolve clean.
- **T-054p-1-2** (Files: \`packages/a/v2.ts\`; Verifies invariant: none; Spec coverage: Spec-050 §Required Behavior step 3 (probe)) — a resolving heading with trailing legacy descriptor words.
`;

const LEGACY_PHANTOM_AC_PHASE = `### Phase 1 — legacy inline phantom AC

#### Tasks

- **T-055p-1-1** (Files: \`packages/a/u.ts\`; Verifies invariant: none; Spec coverage: Spec-050 AC999) — legacy row citing an out-of-range acceptance criterion.
`;

test("surveyCorpus: a phantom inline AC index at an exempt path GATES via the floor (Codex P2, PR #214 round 4)", () => {
  // `Spec-050 AC999` resolves the spec file but claims a checkbox bullet that
  // does not exist — the AC leg of the floor routes it through the real AC
  // verifier, so it lands [inline-anchor-not-found] in the GATED channel while
  // the shape debt still diverts.
  const exemptBase = LEGACY_INLINE_CITE_EXEMPT[0].slice("docs/plans/".length);
  const tmp = makeFixtureCorpus({ [exemptBase]: LEGACY_PHANTOM_AC_PHASE });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.ok(
      survey.citeAnomalies.some((anomaly) =>
        /\[inline-anchor-not-found\].*Spec-050 AC999.*ac-index-out-of-range/.test(anomaly),
      ),
      survey.citeAnomalies.join("\n"),
    );
    assert.ok(
      survey.exemptCiteAnomalies.some((anomaly) => /\[legacy-unbold-marker\]/.test(anomaly)),
      "shape debt still diverts",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("surveyCorpus: floor idiom tolerance — clean anchors stay clean; a descriptor tail DIVERTS with its own printed row (Codex P2, PR #214 round 5)", () => {
  // `Spec-050 AC2` and backticked `§Framing` (heading-side parenthetical
  // strip against `## Framing (V1 Pairwise)`, zero dropped words) verify
  // clean. `§Required Behavior step 3` RESOLVES §Required Behavior but drops
  // trailing words — that is no longer silently accepted: it diverts as
  // [legacy-inline-descriptor-tail] beside the shape row, so the tail debt
  // stays visible while the gated channel stays empty at the exempt path.
  const exemptBase = LEGACY_INLINE_CITE_EXEMPT[0].slice("docs/plans/".length);
  const tmp = makeFixtureCorpus({ [exemptBase]: LEGACY_TOLERANT_ANCHOR_PHASE });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.deepEqual(survey.citeAnomalies, [], survey.citeAnomalies.join("\n"));
    assert.equal(survey.exemptCiteAnomalies.length, 2, survey.exemptCiteAnomalies.join("\n"));
    assert.ok(
      survey.exemptCiteAnomalies.some((anomaly) => /\[legacy-unbold-marker\]/.test(anomaly)),
    );
    assert.ok(
      survey.exemptCiteAnomalies.some((anomaly) =>
        /\[legacy-inline-descriptor-tail\].*Required Behavior step 3.*resolves §Required Behavior/.test(
          anomaly,
        ),
      ),
    );
    assert.equal(survey.exemptFiles[0].count, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const LEGACY_LINE_ANCHOR_PHASE = `### Phase 1 — legacy inline line anchor

#### Tasks

- **T-056p-1-1** (Files: \`packages/a/t.ts\`; Verifies invariant: none; Spec coverage: Spec-050 line 999) — legacy row citing a line past the spec's EOF.
`;

test("surveyCorpus: an out-of-range inline line anchor GATES via the real verifier even at an exempt path (Codex P2, PR #214 round 5)", () => {
  // Round 5 finding 1: the walker ignored `line N` tokens, so a phantom line
  // cite was suppressed with the shape. The real grammar parses it as a line
  // anchor and verifyLineAnchor rejects it — [inline-anchor-not-found] gates.
  const exemptBase = LEGACY_INLINE_CITE_EXEMPT[0].slice("docs/plans/".length);
  const tmp = makeFixtureCorpus({ [exemptBase]: LEGACY_LINE_ANCHOR_PHASE });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.ok(
      survey.citeAnomalies.some((anomaly) =>
        /\[inline-anchor-not-found\].*Spec-050 line 999.*line-out-of-range/.test(anomaly),
      ),
      survey.citeAnomalies.join("\n"),
    );
    assert.ok(
      survey.exemptCiteAnomalies.some((anomaly) => /\[legacy-unbold-marker\]/.test(anomaly)),
      "shape debt still diverts",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractInlineCitePayloads: `;` continues the payload unless it introduces a field (Codex P2, PR #214 round 6)", () => {
  // Gate-4's own grammar uses `;` as a segment separator, so a bare
  // continuation stays in the payload and reaches the parser; only a
  // `; <Field>:` intro terminates it.
  const row =
    "- **T1** (Files: a.ts; Verifies invariant: none; Spec coverage: Spec-050 §Framing; Spec-999 §Anything) — prose";
  assert.deepEqual(
    extractInlineCitePayloads(row).map((p) => [p.field, p.payload]),
    [
      ["Verifies invariant", "none"],
      ["Spec coverage", "Spec-050 §Framing; Spec-999 §Anything"],
    ],
  );
});

test("verifyInlineAnchorFloor: secondary existence sweep (unit — Codex P2, PR #214 round 6)", () => {
  // Claims OUTSIDE what the grammar parses — unparsed fragments, post-`;`
  // segments, descriptor text — still existence-verify, deduped against the
  // primary pass so each defect reports exactly once.
  const tmp = makeFixtureCorpus({});
  const row = (payload) =>
    `### Phase 1 — unit\n\n#### Tasks\n\n- **T-050u-1-1** (Files: \`packages/a/x.ts\`; Verifies invariant: none; Spec coverage: ${payload})\n`;
  const floor = (payload) => verifyInlineAnchorFloor(row(payload), { repoRoot: tmp });
  try {
    // A missing doc inside an unparseable `+` continuation gates once (label
    // sweep), with the §-under-missing-spec claim folded into it.
    const mixed = floor("Spec-050 §Required Behavior + Spec-999 §Missing");
    assert.equal(mixed.length, 1, JSON.stringify(mixed));
    assert.match(mixed[0].evidence, /Spec-999 — spec-file-not-found/);
    // A post-`;` segment reaches the parser and its missing doc gates.
    const semicolon = floor("Spec-050 §Framing; Spec-999 §Anything");
    assert.equal(semicolon.length, 1, JSON.stringify(semicolon));
    assert.equal(semicolon[0].kind, "inline-doc-missing");
    assert.match(semicolon[0].evidence, /Spec-999/);
    // Labels swallowed into a parsed anchor's descriptor existence-check.
    const descriptor = floor("Spec-050 §Required Behavior (see ADR-999 and Spec-999)");
    assert.equal(descriptor.length, 2, JSON.stringify(descriptor));
    assert.ok(descriptor.some((f) => /ADR-999 — adr-file-not-found/.test(f.evidence)));
    assert.ok(descriptor.some((f) => /Spec-999 — spec-file-not-found/.test(f.evidence)));
    // A phantom § in an unparsed fragment gates under the sweep's binding.
    const residueSection = floor("Spec-050 AC2 + §Definitely Missing");
    assert.equal(residueSection.length, 1, JSON.stringify(residueSection));
    assert.equal(residueSection[0].kind, "inline-anchor-not-found");
    assert.match(residueSection[0].evidence, /§Definitely Missing.*section-not-found/);
    // A resolving-with-tail § in an unparsed fragment diverts as tail debt.
    const residueTail = floor("Spec-050 AC2 + §Required Behavior step 3");
    assert.equal(residueTail.length, 1, JSON.stringify(residueTail));
    assert.equal(residueTail[0].kind, "legacy-inline-descriptor-tail");
    // Line claims in unparsed fragments verify: an in-range line beside pure
    // shape junk is clean; an out-of-range one gates.
    assert.deepEqual(floor("Spec-050 line 1, junk"), []);
    const residueLine = floor("Spec-050 line 1, then line 999 junk");
    assert.equal(residueLine.length, 1, JSON.stringify(residueLine));
    assert.match(residueLine[0].evidence, /line-out-of-range/);
    // Dedupe: a defect the PRIMARY pass reported is never re-reported by the
    // sweep (negative control for double-reporting).
    assert.equal(floor("Spec-999 §Anything").length, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verifyInlineAnchorFloor: row claims verify against spec table first-column ids (unit — Codex P2, PR #214 round 7)", () => {
  const tmp = makeFixtureCorpus({});
  const row = (payload) =>
    `### Phase 1 — unit\n\n#### Tasks\n\n- **T-050u-1-1** (Files: \`packages/a/x.ts\`; Verifies invariant: none; Spec coverage: ${payload})\n`;
  const floor = (payload) => verifyInlineAnchorFloor(row(payload), { repoRoot: tmp });
  try {
    // Real row ids — numeric and lettered, `+`/`/` list forms — verify clean.
    assert.deepEqual(floor("Spec-050 rows 1 + 7a"), []);
    assert.deepEqual(floor("Spec-050 rows 1/7a"), []);
    // A bogus row id gates per id (the Codex round-7 scenario).
    const bogus = floor("Spec-050 rows 1 + 999");
    assert.equal(bogus.length, 1, JSON.stringify(bogus));
    assert.equal(bogus[0].kind, "inline-anchor-not-found");
    assert.match(bogus[0].evidence, /row 999.*row-not-found/);
    // Prose uses of the word "rows" never tokenize — row ids are digit-led.
    assert.deepEqual(floor("Spec-050 §Required Behavior (the table rows correlate ids)"), []);
    // A row under a missing spec folds into that spec's one doc-missing
    // finding (dedupe parity with §/AC/line).
    assert.equal(floor("Spec-999 rows 1 + 2").length, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const LEGACY_ROW_PHASE = `### Phase 1 — legacy inline row anchors

#### Tasks

- **T-058p-1-1** (Files: \`packages/a/r.ts\`; Verifies invariant: none; Spec coverage: Spec-050 rows 1 + 999) — legacy row citing one real and one phantom table row.
`;

test("surveyCorpus: a phantom table-row cite GATES via the sweep even at an exempt path (Codex P2, PR #214 round 7)", () => {
  const exemptBase = LEGACY_INLINE_CITE_EXEMPT[0].slice("docs/plans/".length);
  const tmp = makeFixtureCorpus({ [exemptBase]: LEGACY_ROW_PHASE });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.ok(
      survey.citeAnomalies.some((anomaly) =>
        /\[inline-anchor-not-found\].*row 999.*row-not-found/.test(anomaly),
      ),
      survey.citeAnomalies.join("\n"),
    );
    assert.ok(
      survey.exemptCiteAnomalies.some((anomaly) => /\[legacy-unbold-marker\]/.test(anomaly)),
      "shape debt still diverts",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const LEGACY_SEMICOLON_PHASE = `### Phase 1 — legacy inline semicolon continuation

#### Tasks

- **T-057p-1-1** (Files: \`packages/a/s.ts\`; Verifies invariant: none; Spec coverage: Spec-050 §Framing; Spec-999 §Anything) — legacy row whose second cite segment sits after a bare semicolon.
`;

test("surveyCorpus: a missing doc after a bare `;` GATES even at an exempt path (Codex P2, PR #214 round 6)", () => {
  const exemptBase = LEGACY_INLINE_CITE_EXEMPT[0].slice("docs/plans/".length);
  const tmp = makeFixtureCorpus({ [exemptBase]: LEGACY_SEMICOLON_PHASE });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.ok(
      survey.citeAnomalies.some((anomaly) => /\[inline-doc-missing\].*Spec-999/.test(anomaly)),
      survey.citeAnomalies.join("\n"),
    );
    assert.ok(
      survey.exemptCiteAnomalies.some((anomaly) => /\[legacy-unbold-marker\]/.test(anomaly)),
      "shape debt still diverts",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verifyInlineAnchorFloor: semantic parse violations gate; shape debt stays silent (unit — Codex P2, PR #214 round 8)", () => {
  // The fixture plan makes `Plan-050` resolve, so the sweep's label check is
  // silent and the grammar's parse failure is provably the ONLY signal.
  const tmp = makeFixtureCorpus({ "050-unit-plan.md": "# Plan-050 unit fixture\n" });
  const row = (payload) =>
    `### Phase 1 — unit\n\n#### Tasks\n\n- **T-050u-1-1** (Files: \`packages/a/x.ts\`; Verifies invariant: none; Spec coverage: ${payload})\n`;
  const floor = (payload) => verifyInlineAnchorFloor(row(payload), { repoRoot: tmp });
  try {
    // A denied Plan-NNN:LLL line cite inside a parsed anchor's descriptor is
    // invisible to the existence sweep (the label resolves; `:243` never
    // tokenizes) — the namespace-violation parse failure gates it (the
    // Codex round-8 scenario).
    const violation = floor("Spec-050 §Required Behavior (see Plan-050:243)");
    assert.equal(violation.length, 1, JSON.stringify(violation));
    assert.equal(violation[0].kind, "inline-cite-violation");
    assert.match(violation[0].evidence, /namespace-violation.*Plan-050:243/);
    // Second parse-time defect class: a Plan-local row ID cited as a Spec
    // anchor gates through the same routing.
    const planLocal = floor("Spec-050 C3");
    assert.equal(planLocal.length, 1, JSON.stringify(planLocal));
    assert.equal(planLocal[0].kind, "inline-cite-violation");
    assert.match(planLocal[0].evidence, /plan-local-id-as-spec-anchor/);
    // Shape-class parse failures (unparseable continuation prose) stay
    // silent at the floor — that debt is the marker-shape divert's job.
    assert.deepEqual(floor("Spec-050 §Required Behavior + banner content extension"), []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verifyInlineAnchorFloor: salvage-dropped tails are scanned for claims (unit — Codex P2, PR #214 round 8)", () => {
  const tmp = makeFixtureCorpus({});
  const row = (payload) =>
    `### Phase 1 — unit\n\n#### Tasks\n\n- **T-050u-1-1** (Files: \`packages/a/x.ts\`; Verifies invariant: none; Spec coverage: ${payload})\n`;
  const floor = (payload) => verifyInlineAnchorFloor(row(payload), { repoRoot: tmp });
  try {
    // The Codex round-8 scenario: a checkable label swallowed into the
    // salvaged section's dropped tail gates instead of hiding behind the
    // divertable tail classification.
    const hidden = floor("Spec-050 §Required Behavior and Spec-999 §Missing");
    assert.equal(hidden.length, 2, JSON.stringify(hidden));
    assert.ok(hidden.some((f) => f.kind === "legacy-inline-descriptor-tail"));
    assert.ok(
      hidden.some((f) => f.kind === "inline-doc-missing" && /Spec-999/.test(f.evidence)),
      JSON.stringify(hidden),
    );
    // A prose-only tail stays pure formatting debt — the scan adds nothing.
    const prose = floor("Spec-050 §Required Behavior step 3");
    assert.equal(prose.length, 1, JSON.stringify(prose));
    assert.equal(prose[0].kind, "legacy-inline-descriptor-tail");
    // The scan runs even when the anchor's primary claim fails: a failing
    // line does not absolve the tail's claims.
    const both = floor("Spec-050 §Required Behavior and Spec-999 §Missing line 999");
    assert.equal(both.length, 2, JSON.stringify(both));
    assert.ok(both.some((f) => /line-out-of-range/.test(f.evidence)));
    assert.ok(
      both.some((f) => f.kind === "inline-doc-missing" && /Spec-999/.test(f.evidence)),
      JSON.stringify(both),
    );
    // Residue-§ tails found only by the sweep get the same scan (recursion).
    const residue = floor("Spec-050 AC2 + §Required Behavior and Spec-999 §Missing");
    assert.equal(residue.length, 2, JSON.stringify(residue));
    assert.ok(residue.some((f) => f.kind === "legacy-inline-descriptor-tail"));
    assert.ok(
      residue.some((f) => f.kind === "inline-doc-missing" && /Spec-999/.test(f.evidence)),
      JSON.stringify(residue),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const LEGACY_VIOLATION_PHASE = `### Phase 1 — legacy inline namespace violation

#### Tasks

- **T-059p-1-1** (Files: \`packages/a/v.ts\`; Verifies invariant: none; Spec coverage: Spec-050 §Required Behavior (see Plan-007:243)) — legacy row whose descriptor smuggles a denied Plan line cite.
`;

test("surveyCorpus: a namespace-violation parse failure GATES even at an exempt path (Codex P2, PR #214 round 8)", () => {
  const exemptBase = LEGACY_INLINE_CITE_EXEMPT[0].slice("docs/plans/".length);
  const tmp = makeFixtureCorpus({ [exemptBase]: LEGACY_VIOLATION_PHASE });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.ok(
      survey.citeAnomalies.some((anomaly) =>
        /\[inline-cite-violation\].*namespace-violation/.test(anomaly),
      ),
      survey.citeAnomalies.join("\n"),
    );
    assert.ok(
      survey.exemptCiteAnomalies.some((anomaly) => /\[legacy-unbold-marker\]/.test(anomaly)),
      "shape debt still diverts",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const LEGACY_TAIL_LABEL_PHASE = `### Phase 1 — legacy inline tail-hidden label

#### Tasks

- **T-060p-1-1** (Files: \`packages/a/t.ts\`; Verifies invariant: none; Spec coverage: Spec-050 §Required Behavior and Spec-999 §Missing) — legacy row whose descriptor tail swallows a missing document label.
`;

test("surveyCorpus: a label hidden in a salvage-dropped tail GATES even at an exempt path (Codex P2, PR #214 round 8)", () => {
  const exemptBase = LEGACY_INLINE_CITE_EXEMPT[0].slice("docs/plans/".length);
  const tmp = makeFixtureCorpus({ [exemptBase]: LEGACY_TAIL_LABEL_PHASE });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.ok(
      survey.citeAnomalies.some((anomaly) => /\[inline-doc-missing\].*Spec-999/.test(anomaly)),
      survey.citeAnomalies.join("\n"),
    );
    assert.ok(
      survey.exemptCiteAnomalies.some((anomaly) =>
        /\[legacy-inline-descriptor-tail\]/.test(anomaly),
      ),
      "the tail itself still diverts",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("surveyCorpus: a descriptor tail at a NON-exempt path GATES (divert is exempt-list-scoped)", () => {
  // The new kind rides the same kind-scoped divert as the shape kinds: at any
  // path outside LEGACY_INLINE_CITE_EXEMPT it lands in the gated channel.
  const tmp = makeFixtureCorpus({ "064-legacy.md": LEGACY_TOLERANT_ANCHOR_PHASE });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.ok(
      survey.citeAnomalies.some((anomaly) =>
        /\[legacy-inline-descriptor-tail\].*Required Behavior step 3/.test(anomaly),
      ),
      survey.citeAnomalies.join("\n"),
    );
    assert.ok(
      survey.citeAnomalies.some((anomaly) => /\[legacy-unbold-marker\]/.test(anomaly)),
      "shape gates at non-exempt paths too",
    );
    assert.deepEqual(survey.exemptCiteAnomalies, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("surveyCorpus: a clean plan at an exempt path trips the stale-exemption ratchet (armed exit 1)", () => {
  // Negative control for the exemption path: an exempt plan re-authored clean must
  // NOT silently keep its carve-out. The survey emits a gated [stale-exemption]
  // anomaly, so a "fake-exempt clean file" fails under --enforce-cites — forcing the
  // list entry's removal rather than letting the exemption outlive its debt.
  const exemptBase = LEGACY_INLINE_CITE_EXEMPT[0].slice("docs/plans/".length);
  const tmp = makeFixtureCorpus({ [exemptBase]: CLEAN_PHASE });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.equal(survey.citeAnomalies.length, 1, survey.citeAnomalies.join("\n"));
    assert.match(survey.citeAnomalies[0], /\[stale-exemption\] exempt plan scans clean/);
    assert.deepEqual(survey.exemptCiteAnomalies, []); // nothing to divert — it's clean
    const runner = join(tmp, "run-enforce.mjs");
    writeFileSync(
      runner,
      `import { surveyCorpus } from ${JSON.stringify(PREFLIGHT)};\n` +
        `const s = surveyCorpus({ repoRoot: ${JSON.stringify(tmp)} });\n` +
        `process.exit((s.anomalies.length + s.citeAnomalies.length) > 0 ? 1 : 0);\n`,
    );
    const armed = spawnSync(process.execPath, [runner], { encoding: "utf8" });
    assert.equal(armed.status, 1, "a clean exempt plan must fail the armed survey");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("preflight --survey --enforce-cites: real corpus exits 0 with zero gated cite anomalies (armed)", () => {
  // The load-bearing arming guard, matching the docs-corpus CI step. It asserted
  // exit 0 while the survey was skipping 9 of 28 plans outright — the false-clean
  // verdict the coverage fix closed by surfacing 53 real findings. Those are now
  // healed (see the KNOWN-clean note above), so the armed exit is 0 again — this
  // time on a sweep that actually reaches all 28 plans. The `0 uncovered` +
  // `cite anomalies: none` pair is what makes the green meaningful: either alone
  // is satisfiable by a sweep that simply skipped the work.
  const run = spawnSync(process.execPath, [PREFLIGHT, "--survey", "--enforce-cites"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /distribution:/);
  assert.ok(run.stdout.endsWith("\n"), "report truncated mid-line — stdout was not drained");
  assert.match(run.stdout, /^cite anomalies: none$/m);
  assert.match(run.stdout, /cite-exempt \(legacy-inline, \d+ plan\(s\)/);
  // Coverage is a first-class number on every run, and the residual stays at zero.
  assert.match(run.stdout, /^coverage: (\d+)\/\1 plan\(s\) cite-swept, 0 uncovered$/m);
});

test("preflight --survey: an over-pipe-buffer report drains fully (no mid-line truncation)", () => {
  // Pipe-drain regression guard, relocated off the real corpus. spawnSync reads
  // stdout through a PIPE, where Node's writes are async; the old
  // `process.exit()` discarded the buffer and cut the report at 8192 bytes
  // mid-line, losing the whole trailing `cite-exempt` visible-debt block on
  // exactly the failing runs CI reads. The fix is `process.exitCode` + return.
  //
  // The healed real-corpus report is ~5 KB — under the observed pipe boundary,
  // so it can no longer exercise the path. Rather than drop the guard, the CLI
  // is COPIED into a temp repo root (a symlink would not work: ESM resolves
  // `import.meta.url` through symlinks, so the copy's derived REPO_ROOT would
  // snap back to the real repo) over a synthetic corpus large enough to push
  // the report well past 8192 bytes. This exercises the real `main()` survey
  // branch, not a shim.
  // realpathSync is load-bearing: preflight.mjs guards `main()` on
  // `process.argv[1] === fileURLToPath(import.meta.url)`, and macOS resolves
  // `/var/folders/…` (what mkdtempSync returns) to `/private/var/folders/…`
  // (what ESM reports). Spawning the unresolved path makes the CLI a silent
  // no-op that exits 0 with empty stdout.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "survey-drain-")));
  try {
    const scriptsDir = join(root, ".claude", "skills", "plan-execution", "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    cpSync(resolve(__dirname, ".."), scriptsDir, {
      recursive: true,
      filter: (src) => !src.includes("__tests__"),
    });
    const plansDir = join(root, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    // Each plan contributes a long-titled phase line plus a cite anomaly line;
    // 40 of them clear the boundary with margin on any platform.
    for (let index = 0; index < 40; index += 1) {
      const number = String(100 + index).padStart(3, "0");
      writeFileSync(
        join(plansDir, `${number}-drain-fixture-plan-with-a-deliberately-long-name.md`),
        `### Phase 1 — drain fixture phase with a deliberately long title\n\n` +
          `#### Tasks\n\n- **T1.1 — drain fixture task with a deliberately long title**\n` +
          `  - **Spec coverage:** prose that matches no namespace pattern whatsoever\n` +
          `  - **Verifies invariant:** none (drain fixture)\n`,
      );
    }
    const copiedPreflight = join(scriptsDir, "preflight.mjs");
    const run = spawnSync(process.execPath, [copiedPreflight, "--survey"], { encoding: "utf8" });
    // Drain-completeness first. Under the `process.exit()` regression the report
    // is cut exactly AT the pipe boundary, so a leading size assertion fires with
    // "report too small" — diagnosing a shrunken FIXTURE when the CLI is what
    // regressed. Ordering the semantic checks ahead of the adequacy check keeps
    // the failure message pointed at the real cause.
    assert.ok(run.stdout.endsWith("\n"), "report truncated mid-line — stdout was not drained");
    // The trailing block is the one the truncation used to eat; assert the tail
    // is structurally complete, not merely newline-terminated.
    assert.match(run.stdout, /cite anomalies \(\d+\) \[warn-only/);
    // Fixture adequacy last: a report under the boundary cannot exercise the path
    // at all, so a shrunken corpus must fail loudly rather than pass vacuously.
    assert.ok(
      Buffer.byteLength(run.stdout) > 8192,
      `report too small to exercise the pipe-drain path (${Buffer.byteLength(run.stdout)} bytes)`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight --survey --enforce-cites <plan>: still rejects an extra positional (exit 2)", () => {
  const run = spawnSync(
    process.execPath,
    [PREFLIGHT, "--survey", "--enforce-cites", "docs/plans/001-shared-session-core.md"],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stderr, /runs alone/);
});

// ---------- intra-plan coverage: markers outside every phase section ----------
//
// `N/M plan(s) cite-swept, 0 uncovered` counts PLANS, and a plan counts as swept
// the moment ONE survey unit exists. Units were once phase sections ONLY, so a
// bold cite marker under a non-`Phase` `###` heading sat inside a counted plan
// and outside every unit — never screened, yet reported as covered. That is
// CAT-10: a gate reporting clean over work it did not do. The whole-document
// fallback cannot rescue it either — that fires only at `surveyUnits.length === 0`,
// so a single `### Phase N` heading pins the plan to the per-phase path forever.
//
// The complement path closes it: phase spans and their set-difference partition
// the plan source, so every marker now lands in some unit and IS screened. The
// discriminator is POSITION, not heading shape — deriving the complement by
// subtraction rather than by matching a heading grammar is what makes it
// exhaustive against the next spelling nobody predicted.
//
// This test pins BOTH directions, because either alone is satisfiable by a
// no-op: that the complement's markers really are screened (phantom cites in
// the out-of-phase block DO raise anomalies), and that a phase-only screen
// provably CANNOT reach them (the markers lie outside every phase span). The
// printed `complement` count is the screen's must-not-be-zero denominator —
// without it a complement regressed to a no-op reads exactly like a clean run.

// Mirrors the real Plan-025 layout: the carve-out sections sit BEFORE the only
// `### Phase N` heading. Ordering is load-bearing — `extractPhaseSection` runs a
// phase to EOF, so the same two sections placed AFTER Phase 1 would be swallowed
// into its span and swept. `### Tier-7 Remainder — …` is prose, not a remainder
// LABEL: the remainder walk matches `### Phase R1` / `### Phase 7A` only.
const PARTIALLY_SWEPT_PLAN = `### Tier-7 Remainder — carve-out narrative

#### Tasks

- **T-R-1 — a task OUTSIDE every phase section**
  - **Spec coverage:** Spec-999 §Nonexistent Section
  - **Verifies invariant:** Spec-999 §Also Nonexistent

### Phase 1 — swept work

#### Tasks

- **T1.1 — a task inside a phase section**
  - **Spec coverage:** Spec-050 §Required Behavior
  - **Verifies invariant:** Spec-050 §Framing (V1 Pairwise)
`;

test("surveyCorpus: bold markers outside every phase section ARE screened via the complement", () => {
  const tmp = makeFixtureCorpus({ "065-partially-swept.md": PARTIALLY_SWEPT_PLAN });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });

    // DIRECTION 1 — the complement really screens. The out-of-phase block cites
    // a nonexistent spec; if those markers are reached, that phantom surfaces.
    // This is the assertion the pre-complement gate failed: it returned clean
    // over a block holding two unresolvable cites.
    const phantoms = survey.citeAnomalies.filter((a) => a.includes("Spec-999"));
    assert.ok(
      phantoms.length > 0,
      `expected the complement screen to surface the out-of-phase Spec-999 phantoms, got none. ` +
        `All anomalies: ${JSON.stringify(survey.citeAnomalies)}`,
    );

    // DIRECTION 2 — negative control. A phase-only screen provably cannot reach
    // them: the markers sit outside every phase span, so their being surfaced
    // above is attributable to the complement and to nothing else. Without this
    // half, direction 1 would also pass if the markers had silently migrated
    // into a phase section.
    const phaseOne = extractPhaseSection(PARTIALLY_SWEPT_PLAN, 1);
    assert.ok(phaseOne, "fixture must expose a locatable Phase 1 span");
    assert.ok(
      !phaseOne.includes("Spec-999"),
      "fixture invariant broken: the phantom cites must lie OUTSIDE Phase 1, " +
        "otherwise the phase path alone would surface them and the complement is untested",
    );

    // The screen's must-not-be-zero denominator: 2 of the plan's 4 markers were
    // screened through 1 complement unit. A complement that regressed to a no-op
    // would zero this while every other line of output stayed identical.
    const entry = survey.complementMarkerPlans.find((p) => p.name === "065-partially-swept.md");
    assert.ok(
      entry,
      `expected a complement-screened entry, got ${JSON.stringify(survey.complementMarkerPlans)}`,
    );
    assert.equal(entry.total, 4);
    assert.equal(entry.complement, 2);
    assert.equal(entry.units, 1);

    // Plan-granular coverage still reads 1/1 — but it is no longer an over-claim,
    // because the complement line below it discloses the marker-level denominator
    // the plan count cannot express.
    const text = formatSurvey(survey);
    assert.match(text, /coverage: 1\/1 plan\(s\) cite-swept, 0 uncovered/);
    assert.match(
      text,
      /Gate-4 markers OUTSIDE every `### Phase N` section — screened via the complement path \(1 plan\(s\), 2 marker\(s\)\)/,
    );
    assert.match(text, /065-partially-swept\.md: 2 of 4 marker\(s\) in 1 complement unit\(s\)/);

    // Phase spans and their complement PARTITION the source, so nothing may be
    // left over. A non-empty unswept residual means the partition leaked.
    assert.deepEqual(survey.unsweptMarkerPlans ?? [], []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// A complement holding exactly ONE Gate-4 field. The pair requirement is right
// for a phase (one marker = partial audit output) and wrong for a complement,
// which has no audit output at all — there it silently skipped anchor parsing
// entirely, so the phantom below was screened by nothing while the report
// counted its marker as swept. CAT-10 reproduced inside the CAT-10 fix
// (Codex P1, PR #262 round 1).
const ONE_SIDED_COMPLEMENT_PLAN = `### Tier-7 Remainder — carve-out narrative

#### Tasks

- **T-R-1 — a task OUTSIDE every phase, carrying ONE field only**
  - **Spec coverage:** Spec-999 §Nonexistent Section

### Phase 1 — swept work

#### Tasks

- **T1.1 — a task inside a phase section**
  - **Spec coverage:** Spec-050 §Required Behavior
  - **Verifies invariant:** Spec-050 §Framing (V1 Pairwise)
`;

test("surveyCorpus: a ONE-SIDED complement marker still has its anchors verified", () => {
  const tmp = makeFixtureCorpus({ "067-one-sided-complement.md": ONE_SIDED_COMPLEMENT_PLAN });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });

    // The finding class. Before the marker-floor split this was empty: the
    // both-markers-required guard returned before extractCiteAnchors ran, so a
    // cite naming a spec that does not exist produced no anomaly and
    // --enforce-cites exited 0.
    const phantoms = survey.citeAnomalies.filter((a) => a.includes("Spec-999"));
    assert.ok(
      phantoms.length > 0,
      `a lone **Spec coverage:** marker outside every phase must still have its ` +
        `anchor verified; got: ${JSON.stringify(survey.citeAnomalies)}`,
    );

    // The deliberate exclusion, pinned so a later "just run both checks
    // everywhere" simplification cannot quietly take it. W3 partial-marker
    // asserts a property of AUDIT OUTPUT, and a complement has none — firing it
    // here would report a partial audit that never happened.
    const partial = survey.citeAnomalies.filter((a) => a.includes("markers-partial"));
    assert.deepEqual(
      partial,
      [],
      `partial-marker is a phase-only predicate; a complement must not be judged ` +
        `on marker-pair completeness. Got: ${JSON.stringify(partial)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("gateTasksBlockCites: the DISPATCH path still requires the complete marker pair", () => {
  // The other half of the asymmetry. Relaxing the floor for complements must not
  // relax it for phases — a phase Tasks block carrying one marker is a partial
  // audit, and "audit has not run" stays the correct dispatch read.
  const oneSidedPhase = `#### Tasks

- **T1.1 — task**
  - **Spec coverage:** Spec-050 §Required Behavior
`;

  const dispatch = gateTasksBlockCites(oneSidedPhase, "050", 1);
  assert.equal(dispatch.hasCiteMarkers, false, "phase default must keep the pair requirement");
  assert.deepEqual(dispatch.findings, []);

  // Same input, complement semantics: the lone marker now clears the floor and
  // its anchors are parsed and judged.
  const complement = gateTasksBlockCites(oneSidedPhase, "050", 1, { requireBothMarkers: false });
  assert.equal(complement.hasCiteMarkers, true, "complement must verify whichever markers exist");
});

test("surveyCorpus: a plan whose markers all sit inside phases reports NO unswept residual", () => {
  // Negative control — the counter must key on marker placement, not merely on
  // a plan having more than one `###` heading.
  const tmp = makeFixtureCorpus({
    "066-fully-swept.md": `### Phase 1 — all markers inside

#### Tasks

- **T1.1 — task**
  - **Spec coverage:** Spec-050 §Required Behavior
  - **Verifies invariant:** Spec-050 §Framing (V1 Pairwise)

### Phase 2 — also inside

#### Tasks

- **T2.1 — task**
  - **Spec coverage:** Spec-050 §Required Behavior
  - **Verifies invariant:** Spec-050 §Framing (V1 Pairwise)
`,
  });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.deepEqual(survey.unsweptMarkerPlans, []);
    assert.doesNotMatch(formatSurvey(survey), /OUTSIDE every survey unit/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("surveyCorpus: REAL corpus — the unswept-marker residual is reported, never silent", () => {
  // Corpus tripwire. The residual is a known, deliberately-unclosed gap (closing
  // it needs a grammar decision, since most of the hidden cites are accurate
  // corpus idiom the grammar cannot yet express). What must NOT happen is the
  // gap going quiet: either it is reported with real numbers, or it is genuinely
  // zero. A silently-emptied `unsweptMarkerPlans` would restore the exact
  // over-claim this counter was added to end.
  const survey = surveyCorpus({ repoRoot: REPO_ROOT });
  const text = formatSurvey(survey);
  if (survey.unsweptMarkerPlans.length === 0) {
    assert.doesNotMatch(text, /OUTSIDE every survey unit/);
    return;
  }
  for (const { name, unswept, total } of survey.unsweptMarkerPlans) {
    assert.match(name, /^\d{3}-.+\.md$/);
    assert.ok(
      unswept > 0 && unswept <= total,
      `${name}: ${unswept}/${total} is not a sane residual`,
    );
  }
  const totalUnswept = survey.unsweptMarkerPlans.reduce((sum, plan) => sum + plan.unswept, 0);
  assert.match(
    text,
    new RegExp(
      `\\(${survey.unsweptMarkerPlans.length} plan\\(s\\), ${totalUnswept} marker\\(s\\)\\)`,
    ),
  );
});

test("surveyCorpus: the SAME carve-out placed after the last phase is swallowed and swept", () => {
  // Ordering discriminator for the residual. `extractPhaseSection` runs a phase
  // heading to EOF, so an identical non-phase `###` section trailing the last
  // phase falls INSIDE that phase's span and is genuinely screened — the residual
  // is a function of layout, not of the heading text. Pinning both directions
  // keeps the counter from being read as "every non-phase heading is a gap", and
  // documents why the fixture above orders its sections the way Plan-025 does.
  const tmp = makeFixtureCorpus({
    "067-carveout-trailing.md": `### Phase 1 — swept work

#### Tasks

- **T1.1 — a task inside a phase section**
  - **Spec coverage:** Spec-050 §Required Behavior
  - **Verifies invariant:** Spec-050 §Framing (V1 Pairwise)

### Tier-7 Remainder — carve-out narrative

#### Tasks

- **T-R-1 — trailing carve-out, inside Phase 1's span**
  - **Spec coverage:** Spec-999 §Nonexistent Section
  - **Verifies invariant:** Spec-999 §Also Nonexistent
`,
  });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.deepEqual(survey.unsweptMarkerPlans, []);
    // Genuinely screened, not merely uncounted: the phantom spec in the trailing
    // carve-out produces a real anomaly. This is the assertion that separates
    // "swept" from "silently skipped" — without it the test would pass equally
    // well if the section had been dropped.
    assert.ok(
      survey.citeAnomalies.some((a) => a.includes("Spec-999")),
      `expected the trailing carve-out's phantom cites to be caught, got ${survey.citeAnomalies.join("\n")}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- a screen that THREW is not a screen that passed ----------

// One phase, one well-formed task, real markers: nothing here is malformed, so
// every finding below comes from the injected failure and not from the fixture.
const HEALTHY_PLAN =
  "### Phase 1 — real work\n\n#### Tasks\n\n" +
  "- **T1.1 — a task** (Files: packages/a/src/x.ts)\n\n" +
  "  **Spec coverage:** Spec-050 §Required Behavior\n\n" +
  "  **Verifies invariant:** I-050-1\n";

test("surveyCorpus: a cite screen that THREW leaves its plan uncovered, not swept", () => {
  // The generalized defect this PR exists to close, found once more in the very
  // screen that closes it. The catch recorded a `[cite-check-threw]` anomaly —
  // so the run does gate — but left the plan inside `surveyedPlanCount`, so the
  // coverage line still read `1/1 plan(s) cite-swept` over a screen that never
  // ran, and `markerlessPlans` additionally labelled the unrun screen a vacuous
  // pass (Codex P2, PR #260 round 2).
  const tmp = makeFixtureCorpus({ "069-throwing-screen.md": HEALTHY_PLAN });
  try {
    const survey = surveyCorpus({
      repoRoot: tmp,
      runCiteGate: () => {
        throw new Error("injected screen failure");
      },
    });
    assert.equal(survey.planCount, 1);
    assert.equal(survey.surveyedPlanCount, 0, "a plan whose screen threw is NOT cite-swept");
    assert.deepEqual(
      survey.uncoveredPlans.map((plan) => plan.name),
      ["069-throwing-screen.md"],
    );
    assert.ok(
      survey.anomalies.some((anomaly) => anomaly.includes("[cite-check-threw]")),
      `expected a [cite-check-threw] anomaly, got ${survey.anomalies.join("\n")}`,
    );
    assert.deepEqual(survey.markerlessPlans, [], "an unrun screen is not a vacuous pass");
    const text = formatSurvey(survey);
    assert.match(text, /coverage: 0\/1 plan\(s\) cite-swept, 1 uncovered/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("surveyCorpus: an exempt plan whose screen threw is not called re-authored", () => {
  // The sharpest edge of the same bug. The stale-exemption ratchet fires when an
  // exempt plan emits ZERO cite findings — "re-authored clean, delete the
  // entry". A screen that threw emits zero findings in exactly the same way, so
  // the ratchet would advise deleting a live exemption on evidence that was
  // never gathered, dropping real debt coverage. The guard for this already
  // existed for the OUTER per-plan catch (`uncoveredPlanNames`); the per-unit
  // cite-screen catch walked straight past it.
  const exemptName = LEGACY_INLINE_CITE_EXEMPT[0].slice("docs/plans/".length);
  const tmp = makeFixtureCorpus({ [exemptName]: HEALTHY_PLAN });
  try {
    const survey = surveyCorpus({
      repoRoot: tmp,
      runCiteGate: () => {
        throw new Error("injected screen failure");
      },
    });
    assert.deepEqual(
      survey.citeAnomalies.filter((anomaly) => anomaly.includes("[stale-exemption]")),
      [],
      "an exemption must not be declared stale on a screen that never ran",
    );
    // The row is still PRINTED — `exemptFiles.length` is the dead-entry detector
    // for a renamed or removed exempt plan, so only the verdict is withheld.
    assert.equal(survey.exemptFiles.length, 1);
    assert.equal(survey.exemptFiles[0].uncovered, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- a fenced example is illustration, not audit output ----------

const FENCED_EXAMPLE_ONLY_PLAN = `# Plan-068: Fenced Example Only

## Overview

No \`### Phase N\` headings, so this plan takes the whole-document fallback.
Its only cite markers live inside a fenced example block.

\`\`\`markdown
- **T-068r-1-1 — illustrative task** (Files: packages/x/src/a.ts)

  **Spec coverage:** Spec-050 §Required Behavior

  **Verifies invariant:** I-050-1
\`\`\`
`;

test("surveyCorpus: fenced example markers do not make a plan look audited", () => {
  // Passing the complete source as the fallback unit let the raw marker regexes
  // read a ```markdown example as audit output: the plan reported cite-swept,
  // non-vacuous and anomaly-free, and the screen even VERIFIED the example's
  // cites against real spec files — a complete false clean (Codex P2, PR #260
  // round 2). Marker detection and cite extraction are now fence-masked.
  const tmp = makeFixtureCorpus({ "068-fenced-only.md": FENCED_EXAMPLE_ONLY_PLAN });
  try {
    const survey = surveyCorpus({ repoRoot: tmp });
    assert.deepEqual(
      survey.markerlessPlans,
      ["068-fenced-only.md"],
      "a plan whose only markers are fenced has NO audit output to verify",
    );
    assert.match(formatSurvey(survey), /vacuous pass \(1\): 068-fenced-only\.md/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("classifyPhaseMarkers ignores fenced markers but still counts real ones", () => {
  // The isolating control: identical marker text, once fenced and once not.
  const markerBody = "**Spec coverage:** Spec-050 §Required Behavior\n";
  assert.deepEqual(classifyPhaseMarkers(markerBody), {
    boldSpec: 1,
    boldInvariant: 0,
    unboldSpec: 0,
    unboldInvariant: 0,
  });
  assert.deepEqual(classifyPhaseMarkers("```markdown\n" + markerBody + "```\n"), {
    boldSpec: 0,
    boldInvariant: 0,
    unboldSpec: 0,
    unboldInvariant: 0,
  });
});
