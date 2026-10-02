// Claude's capability-probe reply classifier over the control-response arms a probe can draw.

import { describe, expect, it } from "vitest";

import type { ProbeAnswer } from "../../../capability-probe.js";
import { CLAUDE_DRIVER_DESCRIPTOR } from "../claude-driver-descriptor.js";
import {
  claudeContextualRefusalReply,
  claudeSuccessReply,
  claudeUnsupportedSubtypeReply,
} from "../__fixtures__/capability-probe-replies.js";

// The Claude classifier reads no probe name: its refusal is name-level already.
function classifyClaudeProbeReply(payload: unknown): ProbeAnswer {
  return CLAUDE_DRIVER_DESCRIPTOR.classifyCapabilityProbeReply(payload, "");
}

describe("Claude capability-probe reply classification", () => {
  it("classifies the Claude control-response arms", () => {
    expect(classifyClaudeProbeReply(claudeSuccessReply())).toBe("accepted");
    // A registered subtype refusing for context accepts the name (`get_usage is not supported in
    // this context`); reading it as absence would withdraw a live capability.
    expect(classifyClaudeProbeReply(claudeContextualRefusalReply("get_usage"))).toBe("accepted");
    expect(classifyClaudeProbeReply(claudeUnsupportedSubtypeReply("zzq"))).toBe("unknown-name");
    // Unwrapped inner response — the seam may return either shape.
    expect(classifyClaudeProbeReply({ subtype: "success" })).toBe("accepted");
    expect(classifyClaudeProbeReply({ subtype: "error", error: 42 })).toBe("unrecognized");
    expect(classifyClaudeProbeReply(null)).toBe("unrecognized");
    expect(classifyClaudeProbeReply([])).toBe("unrecognized");
    expect(classifyClaudeProbeReply({ subtype: "mystery" })).toBe("unrecognized");
  });
});
