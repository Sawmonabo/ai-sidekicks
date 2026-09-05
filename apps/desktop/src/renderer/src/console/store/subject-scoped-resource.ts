// A resource held per subject, and closed however the render that opened it ended.
//
// `subject-scoped-state.ts` holds one VALUE per subject and states what it
// deliberately does not do: A HOLDER DROPS A VALUE; A RESOURCE HAS TO BE DISPOSED.
// Two window subsystems now seed one through that holder — a session-store registry
// with its event binder, and an open IndexedDB connection — and the pairing they rely
// on is correct only for the renders React keeps.
//
// THE HOLE IS THE RENDER REACT THROWS AWAY. Seeding runs DURING the render, because a
// hook cannot be called conditionally and a resource that arrived one commit late
// would mean a first render with nothing to read through. React may then discard that
// pass — an interrupted concurrent render, a transition, a render-phase state
// adjustment — and re-render at the previous subject. The holder is an external
// mutable object, so the discarded pass really opened its resource and really
// installed it; nothing committed it, so no effect ever closed over it, so nothing
// would ever close it. The `useState` initializer this replaced had no such window,
// because React owned the cell.
//
// SO THERE ARE TWO DISPOSAL MOMENTS, AND THEY ARE TWO DIFFERENT FACTS.
//
//   • A RESOURCE NO COMMIT SAW is closed the instant the holder drops it, inside the
//     render that drops it. Nothing else ever will.
//   • THE COMMITTED RESOURCE is closed by the effect that holds it, when the value
//     that effect closed over is replaced or the mount ends. Closing it during a
//     render would tear down what the frame on screen is still reading through — and
//     that render may itself be the one React discards.
//
// A RESOURCE THE HOLDER REFUSED IS THE FIRST OF THE TWO, reached by the other door.
// An `open` that settles after the surface has been re-addressed publishes into a
// visit that is over; the holder installs nothing, so no commit will ever see that
// resource either. It is closed on the same terms and by the same decision — this
// hook's — which is why the holder is handed the disposal at construction.
//
// WHICH OF THE TWO A DROPPED RESOURCE IS cannot be the holder's question. It knows a
// value was replaced; only React knows whether the pass that replaced it went on to
// commit. So the holder reports the drop, this module decides, and the decision is
// written once rather than at each call site.
//
// WHAT THIS IS NOT. It is not a second holder — there is one, next door, and this
// hook addresses it. It is not a pool or a cache: nothing here survives the subject it
// was opened for, and a resource is opened again when a subject the surface left is
// returned to.

import { useEffect, useLayoutEffect, useState } from "react";

import { SubjectScopedHolder, type SubjectKey } from "./subject-scoped-holder.js";
import { useHeldSubjectValue, type SubjectScopedState } from "./subject-scoped-state.js";

/**
 * Which resource the last commit saw, for the hook that has to close the rest.
 *
 * ONE PER MOUNT, held in state beside the holder. Nothing here is a rule about
 * subjects — it is a rule about renders — which is why it lives outside the holder
 * that has no idea one is happening.
 */
class SubjectScopedResourceLifetime<TResource> {
  #close: (resource: TResource) => void;
  #committed: { readonly resource: TResource } | undefined;

  public constructor(close: (resource: TResource) => void) {
    this.#close = close;
  }

  /**
   * Close a resource the holder dropped that no commit ever saw.
   *
   * A bound property rather than a method, so the holder can be handed it on every
   * render without a closure being minted for a call that almost never happens. It
   * is what the holder is handed for a REFUSED publish too, and one property serves
   * both: a value no commit saw is closed whichever door it arrived at, and the
   * committed check is not redundant on either — a caller may publish the resource
   * it is already holding, and a refusal is no reason to tear down what the frame on
   * screen is reading through.
   *
   * The committed resource is deliberately NOT closed here: a live effect is holding
   * it, and the render doing the dropping may itself be discarded, in which case that
   * effect goes on holding it and this render never happened.
   */
  public readonly closeIfUncommitted = (dropped: TResource): void => {
    if (this.#committed?.resource === dropped) {
      return;
    }
    this.#close(dropped);
  };

  /**
   * Hold the caller's latest disposal, and disturb nothing else.
   *
   * SEPARATE FROM {@link commit} BECAUSE A DISPOSAL IS NOT A LIFETIME. A caller
   * whose `close` is minted per render — the shape the hook below documents support
   * for — hands over a new identity on renders that have nothing to do with the
   * resource, and an effect taking that identity as a dependency answered an
   * unrelated rerender by running its own cleanup: it closed the resource the frame
   * on screen was still reading through, then recommitted that closed value. So the
   * per-render identity is written here, on its own dependency, and the lifetime
   * effect depends on the resource alone.
   *
   * Written from the LAYOUT phase, which is what makes "the latest" exact: every
   * layout effect for a commit runs before any passive cleanup for it, so the
   * disposal this holds when a retired resource is closed is the one supplied by the
   * render that retired it.
   */
  public holdClose(close: (resource: TResource) => void): void {
    this.#close = close;
  }

  /**
   * Record what this commit is holding, and answer the cleanup that closes it.
   *
   * The disposal is read when the cleanup RUNS rather than captured as it is built,
   * so a resource retires through the caller's most recent `close` rather than
   * through whichever render happened to install the value.
   */
  public commit(resource: TResource): () => void {
    this.#committed = { resource };
    return () => {
      this.#committed = undefined;
      this.#close(resource);
    };
  }
}

/**
 * Hold one resource per `(subject, key)`, and close it however its render ended.
 *
 * {@link useSubjectScopedState}'s rule about the value, plus the half that hook
 * deliberately leaves to its caller. `open` runs during the render that first sees a
 * new subject, exactly as `initial` does; `close` is called at most once for each
 * resource this hook produced, whether the render that produced it committed or was
 * thrown away.
 *
 * A `close` MINTED PER RENDER IS SUPPORTED, AND IS NOT A LIFETIME. Its identity is
 * held on a dependency of its own, so an unrelated rerender changes which disposal
 * will run and changes nothing about what is open.
 *
 * WHY A HOOK RATHER THAN A FOURTH ARGUMENT AT EACH CALL SITE. The holder takes the
 * discard callback either way — the question is who supplies it. Supplied per call
 * site it is a closure minted on every render, and the steady path, where the subject
 * has not moved and `address` returns after one comparison, is every render but the
 * rare one; worse, the committed-versus-discarded decision would then be re-derived at
 * each site, which is the drift this whole substrate exists to remove. Supplied here
 * it is a bound property of one per-mount object, so the steady path allocates nothing
 * beyond the `open` thunk the holder already required, and both call sites pass a
 * declared `close` rather than an arrow.
 *
 * A resource a caller PUBLISHES is disposed on the same terms, by the effect, when the
 * value it replaced retires — which is the one shape either caller uses: publishing is
 * how a window replaces a resource that has already closed itself.
 */
export function useSubjectScopedResource<TResource>(
  subject: object,
  key: SubjectKey,
  open: () => TResource,
  close: (resource: TResource) => void,
): SubjectScopedState<TResource> {
  const [lifetime] = useState(() => new SubjectScopedResourceLifetime<TResource>(close));
  // The holder is handed the disposal at construction, because a resource it refuses
  // is one nothing else can reach: never installed, so no commit and no effect.
  const [holder] = useState(
    () =>
      new SubjectScopedHolder<TResource>({
        disposeRejectedPublish: lifetime.closeIfUncommitted,
      }),
  );
  // During the render and before the value is read, for the reason the holder states:
  // the pass that first sees a new subject already reads that subject's own resource.
  holder.address(subject, key, open, lifetime.closeIfUncommitted);
  const held = useHeldSubjectValue(holder, subject, key);
  const { value } = held;
  // The caller's disposal, held on a dependency of its own so a `close` minted per
  // render cannot restart the lifetime effect beneath it, and held in the layout
  // phase so the resource that effect retires is closed through the newest one.
  useLayoutEffect(() => {
    lifetime.holdClose(close);
  }, [lifetime, close]);
  // THE RESOURCE IS THE WHOLE DEPENDENCY. Its replacement is the one fact that ends
  // a resource's lifetime; every other thing that changes per render is about the
  // caller and not about what this effect is holding.
  useEffect(() => lifetime.commit(value), [lifetime, value]);
  return held;
}
