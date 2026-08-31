// Test doubles for the T3.24 capability-probe transport.
//
// Excluded from `tsconfig.json`'s build (`src/**/__fixtures__/**`), so nothing
// here ships in `dist/` — it exists so every suite that needs a probe surface
// drives the REAL classifier and the REAL mechanism table against a recording
// transport, rather than each one hand-rolling reply shapes that could drift
// apart from the wire references.
//
// The default replies are the MEASURED ones, deliberately — every Codex shape
// below is a verbatim message from a first-party probe of the pinned build
// (codex-cli 0.150.1, 2026-08-30), not a plausible-looking reconstruction:
//
//   * the negative control answers each channel's own name-level refusal — the
//     Claude dispatcher's verbatim `Unsupported control request subtype:`
//     prefix, and the Codex deserializer's `unknown variant` enumeration under
//     the generic `-32600`;
//   * every other name answers the reply a PAYLOAD-FREE probe actually draws.
//     On Codex that is ALSO a `-32600`, carrying a missing-field message: the
//     method exists and its schema refused the empty request, which is exactly
//     the outcome that keeps the probe non-mutating. Those two shapes sharing
//     one error code is the whole reason the classifier reads the message, so a
//     fixture whose accepted-method default used a distinguishable code
//     (`-32602`) would let a broken classifier pass. That code is kept below as
//     a SECOND accepted shape rather than as the default.
//
// Refs: Plan-005 T3.24, `docs/reference/provider-wire/claude.md`,
// `docs/reference/provider-wire/codex.md`.

import type { CapabilityDetectionSource, DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import {
  CAPABILITY_DETECTION_TABLES,
  CAPABILITY_PROBE_CHANNELS,
  CAPABILITY_PROBE_NEGATIVE_CONTROLS,
  type CapabilityDetectionMechanism,
  type CapabilityDetectionReading,
  type CapabilityProbeExchange,
  type CapabilityProbeRequest,
} from "../capability-probe.js";
import type { FlooredDriverName } from "../capability-refresh.js";

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

/** A Claude control-response `success` arm. */
export function claudeSuccessReply(): unknown {
  return {
    type: "control_response",
    response: { subtype: "success", request_id: "probe-1", response: {} },
  };
}

/**
 * A Claude control-response error arm that is NOT name-level — the wire
 * reference's own `get_usage is not supported in this context` shape. The
 * dispatcher knows the subtype, so this classifies as acceptance.
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
 * The Codex deserializer's unknown-variant reply, in its measured verbatim
 * shape: the variant it refused, then the enumeration of the ones it accepts.
 *
 * The primitive rather than the method-level helper, because the same shape
 * appears for variants nested INSIDE an accepted request — which is precisely
 * the case that must not be read as a missing method.
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

/**
 * A sample of the accepted client-request methods the pinned build enumerates.
 *
 * A SAMPLE and not the census: the real enumeration is the deserializer's whole
 * `ClientRequest` variant list, and nothing here depends on its length — only
 * on whether a given name is in it.
 */
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
 * The reply a name the connection does not accept draws.
 *
 * The refused name is filtered OUT of the enumeration, because that is what the
 * real build does: an enumeration that listed the very variant it refused would
 * be self-contradictory, and the classifier reads such a reply as acceptance.
 */
export function codexUnknownMethodReply(method: string): unknown {
  return codexUnknownVariantReply(
    method,
    CODEX_ACCEPTED_METHOD_SAMPLE.filter((accepted) => accepted !== method),
  );
}

/**
 * The reply a payload-free probe of an ACCEPTED Codex method draws: the same
 * `-32600` code, carrying the deserializer's missing-field message.
 */
export function codexMissingFieldReply(field = "threadId"): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32600, message: `Invalid request: missing field \`${field}\`` },
  };
}

/**
 * The measured reply an ACCEPTED but capability-gated method draws: `-32600`
 * with a plain-prose reason and no enumeration at all.
 */
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

function defaultReply(driverName: FlooredDriverName, probeName: string): unknown {
  const isNegativeControl = probeName === CAPABILITY_PROBE_NEGATIVE_CONTROLS[driverName];
  if (driverName === "claude") {
    return isNegativeControl ? claudeUnsupportedSubtypeReply(probeName) : claudeSuccessReply();
  }
  return isNegativeControl ? codexUnknownMethodReply(probeName) : codexMissingFieldReply();
}

/** Per-name overrides: a raw reply, or a thrown rejection. */
export interface RecordingProbeTransportOptions {
  readonly replies?: Readonly<Record<string, unknown>>;
  readonly rejections?: Readonly<Record<string, unknown>>;
}

/**
 * Records every probe dispatch and answers from the defaults above.
 *
 * The recording is the point: the zero-billed-turn claim is asserted HERE, at
 * the provider transport, because a daemon-side assertion on usage or
 * run-lifecycle events cannot see a turn billed before event handling attached.
 */
export class RecordingCapabilityProbeTransport {
  readonly requests: CapabilityProbeRequest[] = [];
  readonly #driverName: FlooredDriverName;
  readonly #replies: Readonly<Record<string, unknown>>;
  readonly #rejections: Readonly<Record<string, unknown>>;

  constructor(driverName: FlooredDriverName, options: RecordingProbeTransportOptions = {}) {
    this.#driverName = driverName;
    this.#replies = options.replies ?? {};
    this.#rejections = options.rejections ?? {};
  }

  /** The injected seam. Arrow-bound so callers may pass it unbound. */
  readonly exchange: CapabilityProbeExchange = async (
    request: CapabilityProbeRequest,
  ): Promise<unknown> => {
    this.requests.push(request);
    if (Object.hasOwn(this.#rejections, request.probeName)) {
      throw this.#rejections[request.probeName];
    }
    if (Object.hasOwn(this.#replies, request.probeName)) {
      return this.#replies[request.probeName];
    }
    return defaultReply(this.#driverName, request.probeName);
  };

  /** Every wire name this transport was asked to issue, in dispatch order. */
  get issuedProbeNames(): readonly string[] {
    return this.requests.map((request) => request.probeName);
  }
}

/**
 * A detection reading in which every probe answered — the provenance the tables
 * declare, with nothing withdrawn.
 *
 * DERIVED from the real tables rather than transcribed, so a table edit moves
 * this helper with it and a suite that only needs "some valid reading" cannot
 * quietly assert a stale shape.
 *
 * `boundExecutablePath` is REQUIRED and not defaulted: a composition site
 * compares it against its version reading's own resolved path, so a helper that
 * invented one would hand every suite a reading that passes that check by
 * accident.
 */
export function fullyProbedDetectionReading(
  driverName: FlooredDriverName,
  boundExecutablePath: string,
): CapabilityDetectionReading {
  const detectionSource: Record<DriverCapabilityFlag, CapabilityDetectionSource> = {} as Record<
    DriverCapabilityFlag,
    CapabilityDetectionSource
  >;
  for (const [flag, mechanism] of Object.entries(CAPABILITY_DETECTION_TABLES[driverName]) as [
    DriverCapabilityFlag,
    CapabilityDetectionMechanism,
  ][]) {
    detectionSource[flag] = mechanism.detectionSource;
  }
  return { driverName, boundExecutablePath, detectionSource, withdrawnFlags: [], diagnostics: [] };
}

/** The channel a driver's probes ride — re-exported so suites need one import. */
export function probeChannelFor(driverName: FlooredDriverName): CapabilityProbeRequest["channel"] {
  return CAPABILITY_PROBE_CHANNELS[driverName];
}
