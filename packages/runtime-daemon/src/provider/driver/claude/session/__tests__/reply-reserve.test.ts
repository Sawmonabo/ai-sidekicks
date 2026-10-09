import { describe, expect, it } from "vitest";

import { deriveClaudeReplyReserve } from "../reply-reserve.js";

describe("deriveClaudeReplyReserve", () => {
  it("reads the reserve and constant from the two points, and nothing from a key not taken", () => {
    // The points Claude Code 2.1.294 reported on a 100,000-token window, then with a 1,000 cap.
    const windowOnly = {
      maxTokens: 100_000,
      autoCompactThreshold: 67_000,
      model: "claude-opus-5-5",
    };
    const read = (cappedPoint: number): ReturnType<typeof deriveClaudeReplyReserve> =>
      deriveClaudeReplyReserve("opus", {
        kind: "read",
        windowOnly,
        withMaximumOutput: { ...windowOnly, autoCompactThreshold: cappedPoint },
      });

    expect(read(86_000)).toStrictEqual({
      kind: "read",
      model: "claude-opus-5-5",
      replyReserveTokens: 20_000,
      constantTokens: 13_000,
    });
    // A cap Claude Code dropped leaves the point where it was; no figure is made up from it.
    expect(read(67_000)).toStrictEqual({
      kind: "unread",
      reason: "Claude Code did not take the maximum reply key.",
    });
  });
});
