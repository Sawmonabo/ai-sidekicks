import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import {
  extractLabelCites,
  checkLabelCiteTargets,
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
