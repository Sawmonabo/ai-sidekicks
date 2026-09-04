// The two numbers a windowed row carries, held against the index the window addresses
// it by.
//
// Driven directly rather than through either list that spreads it: the claim is the
// off-by-one between a zero-based index and a one-based position, and a case that had
// to mount a virtualizer to check it would be checking the virtualizer.

import { describe, expect, it } from "vitest";

import { windowedRowPosition } from "./windowed-row-position.js";

describe("windowedRowPosition", () => {
  it("counts the position from one, because that is what the attribute means", () => {
    expect(windowedRowPosition(0, 5_000)).toStrictEqual({
      "aria-setsize": 5_000,
      "aria-posinset": 1,
    });
  });

  it("reports the whole list's size for a row deep inside it", () => {
    expect(windowedRowPosition(4_000, 5_000)).toStrictEqual({
      "aria-setsize": 5_000,
      "aria-posinset": 4_001,
    });
  });

  it("negative control: the size is the list's and never the window's", () => {
    // Without this, a helper handed the mounted-row count would satisfy both cases
    // above for the first window and report a five-thousand-file change set as
    // thirty rows long everywhere else.
    expect(windowedRowPosition(4_000, 5_000)["aria-setsize"]).not.toBe(
      windowedRowPosition(4_000, 30)["aria-setsize"],
    );
  });
});
