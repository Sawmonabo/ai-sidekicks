// The viewport seam: which rows exist right now, and what the surface is showing of them.
//
// THE SEAM. This is where the window is decided — the virtualizer binding, the pruning
// cycle and the cap that bound how much of a long log is ever mounted, the snapshot a
// row body reads its own position out of, and the controller that is the only module
// holding the four collaborators at once (the chokepoint, the anchor, the measurement
// ledger, and the cap). They are separately testable and jointly useless: a surface that
// wanted the anchor without the chokepoint would be asking to decide where a reader is
// standing and then be unable to keep them there.
//
// WHAT LEAVES. The three shapes a reader of the window speaks — the visible range, one
// row, and the whole snapshot. The binding itself does NOT: the only thing that holds one
// is the component declared beside it, which reaches it directly, and a door line no
// reader outside this seam consumes is a symbol published ahead of its consumer. The
// controller, the prune cycle, the cap and the virtualizer seams stop here too; the
// family door publishes the two hooks and the component from their own declaring modules,
// which is what keeps a symbol's home one hop away rather than two.

export { type LedgerVisibleRowRange } from "./viewport-binding.js";
export { type LedgerViewportRow, type LedgerViewportSnapshot } from "./viewport-snapshot.js";
