// The app's matcher, run through the module the package builds, which the tier's setup hands it as
// the markdown worker's connection does in the app: an initialism finds the candidate whose words
// it starts over one holding its letters mid-word, and a ranking keeps equal scores in their input
// order under every query, so rows never trade places as a person types.

import { describe, expect, it } from "vitest";

import { appFuzzyMatcher } from "./fuzzy-matcher.js";

describe("the app's fuzzy matcher", () => {
  it("ranks `Copy SHA` above `class` for `cs`, at the units the query matched", () => {
    expect(appFuzzyMatcher.rank(["class", "Copy SHA"], "cs")).toStrictEqual([
      { index: 1, match: { score: 99, matchedIndices: [0, 5] } },
      { index: 0, match: { score: 97.5, matchedIndices: [0, 3] } },
    ]);
    expect(appFuzzyMatcher.score("Copy SHA", "cs")).toStrictEqual({
      score: 99,
      matchedIndices: [0, 5],
    });
  });

  it("keeps equal scores in their input order across two queries", () => {
    // Each pair spells the same letters in the same places, so each query scores them alike.
    const candidates = ["Stop run", "Open file", "Stop rug", "Open fill", "Undo"];
    for (const [query, expected] of [
      ["sr", ["Stop run", "Stop rug"]],
      ["of", ["Open file", "Open fill"]],
    ] as const) {
      const ranked = appFuzzyMatcher.rank(candidates, query);
      expect(ranked[0]?.match.score).toBe(ranked[1]?.match.score);
      expect(ranked.map(({ index }) => candidates[index])).toStrictEqual(expected);
    }
  });
});
