// The sidebar's named constants — the ones that are not bounds.
//
// The width range moved to `console/core/constants.ts`: a ceiling declared in a view
// family is one nobody audits, which is what `apps/desktop/AGENTS.md` §Config
// single-sourcing states and `cap-constant-home.test.ts` enforces. What is left is a
// STEP and two persistence keys, neither of which is a bound.
//
// The keys live here for a reason beyond tidiness: a key is a record ADDRESS, and
// the sidebar writes at one address and reads back at the same one. Two spellings of
// one address is a setting that saves and never restores, which is invisible until a
// person reopens the window.

/** How far one arrow-key press moves the resize separator. Small enough to land
 *  on a chosen width, large enough that crossing the whole range is a held key
 *  rather than a hundred presses. */
export const SIDEBAR_WIDTH_KEYBOARD_STEP_PX = 16;

/**
 * Where the collapsed-section set is written, inside the session's partition.
 *
 * SESSION-scoped rather than window-scoped because which sections are worth
 * looking at is a property of the session: a session mid-run wants Runs open and
 * a session being reviewed wants Repos, and one window switching between them
 * should not carry the first session's shape into the second.
 */
export const SIDEBAR_COLLAPSED_SECTIONS_KEY = "sidebar.collapsed-sections";

/**
 * Where the sidebar's width is written, in the global partition.
 *
 * WINDOW-scoped, unlike the collapsed set, and the split is deliberate: a width
 * is a property of the person's screen and their eyes, and re-learning it per
 * session would make every newly opened session feel like a different app.
 */
export const SIDEBAR_WIDTH_KEY = "sidebar.width";
