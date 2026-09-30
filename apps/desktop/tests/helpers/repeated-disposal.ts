// Counts disposals on a resource that was already disposed.
//
// `useSubjectScopedResource` is handed one disposal object, and its shape says whether the ending
// is terminal: the watched resources hand over `{ dispose, isClosed }`. Handed a bare release
// instead, the seam records a corpse as committed, the caller publishes a replacement, and the
// value-change cleanup disposes the corpse again. Each disposal is re-entrant, so the second call
// changes nothing on the resource, which is why the call is the observable and not its effect.
// The spy sits on the prototype rather than wrapping, so what is counted is the disposal the
// binding really performs.

/**
 * How many disposals landed on a resource that had already been disposed.
 *
 * Zero is the claim. A count rather than the resources, because a failure naming a reader prints
 * the whole reader.
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

/** Just enough of a `vi.spyOn` handle to read the `this` of each call it saw. */
interface DisposalSpy {
  readonly mock: { readonly contexts: readonly unknown[] };
}
