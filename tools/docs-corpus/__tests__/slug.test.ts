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
});
