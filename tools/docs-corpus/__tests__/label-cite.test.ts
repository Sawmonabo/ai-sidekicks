import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import {
  extractLabelCites,
  checkLabelCiteTargets,
  checkMarkdownVolatileCites,
  checkSectionCites,
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
  it("DENIES a raw colon cite even at a non-empty in-range line (post-sweep ratchet)", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
      "packages/runtime-daemon/src/node.ts": "// see Spec-003:2 for the attach handshake.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/node.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("raw-line-cite-into-governance-doc");
      expect(violations[0].cite.rawTarget).toBe("Spec-003:2");
    } finally {
      cleanup();
    }
  });

  it("DENIES a raw colon cite whose target line is out of range (deny, not floor)", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
      "packages/runtime-daemon/src/node.ts": "// see Spec-003:99 for the attach handshake.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/node.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("raw-line-cite-into-governance-doc");
      expect(violations[0].cite.rawTarget).toBe("Spec-003:99");
    } finally {
      cleanup();
    }
  });

  it("DENIES a raw colon cite whose target line is whitespace-only", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
      "packages/runtime-daemon/src/node.ts": "// see Spec-003:6 for the attach handshake.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/node.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("raw-line-cite-into-governance-doc");
    } finally {
      cleanup();
    }
  });

  it("DENIES a raw cite to a governance doc that does not exist (deny fires before read)", () => {
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
      expect(violations[0].reason).toBe("raw-line-cite-into-governance-doc");
      expect(violations[0].cite.rawTarget).toBe("Spec-028:1");
    } finally {
      cleanup();
    }
  });

  it("DENIES a range cite exactly ONCE (extraction expands endpoints; the deny dedupes)", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/006-event-taxonomy.md": FIVE_LINE_DOC,
      "packages/contracts/src/event.ts": "// Spec-006:2-99 spans the taxonomy block.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/contracts/src/event.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("raw-line-cite-into-governance-doc");
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
  it("DENIES a raw `docs/...md:LL` cite even at a non-empty in-range line (ratchet)", () => {
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
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("raw-line-cite-into-governance-doc");
    } finally {
      cleanup();
    }
  });

  it("DENIES a raw `docs/...md:LL` cite whose line is out of range", () => {
    const { root, cleanup } = setupRepo({
      "docs/domain/session-model.md": FIVE_LINE_DOC,
      "packages/runtime-daemon/src/types.ts": "// `docs/domain/session-model.md:99` drifted.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/types.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("raw-line-cite-into-governance-doc");
      expect(violations[0].cite.rawTarget).toBe("docs/domain/session-model.md:99");
    } finally {
      cleanup();
    }
  });

  it("DENIES a `docs/...md:LL-LL` range cite exactly ONCE (dedupe)", () => {
    const { root, cleanup } = setupRepo({
      "docs/domain/session-model.md": FIVE_LINE_DOC,
      "packages/runtime-daemon/src/types.ts": "// `docs/domain/session-model.md:2-99` span.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/types.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("raw-line-cite-into-governance-doc");
    } finally {
      cleanup();
    }
  });

  it("DENIES a raw cite to a `docs/` path that does not exist (deny fires before read)", () => {
    const { root, cleanup } = setupRepo({
      "docs/domain/session-model.md": FIVE_LINE_DOC,
      "packages/runtime-daemon/src/types.ts": "// `docs/domain/renamed-away.md:1` is stale.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/types.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("raw-line-cite-into-governance-doc");
    } finally {
      cleanup();
    }
  });

  it("DENIES a multi-segment `docs/architecture/contracts/...md:LL` cite (any-depth)", () => {
    // The two-segment `architecture/contracts` path is repo-root-resolvable and
    // MUST be floored. An out-of-range hit is load-bearing: it proves the regex
    // MATCHED the deep path (an unmatched cite yields 0 violations, which is
    // indistinguishable from a pass), routing it through checkCite like the
    // single-segment form. Regression guard for the single-subtree-only regex.
    const { root, cleanup } = setupRepo({
      "docs/architecture/contracts/error-contracts.md": FIVE_LINE_DOC,
      "packages/contracts/src/x.ts":
        "// code per `docs/architecture/contracts/error-contracts.md:99`.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/contracts/src/x.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("raw-line-cite-into-governance-doc");
      expect(violations[0].cite.rawTarget).toBe(
        "docs/architecture/contracts/error-contracts.md:99",
      );
    } finally {
      cleanup();
    }
  });

  it("DENIES a multi-segment `docs/...md:LL` cite even at a valid in-range line", () => {
    const { root, cleanup } = setupRepo({
      "docs/architecture/contracts/error-contracts.md": FIVE_LINE_DOC,
      "packages/contracts/src/x.ts":
        "// pinned to `docs/architecture/contracts/error-contracts.md:3`.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/contracts/src/x.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("raw-line-cite-into-governance-doc");
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

  it("line-word form (Spec-003 line 5) IS extracted in code citers — pass-5 deny (was audit-layer pre-ratchet)", () => {
    const cites = extractFrom("// Spec-003 line 5 describes the floor.\n");
    expect(cites).toHaveLength(1);
    expect(cites[0].lineWordDeny).toBe(true);
  });

  it("parenthesized line phrase (Spec-003 §AC1 (line 5)) IS extracted in code citers — pass-5 deny", () => {
    const cites = extractFrom("//   • Spec-003 §AC1 (line 5, an attach race):\n");
    expect(cites).toHaveLength(1);
    expect(cites[0].lineWordDeny).toBe(true);
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

  it("does NOT match an in-package `docs/` dir (src/docs/y.md:5) — only repo-root docs/", () => {
    // Same lookbehind: a `docs/` dir inside a package is preceded by `/`, so it
    // is not the repo-root governance corpus. The any-depth widening floors
    // repo-root `docs/a/b/x.md` but must still reject this package-local path.
    expect(extractFrom("// generated note at src/docs/guide.md:5 — package-local.\n")).toEqual([]);
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
      expect(out).toContain("raw-line-cite-into-governance-doc");
      expect(out).toContain("§Heading");
      expect(out).toContain("1 violation(s)");
    } finally {
      cleanup();
    }
  });

  it("returns empty string for no violations", () => {
    expect(formatLabelCiteViolations([])).toBe("");
  });
});

describe("section-anchor cites", () => {
  it("passes `Spec-NNN §Heading` when the heading exists", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": "# Spec\n\n## Wire Format\n\nbody\n",
      "packages/runtime-daemon/src/node.ts":
        "// Per `Spec-003 §Wire Format` the frame is LSP-style.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/node.ts")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("fails with section-not-found when the heading is absent", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": "# Spec\n\n## Something Else\n\nbody\n",
      "packages/runtime-daemon/src/node.ts":
        "// Per `Spec-003 §Wire Format` the frame is LSP-style.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/node.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("section-not-found");
    } finally {
      cleanup();
    }
  });

  it("section-not-found detail suggests the doc's nearest headings (self-heal)", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": "# Spec\n\n## Wire Format v2\n\nbody\n",
      "packages/runtime-daemon/src/node.ts":
        "// Per `Spec-003 §Wire Format` the frame is LSP-style.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/node.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].detail).toContain("Wire Format v2");
    } finally {
      cleanup();
    }
  });

  it("normalizes case + punctuation exactly like preflight (— vs -)", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/016-budget.md": "# Spec\n\n## Budget–Ledger Rules\n\nbody\n",
      "packages/runtime-daemon/src/budget.ts":
        "// Per `Spec-016 §Budget-Ledger Rules` spend is capped.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/budget.ts")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("does not match an unbackticked § form (zero-FP contract)", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": "# Spec\n\n## Wire Format\n\nbody\n",
      "packages/runtime-daemon/src/node.ts":
        "// Per Spec-003 §Wire Format the frame is LSP-style.\n",
    });
    try {
      const sectionCites = withRepoRoot(root, () =>
        extractLabelCites(resolve(root, "packages/runtime-daemon/src/node.ts")),
      ).filter((c) => c.rawTarget.includes("§"));
      expect(sectionCites).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("resolves the doc via the NNN glob and reports missing-target-file for a dead token", () => {
    const { root, cleanup } = setupRepo({
      "packages/runtime-daemon/src/node.ts": "// Per `Spec-999 §Anything` this never resolves.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/node.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("missing-target-file");
    } finally {
      cleanup();
    }
  });
});

describe("checkSectionCites — section-anchor verification for markdown citers", () => {
  it("passes a doc-to-doc `Spec-NNN §Heading` cite whose heading exists", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": "# Spec\n\n## Wire Format\n\nbody\n",
      "docs/plans/001-x.md": "# Plan\n\nPer `Spec-003 §Wire Format` the frame is LSP-style.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkSectionCites([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("flags section-not-found for a doc-to-doc cite with a dead heading", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": "# Spec\n\n## Something Else\n\nbody\n",
      "docs/plans/001-x.md": "# Plan\n\nPer `Spec-003 §Wire Format` the frame is LSP-style.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkSectionCites([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("section-not-found");
    } finally {
      cleanup();
    }
  });

  it("ignores raw label-form cites (md label floors stay cite-target-existence's beat)", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": "line one\n",
      "docs/plans/001-x.md":
        "# Plan\n\nPer Spec-003:999 (raw form — out of range, NOT this check's scope).\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkSectionCites([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("section-anchor cites — fenced headings excluded", () => {
  it("does not accept a heading that only exists inside a code fence", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md":
        "# Spec\n\n## Other Section\n\n```markdown\n## Wire Format\n```\n\nbody\n",
      "packages/runtime-daemon/src/node.ts":
        "// Per `Spec-003 §Wire Format` the frame is LSP-style.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/node.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("section-not-found");
      // The self-heal suggestions list real headings only — never fence content.
      expect(violations[0].detail).toContain("Other Section");
      expect(violations[0].detail).not.toContain("Wire Format |");
    } finally {
      cleanup();
    }
  });
});

describe("section-anchor cites — fenced citer content excluded (md only)", () => {
  it("does not extract a §-cite from a fenced example block in a markdown citer", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": "# Spec\n\n## Wire Format\n\nbody\n",
      "docs/plans/009-y.md":
        "# Plan\n\n```markdown\nPer `Spec-003 §Old Heading` — illustrative only.\n```\n\nprose\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkSectionCites([resolve(root, "docs/plans/009-y.md")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("path-section anchor cites (`docs/….md §Heading` — label-LESS governance docs)", () => {
  it("passes a backticked path-form §-cite whose heading exists in the target doc", () => {
    const { root, cleanup } = setupRepo({
      "docs/domain/session-model.md": "# Session Model\n\n## State Model\n\nbody\n",
      "packages/runtime-daemon/src/types.ts":
        "// State names track `docs/domain/session-model.md §State Model`.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/types.ts")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("flags section-not-found when the path-form heading was renamed away", () => {
    const { root, cleanup } = setupRepo({
      "docs/domain/session-model.md": "# Session Model\n\n## Lifecycle Model\n\nbody\n",
      "packages/runtime-daemon/src/types.ts":
        "// State names track `docs/domain/session-model.md §State Model`.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/types.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("section-not-found");
      expect(violations[0].detail).toContain("Lifecycle Model");
    } finally {
      cleanup();
    }
  });

  it("flags missing-target-file when the path-form doc does not exist", () => {
    const { root, cleanup } = setupRepo({
      "packages/runtime-daemon/src/types.ts":
        "// State names track `docs/domain/renamed-away.md §State Model`.\n",
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

  it("verifies path-form §-cites in MARKDOWN citers too (checkSectionCites)", () => {
    const { root, cleanup } = setupRepo({
      "docs/domain/session-model.md": "# Session Model\n\n## State Model\n\nbody\n",
      "docs/plans/001-x.md":
        "# Plan\n\nPer `docs/domain/session-model.md §State Model` states are enumerated.\n",
    });
    try {
      const clean = withRepoRoot(root, () =>
        checkSectionCites([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(clean).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("flags a dead path-form heading in a MARKDOWN citer (checkSectionCites)", () => {
    const { root, cleanup } = setupRepo({
      "docs/domain/session-model.md": "# Session Model\n\n## Lifecycle Model\n\nbody\n",
      "docs/plans/001-x.md":
        "# Plan\n\nPer `docs/domain/session-model.md §State Model` states are enumerated.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkSectionCites([resolve(root, "docs/plans/001-x.md")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("section-not-found");
    } finally {
      cleanup();
    }
  });

  it("does not match an unbackticked path-form § mention (zero-FP contract)", () => {
    const { root, cleanup } = setupRepo({
      "docs/domain/session-model.md": "# Session Model\n\n## State Model\n\nbody\n",
      "packages/runtime-daemon/src/types.ts":
        "// Refs: docs/domain/session-model.md §Totally Renamed Heading\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/runtime-daemon/src/types.ts")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("matches a heading whose doc spelling carries inline code ticks (normalize strips them)", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/005-provider.md": "# Spec\n\n### `idempotency_class`\n\nbody\n",
      "packages/contracts/src/provider.ts":
        "// Defaults per `Spec-005 §idempotency_class` when undeclared.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/contracts/src/provider.ts")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("line-word + bare-basename deny in code citers (CAT-07 ratchet)", () => {
  it("DENIES a docs-rooted §-heading cite with a trailing line anchor in a code file", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/021-x.md": FIVE_LINE_DOC,
      "packages/p/src/a.ts":
        "// See docs/plans/021-x.md §Tier 1 Partial PR Sequence > Phase 1 line 259.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/p/src/a.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("line-anchored-cite-in-code");
    } finally {
      cleanup();
    }
  });

  it("DENIES a label line-word cite in a code file", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/021-x.md": FIVE_LINE_DOC,
      "packages/p/src/a.ts": "// per Spec-021 line 2 the bind address is loopback.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/p/src/a.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("line-anchored-cite-in-code");
      expect(violations[0].detail).toContain("§Heading");
    } finally {
      cleanup();
    }
  });

  it("DENIES the lines-list, parenthesized, and §-section+line variants", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/022-y.md": FIVE_LINE_DOC,
      "docs/decisions/014-z.md": FIVE_LINE_DOC,
      "docs/specs/027-w.md": FIVE_LINE_DOC,
      "packages/p/src/b.ts": [
        "// Plan-022 lines 2, 3-4 cover retention.",
        "// ADR-014 (line 2) picked tRPC.",
        "// Spec-027 §Bind-Address line 3 pins the default.",
        "",
      ].join("\n"),
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/p/src/b.ts")]),
      );
      expect(violations).toHaveLength(3);
      expect(violations.every((v) => v.reason === "line-anchored-cite-in-code")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("DENIES bare-basename colon and line-word forms", () => {
    const { root, cleanup } = setupRepo({
      "packages/p/src/c.ts": [
        "// api-payload-contracts.md:120 documents the envelope.",
        "// session-model.md line 61 defines membership.",
        "",
      ].join("\n"),
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/p/src/c.ts")]),
      );
      expect(violations).toHaveLength(2);
      expect(violations.every((v) => v.reason === "line-anchored-cite-in-code")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("DENIES a docs-rooted line-word cite (colon form is pass 2's; line-word slips it)", () => {
    const { root, cleanup } = setupRepo({
      "docs/domain/session-model.md": FIVE_LINE_DOC,
      "packages/p/src/d.ts": "// docs/domain/session-model.md line 3 defines membership.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/p/src/d.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("line-anchored-cite-in-code");
    } finally {
      cleanup();
    }
  });

  it("does NOT fire in markdown citers (docs corpus keeps its own conventions)", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/021-x.md": FIVE_LINE_DOC,
      "docs/architecture/note.md": "Per Spec-021 line 2 the bind address is loopback.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "docs/architecture/note.md")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("does NOT fire on durable §-forms, prose without a line anchor, or 'outlines'", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/021-x.md": "# X\n\n## Bind Address\n\nbody\n",
      "packages/p/src/e.ts": [
        "// `Spec-021 §Bind Address` is the durable form.",
        "// Plan-022 Phase 4 ships the stubs.",
        "// Spec-021 outlines 3 tiers.",
        "",
      ].join("\n"),
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/p/src/e.ts")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("keeps frozen-tree line-word cites legal (parity with the colon-form carve-out)", () => {
    const { root, cleanup } = setupRepo({
      "docs/reference/excerpt.md": FIVE_LINE_DOC,
      "packages/p/src/f.ts": "// docs/reference/excerpt.md line 2 quotes upstream.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/p/src/f.ts")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("FLOORS a frozen-tree line-word cite: a deleted target still fails loudly", () => {
    // Legal ≠ unchecked (parity with the colon-form frozen carve-out): the
    // line-word spelling into docs/reference/ is exempt from the deny, but a
    // missing file or out-of-range pin must surface, not vanish from every
    // check (Codex, PR #195 — pass 6 previously dropped the match entirely).
    const { root, cleanup } = setupRepo({
      "packages/p/src/f.ts": "// docs/reference/gone.md line 3 quotes upstream.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/p/src/f.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("missing-target-file");
    } finally {
      cleanup();
    }
  });

  it("DENIES a line locator appended after a backticked durable label cite", () => {
    // The durable spelling does not launder a pin: `` `Spec-021 §Bind
    // Address` line 2 `` re-enters the CAT-07 class through the closing
    // backtick unless the deny looks past it (Codex, PR #195).
    const { root, cleanup } = setupRepo({
      "docs/specs/021-x.md": "# X\n\n## Bind Address\n\nbody\n",
      "packages/p/src/g.ts": "// `Spec-021 §Bind Address` line 2 pins the default.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/p/src/g.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("line-anchored-cite-in-code");
    } finally {
      cleanup();
    }
  });

  it("DENIES a line-word tail after a backticked docs-path cite", () => {
    const { root, cleanup } = setupRepo({
      "docs/domain/session-model.md": "# M\n\n## State Model\n\nbody\n",
      "packages/p/src/h.ts":
        "// `docs/domain/session-model.md §State Model` lines 61-77 moved here.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/p/src/h.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("line-anchored-cite-in-code");
    } finally {
      cleanup();
    }
  });

  it("DENIES the adjectival hyphen spelling (Spec-003 line-48 payload)", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
      "packages/p/src/i.ts": "// Spec-003 line-48 payload components are standing facts.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/p/src/i.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("line-anchored-cite-in-code");
    } finally {
      cleanup();
    }
  });

  it("remediation for a durable-path-tail deny says drop-the-locator, not §Heading nesting", () => {
    const { root, cleanup } = setupRepo({
      "docs/domain/session-model.md": "# M\n\n## State Model\n\nbody\n",
      "packages/p/src/j.ts":
        "// `docs/domain/session-model.md §State Model` lines 61-77 moved here.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/p/src/j.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].detail).toContain("drop the appended line locator");
      expect(violations[0].detail).not.toContain("` §Heading`");
    } finally {
      cleanup();
    }
  });

  it("floors a frozen §-segment cite against the anchored line, not the §-segment number", () => {
    // `§RFC 9110 line 2`: the 9110 is heading text; the pin is line 2. A
    // first-digit parse would check line 9110 and false-fail a valid cite.
    const { root, cleanup } = setupRepo({
      "docs/reference/rfc.md": FIVE_LINE_DOC,
      "packages/p/src/k.ts": "// docs/reference/rfc.md §RFC 9110 line 2 quotes the norm.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/p/src/k.ts")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("floors EVERY endpoint of a frozen range/list anchor (stale 999 fails)", () => {
    const { root, cleanup } = setupRepo({
      "docs/reference/excerpt.md": FIVE_LINE_DOC,
      "packages/p/src/l.ts": "// docs/reference/excerpt.md lines 2, 999 quote upstream.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/p/src/l.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("line-out-of-range");
    } finally {
      cleanup();
    }
  });

  it("DENIES the comma-separated spelling (Spec-003, line 5)", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
      "packages/p/src/n.ts": "// Per Spec-003, line 5 the attach handshake is versioned.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/p/src/n.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("line-anchored-cite-in-code");
    } finally {
      cleanup();
    }
  });

  it("DENIES a line pin after a LONG § heading (bridge spans real heading lengths)", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/003-runtime-node-attach.md": FIVE_LINE_DOC,
      "packages/p/src/o.ts":
        "// Plan-003 §T5.3 — Mixed-version status indicator (below-floor read-only surfacing) line 600 moved.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/p/src/o.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("line-anchored-cite-in-code");
    } finally {
      cleanup();
    }
  });

  it("DENIES a pin on an unstarred block-comment interior line (cross-line /* state)", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
      "packages/p/src/q.ts": "/*\n  Spec-003 line 5 governs the handshake.\n*/\nconst x = 1;\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/p/src/q.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("line-anchored-cite-in-code");
    } finally {
      cleanup();
    }
  });

  it("does NOT treat // inside a quoted string as a comment opener", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
      "packages/p/src/r.ts": 'const fixture = "foo// Spec-003 line 5";\n',
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/p/src/r.ts")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("does NOT deny .md:NN inside non-comment code strings (fixture/diagnostic FP guard)", () => {
    const { root, cleanup } = setupRepo({
      "packages/p/src/m.ts":
        'const rendered = expectFormat("README.md:12");\nconst u = "https://x.test/session-model.md line 3";\n',
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/p/src/m.ts")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("deny-detail remediation names the form that exists for the target", () => {
  it("recommends `Spec-NNN §Heading` for a denied label-form raw cite", () => {
    const { root, cleanup } = setupRepo({
      "docs/specs/016-x.md": FIVE_LINE_DOC,
      "packages/x/src/f.ts": "// Spec-016:3 governs this.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/x/src/f.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].detail).toContain("`Spec-NNN §Heading`");
    } finally {
      cleanup();
    }
  });

  it("recommends the backticked `docs/….md §Heading` form for a denied docs-path raw cite (label-less target)", () => {
    const { root, cleanup } = setupRepo({
      "docs/domain/session-model.md": FIVE_LINE_DOC,
      "packages/x/src/f.ts": "// docs/domain/session-model.md:3 governs this.\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/x/src/f.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].detail).toContain("`docs/domain/session-model.md §Heading`");
      expect(violations[0].detail).not.toContain("`Spec-NNN §Heading`");
    } finally {
      cleanup();
    }
  });
});

describe("frozen trees exempt from the raw-cite deny (AGENTS.md: raw `:NNN` stays legal there)", () => {
  it("does not deny a code cite into docs/reference/", () => {
    const { root, cleanup } = setupRepo({
      "docs/reference/paseo/overview.md": FIVE_LINE_DOC,
      "packages/x/src/f.ts": "// upstream precedent: docs/reference/paseo/overview.md:3\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/x/src/f.ts")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("does not deny a code cite into docs/archive/", () => {
    const { root, cleanup } = setupRepo({
      "docs/archive/backlog-archive.md": FIVE_LINE_DOC,
      "packages/x/src/f.ts": "// closed as docs/archive/backlog-archive.md:2\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/x/src/f.ts")]),
      );
      expect(violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("still FLOORS a frozen cite: out-of-range line fails loudly (legality ≠ blind trust)", () => {
    const { root, cleanup } = setupRepo({
      "docs/reference/paseo/overview.md": FIVE_LINE_DOC,
      "packages/x/src/f.ts": "// upstream precedent: docs/reference/paseo/overview.md:999\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/x/src/f.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("line-out-of-range");
    } finally {
      cleanup();
    }
  });

  it("still FLOORS a frozen cite: missing target file fails loudly", () => {
    const { root, cleanup } = setupRepo({
      "packages/x/src/f.ts": "// upstream precedent: docs/reference/renamed-away.md:3\n",
    });
    try {
      const violations = withRepoRoot(root, () =>
        checkLabelCiteTargets([resolve(root, "packages/x/src/f.ts")]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe("missing-target-file");
    } finally {
      cleanup();
    }
  });
});

describe("label-cite — code-lane wrap-split pair scan (CAT-07 wrapped-cite gap)", () => {
  function codeViolations(files: Record<string, string>, citer: string) {
    const { root, cleanup } = setupRepo(files);
    try {
      return withRepoRoot(root, () => checkLabelCiteTargets([resolve(root, citer)]));
    } finally {
      cleanup();
    }
  }

  it("DENIES a label cite wrapped across two comment lines, reported at the first line", () => {
    const violations = codeViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "packages/x/src/f.ts":
          "const a = 1;\n// governed by Spec-003\n// line 4 of the admission flow\n",
      },
      "packages/x/src/f.ts",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("line-anchored-cite-in-code");
    expect(violations[0].cite.line).toBe(2);
    expect(violations[0].cite.rawTarget).toBe("Spec-003 line 4");
  });

  it("DENIES a wrapped §-hybrid (label + §Heading on one line, locator on the next)", () => {
    const violations = codeViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "packages/x/src/f.ts": "// per Spec-003 §Required\n// line 4 the daemon defers\n",
      },
      "packages/x/src/f.ts",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("line-anchored-cite-in-code");
  });

  it("DENIES a wrapped docs-path line-word cite", () => {
    const violations = codeViolations(
      {
        "docs/domain/session-model.md": FIVE_LINE_DOC,
        "packages/x/src/f.ts":
          "// mapping per docs/domain/session-model.md\n// line 3 (participant row)\n",
      },
      "packages/x/src/f.ts",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("line-anchored-cite-in-code");
    expect(violations[0].cite.line).toBe(1);
  });

  it("does NOT pair across an intervening non-comment line (adjacency reset)", () => {
    const violations = codeViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "packages/x/src/f.ts":
          "// governed by Spec-003\nconst a = 1;\n// line 4 is unrelated prose\n",
      },
      "packages/x/src/f.ts",
    );
    expect(violations).toEqual([]);
  });

  it("does NOT double-report a cite wholly inside one line through the pair scan", () => {
    const violations = codeViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "packages/x/src/f.ts":
          "// see Spec-003 line 4 for admission\n// unrelated follow-up comment\n",
      },
      "packages/x/src/f.ts",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].cite.line).toBe(1);
  });

  it("FLOORS a wrapped frozen-tree pin instead of denying (out-of-range fails loudly)", () => {
    const brokenPin = codeViolations(
      {
        "docs/archive/backlog-archive.md": FIVE_LINE_DOC,
        "packages/x/src/f.ts":
          "// closed via docs/archive/backlog-archive.md\n// line 99 (BL-100)\n",
      },
      "packages/x/src/f.ts",
    );
    expect(brokenPin).toHaveLength(1);
    expect(brokenPin[0].reason).toBe("line-out-of-range");
    const validPin = codeViolations(
      {
        "docs/archive/backlog-archive.md": FIVE_LINE_DOC,
        "packages/x/src/f.ts":
          "// closed via docs/archive/backlog-archive.md\n// line 2 (BL-100)\n",
      },
      "packages/x/src/f.ts",
    );
    expect(validPin).toEqual([]);
  });

  it("stays quiet on a durable §-anchor followed by digit-less 'line' prose", () => {
    const violations = codeViolations(
      {
        "docs/specs/003-runtime-node-attach.md": "# Spec-003\n\n## Attach\n\ntext\n",
        "packages/x/src/f.ts": "// per `Spec-003 §Attach`\n// the line count stays bounded\n",
      },
      "packages/x/src/f.ts",
    );
    expect(violations).toEqual([]);
  });

  it("does NOT pair a comment line with a trailing comment on a CODE line", () => {
    // `// See Spec-003` followed by `const limit = 5; // line 5 …` must not
    // join into a phantom wrapped cite — pairing requires both sides to be
    // comment-ONLY lines (Codex, PR #207).
    const violations = codeViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "packages/x/src/f.ts": "// See Spec-003\nconst limit = 5; // line 5 is the local limit\n",
      },
      "packages/x/src/f.ts",
    );
    expect(violations).toEqual([]);
  });

  it("DENIES single-line spaced- and paren-colon label spellings in comments", () => {
    const violations = codeViolations(
      {
        "docs/specs/022-data-retention-and-gdpr.md": FIVE_LINE_DOC,
        "packages/x/src/f.ts":
          "// sealed per Spec-022 :2 exactly\n// Spec coverage: Spec-022 §Daemon Master Key (:2-3, substrate)\n",
      },
      "packages/x/src/f.ts",
    );
    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.reason === "line-anchored-cite-in-code")).toBe(true);
  });
});

describe("label-cite — markdown volatile-cite deny (checkMarkdownVolatileCites)", () => {
  function mdViolations(files: Record<string, string>, citer: string) {
    const { root, cleanup } = setupRepo(files);
    try {
      return withRepoRoot(root, () => checkMarkdownVolatileCites([resolve(root, citer)]));
    } finally {
      cleanup();
    }
  }

  it("DENIES a raw label colon cite in md prose", () => {
    const violations = mdViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "docs/architecture/security-architecture.md": "Attach admission per Spec-003:2 today.\n",
      },
      "docs/architecture/security-architecture.md",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("line-anchored-cite-in-docs");
    expect(violations[0].cite.rawTarget).toBe("Spec-003:2");
  });

  it("DENIES a docs-path colon cite and a bare-basename colon cite", () => {
    const violations = mdViolations(
      {
        "docs/domain/session-model.md": FIVE_LINE_DOC,
        "docs/architecture/security-architecture.md":
          "Rows per docs/domain/session-model.md:3 and session-model.md:4 both rot.\n",
      },
      "docs/architecture/security-architecture.md",
    );
    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.reason === "line-anchored-cite-in-docs")).toBe(true);
  });

  it("DENIES a markdown-link colon cite (target resolved citer-relative)", () => {
    const violations = mdViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "docs/plans/003-runtime-node-attach.md":
          "# Plan-003\n\nSee [the spec](../specs/003-runtime-node-attach.md):2 for admission.\n",
      },
      "docs/plans/003-runtime-node-attach.md",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("line-anchored-cite-in-docs");
  });

  it("DENIES label line-word spellings, including the §-hybrid", () => {
    const violations = mdViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "docs/architecture/security-architecture.md":
          "Spec-003 line 2 governs admission.\nSpec-003 §Required Behavior line 4 defers idle holders.\n",
      },
      "docs/architecture/security-architecture.md",
    );
    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.reason === "line-anchored-cite-in-docs")).toBe(true);
  });

  it("DENIES a wrap-split label pair and reports the pair's first line", () => {
    const violations = mdViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "docs/architecture/security-architecture.md":
          "intro text\nadmission is governed by Spec-003\nline 4 which defers idle holders.\n",
      },
      "docs/architecture/security-architecture.md",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].cite.line).toBe(2);
  });

  it("does NOT pair across a blank line or a fence boundary", () => {
    const violations = mdViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "docs/architecture/security-architecture.md":
          "governed by Spec-003\n\nline 4 is unrelated prose\ngoverned by Spec-003\n```\nline 4 fenced example\n```\n",
      },
      "docs/architecture/security-architecture.md",
    );
    expect(violations).toEqual([]);
  });

  it("exempts a line carrying the cite-shape-example waiver marker", () => {
    const violations = mdViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "docs/operations/failure-mode-catalog.md":
          "Example drift: Spec-003:2 → :3 after an insertion. <!-- cite-shape-example -->\n",
      },
      "docs/operations/failure-mode-catalog.md",
    );
    expect(violations).toEqual([]);
  });

  it("exempts fenced blocks", () => {
    const violations = mdViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "docs/architecture/security-architecture.md": "```\nSpec-003:2 quoted example\n```\n",
      },
      "docs/architecture/security-architecture.md",
    );
    expect(violations).toEqual([]);
  });

  it("exempts plan grammar MARKER lines only — a marker-less plan table row is denied", () => {
    // Gate 4 (plan-execution preflight) keys on the BOLD markers, so exactly
    // those lines — including marker-bearing table rows — are its parse
    // boundary. A plan table row WITHOUT a marker (invariant / dependency /
    // decision-log tables) is ordinary prose to Gate 4 and stays denied
    // (Codex, PR #207 — the blanket `|`-row exemption let invariant-table
    // cites through).
    const planViolations = mdViolations(
      {
        "docs/specs/011-x.md": FIVE_LINE_DOC,
        "docs/plans/011-x.md":
          "# Plan-011\n\n- **Spec coverage:** Spec-011 line 2 (admission); line 3 (deferral)\n| T1 | **Verifies invariant:** Spec-011:4 |\n| I-011-1 | per Spec-011:4 |\n",
      },
      "docs/plans/011-x.md",
    );
    expect(planViolations).toHaveLength(1);
    expect(planViolations[0].cite.line).toBe(5);
    expect(planViolations[0].reason).toBe("line-anchored-cite-in-docs");
    const specViolations = mdViolations(
      {
        "docs/specs/011-x.md": FIVE_LINE_DOC,
        "docs/specs/012-y.md":
          "- **Spec coverage:** Spec-011 line 2 (admission)\n| row | Spec-011:4 |\n",
      },
      "docs/specs/012-y.md",
    );
    expect(specViolations).toHaveLength(2);
  });

  it("exempts the named citer trees (superpowers campaign logs, .claude harness docs)", () => {
    const superpowersViolations = mdViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "docs/superpowers/plans/2026-07-01-campaign.md":
          "Bundle B4 amends Spec-003:2 and Spec-003 line 4.\n",
      },
      "docs/superpowers/plans/2026-07-01-campaign.md",
    );
    expect(superpowersViolations).toEqual([]);
    const harnessViolations = mdViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        ".claude/skills/ripple-check/SKILL.md": "CAT-07 example: Spec-003:2 → :3 drift.\n",
      },
      ".claude/skills/ripple-check/SKILL.md",
    );
    expect(harnessViolations).toEqual([]);
  });

  it("FLOORS bare frozen-target pins (colon and line-word) instead of denying", () => {
    const brokenPins = mdViolations(
      {
        "docs/archive/backlog-archive.md": FIVE_LINE_DOC,
        "docs/architecture/security-architecture.md":
          "Closed via docs/archive/backlog-archive.md:99 and docs/archive/backlog-archive.md line 98.\n",
      },
      "docs/architecture/security-architecture.md",
    );
    expect(brokenPins).toHaveLength(2);
    expect(brokenPins.every((v) => v.reason === "line-out-of-range")).toBe(true);
    const validPins = mdViolations(
      {
        "docs/archive/backlog-archive.md": FIVE_LINE_DOC,
        "docs/architecture/security-architecture.md":
          "Closed via docs/archive/backlog-archive.md:2 and docs/archive/backlog-archive.md line 3.\n",
      },
      "docs/architecture/security-architecture.md",
    );
    expect(validPins).toEqual([]);
  });

  it("skips backticked and link-form frozen pins (extractCites already floors those)", () => {
    const violations = mdViolations(
      {
        "docs/archive/backlog-archive.md": FIVE_LINE_DOC,
        "docs/architecture/security-architecture.md":
          "Closed via `docs/archive/backlog-archive.md:99` and [the archive](../archive/backlog-archive.md):99.\n",
      },
      "docs/architecture/security-architecture.md",
    );
    expect(violations).toEqual([]);
  });

  it("stays quiet on durable §-anchor forms and bare non-docs slashed paths", () => {
    // A bare slashed non-docs path is a repo-root mention of a
    // non-governance file (the corpus cites by repo-root path) — it is NOT
    // resolved citer-relative into docs/ (that resolution is reserved for
    // explicitly relative `../` / `./` spellings).
    const violations = mdViolations(
      {
        "docs/specs/003-runtime-node-attach.md": "# Spec-003\n\n## Attach\n\ntext\n",
        "docs/architecture/security-architecture.md":
          "Per `Spec-003 §Attach` and `docs/specs/003-runtime-node-attach.md §Attach`; packages/x/readme.md line 5 is not corpus.\n",
      },
      "docs/architecture/security-architecture.md",
    );
    expect(violations).toEqual([]);
  });

  it("DENIES explicitly relative line-word spellings that resolve into docs/", () => {
    const violations = mdViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "docs/plans/003-runtime-node-attach.md":
          "# Plan-003\n\nAdmission per ../specs/003-runtime-node-attach.md line 2 as shipped.\n",
      },
      "docs/plans/003-runtime-node-attach.md",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("line-anchored-cite-in-docs");
  });

  it("resolves relative spellings OUT of docs/ to quiet, and relative frozen pins to the floor", () => {
    const outsideDocs = mdViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "tools/notes.md": "scratch",
        "docs/plans/003-runtime-node-attach.md":
          "# Plan-003\n\nSee ../../tools/notes.md line 9 for tooling notes.\n",
      },
      "docs/plans/003-runtime-node-attach.md",
    );
    expect(outsideDocs).toEqual([]);
    const frozenRelative = mdViolations(
      {
        "docs/archive/backlog-archive.md": FIVE_LINE_DOC,
        "docs/plans/003-runtime-node-attach.md":
          "# Plan-003\n\nClosed via ../archive/backlog-archive.md line 99 (BL-100).\n",
      },
      "docs/plans/003-runtime-node-attach.md",
    );
    expect(frozenRelative).toHaveLength(1);
    expect(frozenRelative[0].reason).toBe("line-out-of-range");
  });

  it("DENIES a line locator appended to a fragment link", () => {
    // `[…](../specs/022-x.md#pii-data-map):251-254` — the fragment does not
    // durable-ize the appended line locator (Codex, PR #207).
    const violations = mdViolations(
      {
        "docs/specs/022-data-retention-and-gdpr.md": FIVE_LINE_DOC,
        "docs/plans/022-data-retention-and-gdpr.md":
          "# Plan-022\n\nMirrors [Spec-022 §PII Data Map](../specs/022-data-retention-and-gdpr.md#pii-data-map):2-3, reconciled at swap.\n",
      },
      "docs/plans/022-data-retention-and-gdpr.md",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("line-anchored-cite-in-docs");
  });

  it("DENIES the spaced-, tight-, and paren-colon label spellings", () => {
    const violations = mdViolations(
      {
        "docs/specs/022-data-retention-and-gdpr.md": FIVE_LINE_DOC,
        "docs/architecture/security-architecture.md":
          "Sealed per Spec-022 :2 exactly.\nSealed per Spec-022 §Daemon Master Key :2 exactly.\nUnresolved per Spec-022 §Resolved Questions:3; only performance.\nSpec coverage: Spec-022 §Relay Negotiation (:2-3, substrate).\n",
      },
      "docs/architecture/security-architecture.md",
    );
    expect(violations).toHaveLength(4);
    expect(violations.every((v) => v.reason === "line-anchored-cite-in-docs")).toBe(true);
  });

  it("stays quiet on prose quoting a numeric VALUE after a §-anchor (colon-space)", () => {
    // `§Scheduler Limits: 25` quotes the section's VALUE — the flush-digits
    // requirement keeps value quotes out of the deny.
    const violations = mdViolations(
      {
        "docs/specs/016-multi-agent-channels-and-orchestration.md": FIVE_LINE_DOC,
        "docs/architecture/contracts/error-contracts.md":
          'Caps per Spec-016 §Scheduler Limits: 25 concurrent runs.\nPlan-001 §CP-001-1 names "second bounded timeout: 2 s" for shutdown.\n',
      },
      "docs/architecture/contracts/error-contracts.md",
    );
    expect(violations).toEqual([]);
  });

  it("exempts a fence nested inside a block quote, honoring delimiter type and length", () => {
    // `> ```text` opens a fence inside a quoted example (Codex, PR #207); a
    // `~~~` line cannot close it, and a longer opener needs an
    // equal-or-longer closer of the same character.
    const quotedFence = mdViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "docs/architecture/security-architecture.md":
          "> ```text\n> Spec-003:2 quoted example\n> ```\n",
      },
      "docs/architecture/security-architecture.md",
    );
    expect(quotedFence).toEqual([]);
    const mismatchedDelimiter = mdViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "docs/architecture/security-architecture.md":
          "````\n~~~\nSpec-003:2 still fenced (a tilde line cannot close a backtick fence)\n````\nSpec-003 line 2 after the real close.\n",
      },
      "docs/architecture/security-architecture.md",
    );
    expect(mismatchedDelimiter).toHaveLength(1);
    expect(mismatchedDelimiter[0].cite.line).toBe(5);
  });

  it("dedupes an identical cite repeated on one line", () => {
    const violations = mdViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "docs/architecture/security-architecture.md": "Spec-003:2 and again Spec-003:2 here.\n",
      },
      "docs/architecture/security-architecture.md",
    );
    expect(violations).toHaveLength(1);
  });
});
