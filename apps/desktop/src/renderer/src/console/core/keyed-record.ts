// One keyed record with one key gone, rebuilt rather than mutated.
//
// The rule every store snapshot in the console needs; one body keeps the copies from
// drifting apart. Its reader today is
// `settings/shared/shell-preferences/shell-preferences-store.ts`.
//
// IT LIVES AT THE FLOOR AND NOT IN THE FAMILY THAT NEEDED IT FIRST, because a view
// family never imports another. `core/` is the only home every family can reach, and
// this rule needs nothing to sit there: no store type, no schema, no React, no clock.
//
// REBUILT AND NEVER MUTATED, because every caller holds the record a `useSyncExternalStore`
// snapshot is read from: a `delete` in place leaves the same object identity and the
// surface does not repaint. That is a rule about this function rather than about any of
// its callers, which is why it is stated once here instead of once per caller.
//
// AND THE SAME RECORD BACK WHERE THE KEY IS ABSENT, which is the other half of the same
// concern. A rebuild that always allocates makes every no-op removal a new snapshot
// identity and repaints a surface nothing changed on — so the absent case returns the
// argument, and a caller may compare identities to decide whether anything happened.
//
// A MAP IS NOT A RECORD. `approvals/pane/approvals-reader.ts` holds `ReadonlyMap`
// snapshots and keeps its own `withEntry` / `withoutKey` pair over them: those are two
// operations on a different container with one reader module between them, so they are
// not a fourth copy of this and hoisting them here would publish a floor symbol for a
// single family.

/**
 * The record without `key`, or that same record where it never held one.
 *
 * `Object.hasOwn` rather than `key in entries`, because an inherited key is not a member
 * this record holds and removing one would be rebuilding to change nothing. The values
 * stay `TValue` — this says which keys survive, never anything about what is behind one.
 */
export function withoutKey<TValue>(
  entries: Readonly<Record<string, TValue>>,
  key: string,
): Readonly<Record<string, TValue>> {
  if (!Object.hasOwn(entries, key)) {
    return entries;
  }
  const remaining: Record<string, TValue> = {};
  for (const [heldKey, value] of Object.entries(entries)) {
    if (heldKey !== key) {
      remaining[heldKey] = value;
    }
  }
  return remaining;
}
