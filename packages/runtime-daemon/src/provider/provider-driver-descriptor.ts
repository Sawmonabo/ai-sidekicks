// The static half of a provider driver: the facts the daemon needs before any session exists,
// declared once per provider. The live half, what a running driver does, is `ProviderDriver`.
//
// A descriptor names no other provider and holds no session state, so shared code reads one
// through `PROVIDER_DRIVER_DESCRIPTORS[providerName]` and never branches on a provider's name.

import type {
  CapabilityProbeChannel,
  DriverCapabilityDetectionTable,
  ProbeAnswer,
} from "./capability-probe.js";

/**
 * What a version handshake reply says: the provider's own version text, or the reply text that
 * carried none, which the version gate reports as unparseable.
 */
export type ReportedVersionReading =
  | { readonly version: string }
  | { readonly unreadableReply: string };

/** One provider's static facts, the ones the daemon reads before or without a session. */
export interface ProviderDriverDescriptor {
  /** How each capability flag is decided, total over the flag set. */
  readonly capabilityDetectionTable: DriverCapabilityDetectionTable;
  /** The request surface every capability probe of this provider rides. */
  readonly capabilityProbeChannel: CapabilityProbeChannel;
  /**
   * A deliberately unsupported name the probe channel must still refuse; a channel that answered
   * it would report every capability available. Dispatched only when a probe exists.
   */
  readonly capabilityProbeNegativeControl: string;
  /**
   * Wire names no probe may issue, screened when the table is read and at every dispatch: each
   * would mutate a session or start a turn, breaking the never-started session that keeps probes
   * non-mutating.
   */
  readonly capabilityProbeProhibitedNames: readonly string[];
  /** Reads one probe reply about `probeName`; only a name-level refusal is `unknown-name`. */
  readonly classifyCapabilityProbeReply: (payload: unknown, probeName: string) => ProbeAnswer;
  /** The oldest CLI build accepted, a floor and not a pin, compared with the in-band reading. */
  readonly cliVersionFloor: string;
  /**
   * Reads the version out of the zero-turn version handshake's reply. `clientName` is the client
   * name the daemon sent at that handshake. Throws only for a daemon fault in its arguments.
   */
  readonly readReportedVersion: (payload: unknown, clientName: string) => ReportedVersionReading;
  /**
   * The environment that keeps the provider from updating itself, applied last on every spawn: a
   * build that updates mid-session makes the recorded version and the admitted capability
   * snapshot describe a process no longer running. Empty when the provider documents none.
   */
  readonly autoUpdateOptOutEnvironment: Readonly<Record<string, string>>;
  /**
   * The output-speed levels a caller may request. Empty is a declaration, the complete one a
   * `false` `output_speed` flag implies. A constant of the driver, so no cache stores it and both
   * the live declaration and the cold-start hydrate read this one list. A provider can report
   * more states than it accepts; `ProviderOutputSpeedState.declared` carries those verbatim.
   */
  readonly outputSpeedLevels: readonly string[];
  /**
   * The provider's own tools, in the names a person picks for an agent's allowlist. A constant of
   * the driver, composed onto every capability report and never stored.
   */
  readonly builtInTools: readonly string[];
}
