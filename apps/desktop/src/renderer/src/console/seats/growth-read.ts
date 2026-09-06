// One growth-port read, asked once for a subject and held against it.
//
// WHY THIS IS A SEAT AND NOT A VIEW FAMILY'S OWN
//
// Four surfaces in two view families now hold exactly one growth answer each — the
// channel roster, the membership roster, a participant's device fan-out, the
// session's terminal-control holder — and every one of them was the same twenty
// lines: hold the answer against the subject that asked, ask on mount, publish the
// outcome on the resolved arm, publish a console refusal on the arm the port's own
// vocabulary cannot express. View families are siblings, so the second family to
// need it could not have taken the first family's copy; `seats/` is the lowest
// family that sits above everything this needs — the bridge the call goes through,
// the store's subject-scoped holder, and the refusal reader beside it.
//
// WHAT IT DOES NOT DO, AND WHY THAT IS THE WHOLE POINT
//
// It asks ONCE per subject. There is no interval, no retry, and no refresh trigger:
// every operation reachable through this hook is a wire the console does not have
// yet, so a repeat re-asks a question with a standing answer and burns the idle-CPU
// budget doing it. `store/scheduling.ts` is where a re-read goes when the wire lands
// and there is something to re-read.
//
// It also does not WRITE into what it holds. A surface whose own mutation settles
// back into its held reading — the sent-invite ledger is the one — needs the
// publisher itself and keeps the holder directly; this hook hands back the reading
// and nothing else, because a publisher handed out is a second writer to a cell
// whose whole discipline is that one read owns it.
//
// THE SUBJECT IDENTIFIES THE REQUEST, and that contract is what makes it sound to
// re-ask exactly when the subject moves. The two are separate fields because they
// are separate facts: the subject is a STRING, because that is what an answer can be
// keyed and held under, and the request is the typed shape the port takes. A render
// that rebuilt an equal request under an unchanged subject re-asks nothing, because
// both are read through refs at the moment the effect runs rather than through the
// effect's dependency list.

import { useEffect, useRef } from "react";

import type { ConsoleBridge, GrowthOutcome, GrowthReading } from "../bridge/index.js";
import { useSubjectScopedState } from "../store/index.js";
import { consoleRefusalFrom } from "./push-driven-read.js";

export interface GrowthReadOnMountOptions<TRequest, TValue> {
  readonly bridge: ConsoleBridge;
  /**
   * What this read is asked ABOUT, and the key the answer is held under.
   *
   * `undefined` means there is nothing to ask — no session yet, no row opened — and
   * the hook asks nothing rather than composing a request with a hole in it.
   */
  readonly subject: string | undefined;
  /**
   * The question, in the shape the port takes.
   *
   * `undefined` on the same terms as the subject, and checked independently of it:
   * a request assembled around a value that turned out to be absent is how a read
   * ends up asking about nothing and reporting the answer as though it were about
   * something.
   */
  readonly request: TRequest | undefined;
  /** Names this read in a refusal the call itself did not name. */
  readonly origin: string;
  /** The one call. Read when the effect runs, so an equal rebuild re-asks nothing. */
  readonly ask: (bridge: ConsoleBridge, request: TRequest) => Promise<GrowthOutcome<TValue>>;
}

/**
 * Ask one growth operation once for one subject, and hold the answer against it.
 *
 * `undefined` is the not-yet-asked absence — distinct from an answered read that
 * refused, which is an `answered` reading carrying an unavailable outcome, and from
 * a call that produced no outcome at all, which is the `unreadable` arm. The three
 * are what let a surface tell "still coming" from "the port said no" from "the call
 * itself failed", which is the distinction the console's kinds of nothing rest on.
 */
export function useGrowthReadOnMount<TRequest, TValue>(
  options: GrowthReadOnMountOptions<TRequest, TValue>,
): GrowthReading<GrowthOutcome<TValue>> | undefined {
  const { bridge, subject, request, origin, ask } = options;
  const { value: reading, publish: publishReading } = useSubjectScopedState<
    GrowthReading<GrowthOutcome<TValue>> | undefined
  >(bridge, subject, () => undefined);
  // The current question and the current way of asking it, kept off the effect's
  // dependency list on the contract above. Assigned during render rather than in an
  // effect of their own: the effect below runs after this render, so what it reads
  // is what this render composed.
  const askRef = useRef(ask);
  askRef.current = ask;
  const requestRef = useRef(request);
  requestRef.current = request;

  useEffect(() => {
    const currentRequest = requestRef.current;
    if (subject === undefined || currentRequest === undefined) {
      return;
    }
    // The publisher was captured during this render, so it names the subject that
    // asked. An answer arriving after a re-address publishes nowhere — including on
    // the round trip back to a subject this surface has already been on, which a
    // render-time pair comparison reads as current.
    void askRef.current(bridge, currentRequest).then(
      (outcome) => {
        publishReading({ kind: "answered", outcome });
      },
      // The port's contract is that it RESOLVES with an outcome, so a rejection has
      // no arm in that vocabulary. Left unhandled it publishes nothing and the
      // surface goes on rendering its not-loaded absence for the life of the window
      // over a call that had already failed.
      (rejection: unknown) => {
        publishReading({ kind: "unreadable", refusal: consoleRefusalFrom(rejection, origin) });
      },
    );
  }, [bridge, subject, origin, publishReading]);

  return reading;
}
