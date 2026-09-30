// Type-level guard: no property name reachable from `PreloadApi` contains "token", "dpop" or
// "secret", so no auth material appears on `window.desktopBridge`. The typecheck fails with
// TS2344 at the `AssertNever<Offenders>` line the moment such a key enters the bridge.
//
// `AssertNever<T extends never>` is the guard rather than `const _: Offenders = null as never`,
// because `never` is assignable to any type and that assignment would typecheck regardless.

import type { PreloadApi } from "./preload-api.js";

/** Every string property name reachable from `T`, stopping at function types and primitives. */
type AllKeys<T> = T extends (...args: never[]) => unknown
  ? never
  : T extends object
    ? { [K in keyof T]: K extends string ? K | AllKeys<T[K]> : never }[keyof T]
    : never;

/** Union of every string property name reachable from `PreloadApi`. */
type BridgeKeys = AllKeys<PreloadApi>;

/**
 * Any key whose lowercased form contains a forbidden substring. The outer `K extends string`
 * makes the conditional distribute over the union; without it `Lowercase<K>` is not a naked
 * type parameter, the check silently yields `never`, and the guard passes vacuously.
 */
type ContainsForbidden<K extends string> = K extends string
  ? Lowercase<K> extends `${string}token${string}`
    ? K
    : Lowercase<K> extends `${string}dpop${string}`
      ? K
      : Lowercase<K> extends `${string}secret${string}`
        ? K
        : never
  : never;

/** Every bridge key matching a forbidden substring; `never` when the bridge is clean. */
type Offenders = ContainsForbidden<BridgeKeys>;

/** Fails to compile (TS2344) when `T` is anything other than `never`. */
type AssertNever<T extends never> = T;

/** Fails the typecheck if `PreloadApi` grows a property name matching /token|dpop|secret/i. */
type _NoForbiddenKeysOnBridge = AssertNever<Offenders>;
