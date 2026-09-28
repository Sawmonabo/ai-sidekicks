// The run controls' one chokepoint: guards threaded, keys minted, answers read.
//
// Guard threading and key minting live here rather than in each button. A button that
// assembled its own request could omit a comparand or reuse a key across a changed
// body, and both fail silently at the call site and loudly on the wire.
//
//   1. Both guards, always. `expectedRunVersion` is required on every intervention and
//      on pause and resume alike; an absent one is rejected, not applied. Steer and
//      interrupt also get a `clientIdempotencyKey` minted per dispatch, never reused
//      across a changed body (that is `intervention.idempotency_conflict`).
//   2. The fresh comparand comes from the answer, reconciled against the state stream.
//      An applied native steer advances the run with no state event, and the run also
//      advances with no control pressed, so neither reading is freshest alone; the
//      caller gets the newer, and that maximum is taken once, beside the cache.
//   3. Eligibility is not projected. Every control is dispatched and the daemon's typed
//      refusal is what renders: no role, authorship or state check lives here.
//   4. Capability gating is a read. Steer is gated on the bound driver's declared flag;
//      pause, resume and interrupt never are. A gated control whose flag is false, or
//      not yet read, is absent rather than disabled.
//
// Nothing here reorders the queue, sets a priority, dequeues apart from cancel, or
// backgrounds a run: no wire member exists for any of them.

import type { InterventionRequestResponse, RunControlAck } from "@ai-sidekicks/contracts";

import { normalizeWireRejection, refuse, type ConsoleRefusal } from "../../../core/index.js";
import {
  callDaemon,
  readInterventionRequest,
  readRunId,
  type ConsoleBridge,
} from "../../../bridge/index.js";

/** The subsystem name every refusal this module raises carries. */
export const RUN_CONTROL_REFUSAL_ORIGIN = "run-controls";

/**
 * The controls, closed and declared once: pause and resume on an active run
 * (`run.pause`, `run.resume`), and steer and interrupt through the generic
 * `run.intervene` dispatch.
 */
export const RUN_CONTROLS = ["pause", "resume", "steer", "interrupt"] as const;

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

  /** Resume. `run.resume` moves a paused run back to running and does nothing else. */
  public resume(target: RunControlTarget): Promise<RunControlOutcome> {
    return this.#dispatchControlVerb("resume", "run.resume", target);
  }

  public steer(target: RunControlTarget, request: SteerRequest): Promise<RunControlOutcome> {
    return this.#dispatchIntervention("steer", target, { content: request.content });
  }

  public interrupt(target: RunControlTarget, reason?: string): Promise<RunControlOutcome> {
    return this.#dispatchIntervention("interrupt", target, reason === undefined ? {} : { reason });
  }

  /** Pause and resume: one shape, one acknowledgment, one comparand threaded back. */
  async #dispatchControlVerb(
    control: "pause" | "resume",
    method: "run.pause" | "run.resume",
    target: RunControlTarget,
  ): Promise<RunControlOutcome> {
    const runId = readRunId(target.runId);
    if (runId === undefined) {
      return this.#unparseableRun(control);
    }
    const reply = await callDaemon(this.#bridge, method, {
      targetRunId: runId,
      expectedRunVersion: target.expectedRunVersion,
    });
    if (reply.status === "refused") {
      return { kind: "refused", control, refusal: reply.refusal };
    }
    this.#freshComparandByRunId.set(target.runId, reply.value.runVersion);
    return { kind: "acknowledged", control, ack: reply.value };
  }

  /**
   * Steer and interrupt: one method, two arms.
   *
   * The ARM is built and READ here rather than at the door, because the union's
   * discriminant decides which members are required and this is the only place that
   * knows which control was pressed. The door parses the whole request again before
   * sending it, which costs nothing and is what makes the parse unskippable; what
   * this reading buys is a refusal that names the CONTROL rather than the method.
   * The reader is the bridge family's — a schema is the wire's and is imported at the
   * wire's edge, so this pane consumes a typed answer and never a validator.
   */
  async #dispatchIntervention(
    control: RunControl,
    target: RunControlTarget,
    arm: Readonly<Record<string, unknown>>,
  ): Promise<RunControlOutcome> {
    const runId = readRunId(target.runId);
    if (runId === undefined) {
      return this.#unparseableRun(control);
    }
    const request = readInterventionRequest({
      type: control,
      targetRunId: runId,
      expectedRunVersion: target.expectedRunVersion,
      clientIdempotencyKey: this.#mintIdempotencyKey(),
      ...arm,
    });
    if (request === undefined) {
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
    const reply = await callDaemon(this.#bridge, "run.intervene", request);
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
 * The code the daemon sent is the code a person sees; there is deliberately no table
 * here mapping a wire code onto console prose. The renderer never pre-denies: it calls,
 * and renders the typed refusal code with the daemon's message text and the operator's
 * next move. Every refusal these controls can reach is registered in
 * `error-contracts.md` — `run.invalid_transition`, `run.not_found`,
 * `run.limit_exceeded`, `run.recovery_failed`, `intervention.idempotency_conflict`,
 * `auth.principal_mismatch` — and each travels this one path.
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
