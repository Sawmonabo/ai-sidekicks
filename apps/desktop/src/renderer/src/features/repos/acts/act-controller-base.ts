// An act that asks a question first: the two halves of `act-controller.ts`, composed.
//
// WHAT A SUBCLASS IS LEFT WITH. Which prerequisite question it asks and how it asks it,
// which call each act sends, and what a settled arm carries. The scheduler, the trigger
// wiring, the emitters, the disposed latch, and the single-flight guard are the two
// halves'; this class holds one of each and publishes both as one reading.
//
// A BASE CLASS AND NOT FORWARDING MEMBERS PER CONTROLLER. `snapshot`, `isDisposed`,
// `subscribe`, `requestRead`, `clearAct`, and `dispose` are one line of body each and
// the same in every controller that asks first, and a forwarding member is exactly where
// a copy drifts silently: a controller that forgot to forward `requestRead` still
// compiles, still renders, and is simply never refreshed.
//
// THE HALVES ARE HELD, NOT INHERITED. `ask`, `withdraw`, and `act` stay off a
// controller's public members, so a dialog cannot reach past `requestCapabilities` into
// the primitive and name its own question.
//
// AND THE PREREQUISITE ARRIVES AS AN ABSTRACT METHOD RATHER THAN AS A CLOSURE IN THE
// OPTIONS. A subclass cannot close over its own state in its `super()` call — `this` is
// unreachable until `super()` returns — but `this` is available INSIDE this constructor,
// so the closure handed to the reader is written here and dispatches to the subclass's
// override. It is called only after the first read is scheduled, which is after every
// subclass field has been initialized.
//
// WHAT THIS IS NOT. It is not a reading in its own right: it holds no `PlatformBridge` and
// knows no method name.

import { Emitter, type Unsubscribe } from "@renderer/lib/emitter.js";
import { type Clock } from "@renderer/lib/clock.js";
import { ActController, PrerequisiteReader } from "./act-controller.js";
import {
  ACT_NOT_STARTED,
  type ActOwnArm,
  type ActReading,
  type ActSettlementArm,
} from "./act-reading.js";
import type { ReadTriggerTarget } from "@renderer/store/reads/read-triggers.js";
import type { RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import type { SessionStore } from "@renderer/store/session/session-store.js";
import type { SessionStoreScoped } from "./hooks/useSessionStoreRebind.js";

/** What a subclass hands the two halves underneath it. */
export interface ActControllerBaseOptions {
  /** What this controller's emitters report under when a sink throws. */
  readonly label: string;
  /** The window's one clock, so this refresh coalesces on the window's time base. */
  readonly clock: Clock;
  /** The session whose reconnect edge and named frames re-ask the prerequisite. */
  readonly sessionStore: SessionStore;
  /** The frames that owe the prerequisite a fresh answer. A property of the QUESTION. */
  readonly triggeringEventKinds: ReadonlySet<string>;
}

/**
 * One act, its prerequisite question, and the members every dialog reads them by.
 *
 * ONE PER SUBJECT AND NOT PER DIALOG — per mount for the modes it admits, per
 * workspace-and-mode for an execution root — which is why a prerequisite survives a
 * dialog that is closed and reopened.
 */
export abstract class ActControllerBase<TValue, TSettlement extends ActSettlementArm>
  implements ReadTriggerTarget, SessionStoreScoped
{
  /** The frames that owe this controller's prerequisite a fresh answer. */
  public readonly triggeringEventKinds: ReadonlySet<string>;
  readonly #prerequisite: PrerequisiteReader<TValue>;
  readonly #acts: ActController<TSettlement>;
  readonly #changes: Emitter<ActReading<TValue, TSettlement>>;
  readonly #sessionStore: SessionStore;
  #reading: ActReading<TValue, TSettlement> = ACT_NOT_STARTED;
  #disposed = false;

  protected constructor(options: ActControllerBaseOptions) {
    this.triggeringEventKinds = options.triggeringEventKinds;
    this.#sessionStore = options.sessionStore;
    this.#changes = new Emitter<ActReading<TValue, TSettlement>>(options.label);
    this.#prerequisite = new PrerequisiteReader<TValue>({
      label: options.label,
      clock: options.clock,
      sessionStore: options.sessionStore,
      triggeringEventKinds: options.triggeringEventKinds,
      // DISPATCHED TO THE SUBCLASS AND NOT CAPTURED FROM IT. The reader stores this
      // closure and calls it no earlier than the first scheduled read, so a subclass
      // field the override reads is initialized long before it runs.
      readPrerequisite: async (question: string, signal: AbortSignal) =>
        await this.readPrerequisite(question, signal),
    });
    this.#acts = new ActController<TSettlement>({ label: options.label });
    // One reading for both halves, rebuilt as either moves, so a dialog reading the
    // snapshot gets the same object until something changed.
    this.#prerequisite.subscribe((prerequisite) => {
      this.#publish({ ...this.#reading, prerequisite });
    });
    this.#acts.subscribe((act) => {
      this.#publish({ ...this.#reading, act });
    });
  }

  public get snapshot(): ActReading<TValue, TSettlement> {
    return this.#reading;
  }

  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /**
   * Whether this controller's triggers are armed on `sessionStore`.
   *
   * `useSessionStoreRebind.ts` states the axis; this is where every
   * controller that asks first answers it. A store replaced under an unchanged bridge and
   * identity retires the triggers this controller armed, and the binding above it mints a
   * replacement on this answer.
   */
  public isReadingFor(sessionStore: SessionStore): boolean {
    return this.#sessionStore === sessionStore;
  }

  public subscribe(sink: (reading: ActReading<TValue, TSettlement>) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Ask again, on one of the four reasons the policy admits.
   *
   * ASKS NOTHING WITH NO QUESTION NAMED, which is what lets a controller arm its triggers
   * before anybody has opened its dialog or typed into its form.
   */
  public requestRead(reason: RefreshReason): void {
    this.#prerequisite.requestRead(reason);
  }

  /** Put the act half back to idle. The prerequisite half is deliberately untouched. */
  public clearAct(): void {
    this.#acts.clearAct();
  }

  /** Terminal. A reply still on the wire publishes into nothing after this. */
  public dispose(): void {
    this.#disposed = true;
    this.#prerequisite.dispose();
    this.#acts.dispose();
    this.#changes.clear();
  }

  /**
   * Ask the question this act depends on. The string is whatever {@link askPrerequisite}
   * was given — a constant for a mount's modes, the branch name for a reuse check.
   *
   * THE SIGNAL IS PART OF THE OVERRIDE'S CONTRACT AND NOT AN OPTION IT MAY DECLINE. It
   * belongs to the round the reader's scheduler opened for this read, so an override that
   * hands it to its call lets a controller that is disposed — or whose read has been
   * superseded by a newer fire — drop the reply before anything is built from it.
   */
  protected abstract readPrerequisite(question: string, signal: AbortSignal): Promise<TValue>;

  /** Arm the refresh triggers and take NO read. Idempotent. */
  protected startTriggers(): void {
    this.#prerequisite.start();
  }

  /** Name the prerequisite question and read it. Idempotent on the same question. */
  protected askPrerequisite(question: string, reason: RefreshReason): void {
    this.#prerequisite.ask(question, reason);
  }

  /** Withdraw the question, and put the prerequisite half back to unasked. */
  protected withdrawPrerequisite(): void {
    this.#prerequisite.withdraw();
  }

  /** Send one act, and publish what came back. Does not overlap itself. */
  protected async sendAct<TReplyValue>(
    send: () => Promise<TReplyValue>,
    settle: (value: TReplyValue) => ActOwnArm<TSettlement>,
  ): Promise<void> {
    await this.#acts.act(send, settle);
  }

  /** What the newest prerequisite answer carried, where one has been read at all. */
  protected get prerequisiteValue(): TValue | undefined {
    const { prerequisite } = this.#reading;
    return prerequisite.status === "read" ? prerequisite.value : undefined;
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
