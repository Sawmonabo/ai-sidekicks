// One reading of the composer's line, for every zone that needs it.
//
// The send bar and the discovery popover both watch the SAME key in the same store,
// and both had written the same three lines to do it: a `subscribe` callback, a
// value-stable `read`, and a `useSyncExternalStore` over the pair. Two copies of one
// subscription is two answers to "what has the person typed" the day either one is
// tuned — and the host's own header already states why that must never happen, since
// the popover is handed the region and OBSERVES the line rather than being given a
// copy of its value.
//
// THE READER COMES BACK BESIDE THE VALUE. Both callers need the reading twice: once
// as a rendered value, and once inside a handler that must read at CALL time rather
// than close over the value the render that made it saw. The popover's dismissal is
// the sharp case — it records the text it was dismissed at, and a stale close-over
// would key the dismissal to a string the person has already typed past.

import { useCallback, useSyncExternalStore } from "react";

import type { DraftStore } from "../../console/persistence/index.js";

/** The composer line's text, and the way to read it again. */
export interface ComposerDraftText {
  /** What the line holds now. Re-rendered on every write to this key. */
  readonly text: string;
  /**
   * The same reading, as a callback.
   *
   * Value-stable: a plain string rather than the store entry, so a snapshot
   * `useSyncExternalStore` compares by identity has nothing to loop on.
   */
  readonly read: () => string;
}

/** Subscribe to one draft key and read its text. */
export function useComposerDraftText(draftStore: DraftStore, draftKey: string): ComposerDraftText {
  const subscribe = useCallback(
    (onDraftChanged: () => void) => draftStore.subscribe(draftKey, onDraftChanged),
    [draftStore, draftKey],
  );
  const read = useCallback(() => draftStore.read(draftKey)?.text ?? "", [draftStore, draftKey]);
  const text = useSyncExternalStore(subscribe, read, read);
  return { text, read };
}
