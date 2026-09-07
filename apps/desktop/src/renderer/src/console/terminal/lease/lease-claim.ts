// The one wire call the lease surface makes: take the shell, or hand it back.
//
// Its own module rather than a section at the bottom of `LeaseLine.tsx`, because the
// two answer different questions. The line RENDERS — the holder, the chip, the
// transition ledger, the withheld control — and this CALLS: it is the only place in
// the family that reaches `bridge.growth`, and the only place that turns a rejection
// into something a person reads.
//
// WHAT IT DOES NOT DO, which is the whole reason it can be this small.
// `Spec-023 §Console Design (Meridian)` 8.8's second Never — the holder is never
// derived from the last observed claim — is met here by a hook that returns no
// holder at all. It reports exactly two renderer-local facts (a call is out; a call
// was refused) and the fold in `lease-model.ts` owns everything else. The moment
// this file acquires a rule about WHO HOLDS the shell, that rule belongs in the fold
// where it can be tested without React.
//
// BOTH OF THOSE FACTS ARE ABOUT A SUBJECT, AND THE SUBJECT IS STAMPED ON THEM.
// They are renderer-local, not session-local, so nothing outside this hook can tell
// that a disabled control and a refusal on screen belong to a session the pane has
// since left. The family's own answer to that is `viewer-identity.ts`'s: a settled
// value is held together with the `(bridge, sessionId)` it was produced for, and the
// COMPARISON HAPPENS DURING RENDER. An effect that reset the state after the commit
// was one frame too late — session B's first committed render inherited A's disabled
// control or A's refusal, and a person who pressed the control in that frame issued
// a call under A's generation which A's own cleanup then retired. The stamp makes
// B's first render idle by construction, with no pass to be wrong on.
//
// A DISPATCH IS THE GENERATION, which is the second half of the same idea. Each call
// mints its own serial and stamps it beside the subject, and a settlement is admitted
// only while the state it would write into is still that dispatch's. So a reply for a
// session the pane has left is dropped; so is a reply for a call a LATER press on the
// same session superseded; and an unmount needs no flag of its own, because there is
// no longer a committed state for a late settlement to reach.
//
// AND THE SINGLE-FLIGHT REGISTER IS KEYED ON THE VISIT, NOT ON THE PAIR, because the
// state beside it is. A surface routed s1 -> s2 -> s1 is at the same pair twice and
// the holder re-seeds on both visits — that is what its addressing serial exists to
// say. A register keyed on `(bridge, sessionId)` has no visit concept at all, so on
// the return it would still be holding the FIRST visit's round while the flag the
// control renders came from the re-seeded state: an enabled control whose press is
// refused by a key it cannot see and swallowed without a word, which is exactly what
// `lease-acquisition.ts` calls neither an offer nor a refusal. So the subject handed
// to the latch is the PUBLISHER, whose identity the holder re-mints on precisely the
// addressings it re-seeds on and on nothing else — the same fact as the addressing
// serial, in the one form this hook is handed. The returning visit therefore finds a
// free slot, and within one visit the register behaves exactly as it did.

import { useCallback } from "react";

import { normalizeWireRejection, type ExtendedConsoleRefusal } from "../../core/index.js";
import { useGenerationLatch, useSubjectScopedState } from "../../store/index.js";
import type { ConsoleBridge } from "../../bridge/index.js";

/**
 * The subsystem name every refusal this claim raises itself carries.
 *
 * A REJECTED lease call is normalized by `core/refusal.ts`'s one normalizer rather
 * than by a copy here. That is what keeps the wire's own code on screen: the port
 * answers rather than throws, so a rejection means the bridge itself failed, and a
 * bridge that failed with `{ code, message }` — a lease conflict, a denied
 * permission — is telling the person what to do next. A local arm that recognised
 * only this console's own refusal shape flattened every one of those into a single
 * call-failed code with `[object Object]` for a sentence.
 */
const TERMINAL_LEASE_REFUSAL_ORIGIN = "terminal-lease";

/** What the claim control knows: whether a call is out, and what refused it. */
export interface TerminalLeaseClaim {
  readonly isInFlight: boolean;
  /**
   * What refused the last dispatch, with whatever registered members it carried.
   *
   * The EXTENDED refusal rather than the bare one, because 8.8's naming rule is met
   * from a member the wire sent — `holderParticipantId`, registered in
   * `core/refusal-extensions.ts` — and a surface handed the narrow type would have to
   * re-read it off an unvalidated value the normalizer has already read once.
   */
  readonly refusal: ExtendedConsoleRefusal | undefined;
  readonly acquire: () => void;
  readonly release: () => void;
}

/**
 * The two facts one dispatch publishes.
 *
 * WHOSE they are is not on this shape and is deliberately not restated here: the
 * subject is `(bridge, sessionId)` — `session.takeControl` and
 * `session.releaseControl` both take `{ sessionId }` and V1 gives a session one
 * shared shell, so the pane's own terminal id is not an input any call here carries
 * — and the console's one subject-scoped holder is what binds a reading to it.
 */
interface TerminalLeaseClaimReading {
  readonly isInFlight: boolean;
  readonly refusal: ExtendedConsoleRefusal | undefined;
}

/**
 * What a subject that has dispatched nothing renders as.
 *
 * One frozen value rather than a fresh literal per seed: the two members are read
 * straight out of it on every pass before a dispatch, and a new object each time
 * would be a new value for consumers that compare.
 */
const IDLE_TERMINAL_LEASE_CLAIM: TerminalLeaseClaimReading = {
  isInFlight: false,
  refusal: undefined,
};

/**
 * Call the lease wire and render what it answers — and nothing else.
 *
 * A hook rather than a class because its whole state is two renderer-local values
 * with no logic between them; the moment it acquires a rule, that rule belongs in
 * `lease-model.ts` where the fold can be tested without React.
 *
 * The served arm deliberately sets NO holder. `terminalAcquireWriteLease` answering
 * "served" means the daemon accepted the claim, not that this participant now holds
 * the shell — the holder is the wire field the transition carries, and a surface
 * that moved on the reply would show a keyboard to somebody whose broadcast never
 * arrived. The registered reply DOES carry a `controlHolder`, and 8.8's second Never
 * is precisely that it may not be read as one: the fold owns the holder.
 */
export function useTerminalLeaseClaim(
  bridge: ConsoleBridge,
  sessionId: string,
): TerminalLeaseClaim {
  const { value: reading, publish } = useSubjectScopedState<TerminalLeaseClaimReading>(
    bridge,
    sessionId,
    () => IDLE_TERMINAL_LEASE_CLAIM,
  );
  // The single-flight rule, stated by claiming a key rather than by counting: the
  // latch refuses a second claim while one is live, which is the rule the control's
  // disabled state renders. Its claim is also the serial the two settlements compare
  // against, so an earlier press's `finally` can no longer clear the in-flight flag a
  // later press had just set.
  const dispatches = useGenerationLatch();

  const call = useCallback(
    (operation: "acquire" | "release"): void => {
      // The subject is read out of the closure, and the closure is rebuilt whenever
      // either input changes — so a press on session B's FIRST committed render
      // carries B, with no effect having had to flush first.
      //
      // `publish` IS the visit, and that is the whole of the header's last paragraph:
      // the holder re-mints it on exactly the addressings it re-seeds this state on,
      // so one publisher names one visit and the register can never be holding a
      // round the flag beside it has already forgotten. The session id stays the KEY
      // so the register's entry still names the shell the round is about, and so
      // taking the shell and handing it back share one slot.
      const dispatch = dispatches.claim(publish, sessionId);
      if (dispatch === undefined) {
        // A call is already out for this subject. The control is disabled for exactly
        // that lifetime, so there is nothing to start and nothing new to say.
        return;
      }
      publish({ isInFlight: true, refusal: undefined });
      const request = { sessionId };
      const pending =
        operation === "acquire"
          ? bridge.growth.terminalAcquireWriteLease(request)
          : bridge.growth.terminalReleaseWriteLease(request);
      void pending
        .then((outcome) => {
          dispatch.settle(() => {
            publish((previous) => ({
              ...previous,
              refusal: outcome.status === "unavailable" ? outcome : undefined,
            }));
          });
        })
        .catch((error: unknown) => {
          dispatch.settle(() => {
            publish((previous) => ({
              ...previous,
              refusal: normalizeWireRejection(TERMINAL_LEASE_REFUSAL_ORIGIN, error),
            }));
          });
        })
        .finally(() => {
          dispatch.settle(() => {
            publish((previous) => ({ ...previous, isInFlight: false }));
          });
          dispatch.release();
        });
    },
    [bridge, dispatches, publish, sessionId],
  );

  const acquire = useCallback(() => {
    call("acquire");
  }, [call]);
  const release = useCallback(() => {
    call("release");
  }, [call]);

  return { isInFlight: reading.isInFlight, refusal: reading.refusal, acquire, release };
}
