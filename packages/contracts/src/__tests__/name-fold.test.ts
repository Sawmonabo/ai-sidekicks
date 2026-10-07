// The fold every name held once is compared by: workflow names in the library and the names typed
// for pasted-token accounts. A machine's language must never move it.
import { describe, expect, it } from "vitest";

import { foldName } from "../name-fold.js";

describe("foldName", () => {
  it("folds by Unicode's full case folding, never by the machine's language", () => {
    // Full folding turns ß and the capital ẞ into ss, which lower-casing does not.
    expect(foldName("Straße")).toBe(foldName("STRASSE"));
    expect(foldName("STRAẞE")).toBe(foldName("STRASSE"));
    // The dotted capital İ folds to i and a combining dot, so it is not the plain i; the dotless
    // ı has no folding and stays apart from i, which an upper-then-lower mapping would merge, and
    // I folds to i as in every language but Turkish.
    expect(foldName("İ")).toBe("i̇");
    expect(foldName("ı")).not.toBe(foldName("i"));
    expect(foldName("I")).toBe("i");
  });
});
