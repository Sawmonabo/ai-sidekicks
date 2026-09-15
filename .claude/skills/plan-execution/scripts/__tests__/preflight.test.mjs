import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../preflight.mjs");

// A throwaway git repo with one plan and a controllable history.
function makeRepo({ status = "ready", shippedSubjects = [], boldPreconditions = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "preflight-"));
  const run = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  run(["init", "-q"]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  mkdirSync(path.join(root, "docs/plans"), { recursive: true });
  // The plan template writes the precondition line bare; every real plan in
  // the corpus writes it bold, so both spellings are built here.
  const phaseTwoPrecondition = boldPreconditions
    ? "**Precondition:** Plan-003 Phase 1 merged."
    : "Precondition: Plan-003 Phase 1 merged.";
  writeFileSync(
    path.join(root, "docs/plans/003-queue.md"),
    `# Plan-003: Queue\n\n| **Status** | \`${status}\` |\n\n## Phases\n\n### Phase 1 — Queue core\n\nPrecondition: none.\n\n### Phase 2 — Steer\n\n${phaseTwoPrecondition}\n`,
  );
  run(["add", "."]);
  run(["commit", "-q", "-m", "docs(repo): add plan"]);
  for (const subject of shippedSubjects) {
    writeFileSync(path.join(root, "x.txt"), subject);
    run(["add", "."]);
    run(["commit", "-q", "-m", subject]);
  }
  return root;
}

// A repo whose history straddles a plan-renumber commit: `oldEraSubjects` are
// committed under the OLD numbering, then a boundary commit, then the rest.
// The returned SHA is what `PREFLIGHT_RENUMBER_COMMIT` points the tool at.
function makeRenumberedRepo({ oldEraSubjects = [], newEraSubjects = [] } = {}) {
  const root = makeRepo();
  const run = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  // A second plan whose number was retired by the renumbering.
  writeFileSync(
    path.join(root, "docs/plans/008-retired.md"),
    "# Plan-008: Retired\n\n| **Status** | `ready` |\n\n## Phases\n\n### Phase 1 — Work\n\nPrecondition: none.\n",
  );
  run(["add", "."]);
  run(["commit", "-q", "-m", "docs(repo): add the second plan"]);
  const commitSubject = (subject) => {
    writeFileSync(path.join(root, "x.txt"), subject);
    run(["add", "."]);
    run(["commit", "-q", "-m", subject]);
  };
  for (const subject of oldEraSubjects) commitSubject(subject);
  writeFileSync(path.join(root, "renumber.txt"), "renumbered");
  run(["add", "."]);
  run(["commit", "-q", "-m", "docs(repo): renumber the plan corpus contiguously"]);
  const boundary = run(["rev-parse", "HEAD"]).stdout.trim();
  for (const subject of newEraSubjects) commitSubject(subject);
  return { root, boundary };
}

function preflight(root, args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("ready plan, unshipped phase, no precondition: exit 0", () => {
  const root = makeRepo();
  const r = preflight(root, ["docs/plans/003-queue.md", "1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok: plan is ready/);
  assert.match(r.stdout, /ok: phase 1 not in git log/);
});

test("draft plan: exit 1", () => {
  const root = makeRepo({ status: "draft" });
  const r = preflight(root, ["docs/plans/003-queue.md", "1"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /plan status is draft/);
});

test("phase already shipped (found in git log): exit 1", () => {
  const root = makeRepo({ shippedSubjects: ["feat(daemon): queue core (Plan-003 Phase 1)"] });
  const r = preflight(root, ["docs/plans/003-queue.md", "1"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /phase 1 already in git log/);
});

test("precondition names an unshipped phase: exit 1; shipped: exit 0", () => {
  const unmet = preflight(makeRepo(), ["docs/plans/003-queue.md", "2"]);
  assert.equal(unmet.status, 1);
  assert.match(unmet.stderr, /precondition not met: Plan-003 Phase 1/);
  const met = preflight(
    makeRepo({ shippedSubjects: ["feat(daemon): queue core (Plan-003 Phase 1)"] }),
    ["docs/plans/003-queue.md", "2"],
  );
  assert.equal(met.status, 0, met.stderr);
});

test("missing phase section: exit 1; bad usage: exit 2", () => {
  assert.equal(preflight(makeRepo(), ["docs/plans/003-queue.md", "9"]).status, 1);
  assert.equal(preflight(makeRepo(), []).status, 2);
});

test("bold precondition, as the corpus writes it: exit 1; shipped: exit 0", () => {
  const unmet = preflight(makeRepo({ boldPreconditions: true }), ["docs/plans/003-queue.md", "2"]);
  assert.equal(unmet.status, 1, unmet.stdout);
  assert.match(unmet.stderr, /precondition not met: Plan-003 Phase 1/);
  const met = preflight(
    makeRepo({
      boldPreconditions: true,
      shippedSubjects: ["feat(daemon): queue core (Plan-003 Phase 1)"],
    }),
    ["docs/plans/003-queue.md", "2"],
  );
  assert.equal(met.status, 0, met.stderr);
  assert.match(met.stdout, /ok: preconditions satisfied \(Plan-003 Phase 1 merged\.\)/);
});

// History spells "Plan-003 Phase 1 has shipped" four ways, and a precondition
// naming the phase must be satisfied by each of them.
for (const { form, subject } of [
  { form: "task number", subject: "feat(contracts): currency + parity ops (Plan-003 T1.7/T1.8)" },
  { form: "short phase", subject: "feat(daemon): close Plan-003 P1 residuals" },
  { form: "long phase", subject: "feat(daemon): queue core (Plan-003 Phase 1)" },
]) {
  test(`a ${form} subject satisfies a precondition on that phase`, () => {
    const met = preflight(makeRepo({ boldPreconditions: true, shippedSubjects: [subject] }), [
      "docs/plans/003-queue.md",
      "2",
    ]);
    assert.equal(met.status, 0, met.stderr);
  });
}

test("a task number does not satisfy a different phase, and docs subjects never ship", () => {
  // `T11.` is phase 11, not phase 1; `P12` is phase 12, not phase 1.
  for (const subject of [
    "feat(daemon): later work (Plan-003 T11.2)",
    "feat(daemon): later work (Plan-003 P12)",
    "docs(repo): fix Plan-003 T1.9 spec-coverage cite anchors",
    "chore(repo): manifest rows for the Plan-003 Phase 1 shipment",
  ]) {
    const unmet = preflight(makeRepo({ boldPreconditions: true, shippedSubjects: [subject] }), [
      "docs/plans/003-queue.md",
      "2",
    ]);
    assert.equal(unmet.status, 1, `${subject} was counted as shipped`);
    assert.match(unmet.stderr, /precondition not met: Plan-003 Phase 1/);
  }
});

test("a subject written under the old numbering is translated to today's plan", () => {
  // Old 004 is today's Plan-003, so this subject ships Plan-003 Phase 1 and
  // satisfies Phase 2's precondition.
  const { root, boundary } = makeRenumberedRepo({
    oldEraSubjects: ["feat(daemon): queue core (Plan-004 Phase 1)"],
  });
  const met = preflight(root, ["docs/plans/003-queue.md", "2"], {
    PREFLIGHT_RENUMBER_COMMIT: boundary,
  });
  assert.equal(met.status, 0, met.stderr);
});

test("a retired old number matches nothing, before or after the renumbering", () => {
  // Old Plan-008 was retired rather than renumbered, so its subject names no
  // plan that exists today and cannot answer for today's Plan-008.
  const { root, boundary } = makeRenumberedRepo({
    oldEraSubjects: ["feat(daemon): retired work (Plan-008 Phase 1)"],
  });
  const fresh = preflight(root, ["docs/plans/008-retired.md", "1"], {
    PREFLIGHT_RENUMBER_COMMIT: boundary,
  });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /ok: phase 1 not in git log/);

  // The same subject written AFTER the boundary is today's Plan-008 and does.
  const after = makeRenumberedRepo({
    newEraSubjects: ["feat(daemon): retired work (Plan-008 Phase 1)"],
  });
  const shipped = preflight(after.root, ["docs/plans/008-retired.md", "1"], {
    PREFLIGHT_RENUMBER_COMMIT: after.boundary,
  });
  assert.equal(shipped.status, 1);
  assert.match(shipped.stderr, /phase 1 already in git log/);
});
