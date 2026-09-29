// Which transcript a command acts on: the seam between a chord and a mounted feed.
//
// The transcript's commands are contributed when the window is composed, before any
// window has rendered and long before a session is open. The acts they perform
// belong to a mounted feed: opening find, walking its matches, scrolling its tail.
// Something has to join the two, and it cannot be a closure — the command is built
// once per window and the feed comes and goes with the route.
//
// So the feed ADOPTS this holder while it is mounted, and every command resolves its
// target at press time. Three properties follow, and each is the reason for the
// shape below:
//
//   • **The newest mount is the target.** Two transcript panes in one window are two
//     feeds; the most recently mounted is the one a chord acts on, rather than a focus
//     model nothing publishes.
//   • **Release is by identity.** A pane unmounting drops ITS adoption and not
//     whichever happens to be last, so a strict-mode double mount and a route
//     change cannot leave the holder pointing at a feed that is gone.
//   • **No mounted feed is a refusal, not a silence.** `perform` answers with the
//     refusal rather than raising it; the caller that contributed the command knows
//     where its refusals are rendered.
//
// Module scope is window scope, as it is for the command registry: each window is its
// own renderer process, so two windows share nothing.

import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import { type Unsubscribe } from "@renderer/lib/emitter.js";

/**
 * The acts a mounted transcript offers, one function per command, named for the act
 * rather than the control that triggers it. Declared beside the holder of the mounted one,
 * so the commands and the feed do not import each other.
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
 * What an act says when no transcript is mounted. One value rather than one per act: a
 * person pressing a transcript chord from the settings page needs to know the transcript
 * is not here, not which act they reached for.
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

  /** The transcript a command acts on, or `undefined` while none is mounted. */
  public current(): TranscriptActs | undefined {
    return this.#adopted[this.#adopted.length - 1];
  }

  /** How many mounts are adopted. Read by tests. */
  public get mountedCount(): number {
    return this.#adopted.length;
  }

  /** Perform one act on the mounted transcript, or answer why it could not be. */
  public perform(act: TranscriptActName): TranscriptActOutcome {
    const acts = this.current();
    if (acts === undefined) {
      return { status: "refused", refusal: TRANSCRIPT_NOT_MOUNTED_REFUSAL };
    }
    acts[act]();
    return { status: "performed", act };
  }
}

/** This window's mounted transcript. */
export const mountedTranscript: MountedTranscript = new MountedTranscript();
