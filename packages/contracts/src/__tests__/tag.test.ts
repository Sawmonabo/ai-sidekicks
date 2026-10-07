// A tag is matched ignoring case and read level by level around `/`, so a tag the schema let
// through with a space, an empty level or a case-only twin would file a record under a tag no
// search or filter can name.
import { describe, expect, it } from "vitest";

import { TagListSchema, TagSchema } from "../tag.js";

describe("TagSchema", () => {
  it("accepts a nested tag", () => {
    expect(TagSchema.safeParse("billing/stripe").success).toBe(true);
  });

  it.each([
    ["an empty tag", ""],
    ["a space", "two words"],
    ["a tab", "two\twords"],
    ["an empty middle level", "billing//stripe"],
    ["an empty first level", "/billing"],
    ["an empty last level", "billing/"],
    ["a tag longer than a session name", "t".repeat(257)],
  ])("refuses %s", (_name, tag) => {
    expect(TagSchema.safeParse(tag).success).toBe(false);
  });
});

describe("TagListSchema", () => {
  it("refuses a tag that differs from an earlier one only in case, at its index", () => {
    const parsed = TagListSchema.safeParse(["Ops", "billing", "ops"]);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({ path: [2], message: expect.stringContaining("ops") }),
    ]);
    expect(TagListSchema.safeParse(["ops", "billing/ops"]).success).toBe(true);
  });
});
