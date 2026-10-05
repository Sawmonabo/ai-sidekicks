// What a window's blank document is given before anything is drawn in it: the console document's
// language, the Meridian token sheet and the element the window's tree is drawn into, the same
// `#root` the console document has, so the base sheet sizes it as it sizes that one.

import { installMeridianTokens } from "./token-installation.js";

/** The id of the element a window's tree is drawn into. */
const WINDOW_ROOT_ELEMENT_ID = "root";

/** Put the language, the token sheet and the mount point into a window's document; idempotent. */
export function prepareWindowDocument(windowDocument: Document): void {
  // A blank document declares no language, and a screen reader then guesses how to read it.
  windowDocument.documentElement.lang = document.documentElement.lang;
  installMeridianTokens(windowDocument);
  if (windowDocument.getElementById(WINDOW_ROOT_ELEMENT_ID) === null) {
    const root = windowDocument.createElement("div");
    root.id = WINDOW_ROOT_ELEMENT_ID;
    windowDocument.body.append(root);
  }
}

/** The element a prepared window's tree is drawn into. Throws for a document never prepared. */
export function windowMountPoint(windowDocument: Document): HTMLElement {
  const root = windowDocument.getElementById(WINDOW_ROOT_ELEMENT_ID);
  if (root === null) {
    throw new Error("A window's document was drawn into before it was prepared.");
  }
  return root;
}
