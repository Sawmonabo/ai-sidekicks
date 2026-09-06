// The crashed-window signal: one subscription, held for exactly as long as something
// is in a window of its own.
//
// Split from `aux-handoff.ts`, which owns WHICH panes are detached and which windows
// were lost. This module owns the SUBSCRIPTION's own lifecycle — start, install,
// drain, stop — because that lifecycle is the part with rounds in it, and a class
// that also held the detached set would make every read of that set a read of
// something a stale round could still be writing to.
//
// `Spec-023 §The surface set`: "a crashed auxiliary window returns the pane to the
// deck with the crash noted in the pane's error slot" needs something to notice the
// crash, and the growth registry carries exactly one: a window pane-error
// subscription whose value is a pane id and a reason. It is watched only while
// something is detached, because a subscription held over an empty detached set can
// report nothing and its refusal would be a permanent notice about a hazard the
// window does not currently have. A refused subscription is rendered in the
// placeholder it belongs to: it does not mean "no crashes".

import { GenerationLatch, type CurrentGenerationClaim } from "../../store/index.js";
import { settledGrowthCall, type ConsoleBridge } from "../../bridge/index.js";
import { lossyStringify } from "../../core/index.js";
import {
  refuseHandoff,
  refuseHandoffFromGrowth,
  refuseHandoffFromRejection,
  type AuxiliaryHandoffRefusal,
} from "./aux-handoff-contract.js";

/**
 * The growth port, reached as the bridge's own member rather than by importing the
 * port type.
 *
 * `bridge/index.ts` exports the bridge and not the port, deliberately — the port is
 * reached THROUGH a bridge and never held on its own — so this alias takes the type
 * off the door that is open rather than asking for a second one.
 *
 * Declared HERE and imported by `aux-handoff.ts` rather than the other way round:
 * that file already imports this module for the watch, and a type-only import back
 * would close a cycle the layering gate counts as an edge.
 */
export type ConsoleGrowthPort = ConsoleBridge["growth"];

/**
 * The served value of the pane-error subscription, taken off the port for the same
 * reason `ConsoleGrowthPort` is: the bridge door exports the bridge and not the
 * stream shape, and a second import for a type the open door already carries would
 * be a second name for one wire fact.
 */
type PaneErrorSignal = Extract<
  Awaited<ReturnType<ConsoleGrowthPort["windowSubscribePaneErrors"]>>,
  { readonly status: "served" }
>["value"];

/**
 * The one key the pane-error watch is claimed under.
 *
 * There is exactly one signal per hand-off, so one key: the latch's subject is the
 * watch itself and the register never holds more than this.
 */
const PANE_ERROR_WATCH_KEY = "pane-error-watch";

export interface PaneErrorWatchOptions {
  readonly growth: ConsoleGrowthPort;
  /** A window reported lost, by the pane it held and the reason it gave. */
  readonly onWindowLost: (paneId: string, reason: string) => void;
  /** The refusal changed. The hand-off publishes; this module never does. */
  readonly onChanged: () => void;
}

export class PaneErrorWatch {
  readonly #growth: ConsoleGrowthPort;
  readonly #onWindowLost: (paneId: string, reason: string) => void;
  readonly #onChanged: () => void;
  #stream: PaneErrorSignal | undefined;
  #refusal: AuxiliaryHandoffRefusal | undefined;
  /**
   * Whether a start is in flight, and which round it is.
   *
   * THE SUBSTRATE'S REGISTER RATHER THAN A COUNTER PAIR. This used to be a watch
   * generation beside the generation a start was pending for, compared as
   * `#pendingStartGeneration === #watchGeneration`; the latch says that once — a
   * taken key IS a start in flight, and a superseded key IS a start whose settlement
   * installs nothing. A boolean captured per call could not be reached from the stop
   * that has to invalidate it, which is why the pair existed at all, and the latch
   * keeps that property without the arithmetic.
   */
  readonly #rounds = new GenerationLatch();

  public constructor(options: PaneErrorWatchOptions) {
    this.#growth = options.growth;
    this.#onWindowLost = options.onWindowLost;
    this.#onChanged = options.onChanged;
  }

  /**
   * Why the crashed-window signal is not being received, where it is not.
   *
   * Rendered in the placeholder rather than swallowed: a subscription this build
   * cannot open is not the same fact as a window that has not crashed, and a slot
   * that showed nothing would be claiming the second.
   */
  public get refusal(): AuxiliaryHandoffRefusal | undefined {
    return this.#refusal;
  }

  /**
   * Open the signal, so a window that crashed returns its pane.
   *
   * Idempotent across BOTH states a watch can be in, which is the half this used to
   * miss. A second call while a stream is open is a no-op, because the deck detaching
   * a second pane must not open a second subscription to the same signal — and a
   * second call while the FIRST request is still in flight is a no-op for exactly the
   * same reason, which a guard reading only the installed stream cannot say.
   *
   * AND A REQUEST THAT OUTLIVES ITS WATCH INSTALLS NOTHING. The subscription is
   * asked for over a process boundary, so the last pane can come back while the
   * request is in flight; without the generation the response then installed a
   * stream and drained it for a window with nothing detached, which is the
   * permanent-notice-about-a-hazard-the-window-does-not-have shape this module's
   * header rules out. A stale response closes what it opened and installs nothing.
   *
   * AND THE CLAIM IS HELD FOR THE DRAIN, WHICH IS THE WORK IT GATES. The drain runs
   * for the whole life of the subscription and every write it makes is a settlement
   * — a pane returned to the deck, a refusal about the signal, the handle cleared.
   * Freeing the key at the reply left all of that ungated: a stop closes the stream,
   * which is what makes the drain throw, and a detach arriving right behind that stop
   * has already installed a healthy one by the time the throw is caught. The key is
   * given back at the end instead, where `release` is a no-op for a round something
   * else has already superseded.
   */
  public async start(): Promise<void> {
    if (this.#stream !== undefined) {
      return;
    }
    const claim = this.#rounds.claim(this, PANE_ERROR_WATCH_KEY);
    if (claim === undefined) {
      return;
    }

    try {
      // Settled, so a rejecting subscribe leaves a stated refusal in the placeholder
      // rather than a watch that was never installed reporting calm.
      const answer = await settledGrowthCall("windowSubscribePaneErrors", () =>
        this.#growth.windowSubscribePaneErrors({}),
      );
      const installed = claim.settle(() => {
        if (answer.status === "unavailable") {
          this.#refusal = refuseHandoffFromGrowth(answer);
          this.#onChanged();
          return;
        }
        this.#refusal = undefined;
        this.#stream = answer.value;
      });
      if (!installed) {
        // Stopped while this was in flight, so the stream this reply carries is one
        // nothing will ever drain.
        if (answer.status === "served") {
          answer.value.close();
        }
        return;
      }
      if (answer.status === "served") {
        await this.#drain(answer.value, claim);
      }
    } catch (rejection: unknown) {
      // TOTAL, because the only caller is an effect. A rejection escaping here
      // reached nobody: the placeholder reported calm over a signal that was never
      // installed, and the fault surfaced as an unhandled rejection a shipped window
      // does not report. The wire call above already settles, so this is the backstop
      // for a defect — and one stated in the slot a person reads beats one recorded
      // nowhere.
      this.#refusal = refuseHandoffFromRejection(rejection);
      this.#stream = undefined;
      this.#onChanged();
    } finally {
      claim.release();
    }
  }

  /**
   * Close the signal. Called when the last pane comes back, and on teardown.
   *
   * The round is superseded FIRST, so a request still in flight is invalidated by
   * the same act that closes an installed stream — a stop that reached only what was
   * installed left the pending one to arrive afterwards and re-open the watch it had
   * just closed. Superseding also frees the key, so a detach arriving right behind
   * this stop starts a new subscription rather than being turned away into no watch
   * at all.
   */
  public stop(): void {
    this.#rounds.supersede(this, PANE_ERROR_WATCH_KEY);
    this.#stream?.close();
    this.#stream = undefined;
    this.#refusal = undefined;
  }

  /**
   * Deliver what the signal reports, for as long as this round is the watch.
   *
   * EVERY WRITE GOES THROUGH THE CLAIM, including the failure arm. A superseded drain
   * is one whose stream has been closed by a stop, and closing is exactly what makes
   * this loop throw — so an ungated catch wrote "the signal that reports a lost window
   * stopped" over a subscription that a detach arriving behind that stop had already
   * re-opened and that was delivering. The generation is what tells the two apart; the
   * stream-identity check that used to guard the handle alone cannot, because the
   * handle is one of the fields the stale round was writing.
   *
   * AND BOTH ENDINGS ARE THE SAME FACT, WHICH IS WHY BOTH REFUSE. A producer that
   * closes the stream cleanly and one that drops it leave this window in the identical
   * state: nothing will report the next crash, and every pane still in a window of its
   * own is one whose loss would go unnoticed. The normal arm used to clear the handle
   * and publish, which rendered a placeholder that said nothing was wrong — the
   * quietest possible account of a signal that had stopped. A stop is the ONE ending
   * that is calm, and a stop supersedes this round before the loop can notice, so
   * neither arm here ever has to ask which one it was.
   */
  async #drain(stream: PaneErrorSignal, claim: CurrentGenerationClaim): Promise<void> {
    try {
      for await (const paneError of stream.events) {
        claim.settle(() => {
          this.#onWindowLost(paneError.paneId, paneError.reason);
        });
      }
    } catch (error) {
      // A signal that ended in a failure is not a signal that reported no crashes,
      // so the placeholder says so rather than the stream ending in silence.
      claim.settle(() => {
        this.#refusal = refuseHandoff(
          "wire-unregistered",
          `The signal that reports a lost window stopped: ${describeStreamFailure(error)}`,
        );
        this.#stream = undefined;
        this.#onChanged();
      });
      return;
    }
    claim.settle(() => {
      this.#refusal = refuseHandoff(
        "signal-ended",
        "The signal that reports a lost window ended. A window that closes unexpectedly will no longer return its pane on its own.",
      );
      this.#stream = undefined;
      this.#onChanged();
    });
  }
}

/**
 * An unknown thrown value as one sentence, without inventing a shape for it.
 *
 * `lossyStringify` rather than `String`: a caught value may be a revoked proxy, a
 * null-prototype object, or a `toString` that throws, and `String` on any of those
 * throws out of the very handler written to keep a failed signal from escaping.
 */
function describeStreamFailure(error: unknown): string {
  return error instanceof Error ? error.message : lossyStringify(error);
}
