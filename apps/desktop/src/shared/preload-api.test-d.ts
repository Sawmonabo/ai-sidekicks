// Type-level guard: no property name reachable from `PreloadApi`, including through what its
// methods return, contains "token", "dpop", "prf" or "secret", so no auth material appears on
// `window.desktopBridge`. The typecheck fails with TS2344 at the `AssertNever<Offenders>` line
// the moment such a key enters the bridge.
//
// `AssertNever<T extends never>` is the guard rather than `const _: Offenders = null as never`,
// because `never` is assignable to any type and that assignment would typecheck regardless.

import type { PreloadApi } from "./preload-api.js";

/**
 * How many levels deep the walk goes, so a recursive type cannot expand forever. A key nested
 * deeper than this is not checked.
 */
type WalkDepthLimit = 12;

/**
 * Every string property name reachable from `T`: an object's keys and their values' keys, an
 * array's element keys, and a function's awaited return type's keys. Primitives, branded ones
 * included, add nothing. An index signature contributes its value's keys but not `string`
 * itself, which would absorb every literal key in the union and leave nothing to match.
 */
type AllKeys<T, Depth extends readonly unknown[] = []> = Depth["length"] extends WalkDepthLimit
  ? never
  : T extends string | number | boolean | bigint | symbol
    ? never
    : T extends (...args: never[]) => infer Result
      ? AllKeys<Awaited<Result>, [...Depth, unknown]>
      : T extends readonly (infer Element)[]
        ? AllKeys<Element, [...Depth, unknown]>
        : T extends object
          ? {
              [K in keyof T]-?: K extends string
                ? (string extends K ? never : K) | AllKeys<T[K], [...Depth, unknown]>
                : never;
            }[keyof T]
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
      : Lowercase<K> extends `${string}prf${string}`
        ? K
        : Lowercase<K> extends `${string}secret${string}`
          ? K
          : never
  : never;

/** Every bridge key matching a forbidden substring; `never` when the bridge is clean. */
type Offenders = ContainsForbidden<BridgeKeys>;

/** Fails to compile (TS2344) when `T` is anything other than `never`. */
type AssertNever<T extends never> = T;

/**
 * Fails the typecheck if `PreloadApi` grows a property name, or a method returns a value with a
 * property name, matching /token|dpop|prf|secret/i.
 */
type _NoForbiddenKeysOnBridge = AssertNever<Offenders>;
