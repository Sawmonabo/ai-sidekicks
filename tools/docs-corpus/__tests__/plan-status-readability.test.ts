import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  checkPlanStatusReadability,
  formatPlanStatusViolations,
  readHeaderStatus,
} from "../lib/plan-status-readability.ts";

// Resolved from this file's own location, NOT getRepoRoot(): the corpus tests
// below deliberately point REPO_ROOT at a temp fixture, and the drift test must
// keep loading the REAL preflight regardless.
const REAL_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface GateResult {
  ok: boolean;
  halt?: string;
}
type GateStatusPromotion = (planSource: string, planFile: string) => GateResult;

// Loaded through a runtime-computed specifier. `preflight.mjs` ships no
// declaration file, so a static specifier is TS7016 under this package's
// `noImplicitAny`; authoring a one-export `preflight.d.mts` over a 7000+-line
// module would be its own drift surface (the `manifest.d.mts` precedent needs a
// pin test of its own to stay honest). A computed specifier types as `any` and
// the cast below states the contract this test actually depends on.
async function loadRealGate(): Promise<GateStatusPromotion> {
  const specifier = pathToFileURL(
    resolve(REAL_REPO_ROOT, ".claude/skills/plan-execution/scripts/preflight.mjs"),
  ).href;
  const mod = (await import(specifier)) as { gateStatusPromotion: GateStatusPromotion };
  return mod.gateStatusPromotion;
}

function plan(statusCell: string, opts: { body?: string } = {}): string {
  return [
    "# Plan — Fixture",
    "",
    "| Field | Value |",
    "| --- | --- |",
    statusCell,
    "",
    "## Scope",
    "",
    opts.body ?? "Body.",
    "",
  ].join("\n");
}

function setupRepo(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(resolve(tmpdir(), "psr-"));
  execSync("git init -q -b main", { cwd: root });
  execSync("git config user.email test@test", { cwd: root });
  execSync("git config user.name test", { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    const full = resolve(root, path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  execSync("git add -A && git commit -q -m bootstrap", { cwd: root });
  return { root, cleanup: () => rmSync(root, { recursive: true }) };
}

// The check resolves the corpus via getRepoRoot() (REPO_ROOT env override) and
// reads each plan from the git index, so a temp repo + REPO_ROOT fully isolates
// it without mutating process.cwd().
function runCheck(root: string): ReturnType<typeof checkPlanStatusReadability> {
  const prev = process.env.REPO_ROOT;
  try {
    process.env.REPO_ROOT = root;
    return checkPlanStatusReadability();
  } finally {
    if (prev === undefined) delete process.env.REPO_ROOT;
    else process.env.REPO_ROOT = prev;
  }
}

// One matrix, used by BOTH the unit assertions and the drift assertion, so the
// two can never be checking different populations.
const READABLE_CELL = "| **Status** | `approved` |";
const ANNOTATED_CELL = "| **Status** | `approved` (restored 2026-08-26, NS-84) |";

const MATRIX: { name: string; source: string; expected: string | null }[] = [
  { name: "backticked approved", source: plan(READABLE_CELL), expected: "approved" },
  {
    name: "backticked completed",
    source: plan("| **Status** | `completed` |"),
    expected: "completed",
  },
  { name: "backticked draft", source: plan("| **Status** | `draft` |"), expected: "draft" },
  { name: "backticked review", source: plan("| **Status** | `review` |"), expected: "review" },
  {
    name: "unbackticked approved",
    source: plan("| **Status** | approved |"),
    expected: "approved",
  },
  {
    name: "hyphenated status",
    source: plan("| **Status** | `in-progress` |"),
    expected: "in-progress",
  },
  { name: "inline-annotated value", source: plan(ANNOTATED_CELL), expected: null },
  { name: "capitalised value", source: plan("| **Status** | `Approved` |"), expected: null },
  { name: "no Status row at all", source: plan("| **Owner** | someone |"), expected: null },
  {
    name: "Status row only in the body, after the first `##`",
    source: plan("| **Owner** | someone |", { body: "| **Status** | `approved` |" }),
    expected: null,
  },
];

describe("plan-status-readability — matcher", () => {
  for (const testCase of MATRIX) {
    it(`reads ${testCase.name} as ${testCase.expected === null ? "UNREADABLE" : `\`${testCase.expected}\``}`, () => {
      expect(readHeaderStatus(testCase.source)).toBe(testCase.expected);
    });
  }
});

// The enforcement for this module's deliberate duplication of Gate 7's matcher.
// A change to `gateStatusPromotion` that this file did not follow turns this
// red — which is the whole reason the duplication is acceptable.
describe("plan-status-readability — drift against the real preflight Gate 7", () => {
  // Both assertions below compare the gate against `readHeaderStatus`'s LIVE
  // output, never against MATRIX.expected. Comparing to the table would pin the
  // gate to the fixtures and leave this module free to drift away from both —
  // which is precisely the failure this test exists to catch.
  it("agrees with gateStatusPromotion on unreadability across the whole matrix", async () => {
    const gateStatusPromotion = await loadRealGate();
    for (const testCase of MATRIX) {
      const verdict = gateStatusPromotion(testCase.source, "docs/plans/999-fixture.md");
      const gateSaysUnreadable =
        verdict.ok === false && /status unreadable/.test(verdict.halt ?? "");
      const mine = readHeaderStatus(testCase.source);
      expect(
        gateSaysUnreadable,
        `case "${testCase.name}": gate ${gateSaysUnreadable ? "" : "did not "}call it unreadable, ` +
          `readHeaderStatus returned ${mine === null ? "null" : `"${mine}"`}`,
      ).toBe(mine === null);
    }
  });

  it("agrees with gateStatusPromotion on the status TOKEN it read, not just readability", async () => {
    const gateStatusPromotion = await loadRealGate();
    for (const testCase of MATRIX) {
      const mine = readHeaderStatus(testCase.source);
      if (mine === null) continue;
      const verdict = gateStatusPromotion(testCase.source, "docs/plans/999-fixture.md");
      if (verdict.ok) {
        // The gate passes exactly the two dispatchable tokens; anything else
        // reaching `ok: true` means the two matchers read different values.
        expect(["approved", "completed"], `case "${testCase.name}"`).toContain(mine);
        continue;
      }
      // The not-promoted halt quotes the token the gate read back verbatim.
      expect(verdict.halt, `case "${testCase.name}"`).toContain(`Status is \`${mine}\``);
    }
  });

  it("never flags a plan the gate merely calls NOT PROMOTED", async () => {
    const gateStatusPromotion = await loadRealGate();
    const draft = plan("| **Status** | `draft` |");
    const verdict = gateStatusPromotion(draft, "docs/plans/999-fixture.md");
    expect(verdict.ok).toBe(false);
    expect(verdict.halt).toContain("plan not promoted");
    // `draft` and `review` are legitimate authoring states — this check is
    // scoped to readability and must stay silent on them.
    expect(readHeaderStatus(draft)).toBe("draft");
  });
});

describe("plan-status-readability — corpus check", () => {
  it("FIRES on a plan whose Status cell carries an inline annotation", () => {
    const { root, cleanup } = setupRepo({ "docs/plans/005-foo.md": plan(ANNOTATED_CELL) });
    const hits = runCheck(root);
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toBe("docs/plans/005-foo.md");
    expect(hits[0].offendingLine).toBe(ANNOTATED_CELL);
    const formatted = formatPlanStatusViolations(hits);
    expect(formatted).toMatch(/005-foo\.md/);
    expect(formatted).toMatch(/restored 2026-08-26/);
    cleanup();
  });

  it("STAYS SILENT on a plan whose Status cell is the template shape", () => {
    const { root, cleanup } = setupRepo({ "docs/plans/005-foo.md": plan(READABLE_CELL) });
    expect(runCheck(root)).toEqual([]);
    expect(formatPlanStatusViolations([])).toBe("");
    cleanup();
  });

  it("STAYS SILENT on 000-plan-template.md, whose placeholder cell is unreadable by design", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/000-plan-template.md": plan("| **Status** | `draft` / `review` / `approved` |"),
      "docs/plans/005-foo.md": plan(READABLE_CELL),
    });
    // Negative control for the exemption: the same unreadable cell in a real
    // plan MUST fire, so the silence above is the template exemption and not a
    // matcher that accepts the shape.
    expect(readHeaderStatus(plan("| **Status** | `draft` / `review` / `approved` |"))).toBeNull();
    expect(runCheck(root)).toEqual([]);
    cleanup();
  });

  it("reports the missing-row case distinctly from the malformed-value case", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/005-foo.md": plan("| **Owner** | someone |"),
    });
    const hits = runCheck(root);
    expect(hits).toHaveLength(1);
    expect(hits[0].offendingLine).toBeUndefined();
    expect(formatPlanStatusViolations(hits)).toMatch(
      /no `\*\*Status\*\*` row in the header region/,
    );
    cleanup();
  });

  it("is not rescued by a Status row that appears below the first `##` heading", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/005-foo.md": plan("| **Owner** | someone |", { body: READABLE_CELL }),
    });
    expect(runCheck(root)).toHaveLength(1);
    cleanup();
  });

  it("fails CLOSED, under its own name, when the corpus cannot be enumerated", () => {
    const root = mkdtempSync(resolve(tmpdir(), "psr-norepo-"));
    try {
      expect(() => runCheck(root)).toThrow(/plan-status-readability: could not enumerate plans/);
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});
