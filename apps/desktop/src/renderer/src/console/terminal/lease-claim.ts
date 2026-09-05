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

import { useCallback, useState } from "react";

import { normalizeWireRejection, type ConsoleRefusal } from "../core/index.js";
import type { ConsoleBridge } from "../bridge/index.js";

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
  readonly refusal: ConsoleRefusal | undefined;
  readonly acquire: () => void;
  readonly release: () => void;
}

/**
 * One dispatch's state, together with the subject it was made under.
 *
 * The subject is `(bridge, sessionId)` because that is what the call was made under:
 * `session.takeControl` and `session.releaseControl` both take `{ sessionId }` and
 * V1 gives a session one shared shell, so the pane's own terminal id is not an input
 * any call here carries. The serial distinguishes two dispatches on ONE subject,
 * which the subject alone cannot: without it an earlier press's `finally` cleared the
 * in-flight flag a later press had just set.
 */
interface StampedTerminalLeaseClaim {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  readonly dispatchSerial: number;
  readonly isInFlight: boolean;
  readonly refusal: ConsoleRefusal | undefined;
}

/**
 * What a subject that has dispatched nothing renders as.
 *
 * One frozen value rather than a fresh literal per render: the two members are read
 * straight out of it on every pass where the stamp does not match, and a new object
 * each time would be a new value for consumers that compare.
 */
const IDLE_TERMINAL_LEASE_CLAIM = {
  isInFlight: false,
  refusal: undefined,
} as const satisfies Pick<TerminalLeaseClaim, "isInFlight" | "refusal">;

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
  const [stampedClaim, setStampedClaim] = useState<StampedTerminalLeaseClaim | undefined>(
    undefined,
  );
  // The serial is minted inside `call`, never during render: a ref written on a
  // render pass is a write React is entitled to run twice, and this one has to
  // advance exactly once per press.
  const [dispatchSerials] = useState(() => new DispatchSerialSequence());

  const call = useCallback(
    (operation: "acquire" | "release"): void => {
      // The subject is read out of the closure, and the closure is rebuilt whenever
      // either input changes — so a press on session B's FIRST committed render
      // carries B, with no effect having had to flush first.
      const dispatchSerial = dispatchSerials.next();
      const isStillCurrent = (
        previous: StampedTerminalLeaseClaim | undefined,
      ): previous is StampedTerminalLeaseClaim =>
        previous !== undefined &&
        previous.bridge === bridge &&
        previous.sessionId === sessionId &&
        previous.dispatchSerial === dispatchSerial;
      setStampedClaim({
        bridge,
        sessionId,
        dispatchSerial,
        isInFlight: true,
        refusal: undefined,
      });
      const request = { sessionId };
      const pending =
        operation === "acquire"
          ? bridge.growth.terminalAcquireWriteLease(request)
          : bridge.growth.terminalReleaseWriteLease(request);
      void pending
        .then((outcome) => {
          setStampedClaim((previous) =>
            isStillCurrent(previous)
              ? {
                  ...previous,
                  refusal: outcome.status === "unavailable" ? outcome : undefined,
                }
              : previous,
          );
        })
        .catch((error: unknown) => {
          setStampedClaim((previous) =>
            isStillCurrent(previous)
              ? {
                  ...previous,
                  refusal: normalizeWireRejection(TERMINAL_LEASE_REFUSAL_ORIGIN, error),
                }
              : previous,
          );
        })
        .finally(() => {
          setStampedClaim((previous) =>
            isStillCurrent(previous) ? { ...previous, isInFlight: false } : previous,
          );
        });
    },
    [bridge, dispatchSerials, sessionId],
  );

  const acquire = useCallback(() => {
    call("acquire");
  }, [call]);
  const release = useCallback(() => {
    call("release");
  }, [call]);

  // The comparison, during render. A state stamped with anything but the subject
  // this pass is about renders as the idle arm — never as the previous session's
  // disabled control, and never as its refusal.
  const isCurrentSubject =
    stampedClaim !== undefined &&
    stampedClaim.bridge === bridge &&
    stampedClaim.sessionId === sessionId;
  const claim = isCurrentSubject ? stampedClaim : IDLE_TERMINAL_LEASE_CLAIM;

  return { isInFlight: claim.isInFlight, refusal: claim.refusal, acquire, release };
}

/**
 * The monotonic serial each dispatch is stamped with.
 *
 * A tiny class rather than a `useRef` counter incremented in place, on this
 * package's rule that stateful logic is encapsulated: the sequence is per hook
 * instance, it is never read during render, and the one thing a caller may do with
 * it is take the next number.
 */
class DispatchSerialSequence {
  #issued = 0;

  public next(): number {
    this.#issued += 1;
    return this.#issued;
  }
}
