import { describe, expect, it } from "vitest";

import { buildWindowNoticeText, buildWindowNoticeTexts } from "./window-notices.js";

const SUBJECT = "entries";

describe("window notices — what there is to say", () => {
  it("says nothing about a counted absence of zero", () => {
    expect(buildWindowNoticeTexts([{ kind: "dropped", count: 0 }], SUBJECT)).toStrictEqual([]);
  });

  it("formats the dropped count through the figures chokepoint", () => {
    expect(buildWindowNoticeText({ kind: "dropped", count: 1200 }, SUBJECT).detail).toContain(
      "1,200",
    );
  });
});
