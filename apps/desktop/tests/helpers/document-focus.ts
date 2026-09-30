// A document that reports a given focus, for the length of one construction.
//
// `WindowStore` seeds `isWindowFocused` from its own document, so a case about a window that opened
// unfocused has to make the document say so; the DOM shim reports a focused, visible document.
// Both readings move together because the store reads both and no host produces a document that
// is hidden and holding the keyboard.
//
// The stub is scoped to a construction because the seed is read once, in the constructor, and a
// stub left standing would also answer every other reader in the tree. The own properties shadow
// `Document.prototype`'s `hasFocus` method and `visibilityState` accessor and are deleted rather
// than written back, since there is no instance value to restore.

/** What a document says about this window. Both members, because the store reads both. */
export interface DocumentFocusReading {
  readonly hasFocus: boolean;
  readonly visibilityState: "visible" | "hidden";
}

/** A window a person is looking at. What every DOM shim in this tier reports by default. */
export const FOCUSED_DOCUMENT: DocumentFocusReading = {
  hasFocus: true,
  visibilityState: "visible",
};

/** A window that is on screen and does not hold the keyboard — beside a focused one. */
export const UNFOCUSED_DOCUMENT: DocumentFocusReading = {
  hasFocus: false,
  visibilityState: "visible",
};

/** A window that is not on screen at all — minimized, or opened without being shown. */
export const HIDDEN_DOCUMENT: DocumentFocusReading = {
  hasFocus: false,
  visibilityState: "hidden",
};

/**
 * Build something under a document reporting `reading`, then put the document back.
 *
 * Synchronous on purpose: what it exists to scope is a constructor, and a body that
 * awaited would leave the stub answering every other reader for as long as it ran.
 */
export function underDocumentFocus<TResult>(
  reading: DocumentFocusReading,
  build: () => TResult,
): TResult {
  Object.defineProperty(document, "hasFocus", {
    configurable: true,
    value: () => reading.hasFocus,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => reading.visibilityState,
  });
  try {
    return build();
  } finally {
    Reflect.deleteProperty(document, "hasFocus");
    Reflect.deleteProperty(document, "visibilityState");
  }
}
