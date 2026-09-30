import { useEffect, useMemo, useRef } from "react";

import {
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
  const forwarding = useMemo(() => forwardingActs(() => actsRef.current), []);
  useEffect(() => transcript.adopt(forwarding), [transcript, forwarding]);
}

/** An act set that reads the live one on every call and holds none of it. */
function forwardingActs(read: () => TranscriptActs): TranscriptActs {
  return {
    openFind: () => {
      read().openFind();
    },
    stepFindNext: () => {
      read().stepFindNext();
    },
    stepFindPrevious: () => {
      read().stepFindPrevious();
    },
    jumpToLatest: () => {
      read().jumpToLatest();
    },
    foldEveryRun: () => {
      read().foldEveryRun();
    },
  };
}
