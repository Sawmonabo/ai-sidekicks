// One act, and the question it may be issued against: the two halves as two classes.
//
// WHAT AN ACT IS, in this console. A user presses something, one call goes on the wire,
// and the answer is a settlement they read — attached, bound, prepared. Some acts depend
// on a second question that is asked separately from the act: the modes a mount admits,
// whether a branch already has a live checkout. Others ask nothing first — an attach
// sends a path and reads what came back. So the act and the question are two classes,
// and a controller takes the one it needs: attach builds on `ActController` alone, and
// `act-controller-base.ts` composes both for the controllers that ask first.
//
// THE PREREQUISITE HALF IS SCHEDULED AND THE ACT HALF IS NOT. Reading again is admitted
// on four reasons and interval polling is forbidden, so the read goes through the
// console's one `RefreshScheduler` and declares its own trigger set. An act is something
// a person did once; re-sending it on a window focus would put a second durable record
// on the wire for one press.
//
// THE QUESTION IS A STRING AND IT ARRIVES LATE. A prerequisite has nothing to ask until
// something names it — a dialog that opened, a branch that was typed — so a refresh
// reason arriving with no question asks nothing. Naming a DIFFERENT question resets the
// half and abandons the answer in flight: two checks settle in whatever order the wire
// returns them, and a late answer landing under a newer question is the one state that
// would let a consent be given for the wrong tree.
//
// SUPERSESSION IS `store/read/generation-latch.ts`'s AND NOT A FLAG OF ITS OWN. The act
// half takes a key with `claim`, so a second press while one call is on the wire sends
// nothing rather than being queued or superseding the first. The read half rides the
// scheduler's round instead, which is a latch claim and an `AbortSignal` as one value, so
// it holds no key of its own. The question check is a separate fact: the round says
// whether a NEWER READ replaced this one, and the question says whether the answer is for
// a question anybody still asks — a withdrawal fires no read, so there is no round to
// measure it against.
//
// A CALL THAT REJECTS IS NOT CAUGHT HERE. A rejected act puts the act half back to idle,
// so the surface stops saying it is sending, and the rejection reaches whoever sent the
// act; a rejected read leaves the prerequisite half where it was and the scheduler
// re-throws it.
//
// WHAT THIS IS NOT. It is not a store — nothing here is projected from the timeline —
// and it holds no `PlatformBridge` and knows no method name. Each call is a closure its
// owner passes in, which is what keeps this module below `bridge/` in the console's DAG.

import { Emitter, type Unsubscribe } from "@renderer/lib/emitter.js";
import { type Clock } from "@renderer/lib/clock.js";
import {
  ACT_IDLE,
  PREREQUISITE_NOT_READ,
  type ActOwnArm,
  type ActPrerequisiteReading,
  type ActSettlementArm,
  type ActSettlementReading,
} from "./act-reading.js";
import { GenerationLatch } from "@renderer/lib/reads/generation-latch.js";
import { RefreshScheduler } from "@renderer/lib/reads/refresh-scheduler.js";
import { SessionRefreshTriggers } from "@renderer/store/reads/session-refresh-triggers.js";
import type { ReadRound } from "@renderer/lib/reads/read-scope.js";
import type { ReadTriggerTarget } from "@renderer/store/reads/read-triggers.js";
import type { RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import type { SessionStore } from "@renderer/store/session/session-store.js";

/** What the act half is named by. */
export interface ActControllerOptions {
  /** What this controller's emitter reports under when a sink throws. */
  readonly label: string;
}

/** What one prerequisite reader collaborates with, and what it is scoped to. */
export interface PrerequisiteReaderOptions<TValue> {
  /** What this reader's emitter reports under when a sink throws. */
  readonly label: string;
  /** The window's one clock, so this refresh coalesces on its surface's time base. */
  readonly clock: Clock;
  /** The session whose reconnect edge and named frames re-ask the question. */
  readonly sessionStore: SessionStore;
  /**
   * The frames that owe the question a fresh answer.
   *
   * A PROPERTY OF THE QUESTION and not of the surface that mounts it, which is what
   * `ReadTriggerTarget` means: two readings asking the same thing must not disagree
   * about when the answer goes stale.
   */
  readonly triggeringEventKinds: ReadonlySet<string>;
  /**
   * Ask the question. The string is whatever `ask` was given.
   *
   * THE SIGNAL IS REQUIRED AND NOT OPTIONAL, which is what makes "a prerequisite read is
   * made inside a round" structural rather than a convention: there is no way to write
   * this closure without naming the thing that stops it.
   */
  readonly readPrerequisite: (question: string, signal: AbortSignal) => Promise<TValue>;
}

/** The single-flight key the act half holds. One act at a time, per controller. */
const ACT_KEY = "act";

/**
 * One act, published as the settlement a surface reads.
 *
 * Owns the single-flight guard, the disposed latch, and the emitter; the call each act
 * sends and the arm it settles into are the caller's.
 */
export class ActController<TSettlement extends ActSettlementArm> {
  readonly #changes: Emitter<ActSettlementReading<TSettlement>>;
  readonly #rounds = new GenerationLatch();
  #reading: ActSettlementReading<TSettlement> = ACT_IDLE;
  #disposed = false;

  public constructor(options: ActControllerOptions) {
    this.#changes = new Emitter<ActSettlementReading<TSettlement>>(options.label);
  }

  public get snapshot(): ActSettlementReading<TSettlement> {
    return this.#reading;
  }

  public get isDisposed(): boolean {
    return this.#disposed;
  }

  public subscribe(sink: (reading: ActSettlementReading<TSettlement>) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Send one act, and publish what came back.
   *
   * DOES NOT OVERLAP ITSELF, and through the latch rather than off the rendered arm: two
   * presses inside one frame both read a surface that is idle, so a guard read from the
   * published reading admits both. What that costs is two durable records for one
   * intended act, and two replies racing to decide which settlement is shown.
   *
   * THE SETTLE CALLBACK IS ANNOTATED {@link ActOwnArm} RATHER THAN `TSettlement`, which
   * is where "a discriminant of its own" is actually checked. An arm reusing `idle` or
   * `sending` resolves to `never` there and the callback stops compiling; without it a
   * surface could publish an arm that overwrote one of the two states its own reading is
   * read in, and a settled act would render as still sending.
   */
  public async act<TReplyValue>(
    send: () => Promise<TReplyValue>,
    settle: (value: TReplyValue) => ActOwnArm<TSettlement>,
  ): Promise<void> {
    const round = this.#rounds.takeShell(this, ACT_KEY);
    if (round === undefined || this.#disposed) {
      round?.release();
      return;
    }
    this.#publish({ status: "sending" });
    try {
      const value = await send();
      round.settle(() => {
        this.#publish(settle(value));
      });
    } catch (rejection) {
      // Nothing is on the wire any more, so the surface stops saying it is sending.
      this.#publish(ACT_IDLE);
      throw rejection;
    } finally {
      round.release();
    }
  }

  /**
   * Put the act back to idle.
   *
   * ITS OWN CALL RATHER THAN A SIDE EFFECT OF CLOSING, because the two are different
   * moments: a settlement is read after the call settles and the surface is still open,
   * and a user who comes back to act a second time must not meet the first one's
   * sentence. The single-flight key is not given back — a call still on the wire is not
   * recallable, so a second act sends nothing until that one answers.
   */
  public clearAct(): void {
    if (this.#reading.status === "idle") {
      return;
    }
    this.#publish({ status: "idle" });
  }

  /** Terminal. A reply still on the wire publishes into nothing after this. */
  public dispose(): void {
    this.#disposed = true;
    this.#changes.clear();
  }

  /** The one write. Disposed is terminal here rather than at each caller. */
  #publish(reading: ActSettlementReading<TSettlement>): void {
    if (this.#disposed) {
      return;
    }
    this.#reading = reading;
    this.#changes.emit(reading);
  }
}

/**
 * The question an act is issued against, read on the console's refresh policy.
 *
 * ONE PER SUBJECT AND NOT PER SURFACE — per mount for the modes it admits, per
 * workspace-and-mode for an execution root — which is why an answer survives a dialog
 * that is closed and reopened. The answer has not changed because a popup shut, and
 * re-reading on every open would put a call on the wire for each glance.
 */
export class PrerequisiteReader<TValue> implements ReadTriggerTarget {
  public readonly triggeringEventKinds: ReadonlySet<string>;
  readonly #scheduler: RefreshScheduler;
  readonly #triggers: SessionRefreshTriggers;
  readonly #changes: Emitter<ActPrerequisiteReading<TValue>>;
  readonly #readPrerequisite: (question: string, signal: AbortSignal) => Promise<TValue>;
  #reading: ActPrerequisiteReading<TValue> = PREREQUISITE_NOT_READ;
  /** The question the newest read was issued for. `undefined` means none is named. */
  #question: string | undefined;
  #started = false;
  #disposed = false;

  public constructor(options: PrerequisiteReaderOptions<TValue>) {
    this.triggeringEventKinds = options.triggeringEventKinds;
    this.#changes = new Emitter<ActPrerequisiteReading<TValue>>(options.label);
    this.#readPrerequisite = options.readPrerequisite;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
      // Taken, not asked for: every prerequisite read is one of these fires.
      perform: async (_reasons, round) => {
        await this.#performRead(round);
      },
    });
    this.#triggers = new SessionRefreshTriggers({
      target: this,
      sessionStore: options.sessionStore,
    });
  }

  public get snapshot(): ActPrerequisiteReading<TValue> {
    return this.#reading;
  }

  public subscribe(sink: (reading: ActPrerequisiteReading<TValue>) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Arm the refresh triggers, and take NO read.
   *
   * Idempotent, and separate from {@link ask} because a surface whose question does not
   * exist yet still has to be listening for the frames that would change it. A surface
   * whose question exists the moment it opens calls `ask` instead, which arms these same
   * triggers on its way past.
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
   * IDEMPOTENT ON THE SAME QUESTION. A dialog reopened asks nothing new, and a field
   * retyped to the same text has not changed the question either.
   *
   * A DIFFERENT QUESTION RESETS THE HALF AND ABANDONS THE ANSWER IN FLIGHT. The verdict
   * on screen must never be the one for a branch the user has already edited away from,
   * and a reply still on the wire for the old question installs nothing — its own read
   * sees `#question` has moved, and the fire this request schedules supersedes its round.
   */
  public ask(question: string, reason: RefreshReason): void {
    if (this.#disposed || this.#question === question) {
      return;
    }
    this.start();
    this.#question = question;
    this.#publish({ status: "reading" });
    this.#scheduler.request(reason);
  }

  /**
   * Withdraw the question, and put the half back to unasked.
   *
   * For the user who cleared the field: leaving the last answer on screen would attach it
   * to a question nobody is asking. A withdrawal fires no read, so no newer round
   * supersedes the answer in flight; what keeps it off screen is that its question is
   * unnamed.
   */
  public withdraw(): void {
    if (this.#disposed || this.#question === undefined) {
      return;
    }
    this.#question = undefined;
    this.#publish(PREREQUISITE_NOT_READ);
  }

  /**
   * Ask again, on one of the four reasons the policy admits.
   *
   * ASKS NOTHING WITH NO QUESTION NAMED. A window focus over a surface nobody has opened
   * or typed into has nothing to re-ask, and requesting anyway would put a call on the
   * wire on every focus for the life of the surface.
   */
  public requestRead(reason: RefreshReason): void {
    if (this.#disposed || this.#question === undefined) {
      return;
    }
    this.#scheduler.request(reason);
  }

  /**
   * Terminal. A reply still on the wire publishes into nothing after this.
   *
   * AND IS NOT PARSED EITHER, which is the scheduler's disposal doing it: it abandons the
   * read line, so the door drops the call and the round it holds settles nothing.
   */
  public dispose(): void {
    this.#disposed = true;
    this.#scheduler.dispose();
    this.#triggers.dispose();
    this.#changes.clear();
  }

  /**
   * Ask about the question the newest `ask` named.
   *
   * READS THE QUESTION AT PERFORM TIME rather than taking one at request time, because
   * the scheduler coalesces: two edits inside one debounce window are one call, and it
   * has to be the call for what is named NOW.
   *
   * THE ROUND IS THE SCHEDULER'S AND IS NOT RELEASED HERE — `ReadRound`'s own narrowing:
   * the scope took the key, so a performer cannot free the one its successor relies on.
   */
  async #performRead(round: ReadRound): Promise<void> {
    const question = this.#question;
    if (question === undefined) {
      return;
    }
    const value = await this.#readPrerequisite(question, round.signal);
    if (this.#question !== question) {
      return;
    }
    round.settle(() => {
      this.#publish({ status: "read", value });
    });
  }

  /** The one write. Disposed is terminal here rather than at each caller. */
  #publish(reading: ActPrerequisiteReading<TValue>): void {
    if (this.#disposed) {
      return;
    }
    this.#reading = reading;
    this.#changes.emit(reading);
  }
}
