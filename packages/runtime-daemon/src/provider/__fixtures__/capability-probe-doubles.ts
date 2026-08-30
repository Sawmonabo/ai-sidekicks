// Test doubles for the T3.24 capability-probe transport.
//
// Excluded from `tsconfig.json`'s build (`src/**/__fixtures__/**`), so nothing
// here ships in `dist/` — it exists so every suite that needs a probe surface
// drives the REAL classifier and the REAL mechanism table against a recording
// transport, rather than each one hand-rolling reply shapes that could drift
// apart from the wire references.
//
// The default replies are the REALISTIC ones, deliberately:
//
//   * the negative control answers each channel's own name-level refusal — the
//     Claude dispatcher's verbatim `Unsupported control request subtype:` prefix
//     and the Codex app-server's `-32600` unknown-method reply;
//   * every other name answers the reply a PAYLOAD-FREE probe actually draws.
//     On Codex that is `-32602 Invalid params` — the method exists and its
//     schema refused the empty request, which is exactly the outcome that keeps
//     the probe non-mutating. A suite whose default was a bare `result` would
//     never exercise that arm.
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

/** The Codex app-server's `-32600` reply, whose message enumerates the accepted set. */
export function codexUnknownMethodReply(method: string): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    error: {
      code: -32600,
      message: `unknown method '${method}'; accepted: initialize, thread/start, turn/start, turn/steer, thread/goal/set`,
    },
  };
}

/** The reply a payload-free probe of an ACCEPTED Codex method draws. */
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
  return isNegativeControl ? codexUnknownMethodReply(probeName) : codexInvalidParamsReply();
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
 */
export function fullyProbedDetectionReading(
  driverName: FlooredDriverName,
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
  return { driverName, detectionSource, withdrawnFlags: [], diagnostics: [] };
}

/** The channel a driver's probes ride — re-exported so suites need one import. */
export function probeChannelFor(driverName: FlooredDriverName): CapabilityProbeRequest["channel"] {
  return CAPABILITY_PROBE_CHANNELS[driverName];
}
