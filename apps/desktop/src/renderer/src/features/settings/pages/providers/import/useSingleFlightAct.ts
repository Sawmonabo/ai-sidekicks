// One act, in flight or settled: a single control, pressed, and what came of it.
//
// The settlement is a closed union (nothing attempted, in flight, the answer) so a form can
// tell "nothing happened" from "it worked", which a boolean `isSending` renders alike.

import { useCallback, useSyncExternalStore } from "react";

import { Emitter, type Unsubscribe } from "@renderer/lib/emitter.js";
import { refuse, type Refusal } from "@renderer/lib/refusal.js";

/** The subsystem name every refusal this module raises carries. */
export const IMPORT_REFUSAL_ORIGIN = "session-act";

/**
 * The code a press refused for arriving while the act it repeats is unsettled.
 *
 * Console-local rather than a wire code, and named so it reads as one: nothing was
 * sent, so no daemon namespace may be quoted. A refusal wearing a `session.*` code
 * would attribute this console's own rule to the daemon.
 */
const ACT_IN_FLIGHT_CODE = "act-in-flight";

/** Where one act has got to. */
type ActSettlement<TAnswer> =
  | { readonly status: "unattempted" }
  | { readonly status: "running" }
  | { readonly status: "settled"; readonly answer: TAnswer };

/** What one act does: put the call and answer. A rejected call propagates to the presser. */
type ActAttempt<TRequest, TAnswer> = (request: TRequest) => Promise<TAnswer>;

const NOTHING_ATTEMPTED: ActSettlement<never> = { status: "unattempted" };

/**
 * One act's state, held off the render tree.
 *
 * A class, not three `useState` cells: a second press while one is unsettled is answered
 * rather than sent, and a machine spread across cells cannot be driven without a component.
 * The snapshot is rebuilt on transition and held, because `useSyncExternalStore` compares
 * identity.
 */
export class SingleFlightAct<TRequest, TAnswer> {
  readonly #attempt: ActAttempt<TRequest, TAnswer>;
  readonly #describeWhat: string;
  readonly #changes = new Emitter<ActSettlement<TAnswer>>("session act settlement");
  #settlement: ActSettlement<TAnswer> = NOTHING_ATTEMPTED;

  public constructor(options: {
    readonly attempt: ActAttempt<TRequest, TAnswer>;
    /** One noun for the refusal sentence — "the import". */
    readonly describeWhat: string;
  }) {
    this.#attempt = options.attempt;
    this.#describeWhat = options.describeWhat;
  }

  /** Where the act has got to right now. */
  public settlement(): ActSettlement<TAnswer> {
    return this.#settlement;
  }

  /** Call `sink` on every transition. */
  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Put the act, and settle it.
   *
   * A press arriving while one is unsettled makes no call and resolves to a refusal, since
   * a press that vanishes looks like one the daemon ignored; it does not queue. The refusal
   * is returned, never published: publishing it would replace `running` while the first
   * call is still out, and every form reading the act would re-enable its control and admit
   * a third press. Resolves to `undefined` where the act was put. A rejected attempt
   * propagates to whoever pressed, and the act stays `running`.
   */
  public async run(request: TRequest): Promise<Refusal | undefined> {
    if (this.#settlement.status === "running") {
      return refuse(
        IMPORT_REFUSAL_ORIGIN,
        ACT_IN_FLIGHT_CODE,
        `${this.#describeWhat} was not put: the last press is still waiting for its answer. Wait for it to settle, then press again.`,
      );
    }
    this.#publish({ status: "running" });
    this.#publish({ status: "settled", answer: await this.#attempt(request) });
    return undefined;
  }

  /** Return to the unattempted state — the form's own reset, never a settlement. */
  public clear(): void {
    if (this.#settlement.status === "unattempted") {
      return;
    }
    this.#publish(NOTHING_ATTEMPTED);
  }

  #publish(next: ActSettlement<TAnswer>): void {
    this.#settlement = next;
    this.#changes.emit(next);
  }
}

/** Read one act's settlement inside a component. */
export function useSingleFlightAct<TRequest, TAnswer>(
  act: SingleFlightAct<TRequest, TAnswer>,
): ActSettlement<TAnswer> {
  const subscribe = useCallback((onStoreChange: () => void) => act.subscribe(onStoreChange), [act]);
  const read = useCallback(() => act.settlement(), [act]);
  return useSyncExternalStore(subscribe, read, read);
}
