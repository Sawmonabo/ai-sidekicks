// The run controls' one chokepoint: guards threaded, keys minted, answers read.
//
// Guard threading and key minting live here rather than in each button. A button that
// assembled its own request could omit a comparand or reuse a key across a changed
// body, and both fail silently at the call site and loudly on the wire.
//
//   1. Every request carries `expectedRunVersion`, taken from the target the caller passes
//      (`RunControlTarget` types it as a required number). Steer and interrupt also carry
//      a `clientIdempotencyKey` minted here per dispatch and never reused across a
//      changed body.
//   2. The fresh comparand comes from the answer, reconciled against the state stream.
//      An applied native steer advances the run with no state event, and the run also
//      advances with no control pressed, so neither reading is freshest alone; the
//      caller gets the newer, and that maximum is taken once, beside the cache.
//   3. Eligibility is not decided here. Every control is dispatched and the daemon's
//      answer is what comes back; a rejected call propagates to the caller.
//   4. Steer is gated on the bound driver's declared flag in `run-control-gating.ts`;
//      pause, resume and interrupt never are.
//
// The daemon calls are an argument (`RunControlCalls`), so this module holds no bridge.

import type {
  InterventionRequestPayload,
  InterventionRequestResponse,
  RunControlAck,
  RunId,
  RunPauseRequest,
  RunResumeRequest,
} from "@ai-sidekicks/contracts";

import { readRunId } from "@renderer/services/daemon/wire-identifiers.js";

/** The three daemon methods the controls reach, each taking the contract's request. */
export interface RunControlCalls {
  /** `run.pause`. */
  readonly pause: (request: RunPauseRequest) => Promise<RunControlAck>;
  /** `run.resume`. */
  readonly resume: (request: RunResumeRequest) => Promise<RunControlAck>;
  /** `run.intervene`: steer and interrupt are its two arms used here. */
  readonly intervene: (request: InterventionRequestPayload) => Promise<InterventionRequestResponse>;
}

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
    };

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
  readonly #calls: RunControlCalls;
  readonly #mintIdempotencyKey: () => string;
  readonly #freshComparandByRunId = new Map<string, number>();

  public constructor(
    calls: RunControlCalls,
    /** Injected so a test pins the key; the default is the platform's own UUID. */
    mintIdempotencyKey: () => string = () => crypto.randomUUID(),
  ) {
    this.#calls = calls;
    this.#mintIdempotencyKey = mintIdempotencyKey;
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
  public async pause(target: RunControlTarget): Promise<RunControlOutcome> {
    const ack = await this.#calls.pause(this.#guardedRequest(target));
    return this.#acknowledged("pause", target, ack);
  }

  /** Resume. `run.resume` moves a paused run back to running and does nothing else. */
  public async resume(target: RunControlTarget): Promise<RunControlOutcome> {
    const ack = await this.#calls.resume(this.#guardedRequest(target));
    return this.#acknowledged("resume", target, ack);
  }

  /** Steer: `run.intervene` with a fresh key, carrying the person's text as typed. */
  public async steer(target: RunControlTarget, request: SteerRequest): Promise<RunControlOutcome> {
    return await this.#settle("steer", target, {
      type: "steer",
      ...this.#interventionGuards(target),
      content: request.content,
    });
  }

  /**
   * Interrupt: `run.intervene` with a fresh key and, where given, the reason. The
   * messages still waiting go as the next turn.
   */
  public async interrupt(target: RunControlTarget, reason?: string): Promise<RunControlOutcome> {
    return await this.#settle("interrupt", target, {
      type: "interrupt",
      ...this.#interventionGuards(target),
      pending: "nextTurn",
      ...(reason === undefined ? {} : { reason }),
    });
  }

  /** The two guards every intervention carries: the comparand and a key for this body. */
  #interventionGuards(target: RunControlTarget): {
    readonly targetRunId: RunId;
    readonly expectedRunVersion: number;
    readonly clientIdempotencyKey: string;
  } {
    return {
      ...this.#guardedRequest(target),
      clientIdempotencyKey: this.#mintIdempotencyKey(),
    };
  }

  #guardedRequest(target: RunControlTarget): RunPauseRequest {
    return {
      targetRunId: readRunIdOrThrow(target.runId),
      expectedRunVersion: target.expectedRunVersion,
    };
  }

  #acknowledged(
    control: RunControl,
    target: RunControlTarget,
    ack: RunControlAck,
  ): RunControlOutcome {
    this.#freshComparandByRunId.set(target.runId, ack.runVersion);
    return { kind: "acknowledged", control, ack };
  }

  async #settle(
    control: RunControl,
    target: RunControlTarget,
    request: InterventionRequestPayload,
  ): Promise<RunControlOutcome> {
    const response = await this.#calls.intervene(request);
    this.#freshComparandByRunId.set(target.runId, response.runVersion);
    return { kind: "settled", control, response };
  }
}

/** The run id as the contract brands it. An id the contract rejects is a defect upstream. */
function readRunIdOrThrow(runId: string): RunId {
  const branded = readRunId(runId);
  if (branded === undefined) {
    throw new Error(`the run identifier "${runId}" is not one the daemon accepts`);
  }
  return branded;
}
