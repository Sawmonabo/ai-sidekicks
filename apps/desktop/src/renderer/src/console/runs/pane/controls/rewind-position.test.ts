// The whole-value rule, held to a table — including the case that motivated it.
//
// The negative control is the prefix parse itself: `Number.parseInt("4oops", 10)`
// answers `4`, and asserting that in the same file is what keeps the table from
// looking like a restatement of behaviour every parser already had.

import { describe, expect, it } from "vitest";

import { parseRewindPosition } from "./rewind-position.js";

describe("a rewind position is the whole trimmed value", () => {
  const table = [
    { typed: "4", expected: { status: "named", position: 4 } },
    { typed: " 4 ", expected: { status: "named", position: 4 } },
    { typed: "0", expected: { status: "named", position: 0 } },
    { typed: "007", expected: { status: "named", position: 7 } },
    { typed: "", expected: { status: "unnamed" } },
    { typed: "   ", expected: { status: "unnamed" } },
    { typed: "4oops", expected: { status: "unreadable" } },
    { typed: "-1", expected: { status: "unreadable" } },
    { typed: "1e3", expected: { status: "unreadable" } },
    { typed: "4.0", expected: { status: "unreadable" } },
    { typed: "0x10", expected: { status: "unreadable" } },
    { typed: "+4", expected: { status: "unreadable" } },
    // `Number("٤")` is 4. A locale digit reads as a position on screen and is not
    // one on this wire, so the ASCII grammar refuses it rather than converting it.
    { typed: "٤", expected: { status: "unreadable" } },
    // Past the safe-integer range the registered parser refuses, so this surface
    // refuses it too rather than sending a value the daemon will reject.
    { typed: "9007199254740992", expected: { status: "unreadable" } },
    { typed: "9007199254740991", expected: { status: "named", position: 9007199254740991 } },
  ] as const;

  for (const row of table) {
    it(`reads ${JSON.stringify(row.typed)} as ${row.expected.status}`, () => {
      expect(parseRewindPosition(row.typed)).toStrictEqual(row.expected);
    });
  }

  it("negative control: the prefix parse this replaces answers 4 for the same value", () => {
    // Without this the table above would read as a description of what any integer
    // parse already did. `parseInt` stops at the first character it cannot use, and
    // stopping there is precisely how a typed suffix became a destructive rollback.
    expect(Number.parseInt("4oops", 10)).toBe(4);
    expect(parseRewindPosition("4oops").status).toBe("unreadable");
  });
});
