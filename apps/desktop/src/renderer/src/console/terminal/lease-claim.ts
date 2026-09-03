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
// BOTH OF THOSE FACTS ARE ABOUT A SUBJECT, which is what the generation below keeps
// them attached to. They are renderer-local, not session-local, so nothing outside
// this hook can tell that a disabled control and a refusal on screen belong to a
// session the pane has since left.

import { useCallback, useEffect, useRef, useState } from "react";

import { refusalFromRejection, type ConsoleRefusal } from "../core/index.js";
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
  const [isInFlight, setIsInFlight] = useState(false);
  const [refusal, setRefusal] = useState<ConsoleRefusal | undefined>(undefined);
  // WHICH INPUTS THE CALLS IN FLIGHT WERE MADE UNDER, as a number that advances the
  // moment those inputs stop being the current ones.
  //
  // The two state values below are ABOUT a call, and a call is about a bridge and a
  // session. A pane rebound from one session to another kept both: the control stayed
  // disabled on the new session for as long as the old session's call was unresolved
  // — indefinitely, if it never resolved — and the old session's refusal was rendered
  // beside a lease it had nothing to do with, under a code naming a shell the person
  // was no longer looking at. The generation is what tells the two apart, and an
  // unmount advances it too, so a reply that lands after the pane closed is dropped
  // by the same test rather than by a second flag.
  //
  // The pane's own terminal id is deliberately not part of it: `session.takeControl`
  // and `session.releaseControl` both take `{ sessionId }` and V1 gives a session one
  // shared shell, so a terminal id is not an input any call here was made under.
  const callGenerationRef = useRef(0);

  useEffect(() => {
    // The new subject inherits no call state. Whatever was in flight, and whatever
    // refused, belonged to the inputs the cleanup below has just retired.
    setIsInFlight(false);
    setRefusal(undefined);
    return () => {
      callGenerationRef.current += 1;
    };
  }, [bridge, sessionId]);

  const call = useCallback(
    (operation: "acquire" | "release"): void => {
      const dispatchedUnderGeneration = callGenerationRef.current;
      const isStillCurrent = (): boolean => callGenerationRef.current === dispatchedUnderGeneration;
      setIsInFlight(true);
      setRefusal(undefined);
      const request = { sessionId };
      const pending =
        operation === "acquire"
          ? bridge.growth.terminalAcquireWriteLease(request)
          : bridge.growth.terminalReleaseWriteLease(request);
      void pending
        .then((outcome) => {
          if (!isStillCurrent()) {
            return;
          }
          setRefusal(outcome.status === "unavailable" ? outcome : undefined);
        })
        .catch((error: unknown) => {
          if (!isStillCurrent()) {
            return;
          }
          setRefusal(refusalFromRejection(TERMINAL_LEASE_REFUSAL_ORIGIN, error));
        })
        .finally(() => {
          if (isStillCurrent()) {
            setIsInFlight(false);
          }
        });
    },
    [bridge, sessionId],
  );

  const acquire = useCallback(() => {
    call("acquire");
  }, [call]);
  const release = useCallback(() => {
    call("release");
  }, [call]);

  return { isInFlight, refusal, acquire, release };
}
