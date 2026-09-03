// The collaboration family's own wire vocabulary.
//
// Its BOUNDS are not here. `apps/desktop/AGENTS.md` gives every cap, window, and
// timeout one home — `console/core/constants.ts` — and this family's three moved
// there with their rationales intact, beside the agents, sessions, and settings
// families' own. What is left is the one value that was never a bound: a name the
// control plane synthesizes, which two modules in this family recognise and no
// module outside it spends.
//
// `test/console/architecture/cap-single-home.test.ts` is what keeps that true.

/**
 * The bootstrap channel's name, as the control plane synthesizes it.
 *
 * The main channel has no row of its own — the channel-list projection composes it
 * from the session's own membership count — so the console recognises it by the one
 * thing the wire carries: this name. Recognising it by position would make the
 * ordering rule depend on the order it is trying to impose.
 */
export const MAIN_CHANNEL_NAME = "main";
