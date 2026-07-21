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
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
    assert.equal(survey.phaseCount, 1);
    assert.equal(survey.notices.length, 1);
    assert.match(survey.notices[0], /050-cluster-shaped\.md/);
    assert.deepEqual(survey.anomalies, []);
    const text = formatSurvey(survey);
    assert.match(text, /notices \(1\):/);
    assert.match(text, /anomalies: none/);
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

test("surveyCorpus: REAL corpus — gated cite anomalies clean; legacy-inline debt diverted + visible", () => {
  const survey = surveyCorpus({ repoRoot: REPO_ROOT });
  // The gated channel (what --enforce-cites folds into the exit) is empty: the
  // healed plans carry no cite anomaly, the two compact-inline plans divert out,
  // and no exemption has gone stale. A regression in any of those lands right here.
  assert.deepEqual(
    survey.citeAnomalies,
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

test("preflight --survey --enforce-cites: real corpus exits 0 (armed — clean under enforcement)", () => {
  // The load-bearing arming guard, matching the docs-corpus CI step. With the
  // eight-plan cite heals landed and the two compact-inline plans diverted via
  // LEGACY_INLINE_CITE_EXEMPT, the live corpus has zero GATED cite anomalies, so the
  // armed survey exits 0. A future non-exempt plan gaining a cite defect — or an
  // exempt plan re-authored clean (the stale-exemption ratchet) — flips this to
  // exit 1: enforcement doing its job. The exempt block always prints so the
  // remaining legacy-inline debt stays visible.
  const run = spawnSync(process.execPath, [PREFLIGHT, "--survey", "--enforce-cites"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /distribution:/);
  assert.match(run.stdout, /cite-exempt \(legacy-inline, \d+ plan\(s\)/);
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
