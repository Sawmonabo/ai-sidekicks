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
// TWO GROUPS, NEITHER WITH A DOOR. `cycle/` is the reconcile pass and everything that
// decides what the window holds over time — the controller, the prune cycle it drives,
// the head-growth count, the deferred position work a commit performs, the idle trim,
// and the cap itself. `surface/` is what the viewport publishes and renders — the
// component, the empty window and its words, the binding hook, the publication, the
// snapshot, and the virtualizer's own seams. Neither carries an `index.ts`: the two read
// each other in BOTH directions (the binding holds the controller and the snapshot reads
// the cap's row shape, while the controller reads the publication, the snapshot, and the
// virtualizer seams), so a pair of doors would be a pair of mutually reading barrels
// where the deep intra-family specifier is the shape this package asks for. This door
// re-exports from the declaring module in either group, which is what keeps it one hop.
//
// WHAT LEAVES. The three shapes a reader of the window speaks — the visible range, one
// row, and the whole snapshot. The binding itself does NOT: the only thing that holds one
// is the component declared beside it, which reaches it directly, and a door line no
// reader outside this seam consumes is a symbol published ahead of its consumer. The
// controller, the prune cycle, the cap and the virtualizer seams stop here too; the
// family door publishes the two hooks and the component from their own declaring modules,
// which is what keeps a symbol's home one hop away rather than two.

export {
  type LedgerViewportRow,
  type LedgerViewportSnapshot,
} from "./surface/viewport-snapshot.js";
