import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import GithubSlugger, { slug as oracleSlug } from "github-slugger";
import { describe, it, expect } from "vitest";

import { slug, SluggerSession } from "../lib/slug.ts";

describe("slug — github-slugger algorithm fidelity", () => {
  // Each pair: heading text from this corpus → expected slug as it appears
  // in committed inbound cites. Sourced from primary-source grep over docs/
  // (specifically the post-archival headings in docs/archive/backlog-archive.md).
  const cases: Array<[string, string]> = [
    ["A Heading", "a-heading"],
    ["Many          spaces", "many----------spaces"],
    [
      "BL-108: Plan-024 Windows + macOS signing procurement evidence",
      "bl-108-plan-024-windows--macos-signing-procurement-evidence",
    ],
    // U+2192 regression (PR #199 round 12, 2026-07-09). GitHub-rendered ground
    // truth captured from the contents API (Accept: application/vnd.github.html)
    // at commit d749307: GitHub strips U+2192, so "3 → 2" slugs to "3--2". The
    // pre-restore snapshot regex was truncated at U+205E and kept the arrow,
    // silently diverging from GitHub for every codepoint above the truncation.
    [
      "Amendment 2026-07-08: V1.1 deferred features 3 → 2 (cross-node shared artifacts pulled into V1)",
      "amendment-2026-07-08-v11-deferred-features-3--2-cross-node-shared-artifacts-pulled-into-v1",
    ],
  ];

  for (const [text, expected] of cases) {
    it(`slugs "${text.slice(0, 40)}…" correctly`, () => {
      expect(slug(text)).toBe(expected);
    });
  }
});

describe("SluggerSession — duplicate-suffix dedup", () => {
  it("appends -1, -2 suffixes for duplicate base slugs", () => {
    const s = new SluggerSession();
    expect(s.next("Foo")).toBe("foo");
    expect(s.next("Foo")).toBe("foo-1");
    expect(s.next("Foo")).toBe("foo-2");
  });

  it("resets between files", () => {
    const s = new SluggerSession();
    s.next("Foo");
    s.reset();
    expect(s.next("Foo")).toBe("foo");
  });

  it("never emits an id already taken by an earlier heading (upstream collision walk)", () => {
    // "Foo", "Foo-1", "Foo": the third heading's first candidate (foo-1) is
    // already owned by the second heading, so GitHub walks on to foo-2. A
    // count-by-base-only dedup emits a duplicate foo-1 here and diverges from
    // every anchor GitHub renders after the collision.
    const s = new SluggerSession();
    expect(s.next("Foo")).toBe("foo");
    expect(s.next("Foo-1")).toBe("foo-1");
    expect(s.next("Foo")).toBe("foo-2");
  });
});

describe("slug — parity with the packaged github-slugger oracle", () => {
  // The runtime keeps a zero-dep snapshot of upstream's strip regex (header
  // rationale in ../lib/slug.ts); github-slugger is a devDependency used only
  // here, as the oracle that makes the snapshot pin ENFORCED: any drift —
  // truncation, partial paste, formatter mangling — fails this suite instead
  // of surfacing later as silent anchor divergence in rendered docs.

  const adversarialHeadings = [
    "3 → 2 and 2 ← 3 and A ⇒ B",
    "boundary ⁞ vertical dots and ⁠ word joiner",
    "math × ÷ ≤ ≥ ± ∞ symbols",
    "em—dash – en nbsp thin space",
    "“smart quotes” and ‘apostrophes’",
    "emoji \u{1F680} rocket \u{1F525} fire",
    "CJK 日本語の見出し and 中文标题",
    "한국어 제목",
    "Ελληνικά и Русский",
    "café résumé naïve",
    "combining é acute",
    "currency € £ ¥ ₿",
    "Async ⇒ Await — 100% faster \u{1F680}",
  ];

  it("matches the oracle on adversarial unicode", () => {
    for (const heading of adversarialHeadings) {
      expect(slug(heading), JSON.stringify(heading)).toBe(oracleSlug(heading));
    }
  });

  it("matches the oracle on every heading sequence in the committed corpus", () => {
    let totalHeadings = 0;
    for (const filePath of corpusMarkdownFiles()) {
      const headingTexts = extractHeadingTexts(readFileSync(filePath, "utf8"));
      totalHeadings += headingTexts.length;
      const session = new SluggerSession();
      const oracle = new GithubSlugger();
      for (const headingText of headingTexts) {
        expect(session.next(headingText), `${filePath} :: ${JSON.stringify(headingText)}`).toBe(
          oracle.slug(headingText),
        );
      }
    }
    // Fail closed: a broken harvest that finds (nearly) nothing must not read
    // as parity. The committed corpus carries well over this many headings.
    expect(totalHeadings).toBeGreaterThanOrEqual(300);
  });
});

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function corpusMarkdownFiles(): string[] {
  const rootMarkdown = ["README.md", "CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md"].map((name) =>
    join(repositoryRoot, name),
  );
  const docsMarkdown = readdirSync(join(repositoryRoot, "docs"), { recursive: true })
    .map(String)
    .filter((relativePath) => relativePath.endsWith(".md"))
    .map((relativePath) => join(repositoryRoot, "docs", relativePath));
  return [...rootMarkdown, ...docsMarkdown];
}

// Fence-aware ATX heading walk. This is now the only such walk on the slug
// path: ../lib/slug.ts carried a slug-emitting twin (`extractHeadingSlugs`)
// that no caller ever reached, removed 2026-07-27. This one yields heading
// TEXTS rather than slugs because the parity assertions above need the raw
// text to feed both sluggers. Walker fidelity only selects test inputs; it
// cannot mask a slug divergence.
function extractHeadingTexts(content: string): string[] {
  const headingTexts: string[] = [];
  let inFence = false;
  let fenceMarker = "";
  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trimStart();
    if (!inFence && (trimmed.startsWith("```") || trimmed.startsWith("~~~"))) {
      inFence = true;
      fenceMarker = trimmed.startsWith("```") ? "```" : "~~~";
      continue;
    }
    if (inFence) {
      if (trimmed.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(rawLine);
    if (!headingMatch) continue;
    headingTexts.push(headingMatch[2].trim());
  }
  return headingTexts;
}
