import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";

import { runChecks } from "../bin/pre-commit-runner.ts";

function setupRepo(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(resolve(tmpdir(), "pcr-"));
  execSync("git init -q -b main", { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    const full = resolve(root, path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  // Stage the fixture set so `git ls-files` enumerates them. The index-aware
  // reader returns the staged blob for any path not in the argv-staged set —
  // tests that exercise that branch need at least these `git add -A` blobs.
  execSync("git add -A", { cwd: root });
  return { root, cleanup: () => rmSync(root, { recursive: true }) };
}

// setupRepoCommitted extends setupRepo with an initial commit so HEAD exists.
// Required only by Scenario-Y, which verifies the runner catches a stale cite
// in a citer's HEAD content while the worktree carries a WIP fix — `git show
// :<relpath>` on a tracked-clean path returns the HEAD blob, so the runner
// validates HEAD content against the (just-staged) plan's new line layout.
function setupRepoCommitted(files: Record<string, string>): { root: string; cleanup: () => void } {
  const { root, cleanup } = setupRepo(files);
  execSync(`git -c user.email=test@example.com -c user.name=test commit -q -m "init"`, {
    cwd: root,
  });
  return { root, cleanup };
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

  it("does not flag an unstaged citer whose WIP working-tree edit introduces a broken cite", () => {
    // End-to-end companion to the inbound-cite-discovery index-read tests:
    // the runner exits 0 when a citer has unstaged WIP that would otherwise
    // look like a line-out-of-range violation. The index-aware reader returns
    // the citer's STAGED content (the clean cite at :3), so the WIP-introduced
    // broken cite is structurally invisible to validation. A developer mid-
    // editing one governance doc is never blocked while staging an unrelated
    // change.
    const { root, cleanup } = setupRepo({
      "docs/plans/002-test.md": "# Plan-002\n\npreconds\n",
      "docs/architecture/cross-plan-dependencies.md":
        "Clean: [Plan-002](../plans/002-test.md):3.\n",
    });
    try {
      writeFileSync(
        resolve(root, "docs/architecture/cross-plan-dependencies.md"),
        "WIP edit: [Plan-002](../plans/002-test.md):9999.\n",
      );
      const result = withRepoRoot(root, () => runChecks([resolve(root, "docs/plans/002-test.md")]));
      expect(result.exitCode).toBe(0);
      expect(result.messages).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("catches a HEAD-stale citer cite when the staged plan's line shift exposes it (Scenario Y)", () => {
    // Scenario Y is the residual case that the prior dirty-skip filter
    // deferred to CI: a citer at HEAD cites a stable line in a plan, the
    // developer's UNSTAGED worktree edit fixes the citer to the plan's new
    // line, and the developer stages the plan (alone) intending to follow
    // with the citer fix in a separate commit. Under the dirty-skip filter
    // the citer was excluded from pre-commit and CI caught it post-push.
    // Under the index-aware reader, `git show :<citer>` returns the HEAD
    // blob (the stale cite), validation runs against it, and the runner
    // catches the inbound break locally.
    //
    // Fixture shape: HEAD plan has 3 lines ("# Plan-002", blank, "preconds")
    // and the HEAD citer cites :3. The developer's staged plan shrinks to 2
    // lines (drops preconds entirely), so :3 is out of range in the staged
    // blob. Worktree WIP on the citer "fixes" it to :2 (still wrong but
    // irrelevant — the reader returns HEAD).
    const { root, cleanup } = setupRepoCommitted({
      "docs/plans/002-test.md": "# Plan-002\n\npreconds\n",
      "docs/architecture/cross-plan-dependencies.md":
        "See [Plan-002](../plans/002-test.md):3 for preconds.\n",
    });
    try {
      // Staged edit on the plan: drop the preconds line so the file is 2
      // lines long. Citer's HEAD cite of :3 is now out of range.
      writeFileSync(resolve(root, "docs/plans/002-test.md"), "# Plan-002\n\n");
      execSync("git add docs/plans/002-test.md", { cwd: root });
      // Worktree-only WIP on the citer — not staged, not in HEAD. Index-aware
      // reader serves HEAD's :3 cite, NOT this WIP value.
      writeFileSync(
        resolve(root, "docs/architecture/cross-plan-dependencies.md"),
        "See [Plan-002](../plans/002-test.md):2 for preconds.\n",
      );
      const result = withRepoRoot(root, () => runChecks([resolve(root, "docs/plans/002-test.md")]));
      expect(result.exitCode).toBe(1);
      const joined = result.messages.join("\n");
      expect(joined).toContain("cite-target-existence");
      expect(joined).toContain("cross-plan-dependencies.md");
      // Either CAT-06 sub-reason proves the validation ran against HEAD: the
      // staged plan's 3rd line is empty (trailing newline → split yields a
      // bare-empty element) so this fires as target-line-empty. If a future
      // fixture shape lands the cite past the file length, line-out-of-range
      // is equally valid evidence.
      expect(joined).toMatch(/target-line-empty|line-out-of-range/);
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

describe("pre-commit-runner — bin-script direct-invocation guard", () => {
  // Existing tests import `runChecks` so they bypass the direct-invocation
  // guard entirely. The guard's failure mode is hostile: it exits 0 silently,
  // indistinguishable from "no violations." This spawn-based test verifies
  // that the script's `main()` actually runs when invoked as a bin script —
  // catching guard regressions before they ship.
  it("spawning the bin script with a markdown file containing a missing cite target exits 1", () => {
    const binPath = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/pre-commit-runner.ts");
    const fixtureDir = mkdtempSync(resolve(tmpdir(), "pcr-spawn-"));
    const badFile = resolve(fixtureDir, "bad.md");
    writeFileSync(badFile, "See [missing](./does-not-exist.md):42 for context.\n");

    try {
      const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", binPath, badFile],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).toContain("cite-target-existence");
      expect(combined).toContain("missing-target-file");
    } finally {
      rmSync(fixtureDir, { recursive: true });
    }
  });
});
