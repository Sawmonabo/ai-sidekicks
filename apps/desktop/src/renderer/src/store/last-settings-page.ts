// The settings page last open on this device, so reopening Settings opens it again.
//
// One record in the durable store, under the `selection` class: `{ page: <id> }`. Held in memory
// first, so the rail reads it at once, and hydrated once when the app opens; a record naming no
// page this app has (a page renamed or removed since) is set aside and Settings opens on its
// list. A refused write is counted by the store's health, as every refused write is.

import type { Unsubscribe } from "#shared/preload-api.js";
import { SETTINGS_PAGE_IDS, type SettingsPageId } from "#renderer/routing/settings-page-ids.js";
import { DurableViewState } from "#renderer/store/persistence/durable-view-state.js";
import type { UiStateStore } from "#renderer/store/persistence/ui-state-store.js";

/** The record key, inside the durable store's global partition. */
const LAST_SETTINGS_PAGE_KEY = "settings-last-page";

/** The page Settings last showed, kept on this device for everything that opens Settings. */
export class LastSettingsPage {
  readonly #state: DurableViewState<Readonly<Record<string, string>>>;

  public constructor(uiStateStore: UiStateStore) {
    this.#state = new DurableViewState<Readonly<Record<string, string>>>({
      store: uiStateStore,
      key: LAST_SETTINGS_PAGE_KEY,
      valueClass: "selection",
      initial: {},
      narrow: (raw) => {
        const pageId = pageIdOf(raw);
        return pageId === undefined ? undefined : { page: pageId };
      },
    });
  }

  /** The page last open, or `undefined` before any was or while the record is still read. */
  public get pageId(): SettingsPageId | undefined {
    return pageIdOf(this.#state.value);
  }

  /** Read the kept record once; a page recorded before it lands is not overwritten. */
  public async hydrate(): Promise<void> {
    await this.#state.hydrate();
  }

  /** Hear every change of the page last open. */
  public subscribe(sink: () => void): Unsubscribe {
    return this.#state.subscribe(sink);
  }

  /** Keep `pageId` as the page last open. */
  public record(pageId: SettingsPageId): void {
    if (pageId !== this.pageId) {
      void this.#state.commit({ page: pageId });
    }
  }

  public dispose(): void {
    this.#state.dispose();
  }
}

/** The page a record names, when it names one this app has. */
function pageIdOf(raw: unknown): SettingsPageId | undefined {
  if (typeof raw !== "object" || raw === null || !("page" in raw)) {
    return undefined;
  }
  const { page } = raw;
  return SETTINGS_PAGE_IDS.find((pageId) => pageId === page);
}
