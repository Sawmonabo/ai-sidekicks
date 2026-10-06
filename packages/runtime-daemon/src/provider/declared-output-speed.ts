// The output-speed state a provider declares, read into the contract's held shape the same way on
// every driver (bounded by the contract and never by a vocabulary, absent when the bounds refuse),
// and the per-run report of the state each run runs at.

import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import {
  ProviderOutputSpeedStateSchema,
  type ProviderOutputSpeedState,
} from "@ai-sidekicks/contracts/provider/driver/output-speed";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DriverDiagnosticsEmitter } from "./driver/diagnostics.js";

/** One declaration as the provider made it: the state, and its reason or `null` if it gave none. */
export interface DeclaredOutputSpeed {
  readonly provider: ProviderName;
  readonly sessionId: SessionId;
  readonly declared: unknown;
  readonly reason: string | null;
}

/**
 * The held state for one declaration, carried verbatim, so a level no vocabulary lists is kept
 * rather than coerced. A declaration the contract's bounds refuse reads as absent, with an
 * `output_speed_state_rejected` diagnostic naming the failing field and lengths, never the values.
 */
export function readDeclaredOutputSpeed(
  declaration: DeclaredOutputSpeed,
  diagnostics: DriverDiagnosticsEmitter,
): ProviderOutputSpeedState | undefined {
  const { declared, reason } = declaration;
  const parsed = ProviderOutputSpeedStateSchema.safeParse({
    declared,
    ...(reason === null ? {} : { reason }),
  });
  if (parsed.success) {
    return parsed.data;
  }
  diagnostics.emit({
    provider: declaration.provider,
    kind: "output_speed_state_rejected",
    rawWireType: null,
    dispositionReason:
      "the provider declared an output-speed state the contract's own bounds refuse; this " +
      "binding reads as having no observation until it declares another",
    details: {
      sessionId: declaration.sessionId,
      rejectedField: parsed.error.issues[0]?.path.join(".") ?? "",
      declaredLength: typeof declared === "string" ? declared.length : null,
      reasonLength: reason === null ? null : reason.length,
    },
  });
  return undefined;
}

/**
 * Receives, once per run, the declared output-speed state that run runs at, read once the run's
 * carrier has settled; the run engine compares it with the level the run carried.
 */
export type RunOutputSpeedSettledListener = (
  sessionId: SessionId,
  runId: RunId,
  state: ProviderOutputSpeedState,
) => void;
