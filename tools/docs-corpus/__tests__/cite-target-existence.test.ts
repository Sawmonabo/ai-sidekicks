import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { extractCites, checkCiteTargetExistence } from "../lib/cite-target-existence.ts";

function setupRepo(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(resolve(tmpdir(), "cte-"));
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

describe("cite-target-existence — inline-code citations", () => {
  it("FLAGS path-shaped citations whose target file is missing", () => {
    // Codex review on PR #27: path-shaped inline-code citations like
    // `path/to/file.ts:123` were being silently skipped when the target
    // didn't exist, masking renamed/deleted targets. Re-importing the lib
    // dynamically would be cleaner than env-var threading, but
    // REPO_ROOT-on-import is the existing pattern.
    const { root, cleanup } = setupRepo({
      "docs/note.md": "see `packages/lost/src/missing.ts:42` for context.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/note.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("missing-target-file");
      expect(violations[0].cite.rawTarget).toBe("packages/lost/src/missing.ts:42");
    } finally {
      cleanup();
    }
  });

  it("ACCEPTS path-shaped citations whose target exists at the cited line", () => {
    const { root, cleanup } = setupRepo({
      "docs/note.md": "see `packages/contracts/src/session.ts:2` for context.\n",
      "packages/contracts/src/session.ts": "line one\nline two\nline three\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/note.md")]),
      );
      expect(violations).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("FLAGS path-shaped citations whose target line is out of range", () => {
    const { root, cleanup } = setupRepo({
      "docs/note.md": "see `packages/contracts/src/session.ts:99` for context.\n",
      "packages/contracts/src/session.ts": "line one\nline two\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/note.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("line-out-of-range");
    } finally {
      cleanup();
    }
  });

  it("SKIPS bare-name citations whose target is missing (preserves known limitation)", () => {
    // Bare-name citations like `session.ts:N` resolve only against REPO_ROOT,
    // which is the wrong location for nested files. Until basename resolution
    // is reworked, treating a bare-name miss as a violation would generate
    // false positives on every existing `session.ts:N` style reference whose
    // canonical location is `packages/contracts/src/session.ts`.
    const { root, cleanup } = setupRepo({
      "docs/note.md": "see `session.ts:42` for context.\n",
    });
    try {
      const cites = withRepoRoot(root, () => extractCites(resolve(root, "docs/note.md")));
      expect(cites).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
