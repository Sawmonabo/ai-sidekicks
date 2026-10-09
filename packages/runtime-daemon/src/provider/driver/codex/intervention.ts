/**
 * Codex intervention dispatcher. `applyIntervention` routes a normalized intervention onto the
 * provider's native operation, or returns a `degraded` result the layer above can act on (an
 * unsupported type is data, not an exception).
 *
 * - `steer` is gated by the `steer` capability flag, read live at dispatch with `!== true` (as in
 *   `driver/registry.ts`); `interrupt` has no flag. Codex declares `steer: true`, so its degraded
 *   arm is reached only through an injected snapshot.
 * - `CodexInterventionRuntime` is a port `CodexLifecycleManager` satisfies, so this module stays
 *   testable against a fake.
 * - `clientIdempotencyKey` rides the wire unchanged where a field exists (`turn/steer` carries
 *   it as `clientUserMessageId`); `turn/interrupt` has none, and a minted key would defeat the
 *   `UNIQUE (target_run_id, client_idempotency_key)` dedupe on retry.
 * - A steer carrying attachments throws `DriverCapabilityUnsupportedError`.
 * - `turn/steer` answers `{ turnId }`, so `applied` requires the targeted turn; `turn/interrupt`
 *   answers an empty object, so no JSON-RPC error is the only evidence. No shape check: the wire is
 *   additive, and a new member must not degrade every interrupt.
 */

import type {
  DriverCapabilities,
  DriverCapabilityFlag,
} from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type {
  ApplyInterventionParams,
  DriverInterventionResult,
  InterruptRunParams,
} from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import { CODEX_DRIVER_NAME } from "./capabilities.js";
import { STEER_FALLBACK_ACTION } from "../contract.js";
import { DriverCapabilityUnsupportedError } from "../registry.js";

/** Capability flag governing each intervention type; `null` means no flag gates it. */
const CODEX_INTERVENTION_CAPABILITY_FLAGS: Readonly<
  Record<ApplyInterventionParams["type"], DriverCapabilityFlag | null>
> = {
  steer: "steer",
  interrupt: null,
};

/** One steer, as handed to the runtime. */
export interface CodexSteerRunRequest {
  readonly runId: RunId;
  readonly content: string;
  /** Pins the steer to a turn; absent means the live turn, reported back as `targetedTurnId`. */
  readonly expectedTurnId?: string | undefined;
  /** The requester's key, placed on the wire unchanged. */
  readonly clientIdempotencyKey: string;
}

/** What `turn/steer` acknowledged; both turn ids travel so a different turn can be told apart. */
export interface CodexSteerAcknowledgement {
  /** The turn the runtime actually put on the wire as `expectedTurnId`. */
  readonly targetedTurnId: string;
  /** The turn the provider's ack named, or `null` when the ack named none. */
  readonly acknowledgedTurnId: string | null;
}

/** The provider operations the dispatcher routes onto. */
export interface CodexInterventionRuntime {
  steerRun(request: CodexSteerRunRequest): Promise<CodexSteerAcknowledgement>;
  interruptRun(params: InterruptRunParams): Promise<void>;
}

/** Reads the live capability snapshot; injected so a refreshed record is honored. */
export type CodexCapabilitySnapshotReader = () => DriverCapabilities;

/** Construction inputs for the dispatcher. */
export interface CodexInterventionOptions {
  readonly runtime: CodexInterventionRuntime;
  readonly readCapabilities: CodexCapabilitySnapshotReader;
}

// `params: never` stops compiling when `ApplyInterventionParams` gains an arm. No
// `fallbackAction`: `queue_and_interrupt` remedies a missing steer, not an unknown type.
function degradeUnroutedInterventionType(params: never): DriverInterventionResult {
  void params;
  return { status: "degraded" };
}

// A mismatched or missing acknowledged turn degrades: neither shows the targeted turn was steered.
function normalizeSteerAcknowledgement(
  acknowledgement: CodexSteerAcknowledgement,
): DriverInterventionResult {
  if (acknowledgement.acknowledgedTurnId === acknowledgement.targetedTurnId) {
    return { status: "applied" };
  }
  return { status: "degraded", fallbackAction: STEER_FALLBACK_ACTION };
}

/** Routes normalized interventions onto Codex's native operations, or degrades them. */
export class CodexInterventionDispatcher {
  readonly #runtime: CodexInterventionRuntime;
  readonly #readCapabilities: CodexCapabilitySnapshotReader;

  constructor(options: CodexInterventionOptions) {
    this.#runtime = options.runtime;
    this.#readCapabilities = options.readCapabilities;
  }

  /**
   * Routes one intervention: `degraded` when the governing capability is not `true`, else the
   * native operation and `applied`. Transport and run-state failures throw.
   */
  async applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult> {
    const requiredFlag = CODEX_INTERVENTION_CAPABILITY_FLAGS[params.type];
    if (requiredFlag !== null && !this.#isDeclaredSupported(requiredFlag)) {
      return { status: "degraded", fallbackAction: STEER_FALLBACK_ACTION };
    }

    switch (params.type) {
      case "steer": {
        // Staged files are not handed to Codex yet, so a steer carrying them is refused whole
        // rather than sent without them.
        if ((params.payload.attachments ?? []).length > 0) {
          throw new DriverCapabilityUnsupportedError(CODEX_DRIVER_NAME, "steer");
        }
        const acknowledgement = await this.#runtime.steerRun({
          runId: params.targetRunId,
          content: params.payload.content,
          expectedTurnId: params.payload.expectedTurnId,
          clientIdempotencyKey: params.clientIdempotencyKey,
        });
        return normalizeSteerAcknowledgement(acknowledgement);
      }
      case "interrupt": {
        await this.#runtime.interruptRun({
          runId: params.targetRunId,
          ...(params.payload.reason === undefined ? {} : { reason: params.payload.reason }),
        });
        break;
      }
      default: {
        return degradeUnroutedInterventionType(params);
      }
    }

    return { status: "applied" };
  }

  #isDeclaredSupported(flag: DriverCapabilityFlag): boolean {
    return this.#readCapabilities().flags[flag] === true;
  }
}
