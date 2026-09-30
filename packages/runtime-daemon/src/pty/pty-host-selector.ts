// Selector that picks the `PtyHost` backend for a daemon process, so the rest of the daemon does
// not branch on platform. Backends: `NodePtyHost` (in-process `node-pty`) and
// `RustSidecarPtyHost` (out-of-process Rust binary). The default is `NodePtyHost` on every
// platform; `deps.platform` is not consulted.
//
// `AIS_PTY_BACKEND` is case-sensitive and matched verbatim, with no trimming:
//   - unset: the platform default, silently (the normal path, not a warn case).
//   - "rust-sidecar": `RustSidecarPtyHost` from the factory. A factory failure (binary missing,
//     spawn-time crash, crash budget exhausted) is wrapped as `PtyBackendUnavailableError`; one
//     the factory already threw as that error is rethrown unchanged.
//   - "node-pty": `NodePtyHost`, unconditionally.
//   - anything else, including "" and "Rust-Sidecar": the platform default plus a `warn`, because
//     a silent fallback would hide a misconfiguration.
//
// Env reader, warn sink and both factories are injectable through `PtyHostSelectorDeps`, so tests
// cover the whole grammar without real env, console or `node-pty`.

import type { PtyHost } from "@ai-sidekicks/contracts";

import { NodePtyHost } from "./node-pty-host.js";
import { createRustSidecarPtyHost, PtyBackendUnavailableError } from "./rust-sidecar-pty-host.js";

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

/**
 * Injectable dependencies for `selectPtyHost`. Production callers pass none: the defaults read
 * `process.env`, write to `console.warn` and construct the real hosts.
 */
export interface PtyHostSelectorDeps {
  /** Effective platform, default `process.platform`. Not consulted by the selection today. */
  readonly platform: NodeJS.Platform;
  /**
   * Reader for `AIS_PTY_BACKEND`, default `() => process.env["AIS_PTY_BACKEND"]` (bracket access
   * because `noPropertyAccessFromIndexSignature` is on). `undefined` means unset; any string,
   * including "", means set.
   */
  readonly readEnv: () => string | undefined;
  /** Sink for the unrecognized-value warning, default `console.warn`. */
  readonly warn: (message: string) => void;
  /** Factory for `NodePtyHost`, default `() => new NodePtyHost()`. */
  readonly createNodePtyHost: () => PtyHost;
  /**
   * Factory for `RustSidecarPtyHost`, default `createRustSidecarPtyHost`. A throw is wrapped as
   * `PtyBackendUnavailableError` by `selectPtyHost`.
   */
  readonly createRustSidecarPtyHost?: () => PtyHost;
}

// --------------------------------------------------------------------------
// Default deps
// --------------------------------------------------------------------------

/** `PtyHostSelectorDeps` with every field filled in, so callers read fields without checks. */
interface ResolvedPtyHostSelectorDeps {
  readonly platform: NodeJS.Platform;
  readonly readEnv: () => string | undefined;
  readonly warn: (message: string) => void;
  readonly createNodePtyHost: () => PtyHost;
  readonly createRustSidecarPtyHost: () => PtyHost;
}

function resolveDefaultDeps(partial: Partial<PtyHostSelectorDeps>): ResolvedPtyHostSelectorDeps {
  return {
    platform: partial.platform ?? process.platform,
    readEnv: partial.readEnv ?? (() => process.env["AIS_PTY_BACKEND"]),
    // TRIPWIRE: replace `console.warn` once a structured logger exists in the runtime-daemon.
    warn: partial.warn ?? ((msg: string) => console.warn(msg)),
    createNodePtyHost: partial.createNodePtyHost ?? ((): PtyHost => new NodePtyHost()),
    createRustSidecarPtyHost:
      partial.createRustSidecarPtyHost ?? ((): PtyHost => createRustSidecarPtyHost()),
  };
}

// --------------------------------------------------------------------------
// Selection
// --------------------------------------------------------------------------

/**
 * Picks the `PtyHost` backend for this daemon process from `AIS_PTY_BACKEND` (grammar in the
 * file header). Throws `PtyBackendUnavailableError` when the rust-sidecar factory fails.
 */
export function selectPtyHost(deps?: Partial<PtyHostSelectorDeps>): PtyHost {
  const resolved: ResolvedPtyHostSelectorDeps = resolveDefaultDeps(deps ?? {});
  const envValue: string | undefined = resolved.readEnv();

  // Unset is the normal path: the platform default, with no warning.
  if (envValue === undefined) {
    return platformDefault(resolved);
  }

  if (envValue === "rust-sidecar") {
    // A returned host does not prove the binary works; `RustSidecarPtyHost` methods report that
    // themselves with `PtyBackendUnavailableError`.
    try {
      return resolved.createRustSidecarPtyHost();
    } catch (err: unknown) {
      // Rethrow unchanged so the original `details.cause` survives.
      if (err instanceof PtyBackendUnavailableError) {
        throw err;
      }
      throw new PtyBackendUnavailableError(
        { attemptedBackend: "rust-sidecar", cause: err },
        "PtyHostSelector: createRustSidecarPtyHost factory threw; " +
          "rust-sidecar backend is unavailable.",
      );
    }
  }

  if (envValue === "node-pty") {
    return resolved.createNodePtyHost();
  }

  // Unrecognized value: warn, because a silent fallback would hide a misconfiguration.
  resolved.warn(`AIS_PTY_BACKEND='${envValue}' unrecognized; falling back to platform default`);
  return platformDefault(resolved);
}

/** The default backend: `NodePtyHost` on every platform; `deps.platform` is not consulted. */
function platformDefault(deps: ResolvedPtyHostSelectorDeps): PtyHost {
  return deps.createNodePtyHost();
}
