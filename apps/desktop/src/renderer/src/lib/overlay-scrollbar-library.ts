// The overlay scrollbar library, one copy in each window document. The console document renders
// every window's tree but never paints, so a copy loaded there would observe sizes and pace its
// frames by a page that never draws, and its bars would never start. Each window document loads
// the library's browser bundle as a script of its own, which runs in that window's realm and sets
// `OverlayScrollbarsGlobal` there. The script element carries its own load state, so a reader in
// any window finds the copy through the document and no registry of windows is kept.

import libraryUrl from "overlayscrollbars/browser/overlayscrollbars.browser.es6.min.js?url";
import type * as OverlayScrollbarLibraryModule from "overlayscrollbars";

/** The library's exports, as its browser bundle sets them on a window. */
export type OverlayScrollbarLibrary = typeof OverlayScrollbarLibraryModule;

/** Load the library into a window document once; idempotent by the script element's id. */
export function installOverlayScrollbarLibrary(windowDocument: Document): void {
  if (windowDocument.getElementById(LIBRARY_SCRIPT_ID) !== null) {
    return;
  }
  const script = windowDocument.createElement("script");
  script.id = LIBRARY_SCRIPT_ID;
  script.src = libraryUrl;
  script.addEventListener(
    "load",
    () => {
      // The track pages when pressed, which the library does only with this plugin registered.
      const library = libraryOf(windowDocument);
      library.OverlayScrollbars.plugin(library.ClickScrollPlugin);
      script.dataset[LOAD_STATE_KEY] = "loaded";
    },
    { once: true },
  );
  script.addEventListener(
    "error",
    () => {
      script.dataset[LOAD_STATE_KEY] = "failed";
    },
    { once: true },
  );
  windowDocument.head.append(script);
}

/**
 * The document's copy of the library once it has loaded; `undefined` for a document that was
 * never given one, whose scrollers keep the platform's bar. Rejects when the script failed to load.
 */
export function loadOverlayScrollbarLibrary(
  windowDocument: Document,
): Promise<OverlayScrollbarLibrary> | undefined {
  const script = windowDocument.getElementById(LIBRARY_SCRIPT_ID);
  if (script === null) {
    return undefined;
  }
  return new Promise((resolve, reject) => {
    const settle = (): void => {
      if (script.dataset[LOAD_STATE_KEY] === "failed") {
        reject(new Error(`The overlay scrollbar library did not load from ${libraryUrl}.`));
      } else {
        resolve(libraryOf(windowDocument));
      }
    };
    if (script.dataset[LOAD_STATE_KEY] !== undefined) {
      settle();
      return;
    }
    // Heard after the installer's own listeners, so the state and the plugin are in place.
    script.addEventListener("load", settle, { once: true });
    script.addEventListener("error", settle, { once: true });
  });
}

/** The id of the script element that loads the library into a window document. */
const LIBRARY_SCRIPT_ID = "meridian-overlay-scrollbar-library";

/** The script element's `data-*` key holding `loaded` or `failed` once it has settled. */
const LOAD_STATE_KEY = "loadState";

/** The window a document's copy of the library set its exports on. */
interface WindowWithOverlayScrollbarLibrary extends Window {
  readonly OverlayScrollbarsGlobal?: OverlayScrollbarLibrary;
}

/** The library a loaded script set on its document's window. Throws when it set none. */
function libraryOf(windowDocument: Document): OverlayScrollbarLibrary {
  const view = windowDocument.defaultView as WindowWithOverlayScrollbarLibrary | null;
  const library = view?.OverlayScrollbarsGlobal;
  if (library === undefined) {
    throw new Error("The overlay scrollbar library loaded without setting its global.");
  }
  return library;
}
