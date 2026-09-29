// Which window notices a transcript shows, and in what order.

import { describe, expect, it } from "vitest";

import { buildWindowNoticeText, buildWindowNoticeTexts } from "./window-notices.js";

const SUBJECT = "entries";

describe("window notices — what there is to say", () => {
  it("says nothing about a counted absence of zero", () => {
    expect(
      buildWindowNoticeTexts(
        [
          { kind: "dropped", count: 0 },
          { kind: "duplicate-key", count: 0 },
        ],
        SUBJECT,
      ),
    ).toStrictEqual([]);
  });

  it("says every absence a window really has, in the caller's order", () => {
    const notices = buildWindowNoticeTexts(
      [
        { kind: "dropped", count: 0 },
        { kind: "duplicate-key", count: 3 },
        { kind: "never-received" },
      ],
      SUBJECT,
    );
    expect(notices.map((notice) => notice.title)).toStrictEqual([
      "Some entries share an identifier.",
      "Some entries never arrived.",
    ]);
  });

  it("keeps the countless notice, which a count filter alone would drop", () => {
    expect(buildWindowNoticeTexts([{ kind: "never-received" }], SUBJECT)).toHaveLength(1);
  });

  it("formats the dropped count through the figures chokepoint", () => {
    expect(buildWindowNoticeText({ kind: "dropped", count: 1200 }, SUBJECT).detail).toContain(
      "1,200",
    );
  });
});
