// One act a dialog sends, and the settlement it reads. An act is never re-sent on a refresh:
// that would put a second durable record on the wire for one press. A rejected act publishes its
// refusal, with the service's own message, and frees the control for another press. The call is
// a closure the owner passes in, so nothing here touches the bridge.

import { coerceToRefusal } from "#renderer/lib/coerce-to-refusal.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "#renderer/lib/emitter.js";
import {
  ACT_IDLE,
  type ActOwnArm,
  type ActSettlementArm,
  type ActSettlementReading,
} from "./act-reading.js";
import { GenerationLatch } from "#renderer/lib/reads/generation-latch.js";

/** What the act half is named by. */
export interface ActControllerOptions {
  /** What this controller's emitter reports under when a sink throws. */
  readonly label: string;
}

/** The single-flight key the act half holds. One act at a time, per controller. */
const ACT_KEY = "act";

/** The subsystem a refused repo act names, so a refusal says which part of the app sent it. */
const REPO_ACT_REFUSAL_ORIGIN = "repo-act";

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
