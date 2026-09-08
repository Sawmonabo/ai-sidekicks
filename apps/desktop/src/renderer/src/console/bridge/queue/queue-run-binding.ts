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
// ASKED ONCE PER SESSION. No registered stream announces a binding change, and a
// binding is fixed when the item is queued — so a repeat would re-ask a question with
// a standing answer and spend the idle-CPU budget doing it. A row the answer does not
// name is UNBOUND, which is the durable column's nullable arm, and the row renders
// without a target rather than with an invented one.

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
   * Whether the one read has been issued.
   *
   * TERMINAL once true, which is the whole discipline: `open` is reached from the
   * reading's own first watcher and from nothing else, and a second call is a second
   * answer to a standing question.
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

  /** Ask once. Later calls do nothing, because the answer does not move. */
  public open(): void {
    if (this.#hasAsked) {
      return;
    }
    this.#hasAsked = true;
    void this.#bridge.growth.runRecordQueueRunBindingRead({ sessionId: this.#sessionId }).then(
      (outcome) => {
        if (outcome.status !== "served") {
          this.#bindingRefusal = outcome;
          this.#onChanged();
          return;
        }
        this.#targetRunIdByItemId = new Map(
          outcome.value.bindings.map((binding) => [binding.queueItemId, binding.targetRunId]),
        );
        this.#onChanged();
      },
      // The port's contract is that it RESOLVES with an outcome, so a rejection has no
      // arm in that vocabulary. Left unhandled it publishes nothing and the rows go on
      // rendering unbound for the life of the window over a call that had failed.
      (rejection: unknown) => {
        this.#bindingRefusal = refuse(
          QUEUE_RUN_BINDING_ORIGIN,
          "queue.run_binding_unreadable",
          rejection instanceof Error
            ? rejection.message
            : "The run-binding read failed and named no reason the console could render.",
        );
        this.#onChanged();
      },
    );
  }
}
