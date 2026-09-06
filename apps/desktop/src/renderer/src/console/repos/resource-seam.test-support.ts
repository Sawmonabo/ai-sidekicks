// What a suite watching the console's resource seam counts, and why it counts THAT.
//
// A RESOURCE THIS FAMILY OPENS IS DISPOSED ONCE. `useSubjectScopedResource` is handed
// a terminal `close` and, beside it, the `isClosed` that tells it the disposal is
// terminal; without that fifth argument the seam records a corpse as committed, the
// caller publishes a replacement, and the value-change cleanup disposes the corpse a
// second time. Every one of this family's four disposals happens to be re-entrant, so
// the second call changes nothing observable ON THE RESOURCE — which is exactly why
// the observable has to be the CALL and not its effect.
//
// SPIED ON THE PROTOTYPE AND NOT WRAPPED, so what is counted is the disposal the
// binding really performs through the real seam. A suite that handed a binding a
// stand-in resource would be counting its own wrapper.

/** Just enough of a `vi.spyOn` handle to read the `this` of each call it saw. */
interface DisposalSpy {
  readonly mock: { readonly contexts: readonly unknown[] };
}

/**
 * How many disposals landed on a resource that had already been disposed.
 *
 * Zero is the claim. A count rather than the resources themselves, because a failure
 * naming a reader prints the whole reader — and the number is the whole finding.
 */
export function repeatedDisposalCount(disposals: DisposalSpy): number {
  const disposed = new Set<unknown>();
  let repeated = 0;
  for (const resource of disposals.mock.contexts) {
    if (disposed.has(resource)) {
      repeated += 1;
    }
    disposed.add(resource);
  }
  return repeated;
}
