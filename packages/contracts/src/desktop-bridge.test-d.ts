// Conditional-type negative test against the `SidekicksBridge` interface.
//
// Verifies invariant (Plan-023 Phase 1 T-023p-1-4):
//   `Spec-023 §Acceptance Criteria` — "No auth material (daemon
//   session token, PASETO tokens, DPoP key, WebAuthn PRF output) appears
//   on the `window.sidekicks` surface — verified by a negative contract
//   test against the bridge's exposed type."
//
// How it works
// ------------
// 1. `AllKeys<T>` recursively flattens every string property name reachable
//    from `T` into a single union. The walker stops at function types (their
//    `keyof Function` chain is irrelevant) and at primitives (which are not
//    assignable to `object`).
// 2. `ContainsForbidden<K>` matches any key whose lowercased form contains
//    "token", "dpop", "prf", or "secret" as a substring, via template-literal
//    types.
// 3. `Offenders` is the union of every flattened bridge key that matches one
//    of the forbidden substrings. The bridge is invariant-compliant iff
//    `Offenders` is `never`.
// 4. `AssertNever<T extends never>` is a type-level assertion that fails to
//    compile (with TS2344: "Type X does not satisfy the constraint 'never'")
//    if `T` is anything other than `never`. Using `Offenders` as the argument
//    makes the file fail to typecheck the moment a forbidden key enters the
//    bridge.
//
// Why `AssertNever` instead of `const _: Offenders = null as never`
// ----------------------------------------------------------------
// The naive guard `const _g: Offenders = null as never` does NOT enforce the
// invariant because `never` is assignable to ANY type — the assignment would
// typecheck regardless of `Offenders`. The constraint-violation pattern
// (`AssertNever<T extends never>`) is the canonical TS recipe: TS errors
// with TS2344 when `T` is non-never, which is the failure we want.
//
// Negative-test verification (Plan-023 Phase 1 T-023p-1-4 acceptance):
//   • inject `sessionToken: string;` under `SidekicksBridge["app"]`
//   • run `pnpm --filter @ai-sidekicks/contracts typecheck`
//   • expect TS2344 at the `AssertNever<Offenders>` line below
//   • restore + re-run to confirm typecheck passes
// This dance is run during the implementing task; subsequent edits to the
// bridge re-trigger the same check in CI typecheck.

import type { SidekicksBridge } from "./desktop-bridge.js";

/**
 * Flatten every string property name reachable from `T` into a single union.
 *
 * Stops at:
 *   • function types (their `keyof Function` chain is irrelevant and would
 *     otherwise expand into call/apply/bind/name/length/prototype keys)
 *   • primitives (not assignable to `object`, so the conditional terminates)
 */
type AllKeys<T> = T extends (...args: never[]) => unknown
  ? never
  : T extends object
    ? { [K in keyof T]: K extends string ? K | AllKeys<T[K]> : never }[keyof T]
    : never;

/** Union of every string property name reachable from `SidekicksBridge`. */
type BridgeKeys = AllKeys<SidekicksBridge>;

/**
 * Match any key whose lowercased form contains a forbidden substring.
 * Template-literal types perform substring match with `${string}…${string}`.
 *
 * Distribution: the outer `K extends string ? … : never` wrapper forces TS to
 * distribute the conditional over each member of the input union (e.g., the
 * `BridgeKeys` union below). WITHOUT the wrapper, `Lowercase<K>` is not a
 * naked type parameter so the conditional does NOT distribute — the whole
 * union must satisfy the template-literal extends check, which it almost
 * never does, silently yielding `never` and defeating the invariant check.
 * This is the standard TS recipe for substring-match-over-a-union.
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

/**
 * Union of every bridge key matching a forbidden substring. The
 * Spec-023 invariant holds iff this resolves to `never`.
 */
type Offenders = ContainsForbidden<BridgeKeys>;

/**
 * Type-level constraint failure when `T` is non-never. TS2344 fires at the
 * `AssertNever<Offenders>` instantiation below if `Offenders` is anything
 * other than `never` — i.e., if any key in `SidekicksBridge` matches the
 * forbidden-substring set.
 *
 * Note: `@typescript-eslint/no-unused-vars` (the rule active in this repo's
 * flat config) does not flag unused type aliases — only unused values. No
 * eslint-disable is required.
 */
type AssertNever<T extends never> = T;

/**
 * Load-bearing assertion. If `SidekicksBridge` ever grows a property name
 * matching /token|dpop|prf|secret/i (at any depth), `Offenders` becomes a
 * non-never union and this line fails compilation with TS2344, blocking
 * `pnpm --filter @ai-sidekicks/contracts typecheck`.
 *
 * The `_` prefix matches the repo lint config's `varsIgnorePattern: "^_"`
 * (eslint.config.mjs), but as a type alias it would not be flagged anyway.
 */
type _NoForbiddenKeysOnBridge = AssertNever<Offenders>;
