// What the repos feature registers in the inline card registry it is handed. The cases drive
// the registry: a descriptor built but never registered renders like one never built.

import { describe, expect, it } from "vitest";

import {
  InlineCardRegistry,
  inlineCardRegistry,
} from "@renderer/registries/inline-cards/inline-card-registry.js";
import { registerReposInlineCards } from "./inline-cards.js";

describe("repos — the inline cards", () => {
  it("writes the card registry it is given and never the process-wide one", () => {
    const cards = new InlineCardRegistry();
    registerReposInlineCards(cards);
    expect(cards.registeredCardKinds()).toStrictEqual(["diff"]);
    expect(inlineCardRegistry.registeredCardKinds()).toStrictEqual([]);
  });

  it("survives being registered twice, as a hot reload does it", () => {
    // Owner-scoped: the same owner re-claiming replaces; a changed owner string would raise.
    const cards = new InlineCardRegistry();
    expect(() => {
      registerReposInlineCards(cards);
      registerReposInlineCards(cards);
    }).not.toThrow();
  });

  it("keeps two compositions apart", () => {
    // Registering into one composition must be invisible to another, so an auxiliary window
    // can compose a subset without the main window seeing it.
    const first = new InlineCardRegistry();
    const second = new InlineCardRegistry();
    registerReposInlineCards(first);
    expect(first.registeredCardKinds()).toHaveLength(1);
    expect(second.registeredCardKinds()).toStrictEqual([]);
  });
});
