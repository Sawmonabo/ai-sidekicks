import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import {
  checkPathCanonicalRipple,
  formatPathRippleViolations,
} from "../lib/path-canonical-ripple.ts";

function setupRepo(
  files: Record<string, string>,
  registry: object,
): { root: string; cleanup: () => void } {
  const root = mkdtempSync(resolve(tmpdir(), "pcr-"));
  execSync("git init -q -b main", { cwd: root });
  execSync("git config user.email test@test", { cwd: root });
  execSync("git config user.name test", { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    const full = resolve(root, path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  // Place the registry at a non-canonical path and point the lib at it via
  // DOCS_CORPUS_REGISTRY env. Avoids leaking the canonical
  // `tools/docs-corpus/...` path into the test's git tree (and into the
  // path-canonical-ripple sweep itself).
  writeFileSync(resolve(root, "registry.json"), JSON.stringify(registry, null, 2));
  execSync("git add -A && git commit -q -m bootstrap", { cwd: root });
  return { root, cleanup: () => rmSync(root, { recursive: true }) };
}

function runCheck(root: string): { hits: ReturnType<typeof checkPathCanonicalRipple> } {
  const prevCwd = process.cwd();
  const prevRegistry = process.env.DOCS_CORPUS_REGISTRY;
  try {
    process.chdir(root);
    process.env.DOCS_CORPUS_REGISTRY = "registry.json";
    const hits = checkPathCanonicalRipple();
    return { hits };
  } finally {
    process.chdir(prevCwd);
    if (prevRegistry === undefined) delete process.env.DOCS_CORPUS_REGISTRY;
    else process.env.DOCS_CORPUS_REGISTRY = prevRegistry;
  }
}

describe("path-canonical-ripple", () => {
  it("REJECTS PR-#24 surviving 'apps/desktop/shell' references", () => {
    const { root, cleanup } = setupRepo(
      {
        "docs/decisions/022-toolchain.md": [
          "uses apps/desktop/ canonical",
          "pnpm rebuild --filter=apps/desktop/shell better-sqlite3",
          "second occurrence: apps/desktop/shell",
          "third: apps/desktop/shell stuff",
        ].join("\n"),
        "docs/architecture/cross-plan-dependencies.md":
          "apps/desktop/renderer references go here\n",
      },
      {
        paths: [
          {
            canonical: "apps/desktop/",
            deprecated: ["apps/desktop/shell", "apps/desktop/renderer"],
            scope: ["docs/**/*.md"],
            exclude: ["docs/archive/**"],
          },
        ],
      },
    );
    const { hits } = runCheck(root);
    const formatted = formatPathRippleViolations(hits);
    expect(hits.length).toBeGreaterThan(0);
    expect(formatted).toMatch(/apps\/desktop\/shell/);
    expect(formatted).toMatch(/apps\/desktop\/renderer/);
    cleanup();
  });

  it("ACCEPTS the canonicalized state", () => {
    const { root, cleanup } = setupRepo(
      {
        "docs/decisions/022-toolchain.md": "uses apps/desktop/ everywhere\n",
      },
      {
        paths: [
          {
            canonical: "apps/desktop/",
            deprecated: ["apps/desktop/shell", "apps/desktop/renderer"],
            scope: ["docs/**/*.md"],
            exclude: ["docs/archive/**"],
          },
        ],
      },
    );
    const { hits } = runCheck(root);
    expect(hits).toEqual([]);
    cleanup();
  });

  it("RESPECTS the archive exclude rule", () => {
    const { root, cleanup } = setupRepo(
      {
        "docs/archive/old-plan.md": "historical apps/desktop/shell reference\n",
      },
      {
        paths: [
          {
            canonical: "apps/desktop/",
            deprecated: ["apps/desktop/shell"],
            scope: ["docs/**/*.md"],
            exclude: ["docs/archive/**"],
          },
        ],
      },
    );
    const { hits } = runCheck(root);
    expect(hits).toEqual([]);
    cleanup();
  });

  it("IGNORES unstaged working-tree edits to tracked files", () => {
    // Codex review on PR #27: the prior `git grep` invocation omitted
    // `--cached` and therefore scanned the working tree, so a tracked file
    // with unrelated WIP containing a deprecated path could block a clean
    // commit. A pre-commit gate should reflect what the next commit would
    // contribute (i.e. the index), not arbitrary unstaged drift.
    const root = mkdtempSync(resolve(tmpdir(), "pcr-wip-"));
    execSync("git init -q -b main", { cwd: root });
    execSync("git config user.email test@test", { cwd: root });
    execSync("git config user.name test", { cwd: root });
    mkdirSync(resolve(root, "docs"), { recursive: true });
    writeFileSync(resolve(root, "docs/clean.md"), "uses apps/desktop/ everywhere\n");
    writeFileSync(
      resolve(root, "registry.json"),
      JSON.stringify(
        {
          paths: [
            {
              canonical: "apps/desktop/",
              deprecated: ["apps/desktop/shell"],
              scope: ["docs/**/*.md"],
              exclude: ["docs/archive/**"],
            },
          ],
        },
        null,
        2,
      ),
    );
    execSync("git add -A && git commit -q -m bootstrap", { cwd: root });
    // Introduce a deprecated string in the working tree only — do NOT stage.
    writeFileSync(
      resolve(root, "docs/clean.md"),
      "uses apps/desktop/ everywhere\nWIP: apps/desktop/shell mention\n",
    );
    const prevCwd = process.cwd();
    const prevRegistry = process.env.DOCS_CORPUS_REGISTRY;
    try {
      process.chdir(root);
      process.env.DOCS_CORPUS_REGISTRY = "registry.json";
      const hits = checkPathCanonicalRipple();
      expect(hits).toEqual([]);
      // Sanity check the inverse: once the WIP is staged, the same content
      // SHOULD be flagged. Confirms `--cached` is the only source of the
      // earlier acceptance and the hook still catches deprecated paths in
      // the index.
      execSync("git add docs/clean.md", { cwd: root });
      const stagedHits = checkPathCanonicalRipple();
      expect(stagedHits.length).toBeGreaterThan(0);
      expect(stagedHits[0].deprecated).toBe("apps/desktop/shell");
    } finally {
      process.chdir(prevCwd);
      if (prevRegistry === undefined) delete process.env.DOCS_CORPUS_REGISTRY;
      else process.env.DOCS_CORPUS_REGISTRY = prevRegistry;
      rmSync(root, { recursive: true });
    }
  });

  it("REGISTRY SHAPE: no deprecated entry ends with '/' (substring-match contract)", () => {
    // Codex review on PR #27 commit c09ce2f: a deprecated entry like
    // `apps/desktop/shell/` (with trailing slash) only catches the
    // literal-path form via `git grep -F` substring matching; it MISSES the
    // executable / CLI form `--filter=apps/desktop/shell` that PR #24 round 1
    // famously failed to canonicalize. The no-slash form catches BOTH.
    //
    // This test guards the registry shape itself, not the runtime behavior:
    // if a future contributor adds a deprecated entry with a trailing slash,
    // this test fires loudly so the CLI-form blind spot does not silently
    // re-emerge. If a slash IS load-bearing for a future entry (e.g. when
    // the substring would false-positive), document the rationale in the
    // entry's `note` field and add an explicit allowlist exception here.
    const here = dirname(fileURLToPath(import.meta.url));
    const registryPath = resolve(here, "..", "canonical-paths.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
      paths: { canonical: string; deprecated: string[] }[];
    };
    const slashy: { canonical: string; deprecated: string }[] = [];
    for (const entry of registry.paths) {
      for (const dep of entry.deprecated) {
        if (dep.endsWith("/")) slashy.push({ canonical: entry.canonical, deprecated: dep });
      }
    }
    expect(slashy).toEqual([]);
  });

  it("FAILS CLOSED when the registry file is missing", () => {
    // Codex review on PR #27: prior behavior logged a warning and returned an
    // empty registry, silently disabling the canonical-path guard if the file
    // was deleted/renamed. An enforcement gate must fail loudly when its
    // policy source vanishes — silent disable is the worst outcome.
    const root = mkdtempSync(resolve(tmpdir(), "pcr-missing-"));
    execSync("git init -q -b main", { cwd: root });
    execSync("git config user.email test@test", { cwd: root });
    execSync("git config user.name test", { cwd: root });
    execSync("git commit -q --allow-empty -m bootstrap", { cwd: root });
    const prevCwd = process.cwd();
    const prevRegistry = process.env.DOCS_CORPUS_REGISTRY;
    try {
      process.chdir(root);
      process.env.DOCS_CORPUS_REGISTRY = "registry.json";
      expect(() => checkPathCanonicalRipple()).toThrow(/path-canonical-ripple: registry missing/i);
    } finally {
      process.chdir(prevCwd);
      if (prevRegistry === undefined) delete process.env.DOCS_CORPUS_REGISTRY;
      else process.env.DOCS_CORPUS_REGISTRY = prevRegistry;
      rmSync(root, { recursive: true });
    }
  });
});
