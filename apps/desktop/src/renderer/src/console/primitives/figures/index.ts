// The figures sub-module door: what a SIBLING inside `primitives/` takes from here.
//
// Everything in this directory is one concern — a wire value on screen. The formatter
// chokepoint that `apps/desktop/AGENTS.md` names, the `Intl` instance cache beside it,
// and the components that wear a formatted value: the two figure spans, the chip, the
// glyph, the ledger row, and the choice list.
//
// WHY THIS DIRECTORY CARRIES A DOOR AND MOST DO NOT. The rule is one edge: a
// sub-module publishes exactly what a sibling reads, and a directory no sibling reads
// from carries no `index.ts` at all. Five siblings read from this one — `absence/`
// takes `Glyph` and `formatCount`, `posture/` takes `Chip` and the two figures,
// `reading/` takes `DerivedFigure` and `formatCount`, `refusal/` takes `Glyph`,
// `WireFigure`, and `formatWireString`, and `restore/` takes all six between its three
// components — so the set below is measured rather than symmetrical. A name only the
// family door publishes (`LedgerRow`, `WireChoiceList`, the rest of the formatter
// table) is deliberately absent: `primitives/index.ts` re-exports from the module that
// DECLARES it, so it never reaches for this file, and a line here for a name no sibling
// takes is a dead export the barrel census fails.
//
// AND THE SHEETS ENTER HERE, because a directory carrying a door owns its own rules —
// `apps/desktop/AGENTS.md` keys that on the owner and not on depth, so the family door
// reaching in is a misowned sheet. `accent-fill.css` left with `accent-fill.ts` for
// the other half of the same rule: the class it declares has no reader on this door's
// static graph, so the sheet belongs where its one reader is, at the family root.
// The order is the one these five held on the family door.

import "./glyph.css";
import "./figure.css";
import "./chip.css";
import "./choice-list.css";
import "./ledger-row.css";

export type { ChipTone } from "./Chip.js";
export { Chip } from "./Chip.js";
export { DerivedFigure } from "./DerivedFigure.js";
export { Glyph } from "./Glyph.js";
export { WireFigure } from "./WireFigure.js";
export { formatCount, formatWireString } from "./wire-figures.js";
