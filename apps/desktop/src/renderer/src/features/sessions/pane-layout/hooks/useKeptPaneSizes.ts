import { useCallback, useSyncExternalStore } from "react";

import { useKeyBoundValue } from "#renderer/hooks/useKeyBoundValue.js";
import { KeyBoundHolder } from "#renderer/lib/key-bound-holder.js";
import { type Refusal } from "#renderer/lib/refusal/contract.js";
import { type BlockPaneKind } from "#renderer/routing/panes/kinds.js";
import type { UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import { KeptPaneSizes, type PaneSizes } from "../kept-sizes.js";

/** What a pane layout holds of the kept sizes: the sizes, the last refusal and the two sets. */
export interface KeptPaneSizesBinding extends PaneSizes {
  readonly lastRefusal: Refusal | undefined;
  readonly setPaneWidth: (kind: BlockPaneKind, widthPx: number | undefined) => void;
  readonly setTerminalHeight: (heightPx: number | undefined) => void;
}

/** How the kept sizes are minted. Module-level, because the holder reads it once. */
function mintKeptPaneSizes(store: UiStateStore): KeptPaneSizes {
  return new KeptPaneSizes(store);
}

/** Reads the kept record once a store is acquired; idempotent, and one stable reference. */
function hydrateKeptPaneSizes(keptSizes: KeptPaneSizes): void {
  void keptSizes.hydrate();
}

/**
 * The renderer's one holder of the kept sizes, keyed on the durable store's identity, so every
 * session view reads and sets one record. A `const` holding an encapsulated object.
 */
const keptPaneSizesHolder = new KeyBoundHolder(mintKeptPaneSizes);

/** The sizes before the kept record is acquired: every pane at its opening size. */
const OPENING_SIZES: PaneSizes = { widthsPx: {}, terminalHeightPx: undefined };

/**
 * Binds the pane sizes kept for this install into a pane layout. Keyed on the store's identity,
 * so a replaced store rebinds; the hydrate rides the holder's effect.
 */
export function useKeptPaneSizes(store: UiStateStore): KeptPaneSizesBinding {
  const {
    value: keptSizes,
    acquire,
    subscribe,
  } = useKeyBoundValue(keptPaneSizesHolder, store, hydrateKeptPaneSizes);
  const readSizes = useCallback(() => keptSizes?.sizes ?? OPENING_SIZES, [keptSizes]);
  const sizes = useSyncExternalStore(subscribe, readSizes, readSizes);
  const readRefusal = useCallback(() => keptSizes?.lastRefusal, [keptSizes]);
  const lastRefusal = useSyncExternalStore(subscribe, readRefusal, readRefusal);
  const setPaneWidth = useCallback(
    (kind: BlockPaneKind, widthPx: number | undefined) => {
      acquire().setPaneWidth(kind, widthPx);
    },
    [acquire],
  );
  const setTerminalHeight = useCallback(
    (heightPx: number | undefined) => {
      acquire().setTerminalHeight(heightPx);
    },
    [acquire],
  );
  return { ...sizes, lastRefusal, setPaneWidth, setTerminalHeight };
}
