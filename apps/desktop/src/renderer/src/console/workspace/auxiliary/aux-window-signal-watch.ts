// One window signal, held for exactly as long as something is in a window of its own.
//
// Split from `aux-handoff.ts`, which owns WHICH panes are detached and which windows
// were lost or returned. This module owns a SUBSCRIPTION's own lifecycle — start,
// install, drain, stop — because that lifecycle is the part with rounds in it, and a
// class that also held the detached set would make every read of that set a read of
// something a stale round could still be writing to.
//
// AND IT IS ONE IMPLEMENTATION BECAUSE THE HAND-OFF HOLDS TWO SIGNALS. The shell
// reports a pane coming back two ways — the crash nobody asked for
// (`aux-pane-error-watch.ts`) and the return somebody did
// (`aux-pane-return-watch.ts`) — and what differs between them is the value they
// carry, what the hand-off does with it, and the sentence a placeholder shows when
// the signal stops. What does NOT differ is any of the ordering below: the
// single-flight start, the round that keeps a late reply from installing a stream
// nothing will drain, the claim held across the whole drain, and the two endings that
// are the same fact. A second copy of that would be a second place for each of those
// to be right, and the copy that went stale would be the one nothing tested.
//
// A refused subscription is rendered in the placeholder it belongs to: it does not
// mean "nothing has happened".

import { GenerationLatch, type CurrentGenerationClaim } from "../../store/index.js";
import { lossyStringify } from "../../core/index.js";
import type { AuxiliaryWindowOutcome, ConsoleBridge } from "../../bridge/index.js";
import {
  refuseHandoff,
  refuseHandoffFromRejection,
  refuseHandoffFromShell,
  type AuxiliaryHandoffRefusal,
} from "./aux-handoff-contract.js";

/**
 * The auxiliary-window plane, reached as the bridge's own member.
 *
 * Taken off the bridge rather than imported as `AuxiliaryWindowPort`, so the type
 * this subsystem is written against is by construction the one a `ConsoleBridge`
 * actually carries: a plane that moved to a different member would be a compile error
 * here rather than a second name that still resolves.
 *
 * Declared HERE and imported by `aux-handoff.ts` rather than the other way round:
 * that file already imports this module's descendants for the watches, and a
 * type-only import back would close a cycle the layering gate counts as an edge.
 */
export type ConsoleAuxiliaryWindowPort = ConsoleBridge["auxiliaryWindows"];

export interface AuxiliaryWindowSignalWatchOptions<TEvent> {
  /**
   * The latch key this watch's rounds are claimed under.
   *
   * One key per watch and never per round: the latch's subject is the watch itself,
   * so a taken key IS a start in flight and a superseded key IS a start whose
   * settlement installs nothing.
   */
  readonly watchKey: string;
  /**
   * Open the subscription, ALREADY SETTLED.
   *
   * The plane is total over failure — it answers `served` or `unavailable` and never
   * rejects — which is what keeps this module free of any knowledge of the transport
   * underneath: a shell that faulted and a build with no shell at all arrive here as
   * the same two-arm answer, and which of them it was is the port's fact rather than
   * this one's.
   */
  readonly open: () => Promise<AuxiliaryWindowOutcome<DrainableSignal<TEvent>>>;
  /** What the hand-off does with one report. This module never touches its sets. */
  readonly onEvent: (event: TEvent) => void;
  /** The refusal changed. The hand-off publishes; this module never does. */
  readonly onChanged: () => void;
  /** What the placeholder says when the producer closes the stream of its own accord. */
  readonly endedDetail: string;
  /** What it says when the stream failed, given the failure's own sentence. */
  readonly stoppedDetailFor: (cause: string) => string;
}

export class AuxiliaryWindowSignalWatch<TEvent> {
  readonly #options: AuxiliaryWindowSignalWatchOptions<TEvent>;
  #stream: DrainableSignal<TEvent> | undefined;
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

  public constructor(options: AuxiliaryWindowSignalWatchOptions<TEvent>) {
    this.#options = options;
  }

  /**
   * Why this signal is not being received, where it is not.
   *
   * Rendered in the placeholder rather than swallowed: a subscription this build
   * cannot open is not the same fact as a window that has not crashed or has not
   * closed, and a slot that showed nothing would be claiming the second.
   */
  public get refusal(): AuxiliaryHandoffRefusal | undefined {
    return this.#refusal;
  }

  /**
   * Open the signal.
   *
   * Idempotent across BOTH states a watch can be in. A second call while a stream is
   * open is a no-op, because the deck detaching a second pane must not open a second
   * subscription to the same signal — and a second call while the FIRST request is
   * still in flight is a no-op for exactly the same reason, which a guard reading only
   * the installed stream cannot say.
   *
   * AND A REQUEST THAT OUTLIVES ITS WATCH INSTALLS NOTHING. The subscription is asked
   * for over a process boundary, so the last pane can come back while the request is
   * in flight; without the generation the response then installed a stream and
   * drained it for a window with nothing detached, which is the
   * permanent-notice-about-a-hazard-the-window-does-not-have shape this module's
   * header rules out. A stale response closes what it opened and installs nothing.
   *
   * AND THE CLAIM IS HELD FOR THE DRAIN, WHICH IS THE WORK IT GATES. The drain runs
   * for the whole life of the subscription and every write it makes is a settlement —
   * a pane returned to the deck, a refusal about the signal, the handle cleared.
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
    const claim = this.#rounds.claim(this, this.#options.watchKey);
    if (claim === undefined) {
      return;
    }

    try {
      // Settled by the plane, so a rejecting subscribe leaves a stated refusal in the
      // placeholder rather than a watch that was never installed reporting calm.
      const answer = await this.#options.open();
      const installed = claim.settle(() => {
        if (answer.status === "unavailable") {
          this.#refusal = refuseHandoffFromShell(answer);
          this.#options.onChanged();
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
      // TOTAL, because the only caller is an effect. A rejection escaping here reached
      // nobody: the placeholder reported calm over a signal that was never installed,
      // and the fault surfaced as an unhandled rejection a shipped window does not
      // report. The wire call above already settles, so this is the backstop for a
      // defect — and one stated in the slot a person reads beats one recorded nowhere.
      this.#refusal = refuseHandoffFromRejection(rejection);
      this.#stream = undefined;
      this.#options.onChanged();
    } finally {
      claim.release();
    }
  }

  /**
   * Close the signal. Called when the last pane comes back, and on teardown.
   *
   * The round is superseded FIRST, so a request still in flight is invalidated by the
   * same act that closes an installed stream — a stop that reached only what was
   * installed left the pending one to arrive afterwards and re-open the watch it had
   * just closed. Superseding also frees the key, so a detach arriving right behind
   * this stop starts a new subscription rather than being turned away into no watch
   * at all.
   */
  public stop(): void {
    this.#rounds.supersede(this, this.#options.watchKey);
    this.#stream?.close();
    this.#stream = undefined;
    this.#refusal = undefined;
  }

  /**
   * Deliver what the signal reports, for as long as this round is the watch.
   *
   * EVERY WRITE GOES THROUGH THE CLAIM, including the failure arm. A superseded drain
   * is one whose stream has been closed by a stop, and closing is exactly what makes
   * this loop throw — so an ungated catch wrote "the signal stopped" over a
   * subscription that a detach arriving behind that stop had already re-opened and
   * that was delivering. The generation is what tells the two apart; the
   * stream-identity check that used to guard the handle alone cannot, because the
   * handle is one of the fields the stale round was writing.
   *
   * AND BOTH ENDINGS ARE THE SAME FACT, WHICH IS WHY BOTH REFUSE. A producer that
   * closes the stream cleanly and one that drops it leave this window in the identical
   * state: nothing will report the next event, and every pane still in a window of its
   * own is one whose fate would go unnoticed. A stop is the ONE ending that is calm,
   * and a stop supersedes this round before the loop can notice, so neither arm here
   * ever has to ask which one it was.
   */
  async #drain(stream: DrainableSignal<TEvent>, claim: CurrentGenerationClaim): Promise<void> {
    try {
      for await (const event of stream.events) {
        claim.settle(() => {
          this.#options.onEvent(event);
        });
      }
    } catch (error) {
      // A signal that ended in a failure is not a signal that reported nothing, so the
      // placeholder says so rather than the stream ending in silence.
      claim.settle(() => {
        this.#refusal = refuseHandoff(
          "wire-unregistered",
          this.#options.stoppedDetailFor(describeStreamFailure(error)),
        );
        this.#stream = undefined;
        this.#options.onChanged();
      });
      return;
    }
    claim.settle(() => {
      this.#refusal = refuseHandoff("signal-ended", this.#options.endedDetail);
      this.#stream = undefined;
      this.#options.onChanged();
    });
  }
}

/**
 * A stream this watch can drain, in the shape a plane subscription answers with.
 *
 * Structural rather than the port's own `WindowSignalStream`, so this module names
 * the two members it actually uses and nothing else. The concrete streams satisfy it
 * because they carry both.
 */
interface DrainableSignal<TEvent> {
  readonly events: AsyncIterable<TEvent>;
  close(): void;
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
