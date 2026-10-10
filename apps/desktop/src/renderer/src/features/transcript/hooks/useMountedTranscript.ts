import { useEffect, useMemo, useRef } from "react";

import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";

import {
  forwardActs,
  mountedTranscript,
  type MountedTranscript,
  type TranscriptActs,
  type TranscriptAdoption,
} from "../mounted-transcript.js";

/**
 * Makes this feed its window's mounted transcript while the component is mounted, and keeps the
 * holder told whether the feed's transcript holds a run group.
 *
 * Acts are read through a ref at act time: a feed rebuilds its callbacks every render, and
 * adopting the object itself would re-adopt each pass or keep the first render's callbacks.
 */
export function useMountedTranscript(
  acts: TranscriptActs,
  holdsRunGroup: boolean,
  transcript: MountedTranscript = mountedTranscript,
): void {
  const ownerDocument = useOwnerWindow().document;
  const actsRef = useRef(acts);
  actsRef.current = acts;
  const holdsRunGroupRef = useRef(holdsRunGroup);
  holdsRunGroupRef.current = holdsRunGroup;
  const forwarding = useMemo(
    () =>
      forwardActs((act) => {
        actsRef.current[act]();
      }),
    [],
  );
  const adoptionRef = useRef<TranscriptAdoption | undefined>(undefined);
  useEffect(() => {
    const adoption = transcript.adopt(forwarding, ownerDocument, holdsRunGroupRef.current);
    adoptionRef.current = adoption;
    return () => {
      adoptionRef.current = undefined;
      adoption.release();
    };
  }, [transcript, forwarding, ownerDocument]);
  useEffect(() => {
    adoptionRef.current?.publishHoldsRunGroup(holdsRunGroup);
  }, [holdsRunGroup]);
}
