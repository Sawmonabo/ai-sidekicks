// The scroll seam: the one thing allowed to move the ledger, and how far it may move it.
//
// THE SEAM. A ledger that scrolls from two places scrolls from ten within a release —
// every affordance that wants to bring a row into view writes an offset, and none of
// them can see the reader the others just moved. So this directory owns the single
// controller every caller goes through, the whole-pixel quantization the browser's own
// fractional offsets have to be reconciled against, and the rope smoother that turns a
// jump into a movement a person can follow. What it does NOT own is which rows exist
// (`../viewport/`) or how tall they are (`../measurement/`); it is handed both.
//
// WHAT LEAVES. Four names, and they are the ones the reveal lanes and the viewport hold.
// The quantization learner and the surface fixture stop here, reached by their siblings
// deeply, which is what an intra-family import is for.

export { LedgerScrollController, type LedgerScrollSurface } from "./scroll-chokepoint.js";
export { RopeSmoother, type ProvenAppendToken } from "./rope-smoother.js";
