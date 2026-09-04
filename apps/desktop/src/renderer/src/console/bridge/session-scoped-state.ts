// React state that belongs to the bridge and session it was produced under.
//
// THE FAILURE THIS EXISTS FOR. A mounted surface is rebound from one session to
// another — or from one bridge to another, which the fixture's scenario switch does
// — by a prop change, and its state survives that change. Two things then go wrong
// at once. The render that first commits the new subject still holds the previous
// one's value, so the previous session's rows are on screen and its controls are
// dispatchable for one frame; clearing that in an effect narrows the window rather
// than closing it, because the effect runs after the commit. And a read still in
// flight against the previous subject settles afterwards into a surface that is now
// addressed to a different one, where it reads as the new subject's answer.
//
// BOTH ARE CLOSED HERE, AND NEITHER BY A TIMER OR A COUNTER. The held value carries
// the subject it was produced under; the subject is compared during render, so a
// value belonging to another subject is never read; and the publisher a caller was
// handed carries the subject it was created under, so a settlement arriving after
// the subject moved writes nothing at all rather than clobbering the current one.
//
// This is `store/hooks.ts`'s caller-identity rule — a settled answer belongs to the
// inputs that produced it — as a reusable holder, and the keying is the pair
// `queue-feed.ts` already keys a session's reading by.

import { useCallback, useState } from "react";

import type { ConsoleBridge } from "./console-bridge.js";

/** A value together with the subject it was produced under. */
interface SubjectScopedValue<Value> {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  readonly value: Value;
}

/** What a caller reads and how it publishes: the current value, and a stamped setter. */
export type SessionScopedState<Value> = readonly [Value, (value: Value) => void];

/**
 * Hold one value per `(bridge, sessionId)` subject.
 *
 * The subject reset runs DURING render rather than in an effect, which is what makes
 * the guarantee synchronous: the pass that first sees a new subject already reads
 * the initial value, so no frame commits the previous subject's value. It is also
 * what keeps the held stamp current, which is what lets the publisher below reject a
 * stale settlement by comparing against it — without the reset, the first publish
 * under a new subject would be indistinguishable from a late one under the old.
 *
 * `initialValue` is read only when the subject changes and at first mount, so a
 * caller may pass a literal without re-arming anything on an ordinary render.
 */
export function useSessionScopedState<Value>(
  bridge: ConsoleBridge,
  sessionId: string,
  initialValue: Value,
): SessionScopedState<Value> {
  const [held, setHeld] = useState<SubjectScopedValue<Value>>({
    bridge,
    sessionId,
    value: initialValue,
  });
  const isCurrent = held.bridge === bridge && held.sessionId === sessionId;
  if (!isCurrent) {
    setHeld({ bridge, sessionId, value: initialValue });
  }

  // Keyed on the subject, so the function a caller closed over carries the subject
  // it was created under. A settlement holding an older one finds the stamp moved
  // and returns the previous state untouched — dropping the late answer rather than
  // publishing it, and leaving whatever the current subject has already said.
  const publish = useCallback(
    (value: Value) => {
      setHeld((previous) =>
        previous.bridge === bridge && previous.sessionId === sessionId
          ? { bridge, sessionId, value }
          : previous,
      );
    },
    [bridge, sessionId],
  );

  return [isCurrent ? held.value : initialValue, publish];
}
