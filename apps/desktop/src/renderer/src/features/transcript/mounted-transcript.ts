// The seam between a chord and a mounted feed. Commands are contributed before any feed
// exists, so a feed adopts this holder while mounted and commands resolve their target at
// press time. The newest mount is the target; release is by identity, so a strict-mode double
// mount or route change cannot leave a gone feed adopted. Module scope is one window.

import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import type { Unsubscribe } from "@shared/preload-api.js";

/**
 * The acts a mounted transcript offers, one function per command, named for the act rather
 * than the control. Declared beside the holder so commands and feed do not import each other.
 */
export interface TranscriptActs {
  readonly openFind: () => void;
  readonly stepFindNext: () => void;
  readonly stepFindPrevious: () => void;
  readonly jumpToLatest: () => void;
  readonly foldEveryRun: () => void;
}

/** One act, by name. Every member is a niladic call, so the name is the whole request. */
export type TranscriptActName = keyof TranscriptActs;

/** What asking the mounted transcript to perform an act produced. */
export type TranscriptActOutcome =
  | { readonly status: "performed"; readonly act: TranscriptActName }
  | { readonly status: "refused"; readonly refusal: Refusal };

/**
 * An act set whose every act hands its name to `perform`. Written out rather than derived from
 * a name list, so an act added to `TranscriptActs` fails to compile here.
 */
export function forwardActs(perform: (act: TranscriptActName) => void): TranscriptActs {
  return {
    openFind: () => {
      perform("openFind");
    },
    stepFindNext: () => {
      perform("stepFindNext");
    },
    stepFindPrevious: () => {
      perform("stepFindPrevious");
    },
    jumpToLatest: () => {
      perform("jumpToLatest");
    },
    foldEveryRun: () => {
      perform("foldEveryRun");
    },
  };
}

/**
 * What an act says when no transcript is mounted. One value, since the person needs to know
 * the transcript is not here, not which act they reached for.
 */
export const TRANSCRIPT_NOT_MOUNTED_REFUSAL: Refusal = refuse(
  "transcript",
  "transcript.no_mounted_transcript",
  "No transcript is open in this window. Open a session and try again.",
);

/** The mounted feeds, in mount order. */
export class MountedTranscript {
  readonly #adopted: TranscriptActs[] = [];

  /** Become the target for a mount's lifetime. The return value releases exactly this one. */
  public adopt(acts: TranscriptActs): Unsubscribe {
    this.#adopted.push(acts);
    return () => {
      const position = this.#adopted.lastIndexOf(acts);
      if (position >= 0) {
        this.#adopted.splice(position, 1);
      }
    };
  }

  /** Perform one act on the mounted transcript, or answer why it could not be. */
  public perform(act: TranscriptActName): TranscriptActOutcome {
    const acts = this.#adopted.at(-1);
    if (acts === undefined) {
      return { status: "refused", refusal: TRANSCRIPT_NOT_MOUNTED_REFUSAL };
    }
    acts[act]();
    return { status: "performed", act };
  }
}

/** This window's mounted transcript. */
export const mountedTranscript: MountedTranscript = new MountedTranscript();
