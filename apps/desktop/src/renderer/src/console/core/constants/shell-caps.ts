// The shell's own bound: what the restart confirmation names before it counts.

// It is not here. `DAEMON_SHUTDOWN_FLUSH_BUDGET_MS` is declared in
// `src/shared/shutdown-budget.ts`, because main races the quit drain against the same
// figure the console's restart confirmation quotes, and `src/shared/` is the only home
// both processes can reach. This home's rule — caps live here — governs the console's
// own bounds, and the shell's budget stopped being one the day main became its other
// reader. The door re-publishes it, so a console reader still takes it from `core/`.

/**
 * Run ids named in the restart confirmation before the rest is a count.
 *
 * A SIBLING OF `AWAITING_RUN_IDS_NAMED_CAP` AND NOT THAT CAP. Both bound the same
 * job — ids enumerated in a sentence before the rest becomes a figure — and they are
 * two constants because they bound two different surfaces: that one is a line under
 * a pane that already holds up to two hundred rows, and this one is a paragraph
 * inside a dialog that must be readable in one glance before a person presses a
 * button they cannot take back. Sharing one number would tie the width of a
 * consequence sentence to the width of a pane's footnote, and the day either moves
 * the other would move with it for no reason anybody could state.
 *
 * Three rather than six for exactly that reason: past a few ids the enumeration
 * stops being a lookup and becomes hex the reader skips, and what a person is
 * deciding here is answered by the COUNT — which names every moving run, seated or
 * not, so nothing disappears from the reading.
 */
export const INTERRUPTED_RUN_IDS_NAMED_CAP = 3;
