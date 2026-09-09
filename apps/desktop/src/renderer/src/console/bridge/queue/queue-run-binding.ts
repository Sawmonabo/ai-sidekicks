// Which run each queued row is bound to, and why that answer is not on the row.
//
// `QueueItemSummary` is `{ id, state, priority, channelId?, createdAt, updatedAt }`
// parsed `.strict()`, and it carries no run member at all — a scripted `targetRunId`
// fails that parse and takes the whole reply down with it. The durable column exists
// (`queue_items.target_run_id`, written by the run-bound delivery redesign), so the
// binding is asked for through the growth port as its own projection and folded onto
// the rows here, where the reading that renders them already is.
//
// A THIRD COLLABORATOR OF `queue-reading.ts`, beside the subscription that owns the
// rows and the cancellations that own the mutation. It publishes through that
// reading's own callback for the reason those two do: one surface, one publication
// path, so a binding arriving never renders a frame the rows have not reached.
//
// ASKED ONCE PER SESSION, AND ONCE MORE AFTER EACH REFUSAL. No registered stream
// announces a binding change, and a binding is fixed when the item is queued — so a
// repeat of an ANSWERED read would re-ask a question with a standing answer and spend
// the idle-CPU budget doing it. A row the answer does not name is UNBOUND, which is the
// durable column's nullable arm, and the row renders without a target rather than with
// an invented one.
//
// A REFUSAL IS NOT AN ANSWER, WHICH IS THE HALF THAT WAS MISSING. `queue-reading.ts`
// lets a REFUSED subscription fall through its own short-circuit because "the joiner's
// arrival is exactly the reason to try the failed read again", and this read inside the
// same class was terminal on its first ask: one refusal — a daemon still starting, a
// transport blip — left every row in the runs pane queue and the composer shelf unbound
// for the life of the reading, under a refusal with no control and no trigger that could
// clear it. So the ask is forgotten when it settles refused, and the reading's own
// `requestRead` is what puts it again.

import { refuse, type ConsoleRefusal } from "../../core/index.js";
import type { ConsoleBridge } from "../console-bridge.js";

/** Names this read in a refusal the call itself did not name. */
export const QUEUE_RUN_BINDING_ORIGIN = "queue-run-binding";

/** What a surface reads about the queue's run bindings. */
export interface QueueRunBindingState {
  /** The run each bound item is bound to. A row absent from the map is unbound. */
  readonly targetRunIdByItemId: ReadonlyMap<string, string>;
  /** The refusal the one read came back with, where it refused. */
  readonly bindingRefusal: ConsoleRefusal | undefined;
}

const NO_BINDINGS: ReadonlyMap<string, string> = new Map<string, string>();

/**
 * One reading's run bindings: the map, the refusal, and the single call that fills it.
 *
 * A class with private fields rather than two cells the reading passes around, because
 * the map and the refusal move together — a settled read writes exactly one of them —
 * and a caller that could move one without the other is how a surface comes to render
 * a stale binding beside a refusal saying the read never landed.
 */
export class QueueRunBindings {
  readonly #bridge: ConsoleBridge;
  readonly #sessionId: string;
  readonly #onChanged: () => void;
  #targetRunIdByItemId: ReadonlyMap<string, string> = NO_BINDINGS;
  #bindingRefusal: ConsoleRefusal | undefined;
  /**
   * Whether a read is outstanding or has been answered.
   *
   * TRUE FOR AN ASK IN FLIGHT AND FOR ONE THAT SERVED, and false again the moment one
   * settles refused. Those are the two claims that matter and they are one flag because
   * they have one consequence: a second `open` while either holds would be a second
   * answer to a standing question, and a second `open` after a refusal is the retry the
   * header describes.
   */
  #hasAsked = false;

  public constructor(bridge: ConsoleBridge, sessionId: string, onChanged: () => void) {
    this.#bridge = bridge;
    this.#sessionId = sessionId;
    this.#onChanged = onChanged;
  }

  /** The bindings as they stand. */
  public get state(): QueueRunBindingState {
    return {
      targetRunIdByItemId: this.#targetRunIdByItemId,
      bindingRefusal: this.#bindingRefusal,
    };
  }

  /**
   * Ask once. A later call re-asks only where the last one refused.
   *
   * Reached from the reading's first watcher and from every one of its read triggers,
   * so a joiner, a reconnect, or a repair puts the failed read again — and asks nothing
   * at all while one is outstanding or a served answer stands.
   */
  public open(): void {
    if (this.#hasAsked) {
      return;
    }
    this.#hasAsked = true;
    void this.#bridge.growth.runRecordQueueRunBindingRead({ sessionId: this.#sessionId }).then(
      (outcome) => {
        if (outcome.status !== "served") {
          this.#settleRefused(outcome);
          return;
        }
        this.#targetRunIdByItemId = new Map(
          outcome.value.bindings.map((binding) => [binding.queueItemId, binding.targetRunId]),
        );
        // Cleared on the answer that replaces it: a served read beside the refusal an
        // earlier attempt left would report the bindings on screen as unreadable.
        this.#bindingRefusal = undefined;
        this.#onChanged();
      },
      // The port's contract is that it RESOLVES with an outcome, so a rejection has no
      // arm in that vocabulary. Left unhandled it publishes nothing and the rows go on
      // rendering unbound for the life of the window over a call that had failed.
      (rejection: unknown) => {
        this.#settleRefused(
          refuse(
            QUEUE_RUN_BINDING_ORIGIN,
            "queue.run_binding_unreadable",
            rejection instanceof Error
              ? rejection.message
              : "The run-binding read failed and named no reason the console could render.",
          ),
        );
      },
    );
  }

  /**
   * Record why the read did not land, and admit the next ask.
   *
   * The flag is dropped in the same act the refusal is written, so there is no moment
   * at which a surface holds a refusal this reading would refuse to retry.
   */
  #settleRefused(refusal: ConsoleRefusal): void {
    this.#bindingRefusal = refusal;
    this.#hasAsked = false;
    this.#onChanged();
  }
}
