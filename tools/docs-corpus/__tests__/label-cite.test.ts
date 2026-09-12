import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import {
  extractLabelCites,
  checkMarkdownVolatileCites,
  checkSectionCites,
  verifySectionHeading,
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
      "docs/plans/001-session-core.md": FIVE_LINE_DOC,
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

  it("DENIES a blockquoted wrap-split pair (quote leaders stripped in the join)", () => {
    // `> governed by Spec-003` / `> line 4` — blockquoted PROSE is not
    // exempt; only fenced blocks are (Codex, PR #207 round 2).
    const violations = mdViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "docs/architecture/security-architecture.md":
          "> governed by Spec-003\n> line 4 which defers idle holders\n",
      },
      "docs/architecture/security-architecture.md",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("line-anchored-cite-in-docs");
  });

  it("DENIES angle-bracketed and titled link destinations with locators", () => {
    const violations = mdViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "docs/plans/003-runtime-node-attach.md":
          '# Plan-003\n\nSee [spec](<../specs/003-runtime-node-attach.md>):2 and [spec](../specs/003-runtime-node-attach.md "attach spec"):2.\n',
      },
      "docs/plans/003-runtime-node-attach.md",
    );
    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.reason === "line-anchored-cite-in-docs")).toBe(true);
  });

  it("stays quiet on a colon-space VALUE after a markdown link, and on non-docs link targets", () => {
    const violations = mdViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "tools/notes.md": "scratch",
        "docs/plans/003-runtime-node-attach.md":
          "# Plan-003\n\nCaps per [the spec](../specs/003-runtime-node-attach.md): 25 participants.\nSee [notes](../../tools/notes.md):5 for tooling details.\n",
      },
      "docs/plans/003-runtime-node-attach.md",
    );
    expect(violations).toEqual([]);
  });

  it("treats an info-string delimiter inside a fence as content, not a closer", () => {
    // ` ```ts ` shown INSIDE a ```text example is fence content: closing
    // fences carry only whitespace after the delimiter (Codex, PR #207
    // round 2). The cite inside stays exempt; prose after the real close
    // scans normally.
    const violations = mdViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "docs/architecture/security-architecture.md":
          "```text\n```ts\nSpec-003:2 still fenced\n```\nSpec-003 line 2 after the real close.\n",
      },
      "docs/architecture/security-architecture.md",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].cite.line).toBe(5);
  });

  it("DENIES a spaced/tight-colon cite across a >100-char §-bridge", () => {
    const longBridge =
      "Participant Keys (random per-participant DEK plus KEK-wrap back-fill owed superseding the credential-derived legacy";
    const violations = mdViolations(
      {
        "docs/specs/022-data-retention-and-gdpr.md": FIVE_LINE_DOC,
        "docs/plans/022-data-retention-and-gdpr.md": `# Plan-022\n\n- Spec coverage: Spec-022 §${longBridge} :2 wording)\n`,
      },
      "docs/plans/022-data-retention-and-gdpr.md",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("line-anchored-cite-in-docs");
  });

  it("FLOORS fragment-bearing frozen links instead of skipping them", () => {
    const outOfRange = mdViolations(
      {
        "docs/archive/backlog-archive.md": FIVE_LINE_DOC,
        "docs/plans/003-runtime-node-attach.md":
          "# Plan-003\n\nClosed via [history](../archive/backlog-archive.md#bl-100):999 back then.\n",
      },
      "docs/plans/003-runtime-node-attach.md",
    );
    expect(outOfRange).toHaveLength(1);
    expect(outOfRange[0].reason).toBe("line-out-of-range");
    const validPin = mdViolations(
      {
        "docs/archive/backlog-archive.md": FIVE_LINE_DOC,
        "docs/plans/003-runtime-node-attach.md":
          "# Plan-003\n\nClosed via [history](../archive/backlog-archive.md#bl-100):2 back then.\n",
      },
      "docs/plans/003-runtime-node-attach.md",
    );
    expect(validPin).toEqual([]);
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

describe("label-cite — round-3 spellings: paren titles, path fragments, structural floor discriminators", () => {
  function mdViolations(files: Record<string, string>, citer: string) {
    const { root, cleanup } = setupRepo(files);
    try {
      return withRepoRoot(root, () => checkMarkdownVolatileCites([resolve(root, citer)]));
    } finally {
      cleanup();
    }
  }

  it("DENIES a paren-titled link destination — the third CommonMark title delimiter", () => {
    const violations = mdViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "docs/plans/003-runtime-node-attach.md":
          "# Plan-003\n\nSee [the spec](../specs/003-runtime-node-attach.md (attach spec)):2 for admission.\n",
      },
      "docs/plans/003-runtime-node-attach.md",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("line-anchored-cite-in-docs");
  });

  it("FLOORS a paren-titled frozen link per endpoint (character sniffing would skip it)", () => {
    const violations = mdViolations(
      {
        "docs/archive/backlog-archive.md": FIVE_LINE_DOC,
        "docs/architecture/security-architecture.md":
          "Closed in [history](../archive/backlog-archive.md (BL log)):999 back then.\n",
      },
      "docs/architecture/security-architecture.md",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("line-out-of-range");
  });

  it("DENIES a fragment-bearing docs-path colon cite (`docs/x.md#a:NN`)", () => {
    const violations = mdViolations(
      {
        "docs/domain/session-model.md": FIVE_LINE_DOC,
        "docs/architecture/security-architecture.md":
          "Rows per docs/domain/session-model.md#participants:3 rot on amendment.\n",
      },
      "docs/architecture/security-architecture.md",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("line-anchored-cite-in-docs");
  });

  it("FLOORS fragment-bearing frozen docs-path pins, backticked included (codeRe cannot parse a fragment)", () => {
    const violations = mdViolations(
      {
        "docs/archive/backlog-archive.md": FIVE_LINE_DOC,
        "docs/architecture/security-architecture.md":
          "Closed per docs/archive/backlog-archive.md#bl-100:999 and `docs/archive/backlog-archive.md#bl-100:999` alike.\n",
      },
      "docs/architecture/security-architecture.md",
    );
    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.reason === "line-out-of-range")).toBe(true);
  });

  it("DENIES a fragment-bearing relative-path line-word cite", () => {
    const violations = mdViolations(
      {
        "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
        "docs/plans/003-runtime-node-attach.md":
          "# Plan-003\n\nAdmission per ../specs/003-runtime-node-attach.md#attach line 4 today.\n",
      },
      "docs/plans/003-runtime-node-attach.md",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("line-anchored-cite-in-docs");
  });
});

describe("label-cite — shared CommonMark fence tracker across heading collection and the floor lane", () => {
  it("an info-string delimiter line inside a fence neither closes it nor reopens it over real headings", () => {
    const doc = [
      "# Doc",
      "",
      "```text",
      "```ts",
      "## Fenced Example Heading",
      "```",
      "",
      "## Real Heading",
      "",
    ].join("\n");
    expect(verifySectionHeading(doc, "Real Heading")).toBe(true);
    expect(verifySectionHeading(doc, "Fenced Example Heading")).toBe(false);
  });

  // A blockquote-nested fence exempts the content INSIDE the quote and
  // nothing below it. The unquoted line is spec example 237's exact shape:
  // laziness continues paragraph text only, so an unquoted line leaves the
  // blockquote and the fence closes with it, making the heading real in every
  // renderer. This assertion previously read `false` — written before the
  // tracker modeled containers, when a quoted fence was recorded at top level
  // and swallowed everything after it (PR #273 round 1).
  it("a blockquote-nested fence exempts quoted content, and the unquoted line that leaves the quote is a real heading", () => {
    const doc = [
      "# Doc",
      "",
      "> ```text",
      "> ## Quoted Example",
      "> ```",
      "",
      "## Real Heading",
      "",
    ].join("\n");
    expect(verifySectionHeading(doc, "Real Heading")).toBe(true);
    expect(verifySectionHeading(doc, "Quoted Example")).toBe(false);

    const leavesTheQuote = [
      "# Doc",
      "",
      "> ```text",
      "## Heading Below The Quote",
      "> ```",
      "",
    ].join("\n");
    expect(verifySectionHeading(leavesTheQuote, "Heading Below The Quote")).toBe(true);
  });

  // The heading lane's own policy, independent of any fence: a quoted heading
  // is someone else's document being reproduced, not a section of THIS one, so
  // a `§Quoted Section` cite against it must not resolve. Collection tests the
  // RAW line for that reason, and this is the fixture that pins it — the
  // fenced cases above cannot, since the fence guard excludes them first.
  it("a blockquoted heading outside any fence is not a citable section", () => {
    const doc = ["# Doc", "", "> ## Quoted Section", "", "## Real Heading", ""].join("\n");
    expect(verifySectionHeading(doc, "Real Heading")).toBe(true);
    expect(verifySectionHeading(doc, "Quoted Section")).toBe(false);
  });

  // The heading lane reads RAW lines, so the tracker must too: handed a
  // pre-stripped line it sees depth 0 forever, an unterminated `> ``` `
  // example is recorded at top level, and every real heading below the quote
  // stops resolving — a valid `§Real Heading` cite reported as a violation.
  it("an unterminated blockquote-nested fence does not suppress the headings below the quote", () => {
    const doc = [
      "# Doc",
      "",
      "> ```text",
      "> an example fence the author never closed",
      "",
      "## Real Heading",
      "",
      "## Another Real Heading",
      "",
    ].join("\n");
    expect(verifySectionHeading(doc, "Real Heading")).toBe(true);
    expect(verifySectionHeading(doc, "Another Real Heading")).toBe(true);
    // Non-vacuity: the same unterminated fence at TOP level still suppresses
    // them, so the assertions above turn on the container, not on the tracker
    // having stopped tracking.
    const unquoted = doc.replace(/^> /gm, "");
    expect(verifySectionHeading(unquoted, "Real Heading")).toBe(false);
    expect(verifySectionHeading(unquoted, "Another Real Heading")).toBe(false);
  });

  it("floor lane: a fenced example with an interior info-string line stays exempt — and the same cite outside a fence still fails", () => {
    const fencedExample = [
      "# Security",
      "",
      "```text",
      "```ts",
      "Per `Spec-003 §No Such Heading` — illustrative only.",
      "```",
      "",
      "prose after the fence.",
      "",
    ].join("\n");
    const { root, cleanup } = setupRepo({
      "docs/specs/003-runtime-node-attach.md": FIVE_LINE_DOC,
      "docs/architecture/security-architecture.md": fencedExample,
      "docs/architecture/deployment-architecture.md":
        "Per `Spec-003 §No Such Heading` — a live cite, not an example.\n",
    });
    try {
      const fencedViolations = withRepoRoot(root, () =>
        checkSectionCites([resolve(root, "docs/architecture/security-architecture.md")]),
      );
      expect(fencedViolations).toHaveLength(0);
      const liveViolations = withRepoRoot(root, () =>
        checkSectionCites([resolve(root, "docs/architecture/deployment-architecture.md")]),
      );
      expect(liveViolations).toHaveLength(1);
      expect(liveViolations[0].reason).toBe("section-not-found");
    } finally {
      cleanup();
    }
  });
});
