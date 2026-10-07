// One lane's bookkeeping: the rope, which holds its text and is what a reader is handed. The engine
// arbitrates a frame; a lane knows only its own text. Diagnostics go out through a sink the
// caller passes, so a lane is never a second publisher on the engine's channel.

import type { RevealDelta, RevealDiagnostic, RevealLaneState } from "./model.js";
import { type PublishedText } from "./published-text.js";
import { RevealTextRope } from "./text-rope.js";

/** Where a lane's diagnostics go. The engine's emitter, in practice. */
export type RevealDiagnosticSink = (diagnostic: RevealDiagnostic) => void;

/** One reveal lane. A rebase resets it in place: same lane, the reader's agreed prefix. */
export class RevealLane {
  readonly #rope: RevealTextRope;

  /** Whether this frame gave the lane a share above its fair one. */
  public isCatchingUp = false;

  /** Set when a transition threw. A quarantined lane is never advanced. */
  #isQuarantined = false;

  public constructor(laneId: string) {
    this.#rope = new RevealTextRope(laneId);
  }

  public get laneId(): string {
    return this.#rope.laneId;
  }

  /**
   * The text a consumer may render for this lane: one handle for the lane's whole life, rebases
   * included, reading only what has been revealed.
   */
  public get publishedText(): PublishedText {
    return this.#rope;
  }

  /**
   * Stop this lane and drop the text it will never reveal, keeping the prefix a reader already
   * saw. A flag alone would leave `appendSpeculative` open, so a producer streaming a
   * long output would grow a rope no frame walks, without bound. Afterwards the lane is
   * settled, so its pending count is true.
   */
  public quarantine(): void {
    this.#isQuarantined = true;
    this.isCatchingUp = false;
    this.#rope.releasePending();
  }

  /** True while the lane has text left to reveal and has not been quarantined. */
  public hasWork(): boolean {
    return !this.#isQuarantined && !this.#rope.isSettled;
  }

  public get isSettled(): boolean {
    return this.#rope.isSettled;
  }

  /**
   * Take a speculative delta, text the producer may still revise. A quarantined lane takes none:
   * nothing would ever reveal it, and only an authoritative commit, which brings its own whole
   * source, lifts a quarantine.
   */
  public appendSpeculative(text: string): void {
    if (this.#isQuarantined) {
      return;
    }
    this.#rope.append(text);
  }

  /**
   * Fold an authoritative commit. One that extends the lane's source is appended. Otherwise the
   * producer rewrote its history (a retry, rollback or reconnect) and the lane rebases on the
   * longest common prefix with its published text, never on the published length, which would
   * keep the cursor but not the text and could replace everything after the divergence in one
   * frame with no budget spent. The divergent remainder streams under the ordinary budget,
   * and the diagnostic states how many characters were retracted. Either arm lifts a
   * quarantine, since the new source is one the producer vouches for.
   */
  public commitAuthoritative(delta: RevealDelta, report: RevealDiagnosticSink): void {
    if (this.#rope.isPrefixOf(delta.text)) {
      // The rope copies the extension, so the commit's whole text is not kept past this call.
      this.#rope.append(delta.text.slice(this.#rope.sourceLength));
      this.#isQuarantined = false;
      return;
    }
    const publishedLength = this.#rope.length;
    const agreedPrefixLength = this.#rope.commonRevealedPrefixLength(delta.text);
    report({
      kind: "out-of-band-source-change",
      laneId: delta.laneId,
      detail:
        "an authoritative commit did not extend the text this lane had " +
        "published; the lane was re-based on the " +
        `${String(agreedPrefixLength)} characters both sources agree on ` +
        `and ${String(publishedLength - agreedPrefixLength)} ` +
        "characters were retracted",
    });
    this.#rope.rebase(delta.text, agreedPrefixLength);
    this.isCatchingUp = false;
    this.#isQuarantined = false;
  }

  /**
   * Reveal up to `share` more characters, stopping where `gate` would show a partial
   * construct. Throws whatever the rope throws; the caller owns the quarantine because a failed
   * transition also concerns the frame's other lanes.
   */
  public advance(
    share: number,
    gate: (window: string, candidateInWindow: number) => number,
    tailCharacters: number,
    backtrackCap: number,
  ): number {
    const tail = this.#rope.revealedTail(tailCharacters);
    const window = tail + this.#rope.lookahead(share + backtrackCap);
    const candidateInWindow = Math.min(tail.length + share, window.length);
    const gatedInWindow = gate(window, candidateInWindow);
    const revealed = this.#rope.advance(Math.max(0, gatedInWindow - tail.length));
    this.isCatchingUp = this.isCatchingUp && !this.#rope.isSettled;
    return revealed;
  }

  /** What a consumer reads about this lane. */
  public describe(): RevealLaneState {
    return {
      laneId: this.laneId,
      publishedText: this.#rope,
      pendingCharacterCount: this.#rope.pendingCharacterCount,
      isCatchingUp: this.isCatchingUp,
      isSettled: this.#rope.isSettled,
    };
  }
}
