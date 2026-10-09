import { describe, expect, it } from "vitest";

import { fuseRankedLists } from "../rank-fusion.js";

describe("fuseRankedLists", () => {
  it("puts an item both lists rank above one that either list ranks alone, even first", () => {
    // `both` is second in each list; `textOnly` and `relationOnly` each lead one list.
    const textRank = ["textOnly", "both"];
    const relationRank = ["relationOnly", "both"];

    expect(fuseRankedLists([textRank, relationRank])).toEqual(["both", "textOnly", "relationOnly"]);
  });
});
