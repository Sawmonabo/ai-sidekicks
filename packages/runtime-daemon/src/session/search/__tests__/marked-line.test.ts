// Reading a highlight back ends on every input, whatever marks it carries.

import { describe, expect, it } from "vitest";

import { MATCH_CLOSE_MARK, MATCH_OPEN_MARK, readMarks } from "../marked-line.js";

describe("readMarks", () => {
  it("reads unpaired marks in one pass: an open match runs to the end, a stray close drops", () => {
    expect(readMarks(`a${MATCH_CLOSE_MARK}b${MATCH_OPEN_MARK}cd`)).toEqual({
      text: "abcd",
      ranges: [{ start: 2, end: 4 }],
    });
    expect(readMarks(`${MATCH_OPEN_MARK}${MATCH_OPEN_MARK}x${MATCH_CLOSE_MARK}`)).toEqual({
      text: "x",
      ranges: [{ start: 0, end: 1 }],
    });
  });
});
