// The run controls' one chokepoint: guards threaded, keys minted, answers read.
//
// A button assembling its own request could omit a comparand or reuse a key across a changed body,
// so every run call carries `expectedRunVersion` from the caller's target, and steer and interrupt
// carry a UUID `clientIdempotencyKey` minted per dispatch, except that a retry of a steer not
// delivered goes under the failed steer's own id, so a second press answers as the first. A steer
// is a message on one child's own queue, which the child takes at its next step, so it names the
// session and the child rather than a run version. The fresh comparand is the newer of the answer's
// version and the state stream's, since the run also advances with no control pressed. Eligibility
// is decided by the daemon, not here; a rejected call propagates. The daemon calls are an argument
// (`RunControlCalls`), so this module holds no bridge.

import type {
  AgentRunControlResponse,
  AgentRunPauseRequest,
  AgentRunResumeRequest,
} from "@ai-sidekicks/contracts/run/control";
import type { AgentChildRunSteerRequest } from "@ai-sidekicks/contracts/run/children";
import type {
  AgentRunInterveneRequest,
  AgentRunInterveneResponse,
} from "@ai-sidekicks/contracts/run/intervention";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { AgentQueueItemCreateResponse, QueueItemId } from "@ai-sidekicks/contracts/run/queue";

import { heldIdAsWireId, readRunId } from "#renderer/services/daemon/wire/identifiers.js";
import { AnsweredRunVersions } from "../answered-versions.js";

/** The four daemon methods the controls reach, each taking the contract's request. */
export interface RunControlCalls {
  /** `agent.run.pause`. */
  readonly pause: (request: AgentRunPauseRequest) => Promise<AgentRunControlResponse>;
  /** `agent.run.resume`. */
  readonly resume: (request: AgentRunResumeRequest) => Promise<AgentRunControlResponse>;
  /** `agent.run.intervene`, for its interrupt arm. */
  readonly intervene: (request: AgentRunInterveneRequest) => Promise<AgentRunInterveneResponse>;
  /** `agent.childRun.steer`, which puts a steer on a child's queue and answers as a queue send. */
  readonly childSteer: (
    request: AgentChildRunSteerRequest,
  ) => Promise<AgentQueueItemCreateResponse>;
}

/**
 * The controls, declared once: pause and resume (`agent.run.pause`, `agent.run.resume`), steer
 * onto a child's queue (`agent.childRun.steer`), and interrupt through `agent.run.intervene`.
 */
export const RUN_CONTROLS = ["pause", "resume", "steer", "interrupt"] as const;

/** One control. Derived from the tuple, never restated. */
export type RunControl = (typeof RUN_CONTROLS)[number];

/** What one settled dispatch says. */
export type RunControlOutcome =
  | {
      readonly kind: "acknowledged";
      readonly control: RunControl;
      readonly ack: AgentRunControlResponse;
    }
  | {
      readonly kind: "settled";
      readonly control: RunControl;
      /** The intervention's state as the daemon answered it, one arm per state. */
      readonly response: AgentRunInterveneResponse;
    }
  | {
      readonly kind: "queued";
      readonly control: RunControl;
      readonly response: AgentQueueItemCreateResponse;
      /** The steer as it went out, so a retry sends its words again. */
      readonly sent: SentSteer;
    };

/**
 * What a steer dispatch carries: the session and the child whose queue takes it, the person's
 * text, and, on a retry, the queue item of the steer that was not delivered, which the retry
 * replaces.
 */
export interface SteerRequest {
  readonly sessionId: string;
  readonly childHandle: string;
  readonly content: string;
  readonly retriesQueueItemId?: QueueItemId | undefined;
}

/** A steer as it went out on the wire: the child it went to and its words. */
export interface SentSteer {
  readonly childHandle: string;
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

  /** Pause via `agent.run.pause`; the intervention union has no pause arm. */
  public async pause(target: RunControlTarget): Promise<RunControlOutcome> {
    const ack = await this.#calls.pause(this.#guardedRequest(target));
    return this.#acknowledged("pause", target, ack);
  }

  /** Resume: `agent.run.resume` moves a paused run back to running. */
  public async resume(target: RunControlTarget): Promise<RunControlOutcome> {
    const ack = await this.#calls.resume(this.#guardedRequest(target));
    return this.#acknowledged("resume", target, ack);
  }

  /**
   * Steer: `agent.childRun.steer` carrying the person's text as typed under a fresh key, or, for a
   * retry, replacing the steer not delivered under that steer's own id as its key.
   */
  public async steer(request: SteerRequest): Promise<RunControlOutcome> {
    const sent: SentSteer = { childHandle: request.childHandle, content: request.content };
    const retried = request.retriesQueueItemId;
    const response = await this.#calls.childSteer({
      sessionId: heldIdAsWireId(request.sessionId),
      clientIdempotencyKey: retried ?? this.#mintIdempotencyKey(),
      childHandle: heldIdAsWireId(sent.childHandle),
      content: sent.content,
      ...(retried === undefined ? {} : { replacesQueueItemId: retried }),
    });
    return { kind: "queued", control: "steer", response, sent };
  }

  /** Interrupt: `agent.run.intervene` with a fresh key and, where given, the reason. */
  public async interrupt(target: RunControlTarget, reason?: string): Promise<RunControlOutcome> {
    return await this.#settle("interrupt", target, {
      type: "interrupt",
      ...this.#keyedGuards(target),
      pending: "nextTurn",
      ...(reason === undefined ? {} : { reason }),
    });
  }

  /** The comparand and a fresh idempotency key for this body, carried by interrupt. */
  #keyedGuards(target: RunControlTarget): {
    readonly targetRunId: RunId;
    readonly expectedRunVersion: number;
    readonly clientIdempotencyKey: string;
  } {
    return {
      ...this.#guardedRequest(target),
      clientIdempotencyKey: this.#mintIdempotencyKey(),
    };
  }

  #guardedRequest(target: RunControlTarget): AgentRunPauseRequest {
    return {
      targetRunId: readRunIdOrThrow(target.runId),
      expectedRunVersion: target.expectedRunVersion,
    };
  }

  #acknowledged(
    control: RunControl,
    target: RunControlTarget,
    ack: AgentRunControlResponse,
  ): RunControlOutcome {
    this.#answeredRunVersions.record(target.runId, ack.runVersion);
    return { kind: "acknowledged", control, ack };
  }

  async #settle(
    control: RunControl,
    target: RunControlTarget,
    request: AgentRunInterveneRequest,
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
