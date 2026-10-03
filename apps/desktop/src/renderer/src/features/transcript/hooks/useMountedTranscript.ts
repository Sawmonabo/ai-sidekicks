import { useEffect, useMemo, useRef } from "react";

import {
  forwardActs,
  mountedTranscript,
  type TranscriptActs,
  type MountedTranscript,
} from "../mounted-transcript.js";

/**
 * Makes this feed the mounted transcript while the component is mounted.
 *
 * Acts are read through a ref at act time: a feed rebuilds its callbacks every render, and
 * adopting the object itself would re-adopt each pass or keep the first render's callbacks.
 */
export function useMountedTranscript(
  acts: TranscriptActs,
  transcript: MountedTranscript = mountedTranscript,
): void {
  const actsRef = useRef(acts);
  actsRef.current = acts;
  const forwarding = useMemo(
    () =>
      forwardActs((act) => {
        actsRef.current[act]();
      }),
    [],
  );
  useEffect(() => transcript.adopt(forwarding), [transcript, forwarding]);
}
