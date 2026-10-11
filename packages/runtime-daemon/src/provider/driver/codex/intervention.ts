/**
 * Codex intervention dispatcher. `applyIntervention` routes a normalized intervention onto the
 * provider's native operation: a steer, the delivery of a message the run queue held, onto
 * `turn/steer` with its picked skills and staged files, and an interrupt onto `turn/interrupt`.
 *
 * - `CodexInterventionRuntime` is a port `CodexLifecycleManager` satisfies, so this module stays
 *   testable against a fake.
 * - `clientIdempotencyKey` rides the wire unchanged where a field exists (`turn/steer` carries
 *   it as `clientUserMessageId`); `turn/interrupt` has none, and a minted key would defeat the
 *   `UNIQUE (target_run_id, client_idempotency_key)` dedupe on retry.
 * - `turn/steer` answers `{ turnId }`, so `applied` requires the targeted turn, and an answer
 *   naming another turn or none is `degraded`; `turn/interrupt` answers an empty object, so no
 *   JSON-RPC error is the only evidence. No shape check: the wire is additive, and a new member
 *   must not degrade every interrupt.
 */

import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import type {
  DriverInterventionResult,
  InterruptRunParams,
} from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { ApplyInterventionParams, PickedSkill } from "../run-control.js";

/** One steer, as handed to the runtime. */
export interface CodexSteerRunRequest {
  readonly runId: RunId;
  readonly content: string;
  /** The skills picked for the message, in the order picked. */
  readonly skills: readonly PickedSkill[] | undefined;
  /** The message's staged files, in staging order. */
  readonly attachments: readonly ArtifactId[] | undefined;
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

// `params: never` stops compiling when `ApplyInterventionParams` gains an arm.
function degradeUnroutedInterventionType(params: never): DriverInterventionResult {
  void params;
  return { status: "degraded" };
}

// A mismatched or missing acknowledged turn degrades: neither shows the targeted turn was steered.
function normalizeSteerAcknowledgement(
  acknowledgement: CodexSteerAcknowledgement,
): DriverInterventionResult {
  return acknowledgement.acknowledgedTurnId === acknowledgement.targetedTurnId
    ? { status: "applied" }
    : { status: "degraded" };
}

/** Routes normalized interventions onto Codex's native operations. */
export class CodexInterventionDispatcher {
  readonly #runtime: CodexInterventionRuntime;

  constructor(runtime: CodexInterventionRuntime) {
    this.#runtime = runtime;
  }

  /**
   * Routes one intervention onto its native operation and answers `applied`, or `degraded` for a
   * steer Codex acknowledged on another turn or none. Transport, run-state and file-binding
   * failures throw.
   */
  async applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult> {
    switch (params.type) {
      case "steer": {
        const acknowledgement = await this.#runtime.steerRun({
          runId: params.targetRunId,
          content: params.payload.content,
          skills: params.payload.skills,
          attachments: params.payload.attachments,
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
        return { status: "applied" };
      }
      default: {
        return degradeUnroutedInterventionType(params);
      }
    }
  }
}
