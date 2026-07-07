import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

import {
  expandToInboundCiteCorpus,
  findGovernanceCitersOfCode,
  makeIndexAwareReader,
} from "../lib/inbound-cite-discovery.ts";
import { extractCites } from "../lib/cite-target-existence.ts";

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

  it("includes an unstaged docs/superpowers/specs/ citer whose cite points into a staged operations runbook", () => {
    // docs/superpowers/{plans,specs}/ are governance-adjacent design docs
    // (skill specs + plans) that cite operations / spec / plan / ADR line
    // numbers. PR #100 Commit 1 shifted a runbook by +3 lines and a
    // superpowers spec's `:NNN` cite landed on whitespace — the failure
    // surfaced only in CI because the pre-commit walker (this function's
    // original scope) excluded docs/superpowers/. Pin the inclusion.
    const { root, cleanup } = setupRepo({
      "docs/operations/runbook.md": "# Runbook\n\nline two\nline three\nline four\n",
      "docs/superpowers/specs/2026-05-design.md":
        "Cite into runbook: [runbook](../../operations/runbook.md):3.\n",
      "docs/superpowers/plans/2026-05-plan.md":
        "Plan cite into runbook: [runbook](../../operations/runbook.md):4.\n",
    });
    try {
      const expanded = withRepoRoot(root, () =>
        expandToInboundCiteCorpus([resolve(root, "docs/operations/runbook.md")]),
      );
      expect(new Set(expanded)).toEqual(
        new Set([
          resolve(root, "docs/operations/runbook.md"),
          resolve(root, "docs/superpowers/specs/2026-05-design.md"),
          resolve(root, "docs/superpowers/plans/2026-05-plan.md"),
        ]),
      );
    } finally {
      cleanup();
    }
  });

  it("fires the corpus walk when a staged file is in docs/superpowers/{plans,specs}/ (symmetry: superpowers can be citee too)", () => {
    // Bidirectional participation: docs/superpowers/{plans,specs}/ are not
    // only citers of governance — they CAN also be citees if a governance
    // doc cites a superpowers spec by `:NNN` (e.g., an audit runbook cites
    // a skill-spec line number). No such cites exist today, but the trigger
    // semantic must hold for future graph growth. Without this trigger,
    // staging an edit to a superpowers spec would not surface stale governance
    // citers — the same bug class PR #100 hit, but in reverse.
    const { root, cleanup } = setupRepo({
      "docs/superpowers/specs/2026-05-design.md": "# Design\n\nline two\n",
      "docs/operations/runbook.md":
        "Cite into superpowers spec: [design](../superpowers/specs/2026-05-design.md):2.\n",
    });
    try {
      const expanded = withRepoRoot(root, () =>
        expandToInboundCiteCorpus([resolve(root, "docs/superpowers/specs/2026-05-design.md")]),
      );
      expect(new Set(expanded)).toEqual(
        new Set([
          resolve(root, "docs/superpowers/specs/2026-05-design.md"),
          resolve(root, "docs/operations/runbook.md"),
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

  it("reads citer content from the index, ignoring unstaged worktree edits", () => {
    // A developer mid-editing one governance doc must not be blocked while
    // staging an unrelated change. The index-aware reader returns the staged
    // blob for citers, so a WIP-broken cite in the working tree is structurally
    // invisible to validation — and a WIP-introduced cite that points into the
    // staged set does NOT propagate either (only the index version is read).
    const { root, cleanup } = setupRepo({
      "docs/plans/002-foo.md": "# Plan-002\n\nline two\n",
      "docs/architecture/cross-plan-deps.md":
        "Initially clean: [Plan-002](../plans/002-foo.md):2.\n",
    });
    try {
      // Setup has staged the clean citer. Introduce an unstaged WIP edit that
      // replaces the real cite with a deliberately broken inbound cite. Under
      // the old working-tree reader, this would surface as a violation; under
      // the index-aware reader, the citer's STAGED content (the clean cite at
      // :2) is what extractCites sees, so the citer still ends up in expanded.
      writeFileSync(
        resolve(root, "docs/architecture/cross-plan-deps.md"),
        "WIP edit with deliberately broken inbound cite: [Plan-002](../plans/002-foo.md):9999.\n",
      );
      const reader = makeIndexAwareReader(root, new Set([resolve(root, "docs/plans/002-foo.md")]));
      const expanded = withRepoRoot(root, () =>
        expandToInboundCiteCorpus([resolve(root, "docs/plans/002-foo.md")], root, reader),
      );
      // Citer IS in expanded — proves the index content (the clean cite at :2)
      // resolves into the staged plan, irrespective of the broken WIP cite.
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

  it("reads citer content from the index when the worktree copy has been deleted", () => {
    // `git ls-files --cached` (the default) lists files that remain in the
    // index after an unstaged worktree `rm`. Reading the working tree would
    // throw ENOENT and crash the pre-commit runner; reading via `git show :`
    // returns the staged blob and the citer is processed normally.
    const { root, cleanup } = setupRepo({
      "docs/plans/002-foo.md": "# Plan-002\n\nline two\n",
      "docs/architecture/cross-plan-deps.md":
        "Surviving citer: [Plan-002](../plans/002-foo.md):2.\n",
      "docs/decisions/010-only-in-index.md":
        "Citer cited from index after worktree rm: [Plan-002](../plans/002-foo.md):2.\n",
    });
    try {
      // Delete the ADR from the worktree AFTER setupRepo's `git add -A`. The
      // path stays in the index; the index-aware reader returns its blob.
      rmSync(resolve(root, "docs/decisions/010-only-in-index.md"));
      const reader = makeIndexAwareReader(root, new Set([resolve(root, "docs/plans/002-foo.md")]));
      const expanded = withRepoRoot(root, () =>
        expandToInboundCiteCorpus([resolve(root, "docs/plans/002-foo.md")], root, reader),
      );
      // Both citers IN expanded — the worktree-only deletion is invisible
      // because the reader serves the staged blob.
      expect(new Set(expanded)).toEqual(
        new Set([
          resolve(root, "docs/plans/002-foo.md"),
          resolve(root, "docs/architecture/cross-plan-deps.md"),
          resolve(root, "docs/decisions/010-only-in-index.md"),
        ]),
      );
    } finally {
      cleanup();
    }
  });

  it("ignores a stage-then-worktree-edit on the citer — index content is structurally authoritative", () => {
    // Belt-and-suspenders for the dirty-skip test: a citer that was staged
    // with a clean inbound cite, then mutated in the worktree to ADD a second
    // (broken) cite — the new cite must be structurally absent from the
    // expansion path, not merely "happen to be harmless." extractCites is
    // called with the index reader; only the index's cite list (one clean
    // cite) is observed.
    const { root, cleanup } = setupRepo({
      "docs/plans/002-foo.md": "# Plan-002\n\nline two\n",
      "docs/architecture/cross-plan-deps.md": "Clean staged: [Plan-002](../plans/002-foo.md):2.\n",
    });
    try {
      // WIP mutation: KEEPS the clean cite AND adds a broken one. Under the
      // old working-tree reader, the broken cite would surface as a
      // line-out-of-range violation downstream. Under the index-aware reader,
      // extractCites only sees the index content (the single clean cite).
      writeFileSync(
        resolve(root, "docs/architecture/cross-plan-deps.md"),
        "Clean staged: [Plan-002](../plans/002-foo.md):2.\nWIP added: [Plan-002](../plans/002-foo.md):9999.\n",
      );
      const reader = makeIndexAwareReader(root, new Set([resolve(root, "docs/plans/002-foo.md")]));
      const cites = extractCites(resolve(root, "docs/architecture/cross-plan-deps.md"), reader);
      // Index content has exactly one cite at :2 — the WIP-added :9999 cite
      // is not in the index and so is invisible to extractCites.
      expect(cites).toHaveLength(1);
      expect(cites[0].targetLine).toBe(2);
    } finally {
      cleanup();
    }
  });
});

describe("findGovernanceCitersOfCode — reverse-direction advisory", () => {
  it("maps a governance citer to its staged-code rawTargets", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md":
        "# Plan-001\n\nThe parser lives at `packages/foo/src/bar.ts#doThing`.\n",
      "docs/plans/002-y.md": "# Plan-002\n\nNo code cites here.\n",
      "packages/foo/src/bar.ts": "export function doThing(): void {}\n",
    });
    try {
      const citers = withRepoRoot(root, () =>
        findGovernanceCitersOfCode([resolve(root, "packages/foo/src/bar.ts")]),
      );
      expect(citers.size).toBe(1);
      expect(citers.get("docs/plans/001-x.md")).toEqual(["packages/foo/src/bar.ts#doThing"]);
    } finally {
      cleanup();
    }
  });

  it("returns an empty map when the staged code file is uncited", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md":
        "# Plan-001\n\nThe parser lives at `packages/foo/src/bar.ts#doThing`.\n",
      "packages/foo/src/other.ts": "export function other(): void {}\n",
    });
    try {
      const citers = withRepoRoot(root, () =>
        findGovernanceCitersOfCode([resolve(root, "packages/foo/src/other.ts")]),
      );
      expect(citers.size).toBe(0);
    } finally {
      cleanup();
    }
  });
});
