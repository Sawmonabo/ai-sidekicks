// State that belongs to a subject, and can never be read about another one.
//
// The React half of the rule. What a held value may do (discard, which publisher may write,
// late settlements) is in `subject-scoped-holder.ts`, which has no renderer. This file
// addresses the holder during the render, so the pass that first sees a new subject reads its
// own seed, and subscribes React to what the holder publishes.
//
// A subject compared by value derives its key: the caller passes a string built from the
// fields that make up the subject. A holder drops a value and does not dispose it; a value
// that owns a subscription, registry or connection takes `useSubjectScopedResource.ts`,
// because a discarded pass still ran the seed. Not single-flight
// (`lib/reads/generation-latch.ts`), not a cache, not a scheduler
// (`lib/reads/refresh-scheduler.ts`).

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
} from "@renderer/lib/subject-scoped/subject-scoped-holder.js";

/** What a caller reads and the two ways it writes. */
export interface SubjectScopedState<TValue> {
  /** The value held for the subject passed on THIS render. Never another's. */
  readonly value: TValue;
  /**
   * Publish into the subject this render is about.
   *
   * Captured at render, so a closure carried into a `.then` still names the subject that
   * dispatched the call; if the subject has moved since, the publish is dropped. Its identity
   * changes exactly when the addressing this render reads does (a view routed away and back
   * is the same pair on two visits), so it is a correct effect dependency and is stable
   * across renders that did not re-address.
   */
  readonly publish: SubjectScopedPublish<TValue>;
  /**
   * Capture the visit on screen now and hand back a publisher bound to it.
   *
   * For a caller with no fresh `publish` to close over: a handler in a ref, a class built
   * once, an effect with no dependencies. Stable for the mount, and because the capture
   * happens when it is called, the settlement is still measured against the subject that
   * dispatched it.
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
  // Before the value is read, so the pass that first sees a new subject reads its own seed.
  // The addressing is provisional until this pass commits (the layout effect in
  // `useHeldSubjectValue`), so a pass React throws away leaves the tree on screen settling
  // through the visit it committed to.
  holder.address(subject, key, initial);
  return useHeldSubjectValue(holder, subject, key);
}

/**
 * Subscribe React to an already-addressed holder, and hand back its two write moments.
 *
 * Split out of `useSubjectScopedState` so `useSubjectScopedResource` shares one subscription
 * path to the holder. The caller addresses the holder immediately before this runs, so the
 * pass that first sees a new subject reads its own value.
 */
export function useHeldSubjectValue<TValue>(
  holder: SubjectScopedHolder<TValue>,
  subject: object,
  key: SubjectKey,
): SubjectScopedState<TValue> {
  const subscribe = useCallback((onChange: () => void) => holder.subscribe(onChange), [holder]);
  const read = useCallback(() => holder.value, [holder]);
  const value = useSyncExternalStore(subscribe, read, read);

  // A layout effect: the earliest point where it is known whether the addressing pass became
  // a frame, and it runs before paint, so no frame shows a seed that is not yet the visit on
  // screen. Keyed on the pair: a pass that addressed the pair the last commit holds proposed
  // nothing.
  useLayoutEffect(() => {
    holder.commit(subject, key);
  }, [holder, subject, key]);
  // The end of the mount: a proposal left by a render that suspended and then unmounted is
  // reachable through nothing else, and for a value that owns a connection that is a leak.
  useEffect(() => () => holder.discardProvisional(), [holder]);

  // Re-captured exactly when the addressing moves. Resolving it at publish time instead would
  // let a caller that captured it on the first visit to a pair find it valid on the third; the
  // capture moment has to be the render, and only its validity is a live read.
  const publish = useMemo(
    () => holder.publisherFor(subject, key),
    [holder, subject, key, holder.addressing],
  );
  // Stable for the mount; the capture happens when it is called.
  const settle = useCallback(() => holder.settle(), [holder]);

  return useMemo(() => ({ value, publish, settle }), [value, publish, settle]);
}
