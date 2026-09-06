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
// installed it as its own PROVISIONAL addressing; nothing committed it, so no effect
// ever closed over it, so nothing would ever close it. The `useState` initializer this
// replaced had no such window, because React owned the cell.
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
// EVERY RESOURCE THE HOLDER LETS GO OF IS THE FIRST OF THE TWO, reached by one of
// three doors. An `open` that settles after the surface has been re-addressed
// publishes into a visit that is over, and the holder installs nothing. A caller that
// publishes twice before the effect runs — two direct settlements in one batched
// event — installs the first and replaces it, and no commit reaches it either. And a
// pass React threw away seeded a provisional addressing a later pass discards. All
// three are closed on the same terms and by the same decision — this hook's — which is
// why the holder is handed one disposal at construction and no second one per render.
//
// WHICH OF THE TWO A DROPPED RESOURCE IS cannot be the holder's question. It knows a
// value left its hand; only React knows whether a live effect is holding it. So the
// holder hands it over, this module decides, and the decision is written once rather
// than at each call site.
//
// AND A `close` MAY BE TERMINAL, WHICH IS A THIRD FACT ABOUT THE SAME RESOURCE. The
// two moments above both END a lifetime and neither can start one, so a caller whose
// disposal is a one-way `dispose()` had nowhere to say so: React's double-mount runs
// the committed cleanup and then re-runs the effect against the value it just closed,
// and the effect re-committed the corpse. Nothing was leaked and nothing was closed
// twice — the subject simply went on holding a resource that would never work again,
// which is invisible until something reads through it. A caller whose `close` merely
// releases (a counter advanced, a subscription dropped) is unaffected.
//
// SO THE DISPOSAL IS ONE ARGUMENT WITH TWO SHAPES, AND WHICH SHAPE IT IS SAYS WHICH
// KIND OF ENDING IT IS. A releasing caller hands over `{ release }`; a terminal one
// hands over `{ dispose, isClosed }`, and the reading is not optional beside it. That
// is the whole reason for the object: the reading used to be a fifth positional
// parameter a caller could simply not pass, so `flushAndClose()` — a writer's one-way
// drain — typechecked as a release and silently took the behaviour above. A missing
// member is a compile error; a missing fifth argument was nothing at all.
//
// THE RE-MINT IS STILL THE CALLER'S READING OF ITS OWN VALUE, NOT AN INTERFACE.
// `isClosed` is supplied beside the `dispose` it belongs with rather than demanded of
// the resource, because this hook is generic over values unrelated window subsystems
// own and a shape requirement here would reach into all of them. When the lifetime
// effect is about to commit a value that reading calls closed, it publishes a fresh one
// through `open` instead — the holder's own write path, so the retired value is
// disposed on the same terms as any replaced one.
//
// AND IT IS THE EFFECT'S RUN THAT ARMS IT, NEVER A RENDER. The lifetime effect depends
// on the resource alone, so a resource that disposes ITSELF while nothing else moves
// re-runs nothing and is not re-minted: that arm is terminal on purpose, and a caller
// wanting a fresh one publishes it.
//
// WHAT THIS IS NOT. It is not a second holder — there is one, next door, and this
// hook addresses it. It is not a pool or a cache: nothing here survives the subject it
// was opened for, and a resource is opened again when a subject the surface left is
// returned to.

import { useEffect, useLayoutEffect, useState } from "react";

import {
  SubjectScopedHolder,
  type SubjectKey,
  type SubjectScopedPublish,
} from "./subject-scoped-holder.js";
import { useHeldSubjectValue, type SubjectScopedState } from "./subject-scoped-state.js";

/**
 * A disposal that hands a resource back rather than ending it.
 *
 * A counter advanced, a subscription dropped, a listener detached: the value is still
 * a working value afterwards and a later commit may hold it again. There is no closed
 * state to read, which is why this arm carries no reading — supplying one would be a
 * claim about a lifetime that does not end.
 */
export interface SubjectScopedRelease<TResource> {
  readonly release: (resource: TResource) => void;
}

/**
 * A disposal that ENDS a resource, and the reading that recognises one it ended.
 *
 * The two travel together because neither is usable alone: a terminal disposal
 * without a reading is the double-mount corpse the header describes, and a reading
 * without a terminal disposal is a claim about a value nothing ever closes.
 */
export interface SubjectScopedTerminalDisposal<TResource> {
  readonly dispose: (resource: TResource) => void;
  readonly isClosed: (resource: TResource) => boolean;
}

/**
 * How a caller's resource ends — released, or disposed and recognisable afterwards.
 *
 * NO `kind` TAG, BECAUSE THE VERB IS THE TAG. `release` and `dispose` are the two
 * facts, and a literal beside them would be a second place to state one of them and
 * a second place to get it wrong. TypeScript discriminates the arms on the member
 * names alone: `{ dispose }` with no reading matches neither, which is the compile
 * error this type exists to produce.
 */
export type SubjectScopedDisposal<TResource> =
  | SubjectScopedRelease<TResource>
  | SubjectScopedTerminalDisposal<TResource>;

/**
 * How a resource whose `close` was terminal is replaced: the reading, the mint, and
 * where the answer goes.
 *
 * Held together because they are one act and are all three minted per render — the
 * reading and the mint close over whatever the caller's `open` reads, and the
 * publisher is re-captured whenever the addressing moves. Held on the lifetime rather
 * than read from the effect's closure for the same reason `close` is: the effect
 * depends on the resource alone, so its closure is the one from the render that
 * installed the value and may be several renders old.
 */
interface SubjectScopedResourceReopening<TResource> {
  readonly isClosed: (resource: TResource) => boolean;
  readonly open: () => TResource;
  readonly publish: SubjectScopedPublish<TResource>;
}

/**
 * Which resource the last commit saw, for the hook that has to close the rest.
 *
 * ONE PER MOUNT, held in state beside the holder. Nothing here is a rule about
 * subjects — it is a rule about renders — which is why it lives outside the holder
 * that has no idea one is happening.
 */
class SubjectScopedResourceLifetime<TResource> {
  #close: (resource: TResource) => void;
  #reopening: SubjectScopedResourceReopening<TResource> | undefined;
  #committed: { readonly resource: TResource } | undefined;

  public constructor(close: (resource: TResource) => void) {
    this.#close = close;
  }

  /**
   * Close a resource the holder dropped that no commit ever saw.
   *
   * A bound property rather than a method, so it is handed to the holder once at
   * construction rather than minted per render for a call that almost never happens.
   * One property serves every door — a refused publish, a value a later publish
   * replaced, and the seed of a pass that never committed — because a value no commit
   * saw is closed whichever door it arrived at, and the committed check is not
   * redundant on any of them. A caller may publish the resource it is already holding;
   * a refusal is no reason to tear down what the frame on screen is reading through;
   * and a publish that replaces the COMMITTED resource hands this the value a live
   * effect still owns, which that effect closes on its own terms when the replacement
   * reaches it.
   *
   * The committed resource is deliberately NOT closed here: a live effect is holding
   * it, and the render doing the dropping may itself be discarded, in which case that
   * effect goes on holding it and this render never happened.
   *
   * NOR IS ONE THAT IS ALREADY CLOSED, which is what makes the re-mint below safe to
   * write through the holder: the value a re-mint replaces is the corpse the committed
   * cleanup has just disposed, and it arrives here as an ordinary replaced value with
   * no commit holding it. Closing it again would be the second `dispose()` a terminal
   * disposal is entitled to refuse. A caller that supplies no reading has no closed
   * values to tell apart, and this guard is inert for it.
   */
  public readonly closeIfUncommitted = (dropped: TResource): void => {
    if (this.#committed?.resource === dropped || this.#reopening?.isClosed(dropped) === true) {
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
   * Hold the caller's latest way of replacing a resource its `close` ended.
   *
   * Beside {@link holdClose} and for its reason: all three parts are minted per render
   * and none of them is a lifetime. `undefined` where the caller supplied no reading,
   * which is every caller whose `close` releases rather than ends.
   */
  public holdReopening(reopening: SubjectScopedResourceReopening<TResource> | undefined): void {
    this.#reopening = reopening;
  }

  /**
   * Record what this commit is holding, or replace a value that is already closed.
   *
   * The disposal is read when the cleanup RUNS rather than captured as it is built,
   * so a resource retires through the caller's most recent `close` rather than
   * through whichever render happened to install the value.
   *
   * THE RE-MINT COMES FIRST AND HOLDS NOTHING. A run that finds the value closed is
   * the double-mount's second one: the cleanup for this same resource has already
   * disposed it, and committing it would install a resource that will never work
   * again. So the replacement is published through the holder — which is what makes
   * it the subject's value and re-runs this effect against a live resource — and this
   * run records no commit and answers no cleanup, because it is holding nothing. The
   * run the publish causes does both.
   *
   * A caller whose `open` answers with an already-closed resource publishes forever,
   * and is stopped by React's own update-depth guard rather than by a count here: a
   * bound would turn a caller's defect into this hook silently holding a corpse, which
   * is the state it exists to prevent.
   */
  public commit(resource: TResource): (() => void) | undefined {
    const reopening = this.#reopening;
    if (reopening !== undefined && reopening.isClosed(resource)) {
      reopening.publish(reopening.open());
      return undefined;
    }
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
 * A DISPOSAL THAT IS TERMINAL SAYS SO BY ITS SHAPE, and is then re-minted rather than
 * re-committed. `{ dispose, isClosed }` and `{ release }` are the two arms, and the
 * difference between them is not optional detail but which kind of ending this is: a
 * caller whose disposal releases has no closed value to recognise, and one whose
 * disposal ends the resource cannot fail to say how a closed one is recognised. The
 * reading is supplied beside the `dispose` it belongs with rather than demanded of the
 * resource, so a value another family owns needs no shape from this one — and it is
 * read only where the lifetime effect RUNS, so a resource that disposes itself while
 * nothing moves stays disposed.
 *
 * A resource a caller PUBLISHES is disposed on the same terms, by the effect, when the
 * value it replaced retires. Publishing is the arm for a replacement reason the hook
 * cannot read for itself; the one reason the frame's two callers had — a value that
 * had closed itself — is now `isClosed`'s, so neither publishes today. A caller that
 * publishes TWICE before the effect runs is the exception the effect cannot serve: the
 * first replacement is installed and gone again with no commit in between, so the
 * holder hands it to the disposal instead and it is closed on the same terms as a
 * refused one — as is the resource a pass React threw away opened, which no commit and
 * therefore no effect ever reached.
 */
export function useSubjectScopedResource<TResource>(
  subject: object,
  key: SubjectKey,
  open: () => TResource,
  disposal: SubjectScopedDisposal<TResource>,
): SubjectScopedState<TResource> {
  // Read apart here rather than carried as one object, so the dependency lists below
  // are the caller's own function identities. A caller that declares both members at
  // module level then has a stable list even though it hands over a fresh literal on
  // every render, which is the shape both frame subsystems take.
  const isTerminalDisposal = "dispose" in disposal;
  const close = isTerminalDisposal ? disposal.dispose : disposal.release;
  const isClosed = isTerminalDisposal ? disposal.isClosed : undefined;
  const [lifetime] = useState(() => new SubjectScopedResourceLifetime<TResource>(close));
  // The holder is handed the disposal at construction, because a resource it lets go
  // of is one nothing else can reach: never installed, installed and replaced before
  // any commit saw it, or seeded by a pass that never committed — no effect in any of
  // the three cases.
  const [holder] = useState(
    () =>
      new SubjectScopedHolder<TResource>({
        disposeUnheldValue: lifetime.closeIfUncommitted,
      }),
  );
  // During the render and before the value is read, for the reason the holder states:
  // the pass that first sees a new subject already reads that subject's own resource.
  holder.address(subject, key, open);
  const held = useHeldSubjectValue(holder, subject, key);
  const { value } = held;
  // The caller's disposal, held on a dependency of its own so a `close` minted per
  // render cannot restart the lifetime effect beneath it, and held in the layout
  // phase so the resource that effect retires is closed through the newest one.
  useLayoutEffect(() => {
    lifetime.holdClose(close);
    // The publisher is this render's, which is what binds a re-mint to the visit on
    // screen: one captured on an earlier addressing would refuse, and the fresh
    // resource it was carrying would be disposed instead of installed.
    lifetime.holdReopening(
      isClosed === undefined ? undefined : { isClosed, open, publish: held.publish },
    );
  }, [lifetime, close, isClosed, open, held.publish]);
  // THE RESOURCE IS THE WHOLE DEPENDENCY. Its replacement is the one fact that ends
  // a resource's lifetime; every other thing that changes per render is about the
  // caller and not about what this effect is holding.
  useEffect(() => lifetime.commit(value), [lifetime, value]);
  return held;
}
