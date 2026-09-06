// Which participant this window is, asked once and remembered only when it answers.
//
// A MODULE OF ITS OWN BECAUSE IT IS A DIFFERENT READ WITH A DIFFERENT RULE. The gate's
// own read is scheduled, coalesced, re-armed by three observations, and published onto
// an arm a person looks at. This one is asked lazily by the first act that needs it,
// answers a value no surface renders, and is never scheduled at all — it is attribution
// travelling on a request rather than a reading. Kept inside the reader the two rules
// sat in one class, which `apps/desktop/AGENTS.md` rejects.
//
// THE REFUSAL IS ABSORBED HERE AND ON PURPOSE. `causationParticipantId` is optional on
// the registered request and is attribution rather than authority: the daemon resolves
// the principal an act runs under from the transport, so an unreadable identity is a
// member this console cannot fill and not a reason to refuse a press. Absorbing it into
// `undefined` is therefore the whole handling — there is no arm to publish and nothing
// for a participant to do about it — and it is deliberately NOT turned into a
// placeholder, which would be a claim about who acted.
//
// A rejection is caught for the same reason a served refusal is: the growth port answers
// with an outcome, but a live bridge whose IPC never reaches the daemon rejects instead,
// and an unhandled rejection here would take down an act that had already been admitted.

import type { ConsoleBridge } from "../../bridge/index.js";

export interface CallerParticipantReadOptions {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
}

/**
 * The caller-identity read, in flight or settled — one per gate, never one per act.
 *
 * A PROMISE HELD RATHER THAN A VALUE: the read answers which participant this window is,
 * which does not change while a gate is mounted, so a second act reuses the first act's
 * answer rather than putting the same question on the wire again. Held from the first
 * act that needs it rather than started at `start()`, because a gate a participant never
 * acts on should not spend a call on an identity nothing is going to attribute.
 *
 * AN ANSWER IS WHAT IS HELD, AND A NON-ANSWER IS NOT ONE. This used to keep whatever the
 * first act got, so an identity read refused or rejected during a transient disconnect
 * made every later Commit and Push on that gate omit its causation for the rest of the
 * gate's life — long after the read would have succeeded. Cleared on a non-answer, so
 * the next act asks again.
 */
export class CallerParticipantRead {
  readonly #bridge: ConsoleBridge;
  readonly #sessionId: string;

  #pending: Promise<string | undefined> | undefined;

  public constructor(options: CallerParticipantReadOptions) {
    this.#bridge = options.bridge;
    this.#sessionId = options.sessionId;
  }

  /**
   * Which participant this window is, for an act's causation — or the honest absence.
   *
   * WHAT IS ABSORBED IS NOT WHAT IS REMEMBERED. Absence is the honest answer for the act
   * that asked, and it is not an identity to hold: a refusal and a rejection are both
   * states of the wire at one moment, and a reader that cached either would go on
   * omitting the causation from every later act on a connection that had come back. Only
   * a served identity is kept; anything else clears the field so the next act puts the
   * question again. Cleared under the identity check the settle paths make, so a slow
   * non-answer cannot drop the answer a later read has already installed.
   */
  public async read(): Promise<string | undefined> {
    const pending = (this.#pending ??= this.#ask());
    const participantId = await pending;
    if (participantId === undefined && this.#pending === pending) {
      this.#pending = undefined;
    }
    return participantId;
  }

  /** Put the identity question on the wire once, answering absence for a non-answer. */
  async #ask(): Promise<string | undefined> {
    try {
      const outcome = await this.#bridge.growth.callerParticipantRead({
        sessionId: this.#sessionId,
      });
      return outcome.status === "served" ? outcome.value.participantId : undefined;
    } catch {
      return undefined;
    }
  }
}
