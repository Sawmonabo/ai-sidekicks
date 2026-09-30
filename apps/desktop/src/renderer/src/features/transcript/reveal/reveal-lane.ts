// One lane's bookkeeping: the rope, its checkpoints, and the text published so far. The engine
// arbitrates a frame; a lane knows only its own text. Diagnostics go out through a sink the
// caller passes, so a lane is never a second publisher on the engine's channel.

import type { RevealDelta, RevealDiagnostic, RevealLaneState } from "./reveal-model.js";
import { REVEAL_CHECKPOINT_TAIL_CAP } from "../frame/frame-caps.js";
import { RopeSmoother, type ProvenAppendToken } from "./rope-smoother.js";

/** Where a lane's diagnostics go. The engine's emitter, in practice. */
export type RevealDiagnosticSink = (diagnostic: RevealDiagnostic) => void;

/** One reveal lane. A rebase resets it in place: same lane, the reader's agreed prefix. */
export class RevealLane {
  #smoother: RopeSmoother;
  #checkpoints: RevealCheckpoint[] = [];
  #publishedText = "";
  #appendToken: ProvenAppendToken | undefined;

  /** Whether this frame gave the lane a share above its fair one. */
  public isCatchingUp = false;

  /** Set when a transition threw. A quarantined lane is never advanced. */
  #isQuarantined = false;

  public constructor(laneId: string) {
    this.#smoother = new RopeSmoother(laneId);
  }

  public get laneId(): string {
    return this.#smoother.laneId;
  }

  /** The text a consumer may render for this lane. */
  public get publishedText(): string {
    return this.#publishedText;
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
    this.#checkpoints = [];
    this.#adoptAsWholeSource(this.#publishedText);
  }

  /** True while the lane has text left to reveal and has not been quarantined. */
  public hasWork(): boolean {
    return !this.#isQuarantined && !this.#smoother.isSettled;
  }

  public get isSettled(): boolean {
    return this.#smoother.isSettled;
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
    const token = this.#smoother.append(text);
    if (token !== undefined) {
      this.#appendToken = token;
    }
  }

  /**
   * Fold an authoritative commit. One that extends the lane's source is appended. Otherwise the
   * producer rewrote its history (a retry, rollback or reconnect) and the lane rebases on the
   * longest common prefix with its published text, never on the published length: clamping by
   * length kept the cursor but not the text and could replace everything after the divergence in
   * one frame with no budget spent. The divergent remainder streams under the ordinary budget,
   * and the diagnostic states how many characters were retracted. Either arm lifts a
   * quarantine, since the new source is one the producer vouches for.
   */
  public commitAuthoritative(delta: RevealDelta, report: RevealDiagnosticSink): void {
    if (this.#smoother.isPrefixOf(delta.text)) {
      const appended = delta.text.slice(this.#smoother.sourceLength);
      const token = this.#smoother.append(appended);
      if (token !== undefined) {
        this.#appendToken = token;
        this.#recordCheckpoint(token, report);
      }
      this.#isQuarantined = false;
      return;
    }
    const alreadyPublished = this.#publishedText;
    const agreedPrefixLength = commonPrefixLength(alreadyPublished, delta.text);
    report({
      kind: "out-of-band-source-change",
      laneId: delta.laneId,
      detail: `an authoritative commit did not extend the text this lane had published; the lane was re-based on the ${String(agreedPrefixLength)} characters both sources agree on and ${String(alreadyPublished.length - agreedPrefixLength)} characters were retracted`,
    });
    this.#checkpoints = [];
    this.#adoptAsWholeSource(delta.text, agreedPrefixLength);
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
    const tail = this.#smoother.revealedTail(tailCharacters);
    const window = tail + this.#smoother.lookahead(share + backtrackCap);
    const candidateInWindow = Math.min(tail.length + share, window.length);
    const gatedInWindow = gate(window, candidateInWindow);
    const revealed = this.#smoother.advance(Math.max(0, gatedInWindow - tail.length));
    this.#publishedText = this.#smoother.revealedText();
    this.isCatchingUp = this.isCatchingUp && !this.#smoother.isSettled;
    this.#assertPublishedTextIsRevealCursor();
    return revealed;
  }

  /** What a consumer reads about this lane. */
  public describe(): RevealLaneState {
    return {
      laneId: this.laneId,
      publishedText: this.#publishedText,
      pendingCharacterCount: this.#smoother.pendingCharacterCount,
      isCatchingUp: this.isCatchingUp,
      isSettled: this.#smoother.isSettled,
      appendToken: this.#appendToken,
    };
  }

  /**
   * Replace the rope with one carrying `source`, revealed as far as `revealedLength`. The one
   * place a lane swaps its rope; published text is read back off the new rope so it stays the
   * reveal cursor.
   */
  #adoptAsWholeSource(source: string, revealedLength: number = source.length): void {
    const adopted = new RopeSmoother(this.laneId);
    const token = adopted.append(source);
    adopted.advance(revealedLength);
    this.#smoother = adopted;
    this.#appendToken = token;
    this.#publishedText = adopted.revealedText();
  }

  #recordCheckpoint(token: ProvenAppendToken, report: RevealDiagnosticSink): void {
    this.#checkpoints.push({ sequence: token.sequence, sourceLength: token.sourceLength });
    while (this.#checkpoints.length > REVEAL_CHECKPOINT_TAIL_CAP) {
      const dropped = this.#checkpoints.shift();
      if (dropped !== undefined) {
        report({
          kind: "checkpoint-dropped",
          laneId: this.laneId,
          detail: `the checkpoint tail is bounded at ${String(REVEAL_CHECKPOINT_TAIL_CAP)}; the oldest anchor was released`,
        });
      }
    }
  }

  /**
   * The reveal engine's named invariant: published text is the smoother's reveal cursor.
   * Asserted in dev and test only: it checks this module's own bookkeeping, and
   * `import.meta.env.DEV` compiles away in a release bundle.
   */
  #assertPublishedTextIsRevealCursor(): void {
    if (!import.meta.env.DEV) {
      return;
    }
    if (this.#publishedText !== this.#smoother.revealedText()) {
      throw new Error(
        `reveal invariant broken on lane ${this.laneId}: published text is not the smoother's reveal cursor`,
      );
    }
  }
}

/** One authoritative commit the lane can be re-anchored against. */
interface RevealCheckpoint {
  readonly sequence: number;
  readonly sourceLength: number;
}

/**
 * How many leading characters two settled strings share. Both are materialized, so nothing
 * still growing is inspected.
 */
function commonPrefixLength(first: string, second: string): number {
  const ceiling = Math.min(first.length, second.length);
  let shared = 0;
  while (shared < ceiling && first[shared] === second[shared]) {
    shared += 1;
  }
  return shared;
}
