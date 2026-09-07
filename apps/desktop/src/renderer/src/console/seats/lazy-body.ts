// A registered body that is not on the initial import graph, and everything that
// follows from saying so.
//
// WHY THE BOUNDARY IS AT THE REGISTRY AND NOT IN THE FAMILIES
//
// Every view family registers what it draws through one of the console's boards — the
// deck's pane registry and the frame's surface registry — by static import, so every
// family's body code sits in the entry chunk whether or not that pane or that route is
// ever reached. Measured on the `renderer-initial-bundle` budget
// (`Spec-023 §Console Design (Meridian)` §Budgets, ≤ 450 kB gzip): four landed families
// spend it to about 79 %, and two more families each carry it past the ceiling on their
// own. The budget is the spec's, so what has to change is the registration.
//
// It changes ONCE, here, rather than per family and rather than per board. A family
// supplies a `body` loader instead of a `render` function; the board normalises it into
// the same resolved descriptor every mount site already reads. That is what keeps
// `PaneHarnessSurface`'s claim true — the thing it measures is what the DECK would
// mount — and what lets a family that has not landed yet take this form verbatim.
//
// WHY PRELOAD RATHER THAN A STATIC IMPORT
//
// The two are the same eventual code. A static import pays for it on every launch, in
// the entry graph, for every surface nobody opens; a loader pays for it once, off the
// critical path, on an idle callback after the first frame — and by the time a person
// can have reached the control that opens it, the module is already resolved. So the
// first open is warm either way and only one of them is charged to the launch.
//
// A registration's loader IS its preload: there is one function, called from the mount,
// from the palette's highlighted entry, from an address about to open, and from the idle
// warm, and its promise is memoised here so those callers cannot each start a fetch.

import { createElement, lazy, type LazyExoticComponent } from "react";

import { LazyBody } from "./LazyBody.js";

/**
 * The module a lazily loaded body is loaded from.
 *
 * The export name is fixed by this contract rather than left to the family, so a board
 * composes one specifier shape and a body module is recognisable as one by reading its
 * exports. `Body` and not `default`: the package admits `export default` only for tool
 * configuration at the root, and a default export here would be the one place in the
 * console where a body had no name.
 */
export interface LazyBodyModule<TContext extends object> {
  readonly Body: (context: TContext) => React.ReactNode;
}

/**
 * How a registration reaches its body.
 *
 * Written at the call site as `body: () => import("./diff-pane/diff-pane-body.js")`, which is
 * what makes the boundary visible in the family's own registrar: the module specifier is
 * right there, and the bundler's chunk split follows it.
 */
export type LazyBodyLoader<TContext extends object> = () => Promise<LazyBodyModule<TContext>>;

/**
 * What the idle warm needs of a board, and the whole of it.
 *
 * A port rather than either registry's own type, because the walk is the same walk for
 * both and a second copy of it keyed on the other board would be one scheduler to keep
 * in step with another.
 */
export interface LazyBodyBoard<TKey> {
  /** Which registered keys still have a body to load, in declaration order. */
  unloadedKeys: () => readonly TKey[];
  /** Start that key's body loading. Idempotent; settles immediately for a loaded one. */
  preload: (key: TKey) => Promise<void>;
}

/**
 * One loader-backed body: the module it loads, the component that mounts it, and the
 * single in-flight promise every caller shares.
 *
 * A CLASS BECAUSE THE MEMO IS STATE. The promise, and the lazy component built over it,
 * are resources whose identity must not change: a second `lazy()` for one registration
 * is a second component type, and a host that re-rendered across the swap would unmount
 * the body and rebuild it. Module-scope caches are rejected by the package standard for
 * the reason they would be wrong here — two boards in one process (an auxiliary window,
 * a suite composing its own) would share one.
 */
export class LoadedLazyBody<TContext extends object> {
  readonly #loader: LazyBodyLoader<TContext>;
  readonly #fallback: (context: TContext) => React.ReactNode;
  /**
   * The one in-flight or fulfilled load.
   *
   * `undefined` until something asks for it, and `undefined` again once a load has
   * rejected — see {@link load} for why that second state exists.
   */
  #pending: Promise<LazyBodyModule<TContext>> | undefined;
  /**
   * The mounted form, built once per load that can still succeed.
   *
   * Built in the constructor rather than on first render, because its IDENTITY is what
   * React reconciles the body by and a getter minting one per call would remount on
   * every render. Constructing it starts no load: `lazy` calls its argument on first
   * render and not before, which is precisely why a preload has to exist beside it.
   *
   * REBUILT WHEN A LOAD REJECTS, AND ONLY THEN. `lazy` marks its payload rejected the
   * first time the initializer's promise fails and never calls that initializer again —
   * so clearing the memo below would leave the retry unreachable from a MOUNT, which is
   * the one path the boundary's "Try again" takes: it would re-throw the cached
   * rejection without asking this registration for anything. A fresh `lazy` is a fresh
   * payload, and the identity change lands on a subtree the boundary is remounting
   * anyway — `LazyBody` re-derives its pin from it, which is the same path a
   * re-registration takes and the reason that path exists.
   */
  #component: LazyExoticComponent<(context: TContext) => React.ReactNode>;

  /**
   * The body itself, once a load has settled — the thing a warmed mount renders.
   *
   * WHY A PRELOAD IS NOT ENOUGH WITHOUT IT. `lazy` calls its initializer on the first
   * RENDER, and the initializer returns a thenable whichever state the underlying
   * promise is in; React learns the value in the microtask that thenable resolves in, so
   * it suspends for that turn and commits the fallback. The whole point of warming a
   * destination before the route commits is that nobody sees the reserved frame, and
   * without this field they saw it anyway — for one frame, on exactly the path that had
   * done the work to avoid it.
   *
   * `undefined` while nothing has settled, which is also what `render` branches on.
   */
  #resolvedBody: ((context: TContext) => React.ReactNode) | undefined;

  public constructor(
    loader: LazyBodyLoader<TContext>,
    fallback: (context: TContext) => React.ReactNode,
  ) {
    this.#loader = loader;
    this.#fallback = fallback;
    this.#component = this.#mintComponent();
  }

  /**
   * Resolve the module, at most once per load that succeeds.
   *
   * Memoised on the PROMISE rather than on the settled value, so a caller arriving while
   * the first load is in flight joins it instead of starting a second: the palette
   * highlighting an entry and the idle warm walking the board are exactly that race.
   *
   * A FULFILLED LOAD IS MEMOISED FOREVER. A REJECTED ONE IS NOT, and keeping it was a
   * defect rather than a policy. The memo outlives every mount — the registration is the
   * board's and the board is the window's — so a retained rejection poisoned the
   * registration for the life of the window: `SurfaceErrorBoundary`'s "Try again"
   * remounted the subtree onto the same dead promise without the loader ever being asked
   * again, and navigating away and back arrived at it too. Clearing it is what makes the
   * next ask a real request.
   *
   * AND CLEARING IS NOT RETRYING, which is what keeps the spin the old rule feared —
   * a damaged install re-fetching a chunk in a loop — off this path. Nothing here
   * re-asks; the clear only decides what the next ASK does. The one caller that walks a
   * board unasked is `lazy-body-warm.ts`, and it takes each key at most once per walk,
   * so a chunk that will not load is re-requested when a person opens that surface again
   * and at no other moment.
   */
  public async load(): Promise<LazyBodyModule<TContext>> {
    const pending = this.#pending ?? this.#mintPendingLoad();
    this.#pending = pending;
    const loaded = await pending;
    this.#resolvedBody = loaded.Body;
    return loaded;
  }

  /**
   * Has this body's module been asked for, and is that ask still good?
   *
   * Read by the warm walk, never by a render. False again after a rejection, because
   * what the boards ask it — which registered keys still have a body to load — is true
   * of this one again once the memo is gone.
   */
  public get isResolved(): boolean {
    return this.#pending !== undefined;
  }

  /**
   * Start one load and arrange for its rejection to release the memo.
   *
   * ATTACHED WHERE THE PROMISE IS MINTED, not inside `load`. `load` is called by every
   * caller that joins an in-flight load, so a continuation attached there would be
   * attached once per CALLER: on a rejection they would fire in turn, and the second
   * would clear the memo the first caller's retry had already installed — a load in
   * flight, thrown away, and a third fetch started for a body two callers were waiting
   * on. One mint, one continuation.
   *
   * The identity comparison is what makes that rule total rather than argued: only the
   * promise that is STILL the memo may clear it, so an older rejection landing after
   * anything else has installed a newer load leaves that newer load alone.
   */
  #mintPendingLoad(): Promise<LazyBodyModule<TContext>> {
    const pending = this.#loader();
    void pending.catch(() => {
      if (this.#pending !== pending) {
        return;
      }
      this.#pending = undefined;
      this.#component = this.#mintComponent();
    });
    return pending;
  }

  /** The `lazy()` form over this registration's memo, whichever load is current. */
  #mintComponent(): LazyExoticComponent<(context: TContext) => React.ReactNode> {
    return lazy(async () => ({ default: (await this.load()).Body }));
  }

  /**
   * The descriptor's `render`, so every mount site is unchanged.
   *
   * Returns an ELEMENT rather than calling the body, which is the shape a component-form
   * registration already produces: the body's hooks belong to the body, and a render
   * that invoked it inline would splice them into whichever host called `render`.
   */
  public render = (context: TContext): React.ReactNode =>
    createElement(LazyBody<TContext>, {
      Body: this.#component,
      // Read at RENDER time, so a mount that begins after a completed preload is handed
      // the settled body and never suspends. `LazyBody` pins whichever arm it was handed
      // for the life of that mount — see its own `useState` and the reason there — so a
      // body that started cold does not have its component identity swapped underneath
      // it when the module lands mid-flight.
      resolvedBody: this.#resolvedBody,
      fallback: this.#fallback,
      context,
    });
}
