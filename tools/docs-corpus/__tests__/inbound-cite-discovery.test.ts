import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

import { expandToInboundCiteCorpus } from "../lib/inbound-cite-discovery.ts";

function setupRepo(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(resolve(tmpdir(), "icd-"));
  execSync("git init -q -b main", { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    const full = resolve(root, path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  // Stage the fixture set so `git ls-files` enumerates them — the discovery
  // enumerator now uses git ls-files to exclude untracked WIP drafts (Codex
  // review on PR #98). Tests that need untracked behavior write AFTER setupRepo.
  execSync("git add -A", { cwd: root });
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

describe("inbound-cite-discovery — governance-corpus inbound expansion", () => {
  it("returns staged files unchanged when no staged file is in the governance corpus", () => {
    // README.md is outside docs/{plans,specs,decisions,architecture,domain,
    // operations}/ so the expansion must not walk the corpus. The fixture
    // also contains a citer that points at a plan — confirming the expansion
    // is gated on a STAGED governance file, not on the mere existence of one.
    const { root, cleanup } = setupRepo({
      "README.md": "# root readme\n",
      "docs/plans/002-foo.md": "# Plan-002\n\nline two\nline three\n",
      "docs/architecture/cross-plan-deps.md":
        "See [Plan-002](../plans/002-foo.md):2 for context.\n",
    });
    try {
      const expanded = withRepoRoot(root, () =>
        expandToInboundCiteCorpus([resolve(root, "README.md")]),
      );
      expect(expanded).toHaveLength(1);
      expect(expanded[0]).toBe(resolve(root, "README.md"));
    } finally {
      cleanup();
    }
  });

  it("includes an unstaged governance citer whose markdown-link cite points into a staged plan", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/002-foo.md": "# Plan-002\n\nline two\nline three\n",
      "docs/architecture/cross-plan-deps.md":
        "See [Plan-002](../plans/002-foo.md):2 for context.\n",
    });
    try {
      const expanded = withRepoRoot(root, () =>
        expandToInboundCiteCorpus([resolve(root, "docs/plans/002-foo.md")]),
      );
      expect(new Set(expanded)).toEqual(
        new Set([
          resolve(root, "docs/plans/002-foo.md"),
          resolve(root, "docs/architecture/cross-plan-deps.md"),
        ]),
      );
    } finally {
      cleanup();
    }
  });

  it("includes an unstaged citer whose code-span cite points into a staged spec", () => {
    // The code-span form `path/file.md:N` is the other cite shape
    // extractCites recognizes; verify it triggers expansion too.
    const { root, cleanup } = setupRepo({
      "docs/specs/008-foo.md": "# Spec-008\n\nline two\nline three\n",
      "docs/decisions/010-bar.md": "See `docs/specs/008-foo.md:2` for context.\n",
    });
    try {
      const expanded = withRepoRoot(root, () =>
        expandToInboundCiteCorpus([resolve(root, "docs/specs/008-foo.md")]),
      );
      expect(new Set(expanded)).toEqual(
        new Set([
          resolve(root, "docs/specs/008-foo.md"),
          resolve(root, "docs/decisions/010-bar.md"),
        ]),
      );
    } finally {
      cleanup();
    }
  });

  it("excludes citers in docs/archive/ (frozen historical content)", () => {
    // Archive entries may cite by `:NNN` into current plans, but the archive
    // is frozen by convention (CLAUDE.md §Documentation Corpus) and not in
    // the governance-corpus set the expansion walks. A staged plan's line
    // shift must not be gated on rewriting frozen historical entries.
    const { root, cleanup } = setupRepo({
      "docs/plans/002-foo.md": "# Plan-002\n\nline two\n",
      "docs/archive/backlog-archive.md": "See [Plan-002](../plans/002-foo.md):2 for context.\n",
    });
    try {
      const expanded = withRepoRoot(root, () =>
        expandToInboundCiteCorpus([resolve(root, "docs/plans/002-foo.md")]),
      );
      expect(expanded).toHaveLength(1);
      expect(expanded[0]).toBe(resolve(root, "docs/plans/002-foo.md"));
    } finally {
      cleanup();
    }
  });

  it("excludes citers in docs/reference/ (external excerpted materials)", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/002-foo.md": "# Plan-002\n\nline two\n",
      "docs/reference/external.md": "See [Plan-002](../plans/002-foo.md):2 for context.\n",
    });
    try {
      const expanded = withRepoRoot(root, () =>
        expandToInboundCiteCorpus([resolve(root, "docs/plans/002-foo.md")]),
      );
      expect(expanded).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("does not double-count a citer with multiple cites into the same staged plan", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/002-foo.md": "# Plan-002\n\nline two\nline three\n",
      "docs/architecture/cross-plan-deps.md":
        "Two cites: [Plan-002](../plans/002-foo.md):2 and [Plan-002](../plans/002-foo.md):3.\n",
    });
    try {
      const expanded = withRepoRoot(root, () =>
        expandToInboundCiteCorpus([resolve(root, "docs/plans/002-foo.md")]),
      );
      expect(expanded).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it("unions citers across multiple staged plans without including unrelated governance files", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/002-foo.md": "# Plan-002\n\nline two\n",
      "docs/plans/008-bar.md": "# Plan-008\n\nline two\n",
      "docs/architecture/cross-plan-deps.md":
        "[Plan-002](../plans/002-foo.md):2 and [Plan-008](../plans/008-bar.md):2 cited.\n",
      "docs/decisions/010-baz.md": "Only [Plan-008](../plans/008-bar.md):2.\n",
      "docs/operations/runbook.md": "No cites here at all.\n",
    });
    try {
      const expanded = withRepoRoot(root, () =>
        expandToInboundCiteCorpus([
          resolve(root, "docs/plans/002-foo.md"),
          resolve(root, "docs/plans/008-bar.md"),
        ]),
      );
      expect(new Set(expanded)).toEqual(
        new Set([
          resolve(root, "docs/plans/002-foo.md"),
          resolve(root, "docs/plans/008-bar.md"),
          resolve(root, "docs/architecture/cross-plan-deps.md"),
          resolve(root, "docs/decisions/010-baz.md"),
        ]),
      );
      // runbook.md is explicitly excluded — confirms the filter discriminates.
      expect(expanded).not.toContain(resolve(root, "docs/operations/runbook.md"));
    } finally {
      cleanup();
    }
  });

  it("does not include a governance citer whose cites target a different governance file", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/002-foo.md": "# Plan-002\n",
      "docs/plans/008-bar.md": "# Plan-008\n\nline two\n",
      "docs/architecture/cross-plan-deps.md":
        "[Plan-008](../plans/008-bar.md):2 only — unrelated to staged Plan-002.\n",
    });
    try {
      const expanded = withRepoRoot(root, () =>
        expandToInboundCiteCorpus([resolve(root, "docs/plans/002-foo.md")]),
      );
      expect(expanded).toHaveLength(1);
      expect(expanded[0]).toBe(resolve(root, "docs/plans/002-foo.md"));
    } finally {
      cleanup();
    }
  });

  it("excludes untracked private WIP files from the candidate set", () => {
    // A raw filesystem walk would scan untracked governance drafts and could
    // block a commit on a stale cite that exists only in a private WIP file
    // (not in the index, not in CI). The enumerator bounds itself via
    // `git ls-files` — index-only, so tracked + staged-new are included,
    // untracked + ignored are excluded. This test pins the exclusion.
    const { root, cleanup } = setupRepo({
      "docs/plans/002-foo.md": "# Plan-002\n\nline two\n",
      "docs/architecture/cross-plan-deps.md":
        "Real tracked cite: [Plan-002](../plans/002-foo.md):2.\n",
    });
    try {
      // setupRepo has already `git add`-ed the fixture set. Write an UNTRACKED
      // private draft AFTER setupRepo — simulating a developer's local WIP
      // file. It is on disk but not in the index. Under the old readdirSync
      // walker, its broken cite would surface here. Under git ls-files, it
      // must not appear in `expanded`.
      writeFileSync(
        resolve(root, "docs/plans/999-private-wip.md"),
        "WIP draft with a deliberately broken inbound cite: [Plan-002](../plans/002-foo.md):2.\n",
      );
      const expanded = withRepoRoot(root, () =>
        expandToInboundCiteCorpus([resolve(root, "docs/plans/002-foo.md")]),
      );
      expect(new Set(expanded)).toEqual(
        new Set([
          resolve(root, "docs/plans/002-foo.md"),
          resolve(root, "docs/architecture/cross-plan-deps.md"),
        ]),
      );
      expect(expanded).not.toContain(resolve(root, "docs/plans/999-private-wip.md"));
    } finally {
      cleanup();
    }
  });

  it("skips citers with unstaged working-tree modifications (dirty WIP)", () => {
    // A developer mid-editing one governance doc must not be blocked while
    // staging an unrelated change. `extractCites` reads the working tree, so
    // an unstaged broken cite in a citer would propagate into the validation
    // set and surface as a violation against an unrelated commit. The
    // enumerator's `git diff --name-only` filter skips dirty citers; they get
    // validated whenever they themselves are staged + committed, and CI is
    // the backstop for the residual cross-edit case.
    const { root, cleanup } = setupRepo({
      "docs/plans/002-foo.md": "# Plan-002\n\nline two\n",
      "docs/architecture/cross-plan-deps.md":
        "Initially clean: [Plan-002](../plans/002-foo.md):2.\n",
    });
    try {
      // Setup has staged the clean citer. Introduce an unstaged WIP edit that
      // adds a deliberately broken inbound cite — under the previous code,
      // this would surface as `target-line-empty` (or `line-out-of-range`)
      // and block the unrelated plan-staging commit. With the dirty-skip,
      // the citer is absent from `expanded`.
      writeFileSync(
        resolve(root, "docs/architecture/cross-plan-deps.md"),
        "WIP edit with deliberately broken inbound cite: [Plan-002](../plans/002-foo.md):9999.\n",
      );
      const expanded = withRepoRoot(root, () =>
        expandToInboundCiteCorpus([resolve(root, "docs/plans/002-foo.md")]),
      );
      // The citer must NOT appear in expanded — proves "skip" rather than
      // "scan but happen-to-pass." (The latter could pass if the WIP edit
      // happened to add a valid cite — we want the structural exclusion.)
      expect(expanded).not.toContain(resolve(root, "docs/architecture/cross-plan-deps.md"));
      expect(new Set(expanded)).toEqual(new Set([resolve(root, "docs/plans/002-foo.md")]));
    } finally {
      cleanup();
    }
  });

  it("skips candidates deleted from the worktree but still tracked in the index", () => {
    // `git ls-files --cached` (the default) lists files that are in the index
    // even when the worktree copy has been deleted (an unstaged `rm`). Without
    // an existsSync filter, the downstream `readFileSync` in extractCites
    // throws ENOENT and crashes the pre-commit runner. This is a common
    // local state: developer rm's a doc, then runs pre-commit on an unrelated
    // change before staging the delete. Verify the enumerator silently skips
    // the missing path instead of propagating an exception.
    const { root, cleanup } = setupRepo({
      "docs/plans/002-foo.md": "# Plan-002\n\nline two\n",
      "docs/architecture/cross-plan-deps.md":
        "Surviving citer: [Plan-002](../plans/002-foo.md):2.\n",
      "docs/decisions/010-to-be-deleted.md":
        "Stale citer about to vanish: [Plan-002](../plans/002-foo.md):2.\n",
    });
    try {
      // Delete the ADR from the worktree AFTER setupRepo's `git add -A`. The
      // path stays in the index; `git ls-files` will still return it.
      rmSync(resolve(root, "docs/decisions/010-to-be-deleted.md"));
      const expanded = withRepoRoot(root, () =>
        expandToInboundCiteCorpus([resolve(root, "docs/plans/002-foo.md")]),
      );
      expect(new Set(expanded)).toEqual(
        new Set([
          resolve(root, "docs/plans/002-foo.md"),
          resolve(root, "docs/architecture/cross-plan-deps.md"),
        ]),
      );
      expect(expanded).not.toContain(resolve(root, "docs/decisions/010-to-be-deleted.md"));
    } finally {
      cleanup();
    }
  });
});
