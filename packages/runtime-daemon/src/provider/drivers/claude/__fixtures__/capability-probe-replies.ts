// Claude control-response replies to a capability probe, for the recording probe transport and the
// probe-reply classifier. The negative control draws the dispatcher's name-level refusal
// (`Unsupported control request subtype:`); any other name draws a `success`.

import { CLAUDE_DRIVER_DESCRIPTOR } from "../claude-driver-descriptor.js";

/** The Claude control-response arm for a subtype the dispatcher does not know. */
export function claudeUnsupportedSubtypeReply(subtype: string): unknown {
  return {
    type: "control_response",
    response: {
      subtype: "error",
      request_id: "probe-1",
      error: `Unsupported control request subtype: ${subtype}`,
    },
  };
}

/** A Claude control-response `success` arm carrying `body`. */
export function claudeSuccessReply(body: Record<string, unknown> = {}): unknown {
  return {
    type: "control_response",
    response: { subtype: "success", request_id: "probe-1", response: body },
  };
}

/** The measured `initialize` reply before the fast-mode opt-in, trimmed to the probed members. */
export function claudeInitializeReply(): unknown {
  return claudeSuccessReply({
    fast_mode_state: "off",
    fast_mode_disabled_reason: "sdk_opt_in_required",
  });
}

/**
 * A Claude control-response error arm that is not name-level, such as
 * `get_usage is not supported in this context`. The dispatcher knows the subtype, so this
 * classifies as acceptance.
 */
export function claudeContextualRefusalReply(subtype: string): unknown {
  return {
    type: "control_response",
    response: {
      subtype: "error",
      request_id: "probe-1",
      error: `${subtype} is not supported in this context (callback not registered)`,
    },
  };
}

/**
 * The reply a Claude build gives `probeName`: a refusal for the negative control, the measured
 * reply for `initialize`, else success.
 */
export function claudeDefaultProbeReply(probeName: string): unknown {
  if (probeName === CLAUDE_DRIVER_DESCRIPTOR.capabilityProbeNegativeControl) {
    return claudeUnsupportedSubtypeReply(probeName);
  }
  return probeName === "initialize" ? claudeInitializeReply() : claudeSuccessReply();
}
