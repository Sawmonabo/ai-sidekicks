// The seam between a chord and a mounted feed. Commands are contributed before any feed
// exists, so a feed adopts this holder while mounted and commands resolve their target at
// press time. The newest mount is the target; release is by identity, so a strict-mode double
// mount or route change cannot leave a gone feed adopted. One holder serves every window, so
// each mount names the document it is drawn in and a command acts on its own window's newest.
// Each mount also says whether its transcript holds a run group, which the palette's `when`
// context reads so the fold rows are offered only where there is something to fold.

import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import type { Unsubscribe } from "#shared/preload-api.js";

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
  readonly unfoldEveryRun: () => void;
}

/** One act, by name. Every member is a niladic call, so the name is the whole request. */
export type TranscriptActName = keyof TranscriptActs;

/** What asking the mounted transcript to perform an act produced. */
export type TranscriptActOutcome =
  | { readonly status: "performed"; readonly act: TranscriptActName }
  | { readonly status: "refused"; readonly refusal: Refusal };

/** One feed's place in the holder: what releases it and what keeps its run group flag current. */
export interface TranscriptAdoption {
  /** Stop being a target; releases exactly this adoption. */
  readonly release: Unsubscribe;
  /** Say whether this feed's transcript holds a run group; listeners hear only a change. */
  readonly publishHoldsRunGroup: (holdsRunGroup: boolean) => void;
}

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
    unfoldEveryRun: () => {
      perform("unfoldEveryRun");
    },
  };
}

/**
 * What an act says when no transcript is mounted. One value, since the person needs to know
 * the transcript is not here, not which act they reached for.
 */
export const TRANSCRIPT_NOT_MOUNTED_REFUSAL: Refusal = refuse(
  "transcript",
  "no-mounted-transcript",
  "No transcript is open in this window. Open a session and try again.",
);

/** The mounted feeds of every window, in mount order. */
export class MountedTranscript {
  readonly #adopted: AdoptedTranscript[] = [];
  readonly #listeners = new Set<() => void>();

  /**
   * Become the target in the window `ownerDocument` belongs to, for a mount's lifetime, saying
   * whether its transcript holds a run group now.
   */
  public adopt(
    acts: TranscriptActs,
    ownerDocument: Document,
    holdsRunGroup: boolean,
  ): TranscriptAdoption {
    const adopted: AdoptedTranscript = { acts, ownerDocument, holdsRunGroup };
    this.#adopted.push(adopted);
    this.#notify();
    return {
      release: () => {
        const position = this.#adopted.lastIndexOf(adopted);
        if (position >= 0) {
          this.#adopted.splice(position, 1);
          this.#notify();
        }
      },
      publishHoldsRunGroup: (holds) => {
        if (adopted.holdsRunGroup !== holds) {
          adopted.holdsRunGroup = holds;
          this.#notify();
        }
      },
    };
  }

  /** Hear every adoption, release and run group flag change, until the return value is called. */
  public subscribe(listener: () => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Whether the newest transcript mounted in the window `windowDocument` belongs to holds a run
   * group; false with none mounted.
   */
  public holdsRunGroup(windowDocument: Document): boolean {
    return (
      this.#adopted.findLast((each) => each.ownerDocument === windowDocument)?.holdsRunGroup ??
      false
    );
  }

  /**
   * Perform one act on the newest transcript mounted in the window `windowDocument` belongs to, or
   * answer why it could not be. A transcript in another window never takes the act.
   */
  public perform(
    act: TranscriptActName,
    windowDocument: Document | undefined,
  ): TranscriptActOutcome {
    const adopted = this.#adopted.findLast((each) => each.ownerDocument === windowDocument);
    if (adopted === undefined) {
      return { status: "refused", refusal: TRANSCRIPT_NOT_MOUNTED_REFUSAL };
    }
    adopted.acts[act]();
    return { status: "performed", act };
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

/** One mounted feed's acts, the document of the window it is drawn in, and its run group flag. */
interface AdoptedTranscript {
  readonly acts: TranscriptActs;
  readonly ownerDocument: Document;
  holdsRunGroup: boolean;
}

/** Every window's mounted transcripts. */
export const mountedTranscript: MountedTranscript = new MountedTranscript();
