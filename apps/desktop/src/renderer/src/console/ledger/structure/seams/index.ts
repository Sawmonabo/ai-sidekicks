// The seam seam: where a run's work begins and ends, and which rows a later epoch retired.
//
// THE SEAM THIS DIRECTORY OWNS. A ledger is one long list until something says where the
// boundaries are — this run started here, that one was paused, an epoch superseded
// everything between these two positions. The classification of those boundaries, the
// row that draws one, and the superseded-band derivation are one job, and it is the job
// every other group here consults rather than repeats: the rail marks seams, replay jumps
// between them, and the chapters fold around them.
//
// WHAT LEAVES. The index and the shape it answers with, which the rail and the replay
// engine both hold. `SeamRow` and the superseded bands are published by the family door
// from their own declaring modules, so a symbol's home stays one hop from its reader.
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

export { LedgerSeamIndex, type LedgerSeam } from "./seams.js";
export { SEAM_WIRE_BINDINGS, type LedgerSeamKind } from "./seam-vocabulary.js";
