/**
 * Codex intervention dispatcher. `applyIntervention` routes a normalized intervention onto the
 * provider's native operation, or returns a `degraded` result the layer above can act on (an
 * unsupported type is data, not an exception).
 *
 * - `steer` is gated by the `steer` capability flag, read live at dispatch with `!== true` (as in
 *   `driver/registry.ts`); `interrupt` and `cancel` have no flag. Codex declares `steer: true`,
 *   so its degraded arm is reached only through an injected snapshot.
 * - `CodexInterventionRuntime` is a port `CodexLifecycleManager` satisfies, so this module stays
 *   testable against a fake.
 * - `clientIdempotencyKey` rides the wire unchanged where a field exists (`turn/steer` carries
 *   it as `clientUserMessageId`); `turn/interrupt` has none, and a minted key would defeat the
 *   `UNIQUE (target_run_id, client_idempotency_key)` dedupe on retry.
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
import type { RunId } from "@ai-sidekicks/contracts/provider/driver/intervention";
import {
  TEXT_NEUTRALIZATION_REFUSAL_CODE,
  type CallerDeclaredFrameOrigin,
} from "../../outbound-frame.js";
import { STEER_FALLBACK_ACTION } from "../contract.js";

/** Capability flag governing each intervention type; `null` means no flag gates it. */
const CODEX_INTERVENTION_CAPABILITY_FLAGS: Readonly<
  Record<ApplyInterventionParams["type"], DriverCapabilityFlag | null>
> = {
  steer: "steer",
  interrupt: null,
  cancel: null,
};

/** One steer, as handed to the runtime. */
export interface CodexSteerRunRequest {
  readonly runId: RunId;
  readonly content: string;
  /** Pins the steer to a turn; absent means the live turn, reported back as `targetedTurnId`. */
  readonly expectedTurnId?: string | undefined;
  /** The requester's key, placed on the wire unchanged. */
  readonly clientIdempotencyKey: string;
  /**
   * Why this text is written. Typed as the caller-declarable subset, so the tripwire-exempt origin
   * (which would skip the swallow check) cannot be named here.
   */
  readonly frameOrigin?: CallerDeclaredFrameOrigin | undefined;
}

/** What `turn/steer` acknowledged; both turn ids travel so a different turn can be told apart. */
export interface CodexSteerAcknowledgement {
  /** The turn the runtime actually put on the wire as `expectedTurnId`. */
  readonly targetedTurnId: string;
  /** The turn the provider's ack named, or `null` when the ack named none. */
  readonly acknowledgedTurnId: string | null;
}

/** The provider operations routed onto; `cancel` and `interrupt` share `interruptRun`. */
export interface CodexInterventionRuntime {
  steerRun(request: CodexSteerRunRequest): Promise<CodexSteerAcknowledgement>;
  interruptRun(params: InterruptRunParams): Promise<void>;
  /**
   * Whether the runtime has already ruled the turn's text swallowed. A read, never a wait, so
   * `refusalCode` is best-effort and the run's `run.failed` terminal remains the guarantee.
   */
  textNeutralizationDecisionForTurn(turnId: string): { readonly refused: boolean };
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
  textNeutralizationRefused: boolean,
): DriverInterventionResult {
  // Checked first: a swallowed steer can still get a matching ack. No `fallbackAction`, since
  // re-queueing the same text fails the same way.
  if (textNeutralizationRefused) {
    return { status: "degraded", refusalCode: TEXT_NEUTRALIZATION_REFUSAL_CODE };
  }
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
        const acknowledgement = await this.#runtime.steerRun({
          runId: params.targetRunId,
          content: params.payload.content,
          expectedTurnId: params.payload.expectedTurnId,
          clientIdempotencyKey: params.clientIdempotencyKey,
          frameOrigin: "human_text",
        });
        // Asked about the turn that went on the wire, not the caller's hint.
        return normalizeSteerAcknowledgement(
          acknowledgement,
          this.#runtime.textNeutralizationDecisionForTurn(acknowledgement.targetedTurnId).refused,
        );
      }
      // Cancel is the same wire operation as interrupt; the daemon differs in what it does with
      // the run after.
      case "interrupt":
      case "cancel": {
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
