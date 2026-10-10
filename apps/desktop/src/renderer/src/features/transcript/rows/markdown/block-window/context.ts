// How far a window nested in a transcript row draws past the scroller's edges, as the viewport's
// render draws its rows. Outside a viewport there is none.

import { createContext, type Context } from "react";

import { type DrawnBandScreenHeights } from "#renderer/features/transcript/viewport/drawn-band.js";

/**
 * How far beyond each edge of the scroller a windowed body draws its items, in screen heights, as
 * the viewport's render draws its rows; the same object until a side changes. Apart from the
 * viewport's value, so a band that moves draws again only the windows that read it, in the same
 * render as the rows. `undefined` outside a viewport.
 */
export const DrawnBandContext: Context<DrawnBandScreenHeights | undefined> = createContext<
  DrawnBandScreenHeights | undefined
>(undefined);
