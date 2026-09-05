// State that belongs to a subject, and can never be read about another one.
//
// THE FAMILY'S DOOR, AND THE REACT HALF OF ITS RULE. What a value addressed by a
// subject may do — when it is discarded, which publisher may write, what a late
// settlement does — is `subject-scoped-holder.ts`, which has no renderer in it at
// all. This file decides when React is told: it addresses the holder DURING the
// render, so the pass that first sees a new subject already reads that subject's own
// seed, and it subscribes React to what the holder publishes afterwards.
//
// A VALUE-COMPARED SUBJECT DERIVES ITS KEY rather than growing a second hook. A
// holder whose subject is a record compared field by field — an agent's effective
// provider binding, say — passes a derivation of that record as the key. The
// comparison then happens in the one place, on a string, and the derivation is the
// caller's business because only the caller knows which fields are the subject.
//
// A HOLDER DROPS A VALUE; A RESOURCE HAS TO BE DISPOSED, and that half is
// deliberately not here. A caller whose value owns a subscription, a registry, or a
// database connection takes `subject-scoped-resource.ts` instead: seeding runs during
// the render, so a pass React DISCARDS still ran it, and the value that pass produced
// is held by nothing a commit will ever clean up. This hook's `initial` is for a value
// a drop releases.
//
// WHAT THIS IS NOT. It is not single-flight: whether an act may be dispatched at all
// is `generation-latch.ts`, which a handler has to decide inside its own tick. It is
// not a cache — nothing here survives the subject it was held for. And it is not a
// scheduler; a burst collapsing into one read is `store/scheduling.ts`.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import {
  SubjectScopedHolder,
  type SubjectKey,
  type SubjectScopedPublish,
} from "./subject-scoped-holder.js";

/** What a caller reads and the two ways it writes. */
export interface SubjectScopedState<TValue> {
  /** The value held for the subject passed on THIS render. Never another's. */
  readonly value: TValue;
  /**
   * Publish into the subject this render is about.
   *
   * Captured at render, so a closure a caller carried into a `.then` still names the
   * subject that dispatched the call: if the subject has moved since, the publish is
   * dropped. Its identity changes exactly when the ADDRESSING THIS RENDER READS does —
   * which is a strictly finer fact than the pair, and the correct one: a surface
   * routed away and back is at the same pair on two different visits, and only the
   * addressing tells them apart. So it is still a correct dependency for an effect
   * that must re-run on a re-address, and it is stable across every render that did
   * not re-address.
   */
  readonly publish: SubjectScopedPublish<TValue>;
  /**
   * Capture the visit ON SCREEN now and hand back a publisher bound to it.
   *
   * For the caller that has no fresh {@link publish} to close over: a handler stored
   * in a ref, a class built once by `useState(() => …)`, an effect with an empty
   * dependency list. Stable for the life of the mount, so handing it to such a holder
   * costs no re-subscription — and because the capture happens when it is CALLED
   * rather than when it was handed over, the settlement it publishes is still
   * measured against the subject that dispatched it. It names the COMMITTED visit,
   * which is the only one anything outside a render is reading through.
   */
  readonly settle: () => SubjectScopedPublish<TValue>;
}

/**
 * Hold one value per `(subject, key)`, reset during the render that re-addresses.
 *
 * `initial` is a function and is read only when the subject changes, so a caller may
 * derive the seed from whatever the new subject is — "unasked" where the key is
 * `undefined`, "reading" where it is not — without recomputing it on every pass.
 */
export function useSubjectScopedState<TValue>(
  subject: object,
  key: SubjectKey,
  initial: () => TValue,
): SubjectScopedState<TValue> {
  const [holder] = useState(() => new SubjectScopedHolder<TValue>());
  // During the render, before the value is read: the pass that first sees a new
  // subject already reads that subject's own seed, so no frame carries the previous
  // one's. React's own state-adjustment pattern spends a discarded render pass to
  // reach the same place; addressing an external holder reaches it in the first. The
  // addressing is PROVISIONAL until this pass commits, which is what the layout
  // effect below settles — so a pass React throws away leaves the tree on screen
  // reading and settling through the visit it committed to.
  holder.address(subject, key, initial);
  return useHeldSubjectValue(holder, subject, key);
}

/**
 * Subscribe React to an already-addressed holder, and hand back its two write moments.
 *
 * The React half of the hook above, split out because `subject-scoped-resource.ts`
 * needs exactly this and differs only in what it does about the value's LIFETIME —
 * two copies of a subscription with their own equality rules is the second path this
 * family's one door exists to keep shut.
 *
 * Addressing is deliberately the CALLER's, immediately before this runs: the whole
 * guarantee is that the pass which first sees a new subject already reads that
 * subject's own value, and a hook that addressed on its caller's behalf would put
 * that ordering somewhere a caller could get wrong.
 */
export function useHeldSubjectValue<TValue>(
  holder: SubjectScopedHolder<TValue>,
  subject: object,
  key: SubjectKey,
): SubjectScopedState<TValue> {
  const subscribe = useCallback((onChange: () => void) => holder.subscribe(onChange), [holder]);
  const read = useCallback(() => holder.value, [holder]);
  const value = useSyncExternalStore(subscribe, read, read);

  // THE COMMIT, AND IT HAS TO BE A LAYOUT EFFECT. This is the earliest moment the
  // answer the holder cannot work out for itself is known — did the pass that
  // addressed become a frame — and it is still before anything is painted, so the
  // window between a pass reading its own seed and that seed becoming the visit on
  // screen never contains a frame. A passive effect would open one.
  //
  // Keyed on the PAIR rather than on the addressing: a pass that addressed the pair
  // the last commit already holds proposed nothing, and one that proposed an
  // addressing carrying this pair is exactly what there is to confirm.
  useLayoutEffect(() => {
    holder.commit(subject, key);
  }, [holder, subject, key]);
  // And the end of the mount, which is the one moment no later pass is coming: a
  // proposal left behind by a render that suspended and was then unmounted is
  // reachable through nothing else, and for a caller whose value owns a connection
  // that is the difference between a close and a leak.
  useEffect(() => () => holder.discardProvisional(), [holder]);

  // Re-captured exactly when the ADDRESSING moves, and by nothing else. The pair is
  // read here too, because it is what `publisherFor` is asked about; the addressing
  // is what makes the memo correct, and it is read LIVE from the holder the caller
  // has already addressed on this pass.
  //
  // Not resolved at publish time instead. A stable callback that asked the holder
  // for its publisher when the settlement arrived would be referentially stable too
  // — and it would re-open the defect the epoch exists to close, because the caller
  // that captured it on the first visit to a pair would find it valid on the third.
  // The capture moment has to be the render; only its VALIDITY is a live read.
  const publish = useMemo(
    () => holder.publisherFor(subject, key),
    [holder, subject, key, holder.addressing],
  );
  // Stable for the mount: captured when CALLED, so a holder built once may keep it.
  const settle = useCallback(() => holder.settle(), [holder]);

  return useMemo(() => ({ value, publish, settle }), [value, publish, settle]);
}
