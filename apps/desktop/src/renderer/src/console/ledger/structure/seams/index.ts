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

export {
  LedgerSeamIndex,
  SEAM_WIRE_BINDINGS,
  type LedgerSeam,
  type LedgerSeamKind,
} from "./seams.js";
