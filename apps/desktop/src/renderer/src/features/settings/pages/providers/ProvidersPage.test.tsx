// The accounts page's rail entry.

import { describe, expect, it } from "vitest";

import { registerProviderAccountsPage } from "@renderer/console/settings/pages/provider-accounts/ProviderAccountsPage.js";
import { SettingsPageRegistry } from "../../settings-pages.js";

describe("the accounts page — its rail entry", () => {
  it("claims the accounts section with a search vocabulary", () => {
    const registry = new SettingsPageRegistry();
    registerProviderAccountsPage(registry);
    const descriptor = registry.descriptorFor("accounts");
    expect(descriptor?.label).toBe("Provider accounts");
    expect(descriptor?.keywords).toContain("sign in");
  });
});
