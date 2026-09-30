// Base for a controller that reads a prerequisite question before its act: it holds a
// `PrerequisiteReader` and an `ActController` and publishes both as one `ActReading`.
// The halves are held, not inherited, so a dialog cannot reach past the subclass's own
// members and name its own question.

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
  /** The frames that owe the prerequisite a fresh answer. */
  readonly triggeringEventKinds: ReadonlySet<string>;
}

/**
 * One act, its prerequisite question, and the members every dialog reads them by. One per
 * subject, not per dialog, so a prerequisite survives a dialog closed and reopened.
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
      // Dispatches to the subclass's override. The reader calls this only after the first
      // scheduled read, when every subclass field is initialized (`this` is unusable in super()).
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
   * Whether this controller's triggers are armed on `sessionStore`. A store replaced under
   * an unchanged bridge and identity retires those triggers; the binding above mints a
   * replacement when this answers false.
   */
  public isReadingFor(sessionStore: SessionStore): boolean {
    return this.#sessionStore === sessionStore;
  }

  public subscribe(sink: (reading: ActReading<TValue, TSettlement>) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Ask again, on a reason the refresh policy admits. Asks nothing while no question is
   * named, so triggers can be armed before a dialog opens.
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
   * Ask the question this act depends on; `question` is what {@link askPrerequisite} was
   * given. The override must pass `signal` to its call so a disposed or superseded read
   * drops its reply before anything is built from it.
   */
  protected abstract readPrerequisite(question: string, signal: AbortSignal): Promise<TValue>;

  /** Arm the refresh triggers and take no read. Idempotent. */
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

  #publish(reading: ActReading<TValue, TSettlement>): void {
    if (this.#disposed) {
      return;
    }
    this.#reading = reading;
    this.#changes.emit(reading);
  }
}
