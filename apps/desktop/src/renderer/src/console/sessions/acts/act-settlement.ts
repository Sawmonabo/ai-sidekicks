// One act, in flight or settled, for the two acts this destination offers.
//
// WHAT IT IS NOT, AND WHY IT IS NOT THAT. `collaboration/mutation-coordinator.ts`
// holds a keyed, superseding, single-flight coordinator over a LEDGER of rows: five
// controls against a subject that moves, each row rendering its own refusal beside
// its own control. This is not that machine and must not become it — and it also
// cannot BE it: `collaboration/` is a sibling view family, and
// `console-view-family-isolation` in `.dependency-cruiser.mjs` fails that import. The
// remedy the package's structure rules name for a shared contract is the hoist — down
// into `bridge/`, which is the lowest family that module's own imports reach — and
// the moment a third family needs an act holder that is what is owed.
//
// WHAT THIS ONE HOLDS is the smaller fact a FORM has: there is one control, it is
// pressed, and what comes back is a settlement. No key, because there is one subject;
// no supersession, because this destination names no session and so has no subject
// that can move underneath the call; no local application, because neither act
// changes anything this family holds a copy of.
//
// THE FOUR STATES ARE THE POINT. A form with a boolean `isSending` renders "nothing
// happened" and "it worked" identically, and a person who pressed Join and saw the
// field clear cannot tell which they got. So the settlement is a closed union and
// every arm has a rendering: nothing attempted, attempt in flight, the daemon's
// refusal, and the answer.

import { useCallback, useSyncExternalStore } from "react";

import { Emitter, refuse, type ConsoleRefusal, type Unsubscribe } from "../../core/index.js";
import type { DaemonReply } from "../../bridge/index.js";

/** The subsystem name every refusal this module raises carries. */
export const SESSION_ACT_REFUSAL_ORIGIN = "session-act";

/**
 * The code a press refused for arriving while the act it repeats is unsettled.
 *
 * Console-local rather than a wire code, and named so it reads as one: nothing was
 * sent, so no daemon namespace may be quoted. A refusal wearing a `session.*` code
 * would attribute this console's own rule to the daemon.
 */
const ACT_IN_FLIGHT_CODE = "act-in-flight";

/** Where one act has got to. */
export type ActSettlement<TAnswer> =
  | { readonly status: "unattempted" }
  | { readonly status: "running" }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal }
  | { readonly status: "settled"; readonly answer: TAnswer };

/**
 * What one act does: put the call, and answer or refuse.
 *
 * Answers a {@link DaemonReply} rather than a shape of this module's own, because
 * that is what the call door answers and the console has exactly one two-armed
 * settlement value. A growth-backed act converts its port outcome at the call site —
 * the refusing arm of a `GrowthOutcome` IS a `ConsoleRefusal`, so the conversion
 * carries the operation, the slate row, and the document that owes the wire through
 * untouched rather than re-minting a refusal on the way past.
 */
export type ActAttempt<TRequest, TAnswer> = (request: TRequest) => Promise<DaemonReply<TAnswer>>;

const NOTHING_ATTEMPTED: ActSettlement<never> = { status: "unattempted" };

/**
 * One act's state, held off the render tree.
 *
 * A class rather than three `useState` cells, per `apps/desktop/AGENTS.md` §State and
 * views: the transitions are a machine — a second press while one is unsettled is
 * ANSWERED rather than sent — and a machine spread across cells is a machine no test
 * can drive without a component around it.
 *
 * The snapshot is REBUILT on transition and held rather than composed per read,
 * because `useSyncExternalStore` compares snapshot identity with `Object.is` and a
 * getter minting a fresh object renders forever.
 */
export class SessionAct<TRequest, TAnswer> {
  readonly #attempt: ActAttempt<TRequest, TAnswer>;
  readonly #describeWhat: string;
  readonly #changes = new Emitter<ActSettlement<TAnswer>>("session act settlement");
  #settlement: ActSettlement<TAnswer> = NOTHING_ATTEMPTED;

  public constructor(options: {
    readonly attempt: ActAttempt<TRequest, TAnswer>;
    /** One noun for the refusal sentence — "the join", "the import". */
    readonly describeWhat: string;
  }) {
    this.#attempt = options.attempt;
    this.#describeWhat = options.describeWhat;
  }

  public settlement(): ActSettlement<TAnswer> {
    return this.#settlement;
  }

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
   * second press's refusal over it would replace `running` with `refused` while the
   * first call is still out: every form reading this act would see a settled state,
   * re-enable its control, and admit a third press whose call races the first to
   * overwrite the settlement both of them write. So the in-flight state stands
   * untouched — no publish, no notification, no transition — and the refusal travels
   * back on the return, which is the one channel that reaches the presser without
   * making a claim about the act. The four-arm union stays exactly four arms: the
   * only shape that could carry this refusal AND the running fact at once is a fifth
   * state, and nothing renders one.
   *
   * The caller that ignores the return loses nothing a person can see: the control
   * that could have been pressed twice is already disabled by the `running` arm this
   * refusal exists to preserve, so the return is what a programmatic second press —
   * a restored draft, a keyboard repeat, a test — is told.
   *
   * There is no `catch` because there is nothing to catch: an attempt answers a
   * served value or a refusal, never a throw, so both arms below are one settlement
   * read two ways rather than one path and one accident.
   *
   * @returns the duplicate-press refusal, or `undefined` where the act was put.
   */
  public async run(request: TRequest): Promise<ConsoleRefusal | undefined> {
    if (this.#settlement.status === "running") {
      return refuse(
        SESSION_ACT_REFUSAL_ORIGIN,
        ACT_IN_FLIGHT_CODE,
        `${this.#describeWhat} was not put: the last one is still running, and only one runs at a time. Wait for it to settle, then press again.`,
      );
    }
    this.#publish({ status: "running" });
    const outcome = await this.#attempt(request);
    this.#publish(
      outcome.status === "served"
        ? { status: "settled", answer: outcome.value }
        : { status: "refused", refusal: outcome.refusal },
    );
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
export function useSessionAct<TRequest, TAnswer>(
  act: SessionAct<TRequest, TAnswer>,
): ActSettlement<TAnswer> {
  const subscribe = useCallback((onStoreChange: () => void) => act.subscribe(onStoreChange), [act]);
  const read = useCallback(() => act.settlement(), [act]);
  return useSyncExternalStore(subscribe, read, read);
}
