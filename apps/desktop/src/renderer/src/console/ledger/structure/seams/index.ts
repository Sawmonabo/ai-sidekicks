// The seam seam: where a run's work begins and ends, and which rows a later epoch retired.
//
// THE SEAM THIS DIRECTORY OWNS. A ledger is one long list until something says where the
// boundaries are — this run started here, that one was paused, an epoch superseded
// everything between these two positions. The classification of those boundaries, the
// row that draws one, and the superseded-band derivation are one job, and it is the job
// every other group here consults rather than repeats: the chapters fold around the
// boundaries this directory classifies.
//
// WHAT LEAVES. The two rows a sibling under `pane/` draws and the band collapse state it
// holds. The seam INDEX and its vocabulary stop here: their one reader outside this
// directory is the family door, which must reach a declaring module or
// `console-no-barrel-chain` reports the second hop.
//
// AND `SeamRow` LEAVES THROUGH HERE TOO, WHICH IS WHAT MAKES THE SHEET USABLE. It used
// to be published by the family door from its declaring module, and this door published
// a vocabulary and no component — so nothing statically reachable from the barrel that
// OWNS `seams.css` could render a single rule in it, which is a sheet every session
// downloads and parses for a surface its own door cannot draw. Publishing the row here
// costs nothing (the family door reaches this directory either way) and puts the sheet,
// its renderer, and the door that imports it in one place.

// The sheet this directory owns, imported by its own door.
import "./seams.css";

export { SeamRow } from "./SeamRow.js";
export { SupersededBandRow } from "./SupersededBandRow.js";

export { SupersededBandCollapseState } from "./superseded-band-collapse.js";
