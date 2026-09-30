// A resource held per subject, and closed however the render that opened it ended.
//
// `open` runs during the render, so a pass React discards has already opened a resource that
// no commit, and so no effect, will ever close. A resource no commit saw is closed the moment
// the holder drops it. The committed resource is closed by the effect that holds it, when it
// is replaced or the mount ends; closing it during a render would tear down what the frame on
// screen still reads, and that render may itself be discarded.
//
// A `close` may be terminal (a one-way `dispose()`). Then `isClosed` travels beside it, so a
// double mount that re-runs the effect against the value it just closed publishes a fresh
// one from `open` instead of re-committing the closed one.

import { useEffect, useLayoutEffect, useState } from "react";

import {
  SubjectScopedHolder,
  type SubjectKey,
  type SubjectScopedPublish,
} from "@renderer/lib/subject-scoped/subject-scoped-holder.js";
import { useHeldSubjectValue, type SubjectScopedState } from "./useSubjectScopedState.js";
import type { SubjectScopedDisposal } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";

/**
 * Hold one resource per `(subject, key)`, and close it however its render ended.
 *
 * `open` runs during the render that first sees a new subject; `close` runs at most once per
 * resource, whether the render that opened it committed or was thrown away. A `close` minted
 * per render is supported. A terminal disposal (`{ dispose, isClosed }`) is re-minted through
 * `open` when `isClosed` reports the value closed, rather than re-committed.
 */
export function useSubjectScopedResource<TResource>(
  subject: object,
  key: SubjectKey,
  open: () => TResource,
  disposal: SubjectScopedDisposal<TResource>,
): SubjectScopedState<TResource> {
  // Read apart so the dependency lists below hold the caller's own function identities: a
  // caller that declares both members at module level keeps a stable list even though it
  // hands over a fresh literal each render.
  const isTerminalDisposal = "dispose" in disposal;
  const close = isTerminalDisposal ? disposal.dispose : disposal.release;
  const isClosed = isTerminalDisposal ? disposal.isClosed : undefined;
  const [lifetime] = useState(() => new SubjectScopedResourceLifetime<TResource>(close));
  // Handed the disposal at construction, because a resource the holder lets go of (refused,
  // replaced before any commit, or seeded by a pass that never committed) reaches no effect.
  const [holder] = useState(
    () =>
      new SubjectScopedHolder<TResource>({
        disposeUnheldValue: lifetime.closeIfUncommitted,
      }),
  );
  // Before the value is read, so the pass that first sees a new subject reads its own resource.
  holder.address(subject, key, open);
  const held = useHeldSubjectValue(holder, subject, key);
  const { value } = held;
  // Held on a dependency of its own so a `close` minted per render does not restart the
  // lifetime effect. The layout phase makes the resource it retires close through the newest one.
  useLayoutEffect(() => {
    lifetime.holdClose(close);
    // This render's publisher binds a re-mint to the visit on screen; an earlier one would be
    // refused and the fresh resource disposed instead of installed.
    lifetime.holdReopening(
      isClosed === undefined ? undefined : { isClosed, open, publish: held.publish },
    );
  }, [lifetime, close, isClosed, open, held.publish]);
  // The resource is the only dependency: its replacement is what ends its lifetime. One that
  // disposes itself while nothing else moves stays disposed; a caller wanting a fresh one
  // publishes it.
  useEffect(() => lifetime.commit(value), [lifetime, value]);
  return held;
}

/**
 * How a resource whose `close` was terminal is replaced: the reading, the mint, and where the
 * answer goes.
 *
 * Held on the lifetime because all three are minted per render and the effect's closure may
 * be several renders old.
 */
interface SubjectScopedResourceReopening<TResource> {
  readonly isClosed: (resource: TResource) => boolean;
  readonly open: () => TResource;
  readonly publish: SubjectScopedPublish<TResource>;
}

/**
 * Which resource the last commit saw, so the hook can close the rest.
 *
 * One per mount. It is a rule about renders, which the holder knows nothing of.
 */
class SubjectScopedResourceLifetime<TResource> {
  #close: (resource: TResource) => void;
  #reopening: SubjectScopedResourceReopening<TResource> | undefined;
  #committed: { readonly resource: TResource } | undefined;

  /**
   * Close a resource the holder dropped that no commit saw.
   *
   * Skips the committed resource, which a live effect owns, and one `isClosed` reports
   * closed, so a re-mint does not `dispose()` the double-mount's closed value a second time.
   * A bound property so the holder is handed it once at construction.
   */
  public readonly closeIfUncommitted = (dropped: TResource): void => {
    if (this.#committed?.resource === dropped || this.#reopening?.isClosed(dropped) === true) {
      return;
    }
    this.#close(dropped);
  };

  public constructor(close: (resource: TResource) => void) {
    this.#close = close;
  }

  /**
   * Hold the caller's latest disposal, apart from {@link commit}.
   *
   * A `close` minted per render must not restart the lifetime effect, which would close the
   * resource the frame on screen still reads. Written from the layout phase: every layout
   * effect for a commit runs before any passive cleanup, so a retired resource closes through
   * the disposal of the render that retired it.
   */
  public holdClose(close: (resource: TResource) => void): void {
    this.#close = close;
  }

  /**
   * Hold the caller's latest way of replacing a resource its `close` ended.
   *
   * `undefined` for a releasing caller. Held beside {@link holdClose} because all three parts
   * are minted per render.
   */
  public holdReopening(reopening: SubjectScopedResourceReopening<TResource> | undefined): void {
    this.#reopening = reopening;
  }

  /**
   * Record what this commit holds, or replace a value that is already closed.
   *
   * The disposal is read when the cleanup runs, so a resource retires through the caller's
   * newest `close`. A closed value is the double mount's second run: it is replaced through
   * the holder and this run records nothing; the run the publish causes does. An `open` that
   * keeps returning closed resources publishes until React's update-depth guard stops it,
   * since a bound here would leave the hook silently holding a closed resource.
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
