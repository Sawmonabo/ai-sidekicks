import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

import { runChecks } from "../bin/pre-commit-runner.ts";

function setupRepo(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(resolve(tmpdir(), "pcr-"));
  execSync("git init -q -b main", { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    const full = resolve(root, path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true }) };
}

function withRepoRoot<T>(root: string, fn: () => T): T {
  const prev = process.env.REPO_ROOT;
  process.env.REPO_ROOT = root;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.REPO_ROOT;
    else process.env.REPO_ROOT = prev;
  }
}

describe("pre-commit-runner — inbound cite ripple expansion", () => {
  it("flags an inbound cite-target failure in an UNSTAGED governance doc when a staged plan's referenced line is empty (PR #97 scenario)", () => {
    // PR #97 reproduction shape: a plan's line numbers shift, an unstaged
    // architecture doc cites the OLD line that is now blank. Without
    // ripple-mode, the runner only scanned the staged plan's outbound cites
    // and missed the inbound break — CI's repo-wide `custom-checks` step
    // caught it after push. With ripple-mode, the runner expands the cite
    // check input to include the unstaged citer because its outbound cites
    // resolve into the staged plan.
    const { root, cleanup } = setupRepo({
      "docs/plans/002-test.md":
        // line 1: "# Plan-002"
        // line 2: ""           <-- target of the cite below; now empty
        // line 3: "preconds"
        "# Plan-002\n\npreconds\n",
      "docs/architecture/cross-plan-dependencies.md":
        "# Cross-plan deps\n\nSee [Plan-002](../plans/002-test.md):2 for preconds.\n",
    });
    try {
      const result = withRepoRoot(root, () => runChecks([resolve(root, "docs/plans/002-test.md")]));
      expect(result.exitCode).toBe(1);
      const joined = result.messages.join("\n");
      expect(joined).toContain("cite-target-existence");
      expect(joined).toContain("cross-plan-dependencies.md");
      expect(joined).toContain("target-line-empty");
    } finally {
      cleanup();
    }
  });

  it("does not expand into governance citers when only non-governance files are staged", () => {
    // Staging README.md (non-governance) should not trigger the corpus walk,
    // even if a stale inbound cite-target exists somewhere in the tree. The
    // expansion is gated on a staged governance file by design — otherwise
    // every commit pays the corpus-walk cost.
    const { root, cleanup } = setupRepo({
      "README.md": "# repo\n",
      "docs/plans/002-test.md": "# Plan-002\n\npreconds\n",
      "docs/architecture/cross-plan-dependencies.md":
        // This cite IS stale (:2 is empty in 002-test.md) — but README staging
        // must not surface it.
        "See [Plan-002](../plans/002-test.md):2 — stale cite that ripple-mode would catch if expanded.\n",
    });
    try {
      const result = withRepoRoot(root, () => runChecks([resolve(root, "README.md")]));
      expect(result.exitCode).toBe(0);
      expect(result.messages).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("passes cleanly when a staged plan's referenced lines are all populated", () => {
    // The happy path: staging a plan whose inbound citers reference real,
    // non-empty lines. Confirms ripple-mode doesn't introduce false positives
    // on healthy governance trees.
    const { root, cleanup } = setupRepo({
      "docs/plans/002-test.md":
        // line 1: "# Plan-002"
        // line 2: ""
        // line 3: "preconds line"   <-- target
        "# Plan-002\n\npreconds line\n",
      "docs/architecture/cross-plan-dependencies.md":
        "See [Plan-002](../plans/002-test.md):3 for preconds.\n",
    });
    try {
      const result = withRepoRoot(root, () => runChecks([resolve(root, "docs/plans/002-test.md")]));
      expect(result.exitCode).toBe(0);
      expect(result.messages).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
