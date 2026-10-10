// Claude's capability-probe reply classifier over the control-response arms a probe can draw.

import { describe, expect, it } from "vitest";

import type { ProbeAnswer } from "../../../capability/probe.js";
import { CLAUDE_DRIVER_DESCRIPTOR } from "../descriptor.js";
import {
  claudeContextualRefusalReply,
  claudeInitializeReply,
  claudeSuccessReply,
  claudeUnsupportedSubtypeReply,
} from "../__fixtures__/capability-probe-replies.js";

// Its refusal is name-level already; only the fast-mode probe's name changes the reading.
function classifyClaudeProbeReply(payload: unknown, probeName = ""): ProbeAnswer {
  return CLAUDE_DRIVER_DESCRIPTOR.classifyCapabilityProbeReply(payload, probeName);
}

describe("Claude capability-probe reply classification", () => {
  it("classifies the Claude control-response arms", () => {
    expect(classifyClaudeProbeReply(claudeSuccessReply())).toBe("accepted");
    // A registered subtype refusing for context accepts the name (`get_usage is not supported in
    // this context`); reading it as absence would withdraw a live capability.
    expect(classifyClaudeProbeReply(claudeContextualRefusalReply("get_usage"))).toBe("accepted");
    expect(classifyClaudeProbeReply(claudeUnsupportedSubtypeReply("zzq"))).toBe("unknown-name");
    expect(classifyClaudeProbeReply({ subtype: "success" })).toBe("accepted");
    expect(classifyClaudeProbeReply({ subtype: "error", error: 42 })).toBe("unrecognized");
    expect(classifyClaudeProbeReply(null)).toBe("unrecognized");
    expect(classifyClaudeProbeReply([])).toBe("unrecognized");
    expect(classifyClaudeProbeReply({ subtype: "mystery" })).toBe("unrecognized");
  });

  it("accepts the `initialize` probe only when its reply carries the fast-mode state", () => {
    // A build whose reply reports no state has no axis this driver can read, so it withdraws.
    expect(classifyClaudeProbeReply(claudeInitializeReply(), "initialize")).toBe("accepted");
    expect(classifyClaudeProbeReply(claudeSuccessReply(), "initialize")).toBe("unrecognized");
  });
});
