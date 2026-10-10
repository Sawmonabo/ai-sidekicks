import { useCallback, useSyncExternalStore } from "react";

import { mountedTranscript } from "../mounted-transcript.js";

/**
 * Whether the transcript mounted in the window `ownerDocument` belongs to holds a run group, kept
 * current as feeds mount, unmount and gain or lose their run groups. False with none mounted.
 */
export function useTranscriptHoldsRunGroup(ownerDocument: Document): boolean {
  const subscribe = useCallback(
    (listener: () => void) => mountedTranscript.subscribe(listener),
    [],
  );
  const readHoldsRunGroup = useCallback(
    () => mountedTranscript.holdsRunGroup(ownerDocument),
    [ownerDocument],
  );
  return useSyncExternalStore(subscribe, readHoldsRunGroup);
}
