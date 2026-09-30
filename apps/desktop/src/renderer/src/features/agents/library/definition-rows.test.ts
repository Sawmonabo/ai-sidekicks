// The registry projection keeps an allowlist of `null` (the driver's defaults) apart from an
// empty one (no tools), and sorts without reordering the caller's array.

import { describe, expect, it } from "vitest";

import { definition } from "./agent-library.test-support.js";
import { projectDefinitionRows } from "./definition-rows.js";

describe("the registry projection — what a row carries", () => {
  it("keeps the allowlist's three states three", () => {
    // `null` is the driver's defaults and `[]` is no tools at all. They read alike and mean
    // opposite things, so the stored shape keeps them apart.
    const readingFor = (allowlist: string[] | null): string | undefined =>
      projectDefinitionRows([definition({ toolAllowlist: allowlist })])[0]?.axes.find(
        (axis) => axis.key === "tools",
      )?.reading;
    expect(readingFor(null)).toBe("The driver's defaults");
    expect(readingFor([])).toBe("No tools");
    expect(readingFor(["read"])).toBe("1 tool");
    expect(readingFor(["read", "grep", "glob"])).toBe("3 tools");
  });
});
