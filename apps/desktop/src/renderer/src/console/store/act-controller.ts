// One act, the question it is issued against, and what both halves publish.
//
// WHAT AN ACT IS, in this console. A participant presses something, one call goes on
// the wire, and the answer is a settlement they read — attached, bound, prepared,
// sent, held. Around that there is always a second question the act depends on and
// which fails independently of it: the roster a node is picked from, the modes a mount
// admits, whether a branch already has a live checkout. Collapsing the two reports an
// outage in the PREREQUISITE as a failure of the ACT, which is the wrong sentence in
// front of somebody who has not pressed anything yet.
//
// THREE COPIES OF THIS WERE WRITTEN IN ONE DIRECTORY. The repos family's attach, bind,
// and execution-root-prepare controllers were the same class member for member — the
// same scheduler wiring, the same trigger wiring, the same emitter, the same disposed
// latch, the same four read arms, the same four act arms, the same overlap guard, and
// the same hook and disposal constant underneath — differing only in which call each
// sent and what its settled arm carried. `apps/desktop/AGENTS.md` §Shared code hoists
// on the SECOND use, and the place copies of a guard drift is the predicate.
//
// THE PREREQUISITE HALF IS SCHEDULED AND THE ACT HALF IS NOT, which is the one
// asymmetry this class is built around. `Spec-023 §Rules every console surface obeys`
// admits four reasons to read again and forbids interval polling, so the read goes
// through the console's one `RefreshScheduler` and declares its own trigger census.
// An act is something a person did once; re-sending it on a window focus would put a
// second durable record on the wire for one press.
//
// THE QUESTION IS A STRING AND IT ARRIVES LATE. A prerequisite has nothing to ask
// until something names it — a dialog that opened, a branch that was typed — so a
// refresh reason arriving with no question asks nothing rather than sending a request
// the contract would refuse unread. Naming a DIFFERENT question resets the half and
// abandons the answer in flight: two checks settle in whatever order the wire returns
// them, and a late answer landing under a newer question is the one state that would
// let a consent be given for the wrong tree.
//
// AND SUPERSESSION IS `generation-latch.ts`'s AND NOT A FLAG OF ITS OWN. That register
// is where this console keeps "may I dispatch" and "may this settlement install", and
// a fourth hand-rolled epoch counter beside it would be the drift this class exists to
// end. The act half takes a key with `claim`, so a second press while one call is on
// the wire is REFUSED rather than queued or superseded; the read half takes one with
// `supersedeAndClaim`, because the newest question is the one the participant is
// waiting on.
//
// WHAT THIS IS NOT. It is not a store — nothing here is projected from the timeline —
// and it is not a reading in its own right: it holds no `ConsoleBridge` and knows no
// method name. The call is a closure its owner passes in, which is what keeps this
// module below `bridge/` in the console's DAG. The arms it publishes are
// `act-reading.ts`'s, because a surface names those and never names this class.

import {
  Emitter,
  normalizeWireRejection,
  type ConsoleClock,
  type RejectionFallback,
  type Unsubscribe,
} from "../core/index.js";
import {
  ACT_NOT_STARTED,
  type ActOutcome,
  type ActReading,
  type ActSettlementArm,
  type ActSettlementReading,
} from "./act-reading.js";
import { GenerationLatch } from "./generation-latch.js";
import type { ReadTriggerTarget } from "./read-triggers.js";
import { SessionRefreshTriggers } from "./refresh-triggers.js";
import { RefreshScheduler, type RefreshReason } from "./scheduling.js";
import type { SessionStore } from "./session-store.js";

/** What one act controller collaborates with, and what it is scoped to. */
export interface ActControllerOptions<TValue> {
  /** What this controller's emitter reports under when a sink throws. */
  readonly label: string;
  /** The window's one clock, so this refresh coalesces on its surface's time base. */
  readonly clock: ConsoleClock;
  /** The session whose reconnect edge and named frames re-ask the prerequisite. */
  readonly sessionStore: SessionStore;
  /**
   * The frames that owe the prerequisite a fresh answer.
   *
   * A PROPERTY OF THE QUESTION and not of the surface that mounts it, which is what
   * `ReadTriggerTarget` means: two readings asking the same thing must not disagree
   * about when the answer goes stale.
   */
  readonly triggeringEventKinds: ReadonlySet<string>;
  /** The subsystem a rejection raised on the read path names as its author. */
  readonly refusalOrigin: string;
  /** Ask the prerequisite question. The string is whatever `ask` was given. */
  readonly readPrerequisite: (question: string) => Promise<ActOutcome<TValue>>;
  /** What a rejection with no readable code of its own says instead. */
  readonly readRejection?: RejectionFallback;
}

/** The single-flight key the act half holds. One act at a time, per controller. */
const ACT_KEY = "act";

/** The single-flight key the prerequisite read holds. Superseded, never refused. */
const PREREQUISITE_KEY = "prerequisite";

/**
 * One act and the question it is issued against, published as one reading.
 *
 * ONE PER SUBJECT AND NOT PER SURFACE — per session for a roster, per mount for the
 * modes it admits, per workspace-and-mode for an execution root — which is why a
 * prerequisite survives a dialog that is closed and reopened. The answer has not
 * changed because a popup shut, and re-reading on every open would put a call on the
 * wire for each glance.
 */
export class ActController<
  TValue,
  TSettlement extends ActSettlementArm,
> implements ReadTriggerTarget {
  public readonly triggeringEventKinds: ReadonlySet<string>;
  readonly #scheduler: RefreshScheduler;
  readonly #triggers: SessionRefreshTriggers;
  readonly #changes: Emitter<ActReading<TValue, TSettlement>>;
  readonly #rounds = new GenerationLatch();
  readonly #readPrerequisite: (question: string) => Promise<ActOutcome<TValue>>;
  readonly #refusalOrigin: string;
  readonly #readRejection: RejectionFallback | undefined;
  #reading: ActReading<TValue, TSettlement> = ACT_NOT_STARTED;
  /** The question the newest read was issued for. `undefined` means none is named. */
  #question: string | undefined;
  #started = false;
  #disposed = false;

  public constructor(options: ActControllerOptions<TValue>) {
    this.triggeringEventKinds = options.triggeringEventKinds;
    this.#changes = new Emitter<ActReading<TValue, TSettlement>>(options.label);
    this.#readPrerequisite = options.readPrerequisite;
    this.#refusalOrigin = options.refusalOrigin;
    this.#readRejection = options.readRejection;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
      perform: async () => {
        await this.#performRead();
      },
      // A read that threw past its own handling reaches nobody from inside a scheduler
      // callback, so it lands in the prerequisite half as a refusal the surface
      // renders rather than leaving it on `reading` with no reason for it.
      onError: (error: unknown) => {
        this.#publishReadRejection(error);
      },
    });
    this.#triggers = new SessionRefreshTriggers({
      target: this,
      sessionStore: options.sessionStore,
    });
  }

  public get snapshot(): ActReading<TValue, TSettlement> {
    return this.#reading;
  }

  public get isDisposed(): boolean {
    return this.#disposed;
  }

  public subscribe(sink: (reading: ActReading<TValue, TSettlement>) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Arm the refresh triggers, and take NO read.
   *
   * Idempotent, and separate from {@link ask} because a surface whose question does
   * not exist yet still has to be listening for the frames that would change it. A
   * surface whose question exists the moment it opens calls `ask` instead, which arms
   * these same triggers on its way past.
   */
  public start(): void {
    if (this.#started || this.#disposed) {
      return;
    }
    this.#started = true;
    this.#triggers.start();
  }

  /**
   * Name the question, and read it.
   *
   * IDEMPOTENT ON THE SAME QUESTION. A dialog reopened asks nothing new — the answer
   * has not changed because a popup shut — and a field retyped to the same text has
   * not changed the question either.
   *
   * A DIFFERENT QUESTION RESETS THE HALF AND ABANDONS THE ANSWER IN FLIGHT. The
   * verdict on screen must never be the one for a branch the participant has already
   * edited away from, and a reply still on the wire for the old question installs
   * nothing rather than being cancelled — nothing behind the bridge is cancellable.
   */
  public ask(question: string, reason: RefreshReason): void {
    if (this.#disposed || this.#question === question) {
      return;
    }
    this.start();
    this.#question = question;
    this.#rounds.supersede(this, PREREQUISITE_KEY);
    this.#publish({ ...this.#reading, prerequisite: { status: "reading" } });
    this.#scheduler.request(reason);
  }

  /**
   * Withdraw the question, and put the half back to unasked.
   *
   * For the participant who cleared the field: leaving the last answer on screen would
   * attach it to a question nobody is asking. The act half is deliberately untouched.
   */
  public withdraw(): void {
    if (this.#disposed || this.#question === undefined) {
      return;
    }
    this.#question = undefined;
    this.#rounds.supersede(this, PREREQUISITE_KEY);
    this.#publish({ ...this.#reading, prerequisite: { status: "not-read" } });
  }

  /**
   * Ask again, on one of the four reasons the policy admits.
   *
   * ASKS NOTHING WITH NO QUESTION NAMED. A window focus over a surface nobody has
   * opened or typed into has nothing to re-ask, and requesting anyway would put a call
   * on the wire on every focus for the life of the surface.
   */
  public requestRead(reason: RefreshReason): void {
    if (this.#disposed || this.#question === undefined) {
      return;
    }
    this.#scheduler.request(reason);
  }

  /** Ask again after a refused read. The participant-driven one of the four reasons. */
  public retryRead(): void {
    this.requestRead("participant-request");
  }

  /**
   * Send one act, and publish what came back.
   *
   * REFUSES TO OVERLAP ITSELF, and through the latch rather than off the rendered arm:
   * two presses inside one frame both read a surface that is idle, so a guard read
   * from the published reading admits both. What that costs is two durable records for
   * one intended act, and two replies racing to decide which settlement is shown.
   *
   * THE SETTLEMENT IS PUBLISHED ON BOTH ARMS AND SWALLOWED ON NEITHER. `Spec-023
   * §Rules every console surface obeys` admits no silent no-op: an act that worked
   * says what it produced, and one that was refused renders the daemon's own code.
   */
  public async act<TReplyValue>(
    send: () => Promise<ActOutcome<TReplyValue>>,
    settle: (value: TReplyValue) => TSettlement,
  ): Promise<void> {
    const round = this.#rounds.claim(this, ACT_KEY);
    if (round === undefined || this.#disposed) {
      round?.release();
      return;
    }
    this.#publishAct({ status: "sending" });
    try {
      const reply = await send();
      round.settle(() => {
        this.#publishAct(
          reply.status === "refused"
            ? { status: "refused", refusal: reply.refusal }
            : settle(reply.value),
        );
      });
    } catch (rejection) {
      // A REJECTION IS AN ANSWER TOO. The live bridge crosses a process boundary, so a
      // disconnected namespace throws where the fixture answers a refusal; without
      // this arm the surface would sit on `sending` with no settlement and no reason.
      round.settle(() => {
        this.#publishAct({
          status: "refused",
          refusal: normalizeWireRejection(this.#refusalOrigin, rejection),
        });
      });
    } finally {
      round.release();
    }
  }

  /**
   * Put the act half back to idle.
   *
   * ITS OWN CALL RATHER THAN A SIDE EFFECT OF CLOSING, because the two are different
   * moments: a settlement is read after the call settles and the surface is still
   * open, and a participant who comes back to act a second time must not meet the
   * first one's sentence. The prerequisite half is deliberately untouched, and the
   * single-flight key is not given back — a call still on the wire is not recallable,
   * so a second act is still refused until that one answers.
   */
  public clearAct(): void {
    if (this.#reading.act.status === "idle") {
      return;
    }
    this.#publishAct({ status: "idle" });
  }

  /** Terminal. A reply still on the wire publishes into nothing after this. */
  public dispose(): void {
    this.#disposed = true;
    this.#scheduler.dispose();
    this.#triggers.dispose();
    this.#changes.clear();
  }

  /**
   * Ask the daemon about the question the newest `ask` named.
   *
   * READS THE QUESTION AT PERFORM TIME rather than taking one at request time, because
   * the scheduler coalesces: two edits inside one debounce window are one call, and it
   * has to be the call for what is named NOW.
   */
  async #performRead(): Promise<void> {
    const question = this.#question;
    if (question === undefined) {
      return;
    }
    const round = this.#rounds.supersedeAndClaim(this, PREREQUISITE_KEY);
    try {
      const reply = await this.#readPrerequisite(question);
      if (this.#question !== question) {
        return;
      }
      round.settle(() => {
        this.#publish({
          ...this.#reading,
          prerequisite:
            reply.status === "refused"
              ? { status: "refused", refusal: reply.refusal }
              : { status: "read", value: reply.value },
        });
      });
    } catch (rejection) {
      round.settle(() => {
        this.#publishReadRejection(rejection);
      });
    } finally {
      round.release();
    }
  }

  /** One rejection reading, for the two paths that can produce one. */
  #publishReadRejection(rejection: unknown): void {
    this.#publish({
      ...this.#reading,
      prerequisite: {
        status: "refused",
        refusal: normalizeWireRejection(this.#refusalOrigin, rejection, this.#readRejection),
      },
    });
  }

  #publishAct(act: ActSettlementReading<TSettlement>): void {
    this.#publish({ ...this.#reading, act });
  }

  /** The one write. Disposed is terminal here rather than at each caller. */
  #publish(reading: ActReading<TValue, TSettlement>): void {
    if (this.#disposed) {
      return;
    }
    this.#reading = reading;
    this.#changes.emit(reading);
  }
}
