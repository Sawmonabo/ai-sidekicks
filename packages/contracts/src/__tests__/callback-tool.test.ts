// The callback tool catalog feeds the allowlist picker, whose saved names a provider
// is later told to allow. These cases hold that an entry without a label is read and
// that a nameless entry never reaches the picker.
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

  it("refuses a tool with an empty name", () => {
    const response = { tools: [{ name: "", description: "Nothing." }] };
    expect(CallbackToolListResponseSchema.safeParse(response).success).toBe(false);
  });
});
