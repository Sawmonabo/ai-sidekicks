// Codex's capability-probe reply classifier over the JSON-RPC shapes a probe can draw, including
// the `-32600` arm a code alone cannot classify.

import { describe, expect, it } from "vitest";

import type { ProbeAnswer } from "../../../capability-probe.js";
import { CODEX_DRIVER_DESCRIPTOR } from "../codex-driver-descriptor.js";
import {
  codexCapabilityGatedReply,
  codexInvalidParamsReply,
  codexMissingFieldReply,
  codexResultReply,
  codexUnknownMethodReply,
  codexUnknownVariantReply,
} from "../__fixtures__/capability-probe-replies.js";

function classifyCodexProbeReply(payload: unknown, probeName: string): ProbeAnswer {
  return CODEX_DRIVER_DESCRIPTOR.classifyCapabilityProbeReply(payload, probeName);
}

describe("Codex capability-probe reply classification", () => {
  it("classifies the Codex JSON-RPC arms", () => {
    expect(classifyCodexProbeReply(codexResultReply(), "turn/steer")).toBe("accepted");
    // `-32602` is a second shape an accepted method can answer a payload-free probe with; reading
    // it as absence would withdraw every probed flag.
    expect(classifyCodexProbeReply(codexInvalidParamsReply(), "turn/steer")).toBe("accepted");
    expect(classifyCodexProbeReply(codexUnknownMethodReply("zzq/x"), "zzq/x")).toBe("unknown-name");
    expect(
      classifyCodexProbeReply({ error: { code: -32601, message: "Method not found" } }, "zzq/x"),
    ).toBe("unknown-name");
    expect(classifyCodexProbeReply({ error: { code: "-32600" } }, "zzq/x")).toBe("unrecognized");
    expect(classifyCodexProbeReply({}, "zzq/x")).toBe("unrecognized");
    expect(classifyCodexProbeReply(undefined, "zzq/x")).toBe("unrecognized");
  });

  it("reads the MESSAGE and not only the code on the Codex `-32600` arm", () => {
    // The measured build answers `-32600` both for an unaccepted name and for an accepted name
    // whose payload does not deserialize, so a code-only classifier would withdraw every probed
    // flag. These are the three measured shapes, verbatim.
    expect(classifyCodexProbeReply(codexMissingFieldReply(), "turn/steer")).toBe("accepted");
    expect(
      classifyCodexProbeReply(
        codexCapabilityGatedReply("server/diagnostics"),
        "server/diagnostics",
      ),
    ).toBe("accepted");
    expect(classifyCodexProbeReply(codexUnknownMethodReply("turn/steer"), "turn/steer")).toBe(
      "unknown-name",
    );
  });

  it("resolves every ambiguous Codex `-32600` toward ACCEPTED", () => {
    // Resolution is withdraw-only: a wrong `accepted` keeps the declared matrix, a wrong
    // `unknown-name` silently disables a live capability. First, an enumeration about a variant
    // nested inside an accepted request…
    expect(
      classifyCodexProbeReply(
        codexUnknownVariantReply("on-failure", ["untrusted", "on-request", "granular", "never"]),
        "turn/steer",
      ),
    ).toBe("accepted");
    // …an enumeration that contains the probed name, so the refusal was about something else…
    expect(
      classifyCodexProbeReply(
        codexUnknownVariantReply("turn/steer", ["turn/steer", "thread/start"]),
        "turn/steer",
      ),
    ).toBe("accepted");
    // …and a `-32600` whose message is not a string at all.
    expect(classifyCodexProbeReply({ error: { code: -32600, message: 7 } }, "turn/steer")).toBe(
      "accepted",
    );
  });
});
