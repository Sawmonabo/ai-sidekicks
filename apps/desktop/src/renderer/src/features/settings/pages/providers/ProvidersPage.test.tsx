// The accounts page's rail entry.

import { describe, expect, it } from "vitest";

import { composeSettingsPages } from "../../settings-pages.js";

describe("the accounts page — its rail entry", () => {
  it("claims the accounts section with a search vocabulary", () => {
    const registry = composeSettingsPages();
    const descriptor = registry.descriptorFor("accounts");
    expect(descriptor?.label).toBe("Providers");
    expect(descriptor?.keywords).toContain("sign in");
  });
});
