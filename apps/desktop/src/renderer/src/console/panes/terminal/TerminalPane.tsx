// The terminal pane's body — the fixture shell the lease line is built into.
//
// SHELL, WITH A DELETION OBLIGATION. `Plan-023 §Console growth slate` row 3 (the
// terminal pane as a renderer surface, with the shared-terminal write lease's
// renderer obligations) is unregistered, so the pane has no output stream, no
// scrollback, and — the part that decides what this body may render — no holder.
// The emulator, the watch mode, the claim control, and the transition ledger of
// `Spec-023 §Console Design (Meridian)` 8.8 land on top of this shell in the same
// task once that row leaves the slate; this absence is deleted then, not kept
// beside them.
//
// WHY NO CLAIM CONTROL, AND WHY THAT IS NOT A DERIVATION. 8.8 is explicit that the
// holder is a wire field and is never derived from the last observed claim, and
// that a holder the control plane cannot vouch for is not shown at all. A claim
// control offered here would have nothing to compare against and no transition to
// render, so the console would be inventing a lease state it has never read. The
// pane therefore offers the one thing it can say truthfully: that the lease has not
// been read. Offering the control is the wire's arrival, not this shell's.
//
// WHY `not-checked` AND NOT `empty`. A free lease is an explicit unheld state that
// 8.8 requires to read differently from a suppressed one, and "unheld" is a fact a
// read establishes. Nothing has been read, so neither state may be shown; the
// dotted boundary is the third answer both of them are distinct from.
//
// The pane takes no context, for `BrowserPane`'s reason: V1 has exactly one
// terminal per session, so the address carries no entity, and every store on the
// context is one this shell has no read to project into.

import { Nothing } from "../../primitives/index.js";

/** The pane region's accessible name. The holder line's own label arrives with it. */
const TERMINAL_PANE_LABEL = "Terminal";

export function TerminalPane(): React.JSX.Element {
  return (
    <section aria-label={TERMINAL_PANE_LABEL}>
      <Nothing
        kind="not-checked"
        placement="surface"
        title="The terminal lease has not been read."
        detail="The shared terminal's renderer surface is not registered yet, so the console has not asked who holds the write lease. That is not the same as the lease being free, and this pane will not guess which it is."
      />
    </section>
  );
}
