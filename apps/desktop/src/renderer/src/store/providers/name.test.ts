// A provider's name comes from its section, and an id the list lacks is a defect, never a blank.

import { describe, expect, it } from "vitest";

import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";

import { providerNameOf } from "./name.js";
import { providerSectionsFixture } from "./sections.test-support.js";

describe("providerNameOf", () => {
  it("answers the section's name and throws for an id the list does not hold", () => {
    const sections = providerSectionsFixture();
    expect(providerNameOf(sections, "claude" as ProviderId)).toBe("Claude Code");
    expect(providerNameOf(sections, "codex" as ProviderId)).toBe("Codex");
    expect(() => providerNameOf(sections, "gemini" as ProviderId)).toThrow(/gemini/u);
  });
});
