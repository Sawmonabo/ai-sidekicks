// The registry projection keeps an allowlist of `null` (the provider's default set) apart from
// an empty one (no tools).

import { describe, expect, it } from "vitest";

import { definition } from "./agent-library.test-support.js";
import { projectDefinitionRows } from "./definition-rows.js";

describe("the registry projection — what a row carries", () => {
  it("keeps the allowlist's three states three", () => {
    // `null` is the provider's default set and `[]` is no tools at all. They read alike and mean
    // opposite things, so the stored shape keeps them apart.
    const readingFor = (allowlist: string[] | null): string | undefined =>
      projectDefinitionRows([definition({ toolAllowlist: allowlist })])[0]?.axes.find(
        (axis) => axis.key === "tools",
      )?.reading;
    expect(readingFor(null)).toBe("The provider's default set");
    expect(readingFor([])).toBe("No tools");
    expect(readingFor(["read"])).toBe("1 tool");
    expect(readingFor(["read", "grep", "glob"])).toBe("3 tools");
  });
});
