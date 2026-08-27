// Codex driver — intervention dispatcher (Plan-005 Phase 3, T3.2).
//
// One generic entry point, `applyIntervention`, routes a normalized intervention
// onto the provider's native operation OR returns a structured `degraded` result
// the orchestration layer can act on. It never throws to signal "unsupported" —
// per ADR-011 an unsupported intervention type is DATA (`{ status: 'degraded',
// fallbackAction }`), not an exception, because the layer above has to choose a
// fallback and an exception carries no choice.
//
// ---------------------------------------------------------------------------
// I-005-4 — the capability gate
// ---------------------------------------------------------------------------
//
// The intervention type is mapped to the capability flag that governs it, and the
// flag is read from the LIVE capability snapshot at dispatch time:
//
//   steer     -> the `steer` flag
//   interrupt -> (none)
//   cancel    -> (none)
//
// `interrupt` and `cancel` map to NO flag deliberately. `DRIVER_CAPABILITY_FLAGS`
// registers no interrupt/cancel member, and inventing a gate on a flag that does
// not exist would fail closed on every driver forever. Stopping an in-flight turn
// is a core obligation of the driver contract, not an optional capability.
//
// The gate is `!== true`, matching `provider-registry.ts`: a flag that is `false`
// AND a flag that is missing are both "unsupported" (I-005-2). A capability is
// supported only when explicitly declared `true`.
//
// Codex declares `steer: true`, so its degraded arm is unreachable in production
// wiring — but it is reachable, and tested, through the injected snapshot. The
// production-live degraded path is the Claude leg (T3.7), where `steer` is
// `false`; both legs share this dispatcher's shape.
//
// ---------------------------------------------------------------------------
// Why the runtime arrives as a port
// ---------------------------------------------------------------------------
//
// `CodexInterventionRuntime` is a structural port satisfied by
// `CodexLifecycleManager`. The dispatcher does not import the manager: the two
// are composed in `index.ts`, which keeps the module graph acyclic (the manager
// routes steering INTO this dispatcher's neighbour operations) and lets the
// dispatcher be tested against a three-method fake rather than a live transport.
//
// Result shapes are produced through `DriverInterventionResultSchema.parse`, so
// the `.strict()` envelope is enforced mechanically rather than asserted. The
// `applied` arm OMITS `fallbackAction` entirely rather than passing `undefined` —
// under `exactOptionalPropertyTypes` those are different values, and a strict
// object should not carry a key whose meaning is "no fallback applies".
//
// Spec coverage: `Spec-005 §Required Behavior` (the generic intervention
// dispatcher and its degraded fallback); ADR-011 (capability flags + intervention
// modeling).
//
// Refs: Plan-005 §Phase 3 / T3.2, `Spec-005 §Required Behavior`, invariant
// I-005-4 (and I-005-2 for the fail-closed read), ADR-011.

import {
  DriverInterventionResultSchema,
  type ApplyInterventionParams,
  type DriverCapabilities,
  type DriverCapabilityFlag,
  type DriverInterventionResult,
  type InterruptRunParams,
  type InterventionType,
  type RunId,
} from "@ai-sidekicks/contracts";

/**
 * The fallback the orchestration layer performs when a native intervention is
 * unavailable: hold the participant's directive and interrupt the turn, so the
 * directive is applied at the next boundary instead of being lost.
 */
export const CODEX_INTERVENTION_FALLBACK_ACTION: string = "queue_and_interrupt";

/**
 * Capability flag governing each intervention type this driver dispatches.
 *
 * A closed record over the three-armed `ApplyInterventionParams` union. `null`
 * means "no flag gates this type" (see the header). `rollback` is a member of
 * `InterventionType` but NOT of the params union — it travels through
 * `rollbackTo`, so it is absent here by construction rather than by omission.
 */
export const CODEX_INTERVENTION_CAPABILITY_FLAGS: Readonly<
  Record<Exclude<InterventionType, "rollback">, DriverCapabilityFlag | null>
> = {
  steer: "steer",
  interrupt: null,
  cancel: null,
};

/**
 * The provider operations this dispatcher routes onto.
 *
 * Structurally satisfied by `CodexLifecycleManager`; declared here so the
 * dispatcher depends on the three calls it makes rather than on the manager.
 */
export interface CodexInterventionRuntime {
  steerRun(runId: RunId, content: string, expectedTurnId?: string): Promise<void>;
  interruptRun(params: InterruptRunParams): Promise<void>;
}

/** Reads the live capability snapshot. Injected — `capabilities.ts` is T3.3's file. */
export type CodexCapabilitySnapshotReader = () => DriverCapabilities;

/** Construction inputs for the dispatcher. */
export interface CodexInterventionOptions {
  readonly runtime: CodexInterventionRuntime;
  readonly readCapabilities: CodexCapabilitySnapshotReader;
}

/** Generic intervention dispatcher for the Codex driver. */
export class CodexInterventionDispatcher {
  readonly #runtime: CodexInterventionRuntime;
  readonly #readCapabilities: CodexCapabilitySnapshotReader;

  constructor(options: CodexInterventionOptions) {
    this.#runtime = options.runtime;
    this.#readCapabilities = options.readCapabilities;
  }

  /**
   * Routes one intervention. Returns `degraded` when the governing capability is
   * not declared `true`; otherwise performs the native operation and returns
   * `applied`.
   *
   * Transport and run-state failures still THROW. Degraded means "this provider
   * cannot do this kind of thing"; a provider that can do it and failed is a
   * different condition, and flattening the two would tell the orchestration
   * layer to run a fallback for what is really an outage.
   */
  async applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult> {
    const requiredFlag = CODEX_INTERVENTION_CAPABILITY_FLAGS[params.type];
    if (requiredFlag !== null && !this.#isDeclaredSupported(requiredFlag)) {
      return DriverInterventionResultSchema.parse({
        status: "degraded",
        fallbackAction: CODEX_INTERVENTION_FALLBACK_ACTION,
      });
    }

    switch (params.type) {
      case "steer": {
        await this.#runtime.steerRun(
          params.targetRunId,
          params.payload.content,
          params.payload.expectedTurnId,
        );
        break;
      }
      case "interrupt": {
        await this.#runtime.interruptRun({
          runId: params.targetRunId,
          ...(params.payload.reason === undefined ? {} : { reason: params.payload.reason }),
        });
        break;
      }
      case "cancel": {
        // Codex exposes ONE turn-stopping operation. Interrupt and cancel differ
        // in what the DAEMON does with the run afterwards (resumable pause vs.
        // terminal cancellation), not in what the provider is asked to do, so
        // both route here and the run-state distinction stays daemon-side.
        await this.#runtime.interruptRun({
          runId: params.targetRunId,
          ...(params.payload.reason === undefined ? {} : { reason: params.payload.reason }),
        });
        break;
      }
    }

    // `applied` carries no `fallbackAction` key at all — see the header note.
    return DriverInterventionResultSchema.parse({ status: "applied" });
  }

  #isDeclaredSupported(flag: DriverCapabilityFlag): boolean {
    return this.#readCapabilities().flags[flag] === true;
  }
}
