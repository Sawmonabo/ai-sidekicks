// The page registry: one page per id, answered in page-list order.

import { describe, expect, it } from "vitest";
import { SETTINGS_PAGE_IDS } from "#renderer/routing/settings-page-ids.js";
import { SettingsPageRegistry, type SettingsPageRegistration } from "./registry.js";
import type { SettingsPageContext } from "../types.js";
import type { ReactNode } from "react";

function pageFor(pageId: (typeof SETTINGS_PAGE_IDS)[number]): SettingsPageRegistration {
  return {
    pageId,
    keywords: [],
    note: "",
    render: () => null,
  };
}

describe("settings page registry — one page per id", () => {
  it("answers in page-list order rather than registration order", () => {
    // Page-list order is what a person reads; registration order would depend on which page's
    // module the bundler evaluated first.
    const registry = new SettingsPageRegistry();
    registry.register(pageFor("keyboard"));
    registry.register(pageFor("providers"));
    expect(registry.registeredPageIds()).toStrictEqual(["providers", "keyboard"]);
    expect(registry.entries().map((entry) => entry.pageId)).toStrictEqual([
      "providers",
      "keyboard",
    ]);
  });
});

describe("settings page registry — what is left to warm", () => {
  /** A registration whose body arrives as its own chunk, resolving to nothing. */
  function deferredPageFor(pageId: (typeof SETTINGS_PAGE_IDS)[number]): SettingsPageRegistration {
    return {
      pageId,
      keywords: [],
      note: "",
      body: () =>
        Promise.resolve<{ Body: (context: SettingsPageContext) => ReactNode }>({
          Body: () => null,
        }),
    };
  }

  it("names the pages still to load, in page-list order", () => {
    // Page-list order rather than registration order: what a walk warms first is observable, and
    // registration order would depend on which page module evaluated first.
    const registry = new SettingsPageRegistry();
    registry.register(deferredPageFor("keyboard"));
    registry.register(deferredPageFor("providers"));
    expect(registry.unloadedKeys()).toStrictEqual(["providers", "keyboard"]);
  });

  it("drops a page once its body has been asked for", async () => {
    const registry = new SettingsPageRegistry();
    registry.register(deferredPageFor("keyboard"));
    await registry.preload("keyboard");
    expect(registry.unloadedKeys()).toStrictEqual([]);
  });

  it("negative control: a component-form page has nothing to warm", () => {
    // Without this the cases above would pass over a registry that reported every registered
    // page as unloaded, and the walk would re-arm forever on a page that never resolves.
    const registry = new SettingsPageRegistry();
    registry.register(pageFor("keyboard"));
    expect(registry.registeredPageIds()).toStrictEqual(["keyboard"]);
    expect(registry.unloadedKeys()).toStrictEqual([]);
  });
});
