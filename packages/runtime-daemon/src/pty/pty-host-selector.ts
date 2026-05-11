// Selector that picks the production `PtyHost` backend for a given
// daemon process.
//
// Why this exists
// ---------------
//
// Plan-024 ships two backends behind the `PtyHost` contract:
//   * `NodePtyHost`           — in-process `node-pty` wrapper (Phase 2,
//                                primary on macOS/Linux at every phase,
//                                Phase 5 Windows-fallback).
//   * `RustSidecarPtyHost`    — out-of-process Rust binary marshalled
//                                over Content-Length framing (Phase 3+,
//                                Phase 5 Windows-primary).
//
// The selector centralizes the "which backend do we instantiate?"
// decision so the rest of the daemon stays oblivious to the platform
// branch. Today (Phase 2) the answer is always `NodePtyHost`; the
// Phase 5 PR will extend the `platformDefault()` branch to flip to
// `RustSidecarPtyHost` on `win32` with a `NodePtyHost` fallback when
// the sidecar binary is not resolvable. macOS/Linux remain on
// `NodePtyHost` primary at Phase 5 and beyond.
//
// Env-var override grammar (F-024-2-07 / Plan-024:126)
// ----------------------------------------------------
//
// `AIS_PTY_BACKEND` is **case-sensitive lowercase**:
//
//   * `undefined`    — env unset; return platform default silently
//                       (the normal path, NOT a warn case).
//   * `"rust-sidecar"` — Phase 2: THROWS `Error("...not yet wired...")`.
//                       Phase 3+: returns RustSidecarPtyHost (requires
//                       the optional sidecar package; throws
//                       `PtyBackendUnavailable` if not resolvable on
//                       macOS/Linux).
//   * `"node-pty"`    — return NodePtyHost unconditionally.
//   * any other value (including empty string `""`, mixed case like
//     `"Rust-Sidecar"`, typos like `"sidecar"`): fall back to platform
//     default + emit `console.warn(\`AIS_PTY_BACKEND='<value>'
//     unrecognized; falling back to platform default\`)`. The warn is
//     load-bearing — silent fallback hides operator misconfig.
//
// Architectural seam — `PtyHostSelectorDeps`
// ------------------------------------------
//
// Every effectful primitive — the env-var reader, the warn sink, and
// the two backend factories — is reachable through an injectable
// `Deps` record. Production callers pass nothing (defaults wire to
// `process.env`, `console.warn`, and `() => new NodePtyHost()`); tests
// inject `vi.fn()` doubles so the entire selection grammar can be
// exercised without touching real env-vars, the real console sink, or
// the real `NodePtyHost` constructor (which lazily loads `node-pty`).
// Same DI pattern as `NodePtyHostDeps` from T-024-2-2.
//
// Refs: Plan-024 §Implementation Step 9, §F-024-2-02, §F-024-2-07;
// ADR-019 §Decision item 1.

import type { PtyHost } from "@ai-sidekicks/contracts";

import { NodePtyHost } from "./node-pty-host.js";

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

/**
 * Recognized `AIS_PTY_BACKEND` env-var values per F-024-2-07.
 *
 * Case-sensitive lowercase. Any string outside this union (including
 * empty string, uppercase variants, typos) is "unrecognized" and falls
 * back to the platform default with a `console.warn` per Plan-024:126.
 */
export type PtyBackendName = "rust-sidecar" | "node-pty";

/**
 * Optional dependencies for `selectPtyHost`.
 *
 * Production callers pass nothing — defaults resolve to `process.env`,
 * `console.warn`, and the real `NodePtyHost` constructor. Tests inject
 * `vi.fn()` doubles to exercise the grammar without touching real env,
 * real console, or `node-pty`'s lazy loader.
 */
export interface PtyHostSelectorDeps {
  /**
   * Effective platform. Defaults to `process.platform`.
   *
   * At Phase 2 this field is NOT consulted by the selection logic —
   * the platform default is always `NodePtyHost` regardless. The field
   * exists in the deps record so Phase 5 can add the `win32 →
   * RustSidecarPtyHost` primary-flip without an API change.
   */
  readonly platform: NodeJS.Platform;
  /**
   * Reader for the `AIS_PTY_BACKEND` env-var. Defaults to
   * `() => process.env["AIS_PTY_BACKEND"]`.
   *
   * Bracket notation is required by this repo's tsconfig
   * (`noPropertyAccessFromIndexSignature: true`) — dot-notation on
   * `process.env` does not compile here, so the literal default above
   * is copy-paste-correct.
   *
   * Returning `undefined` means "env not set" (silent platform-default
   * path); any string — including empty string `""` — means "env set",
   * which routes through the grammar (recognized → selected backend;
   * unrecognized → warn + fallback).
   */
  readonly readEnv: () => string | undefined;
  /**
   * Warn sink for unrecognized env-var values. Defaults to
   * `console.warn`. Tests inject `vi.fn()` to assert message shape.
   */
  readonly warn: (message: string) => void;
  /**
   * Factory for `NodePtyHost`. Defaults to `() => new NodePtyHost()`.
   *
   * Tests inject a sentinel-returning stub so the selector can be
   * exercised without paying the cost of `NodePtyHost`'s lazy
   * `node-pty` loader.
   */
  readonly createNodePtyHost: () => PtyHost;
  /**
   * Factory for `RustSidecarPtyHost`. Phase 2: omitted by design —
   * the `rust-sidecar` env-var branch throws `Error("not yet wired")`
   * unconditionally and never calls this factory.
   *
   * TODO(Phase 3 T-024-3-2): wire a real factory and replace the
   * unconditional throw in `selectPtyHost` with a call to this. At
   * that point, document that an injected factory takes precedence
   * over the throw site (so tests can keep using injected sentinels).
   */
  readonly createRustSidecarPtyHost?: () => PtyHost;
}

// --------------------------------------------------------------------------
// Default deps
// --------------------------------------------------------------------------

/**
 * Default dep resolution — env-var read, console.warn sink, real
 * `NodePtyHost` factory. Per the same merge-with-partial pattern as
 * `NodePtyHostDeps.resolveDefaultDeps`, each user-supplied field
 * overrides the matching default; unspecified fields keep their
 * production wiring.
 *
 * `exactOptionalPropertyTypes: true` forbids spreading `undefined`
 * into an optional field, so `createRustSidecarPtyHost` is added via
 * conditional spread only when the partial supplies it.
 */
function resolveDefaultDeps(partial: Partial<PtyHostSelectorDeps>): PtyHostSelectorDeps {
  const base: {
    readonly platform: NodeJS.Platform;
    readonly readEnv: () => string | undefined;
    readonly warn: (message: string) => void;
    readonly createNodePtyHost: () => PtyHost;
  } = {
    platform: partial.platform ?? process.platform,
    readEnv: partial.readEnv ?? (() => process.env["AIS_PTY_BACKEND"]),
    // TRIPWIRE: replace `console.warn` once a structured logger
    // surfaces in the runtime-daemon (matches the pattern in
    // `node-pty-host.ts` — `defaultSpawnTaskkill` and
    // `invokeTaskkill` use the same primitive for the same reason).
    warn: partial.warn ?? ((msg: string) => console.warn(msg)),
    createNodePtyHost: partial.createNodePtyHost ?? ((): PtyHost => new NodePtyHost()),
  };
  return {
    ...base,
    ...(partial.createRustSidecarPtyHost !== undefined
      ? { createRustSidecarPtyHost: partial.createRustSidecarPtyHost }
      : {}),
  };
}

// --------------------------------------------------------------------------
// Selection
// --------------------------------------------------------------------------

/**
 * Pick the production `PtyHost` backend for the current daemon process.
 *
 * Selection grammar (see file-header comment for the full spec):
 *
 *   * `AIS_PTY_BACKEND` unset           → platform default (Phase 2:
 *                                          always NodePtyHost).
 *   * `AIS_PTY_BACKEND="rust-sidecar"`  → Phase 2: throws
 *                                          `Error("...not yet wired...")`.
 *                                          Phase 3+: returns
 *                                          RustSidecarPtyHost.
 *   * `AIS_PTY_BACKEND="node-pty"`      → returns NodePtyHost.
 *   * any other value (incl. empty)     → warn + platform default.
 *
 * @param deps Optional dep overrides. Production callers pass nothing;
 *             tests inject `vi.fn()` doubles for `readEnv`, `warn`, and
 *             the factories.
 */
export function selectPtyHost(deps?: Partial<PtyHostSelectorDeps>): PtyHost {
  const resolved: PtyHostSelectorDeps = resolveDefaultDeps(deps ?? {});
  const envValue: string | undefined = resolved.readEnv();

  // "env not set" — normal path. Silent platform-default. NO warn.
  if (envValue === undefined) {
    return platformDefault(resolved);
  }

  if (envValue === "rust-sidecar") {
    // Phase 2 caveat: `RustSidecarPtyHost` is unimplemented. Per
    // F-024-2-02 the env-var IS honored (we don't silently fall back),
    // and per Plan-024 §Step 9 lines 123–124 + the T-024-2-3 brief we
    // throw a plain `Error` with "not yet wired" in the message so the
    // caller learns immediately that the env-var is set but the
    // backend is missing.
    //
    // TODO(Phase 3 T-024-3-2): replace this throw with a call to
    //   resolved.createRustSidecarPtyHost?.() ?? throw PtyBackendUnavailable(...)
    // The `PtyBackendUnavailable` error type is defined by T-024-3-2;
    // until then a plain `Error` is the contract.
    throw new Error(
      "PtyHostSelector: AIS_PTY_BACKEND=rust-sidecar is not yet wired " +
        "(Phase 3 work — see Plan-024 §Implementation Step 9 + " +
        "T-024-3-2). Until then, use AIS_PTY_BACKEND=node-pty or leave " +
        "the env-var unset.",
    );
  }

  if (envValue === "node-pty") {
    return resolved.createNodePtyHost();
  }

  // Unrecognized value (mixed-case, typo, empty string, etc). Per
  // Plan-024:126 we emit a warn AND fall back to the platform default
  // — silent fallback would hide operator misconfig.
  resolved.warn(`AIS_PTY_BACKEND='${envValue}' unrecognized; falling back to platform default`);
  return platformDefault(resolved);
}

/**
 * Resolve the platform default backend.
 *
 * **Phase 2 contract: always `NodePtyHost` on every platform** (Plan-024
 * §Step 9 line 124). This intentionally does NOT consult `deps.platform`
 * — the platform branch is dead at Phase 2, and adding a no-op branch
 * here would dilute the contract.
 *
 * TODO(Phase 5): flip the `win32` branch to `RustSidecarPtyHost` with a
 * `NodePtyHost` fallback when the sidecar binary is not resolvable.
 * macOS/Linux MUST remain on `NodePtyHost` primary at Phase 5 and
 * beyond per Plan-024 §Step 9 lines 124–125.
 */
function platformDefault(deps: PtyHostSelectorDeps): PtyHost {
  return deps.createNodePtyHost();
}
