// Which participant this window is, for ATTRIBUTION: asked once, kept only when it
// answers, and never rendered.
//
// NAMED FOR THE POLICY IT OWNS AND NOT FOR THE WIRE IT CALLS. Two families held a class
// called `CallerParticipantRead`, in two files of that name, wrapping the same growth
// operation under opposite rules — this one absorbs every non-answer into an absence a
// request may omit, and the notifications page's publishes each one onto an arm a person
// reads. A grep for the noun returned two different jobs, so each is named for its job:
// this is the attribution reader, and the sibling is the scheduled reading.
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
import { callerParticipantIdentityFrom } from "../../seats/index.js";

export interface CallerParticipantAttributionOptions {
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
export class CallerParticipantAttribution {
  readonly #bridge: ConsoleBridge;
  readonly #sessionId: string;

  #pending: Promise<string | undefined> | undefined;

  public constructor(options: CallerParticipantAttributionOptions) {
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

  /**
   * Put the identity question on the wire once, answering absence for a non-answer.
   *
   * The served/refused narrowing comes from `seats/identity/caller-participant.ts`, which is the
   * console's one reading of what that outcome means; ABSORBING the refusal into an
   * absence is this reader's own policy and is stated here, over that result, rather
   * than as a fourth re-derivation of the outcome's arms.
   */
  async #ask(): Promise<string | undefined> {
    try {
      const identity = callerParticipantIdentityFrom(
        await this.#bridge.growth.callerParticipantRead({ sessionId: this.#sessionId }),
      );
      return typeof identity === "string" ? identity : undefined;
    } catch {
      return undefined;
    }
  }
}
