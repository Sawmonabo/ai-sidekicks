import { useCallback, useEffect } from "react";

import type { Unsubscribe } from "@shared/preload-api.js";
import type { KeyBoundHolder, KeyBoundValue } from "@renderer/lib/key-bound-holder.js";
import { useSubjectScopedState } from "./subject-scoped/useSubjectScopedState.js";

/** A value a view subscribes to while it is live. */
export interface SubscribableKeyBoundValue extends KeyBoundValue {
  /** Be told when the value changes. */
  subscribe(sink: () => void): Unsubscribe;
}

/** What a view holds: the live value while there is one, and the ways to reach it. */
export interface KeyBoundValueAccess<TValue> {
  /**
   * The value this render may read, or `undefined` while the acquiring effect has not settled.
   * A view renders its own initial value then, which is what a fresh value holds.
   */
  readonly value: TValue | undefined;
  /**
   * The value an event handler writes through. Acquires rather than reads, because a press
   * cannot outrun a passive effect and must settle on the value that effect acquires.
   */
  readonly acquire: () => TValue;
  /** `useSyncExternalStore`'s subscribe over the live value; subscribes to nothing before it. */
  readonly subscribe: (onChange: () => void) => Unsubscribe;
}

/**
 * Bind a view to the value `holder` keeps for `key`. The value is acquired in an effect and only
 * read during render, so it lags its key by one committed frame and the opening arm renders in
 * it; a key whose value another view already acquired reads it on the first pass. `activate`
 * runs on each acquire and must be idempotent and a stable reference. The holder is the caller's,
 * declared once at module scope: one minted here would be per mount, two owners of one record.
 */
export function useKeyBoundValue<TKey extends object, TValue extends SubscribableKeyBoundValue>(
  holder: KeyBoundHolder<TKey, TValue>,
  key: TKey,
  activate: (value: TValue) => void,
): KeyBoundValueAccess<TValue> {
  // Seeded from the pure lookup, so a remount over the same key skips the opening arm and a view
  // carried across a key change never reads the retired key's value.
  const { value: acquiredValue, publish: publishAcquiredValue } = useSubjectScopedState<
    TValue | undefined
  >(key, undefined, () => holder.valueIfCurrent(key));

  useEffect(() => {
    const value = holder.acquire(key);
    // Rides the effect, so a discarded render activates nothing.
    activate(value);
    publishAcquiredValue(value);
  }, [holder, key, activate, publishAcquiredValue]);

  const liveValue = holder.valueIfCurrent(key);
  const value = acquiredValue === liveValue ? acquiredValue : undefined;
  return {
    value,
    acquire: useCallback(() => holder.acquire(key), [holder, key]),
    subscribe: useCallback(
      (onChange: () => void) => value?.subscribe(onChange) ?? noSubscription,
      [value],
    ),
  };
}

/** The unsubscribe a view whose effect has not acquired a value yet hands React. */
function noSubscription(): void {
  return undefined;
}
