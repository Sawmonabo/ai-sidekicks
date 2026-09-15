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

function preflight(root, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8" });
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
