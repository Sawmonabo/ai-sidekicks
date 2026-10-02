// Codex JSON-RPC replies to a capability probe, for the recording probe transport and the
// probe-reply classifier. Every shape is a verbatim message from a probe of codex-cli 0.150.1.
//
// * The negative control draws the deserializer's `unknown variant` enumeration under `-32600`.
// * Any other name draws the reply a payload-free probe gets: also `-32600`, with a missing-field
//   message. The method exists and its schema refused the empty request, which is what keeps the
//   probe non-mutating. Because the two shapes share a code, the classifier has to read the
//   message; a default with a distinguishable code (`-32602`) would let a broken classifier pass,
//   so that code is only a second accepted shape.

import { CODEX_DRIVER_DESCRIPTOR } from "../codex-driver-descriptor.js";

/**
 * The Codex deserializer's unknown-variant reply: the variant it refused, then the ones it
 * accepts. The same shape appears for a variant nested inside an accepted request, which must not
 * be read as a missing method.
 */
export function codexUnknownVariantReply(
  variant: string,
  acceptedVariants: readonly string[],
): unknown {
  const enumeration = acceptedVariants.map((accepted) => `\`${accepted}\``).join(", ");
  return {
    jsonrpc: "2.0",
    id: 1,
    error: {
      code: -32600,
      message: `Invalid request: unknown variant \`${variant}\`, expected one of ${enumeration}`,
    },
  };
}

// A sample of the accepted client-request methods, not the full list; only whether a name is in
// it matters.
const CODEX_ACCEPTED_METHOD_SAMPLE: readonly string[] = Object.freeze([
  "initialize",
  "server/diagnostics",
  "thread/start",
  "turn/start",
  "turn/steer",
  "thread/goal/set",
  "thread/goal/clear",
  "thread/compact/start",
  "skills/list",
]);

/**
 * The reply a method the connection does not accept draws. The refused name is filtered out of
 * the enumeration, as the real build does; an enumeration listing the variant it refused would
 * read as acceptance.
 */
export function codexUnknownMethodReply(method: string): unknown {
  return codexUnknownVariantReply(
    method,
    CODEX_ACCEPTED_METHOD_SAMPLE.filter((accepted) => accepted !== method),
  );
}

/** The reply a payload-free probe of an accepted Codex method draws: `-32600`, missing field. */
export function codexMissingFieldReply(field = "threadId"): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32600, message: `Invalid request: missing field \`${field}\`` },
  };
}

/** The reply an accepted but capability-gated method draws: `-32600`, plain reason, no list. */
export function codexCapabilityGatedReply(method: string): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32600, message: `${method} requires experimentalApi capability` },
  };
}

/** A second accepted-method shape: an explicit invalid-params refusal. */
export function codexInvalidParamsReply(): unknown {
  return { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } };
}

/** A Codex success reply. */
export function codexResultReply(): unknown {
  return { jsonrpc: "2.0", id: 1, result: {} };
}

/**
 * The reply a Codex build gives `probeName`: an unknown method for the negative control, else the
 * missing-field refusal a payload-free probe draws.
 */
export function codexDefaultProbeReply(probeName: string): unknown {
  return probeName === CODEX_DRIVER_DESCRIPTOR.capabilityProbeNegativeControl
    ? codexUnknownMethodReply(probeName)
    : codexMissingFieldReply();
}
