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

import { surveyPhase, surveyCorpus, formatSurvey } from "../preflight.mjs";

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

test("preflight --survey --enforce-cites: flag is accepted alongside --survey", () => {
  // Real-CLI arg-parsing check (not an enforcement check): the flag must not
  // trip the mixed-invocation guard. Robust to corpus state — asserts the
  // survey ran and was not rejected, never a specific exit code.
  const run = spawnSync(process.execPath, [PREFLIGHT, "--survey", "--enforce-cites"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  assert.notEqual(run.status, 2, run.stdout + run.stderr);
  assert.doesNotMatch(run.stderr, /runs alone/);
  assert.match(run.stdout, /distribution:/);
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
