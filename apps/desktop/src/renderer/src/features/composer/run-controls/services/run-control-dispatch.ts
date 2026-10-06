// The run controls' one chokepoint: guards threaded, keys minted, answers read.
//
// A button assembling its own request could omit a comparand or reuse a key across a changed
// body, so every request carries `expectedRunVersion` from the caller's target, and steer and
// interrupt carry a `clientIdempotencyKey` minted per dispatch. The fresh comparand is the
// newer of the answer's version and the state stream's, since the run also advances with no
// control pressed. Eligibility is decided by the daemon, not here; a rejected call propagates.
// Only steer is gated on the bound driver, in `gating.ts`. The daemon calls are an
// argument (`RunControlCalls`), so this module holds no bridge.

import type {
  InterventionRequestPayload,
  InterventionRequestResponse,
  RunControlAck,
  RunPauseRequest,
  RunResumeRequest,
} from "@ai-sidekicks/contracts/run/control";
import type { RunId } from "@ai-sidekicks/contracts/provider/driver/intervention";

import { readRunId } from "#renderer/services/daemon/wire/identifiers.js";
import { AnsweredRunVersions } from "../../answered-run-versions.js";

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
 * The controls, declared once: pause and resume (`run.pause`, `run.resume`), and steer and
 * interrupt through the generic `run.intervene` dispatch.
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
 * The dispatcher. A class so the freshest comparand, minted keys and outcomes are one
 * object's state, and threading the answer's version into the next request is not a rule
 * each button re-implements.
 */
export class RunControlDispatcher {
  readonly #calls: RunControlCalls;
  readonly #mintIdempotencyKey: () => string;
  readonly #answeredRunVersions = new AnsweredRunVersions();

  public constructor(
    calls: RunControlCalls,
    /** Injected so a test pins the key; the default is the platform's own UUID. */
    mintIdempotencyKey: () => string = () => crypto.randomUUID(),
  ) {
    this.#calls = calls;
    this.#mintIdempotencyKey = mintIdempotencyKey;
  }

  /**
   * The comparand to send for a run: the newer of the daemon's last answer and the state
   * stream's reading. Both are monotonic per run. Preferring the cached one would pin every
   * later control to a stale version, and a refusal carries no `runVersion` to refresh it.
   * Neither reading gives `undefined` and no dispatch, never an invented zero.
   */
  public comparandFor(runId: string, streamReading: number): number;
  public comparandFor(runId: string, streamReading: number | undefined): number | undefined;
  public comparandFor(runId: string, streamReading: number | undefined): number | undefined {
    return this.#answeredRunVersions.comparandFor(runId, streamReading);
  }

  /** Pause via `run.pause`; the intervention union has no pause arm. */
  public async pause(target: RunControlTarget): Promise<RunControlOutcome> {
    const ack = await this.#calls.pause(this.#guardedRequest(target));
    return this.#acknowledged("pause", target, ack);
  }

  /** Resume: `run.resume` moves a paused run back to running. */
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

  /** Interrupt: `run.intervene` with a fresh key and, where given, the reason. */
  public async interrupt(target: RunControlTarget, reason?: string): Promise<RunControlOutcome> {
    return await this.#settle("interrupt", target, {
      type: "interrupt",
      ...this.#interventionGuards(target),
      pending: "nextTurn",
      ...(reason === undefined ? {} : { reason }),
    });
  }

  /** The comparand and a key for this body, carried by every intervention. */
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
    this.#answeredRunVersions.record(target.runId, ack.runVersion);
    return { kind: "acknowledged", control, ack };
  }

  async #settle(
    control: RunControl,
    target: RunControlTarget,
    request: InterventionRequestPayload,
  ): Promise<RunControlOutcome> {
    const response = await this.#calls.intervene(request);
    this.#answeredRunVersions.record(target.runId, response.runVersion);
    return { kind: "settled", control, response };
  }
}

/** The run id as the contract brands it; an id the contract rejects is a defect upstream. */
function readRunIdOrThrow(runId: string): RunId {
  const branded = readRunId(runId);
  if (branded === undefined) {
    throw new Error(`the run identifier "${runId}" is not one the daemon accepts`);
  }
  return branded;
}
