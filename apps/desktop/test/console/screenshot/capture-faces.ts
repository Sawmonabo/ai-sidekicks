// The typeface every screenshot capture is taken under.
//
// WHY THE TIER PINS A FACE AT ALL, WHEN IT ALREADY PINS A RUNNER.
//
// `console/tokens/palette.ts` ships the monospace stack `"IBM Plex Mono",
// ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", monospace`. Nothing
// self-hosts IBM Plex yet, so the face that actually renders is whichever of the
// remaining entries the capture host has activated — and on the runner that owns
// these references that answer is not the same from one run to the next. Two runs
// of the SAME tree on the same runner image were measured rendering the same
// surfaces two ways:
//
//   • a 0.600-advance face whose zero carries no slash, and
//   • Menlo, whose advance is 1233/2048 em and whose zero is slashed by default.
//
// A 0.002 em difference sounds like nothing and is not: it moves the browser
// capture card's `Open preview` control one pixel to the right, and it grows the
// terminal pane by 24 px, which is its 24-row grid one pixel taller per row. Both
// modes reached the committed set — the browser and terminal references were
// minted under the first, the repos references under the second — so the tier
// could not be green under either, and each regeneration merely moved which half
// of the corpus was wrong.
//
// A runner pin cannot fix that, because the variance is WITHIN the pinned runner.
// The condition the tier was missing is this one: the face is stated here rather
// than inherited from whatever the host happened to have registered when Chromium
// built its font cache. Menlo is the value because it is the one monospace face
// macOS registers system-wide on every install — it is present in both observed
// modes, which is measured rather than assumed — and because it is the mode the
// larger half of the committed corpus already carries.
//
// THE SANS STACK IS DELIBERATELY NOT PINNED. Its only by-name entry is a face that
// is present on no capture host, and every entry after it is a generic that always
// resolves, so it has rendered identically in every run observed — the two modes
// above are byte-identical outside monospace text. Pinning it anyway would re-mint
// every committed reference in the repository to close a hazard with no instance.
// If one ever appears, it is a sibling constant and one more line in the setup.

/**
 * The stack every capture renders monospace text under.
 *
 * `monospace` rides behind Menlo as the last resort for a glyph Menlo does not
 * carry, which is the same tail the shipped stack ends on — the pin narrows which
 * face is chosen, it does not remove the floor beneath it.
 */
export const CAPTURE_MONOSPACE_STACK = "Menlo, monospace";

/**
 * Menlo's advance, in em, as the face itself states it: 1233 units on a 2048-unit
 * em square. The number is here rather than inside the test because it is what
 * makes the pin CHECKABLE — a run that resolved some other monospace face lands on
 * 0.600 and misses this by ten times the tolerance the assertion allows.
 */
export const CAPTURE_MONOSPACE_ADVANCE_EM: number = 1233 / 2048;

/** The custom property the console's own stylesheets read monospace text from. */
export const MONOSPACE_FONT_CUSTOM_PROPERTY = "--meridian-font-mono";

/**
 * Hold the capture's monospace face steady for one document.
 *
 * Written as an inline property on the root element rather than as another
 * stylesheet, because the token sheet defines the same custom property on `:root`
 * and the two would then be decided by injection order — which is the class of
 * accident this module exists to end. An inline declaration on the element the
 * sheet targets wins outright, and every descendant inherits it, so a surface
 * mounted anywhere under the document reads the pinned stack without knowing that
 * anything was pinned.
 */
export function pinCaptureFaces(targetDocument: Document): void {
  targetDocument.documentElement.style.setProperty(
    MONOSPACE_FONT_CUSTOM_PROPERTY,
    CAPTURE_MONOSPACE_STACK,
  );
}
