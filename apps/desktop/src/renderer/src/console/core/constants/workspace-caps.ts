// The workspace chrome's bound: the deck's restored pane cap.

/**
 * Panes one saved deck layout may restore.
 *
 * This family's own decision, like the third of the three restore rules
 * `workspace/deck/model/deck-snapshot.ts` states — no committed document fixes the
 * number, and the cap is about untrusted input rather than performance: a persisted
 * record is a file on disk, and without a bound a corrupted or hand-edited one mounts
 * panes until the window stops responding. Twelve is past any arrangement a person
 * builds on a display the density presets below are drawn for, so the cap binds a
 * defect and never a session.
 */
export const DECK_RESTORED_PANE_CAP = 12;
