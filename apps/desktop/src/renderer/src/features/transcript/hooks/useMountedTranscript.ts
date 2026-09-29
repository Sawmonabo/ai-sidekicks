import { useEffect, useMemo, useRef } from "react";

import {
  mountedTranscript,
  type TranscriptActs,
  type MountedTranscript,
} from "../mounted-transcript.js";

/**
 * Hold the seat for as long as this component is mounted.
 *
 * The acts are read at act time through a ref rather than adopted directly: a feed
 * rebuilds its callbacks on every render, and adopting the object itself would either
 * re-seat the transcript on each pass or keep the first render's callbacks.
 */
export function useMountedTranscript(
  acts: TranscriptActs,
  seat: MountedTranscript = mountedTranscript,
): void {
  const actsRef = useRef(acts);
  actsRef.current = acts;
  const forwarding = useMemo(() => forwardingActs(() => actsRef.current), []);
  useEffect(() => seat.adopt(forwarding), [seat, forwarding]);
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
