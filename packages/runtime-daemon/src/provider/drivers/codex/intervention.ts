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
// dispatcher be tested against a two-method fake rather than a live transport.
//
// Result shapes are produced through `DriverInterventionResultSchema.parse`, so
// the `.strict()` envelope is enforced mechanically rather than asserted. The
// `applied` arm OMITS `fallbackAction` entirely rather than passing `undefined` —
// under `exactOptionalPropertyTypes` those are different values, and a strict
// object should not carry a key whose meaning is "no fallback applies".
//
// ---------------------------------------------------------------------------
// P0-3 — the caller's idempotency key rides the wire, and is never re-minted
// ---------------------------------------------------------------------------
//
// `ApplyInterventionParams` carries the REQUESTER's `clientIdempotencyKey` on
// every arm, and the daemon's `interventions` UNIQUE guard is what turns
// at-least-once delivery into exactly-once application. The driver's obligation
// is therefore as much negative as positive: carry the caller's key verbatim
// where the pinned wire has a home for it, and mint NOTHING where it does not.
//
//   steer            -> `turn/steer` carries it as `clientUserMessageId`.
//   interrupt/cancel -> `turn/interrupt` is `{ threadId, turnId }` at the pin and
//                       accepts no client-supplied id, so nothing is sent. A
//                       substitute minted here would hand the provider a fresh
//                       value on every retry and defeat the dedupe the key exists
//                       for, which is strictly worse than sending none.
//
// ---------------------------------------------------------------------------
// P3-1 — an ambiguous acknowledgement never reads as success
// ---------------------------------------------------------------------------
//
// The two operations this dispatcher routes onto acknowledge in different
// currencies, so they are graded separately rather than through one shared
// "did it throw" test:
//
//   `turn/steer`     answers `{ turnId }` — POSITIVE evidence naming the turn the
//                    steer landed on. `applied` therefore requires that the named
//                    turn be the turn the driver targeted. An ack naming a
//                    DIFFERENT turn, or naming none, is the provider having
//                    accepted something; it is not evidence that it accepted
//                    this, so it degrades.
//   `turn/interrupt` answers an empty object — the pinned response carries no
//                    payload to inspect, so the ABSENCE of a JSON-RPC error is
//                    the whole of the available evidence, and is sufficient. No
//                    shape check is applied to it deliberately: the wire is
//                    additive across releases, and a check that degraded every
//                    interrupt the day the provider added a member to that
//                    response would fail on a change that took nothing away.
//
// Spec coverage: `Spec-005 §Required Behavior` (the generic intervention
// dispatcher and its degraded fallback; idempotency-key ride-through); ADR-011
// (capability flags + intervention modeling).
//
// Refs: Plan-005 §Phase 3 / T3.2 + T3.14 (P0-3, P3-1), `Spec-005 §Required
// Behavior`, invariant I-005-4 (and I-005-2 for the fail-closed read), ADR-011.

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
 * One steer, as handed to the runtime.
 *
 * An object rather than the positional triple it replaces: the caller's
 * idempotency key is a fourth value that must not be confused with the two
 * strings beside it, and a positional `string` in third or fourth place is
 * exactly the shape a transposed argument slips through.
 */
export interface CodexSteerRunRequest {
  readonly runId: RunId;
  readonly content: string;
  /**
   * Pins the steer to a specific turn. Absent means "whichever turn is live",
   * which the runtime resolves — and reports back as `targetedTurnId`, so the
   * comparison below is against what actually went on the wire.
   */
  readonly expectedTurnId?: string | undefined;
  /**
   * The REQUESTER's key (P0-3), placed on the wire unchanged and never re-minted
   * at this boundary. See the header.
   */
  readonly clientIdempotencyKey: string;
}

/**
 * What the provider's `turn/steer` acknowledgement asserted.
 *
 * Both sides of the comparison travel because the comparison is the point: the
 * dispatcher must be able to tell "the provider confirmed the turn we targeted"
 * from "the provider acknowledged something".
 */
export interface CodexSteerAcknowledgement {
  /** The turn the runtime actually put on the wire as `expectedTurnId`. */
  readonly targetedTurnId: string;
  /** The turn the provider's ack named, or `null` when the ack named none. */
  readonly acknowledgedTurnId: string | null;
}

/**
 * The provider operations this dispatcher routes onto.
 *
 * Structurally satisfied by `CodexLifecycleManager`; declared here so the
 * dispatcher depends on the two operations it calls rather than on the manager.
 * Two, not three: `cancel` and `interrupt` share `interruptRun` (see the arm).
 *
 * `steerRun` returns its acknowledgement because P3-1 grades it; `interruptRun`
 * returns `void` because the pinned `turn/interrupt` response has no payload to
 * grade, and because it is `ProviderDriver.interruptRun` — widening a contract
 * operation's return type to serve one caller would be the dispatcher setting
 * the driver's public surface.
 */
export interface CodexInterventionRuntime {
  steerRun(request: CodexSteerRunRequest): Promise<CodexSteerAcknowledgement>;
  interruptRun(params: InterruptRunParams): Promise<void>;
}

/** Reads the live capability snapshot. Injected — `capabilities.ts` is T3.3's file. */
export type CodexCapabilitySnapshotReader = () => DriverCapabilities;

/** Construction inputs for the dispatcher. */
export interface CodexInterventionOptions {
  readonly runtime: CodexInterventionRuntime;
  readonly readCapabilities: CodexCapabilitySnapshotReader;
}

/**
 * Type-level backstop for an intervention type this switch does not route.
 *
 * `params: never` is the whole mechanism: the day `ApplyInterventionParams`
 * grows an arm, this call stops compiling, and the arm cannot reach the
 * `applied` return by falling through. Unreachable at runtime today -- the
 * capability gate degrades an unmapped type before the switch is entered -- so
 * this buys the COMPILE-time guarantee the gate cannot give.
 *
 * Degrades rather than throwing, per I-005-4. It names NO `fallbackAction`:
 * `queue_and_interrupt` is the documented fallback for a missing native steer,
 * and asserting it for a type nothing here knows anything about would put a verb
 * into the daemon's mouth. Mirrors the Claude leg's arm of the same name.
 */
function degradeUnroutedInterventionType(params: never): DriverInterventionResult {
  void params;
  return DriverInterventionResultSchema.parse({ status: "degraded" });
}

/**
 * Grades a steer acknowledgement into the single normalized outcome (P3-1).
 *
 * The mismatch and the named-nothing cases collapse into one degraded answer on
 * purpose: both mean the driver holds no evidence that the turn it targeted was
 * steered, and the daemon's remedy is the same for either — queue the directive
 * and interrupt, so it lands at the next boundary rather than being reported
 * applied to a turn that never saw it.
 */
function normalizeSteerAcknowledgement(
  acknowledgement: CodexSteerAcknowledgement,
): DriverInterventionResult {
  if (acknowledgement.acknowledgedTurnId === acknowledgement.targetedTurnId) {
    return DriverInterventionResultSchema.parse({ status: "applied" });
  }
  return DriverInterventionResultSchema.parse({
    status: "degraded",
    fallbackAction: CODEX_INTERVENTION_FALLBACK_ACTION,
  });
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
        return normalizeSteerAcknowledgement(
          await this.#runtime.steerRun({
            runId: params.targetRunId,
            content: params.payload.content,
            expectedTurnId: params.payload.expectedTurnId,
            clientIdempotencyKey: params.clientIdempotencyKey,
          }),
        );
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
      default: {
        return degradeUnroutedInterventionType(params);
      }
    }

    // Reached by the interrupt and cancel arms only — the steer arm returns its
    // graded acknowledgement above. `turn/interrupt` resolving without a
    // JSON-RPC error IS the evidence for those two (P3-1, header). `applied`
    // carries no `fallbackAction` key at all — see the header note.
    return DriverInterventionResultSchema.parse({ status: "applied" });
  }

  #isDeclaredSupported(flag: DriverCapabilityFlag): boolean {
    return this.#readCapabilities().flags[flag] === true;
  }
}
