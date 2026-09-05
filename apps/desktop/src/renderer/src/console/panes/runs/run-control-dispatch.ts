// The six run controls' one chokepoint: guards threaded, keys minted, answers read.
//
// THIS MODULE'S OWN RULE, because no committed document states it: guard threading
// and idempotency-key minting are one chokepoint rather than a per-button
// convenience. Six buttons each assembling their own request would be six chances
// to omit a comparand or reuse a key across a changed body, and both of those are
// silent at the call site and loud on the wire.
//
// FIVE RULES, EACH STRUCTURAL HERE RATHER THAN CONVENTIONAL.
//
//   1. **Both guards, always.** `expectedRunVersion` is mandatory on every
//      intervention and on pause and resume alike; an absent comparand is rejected
//      rather than applied. This module takes the comparand as a REQUIRED argument
//      and mints `clientIdempotencyKey` itself, so neither can be forgotten.
//   2. **One key per body.** A key is minted per dispatch and never reused across a
//      changed body — reuse with a differing body is `intervention.idempotency_conflict`
//      (422), which is a refusal the caller earned rather than one to render around.
//   3. **The fresh comparand comes from the answer, reconciled against the stream.**
//      `InterventionResponseBase.runVersion` and `RunControlAck.runVersion` are
//      threaded back out on every settlement, because after an applied native steer
//      the response is the ONLY place the caller can read it — that advance emits no
//      state event. The run also advances through `run.subscribeState` without any
//      control being pressed, so neither reading is the freshest on its own and a
//      caller is answered with the NEWER of the two. That reconciliation lives here,
//      beside the map that holds the cache, because both callers ask for it and a
//      maximum written at two call sites would be two claims about one comparand.
//   4. **Eligibility is not projected.** Every control is dispatched and the
//      daemon's typed refusal is what renders. There is no role check, no
//      authorship check, and no state precondition anywhere in this file.
//   5. **Capability gating is a read, not a rule.** `steer` and `rollback` are
//      gated on the bound driver's declared flags, read from
//      `driver.listCapabilities`; pause, resume, interrupt, and cancel are
//      orchestration-layer and are never driver-gated. A gated control whose flag
//      is false is ABSENT, not disabled, on the absent-not-disabled discipline —
//      and a capability read that has not answered yet leaves both gated controls
//      absent, which is the fail-closed direction.
//
// WHAT THIS MODULE NEVER OFFERS. No reorder, no priority, no dequeue distinct from
// cancel, and no move-to-background: none of the four exists anywhere in the corpus.
// `Spec-023 §Signature Feature Composition Sketches`' Runs View strikes the first
// three in terms — "**Queue reorder is struck**: `Spec-004 §Resolved Questions and
// V1 Scope Decisions` defers queue priority overrides for V1 … the queue's only V1
// removal path is `run.queueCancel`." The fourth is this module's own refusal: no
// wire member anywhere backgrounds a run, so a control for it would be an offer the
// daemon could not answer.

import {
  InterventionRequestPayloadSchema,
  RunIdSchema,
  type InterventionRequestResponse,
  type RunControlAck,
} from "@ai-sidekicks/contracts";

import { normalizeWireRejection, refuse, type ConsoleRefusal } from "../../core/index.js";
import { callDaemon, type ConsoleBridge } from "../../bridge/index.js";

/** The subsystem name every refusal this module raises carries. */
export const RUN_CONTROL_REFUSAL_ORIGIN = "run-controls";

/**
 * The six controls, closed and declared once.
 *
 * `Spec-023 §Signature Feature Composition Sketches`' Runs View enumerates exactly
 * these six — "pause / resume on active runs (`run.pause` / `run.resume`); steer /
 * interrupt / cancel / **rollback** through the generic `run.intervene` dispatch".
 * `Spec-004 §Resolved Questions and V1 Scope Decisions`
 * enumerates five and omits `cancel`; `cancel` is nonetheless a first-class arm of
 * the registered `InterventionRequestPayload` union and is named in
 * `Spec-012 §Required Behavior`, so six is the correct reading and the omission is
 * an under-enumeration worth an erratum.
 */
export const RUN_CONTROLS = [
  "pause",
  "resume",
  "steer",
  "interrupt",
  "cancel",
  "rollback",
] as const;

/** One control. Derived from the tuple, never restated. */
export type RunControl = (typeof RUN_CONTROLS)[number];

/** What one settled dispatch says. */
export type RunControlOutcome =
  | { readonly kind: "acknowledged"; readonly control: RunControl; readonly ack: RunControlAck }
  | {
      readonly kind: "settled";
      readonly control: RunControl;
      readonly response: InterventionRequestResponse;
    }
  | { readonly kind: "refused"; readonly control: RunControl; readonly refusal: ConsoleRefusal };

/** What a rollback dispatch carries beyond the two mandatory guards. */
export interface RollbackRequest {
  readonly targetPosition: number;
  /**
   * Presence alone selects the atomic edit-and-resend composite and turns on its
   * four additional structural refusal guards. Absent is a bare rollback.
   */
  readonly replacementSend?: { readonly content: string } | undefined;
}

/** What a steer dispatch carries. */
export interface SteerRequest {
  readonly content: string;
}

/** The comparand every dispatch threads, plus the run it names. */
export interface RunControlTarget {
  readonly runId: string;
  readonly expectedRunVersion: number;
}

/**
 * The dispatcher.
 *
 * A class with private fields rather than a bag of callbacks: the freshest
 * comparand, the minted keys, and the recorded outcomes are one object's state, and
 * a hook closing over three `useState` setters would have made "thread the answer's
 * runVersion into the next request" a rule each button re-implemented.
 */
export class RunControlDispatcher {
  readonly #bridge: ConsoleBridge;
  readonly #mintIdempotencyKey: () => string;
  readonly #freshComparandByRunId = new Map<string, number>();

  public constructor(options: {
    readonly bridge: ConsoleBridge;
    /** Injected so a test pins the key; the default is the platform's own UUID. */
    readonly mintIdempotencyKey?: () => string;
  }) {
    this.#bridge = options.bridge;
    this.#mintIdempotencyKey = options.mintIdempotencyKey ?? (() => crypto.randomUUID());
  }

  /**
   * The comparand this dispatcher has read for a run off the daemon's own answers.
   *
   * Read from those answers and from nowhere else. This is one of the two readings
   * `comparandFor` reconciles, and callers that send a guard want that one.
   */
  public freshComparandFor(runId: string): number | undefined {
    return this.#freshComparandByRunId.get(runId);
  }

  /**
   * The comparand to send for a run: the newer of the daemon's last answer and the
   * reading the state stream currently carries.
   *
   * Both are wire figures and both are monotonic per run, so the larger is the
   * fresher. Preferring the cached one unconditionally would pin every later
   * control to the version the last settlement saw: the run advances through
   * `run.subscribeState` without any control being pressed, the row renders that
   * newer projection, and each guarded call would then be refused as stale with no
   * way back — a refusal carries no `runVersion`, so no failed control can refresh
   * the cache it was refused over.
   *
   * A caller with neither reading gets `undefined` and does not dispatch — never a
   * zero, which would be a guard the console invented.
   */
  public comparandFor(runId: string, streamReading: number): number;
  public comparandFor(runId: string, streamReading: number | undefined): number | undefined;
  public comparandFor(runId: string, streamReading: number | undefined): number | undefined {
    const cached = this.#freshComparandByRunId.get(runId);
    if (cached === undefined) {
      return streamReading;
    }
    if (streamReading === undefined) {
      return cached;
    }
    return Math.max(cached, streamReading);
  }

  /** Pause. `run.pause`, and never an intervention arm — the union has none. */
  public pause(target: RunControlTarget): Promise<RunControlOutcome> {
    return this.#dispatchControlVerb("pause", "run.pause", target);
  }

  /**
   * Resume. Never a reread and never a reattach: the Runs View sketch cited above
   * binds the word to `run.resume` on an active run, which is the verb that moves a
   * paused run back to running and no other.
   */
  public resume(target: RunControlTarget): Promise<RunControlOutcome> {
    return this.#dispatchControlVerb("resume", "run.resume", target);
  }

  public steer(target: RunControlTarget, request: SteerRequest): Promise<RunControlOutcome> {
    return this.#dispatchIntervention("steer", target, { content: request.content });
  }

  public interrupt(target: RunControlTarget, reason?: string): Promise<RunControlOutcome> {
    return this.#dispatchIntervention("interrupt", target, reason === undefined ? {} : { reason });
  }

  public cancel(target: RunControlTarget, reason?: string): Promise<RunControlOutcome> {
    return this.#dispatchIntervention("cancel", target, reason === undefined ? {} : { reason });
  }

  public rollback(target: RunControlTarget, request: RollbackRequest): Promise<RunControlOutcome> {
    return this.#dispatchIntervention("rollback", target, {
      targetPosition: request.targetPosition,
      ...(request.replacementSend === undefined
        ? {}
        : { replacementSend: { content: request.replacementSend.content } }),
    });
  }

  /** Pause and resume: one shape, one acknowledgment, one comparand threaded back. */
  async #dispatchControlVerb(
    control: RunControl,
    method: "run.pause" | "run.resume",
    target: RunControlTarget,
  ): Promise<RunControlOutcome> {
    const runId = RunIdSchema.safeParse(target.runId);
    if (!runId.success) {
      return this.#unparseableRun(control);
    }
    const reply = await callDaemon(this.#bridge, method, {
      targetRunId: runId.data,
      expectedRunVersion: target.expectedRunVersion,
    });
    if (reply.status === "refused") {
      return { kind: "refused", control, refusal: reply.refusal };
    }
    this.#freshComparandByRunId.set(target.runId, reply.value.runVersion);
    return { kind: "acknowledged", control, ack: reply.value };
  }

  /**
   * Steer, interrupt, cancel, rollback: one method, four arms.
   *
   * The ARM is built and parsed here rather than at the door, because the union's
   * discriminant decides which members are required and this is the only place that
   * knows which control was pressed. The door parses the whole request again before
   * sending it, which costs nothing and is what makes the parse unskippable; what
   * this parse buys is a refusal that names the CONTROL rather than the method.
   */
  async #dispatchIntervention(
    control: RunControl,
    target: RunControlTarget,
    arm: Readonly<Record<string, unknown>>,
  ): Promise<RunControlOutcome> {
    const runId = RunIdSchema.safeParse(target.runId);
    if (!runId.success) {
      return this.#unparseableRun(control);
    }
    const request = InterventionRequestPayloadSchema.safeParse({
      type: control,
      targetRunId: runId.data,
      expectedRunVersion: target.expectedRunVersion,
      clientIdempotencyKey: this.#mintIdempotencyKey(),
      ...arm,
    });
    if (!request.success) {
      return {
        kind: "refused",
        control,
        refusal: refuse(
          RUN_CONTROL_REFUSAL_ORIGIN,
          "request-unsendable",
          "The console could not build a request the daemon would accept for this control. Reopen the session so its identifiers and run version are read again.",
        ),
      };
    }
    const reply = await callDaemon(this.#bridge, "run.intervene", request.data);
    if (reply.status === "refused") {
      return { kind: "refused", control, refusal: reply.refusal };
    }
    this.#freshComparandByRunId.set(target.runId, reply.value.runVersion);
    return { kind: "settled", control, response: reply.value };
  }

  #unparseableRun(control: RunControl): RunControlOutcome {
    return {
      kind: "refused",
      control,
      refusal: refuse(
        RUN_CONTROL_REFUSAL_ORIGIN,
        "identifier-unparseable",
        "The console is holding a run identifier the daemon would not accept. Reopen the session so its identifiers are read again.",
      ),
    };
  }
}

/**
 * Carry a rejection through without paraphrasing it.
 *
 * The console's ONE reading of a rejected promise, consumed and not copied. Every
 * dispatch above reaches the wire through `callDaemon`, which normalizes its own
 * rejections; this one survives because the React binding's `perform` can reject
 * BEFORE the dispatcher runs at all, and one rejection deserves one reading.
 *
 * The code the daemon sent is the code a person sees; there is deliberately no
 * table here mapping a wire code onto console prose — `Spec-023 §Rules every console
 * surface obeys` has the renderer never pre-deny: "it calls, and renders the typed
 * refusal code with the daemon's message text and the operator's next move". Every
 * refusal these six controls can reach is registered
 * in `error-contracts.md` — `run.invalid_transition`, `run.not_found`,
 * `run.limit_exceeded`, `run.recovery_failed`,
 * `intervention.idempotency_conflict`, `auth.principal_mismatch` — and each travels
 * this one path.
 *
 */
export function carriedRunControlRefusal(
  control: RunControl,
  rejection: unknown,
): RunControlOutcome {
  return {
    kind: "refused",
    control,
    refusal: normalizeWireRejection(RUN_CONTROL_REFUSAL_ORIGIN, rejection, {
      code: "control-rejected",
      detail: `The ${control} control was rejected.`,
    }),
  };
}
