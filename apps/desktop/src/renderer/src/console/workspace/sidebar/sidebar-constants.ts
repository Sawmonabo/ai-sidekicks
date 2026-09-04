// The sidebar's named bounds.
//
// `console/core/constants.ts` is the substrate's home for these and its header
// says where a view family's go: "each view family adds its own module beside its
// subtree rather than widening this one, so a bound always sits next to the code
// that spends it". This is that module for the sidebar. Every value carries the
// one-line rationale `Spec-023 §Console Design (Meridian)` §The four bars asks
// for; a number appearing inline in a sidebar module instead of here is a review
// rejection.
//
// The persistence KEYS live here for a second reason beyond tidiness: a key is a
// record ADDRESS, and the sidebar writes at one address and reads back at the
// same one. Two spellings of one address is a setting that saves and never
// restores, which is invisible until a person reopens the window.

/** How wide the sidebar opens when nobody has resized it. Wide enough for a
 *  section title plus its count without wrapping at the default type scale. */
export const SIDEBAR_DEFAULT_WIDTH_PX = 288;

/** The narrowest the sidebar may be dragged. Below this the disclosure glyph,
 *  the section glyph, and a two-word title stop fitting on one line, and the
 *  sidebar becomes a column of ellipses rather than a navigation. */
export const SIDEBAR_MIN_WIDTH_PX = 208;

/** The widest. Past this the sidebar is competing with the deck for the window
 *  rather than pointing into it, and this sidebar's density rule is counts, not
 *  lists. */
export const SIDEBAR_MAX_WIDTH_PX = 480;

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
