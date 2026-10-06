// A registered body that is not on the initial import graph.
//
// Static registration would put every feature's body in the entry chunk, which has a gzip
// budget. A feature supplies a `body` loader instead of a `render` function and the board
// normalizes it into the same descriptor every mount site reads. A registration's loader is
// also its preload: it is called from the mount, the palette, an address about to open and the
// idle warm, and its promise is memoized so those callers share one fetch.

import { createElement, lazy, type LazyExoticComponent } from "react";

import { MemoizedLoad } from "#renderer/lib/memoized-load.js";
import { LazyBody } from "./LazyBody.js";

/** The module a lazily loaded body comes from; it exports `Body`, never `default`. */
export interface LazyBodyModule<TContext extends object> {
  readonly Body: (context: TContext) => React.ReactNode;
}

/**
 * How a registration reaches its body, written at the call site as
 * `body: () => import("./pane-body.js")` so the bundler splits a chunk there.
 */
export type LazyBodyLoader<TContext extends object> = () => Promise<LazyBodyModule<TContext>>;

/** What the idle warm needs of a board; both the pane and screen registries satisfy it. */
export interface PreloadableRegistry<TKey> {
  /** Which registered keys still have a body to load, in declaration order. */
  unloadedKeys: () => readonly TKey[];
  /** Start that key's body loading. Idempotent; settles immediately for a loaded one. */
  preload: (key: TKey) => Promise<void>;
}

/**
 * One loader-backed body: the module it loads, the component that mounts it, and the single
 * in-flight promise every caller shares. Per-instance rather than module-scope, so two boards
 * in one process do not share a memo.
 */
export class LoaderBackedBody<TContext extends object> {
  /** The one shared load; a rejected one is released and mints a fresh component with it. */
  readonly #moduleLoad: MemoizedLoad<LazyBodyModule<TContext>>;
  readonly #fallback: (context: TContext) => React.ReactNode;
  /**
   * The mounted form. Its identity is what React reconciles by, so it is built once, and
   * rebuilt only when a load rejects: `lazy` never re-runs a rejected initializer, so without a
   * fresh one `Retry` would re-throw the cached rejection. Building it starts no load.
   */
  #component: LazyExoticComponent<(context: TContext) => React.ReactNode>;

  /**
   * The body once a load has settled. A warmed mount renders it directly: `lazy` learns its
   * value in a microtask even for a resolved promise, which would commit one fallback frame.
   */
  #resolvedBody: ((context: TContext) => React.ReactNode) | undefined;

  /**
   * The descriptor's `render`. Returns an element rather than calling the body, so the body's hooks
   * stay its own.
   */
  public render = (context: TContext): React.ReactNode =>
    createElement(LazyBody<TContext>, {
      Body: this.#component,
      // Read at render time, so a mount after a completed preload never suspends.
      resolvedBody: this.#resolvedBody,
      fallback: this.#fallback,
      context,
    });

  public constructor(
    loader: LazyBodyLoader<TContext>,
    fallback: (context: TContext) => React.ReactNode,
  ) {
    this.#moduleLoad = new MemoizedLoad(loader, () => {
      this.#component = this.#mintComponent();
    });
    this.#fallback = fallback;
    this.#component = this.#mintComponent();
  }

  /**
   * Resolves the module. The promise is memoized, so callers arriving mid-load join it. A
   * fulfilled load is kept for good; a rejected one is released so the next ask (a retry or
   * a reopen) is a real request. Nothing here re-asks on its own.
   */
  public async load(): Promise<LazyBodyModule<TContext>> {
    const loaded = await this.#moduleLoad.load();
    this.#resolvedBody = loaded.Body;
    return loaded;
  }

  /**
   * True once the module has been asked for and the ask has not rejected; read by the warm walk.
   */
  public get isResolved(): boolean {
    return this.#moduleLoad.isStarted;
  }

  /** The `lazy()` form over this registration's memo, whichever load is current. */
  #mintComponent(): LazyExoticComponent<(context: TContext) => React.ReactNode> {
    return lazy(async () => ({ default: (await this.load()).Body }));
  }
}
