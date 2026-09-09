// A document that reports a given focus, for the length of one construction.
//
// AT THE FAMILY ROOT AND NOT IN `shell/`, for `session-event.test-support.ts`'s reason:
// the sessions family's attention-notifier suite reports a focus through it beside
// `shell/frame-store.test.ts`.
//
// `FrameStore` seeds `isWindowFocused` from its own document, so a case about a window
// that opened unfocused has to make the document say so — the shim this tier runs
// under reports a focused, visible document, which is the state a shipped window is in
// most of the time and exactly the one the defect hid behind.
//
// BOTH READINGS MOVE TOGETHER, because the store reads both and a case that moved one
// alone would be asserting against a document state no host produces: a window is not
// both hidden and holding the keyboard.
//
// SCOPED TO A CONSTRUCTION RATHER THAN INSTALLED FOR A FILE, because the seed is read
// once, in the constructor. A stub left standing for a whole case would also be
// answering the frame's own listeners and every other reader in the tree, which is a
// wider claim than any case here makes.
//
// OWN PROPERTIES SHADOWING THE PROTOTYPE'S, and removed rather than written back:
// `hasFocus` is a method and `visibilityState` an accessor, both declared on
// `Document.prototype` by every DOM this console runs under, so there is nothing on the
// instance to restore TO and assigning the previous answer back would leave a frozen
// copy of it behind as an own property.

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

/** A window that is not on screen at all — minimised, or opened without being shown. */
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
