// ONE LANE'S BOOKKEEPING — the rope, its checkpoints, and what the lane has published.
//
// Its own module beside `reveal-engine.ts` because the two answer different
// questions. The engine arbitrates a FRAME: which lanes are behind, how the
// character budget divides between them, when the next frame is armed. A lane knows
// only its own text — how far the reveal cursor has walked, which authoritative
// commits it can be re-anchored against, and whether a producer's rewrite still
// agrees with what a reader has already seen.
//
// THE REBASE IS IN PLACE, and that is the one thing this class changes about the
// arrangement it replaces. The engine used to build a whole new lane record and put
// it back in the map, which meant a rebase and a fresh lane were the same act written
// twice. Resetting in place says instead that this IS the same lane, still holding
// the reader's agreed prefix, now carrying a different source behind it.
//
// The class reports its own diagnostics through a sink the caller passes rather than
// holding an emitter: a lane that could reach the console's subscribers directly
// would be a second publisher on a channel the engine owns.

import { REVEAL_CHECKPOINT_TAIL_CAP } from "./frame-bounds.js";
import type { RevealDelta, RevealDiagnostic, RevealLaneState } from "./reveal-vocabulary.js";
import { RopeSmoother, type ProvenAppendToken } from "./rope-smoother.js";

/** Where a lane's diagnostics go. The engine's emitter, in practice. */
export type RevealDiagnosticSink = (diagnostic: RevealDiagnostic) => void;

/** One authoritative commit the lane can be re-anchored against. */
interface RevealCheckpoint {
  readonly sequence: number;
  readonly sourceLength: number;
}

export class RevealLane {
  #smoother: RopeSmoother;
  #checkpoints: RevealCheckpoint[] = [];
  #publishedText = "";
  #appendToken: ProvenAppendToken | undefined;

  /** Whether THIS frame gave the lane a share above its fair one. */
  public isCatchingUp = false;
  /** Set by the engine when a transition threw. A quarantined lane is never advanced. */
  public isQuarantined = false;

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

  /** True while the lane has text left to reveal and has not been quarantined. */
  public hasWork(): boolean {
    return !this.isQuarantined && !this.#smoother.isSettled;
  }

  public get isSettled(): boolean {
    return this.#smoother.isSettled;
  }

  /** Take a speculative delta — text the producer may still revise. */
  public appendSpeculative(text: string): void {
    const token = this.#smoother.append(text);
    if (token !== undefined) {
      this.#appendToken = token;
    }
  }

  /**
   * Fold an authoritative commit.
   *
   * The prefix check is the whole point: a producer that re-wrote its own history
   * — a retry, a rollback, a driver reconnect — must not have its new source glued
   * onto the tail of the old one.
   *
   * When the check fails the lane is re-based on the LONGEST COMMON PREFIX of what
   * it had published and what the producer now claims, and never on the published
   * LENGTH. Clamping to the length preserved the cursor's position and not its
   * text: a shorter rewrite truncated the visible prefix, and an equal-or-longer
   * one replaced every character after the divergence in a single frame with no
   * budget spent — which is the teleport this engine exists to prevent, arriving in
   * exactly the retry case the branch was written for. Rebasing on the agreed
   * prefix keeps the characters the two sources actually share, and the divergent
   * remainder is revealed by the ordinary per-frame budget, so a rewrite streams.
   *
   * Both strings are already materialised here, so the comparison reads no growing
   * source. The retraction is real — the producer withdrew text a reader had
   * already seen — so the diagnostic states how many characters went, rather than
   * claiming the revealed text held where it was.
   */
  public commitAuthoritative(delta: RevealDelta, report: RevealDiagnosticSink): void {
    if (this.#smoother.isPrefixOf(delta.text)) {
      const appended = delta.text.slice(this.#smoother.sourceLength);
      const token = this.#smoother.append(appended);
      if (token !== undefined) {
        this.#appendToken = token;
        this.#recordCheckpoint(token, report);
      }
      return;
    }
    const alreadyPublished = this.#publishedText;
    const agreedPrefixLength = commonPrefixLength(alreadyPublished, delta.text);
    report({
      kind: "out-of-band-source-change",
      laneId: delta.laneId,
      detail: `an authoritative commit did not extend the text this lane had published; the lane was re-based on the ${String(agreedPrefixLength)} characters both sources agree on and ${String(alreadyPublished.length - agreedPrefixLength)} characters were retracted`,
    });
    const rebased = new RopeSmoother(delta.laneId);
    const token = rebased.append(delta.text);
    rebased.advance(agreedPrefixLength);
    this.#smoother = rebased;
    this.#checkpoints = [];
    this.#publishedText = rebased.revealedText();
    this.#appendToken = token;
    this.isCatchingUp = false;
    this.isQuarantined = false;
  }

  /**
   * Reveal up to `share` more characters, stopping where `gate` says a partial
   * construct would be shown.
   *
   * Throws whatever the rope throws. The caller owns the quarantine, because a
   * failed transition is a fact about the FRAME's remaining lanes as much as about
   * this one.
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
   * The reveal engine's named invariant: published text is the smoother's reveal
   * cursor.
   *
   * Asserted under DEV and test only, because it is a claim about this module's own
   * bookkeeping rather than about anything a user did. `import.meta.env.DEV` is a
   * compile-time substitution, so a release bundle contains neither the check nor
   * the branch.
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

/**
 * How many leading characters two settled strings share.
 *
 * Both arguments are materialised strings the caller already holds — the text a
 * lane published and the whole source an authoritative commit carried — so this
 * inspects nothing that is still growing, which is the one thing the rope's
 * proven-append token exists to prevent.
 */
function commonPrefixLength(first: string, second: string): number {
  const ceiling = Math.min(first.length, second.length);
  let shared = 0;
  while (shared < ceiling && first[shared] === second[shared]) {
    shared += 1;
  }
  return shared;
}
