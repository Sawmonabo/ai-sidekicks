import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
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
});
