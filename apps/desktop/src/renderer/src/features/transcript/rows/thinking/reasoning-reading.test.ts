// The reasoning model's tail: the newest lines, not the first ones.

import { describe, expect, it } from "vitest";

import { reasoningTailOf } from "./reasoning-reading.js";

describe("reasoningTailOf", () => {
  it("takes the newest lines and not the first ones", () => {
    expect(reasoningTailOf("one\ntwo\nthree\nfour\nfive")).toEqual(["three", "four", "five"]);
  });
});
