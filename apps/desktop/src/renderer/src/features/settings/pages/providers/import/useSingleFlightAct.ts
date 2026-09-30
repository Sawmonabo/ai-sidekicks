// One act, in flight or settled: a single control, pressed, and what came of it.
//
// There is one control, so there is no key; the act names no subject that can move
// underneath the call, so there is no supersession; and neither call changes anything
// this feature holds a copy of, so there is no local application.
//
// THE THREE STATES ARE THE POINT. A form with a boolean `isSending` renders "nothing
// happened" and "it worked" identically, and a person who pressed Import and saw the
// field clear cannot tell which they got. So the settlement is a closed union and every
// arm has a rendering: nothing attempted, attempt in flight, and the answer.

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
 * A class rather than three `useState` cells, per the state-and-views rule in
 * `apps/desktop/AGENTS.md`: the transitions are a machine — a second press while one
 * is unsettled is ANSWERED rather than sent — and a machine spread across cells is a
 * machine no test can drive without a component around it.
 *
 * The snapshot is REBUILT on transition and held rather than composed per read,
 * because `useSyncExternalStore` compares snapshot identity with `Object.is` and a
 * getter minting a fresh object renders forever.
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
   * A press arriving while one is unsettled makes NO call and refuses audibly: a
   * press that vanishes is indistinguishable from one the daemon ignored. It does
   * not queue — an act held and put later is a second act nobody re-confirmed.
   *
   * THE DUPLICATE REFUSAL IS ANSWERED TO THE CALLER AND IS NEVER PUBLISHED. The
   * settlement belongs to the request that is still in flight, and publishing the
   * second press's refusal over it would replace `running` while the first call is
   * still out: every form reading this act would see a settled state, re-enable its
   * control, and admit a third press whose call races the first to overwrite the
   * settlement both of them write. So the in-flight state stands untouched — no
   * publish, no notification, no transition — and the refusal travels back on the
   * return, which is the one route that reaches the presser without making a claim
   * about the act.
   *
   * The caller that ignores the return loses nothing a person can see: the control
   * that could have been pressed twice is already disabled by the `running` arm this
   * refusal exists to preserve, so the return is what a programmatic second press —
   * a restored draft, a keyboard repeat, a test — is told.
   *
   * A rejected attempt propagates to whoever pressed, and the act stays `running`.
   *
   * @returns the duplicate-press refusal, or `undefined` where the act was put.
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
