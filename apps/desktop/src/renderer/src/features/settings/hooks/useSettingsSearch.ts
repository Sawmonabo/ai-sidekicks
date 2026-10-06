// The search box above the page list: what is typed, what it finds, and which hit is lit.
//
// Focus stays in the box while the arrows move the highlight over the hits, and Enter opens the
// lit one. A new term lights its first hit again, so a highlight never names a row of the list
// the person typed past.

import { useCallback, useMemo, useState } from "react";

import {
  clampedRowIndex,
  movedRowIndex,
  type WindowedRowMove,
} from "#renderer/hooks/useWindowedRovingIndex.js";
import type { SettingsPageRegistry } from "../pages/registry.js";
import { findSettings, type SettingsSearchHit } from "../search.js";

/** The box's state and the handlers it is drawn with. */
export interface SettingsSearch {
  readonly query: string;
  /** Whether a term is in the box, so the hits stand in for the page list. */
  readonly isSearching: boolean;
  readonly hits: readonly SettingsSearchHit[];
  /** The lit hit's position in `hits`, or `undefined` while there are none. */
  readonly highlightedIndex: number | undefined;
  readonly setQuery: (query: string) => void;
  readonly onFieldKeyDown: (keyEvent: React.KeyboardEvent) => void;
}

/** Hold the search for one mount of the screen; `openHit` is what Enter on a hit does. */
export function useSettingsSearch(
  pages: SettingsPageRegistry,
  openHit: (hit: SettingsSearchHit) => void,
): SettingsSearch {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState<SearchHighlight>({ query: "", index: 0 });
  // Memoized because the registry is fixed while a window is open.
  const hits = useMemo(() => findSettings(pages.entries(), query), [pages, query]);
  const highlightedIndex =
    hits.length === 0
      ? undefined
      : clampedRowIndex(highlight.query === query ? highlight.index : 0, hits.length);

  const onFieldKeyDown = useCallback(
    (keyEvent: React.KeyboardEvent): void => {
      if (highlightedIndex === undefined) {
        return;
      }
      if (keyEvent.key === "Enter") {
        const hit = hits[highlightedIndex];
        if (hit !== undefined) {
          keyEvent.preventDefault();
          openHit(hit);
        }
        return;
      }
      const move = HIGHLIGHT_MOVE_BY_KEY[keyEvent.key];
      if (move === undefined) {
        return;
      }
      keyEvent.preventDefault();
      setHighlight({
        query,
        index: movedRowIndex(move, highlightedIndex, hits.length, false),
      });
    },
    [highlightedIndex, hits, openHit, query],
  );

  return {
    query,
    isSearching: query.trim() !== "",
    hits,
    highlightedIndex,
    setQuery,
    onFieldKeyDown,
  };
}

/**
 * The keys that move the highlight. Home and End are left to the text field, where they move the
 * caret.
 */
const HIGHLIGHT_MOVE_BY_KEY: Readonly<Record<string, WindowedRowMove>> = {
  ArrowDown: "next",
  ArrowUp: "previous",
};

/** Which hit is lit, and the term it was lit under. */
interface SearchHighlight {
  readonly query: string;
  readonly index: number;
}
