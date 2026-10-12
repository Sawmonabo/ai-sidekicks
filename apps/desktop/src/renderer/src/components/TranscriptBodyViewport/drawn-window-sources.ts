// What the windows a feed draws drew their undrawn items from, each under the key its spacers
// carry, so a copy reads the items a spacer stands for from there rather than waiting for them to
// draw: a long table's parse, for its rows, and the text of each item of a window drawn as text,
// a command output's chunks of lines or a diff's steps of rows. A copy that outlives the frame it
// was asked in takes the sources its rows name when it is asked, since a window that scrolls away
// lets its hold go.

import type { Table } from "mdast";
import { createContext, type Context } from "react";

/**
 * What one window drew its items from: a long table's parse, or each item's text as a copy of the
 * drawn item reads, and what a copy of them drawn reads between two items' texts.
 */
export type DrawnWindowSource =
  | { readonly kind: "table"; readonly table: Table }
  | {
      readonly kind: "text";
      readonly itemText: (index: number) => string;
      readonly itemSeparator: string;
    };

/** The sources one feed's windows draw from, by the key their spacers carry. */
export class DrawnWindowSources {
  readonly #sources = new Map<string, DrawnWindowSource>();

  /** Holds `source` under `key`, in place of what the key held, until the key is let go. */
  public hold(key: string, source: DrawnWindowSource): void {
    this.#sources.set(key, source);
  }

  /** Lets the source under `key` go. */
  public release(key: string): void {
    this.#sources.delete(key);
  }

  /** The source under `key`, or `undefined` once it is let go. */
  public sourceOf(key: string): DrawnWindowSource | undefined {
    return this.#sources.get(key);
  }
}

/** The feed's drawn window sources, provided around its viewport; `undefined` outside one. */
export const DrawnWindowSourcesContext: Context<DrawnWindowSources | undefined> = createContext<
  DrawnWindowSources | undefined
>(undefined);

/**
 * The attribute a text window's spacer carries its source's key on, under which the feed holds
 * the items the window draws, so a copy reads the items the spacer stands for from them.
 */
export const UNDRAWN_TEXT_SOURCE_ATTRIBUTE = "data-undrawn-text-source";

/** The attributes a text window's spacer carries the first and last item it stands for on. */
export const FIRST_UNDRAWN_ITEM_ATTRIBUTE = "data-first-undrawn-item";
export const LAST_UNDRAWN_ITEM_ATTRIBUTE = "data-last-undrawn-item";
