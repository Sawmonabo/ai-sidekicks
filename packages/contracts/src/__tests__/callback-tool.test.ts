// The callback tool catalog feeds the allowlist picker, whose saved names a provider is later told
// to allow. A tool registered with a label and one without are both listed; the picker draws the
// label-less one by its name.
import { describe, expect, it } from "vitest";

import { CallbackToolListResponseSchema } from "../callback-tool.js";

describe("callbackTool.list", () => {
  it("accepts a tool drawn by its name, beside one with a label", () => {
    const response = {
      tools: [
        { name: "run", description: "Start a run under another agent." },
        { name: "ask_user", label: "Ask you", description: "Put a question to the person." },
      ],
    };
    expect(CallbackToolListResponseSchema.safeParse(response).success).toBe(true);
  });
});
