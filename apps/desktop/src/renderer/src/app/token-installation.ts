// Getting the Meridian tokens and main's appearance record into the document.
//
// The token sheet is generated at mount from `generateMeridianCss()`, not committed as a `.css`
// file, so there is one source of truth for every color and the sheet cannot drift from it. The
// cost is a few kilobytes of string building once per window, before first paint. Installation is
// idempotent by element id, because a second window and a hot reload both re-enter this path.
//
// It lives in `app/` and not `styles/` because it is the one part that touches a `Document`, and
// node-context tooling imports `styles/` with no DOM lib.

import { generateMeridianCss } from "#renderer/styles/generate-css.js";
import { composeRootAppearance, type AppearanceRecord } from "#shared/appearance.js";
import { generateTypefaceCss } from "#renderer/styles/typeface.js";

/** The id the generated sheet is installed under. */
export const MERIDIAN_STYLE_ELEMENT_ID = "meridian-tokens";

/**
 * Install the token sheet into a document. Returns true when it wrote the sheet, false when one
 * was already present.
 */
export function installMeridianTokens(targetDocument: Document): boolean {
  if (targetDocument.getElementById(MERIDIAN_STYLE_ELEMENT_ID) !== null) {
    return false;
  }
  const styleElement = targetDocument.createElement("style");
  styleElement.id = MERIDIAN_STYLE_ELEMENT_ID;
  // The faces lead the sheet for readability; `@font-face` takes part in no cascade.
  styleElement.textContent = `${generateTypefaceCss()}\n\n${generateMeridianCss()}`;
  // Prepended so component stylesheets cascade after the custom properties they read.
  targetDocument.head.prepend(styleElement);
  return true;
}

/**
 * Apply main's appearance record to the document root, as main stamped it on the served document.
 *
 * Under `"system"` the scheme attribute is removed rather than a resolved value written: the
 * sheet's `prefers-color-scheme` layer is guarded by `:root:not([data-color-scheme="light"])`, so
 * with no attribute the OS keeps deciding, including after a later change.
 */
export function applyAppearance(targetDocument: Document, record: AppearanceRecord): void {
  const root = targetDocument.documentElement;
  const { attributes, styleProperties } = composeRootAppearance(record);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined) {
      root.removeAttribute(name);
    } else {
      root.setAttribute(name, value);
    }
  }
  for (const [name, value] of Object.entries(styleProperties)) {
    root.style.setProperty(name, value);
  }
}
