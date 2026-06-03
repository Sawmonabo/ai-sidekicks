import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import {
  extractLabelCites,
  checkLabelCiteTargets,
  formatLabelCiteViolations,
} from "../lib/label-cite.ts";

function setupRepo(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(resolve(tmpdir(), "lc-"));
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

// A governing doc with 5 non-empty content lines. Trailing newline makes
// split("\n").length === 6 (the final "" element), so :1-5 are valid, :6 is
// whitespace-only, and :7+ are out of range — matching checkCite's semantics.
const FIVE_LINE_DOC = "line one\nline two\nline three\nline four\nline five\n";

describe("label-cite — token → path resolution", () => {
  it("resolves Spec-/Plan-/ADR- tokens to their own governance tree", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
      "docs/plans/001-shared-session-core.md": FIVE_LINE_DOC,
      "docs/decisions/019-windows-v1-tier.md": FIVE_LINE_DOC,
      "packages/runtime-daemon/src/node.ts":
        "// Spec-003:2 governs attach; Plan-001:3 sequences it; ADR-019:4 scopes it.\n",
    });
    try {
      const cites = withRepoRoot(root, () =>
        extractLabelCites(resolve(root, "packages/runtime-daemon/src/node.ts")),
      );
      expect(cites.map((c) => c.rawTarget).sort()).toEqual([
        "ADR-019:4",
        "Plan-001:3",
        "Spec-003:2",
      ]);
      // Each resolved to a file in its own tree (specs/plans/decisions), not a
      // shared number space.
      expect(cites.find((c) => c.rawTarget === "Spec-003:2")!.targetPath).toContain("/docs/specs/");
      expect(cites.find((c) => c.rawTarget === "Plan-001:3")!.targetPath).toContain("/docs/plans/");
      expect(cites.find((c) => c.rawTarget === "ADR-019:4")!.targetPath).toContain(
        "/docs/decisions/",
      );
    } finally {
      cleanup();
    }
  });
});

describe("label-cite — the deterministic floor (checkLabelCiteTargets)", () => {
  it("ACCEPTS a colon cite that points at a non-empty in-range line", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
      "packages/runtime-daemon/src/node.ts": "// see Spec-003:2 for the attach handshake.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/node.ts")]),
      );
      expect(violations).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("FLAGS a colon cite whose target line is out of range", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
      "packages/runtime-daemon/src/node.ts": "// see Spec-003:99 for the attach handshake.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/node.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("line-out-of-range");
      expect(violations[0].cite.rawTarget).toBe("Spec-003:99");
    } finally {
      cleanup();
    }
  });

  it("FLAGS a colon cite whose target line is whitespace-only", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
      "packages/runtime-daemon/src/node.ts": "// see Spec-003:6 for the attach handshake.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/node.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("target-line-empty");
    } finally {
      cleanup();
    }
  });

  it("FLAGS a cite to a governance doc that does not exist (missing-target-file)", () => {
    // Spec-028 has no doc — a cite to a nonexistent/deleted doc is a real
    // defect; the resolver returns a sentinel path no reader can open.
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
      "packages/runtime-daemon/src/node.ts": "// see Spec-028:1 for the (nonexistent) spec.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/node.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("missing-target-file");
      expect(violations[0].cite.rawTarget).toBe("Spec-028:1");
    } finally {
      cleanup();
    }
  });

  it("validates BOTH endpoints of a range cite and isolates the bad one", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/006-event-taxonomy.md": FIVE_LINE_DOC,
      "packages/contracts/src/event.ts": "// Spec-006:2-99 spans the taxonomy block.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/contracts/src/event.ts")]),
      );
      const outOfRange = violations.filter((v) => v.reason === "line-out-of-range");
      expect(outOfRange).toHaveLength(1);
      expect(outOfRange[0].cite.targetLine).toBe(99);
      // The valid start endpoint (:2) produced no violation.
      expect(violations).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("emits one cite per comma-list endpoint", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/006-event-taxonomy.md": FIVE_LINE_DOC,
      "packages/contracts/src/event.ts": "// Spec-006:1, 3, 5 enumerate the cases.\n",
    });
    try {
      const cites = withRepoRoot(root, () =>
        extractLabelCites(resolve(root, "packages/contracts/src/event.ts")),
      );
      expect(cites.map((c) => c.targetLine).sort((a, b) => a - b)).toEqual([1, 3, 5]);
    } finally {
      cleanup();
    }
  });
});

describe("label-cite — docs-path form (floors label-LESS docs: domain / architecture / ops)", () => {
  it("ACCEPTS a `docs/...md:LL` cite at a non-empty in-range line of a label-less doc", () => {
    // session-model.md carries no Spec/Plan/ADR token; the path form is the ONLY
    // floor that reaches it. This is the class the colon-only floor could not see
    // (the SessionBootstrap / session-projector cites the advisor surfaced).
    const { root, cleanup } = setupRepo({
      "docs/domain/session-model.md": FIVE_LINE_DOC,
      "packages/runtime-daemon/src/types.ts": "// states per `docs/domain/session-model.md:2`.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/types.ts")]),
      );
      expect(violations).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("FLAGS a `docs/...md:LL` cite whose line is out of range", () => {
    const { root, cleanup } = setupRepo({
      "docs/domain/session-model.md": FIVE_LINE_DOC,
      "packages/runtime-daemon/src/types.ts": "// `docs/domain/session-model.md:99` drifted.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/types.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("line-out-of-range");
      expect(violations[0].cite.rawTarget).toBe("docs/domain/session-model.md:99");
    } finally {
      cleanup();
    }
  });

  it("validates BOTH endpoints of a `docs/...md:LL-LL` range cite (the :61-77 shape)", () => {
    const { root, cleanup } = setupRepo({
      "docs/domain/session-model.md": FIVE_LINE_DOC,
      "packages/runtime-daemon/src/types.ts": "// `docs/domain/session-model.md:2-99` span.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/types.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("line-out-of-range");
      expect(violations[0].cite.targetLine).toBe(99);
    } finally {
      cleanup();
    }
  });

  it("FLAGS a cite to a `docs/` path that does not exist (rename / delete signal)", () => {
    const { root, cleanup } = setupRepo({
      "docs/domain/session-model.md": FIVE_LINE_DOC,
      "packages/runtime-daemon/src/types.ts": "// `docs/domain/renamed-away.md:1` is stale.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/types.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("missing-target-file");
    } finally {
      cleanup();
    }
  });
});

describe("label-cite — exclusions (must never flag; required-gate false-positive guard)", () => {
  function extractFrom(comment: string): ReturnType<typeof extractLabelCites> {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
      "docs/specs/006-event-taxonomy.md": FIVE_LINE_DOC,
      "docs/decisions/019-windows-v1-tier.md": FIVE_LINE_DOC,
      "packages/x/src/f.ts": comment,
    });
    try {
      return withRepoRoot(root, () => extractLabelCites(resolve(root, "packages/x/src/f.ts")));
    } finally {
      cleanup();
    }
  }

  it("does NOT match the line-word form (Spec-003 line 5) — that is audit-layer (CAT-07)", () => {
    expect(extractFrom("// Spec-003 line 5 describes the floor.\n")).toEqual([]);
  });

  it("does NOT match a parenthesized line phrase (Spec-003 §AC1 (line 5))", () => {
    expect(extractFrom("//   • Spec-003 §AC1 (line 5, an attach race):\n")).toEqual([]);
  });

  it("does NOT match a markdown-link where the token is link text", () => {
    expect(
      extractFrom(
        "// see [Spec-006 §Taxonomy](../../docs/specs/006-event-taxonomy.md) for shape\n",
      ),
    ).toEqual([]);
  });

  it("does NOT match a token immediately followed by a non-colon separator", () => {
    // `Spec-003 §Decision #8` and `ADR-019 §Goal` carry no colon-line.
    expect(extractFrom("// Spec-003 §Decision #8 and ADR-019 §Goal govern this.\n")).toEqual([]);
  });

  it("does NOT match a longer word ending in the token name (MySpec-003:5)", () => {
    expect(extractFrom("// MySpec-003:5 is not a governance cite.\n")).toEqual([]);
  });

  it("does NOT match a package-relative code-to-code ref (internal/branded.ts:25)", () => {
    // No `docs/` root — flooring it would resolve wrong from repo root and FP.
    // This is the exact false positive that dropped the blanket backtick-path
    // reuse; the docs-path matcher is rooted at `docs/` precisely to exclude it.
    expect(extractFrom("// the brand lives at `internal/branded.ts:25`, see there.\n")).toEqual([]);
  });

  it("does NOT match a `docs/` path nested under another segment (node_modules/.../docs)", () => {
    // The lookbehind pins `docs/` to a path-segment start, so a vendored
    // node_modules/pkg/docs/readme.md:3 is not mistaken for a governance cite.
    expect(extractFrom("// vendored at node_modules/pkg/docs/readme.md:3 — ignore.\n")).toEqual([]);
  });

  it("does NOT match identifier / RFC / backlog noise", () => {
    expect(
      extractFrom(
        "// I-003-1, BL-102, T2.3, RFC 3339 §5.6, v0.24.2, status 429, -32600 are all noise.\n",
      ),
    ).toEqual([]);
  });

  it("does NOT swallow a trailing space-separated integer into the cite", () => {
    // `Spec-003:5 7` must yield only :5 — `7` is unrelated prose, not a second
    // line. A required gate must not invent a cite from adjacent digits.
    const cites = extractFrom("// Spec-003:5 7 times the handshake retries.\n");
    expect(cites.map((c) => c.targetLine)).toEqual([5]);
  });
});

describe("label-cite — formatter", () => {
  it("renders the citing form and reason with a label-cite prefix", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
      "packages/x/src/f.ts": "// Spec-003:99 drifted past EOF.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/x/src/f.ts")]),
      );
      const out = formatLabelCiteViolations(violations);
      expect(out).toContain("label-cite:");
      expect(out).toContain("Spec-003:99");
      expect(out).toContain("line-out-of-range");
      expect(out).toContain("1 violation(s)");
    } finally {
      cleanup();
    }
  });

  it("returns empty string for no violations", () => {
    expect(formatLabelCiteViolations([])).toBe("");
  });
});
