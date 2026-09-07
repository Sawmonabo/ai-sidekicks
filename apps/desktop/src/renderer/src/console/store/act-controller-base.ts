// The half of an act controller that is the same in every one of them.
//
// WHAT A SUBCLASS IS LEFT WITH. Which prerequisite question it asks and how it asks it,
// which call each act sends, and what a settled arm carries. Everything else — the
// scheduler, the trigger wiring, the emitter, the disposed latch, the four read arms,
// the four act arms, and the single-flight guard — is `act-controller.ts`'s, and this
// class is how a controller composes that one without writing the wiring again.
//
// A BASE CLASS AND NOT SIX FORWARDING MEMBERS PER CONTROLLER. `store/act-controller.ts`
// already ended three copies of the machine; what survived it was three copies of the
// pass-through — `snapshot`, `isDisposed`, `subscribe`, `requestRead`, `clearAct`, and
// `dispose`, each one line of body and each one written three times. `apps/desktop/AGENTS.md`
// §Shared code hoists on the SECOND use, and a forwarding member is exactly where a
// copy drifts silently: a controller that forgot to forward `requestRead` still
// compiles, still renders, and is simply never refreshed.
//
// THE COMPOSITION SURVIVES THE INHERITANCE, which is the point of the shape. This class
// still HOLDS an `ActController` rather than extending it: the machine's `ask`,
// `withdraw`, and `act` stay off a controller's public surface, so a dialog cannot
// reach past `requestRoster` into the primitive and name its own question. What
// inheritance buys is only the pass-through, which is the part that had no reason to
// differ.
//
// AND THE PREREQUISITE ARRIVES AS AN ABSTRACT METHOD RATHER THAN AS A CLOSURE IN THE
// OPTIONS. A subclass cannot write `readPrerequisite: () => this.#readRoster()` in its
// own `super()` call — `this` is unreachable until `super()` returns — but `this` is
// perfectly available INSIDE this constructor, so the closure handed to the machine is
// written here and dispatches to the subclass's override. It is called only after the
// first read is scheduled, which is after every subclass field has been initialised.
//
// WHAT THIS IS NOT. It is not a reading in its own right: it holds no `ConsoleBridge`
// and knows no method name, so `test/console/architecture/read-triggers.test.ts` does
// not count it as one. What that gate DOES do is follow a subclass's `extends` clause
// into this module, so a controller inherits the scheduler and the trigger contract it
// used to declare by hand and stays a subject of the rule.

import type { ConsoleClock, RejectionFallback, Unsubscribe } from "../core/index.js";
import { ActController } from "./act-controller.js";
import type { ActOutcome, ActOwnArm, ActReading, ActSettlementArm } from "./act-reading.js";
import type { ReadTriggerTarget } from "./read-triggers.js";
import type { RefreshReason } from "./scheduling.js";
import type { SessionStore } from "./session-store.js";

/**
 * What a subclass hands the machine underneath it.
 *
 * `ActControllerOptions` minus its `readPrerequisite`, which is the abstract method
 * below instead — see this module's header for why a subclass cannot supply a closure
 * over its own state in a `super()` call.
 */
export interface ActSurfaceControllerOptions {
  /** What this controller's emitter reports under when a sink throws. */
  readonly label: string;
  /** The window's one clock, so this refresh coalesces on its surface's time base. */
  readonly clock: ConsoleClock;
  /** The session whose reconnect edge and named frames re-ask the prerequisite. */
  readonly sessionStore: SessionStore;
  /** The frames that owe the prerequisite a fresh answer. A property of the QUESTION. */
  readonly triggeringEventKinds: ReadonlySet<string>;
  /** The subsystem a rejection raised on the read path names as its author. */
  readonly refusalOrigin: string;
  /** What a rejection with no readable code of its own says instead. */
  readonly readRejection?: RejectionFallback;
}

/**
 * One act, its prerequisite question, and the six members every surface reads them by.
 *
 * ONE PER SUBJECT AND NOT PER SURFACE — per session for a roster, per mount for the
 * modes it admits, per workspace-and-mode for an execution root — which is why a
 * prerequisite survives a dialog that is closed and reopened.
 */
export abstract class ActSurfaceController<
  TValue,
  TSettlement extends ActSettlementArm,
> implements ReadTriggerTarget {
  /** The frames that owe this controller's prerequisite a fresh answer. */
  public readonly triggeringEventKinds: ReadonlySet<string>;
  readonly #acts: ActController<TValue, TSettlement>;

  protected constructor(options: ActSurfaceControllerOptions) {
    this.triggeringEventKinds = options.triggeringEventKinds;
    this.#acts = new ActController<TValue, TSettlement>({
      label: options.label,
      clock: options.clock,
      sessionStore: options.sessionStore,
      triggeringEventKinds: options.triggeringEventKinds,
      refusalOrigin: options.refusalOrigin,
      ...(options.readRejection === undefined ? {} : { readRejection: options.readRejection }),
      // DISPATCHED TO THE SUBCLASS AND NOT CAPTURED FROM IT. The machine stores this
      // closure and calls it no earlier than the first scheduled read, so a subclass
      // field the override reads is initialised long before it runs.
      readPrerequisite: async (question: string) => await this.readPrerequisite(question),
    });
  }

  /**
   * Ask the question this act depends on. The string is whatever {@link askPrerequisite}
   * was given — a constant for a roster, the branch name for a reuse check.
   */
  protected abstract readPrerequisite(question: string): Promise<ActOutcome<TValue>>;

  public get snapshot(): ActReading<TValue, TSettlement> {
    return this.#acts.snapshot;
  }

  public get isDisposed(): boolean {
    return this.#acts.isDisposed;
  }

  public subscribe(sink: (reading: ActReading<TValue, TSettlement>) => void): Unsubscribe {
    return this.#acts.subscribe(sink);
  }

  /**
   * Ask again, on one of the four reasons the policy admits.
   *
   * ASKS NOTHING WITH NO QUESTION NAMED, which is what lets a controller arm its
   * triggers before anybody has opened its dialog or typed into its form: a window
   * focus over a surface with no question has nothing to re-ask, and requesting anyway
   * would put a call on the wire on every focus for the life of the surface.
   */
  public requestRead(reason: RefreshReason): void {
    this.#acts.requestRead(reason);
  }

  /**
   * Put the act half back to idle. The prerequisite half is deliberately untouched.
   *
   * ITS OWN CALL RATHER THAN A SIDE EFFECT OF CLOSING, because the two are different
   * moments: a settlement is read after the call settles and the surface is still open,
   * and a participant who comes back to act a second time must not meet the first
   * one's sentence.
   */
  public clearAct(): void {
    this.#acts.clearAct();
  }

  /** Terminal. A reply still on the wire publishes into nothing after this. */
  public dispose(): void {
    this.#acts.dispose();
  }

  /** Arm the refresh triggers and take NO read. Idempotent. */
  protected startTriggers(): void {
    this.#acts.start();
  }

  /** Name the prerequisite question and read it. Idempotent on the same question. */
  protected askPrerequisite(question: string, reason: RefreshReason): void {
    this.#acts.ask(question, reason);
  }

  /** Withdraw the question, and put the prerequisite half back to unasked. */
  protected withdrawPrerequisite(): void {
    this.#acts.withdraw();
  }

  /** Ask again after a refused read. The participant-driven one of the four reasons. */
  protected retryPrerequisite(): void {
    this.#acts.retryRead();
  }

  /** Send one act, and publish what came back. Refuses to overlap itself. */
  protected async sendAct<TReplyValue>(
    send: () => Promise<ActOutcome<TReplyValue>>,
    settle: (value: TReplyValue) => ActOwnArm<TSettlement>,
  ): Promise<void> {
    await this.#acts.act(send, settle);
  }

  /** What the newest prerequisite answer carried, where one has been read at all. */
  protected get prerequisiteValue(): TValue | undefined {
    const { prerequisite } = this.#acts.snapshot;
    return prerequisite.status === "read" ? prerequisite.value : undefined;
  }
}
