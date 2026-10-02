// One provider import's start: the press, the call it puts, and what came of it.
//
// The settlement is a closed union (nothing attempted, in flight, the answer, the refusal) so a
// form can tell "nothing happened" from "it worked", which a boolean `isSending` renders alike.
//
// One control, so no key; the start names no subject that can move, so no supersession; and it
// changes nothing this feature copies, so no local application.

import { useCallback, useSyncExternalStore } from "react";

import type {
  ProviderImportProviderRequest,
  ProviderImportStartResponse,
} from "@ai-sidekicks/contracts";
import { coerceToRefusal } from "@renderer/lib/coerce-to-refusal.js";
import type { Unsubscribe } from "@shared/preload-api.js";
import { Emitter } from "@renderer/lib/emitter.js";
import { refuse, type Refusal } from "@renderer/lib/refusal.js";

/** A start the service answered: the provider it named, and the import now running for it. */
export type StartedImport = ProviderImportProviderRequest & ProviderImportStartResponse;

/** Where one import start has got to. */
export type ProviderImportStartSettlement =
  | { readonly status: "unattempted" }
  | { readonly status: "running" }
  | { readonly status: "settled"; readonly answer: StartedImport }
  | { readonly status: "refused"; readonly refusal: Refusal };

/** The subsystem every refusal this module raises carries. */
const PROVIDER_IMPORT_ORIGIN = "provider-import";

/**
 * The code a press refused for arriving while the start it repeats is unsettled.
 *
 * The app's own rather than a wire code, and named so it reads as one: nothing was sent, so no
 * daemon namespace may be quoted.
 */
const START_IN_FLIGHT_CODE = "import-start-in-flight";

/** The code a rejected start that carried none of its own is reported under. */
const START_FAILED_CODE = "import-start-failed";

const NOTHING_ATTEMPTED: ProviderImportStartSettlement = { status: "unattempted" };

/**
 * One import start's state, held off the render tree.
 *
 * A class, not three `useState` cells: a second press while one is unsettled is answered
 * rather than sent, and a machine spread across cells cannot be driven without a component.
 * The snapshot is rebuilt on transition and held, because `useSyncExternalStore` compares
 * identity.
 */
export class ProviderImportStart {
  readonly #attempt: (request: ProviderImportProviderRequest) => Promise<StartedImport>;
  readonly #changes = new Emitter<ProviderImportStartSettlement>("provider import start");
  #settlement: ProviderImportStartSettlement = NOTHING_ATTEMPTED;

  public constructor(attempt: (request: ProviderImportProviderRequest) => Promise<StartedImport>) {
    this.#attempt = attempt;
  }

  /** Where the start has got to right now. */
  public settlement(): ProviderImportStartSettlement {
    return this.#settlement;
  }

  /** Call `sink` on every transition. */
  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Put the start, and settle it.
   *
   * A press arriving while one is unsettled makes no call and resolves to a refusal, since a
   * press that vanishes looks like one the daemon ignored; it does not queue. That refusal is
   * returned, never published: publishing it would replace `running` while the first call is
   * still out, and the form would re-enable its control and admit a third press. Resolves to
   * `undefined` where the start was put; a rejected call settles as `refused`, carrying the
   * service's own words, so the control comes back.
   */
  public async run(request: ProviderImportProviderRequest): Promise<Refusal | undefined> {
    if (this.#settlement.status === "running") {
      return refuse(
        PROVIDER_IMPORT_ORIGIN,
        START_IN_FLIGHT_CODE,
        "The import was not put: the last press is still waiting for its answer. Wait for it to settle, then press again.",
      );
    }
    this.#publish({ status: "running" });
    try {
      this.#publish({ status: "settled", answer: await this.#attempt(request) });
    } catch (error) {
      this.#publish({
        status: "refused",
        refusal: coerceToRefusal(error, PROVIDER_IMPORT_ORIGIN, START_FAILED_CODE),
      });
    }
    return undefined;
  }

  #publish(next: ProviderImportStartSettlement): void {
    this.#settlement = next;
    this.#changes.emit(next);
  }
}

/** Read one import start's settlement inside a component. */
export function useProviderImportStart(start: ProviderImportStart): ProviderImportStartSettlement {
  const subscribe = useCallback(
    (onStoreChange: () => void) => start.subscribe(onStoreChange),
    [start],
  );
  const read = useCallback(() => start.settlement(), [start]);
  return useSyncExternalStore(subscribe, read, read);
}
