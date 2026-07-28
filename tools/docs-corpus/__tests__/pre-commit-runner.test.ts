import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";

import { parseRunnerArguments, runChecks } from "../bin/pre-commit-runner.ts";

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
  // runChecks also runs the whole-repo plan-manifest-presence guard
  // (lib/plan-manifest-presence.ts) unconditionally, before the cite checks. A
  // fixture plan with no manifest and a non-draft status trips it. So fixtures
  // asserting a clean exit (exitCode 0, messages == []) mark their plan `draft`
  // (an exempt status) to isolate the cite-ripple behavior under test; fixtures
  // asserting a cite violation leave it unmarked — the extra manifest violation
  // is immaterial to an exitCode-1 + toContain check, and Scenario Y's plan
  // cannot be marked without shifting its load-bearing line count.
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
      // `draft` → manifest-presence guard exempts this plan (see describe note).
      "docs/plans/002-test.md": "# Plan-002\n\npreconds\n\n| **Status** | `draft` |\n",
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
      // `draft` → manifest-presence guard exempts this plan (see describe note);
      // the status row trails the cited :3 line, so the citer's cite still holds.
      "docs/plans/002-test.md": "# Plan-002\n\npreconds\n\n| **Status** | `draft` |\n",
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
        // line 3: "preconds line"   <-- target (trailing `draft` status row
        //          exempts the manifest-presence guard without shifting it)
        "# Plan-002\n\npreconds line\n\n| **Status** | `draft` |\n",
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

describe("pre-commit-runner — reverse-direction advisory", () => {
  it("warns (without blocking) when staged code is cited by governance docs", () => {
    const { root, cleanup } = setupRepo({
      // `draft` → manifest-presence guard exempts this plan (see describe note).
      "docs/plans/001-x.md":
        "# Plan-001\n\n| **Status** | `draft` |\n\nThe parser lives at `packages/foo/src/bar.ts#doThing`.\n",
      "packages/foo/src/bar.ts": "export function doThing(): void {}\n",
      // checkPathCanonicalRipple roots on process.cwd() (not REPO_ROOT) and
      // fails closed on a missing registry — this test chdirs into the
      // fixture, so give it an empty registry.
      "tools/docs-corpus/canonical-paths.json": '{ "paths": [] }\n',
    });
    // isCodeFile keys on repo-relative paths (`packages/…`), matching
    // lefthook's invocation from the repo root — so run from the fixture root
    // with a relative arg, unlike the md-lane tests above (absolute args).
    // realpath the root first: macOS mkdtemp returns a /var → /private/var
    // symlink, and process.cwd() after chdir is physical, so a symlinked
    // REPO_ROOT would never match cwd-resolved staged paths.
    const previousCwd = process.cwd();
    const physicalRoot = realpathSync(root);
    try {
      process.chdir(physicalRoot);
      const result = withRepoRoot(physicalRoot, () => runChecks(["packages/foo/src/bar.ts"]));
      expect(result.exitCode).toBe(0); // advisory only — never blocks
      const joined = result.messages.join("\n");
      expect(joined).toContain("staged code is cited by governance docs");
      expect(joined).toContain("docs/plans/001-x.md");
    } finally {
      process.chdir(previousCwd);
      cleanup();
    }
  });
});

describe("pre-commit-runner — markdown section-anchor cites", () => {
  it("flags a staged doc citing a dead `§Heading` (section-not-found)", () => {
    const { root, cleanup } = setupRepo({
      // `draft` → manifest-presence guard exempts this plan (see describe note).
      "docs/plans/002-test.md":
        "# Plan-002\n\n| **Status** | `draft` |\n\nPer `Spec-003 §Wire Format` the frame is LSP-style.\n",
      "docs/specs/003-runtime-node-attach.md":
        "# Spec\n\n| **Status** | `draft` |\n\n## Something Else\n\nbody\n",
    });
    try {
      const result = withRepoRoot(root, () => runChecks([resolve(root, "docs/plans/002-test.md")]));
      expect(result.exitCode).toBe(1);
      const joined = result.messages.join("\n");
      expect(joined).toContain("section-not-found");
    } finally {
      cleanup();
    }
  });
});

describe("pre-commit-runner — inbound section-cite ripple", () => {
  it("catches an unstaged citer's dead §-cite when the staged spec renamed the heading", () => {
    // Codex repro (PR #188 round 2): stage ONLY the spec whose heading was
    // renamed; the unstaged plan cites the OLD heading via `Spec-003 §…`.
    // Without §-aware inbound expansion the runner exits 0 and CI catches it
    // post-push — the exact PR #97 gap shape, for section anchors.
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md":
        "# Spec\n\n| **Status** | `draft` |\n\n## Frame Format\n\nbody\n",
      // `draft` → manifest-presence guard exempts this plan (see describe note).
      "docs/plans/009-y.md":
        "# Plan-009\n\n| **Status** | `draft` |\n\nPer `Spec-003 §Wire Format` the frame is LSP-style.\n",
    });
    try {
      const result = withRepoRoot(root, () =>
        runChecks([resolve(root, "docs/specs/003-runtime-node-attach.md")]),
      );
      expect(result.exitCode).toBe(1);
      const joined = result.messages.join("\n");
      expect(joined).toContain("section-not-found");
      expect(joined).toContain("docs/plans/009-y.md");
    } finally {
      cleanup();
    }
  });

  it("stays green when the staged spec still carries the cited heading", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md":
        "# Spec\n\n| **Status** | `draft` |\n\n## Wire Format\n\nbody\n",
      "docs/plans/009-y.md":
        "# Plan-009\n\n| **Status** | `draft` |\n\nPer `Spec-003 §Wire Format` the frame is LSP-style.\n",
    });
    try {
      const result = withRepoRoot(root, () =>
        runChecks([resolve(root, "docs/specs/003-runtime-node-attach.md")]),
      );
      expect(result.exitCode).toBe(0);
      expect(result.messages).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("pre-commit-runner — markdown volatile-cite deny wiring", () => {
  it("exits 1 when a STAGED md citer carries a volatile line cite", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": "# Spec\n\nline three\nline four\nline five\n",
      "docs/architecture/security-architecture.md":
        "Attach admission is governed by Spec-003 line 4 today.\n",
    });
    try {
      const result = withRepoRoot(root, () =>
        runChecks([resolve(root, "docs/architecture/security-architecture.md")]),
      );
      expect(result.exitCode).toBe(1);
      expect(result.messages.join("\n")).toContain("line-anchored-cite-in-docs");
    } finally {
      cleanup();
    }
  });

  it("does NOT deny an UNSTAGED expanded citer's pre-existing volatile cite (introduction-gating scope)", () => {
    // The unstaged citer's link-colon cite pulls it into the expanded floor
    // set (valid pin → floor passes); the deny must skip it — it gates what
    // the staged commit INTRODUCES, not a bystander's pre-existing debt.
    const { root, cleanup } = setupRepo({
      "docs/domain/session-model.md": "# Session model\n\nparticipant rows\n",
      "docs/architecture/security-architecture.md":
        "See [the rows](../domain/session-model.md):3 for the participant table.\n",
    });
    try {
      const result = withRepoRoot(root, () =>
        runChecks([resolve(root, "docs/domain/session-model.md")]),
      );
      expect(result.exitCode).toBe(0);
      expect(result.messages).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("denies the STAGED (index) content even when the worktree already fixed it", () => {
    // Introduction denies validate the COMMIT: a raw cite that is staged and
    // then fixed only in the working tree still blocks — the forbidden blob
    // is what ships (Codex, PR #207 round 2).
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": "# Spec\n\n## Attach\n\nline five\n",
      "docs/architecture/security-architecture.md":
        "Attach admission is governed by Spec-003 line 4 today.\n",
    });
    try {
      writeFileSync(
        resolve(root, "docs/architecture/security-architecture.md"),
        "Attach admission is governed by `Spec-003 §Attach` today.\n",
      );
      const result = withRepoRoot(root, () =>
        runChecks([resolve(root, "docs/architecture/security-architecture.md")]),
      );
      expect(result.exitCode).toBe(1);
      expect(result.messages.join("\n")).toContain("line-anchored-cite-in-docs");
    } finally {
      cleanup();
    }
  });

  it("passes clean STAGED content regardless of raw-cite WIP in the worktree", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": "# Spec\n\n## Attach\n\nline five\n",
      "docs/architecture/security-architecture.md":
        "Attach admission is governed by `Spec-003 §Attach` today.\n",
    });
    try {
      writeFileSync(
        resolve(root, "docs/architecture/security-architecture.md"),
        "Attach admission is governed by Spec-003 line 4 today.\n",
      );
      const result = withRepoRoot(root, () =>
        runChecks([resolve(root, "docs/architecture/security-architecture.md")]),
      );
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("pre-commit-runner — commit-snapshot (index) reads across every lane", () => {
  // isCodeFile keys on repo-relative paths (`packages/…`), matching
  // lefthook's invocation from the repo root — so the code-lane pair chdirs
  // into the (realpathed — macOS /var symlink) fixture root and passes
  // relative args, exactly like the reverse-direction advisory test above.
  function runCodeLane(files: Record<string, string>, worktreeOverride: string, citer: string) {
    const { root, cleanup } = setupRepo({
      ...files,
      "tools/docs-corpus/canonical-paths.json": '{ "paths": [] }\n',
    });
    const previousCwd = process.cwd();
    const physicalRoot = realpathSync(root);
    try {
      writeFileSync(resolve(physicalRoot, citer), worktreeOverride);
      process.chdir(physicalRoot);
      return withRepoRoot(physicalRoot, () => runChecks([citer]));
    } finally {
      process.chdir(previousCwd);
      cleanup();
    }
  }

  it("code lane: denies the STAGED (index) content even when the worktree already fixed it", () => {
    const result = runCodeLane(
      {
        "docs/specs/003-runtime-node-attach.md": "# Spec\n\n## Attach\n\nline five\n",
        "packages/x/src/f.ts": "// admission is governed by Spec-003 line 4 today\n",
      },
      "// admission is governed by `Spec-003 §Attach` today\n",
      "packages/x/src/f.ts",
    );
    expect(result.exitCode).toBe(1);
    expect(result.messages.join("\n")).toContain("line-anchored-cite-in-code");
  });

  it("code lane: passes clean STAGED content regardless of raw-cite WIP in the worktree", () => {
    const result = runCodeLane(
      {
        "docs/specs/003-runtime-node-attach.md": "# Spec\n\n## Attach\n\nline five\n",
        "packages/x/src/f.ts": "// admission is governed by `Spec-003 §Attach` today\n",
      },
      "// admission is governed by Spec-003 line 4 today\n",
      "packages/x/src/f.ts",
    );
    expect(result.exitCode).toBe(0);
  });

  // table-arity joined the commit-snapshot reader in PR #269 round 2. The
  // parseFile-level test pins that an injected reader is honored; this one pins
  // that the RUNNER injects it — with the disk fallback covering every argv
  // path, a runner that silently kept reading the worktree would still exit 0
  // over the real corpus and look identical.
  it("md lane: table-arity flags the STAGED table even when the worktree already fixed it", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md":
        "# Spec\n\n| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n",
    });
    try {
      writeFileSync(
        resolve(root, "docs/specs/003-runtime-node-attach.md"),
        "# Spec\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n",
      );
      const result = withRepoRoot(root, () =>
        runChecks([resolve(root, "docs/specs/003-runtime-node-attach.md")]),
      );
      expect(result.exitCode).toBe(1);
      expect(result.messages.join("\n")).toContain("table-arity");
    } finally {
      cleanup();
    }
  });

  it("§-verification reads the STAGED target: a coherent staged rename passes despite a stale worktree target", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": "# Spec\n\n## Renamed Heading\n\nbody\n",
      "docs/architecture/security-architecture.md":
        "Admission per `Spec-003 §Renamed Heading` today.\n",
    });
    try {
      // Worktree regresses the target to the OLD heading without restaging —
      // a worktree read would report section-not-found; the staged pair is
      // coherent and must pass.
      writeFileSync(
        resolve(root, "docs/specs/003-runtime-node-attach.md"),
        "# Spec\n\n## Old Heading\n\nbody\n",
      );
      const result = withRepoRoot(root, () =>
        runChecks([resolve(root, "docs/architecture/security-architecture.md")]),
      );
      expect(result.exitCode).toBe(0);
      expect(result.messages).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("pre-commit-runner — staged-deletion vs untracked fallback (commit-snapshot reader)", () => {
  it("a staged DELETION of a cited target fails missing-target-file even when the worktree copy is restored", () => {
    const { root, cleanup } = setupRepoCommitted({
      "docs/specs/003-runtime-node-attach.md": "# Spec\n\n## Attach\n\nbody\n",
      "docs/architecture/security-architecture.md": "Admission per `Spec-003 §Attach` today.\n",
    });
    try {
      execSync("git rm -q docs/specs/003-runtime-node-attach.md", { cwd: root });
      // Restore the worktree copy WITHOUT re-adding: the index still stages
      // the deletion, so the commit would remove the cited target — the old
      // disk fallback validated this restored copy and passed. (git rm also
      // prunes the emptied parent directory; recreate it first.)
      mkdirSync(resolve(root, "docs/specs"), { recursive: true });
      writeFileSync(
        resolve(root, "docs/specs/003-runtime-node-attach.md"),
        "# Spec\n\n## Attach\n\nbody\n",
      );
      const result = withRepoRoot(root, () =>
        runChecks([resolve(root, "docs/architecture/security-architecture.md")]),
      );
      expect(result.exitCode).toBe(1);
      expect(result.messages.join("\n")).toContain("missing-target-file");
    } finally {
      cleanup();
    }
  });

  it("a genuinely untracked argv file still validates via the disk fallback", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": "# Spec\n\nline three\nline four\nline five\n",
    });
    try {
      writeFileSync(
        resolve(root, "docs/probe.md"),
        "Attach admission is governed by Spec-003 line 4 today.\n",
      );
      const result = withRepoRoot(root, () => runChecks([resolve(root, "docs/probe.md")]));
      expect(result.exitCode).toBe(1);
      expect(result.messages.join("\n")).toContain("line-anchored-cite-in-docs");
    } finally {
      cleanup();
    }
  });

  it("a staged citer citing an UNTRACKED target fails missing-target-file (no disk fallback for non-argv paths)", () => {
    const { root, cleanup } = setupRepo({
      "docs/architecture/security-architecture.md": "Admission per `Spec-003 §Attach` today.\n",
    });
    try {
      // The target exists ONLY in the worktree — never added. The commit
      // this gate protects would ship a citation to a file it omits; the
      // earlier HEAD-presence rule classified this never-committed target
      // as a probe file and disk-validated it (Codex, PR #207 round 4).
      mkdirSync(resolve(root, "docs/specs"), { recursive: true });
      writeFileSync(
        resolve(root, "docs/specs/003-runtime-node-attach.md"),
        "# Spec\n\n## Attach\n\nbody\n",
      );
      const result = withRepoRoot(root, () =>
        runChecks([resolve(root, "docs/architecture/security-architecture.md")]),
      );
      expect(result.exitCode).toBe(1);
      expect(result.messages.join("\n")).toContain("missing-target-file");
    } finally {
      cleanup();
    }
  });
});

describe("pre-commit-runner — index-first lane membership", () => {
  // `git add` then `mv`/`rm` (without `git rm`) leaves a path staged WITH
  // content and absent from the worktree. The stat-only lane filters dropped
  // it from both lanes, so every per-file check skipped commit content — a
  // required gate failing open (Codex, PR #269 round 4). Membership is now
  // index-OR-worktree, matching what the commit-snapshot reader can serve.
  it("md lane: a staged table-arity violation is still caught after the worktree copy is removed", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md":
        "# Spec\n\n| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n",
    });
    try {
      rmSync(resolve(root, "docs/specs/003-runtime-node-attach.md"));
      const result = withRepoRoot(root, () =>
        runChecks([resolve(root, "docs/specs/003-runtime-node-attach.md")]),
      );
      expect(result.laneCounts.md).toBe(1);
      expect(result.exitCode).toBe(1);
      expect(result.messages.join("\n")).toContain("table-arity");
    } finally {
      cleanup();
    }
  });

  // mermaid + table-total ran on the disk-present SUBSET of the lane until
  // their reader migration — an index-only member silently skipped exactly
  // these two checks while the reader-based ones saw it. Both now take the
  // full lane through the shared commit-snapshot reader; these pin it.
  it("md lane: a staged mermaid-set violation is still caught after the worktree copy is removed", () => {
    const MERMAID_INCOHERENT = [
      "# Page",
      "",
      "```mermaid",
      "graph TB",
      "  NS01[NS-01: a]:::ready",
      "  NS22[NS-22: b]:::ready",
      "",
      "  classDef ready fill:#9f9,stroke:#0a0,color:#000",
      "```",
      "",
      "The ready set (NS-01) shares no code paths.",
      "",
    ].join("\n");
    const { root, cleanup } = setupRepo({
      "docs/architecture/deployment-graph.md": MERMAID_INCOHERENT,
    });
    try {
      rmSync(resolve(root, "docs/architecture/deployment-graph.md"));
      const result = withRepoRoot(root, () =>
        runChecks([resolve(root, "docs/architecture/deployment-graph.md")]),
      );
      expect(result.laneCounts.md).toBe(1);
      expect(result.exitCode).toBe(1);
      expect(result.messages.join("\n")).toContain("mermaid-set-coherence");
    } finally {
      cleanup();
    }
  });

  it("md lane: a staged table-total drift is still caught after the worktree copy is removed", () => {
    const DRIFTED_CENSUS = [
      "# Spec",
      "",
      '<!-- corpus:total-check column="Count" -->',
      "| Category | Count |",
      "| --- | --- |",
      "| a | 12 |",
      "| b | 18 |",
      "| **Total** | **25** |",
      "",
    ].join("\n");
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": DRIFTED_CENSUS,
    });
    try {
      rmSync(resolve(root, "docs/specs/003-runtime-node-attach.md"));
      const result = withRepoRoot(root, () =>
        runChecks([resolve(root, "docs/specs/003-runtime-node-attach.md")]),
      );
      expect(result.laneCounts.md).toBe(1);
      expect(result.exitCode).toBe(1);
      expect(result.messages.join("\n")).toContain("table-total-coherence");
    } finally {
      cleanup();
    }
  });

  it("code lane: a staged raw line-cite is still denied after the worktree copy is removed", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": "# Spec\n\nline three\nline four\nline five\n",
      "packages/x/src/f.ts": "// admission is governed by Spec-003 line 4 today\n",
      "tools/docs-corpus/canonical-paths.json": '{ "paths": [] }\n',
    });
    const previousCwd = process.cwd();
    const physicalRoot = realpathSync(root);
    try {
      rmSync(resolve(physicalRoot, "packages/x/src/f.ts"));
      process.chdir(physicalRoot);
      const result = withRepoRoot(physicalRoot, () => runChecks(["packages/x/src/f.ts"]));
      expect(result.laneCounts.code).toBe(1);
      expect(result.exitCode).toBe(1);
      expect(result.messages.join("\n")).toContain("line-anchored-cite-in-code");
    } finally {
      process.chdir(previousCwd);
      cleanup();
    }
  });

  it("a path in neither the index nor the worktree stays out of the lane", () => {
    // A true staged deletion never reaches lefthook's argv
    // (`--diff-filter=ACMR`), but a caller passing a stale path must degrade
    // to a skip: with no index blob and no disk copy there is nothing any
    // check could read — inclusion would ENOENT the disk fallback mid-check.
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": "# Spec\n",
    });
    try {
      const result = withRepoRoot(root, () => runChecks([resolve(root, "docs/specs/ghost.md")]));
      expect(result.laneCounts.md).toBe(0);
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("pre-commit-runner — argv parsing for the lane floors", () => {
  it("defaults both floors OFF and treats every positional as a file", () => {
    // OFF is the lefthook posture: `{staged_files}` on a commit touching only
    // `.json` derives an empty `.md` lane legitimately.
    expect(parseRunnerArguments(["docs/a.md", "packages/x/y.ts"])).toEqual({
      files: ["docs/a.md", "packages/x/y.ts"],
      minimumMd: 0,
      minimumCode: 0,
    });
  });

  it("parses both floors and keeps the flags OUT of the file list", () => {
    // Hygiene, NOT a live defect — stated precisely because the tempting
    // stronger claim is false. `files` becomes both the lane-partition input
    // and makeCommitSnapshotReader's disk-fallback allowlist, but a leaked
    // flag is inert in both: the lane filters stat it and drop it, and the
    // allowlist is a Set of RESOLVED paths, so `--min-md=150` resolves to a
    // path no real target can ever equal. Measured, not assumed: routing raw
    // argv through main() instead of the parsed files leaves all 34 tests
    // green. The separation is worth keeping and worth pinning; it is not
    // worth claiming a consequence it does not have.
    expect(parseRunnerArguments(["--min-md=150", "docs/a.md", "--min-code=120"])).toEqual({
      files: ["docs/a.md"],
      minimumMd: 150,
      minimumCode: 120,
    });
  });

  it("rejects every malformed floor value rather than defaulting it to zero", () => {
    // The parser validates SHAPE (`/^\d+$/`) before converting, so this list is
    // a sample of one bounded rule rather than an enumeration the rule was
    // built around — the distinction that matters, because the dangerous
    // members were the ones nobody thought to enumerate.
    //
    // Every whitespace-only value converts to `0` via `Number()` — an integer,
    // non-negative, and therefore a silently DISARMED floor. `--min-md=` is the
    // bare form; `--min-md=" "` and a tab are the reachable-through-quoting and
    // config-generated forms (Codex, PR #267 round 1). `1e3`, `0x10` and `+1`
    // are the other side of the same coin: `Number()` accepts them and would
    // set a floor the operator never wrote.
    for (const malformed of [
      "--min-md",
      "--min-md=",
      "--min-md= ",
      "--min-md=\t",
      "--min-md=abc",
      "--min-md=-1",
      "--min-md=+1",
      "--min-md=1.5",
      "--min-md=1e3",
      "--min-md=0x10",
    ]) {
      expect(() => parseRunnerArguments([malformed]), malformed).toThrow(/--min-md requires/);
    }
    expect(() => parseRunnerArguments(["--min-code=x"])).toThrow(/--min-code requires/);
  });

  it("rejects a newline-bearing floor value through the unknown-option arm", () => {
    // Boundary note, pinned so the split is deliberate rather than incidental:
    // `LANE_FLOOR_RE`'s `(.*)` cannot match a line terminator, so `--min-md=\n`
    // never reaches the digits check and falls through to the unknown-option
    // throw instead. Different message, same fail-closed outcome — but only
    // BECAUSE the unknown-option arm exists. Without it these would land in the
    // file list and disarm the floor silently.
    for (const value of ["--min-md=\n", "--min-md=\r"]) {
      expect(() => parseRunnerArguments([value]), JSON.stringify(value)).toThrow(/unknown option/);
    }
  });

  it("rejects an unknown option instead of silently filing it as a path", () => {
    // A `--min-mb=200` typo would otherwise be stat'd, found missing, dropped
    // by both lane filters, and leave the floor at 0 — CI green over an
    // unenforced run.
    expect(() => parseRunnerArguments(["--min-mb=200"])).toThrow(/unknown option: --min-mb=200/);
  });

  it("accepts an explicit zero as a deliberate disarm", () => {
    expect(parseRunnerArguments(["--min-md=0"]).minimumMd).toBe(0);
  });
});

describe("pre-commit-runner — per-lane floors", () => {
  // Fixture shape for this block: both lanes populated, relative paths, run
  // from the fixture root — the CI invocation's shape (repo-relative paths out
  // of `git ls-files`), and required by isCodeFile's `packages/` prefix test.
  function withLaneFixture(
    mdFileCount: number,
    codeFileCount: number,
    body: (paths: { md: string[]; code: string[] }) => void,
  ): void {
    const files: Record<string, string> = {
      // checkPathCanonicalRipple roots on process.cwd() and fails closed on a
      // missing registry (see the reverse-advisory block above).
      "tools/docs-corpus/canonical-paths.json": '{ "paths": [] }\n',
    };
    const md: string[] = [];
    const code: string[] = [];
    for (let index = 0; index < mdFileCount; index += 1) {
      const path = `docs/note-${index}.md`;
      // Deliberately cite-free prose: these fixtures exercise the floor, and a
      // stray `:NNN` would fail them through a different check.
      files[path] = `# Note ${index}\n\nProse with no cites.\n`;
      md.push(path);
    }
    for (let index = 0; index < codeFileCount; index += 1) {
      const path = `packages/foo/src/mod-${index}.ts`;
      files[path] = `export const value${index}: number = ${index};\n`;
      code.push(path);
    }
    const { root, cleanup } = setupRepo(files);
    const previousCwd = process.cwd();
    const physicalRoot = realpathSync(root);
    try {
      process.chdir(physicalRoot);
      withRepoRoot(physicalRoot, () => body({ md, code }));
    } finally {
      process.chdir(previousCwd);
      cleanup();
    }
  }

  it("fails when the .md lane collapses even though argv stays large (per-lane, not a total)", () => {
    // THE discriminating case. CI passes `"${md_files[@]}" "${code_files[@]}"`
    // as one flat argv, so an `.md` enumeration collapse beside a healthy code
    // lane leaves argv long enough for any argv-TOTAL floor to pass — while
    // mermaid, table-total, cite-target, section-cite and the md deny are all
    // skipped by their `stagedMd.length > 0` guards. A total floor of 4 passes
    // this exact argv; the per-lane floor is what catches it.
    withLaneFixture(1, 3, ({ md, code }) => {
      const argv = [...md, ...code];
      expect(argv).toHaveLength(4);
      const result = runChecks(argv, { minimumMd: 2, minimumCode: 2 });
      expect(result.exitCode).toBe(1);
      const joined = result.messages.join("\n");
      expect(joined).toContain(".md lane resolved 1 file(s), --min-md=2 required");
      // The healthy lane is NOT reported — a breach names the lane that broke.
      expect(joined).not.toContain("code lane resolved");
    });
  });

  it("fails when the code lane collapses while the .md lane is full", () => {
    withLaneFixture(3, 1, ({ md, code }) => {
      const result = runChecks([...md, ...code], { minimumMd: 2, minimumCode: 2 });
      expect(result.exitCode).toBe(1);
      const joined = result.messages.join("\n");
      expect(joined).toContain("code lane resolved 1 file(s), --min-code=2 required");
      expect(joined).not.toContain(".md lane resolved");
    });
  });

  it("passes the SAME argv once the floors are unarmed — the floor is what fails, not the fixture", () => {
    // Negative control for both tests above: with floors off, this argv is
    // clean, so their exit 1 is attributable to the floor and not to a fixture
    // that trips some other check.
    withLaneFixture(1, 3, ({ md, code }) => {
      const result = runChecks([...md, ...code]);
      expect(result.exitCode).toBe(0);
    });
  });

  it("runs the checks normally when both floors are cleared", () => {
    withLaneFixture(3, 3, ({ md, code }) => {
      const result = runChecks([...md, ...code], { minimumMd: 2, minimumCode: 2 });
      expect(result.exitCode).toBe(0);
      expect(result.messages.join("\n")).not.toContain("lane resolved");
    });
  });

  it("reports the partitioned lane counts so a cleared-but-shrunken run stays legible", () => {
    // The counts are what main() prints when a floor is armed: clearing a floor
    // is not evidence a lane is healthy (260 `.md` files falling to 40 clears
    // `--min-md=20`), so the number itself has to be visible.
    withLaneFixture(3, 2, ({ md, code }) => {
      expect(runChecks([...md, ...code]).laneCounts).toEqual({ md: 3, code: 2 });
    });
  });

  it("still exits 0 on empty argv when no floor is armed (the lefthook posture)", () => {
    // Pins the behavior the floors deliberately do NOT change: an empty derived
    // set is legitimate at pre-commit, so the default must stay permissive.
    // Every argv-scoped check is skipped here — which is exactly why CI, whose
    // empty lane means enumeration broke, has to arm the floors.
    expect(runChecks([]).exitCode).toBe(0);
  });
});

describe("pre-commit-runner — floor wiring through main()", () => {
  const binPath = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/pre-commit-runner.ts");

  it("exits 2 on a malformed flag — a usage error, distinct from a violation", () => {
    // Exercised through spawn because the exit-code mapping lives in main(),
    // which importing `runChecks` bypasses entirely.
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", binPath, "--min-md=oops"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--min-md requires a non-negative integer");
  });

  it("prints the resolved lane counts when a floor is armed, and exits 0 when it clears", () => {
    const { root, cleanup } = setupRepo({
      "docs/note.md": "# Note\n\nProse with no cites.\n",
      "tools/docs-corpus/canonical-paths.json": '{ "paths": [] }\n',
    });
    const physicalRoot = realpathSync(root);
    try {
      const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", binPath, "--min-md=1", "docs/note.md"],
        {
          cwd: physicalRoot,
          encoding: "utf8",
          env: { ...process.env, REPO_ROOT: physicalRoot },
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("lanes resolved — 1 .md file(s), 0 code file(s)");
    } finally {
      cleanup();
    }
  });

  it("stays quiet about lane counts when no floor is armed", () => {
    // The hook path runs on every commit; the counts would be noise there.
    const { root, cleanup } = setupRepo({
      "docs/note.md": "# Note\n\nProse with no cites.\n",
      "tools/docs-corpus/canonical-paths.json": '{ "paths": [] }\n',
    });
    const physicalRoot = realpathSync(root);
    try {
      const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", binPath, "docs/note.md"],
        {
          cwd: physicalRoot,
          encoding: "utf8",
          env: { ...process.env, REPO_ROOT: physicalRoot },
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("lanes resolved");
    } finally {
      cleanup();
    }
  });
});
