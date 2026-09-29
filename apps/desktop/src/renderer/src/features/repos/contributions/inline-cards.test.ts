// What the repos feature fills on the inline-card board it is handed.
//
// The cases drive the REGISTRY rather than the component: a descriptor that was built and
// never registered renders identically to one that was never built, and it is the
// registration that the seat boards depend on.

import { describe, expect, it } from "vitest";

import { InlineCardRegistry, inlineCardRegistry } from "@renderer/console/seats/index.js";
import { registerReposInlineCards } from "./inline-cards.js";

describe("repos — the inline cards", () => {
  it("writes the card board it is given and never the process-wide one", () => {
    const cards = new InlineCardRegistry();
    registerReposInlineCards(cards);
    expect(cards.registeredCardKinds()).toStrictEqual(["diff"]);
    expect(inlineCardRegistry.registeredCardKinds()).toStrictEqual([]);
  });

  it("survives being registered twice, as a hot reload does it", () => {
    // Owner-scoped: the same owner re-claiming replaces. A feature that changed its
    // owner string between registrations would raise here, which is correct — the
    // owner is what the policy is about.
    const cards = new InlineCardRegistry();
    expect(() => {
      registerReposInlineCards(cards);
      registerReposInlineCards(cards);
    }).not.toThrow();
  });

  it("keeps two compositions apart", () => {
    // The property the singleton could never have. Registering into one composition
    // must be invisible to another, which is what lets an auxiliary window compose a
    // subset without the main window seeing it.
    const first = new InlineCardRegistry();
    const second = new InlineCardRegistry();
    registerReposInlineCards(first);
    expect(first.registeredCardKinds()).toHaveLength(1);
    expect(second.registeredCardKinds()).toStrictEqual([]);
  });
});
