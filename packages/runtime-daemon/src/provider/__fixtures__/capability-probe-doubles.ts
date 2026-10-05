// Test doubles for the capability-probe transport and the capability declaration sink.
//
// Excluded from the build (`src/**/__fixtures__/**` in `tsconfig.json`), so nothing here ships in
// `dist/`. Suites use these to run the real classifier and mechanism table against a recording
// transport instead of hand-rolling reply shapes that could drift from the wire. Each driver's
// measured replies live in its own `__fixtures__/capability-probe-replies.ts`; the transport takes
// that driver's default reply builder.

import type { DriverCapabilityFlag } from "@ai-sidekicks/contracts/provider/driver/driver";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/account/account";

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

/** The reply a provider gives one probe name when a test sets no override for it. */
export type DefaultProbeReply = (probeName: string) => unknown;

/** Per-name reply overrides. */
interface RecordingProbeTransportOptions {
  readonly replies?: Readonly<Record<string, unknown>>;
}

/** Records every probe dispatch and answers from `defaultReply`, or a per-name override. */
export class RecordingCapabilityProbeTransport {
  readonly requests: CapabilityProbeRequest[] = [];
  readonly #defaultReply: DefaultProbeReply;
  readonly #replies: Readonly<Record<string, unknown>>;

  constructor(defaultReply: DefaultProbeReply, options: RecordingProbeTransportOptions = {}) {
    this.#defaultReply = defaultReply;
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
    return this.#defaultReply(request.probeName);
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
