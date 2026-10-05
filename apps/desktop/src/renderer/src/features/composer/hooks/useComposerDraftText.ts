// One reading of the composer's line for every zone that needs it (the send bar and the
// discovery popover watch the same key). The reader comes back beside the value because a
// handler must read at call time, not close over the render's value.

import { useCallback, useSyncExternalStore } from "react";

import type { DraftStore } from "#renderer/store/draft-store.js";

/** The composer line's text, and the way to read it again. */
export interface ComposerDraftText {
  /** What the line holds now. Re-rendered on every write to this key. */
  readonly text: string;
  /** The same reading as a callback; a plain string, so a snapshot compare cannot loop. */
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
