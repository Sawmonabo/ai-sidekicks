import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import {
  extractCites,
  checkCiteTargetExistence,
  formatCiteTargetViolations,
} from "../lib/cite-target-existence.ts";

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
    // Fixtures cite a NON-volatile tree (tools/): raw line-cites into
    // packages//apps/ now hit the durable-cite deny before any floor check —
    // that behavior is covered by the "durable-cite rule" suite below.
    const { root, cleanup } = setupRepo({
      "docs/note.md": "see `tools/lost/missing.ts:42` for context.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/note.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("missing-target-file");
      expect(violations[0].cite.rawTarget).toBe("tools/lost/missing.ts:42");
    } finally {
      cleanup();
    }
  });

  it("ACCEPTS path-shaped citations whose target exists at the cited line", () => {
    const { root, cleanup } = setupRepo({
      "docs/note.md": "see `tools/docs-corpus/lib/session.ts:2` for context.\n",
      "tools/docs-corpus/lib/session.ts": "line one\nline two\nline three\n",
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
      "docs/note.md": "see `tools/docs-corpus/lib/session.ts:99` for context.\n",
      "tools/docs-corpus/lib/session.ts": "line one\nline two\n",
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

  it("FLAGS markdown-link range citations whose end line is out of range", () => {
    // Codex review on PR #27 commit f6e7895: range citations like
    // `[Plan-X](file.md):10-99` previously only validated the start; the
    // end was discarded by `s.split("-")[0]`. A file that shrinks below
    // the cited end-line silently passed.
    const { root, cleanup } = setupRepo({
      "docs/note.md": "see [Plan-X](./target.md):2-99 for context.\n",
      "docs/target.md": "line one\nline two\nline three\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/note.md")]),
      );
      const outOfRange = violations.filter((v) => v.reason === "line-out-of-range");
      expect(outOfRange).toHaveLength(1);
      expect(outOfRange[0].cite.targetLine).toBe(99);
    } finally {
      cleanup();
    }
  });

  it("ACCEPTS markdown-link range citations whose endpoints are both valid", () => {
    const { root, cleanup } = setupRepo({
      "docs/note.md": "see [Plan-X](./target.md):1-3 for context.\n",
      "docs/target.md": "line one\nline two\nline three\n",
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

  it("TERMINATES the repo-root walk at the filesystem root (Windows drive-root parity)", () => {
    // Codex review on PR #27 commit 90b6e40 flagged the equivalent walk in
    // path-canonical-ripple.ts; this file shared the same bug. The walk
    // terminated on `dir !== "/"` which is POSIX-specific — `path.dirname
    // ("C:\\")` returns `"C:\\"` so a Windows pre-commit hook would loop
    // forever with no diagnostic. The fix terminates on parent-equals-current
    // and falls back to `process.cwd()` if no `.git` ancestor is found,
    // matching the prior fallback semantics. Test bypasses REPO_ROOT so the
    // path actually exercises `findRepoRoot`; if the loop ever regressed,
    // vitest's per-test timeout would catch the hang.
    const root = mkdtempSync(resolve(tmpdir(), "cte-noroot-"));
    // Intentionally do NOT `git init` — the walk must reach the filesystem
    // root and terminate there rather than spinning.
    writeFileSync(resolve(root, "note.md"), "see `something.ts:42` for context.\n");
    const prevCwd = process.cwd();
    const prevRepoRoot = process.env.REPO_ROOT;
    try {
      delete process.env.REPO_ROOT;
      process.chdir(root);
      // Bare-name lookup with no `.git` ancestor: should return [] without
      // hanging. The function must complete; the value is the known-limitation
      // skip, not the termination condition under test.
      const cites = extractCites(resolve(root, "note.md"));
      expect(cites).toEqual([]);
    } finally {
      process.chdir(prevCwd);
      if (prevRepoRoot === undefined) delete process.env.REPO_ROOT;
      else process.env.REPO_ROOT = prevRepoRoot;
      rmSync(root, { recursive: true });
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

describe("durable-cite rule", () => {
  it("denies a raw line-cite whose target resolves under packages/", () => {
    const { root, cleanup } = setupRepo({
      "docs/note.md": "see `packages/foo/src/bar.ts:12` for context.\n",
      "packages/foo/src/bar.ts": Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"),
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/note.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("raw-line-cite-into-volatile-code");
    } finally {
      cleanup();
    }
  });

  it("still floors raw line-cites into non-volatile trees (tools/)", () => {
    const { root, cleanup } = setupRepo({
      "docs/note.md": "see `tools/docs-corpus/lib/slug.ts:9999` for context.\n",
      "tools/docs-corpus/lib/slug.ts": "line one\nline two\n",
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

  it("passes a path#symbol cite whose symbol is present", () => {
    const { root, cleanup } = setupRepo({
      "docs/note.md": "see `packages/foo/src/bar.ts#exportedName` for context.\n",
      "packages/foo/src/bar.ts": "export function exportedName(): void {}\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/note.md")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("fails a path#symbol cite whose symbol is absent", () => {
    const { root, cleanup } = setupRepo({
      "docs/note.md": "see `packages/foo/src/bar.ts#missingName` for context.\n",
      "packages/foo/src/bar.ts": "export function presentName(): void {}\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/note.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("symbol-not-found");
    } finally {
      cleanup();
    }
  });

  it("fails a path#symbol cite whose file is missing", () => {
    const { root, cleanup } = setupRepo({
      "docs/note.md": "see `packages/lost/src/gone.ts#anything` for context.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/note.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("missing-target-file");
    } finally {
      cleanup();
    }
  });

  it("keeps floor semantics for a packages/**.md target (docs, not code)", () => {
    const { root, cleanup } = setupRepo({
      "docs/note.md": "see `packages/foo/README.md:9999` for context.\n",
      "packages/foo/README.md": "# readme\n\nshort file\n",
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

  it("denies a RANGE cite into packages/ exactly once (per-endpoint expansion + dedupe)", () => {
    const { root, cleanup } = setupRepo({
      "docs/note.md": "see `packages/foo/src/bar.ts:10-99` for context.\n",
      "packages/foo/src/bar.ts": Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n"),
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/note.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("raw-line-cite-into-volatile-code");
    } finally {
      cleanup();
    }
  });

  it("floors BOTH endpoints of a backticked .md range (new capability)", () => {
    const { root, cleanup } = setupRepo({
      "docs/note.md": "see `docs/other.md:3-9999` for context.\n",
      "docs/other.md": Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"),
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/note.md")]),
      );
      expect(violations.some((v) => v.reason === "line-out-of-range")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("does not false-pass a #symbol cite on a substring or comment mention", () => {
    const { root, cleanup } = setupRepo({
      "docs/note.md": "see `packages/foo/src/bar.ts#doThing` for context.\n",
      "packages/foo/src/bar.ts": "export function doThingFast(): void {}\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/note.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("symbol-not-found");
      expect(violations[0].detail).toContain("exported symbols");
    } finally {
      cleanup();
    }
  });

  it("handles $ in symbol names without regex breakage", () => {
    const { root, cleanup } = setupRepo({
      "docs/note.md": "see `packages/foo/src/bar.ts#store$` for context.\n",
      "packages/foo/src/bar.ts": "export const store$ = makeStore();\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/note.md")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("gates bare-name #symbol cites exactly like bare-name line cites", () => {
    const { root, cleanup } = setupRepo({
      "docs/note.md": "see `session.ts#SessionSubscribeRequest` for context.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/note.md")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("durable-cite rule — Codex round-1 hardening (PR #188)", () => {
  it("denies a ./-spelled raw line-cite into packages/ (normalizes before the prefix test)", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md": "# Plan\n\nSee `./packages/lost/src/missing.ts:42` for detail.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("raw-line-cite-into-volatile-code");
    } finally {
      cleanup();
    }
  });

  it("denies a markdown-link line-pin whose target is volatile code", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md": "# Plan\n\nSee [impl](../../packages/foo/src/bar.ts):12 for detail.\n",
      "packages/foo/src/bar.ts": "export function doThing(): void {}\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("raw-line-cite-into-volatile-code");
    } finally {
      cleanup();
    }
  });

  it("leaves a markdown-link line-pin to non-volatile code unextracted (pre-existing scope)", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md": "# Plan\n\nSee [helper](../../tools/foo.ts):12 for detail.\n",
      "tools/foo.ts": "export function helper(): void {}\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
  it("denies a dot-segment-traversal spelling (`docs/../packages/…`) — volatility tests the RESOLVED path", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md": "# Plan\n\nSee `docs/../packages/foo/src/bar.ts:12` for detail.\n",
      "packages/foo/src/bar.ts": "export function doThing(): void {}\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("raw-line-cite-into-volatile-code");
    } finally {
      cleanup();
    }
  });
});

describe("durable-cite rule — Codex round-4 hardening (PR #188)", () => {
  it("denies a BARE (unbackticked) volatile line-pin, one violation per site", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md":
        "# Plan\n\nModify packages/foo/src/bar.ts:24,35,59 rewritten to event names.\n",
      "packages/foo/src/bar.ts": "export function doThing(): void {}\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("raw-line-cite-into-volatile-code");
    } finally {
      cleanup();
    }
  });

  it("denies dot-segment bare spellings via resolve-then-test (`./packages/…`, `docs/../packages/…`)", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md":
        "# Plan\n\nEdit ./packages/foo/src/bar.ts:12 today.\n\nAlso docs/../packages/foo/src/bar.ts:30 tomorrow.\n",
      "packages/foo/src/bar.ts": "export function doThing(): void {}\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(2);
      for (const violation of violations) {
        expect(violation.reason).toBe("raw-line-cite-into-volatile-code");
      }
    } finally {
      cleanup();
    }
  });

  it("skips bare volatile pins inside code fences (quoted-example carve-out)", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md":
        '# Plan\n\n```js\n  summary: "Modify packages/foo/src/bar.ts:24,35,59",\n```\n\nprose\n',
      "packages/foo/src/bar.ts": "export function doThing(): void {}\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("leaves a bare NON-volatile path mention unextracted", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md": "# Plan\n\nSee tools/foo.ts:12 for the helper.\n",
      "tools/foo.ts": "export function helper(): void {}\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("denies a raw line-pin into a volatile .rs target", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md":
        "# Plan\n\nSee `packages/sidecar-rust-pty/src/framing.rs:42` for the codec.\n",
      "packages/sidecar-rust-pty/src/framing.rs": "pub struct FrameCodec;\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("raw-line-cite-into-volatile-code");
    } finally {
      cleanup();
    }
  });

  it("keeps EXTERNAL .rs line cites invisible (no floor — they cite upstream sources)", () => {
    const { root, cleanup } = setupRepo({
      "docs/decisions/021-x.md":
        "# ADR\n\nkeyring-rs hardcodes it at `src/windows.rs:413` (not tunable).\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/decisions/021-x.md")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("verifies a #symbol cite into a volatile .rs target", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md":
        "# Plan\n\nFraming per `packages/sidecar-rust-pty/src/framing.rs#FrameCodec`.\n",
      "packages/sidecar-rust-pty/src/framing.rs": "pub struct FrameCodec;\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("flags symbol-not-found for a dead #symbol into a volatile .rs target", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md":
        "# Plan\n\nFraming per `packages/sidecar-rust-pty/src/framing.rs#GoneCodec`.\n",
      "packages/sidecar-rust-pty/src/framing.rs": "pub struct FrameCodec;\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("symbol-not-found");
    } finally {
      cleanup();
    }
  });

  it("keeps EXTERNAL .rs #symbol cites invisible", () => {
    const { root, cleanup } = setupRepo({
      "docs/decisions/021-x.md": "# ADR\n\nSee `src/windows.rs#CredWrite` upstream.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/decisions/021-x.md")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("durable-cite rule — malformed #fragment deny (fails closed)", () => {
  // Before this suite's subject landed, symbolRe's fragment charset could not
  // span a hyphen AND required the closing backtick immediately after, so a
  // `path#some-test-id` spelling matched NO extraction pass: no symbol check,
  // no existence check, exit 0 even against a nonexistent path (PR #302
  // discovery record — the perturbation probe that proved the hole). These
  // cases are the negative controls proving the checker can now fail.
  it("denies a hyphenated test-id fragment on an existing volatile target", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md":
        "# Plan\n\nCovered by `packages/foo/src/bar.test.ts#emits-created-event`.\n",
      "packages/foo/src/bar.test.ts": 'it("emits-created-event", () => {});\n',
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("malformed-symbol-anchor");
      expect(violations[0].detail).toContain("exported-symbol anchor");
    } finally {
      cleanup();
    }
  });

  it("denies a malformed fragment even when the target file is missing (form precedes read)", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md": "# Plan\n\nSee `packages/lost/src/gone.ts#some-test-id`.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("malformed-symbol-anchor");
    } finally {
      cleanup();
    }
  });

  it("denies a GitHub single-line `#L42` fragment (identifier-shaped line-pin, denied by kind)", () => {
    // `L42` passes identifier grammar, so a charset-only classifier would fall
    // through to the symbol-presence check and the verdict would ride on
    // whether the file coincidentally contains the string `L42`.
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md": "# Plan\n\nSee `packages/foo/src/bar.ts#L42` for the guard.\n",
      "packages/foo/src/bar.ts": "export function doThing(): void {}\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("malformed-symbol-anchor");
    } finally {
      cleanup();
    }
  });

  it("denies a GitHub range `#L18-L205` fragment", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md": "# Plan\n\nSee `packages/foo/src/bar.ts#L18-L205` for the span.\n",
      "packages/foo/src/bar.ts": "export function doThing(): void {}\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("malformed-symbol-anchor");
    } finally {
      cleanup();
    }
  });

  it("denies an EMPTY fragment on a non-volatile path (scope is path-shaped, not volatile-only)", () => {
    const { root, cleanup } = setupRepo({
      "docs/note.md": "see `tools/docs-corpus/lib/slug.ts#` for context.\n",
      "tools/docs-corpus/lib/slug.ts": "export const slug = 1;\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/note.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("malformed-symbol-anchor");
    } finally {
      cleanup();
    }
  });

  it("keeps slash-free malformed fragments gated like every bare-name cite", () => {
    const { root, cleanup } = setupRepo({
      "docs/note.md": "see `session.ts#some-test-id` for context.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/note.md")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("keeps EXTERNAL .rs malformed fragments invisible (upstream anchor conventions differ)", () => {
    const { root, cleanup } = setupRepo({
      "docs/decisions/021-x.md": "# ADR\n\nSee `src/windows.rs#cred-write-flow` upstream.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/decisions/021-x.md")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("flags only the malformed cite when a valid #symbol cite shares the line", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md":
        "# Plan\n\nPer `packages/foo/src/bar.ts#doThing` and `packages/foo/src/bar.ts#does-the-thing`.\n",
      "packages/foo/src/bar.ts": "export function doThing(): void {}\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("malformed-symbol-anchor");
      expect(violations[0].cite.rawTarget).toBe("packages/foo/src/bar.ts#does-the-thing");
    } finally {
      cleanup();
    }
  });
});

describe("durable-cite rule — malformed-deny round 2 (Codex P2s, PR #315)", () => {
  // Round-2 hardening of the deny above. (1) The FORM deny honors the repo's
  // example channels — fenced blocks, `<!-- cite-shape-example -->` waivered
  // lines, exempt citer trees — reverting to the pre-ratchet gate-invisible
  // posture there; WELL-FORMED cites in the same contexts keep the symbol
  // pass's standing fence-blind verification, so the ratchet only ever
  // tightened enforced prose. (2) The fragment grammar is Unicode identifier
  // grammar (TS = ECMAScript IdentifierName, Rust = ID_Start/ID_Continue),
  // so a legal `café` export is citable and the boundary lookarounds cannot
  // false-match a fragment inside a longer Unicode identifier.
  it("suppresses the deny for a malformed example inside a fenced block", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md":
        "# Plan\n\n```md\nsee `packages/foo/src/bar.test.ts#emits-created-event`\n```\n",
      "packages/foo/src/bar.test.ts": 'it("emits-created-event", () => {});\n',
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("suppresses the deny for a malformed example on a waivered line", () => {
    const { root, cleanup } = setupRepo({
      "docs/operations/catalog.md":
        "# Catalog\n\n| Example | `packages/foo/src/bar.ts#some-test-id` | <!-- cite-shape-example -->\n",
      "packages/foo/src/bar.ts": "export function doThing(): void {}\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/operations/catalog.md")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("suppresses the deny for a malformed cite from an exempt citer tree (docs/superpowers/)", () => {
    const { root, cleanup } = setupRepo({
      "docs/superpowers/plans/campaign.md":
        "# Campaign\n\nSee `packages/foo/src/bar.ts#some-test-id`.\n",
      "packages/foo/src/bar.ts": "export function doThing(): void {}\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/superpowers/plans/campaign.md")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("still VERIFIES a well-formed cite inside a fence (fence-blind verification preserved)", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md": "# Plan\n\n```md\nsee `packages/foo/src/bar.ts#doesNotExist`\n```\n",
      "packages/foo/src/bar.ts": "export function doThing(): void {}\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("symbol-not-found");
    } finally {
      cleanup();
    }
  });

  it("still VERIFIES a well-formed cite on a waivered line", () => {
    const { root, cleanup } = setupRepo({
      "docs/operations/catalog.md":
        "# Catalog\n\n| Hook | `packages/foo/src/bar.ts#doesNotExist` | <!-- cite-shape-example -->\n",
      "packages/foo/src/bar.ts": "export function doThing(): void {}\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/operations/catalog.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("symbol-not-found");
    } finally {
      cleanup();
    }
  });

  it("accepts a Unicode exported identifier fragment", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md": "# Plan\n\nPer `packages/foo/src/bar.ts#café`.\n",
      "packages/foo/src/bar.ts": "export const café = 1;\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("routes an ABSENT Unicode fragment to symbol-not-found and lists Unicode exports", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md": "# Plan\n\nPer `packages/foo/src/bar.ts#thé`.\n",
      "packages/foo/src/bar.ts": "export const café = 1;\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("symbol-not-found");
      expect(violations[0].detail).toContain("café");
    } finally {
      cleanup();
    }
  });

  it("does not false-match a fragment that is a prefix of a longer Unicode identifier", () => {
    // The ASCII lookahead (?![\w$]) saw a boundary between `caf` and `é`
    // (é is not ASCII \w), so `#caf` verified against `café`. The Unicode
    // boundary class closes that.
    const { root, cleanup } = setupRepo({
      "docs/plans/001-x.md": "# Plan\n\nPer `packages/foo/src/bar.ts#caf`.\n",
      "packages/foo/src/bar.ts": "export const café = 1;\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("symbol-not-found");
    } finally {
      cleanup();
    }
  });
});

describe("cite-target-existence — flush-digit locator boundary + shared fence tracker (round 3)", () => {
  it("a colon-space numeric VALUE after an md link is prose, not a floor-checked pin", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/016-x.md": "# Spec\n\nshort\n",
      "docs/note.md": "Cap per [Limit](specs/016-x.md): 25 participants today.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/note.md")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("a colon-space numeric VALUE after a code link is prose, not a volatile-tree deny", () => {
    const { root, cleanup } = setupRepo({
      "packages/foo/src/bar.ts": "export function doThing(): void {}\n",
      "docs/note.md": "Touched [the parser](../packages/foo/src/bar.ts): 25 call sites.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/note.md")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("the flush-digit md link pin still floors (boundary tightening removes values, not pins)", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/016-x.md": "# Spec\n\nshort\n",
      "docs/note.md": "Cap per [Limit](specs/016-x.md):25 today.\n",
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

  it("bare-volatile pass: an interior info-string delimiter line does not flip the fence off, and the same pin outside the fence still denies", () => {
    const fenced = [
      "# Note",
      "",
      "```text",
      "```ts",
      "packages/foo/src/bar.ts:99 — illustrative fixture row",
      "```",
      "",
      "prose after the fence.",
      "",
    ].join("\n");
    const live = "# Note\n\npackages/foo/src/bar.ts:99 is a live pin.\n";
    const { root, cleanup } = setupRepo({
      "packages/foo/src/bar.ts": "export function doThing(): void {}\n",
      "docs/fenced.md": fenced,
      "docs/live.md": live,
    });
    try {
      const fencedViolations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/fenced.md")]),
      );
      expect(fencedViolations).toHaveLength(0);
      const liveViolations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/live.md")]),
      );
      expect(liveViolations).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});

// formatCiteTargetViolations shipped with no test: replacing its body with
// `return ""` passed the entire suite (CAT-10 mutation pass 3). The runner
// pushes its return value straight into the operator-facing failure message
// (pre-commit-runner.ts), so an empty or field-poor string is a gate that
// blocks the commit while saying nothing about what to fix.
//
// The violation is produced END-TO-END rather than hand-built: a literal
// CiteViolation would keep passing after the real shape drifted away from it.
describe("cite-target-existence — formatCiteTargetViolations operator message", () => {
  it("names file, line, target, reason and detail, and totals the violations", () => {
    const { root, cleanup } = setupRepo({
      "docs/note.md": "See [Plan-002](plans/002-foo.md):99 for context.\n",
      "docs/plans/002-foo.md": "# Plan-002\n\nonly three\nlines here\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkCiteTargetExistence([resolve(root, "docs/note.md")]),
      );
      expect(violations).toHaveLength(1);

      const message = formatCiteTargetViolations(violations);
      // Each assertion is a separate field an operator needs to locate and fix
      // the cite; asserting only "message !== ''" would pass on a string that
      // named the count and nothing else.
      expect(message).toContain("docs/note.md");
      expect(message).toContain(`:${violations[0].cite.line}`);
      expect(message).toContain(violations[0].cite.rawTarget);
      expect(message).toContain(violations[0].reason);
      expect(message).toContain(violations[0].detail);
      expect(message).toContain("1 violation(s)");
    } finally {
      cleanup();
    }
  });
});
