// Test doubles for the capability-probe transport and the capability declaration sink.
//
// Excluded from the build (`src/**/__fixtures__/**` in `tsconfig.json`), so nothing here ships in
// `dist/`. Suites use these to run the real classifier and mechanism table against a recording
// transport instead of hand-rolling reply shapes that could drift from the wire.
//
// The default replies are measured, not reconstructed: every Codex shape is a verbatim message
// from a probe of codex-cli 0.150.1.
//
// * The negative control gets each channel's own name-level refusal: the Claude dispatcher's
//   `Unsupported control request subtype:` prefix, and the Codex deserializer's `unknown variant`
//   enumeration under `-32600`.
// * Any other name gets the reply a payload-free probe draws. On Codex that is also `-32600`, with
//   a missing-field message: the method exists and its schema refused the empty request, which is
//   what keeps the probe non-mutating. Because the two shapes share a code, the classifier has to
//   read the message; a default with a distinguishable code (`-32602`) would let a broken
//   classifier pass, so that code is only a second accepted shape.

import type { DriverCapabilityFlag, ProviderName } from "@ai-sidekicks/contracts";

import type {
  CapabilityDetectionMechanism,
  CapabilityDetectionReading,
  CapabilityProbeExchange,
  CapabilityProbeRequest,
} from "../capability-probe.js";
import { PROVIDER_DRIVER_DESCRIPTORS } from "../provider-driver-descriptors.js";
import type {
  DeclareDriverCapabilitiesInput,
  DeclareDriverCapabilitiesResult,
  DriverCapabilityDeclarationSink,
} from "../driver-capabilities-writer.js";
import type { CapabilityDetectionSource } from "../provider-driver.js";

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

function defaultReply(driverName: ProviderName, probeName: string): unknown {
  const isNegativeControl =
    probeName === PROVIDER_DRIVER_DESCRIPTORS[driverName].capabilityProbeNegativeControl;
  if (driverName === "claude") {
    return isNegativeControl ? claudeUnsupportedSubtypeReply(probeName) : claudeSuccessReply();
  }
  return isNegativeControl ? codexUnknownMethodReply(probeName) : codexMissingFieldReply();
}

/** Per-name reply overrides. */
interface RecordingProbeTransportOptions {
  readonly replies?: Readonly<Record<string, unknown>>;
}

/** Records every probe dispatch and answers from the defaults above, or a per-name override. */
export class RecordingCapabilityProbeTransport {
  readonly requests: CapabilityProbeRequest[] = [];
  readonly #driverName: ProviderName;
  readonly #replies: Readonly<Record<string, unknown>>;

  constructor(driverName: ProviderName, options: RecordingProbeTransportOptions = {}) {
    this.#driverName = driverName;
    this.#replies = options.replies ?? {};
  }

  /** The injected seam; arrow-bound so callers may pass it unbound. */
  readonly exchange: CapabilityProbeExchange = async (
    request: CapabilityProbeRequest,
  ): Promise<unknown> => {
    this.requests.push(request);
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
 * A detection reading in which every probe answered: the provenance the tables declare, with
 * nothing withdrawn. It is derived from the real tables, so a table edit moves it too.
 * `boundExecutablePath` is required because a composition site compares it with the version
 * reading's resolved path, and an invented default would pass that check by accident.
 */
export function fullyProbedDetectionReading(
  driverName: ProviderName,
  boundExecutablePath: string,
): CapabilityDetectionReading {
  const detectionSource: Record<DriverCapabilityFlag, CapabilityDetectionSource> = {} as Record<
    DriverCapabilityFlag,
    CapabilityDetectionSource
  >;
  for (const [flag, mechanism] of Object.entries(
    PROVIDER_DRIVER_DESCRIPTORS[driverName].capabilityDetectionTable,
  ) as [DriverCapabilityFlag, CapabilityDetectionMechanism][]) {
    detectionSource[flag] = mechanism.detectionSource;
  }
  return { driverName, boundExecutablePath, detectionSource, withdrawnFlags: [], diagnostics: [] };
}

/**
 * Records every declaration handed to the capability writer and answers each one with
 * a fixed verdict. It implements `DriverCapabilityDeclarationSink`, so a signature
 * change on `DriverCapabilitiesWriter.declare` breaks every suite that uses it.
 */
export class RecordingDeclarationSink implements DriverCapabilityDeclarationSink {
  readonly calls: DeclareDriverCapabilitiesInput[] = [];
  readonly #verdict: DeclareDriverCapabilitiesResult;

  constructor(
    verdict: DeclareDriverCapabilitiesResult = {
      snapshotChange: "created",
      cliVersionRefreshed: true,
    },
  ) {
    this.#verdict = verdict;
  }

  declare(input: DeclareDriverCapabilitiesInput): Promise<DeclareDriverCapabilitiesResult> {
    this.calls.push(input);
    return Promise.resolve(this.#verdict);
  }
}
