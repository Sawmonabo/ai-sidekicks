// One keyed record with one key gone, rebuilt rather than mutated.
//
// The rule every store snapshot in the console needs and three of them had each written
// for themselves — `settings/shared/shell-preferences/shell-preference-snapshot.ts` as an
// exported generic, `channels/mutation-coordinator.ts` as a private one narrowed to
// its own refusal map, and the schema-form answer module as a third spelling nothing
// ever called. One rule, three bodies, and no instrument holding them together, which
// is what the shared-code rule in `apps/desktop/AGENTS.md` forbids.
//
// IT LIVES AT THE FLOOR AND NOT IN THE FAMILY THAT NEEDED IT FIRST. Its readers are
// `settings/` and `channels/`, two VIEW families, and a view family never imports
// another — so neither could have taken the other's copy however the first was written.
// `core/` is the only home both can reach, and this rule needs nothing to sit there: no
// store type, no schema, no React, no clock.
//
// REBUILT AND NEVER MUTATED, because every caller holds the record a `useSyncExternalStore`
// snapshot is read from: a `delete` in place leaves the same object identity and the
// surface does not repaint. That is a rule about this function rather than about any of
// its callers, which is why it is stated once here instead of three times over there.
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
