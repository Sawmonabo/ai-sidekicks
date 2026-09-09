// The typeface every screenshot capture is taken under.
//
// WHY THE TIER PINS A FACE AT ALL, WHEN IT ALREADY PINS A RUNNER.
//
// `console/tokens/typography.ts` ships the monospace stack `"IBM Plex Mono",
// ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", monospace`. When these
// references were minted nothing self-hosted IBM Plex, so the face that actually
// rendered was whichever of the remaining entries the capture host had activated —
// and on the runner that owns these references that answer is not the same from one
// run to the next. Two runs of the SAME tree on the same runner image were measured
// rendering the same surfaces two ways:
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
// THE SANS STACK IS DELIBERATELY NOT PINNED, AND NO LONGER NEEDS TO BE. When these
// references were minted its only by-name entry was a face present on no capture
// host, so every host fell through to a generic and the hazard had no instance.
// `console/frame/bindings/typeface.ts` now self-hosts both families — one variable
// file each, emitted by the build — which settles the same question in the stronger
// direction: the face is a property of the build rather than of the host, on every
// platform, which is what a pin was ever for.
//
// THE COMMITTED REFERENCES PREDATE THAT, AND THE MONO PIN OUTLIVED ITS PREMISE.
// Measured on 2026-09-09 over the 64 references then committed, all but two differ
// from what the console now renders, in two groups and no others: 38 because sans
// resolves to the self-hosted face rather than to the host's generic, and 24 more
// because the slashed zero is now declared on `body`. (That reading was taken while
// the console still shipped six static cuts; it now ships one variable file per
// family, which moves nothing about WHY the references drifted — the same faces
// resolve and the same feature is declared — and adds one more surface that can
// move, the weight 640 `palette/palette.css` asks for and now really gets.) The two
// that remain are a 1 px and a 3 px keycap-glyph difference — this host against the
// runner, which is the residue this tier already expects. Re-minting the corpus on
// the pinned runner
// is therefore one pass, and retiring the monospace pin belongs to it: with the
// face self-hosted, this constant now overrides a face that SHIPS rather than one
// the host happened to supply, so a capture taken through it is a picture of Menlo
// and the product is set in IBM Plex Mono. Both halves move together or the corpus
// is re-minted twice.

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
