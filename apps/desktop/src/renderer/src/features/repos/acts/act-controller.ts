// One act and the question it may be issued against, as two classes: `ActController` (the
// act half) and `PrerequisiteReader` (the question half). An attach asks nothing first, so
// it builds on `ActController` alone; `act-controller-base.ts` composes both.
//
// Only the prerequisite read is scheduled. An act is never re-sent on a refresh: that would
// put a second durable record on the wire for one press. A rejected act publishes its refusal,
// with the service's own message, and frees the control for another press; a rejected read
// publishes its refusal as the prerequisite, unless the question moved on or the round ended.
// Each call is a closure the owner passes in, so nothing here touches the bridge.

import { coerceToRefusal } from "@renderer/lib/coerce-to-refusal.js";
import type { Unsubscribe } from "@shared/preload-api.js";
import { Emitter } from "@renderer/lib/emitter.js";
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
  /** The window's one clock, so this refresh coalesces on the window's time base. */
  readonly clock: Clock;
  /** The session whose reconnect edge and named frames re-ask the question. */
  readonly sessionStore: SessionStore;
  /** The window the reading is drawn in; its regaining focus re-asks. */
  readonly ownerWindow: Window;
  /**
   * The frames that owe the question a fresh answer. A property of the question, not of the
   * dialog that mounts it: two readings of one question must agree when it goes stale.
   */
  readonly triggeringEventKinds: ReadonlySet<string>;
  /**
   * Ask the question; `question` is what `ask` was given. The signal is required so every
   * prerequisite read runs inside a round that can stop it.
   */
  readonly readPrerequisite: (question: string, signal: AbortSignal) => Promise<TValue>;
}

/** The single-flight key the act half holds. One act at a time, per controller. */
const ACT_KEY = "act";

/** The subsystem a refused repo act names, so a refusal says which part of the app sent it. */
const REPO_ACT_REFUSAL_ORIGIN = "repo-act";

/** The subsystem a refused prerequisite read names. */
const REPO_PREREQUISITE_REFUSAL_ORIGIN = "repo-prerequisite";

/**
 * One act, published as the settlement a dialog reads. Owns the single-flight guard, the
 * disposed latch and the emitter; the call and the settled arm are the caller's.
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
   * Send one act, and publish what came back. Does not overlap itself: the guard is the
   * latch, not the rendered arm, because two presses inside one frame both read an idle
   * dialog. `settle` is annotated {@link ActOwnArm} so an arm reusing `idle` or `sending`
   * fails to compile.
   */
  public async act<TReplyValue>(
    send: () => Promise<TReplyValue>,
    settle: (value: TReplyValue) => ActOwnArm<TSettlement>,
  ): Promise<void> {
    const round = this.#rounds.claim(this, ACT_KEY);
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
      // Nothing is on the wire any more, so the dialog stops saying it is sending and says why.
      this.#publish({
        status: "refused",
        refusal: coerceToRefusal(
          rejection,
          REPO_ACT_REFUSAL_ORIGIN,
          `${REPO_ACT_REFUSAL_ORIGIN}-call-failed`,
        ),
      });
    } finally {
      round.release();
    }
  }

  /**
   * Put the act back to idle. Separate from closing because a settlement is read while the
   * dialog is still open. The single-flight key is not released: a call still on the wire is
   * not recallable, so a second act sends nothing until that one answers.
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

  #publish(reading: ActSettlementReading<TSettlement>): void {
    if (this.#disposed) {
      return;
    }
    this.#reading = reading;
    this.#changes.emit(reading);
  }
}

/**
 * The question an act is issued against, read on the refresh policy's reasons. One per
 * subject, not per dialog, so an answer survives a dialog closed and reopened instead of
 * being re-read on every open.
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
      // Every fire performs the same read, so the reasons are unused.
      perform: async (_reasons, round) => {
        await this.#performRead(round);
      },
    });
    this.#triggers = new SessionRefreshTriggers({
      target: this,
      sessionStore: options.sessionStore,
      ownerWindow: options.ownerWindow,
    });
  }

  public get snapshot(): ActPrerequisiteReading<TValue> {
    return this.#reading;
  }

  public subscribe(sink: (reading: ActPrerequisiteReading<TValue>) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Arm the refresh triggers and take no read. Idempotent. Separate from {@link ask} because
   * a dialog whose question does not exist yet must still hear the frames that would change it.
   */
  public start(): void {
    if (this.#started || this.#disposed) {
      return;
    }
    this.#started = true;
    this.#triggers.start();
  }

  /**
   * Name the question, and read it. Idempotent on the same question. A different question
   * resets the half and abandons the answer in flight, so the verdict on screen is never
   * for a branch the user has edited away from.
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
   * Withdraw the question and put the half back to unasked, so a cleared field does not keep
   * the last answer on screen. No read fires; the answer in flight stays off screen because
   * its question is unnamed.
   */
  public withdraw(): void {
    if (this.#disposed || this.#question === undefined) {
      return;
    }
    this.#question = undefined;
    this.#publish(PREREQUISITE_NOT_READ);
  }

  /**
   * Ask again, on a reason the refresh policy admits. The read asks nothing while no question
   * is named, so a window focus over an untouched dialog puts no call on the wire.
   */
  public requestRead(reason: RefreshReason): void {
    this.#scheduler.request(reason);
  }

  /**
   * Terminal. A reply still on the wire publishes into nothing after this: the scheduler's
   * disposal abandons the read, so the call is dropped and its round settles nothing.
   */
  public dispose(): void {
    this.#disposed = true;
    this.#scheduler.dispose();
    this.#triggers.dispose();
    this.#changes.clear();
  }

  // Reads the question at perform time, not request time: the scheduler coalesces, so two
  // edits inside one debounce window are one call and it must be for what is named now.
  // The round belongs to the scheduler and is not released here. A rejection settles under the
  // same two guards as an answer, so a read abandoned with its round never reaches the screen.
  async #performRead(round: ReadRound): Promise<void> {
    const question = this.#question;
    if (question === undefined) {
      return;
    }
    let reading: ActPrerequisiteReading<TValue>;
    try {
      reading = { status: "read", value: await this.#readPrerequisite(question, round.signal) };
    } catch (rejection) {
      reading = {
        status: "refused",
        refusal: coerceToRefusal(rejection, REPO_PREREQUISITE_REFUSAL_ORIGIN),
      };
    }
    if (this.#question !== question) {
      return;
    }
    round.settle(() => {
      this.#publish(reading);
    });
  }

  #publish(reading: ActPrerequisiteReading<TValue>): void {
    if (this.#disposed) {
      return;
    }
    this.#reading = reading;
    this.#changes.emit(reading);
  }
}
