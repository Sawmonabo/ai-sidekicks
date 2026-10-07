// One provider-import call a press puts — the start or the stop — and what came of it.
//
// The settlement is a closed union (nothing attempted, in flight, the answer, the refusal) so a
// control can tell "nothing happened" from "it worked", which a boolean `isSending` renders alike.
//
// One control per call, so no key; the call names no subject that can move, so no supersession;
// and it changes nothing this feature copies, so no local application.

import { useCallback, useSyncExternalStore } from "react";

import { coerceToRefusal } from "#renderer/lib/coerce-to-refusal.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "#renderer/lib/emitter.js";
import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";

/**
 * Where one import call has got to. `pressOrdinal` counts the calls put, from one, so a caller can
 * tell one press's settlement from the one before.
 */
export type ProviderImportCallSettlement<TAnswer> =
  | { readonly status: "unattempted" }
  | { readonly status: "running"; readonly pressOrdinal: number }
  | { readonly status: "settled"; readonly answer: TAnswer; readonly pressOrdinal: number }
  | { readonly status: "refused"; readonly refusal: Refusal; readonly pressOrdinal: number };

/** The subsystem every refusal this module raises carries. */
const PROVIDER_IMPORT_ORIGIN = "provider-import";

/**
 * The code a press refused for arriving while the call it repeats is unsettled.
 *
 * The app's own rather than a wire code, and named so it reads as one: nothing was sent, so no
 * daemon namespace may be quoted.
 */
const CALL_IN_FLIGHT_CODE = "import-call-in-flight";

/**
 * One import call's state, held off the render tree.
 *
 * A class, not three `useState` cells: a second press while one is unsettled is answered
 * rather than sent, and a machine spread across cells cannot be driven without a component.
 * The snapshot is rebuilt on transition and held, because `useSyncExternalStore` compares
 * identity.
 */
export class ProviderImportCall<TRequest, TAnswer> {
  readonly #attempt: (request: TRequest) => Promise<TAnswer>;
  readonly #failedCode: string;
  readonly #changes = new Emitter<ProviderImportCallSettlement<TAnswer>>("provider import call");
  #settlement: ProviderImportCallSettlement<TAnswer> = { status: "unattempted" };
  #pressCount = 0;

  /** `failedCode` reports a rejection that carried no code of its own. */
  public constructor(attempt: (request: TRequest) => Promise<TAnswer>, failedCode: string) {
    this.#attempt = attempt;
    this.#failedCode = failedCode;
  }

  /** Where the call has got to right now. */
  public settlement(): ProviderImportCallSettlement<TAnswer> {
    return this.#settlement;
  }

  /** Call `sink` on every transition. */
  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Put the call, and settle it.
   *
   * A press arriving while one is unsettled makes no call and resolves to a refusal, since a
   * press that vanishes looks like one the daemon ignored; it does not queue. That refusal is
   * returned, never published: publishing it would replace `running` while the first call is
   * still out, and the control would re-enable and admit a third press. Resolves to
   * `undefined` where the call was put; a rejected call settles as `refused`, carrying the
   * service's own words, so the control comes back.
   */
  public async run(request: TRequest): Promise<Refusal | undefined> {
    if (this.#settlement.status === "running") {
      return refuse(
        PROVIDER_IMPORT_ORIGIN,
        CALL_IN_FLIGHT_CODE,
        "Nothing was sent: the last press is still waiting for its answer.",
      );
    }
    this.#pressCount += 1;
    const pressOrdinal = this.#pressCount;
    this.#publish({ status: "running", pressOrdinal });
    try {
      this.#publish({ status: "settled", answer: await this.#attempt(request), pressOrdinal });
    } catch (error) {
      this.#publish({
        status: "refused",
        refusal: coerceToRefusal(error, PROVIDER_IMPORT_ORIGIN, this.#failedCode),
        pressOrdinal,
      });
    }
    return undefined;
  }

  #publish(next: ProviderImportCallSettlement<TAnswer>): void {
    this.#settlement = next;
    this.#changes.emit(next);
  }
}

/** Read one import call's settlement inside a component. */
export function useProviderImportCall<TRequest, TAnswer>(
  call: ProviderImportCall<TRequest, TAnswer>,
): ProviderImportCallSettlement<TAnswer> {
  const subscribe = useCallback(
    (onStoreChange: () => void) => call.subscribe(onStoreChange),
    [call],
  );
  const read = useCallback(() => call.settlement(), [call]);
  return useSyncExternalStore(subscribe, read, read);
}
