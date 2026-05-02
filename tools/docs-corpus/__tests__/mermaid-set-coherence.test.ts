import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseFile, formatMermaidViolations } from "../lib/mermaid-set-coherence.ts";

function withFile(content: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(resolve(tmpdir(), "msc-"));
  const file = resolve(dir, "case.md");
  writeFileSync(file, content);
  try {
    fn(file);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

describe("mermaid-set-coherence", () => {
  // PR #27 round 2: NS-22 was added as a :::ready graph node but the prose
  // enumeration `(NS-01, NS-03, NS-04, NS-11, NS-12, NS-13a, NS-14)` did not
  // include it — yet was claimed to "share no code paths" with the rest.
  const PR27_PRE_FIX = `
# Page

\`\`\`mermaid
graph TB
  NS01[NS-01: foo]:::ready
  NS03[NS-03: bar]:::ready
  NS04[NS-04: baz]:::ready
  NS11[NS-11: qux]:::ready
  NS12[NS-12: quux]:::ready
  NS13a[NS-13a: corge]:::ready
  NS14[NS-14: grault]:::ready
  NS22[NS-22: garply]:::ready

  classDef ready fill:#9f9,stroke:#0a0,color:#000
\`\`\`

The ready set (NS-01, NS-03, NS-04, NS-11, NS-12, NS-13a, NS-14) shares no code paths.
`;

  // Fix variant A: NS-22 dropped from graph; prose unchanged.
  const PR27_POST_FIX_A = `
# Page

\`\`\`mermaid
graph TB
  NS01[NS-01: foo]:::ready
  NS03[NS-03: bar]:::ready

  classDef ready fill:#9f9,stroke:#0a0,color:#000
\`\`\`

The ready set (NS-01, NS-03) shares no code paths.
`;

  // Fix variant B: NS-22 reclassified :::blocked (the actual landed fix).
  const PR27_POST_FIX_B = `
# Page

\`\`\`mermaid
graph TB
  NS01[NS-01: foo]:::ready
  NS22[NS-22: garply]:::blocked

  classDef ready fill:#9f9,stroke:#0a0,color:#000
  classDef blocked fill:#fcc,stroke:#a00,color:#000
\`\`\`

The ready set (NS-01) shares no code paths.
`;

  it("REJECTS the pre-fix PR-#27 round 2 state (NS-22 in :::ready, missing from prose)", () => {
    withFile(PR27_PRE_FIX, (file) => {
      const violations = parseFile(file);
      expect(violations).toHaveLength(1);
      expect(violations[0].extra).toContain("NS22");
      expect(formatMermaidViolations(violations)).toMatch(/in graph but not prose: NS22/);
    });
  });

  it("ACCEPTS PR-#27 fix variant A (NS-22 dropped from graph + prose)", () => {
    withFile(PR27_POST_FIX_A, (file) => {
      expect(parseFile(file)).toEqual([]);
    });
  });

  it("ACCEPTS PR-#27 fix variant B (NS-22 reclassified :::blocked)", () => {
    withFile(PR27_POST_FIX_B, (file) => {
      expect(parseFile(file)).toEqual([]);
    });
  });

  it("does nothing on a doc with neither classDef nor enumeration", () => {
    withFile("# Just prose\n\nA paragraph.\n", (file) => {
      expect(parseFile(file)).toEqual([]);
    });
  });
});
