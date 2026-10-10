// A person who set `Helpers at once` to none gets no helpers, and one who left it empty gets no
// limit carried to the driver rather than the provider's own.

import { describe, expect, it } from "vitest";

import { assembleSubagentPolicy } from "../native-subagent-governor.js";

const REVIEWER = {
  name: "reviewer",
  description: "Reviews a change",
  prompt: "Review the change for defects.",
};

describe("native subagent governor", () => {
  it("disables helpers when the person allows none", () => {
    expect(assembleSubagentPolicy({ helpersAtOnce: 0, definitions: [REVIEWER] })).toStrictEqual({
      enabled: false,
    });
  });

  it("carries no limit as null and a set limit as set", () => {
    expect(assembleSubagentPolicy({ helpersAtOnce: null, definitions: [REVIEWER] })).toStrictEqual({
      enabled: true,
      helpersAtOnce: null,
      definitions: [REVIEWER],
    });
    expect(assembleSubagentPolicy({ helpersAtOnce: 3, definitions: [] })).toStrictEqual({
      enabled: true,
      helpersAtOnce: 3,
      definitions: [],
    });
  });
});
