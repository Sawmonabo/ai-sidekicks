// In-process `node-pty` implementation of the `PtyHost` contract.
//
// Why this exists
// ---------------
//
// Plan-024 (Rust PTY Sidecar) ships two backends behind the `PtyHost`
// interface published from `@ai-sidekicks/contracts`: a Rust sidecar
// primary on Windows (Phase 3) and this in-process `node-pty` wrapper
// (Phase 2). On macOS / Linux `NodePtyHost` is the primary backend at
// every phase (no behavioral regression vs the pre-Plan-024 daemon).
// On Windows it is the fallback backend used when the sidecar binary is
// not resolvable; until the Phase 5 selector default-flip lands it is
// ALSO the Windows default (per Plan-024 Phase 2 selector-default-Node
// statement; see `pty-host-selector.ts` at T-024-2-3).
//
// Why the Windows kill-translation lives here, not in `node-pty`
// --------------------------------------------------------------
//
// `node-pty.kill(signal)` on Windows signals a single PID via the
// `node-pty` C++ binding and does NOT walk console-control-event /
// process-tree semantics ([microsoft/node-pty#167],
// [microsoft/node-pty#437]). Plan-024 §Invariants I-024-1 and I-024-2
// promote that gap to load-bearing daemon-layer obligations:
//
//   * I-024-1: `PtyHost.kill` on Windows MUST translate POSIX signal
//     semantics to the `GenerateConsoleCtrlEvent` Win32 API
//     (`SIGINT` → `CTRL_C_EVENT`; graceful hard-stop → `CTRL_BREAK_EVENT`
//     then escalation per I-024-2).
//   * I-024-2: hard-stop MUST `taskkill /T /F` the entire descendant
//     tree (single-PID kill leaves orphans on Windows); reaping MUST be
//     bounded-timeout (2 s wall-clock) and idempotent — `onExit` MUST
//     fire on the daemon path regardless of whether the OS reap stalls.
//
// `node-pty` does not expose the `GenerateConsoleCtrlEvent` primitive,
// so we bind it via FFI. The binding loads lazily on the first Windows
// kill invocation so non-Windows installs (the vast majority of dev
// boxes) never pay the load cost and `koffi` can be an
// `optionalDependencies` entry rather than a hard requirement.
//
// Architectural seam — `NodePtyHostDeps`
// --------------------------------------
//
// Every effectful primitive — `node-pty.spawn`, the FFI binding, the
// `taskkill` child-process spawn, and `setTimeout` for the 2 s
// escalation budget — is reachable through an injectable `Deps` record.
// Production code resolves real implementations lazily; tests inject
// `vi.fn()` mocks so Test K1 / Test K3 run on every platform without
// requiring `node-pty` itself, `koffi`, or Windows APIs to be available
// in the test environment. This is the architectural seam pattern;
// see also `pty-host-selector.ts` at T-024-2-3 for the parallel
// selector-side seam (the selector's `PtyHostSelectorDeps` follows the
// same constructor-injected, resolve-with-defaults shape used here).
//
// Refs: Plan-024 §Implementation Steps 8, §Invariants I-024-1, I-024-2;
// ADR-019 §Decision item 1, §Failure Mode Analysis row "kill propagation".

import { randomUUID } from "node:crypto";

import type {
  DrainResult,
  PtyHost,
  PtySignal,
  SpawnRequest,
  SpawnResponse,
} from "@ai-sidekicks/contracts";

import { PtyBackendUnavailableError } from "./rust-sidecar-pty-host.js";
import { defaultSpawnTaskkill, type TaskkillResult } from "./taskkill-windows.js";

// --------------------------------------------------------------------------
// `node-pty` minimal type surface
// --------------------------------------------------------------------------
//
// We intentionally declare local types rather than importing from
// `node-pty` at the type layer. Two reasons:
//   1. `node-pty` is loaded lazily via dynamic import — the file is
//      `import`-free of `node-pty` so non-Windows installs that opt out
//      of the optional native dep still typecheck cleanly.
//   2. The injectable `Deps.ptySpawn` seam means tests never load
//      `node-pty` at all. Local types document exactly the surface we
//      consume, which doubles as a contract-narrowing audit (we touch
//      only `pid`, `onData`, `onExit`, `kill`, `resize`, `write`).
//
// If the upstream `node-pty` v1 beta tightens or relaxes these shapes
// in a future release, update this block to match. The package.json
// pin (`^1.2.0-beta.12` per `Plan-024 §Target Areas`) caps the drift surface.

/** Shape of a single PTY-child wrapper as returned by `node-pty.spawn`. */
export interface NodePtyChild {
  /** OS-level process id of the child attached to the PTY pair. */
  readonly pid: number;
  /** Subscribe to stdout/stderr chunks. Returns a disposable handle. */
  onData(listener: (chunk: string | Uint8Array) => void): { dispose: () => void };
  /** Subscribe to child-exit. Returns a disposable handle. */
  onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): {
    dispose: () => void;
  };
  /** Send a POSIX signal name to the child. POSIX-only behavior. */
  kill(signal?: string): void;
  /** Resize the PTY window. */
  resize(cols: number, rows: number): void;
  /** Write a chunk to the PTY's master FD. */
  write(data: string | Uint8Array): void;
}

/** Options passed to `node-pty.spawn`. */
export interface NodePtySpawnOptions {
  readonly name?: string;
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string;
  readonly env: Record<string, string>;
  /**
   * ADR-019 §Tripwire 3: MUST remain `false` until
   * [microsoft/node-pty#894](https://github.com/microsoft/node-pty/issues/894)
   * closes. Setting `true` opts into the bundled ConPTY DLL, which
   * regresses PowerShell 7 with a 3.5 s startup delay.
   */
  readonly useConptyDll?: false;
}

/** Factory shape for `node-pty.spawn`. Matches `^1.2.0-beta.12` export. */
export type NodePtySpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: NodePtySpawnOptions,
) => NodePtyChild;

// --------------------------------------------------------------------------
// Injectable dependency seam — production vs test wiring
// --------------------------------------------------------------------------
//
// Each field below is a primitive that has a Windows-only or
// otherwise-environment-bound implementation. Tests pass mocks; the
// production constructor resolves real implementations lazily.

/** Windows console-control event codes per Win32 `GenerateConsoleCtrlEvent`. */
export type ConsoleCtrlEvent = 0 | 1; // CTRL_C_EVENT | CTRL_BREAK_EVENT

// `TaskkillResult` (interface) + `defaultSpawnTaskkill` (function) moved
// to `./taskkill-windows.ts` so the rust-sidecar backend can share the
// same OS-level primitive without cross-importing this file. Re-exported
// here as a `type` to preserve the public surface for downstream test
// imports (`node-pty-host.tree-kill.test.ts`, `node-pty-host.shutdown.test.ts`,
// `node-pty-host.kill-translation.test.ts`).
export type { TaskkillResult };

/**
 * Effectful primitives that `NodePtyHost` reaches through. Every field
 * is injectable so Tests K1 / K3 can run on every platform with `vi.fn()`
 * doubles. The production constructor fills in real implementations on
 * demand (see `resolveDefaultDeps` below).
 *
 * Test-facing API — public callers pass `Partial<NodePtyHostDeps>` to
 * the constructor.
 */
export interface NodePtyHostDeps {
  /** Effective platform. Defaults to `process.platform`. */
  readonly platform: NodeJS.Platform;
  /**
   * `node-pty.spawn` factory. Tests inject a stub returning a recording
   * fake; production resolves the real export via dynamic import on
   * first spawn (no injection ⇒ lazy load).
   */
  readonly ptySpawn: NodePtySpawnFn;
  /**
   * Windows-only: `GenerateConsoleCtrlEvent(event, pid)`. May be
   * `undefined` on non-Windows; the kill path only reaches it when
   * `platform === "win32"`.
   */
  readonly generateConsoleCtrlEvent?: (event: ConsoleCtrlEvent, pid: number) => void;
  /**
   * Windows-only: `taskkill /T /F /PID <pid>`. May be `undefined` on
   * non-Windows; the kill path only reaches it when
   * `platform === "win32"`.
   */
  readonly spawnTaskkill?: (pid: number) => Promise<TaskkillResult>;
  /**
   * Timer primitive for the 2 s escalation budget. Tests pass a
   * fake-timer-friendly setTimeout via `vi.useFakeTimers()`.
   */
  readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout;
  /** Companion to `setTimer` so callers can cancel a pending escalation. */
  readonly clearTimer: (handle: NodeJS.Timeout) => void;
}

/**
 * Internal post-merge deps shape. `ptySpawn` is nullable in the resolved
 * record to signal the "lazy production load" branch — `null` means
 * `resolvePtySpawn()` should `await loadNodePtySpawn()` on first call.
 * Tests that inject a real `ptySpawn` get a non-null entry.
 */
interface ResolvedNodePtyHostDeps {
  readonly platform: NodeJS.Platform;
  readonly ptySpawn: NodePtySpawnFn | null;
  readonly generateConsoleCtrlEvent?: (event: ConsoleCtrlEvent, pid: number) => void;
  readonly spawnTaskkill?: (pid: number) => Promise<TaskkillResult>;
  readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimer: (handle: NodeJS.Timeout) => void;
}

// --------------------------------------------------------------------------
// Internal session table — `node-pty` child + exit-cache for idempotency
// --------------------------------------------------------------------------

interface SessionRecord {
  /** Underlying `node-pty` child. */
  readonly child: NodePtyChild;
  /**
   * Subscriptions held so `close()` can dispose them. Mutable so
   * `spawn()` can populate after attaching listeners; the contents are
   * effectively immutable post-spawn.
   */
  readonly subscriptions: Array<{ dispose: () => void }>;
  /**
   * Cached exit code once the child has terminated. `null` while the
   * child is still alive. Plan-024 idempotency clause: a `kill` after
   * the child has already exited MUST treat as success and re-emit
   * `onExit` from this cached value rather than throwing.
   */
  exitCode: number | null;
  /** Cached signal code (POSIX numeric) — `undefined` for normal exit. */
  signalCode: number | undefined;
  /** Pending escalation timer, if `SIGTERM` is mid-flight on Windows. */
  pendingEscalation: NodeJS.Timeout | null;
  /**
   * `true` once `invokeTaskkill` has committed to the forced-kill
   * escalation for this session (Windows taskkill cascade). Set inside
   * `invokeTaskkill` AFTER the race-safe re-check inside the
   * SIGTERM-armed escalation timer has gated us past the "child exited
   * naturally before escalation" case — see `invokeTaskkill`'s
   * commitment-point comment for the ordering rationale.
   *
   * Drives the DrainResult misclassification fix (P2 Codex finding on
   * PR #83 thread `PRRT_kwDOSCycWc6DZEKP`): `drainSingleSession`
   * previously routed Windows taskkill-escalated exits through
   * `sessionsDrained` because the child.onExit subscription resolved
   * the drainWaiter at L569 with no signal-channel to distinguish "the
   * child exited gracefully on CTRL_BREAK" from "the 2s internal
   * escalation timer fired taskkill, child died via taskkill, and
   * onExit reported the kill". The `escalated` flag is the
   * signal-channel: the `notifyShutdownWaiter` call at L569 reads
   * `record.escalated` to resolve the drainWaiter with `"forced"`
   * rather than `"drained"` when the SIGTERM escalation fired.
   *
   * Defaults to `false` at construction; flipped only inside
   * `invokeTaskkill` (the sole commitment point). Never reset — once
   * a session has been taskkill-escalated, the outcome is permanent
   * for that session's drain accounting.
   */
  escalated: boolean;
}

// --------------------------------------------------------------------------
// Lazy resolution of real `node-pty` / `koffi` bindings (production path)
// --------------------------------------------------------------------------
//
// We use dynamic `import(...)` for both modules so the source file
// has no module-load-time coupling to them. This is the seam that
// makes `koffi` viable as an `optionalDependencies` entry on macOS /
// Linux (where the binding is never invoked).

/** Lazily resolve `node-pty.spawn`. Called on the first `spawn()` call. */
async function loadNodePtySpawn(): Promise<NodePtySpawnFn> {
  // Indirect specifier — assigning the module name to a string
  // variable defeats TypeScript's static module-resolution check at
  // `nodenext` resolution. The package is a hard runtime dep; we
  // expect `node_modules/node-pty` to be populated at runtime via
  // `pnpm install` (declared in `package.json` `dependencies`). The
  // indirection lets us typecheck cleanly even in the moment between
  // adding the dep to `package.json` and the orchestrator's
  // `pnpm install` resolving the lockfile.
  //
  // Defensive `.default ?? mod` shape (R2 review ACTIONABLE-2): under
  // `"type": "module"` + `tsconfig "module": "nodenext"`, the CJS-to-
  // ESM bridge driven by `cjs-module-lexer` cannot statically detect
  // named exports for packages that use the
  // `module.exports = runtimeIdentifier` pattern. The current
  // `node-pty` v1 beta uses per-property assignment which IS
  // detectable, but future packaging changes upstream could break
  // that. Unwrap `.default` defensively so we work whether the
  // runtime exposes the binding via `default` (the lexer fallback)
  // or as named exports.
  const specifier: string = "node-pty";
  const ptyMod = (await import(specifier)) as {
    default?: { spawn: NodePtySpawnFn };
    spawn?: NodePtySpawnFn;
  };
  const nodePty: { spawn?: NodePtySpawnFn } = ptyMod.default ?? ptyMod;
  if (typeof nodePty.spawn !== "function") {
    throw new Error(
      "loadNodePtySpawn: `node-pty` module did not expose a `spawn` " +
        "function (checked both default-export and named-export shapes). " +
        "This usually means the installed `node-pty` version's ESM-bridge " +
        "shape changed; pin the dep to a known-good version or update this " +
        "loader.",
    );
  }
  return nodePty.spawn;
}

/**
 * Lazily bind `GenerateConsoleCtrlEvent` from `kernel32.dll` via `koffi`.
 *
 * Only invoked on Windows (the kill-translation path guards on
 * `deps.platform === "win32"`). The FFI binding loads on first use, not
 * at module load, so non-Windows installs that opt out of the optional
 * `koffi` dep still typecheck and run.
 */
async function loadGenerateConsoleCtrlEvent(): Promise<
  (event: ConsoleCtrlEvent, pid: number) => void
> {
  // No `process.platform` guard here (R2 review POLISH-1): the guard
  // was defensive against a programmer error that produces a
  // misleading "programmer error" message when a partial-mock test
  // injects `platform: "win32"` but omits `generateConsoleCtrlEvent`.
  // Tests should inject the FFI seam directly; on the production
  // Windows path the underlying FFI / runtime errors surface
  // naturally with their own diagnostics.
  // koffi types are opaque enough that we annotate explicitly here.
  // Indirect specifier defeats nodenext static module-resolution so
  // non-Windows installs that opt out of the `koffi`
  // `optionalDependencies` entry still typecheck.
  // The runtime binding shape: load `kernel32.dll`, declare
  // `BOOL GenerateConsoleCtrlEvent(DWORD dwCtrlEvent, DWORD dwProcessGroupId)`,
  // return a 0 (FALSE) or non-zero (TRUE) on call.
  //
  // Defensive `.default ?? mod` shape (R2 review ACTIONABLE-2):
  // `koffi`'s entry point uses `module.exports = mod2` where `mod2`
  // is a runtime-assigned identifier (NOT a literal object). Node's
  // `cjs-module-lexer`-driven CJS-to-ESM bridge cannot statically
  // detect named exports for this pattern; under `"type": "module"`
  // + `tsconfig "module": "nodenext"`, `(await import("koffi")).load`
  // resolves to `undefined` at runtime — the runtime binding lives
  // on `.default`. Unwrap defensively so we work whether the import
  // exposes the binding via `default` (the lexer fallback) or as
  // named exports (in case a future koffi version migrates to ESM).
  type KoffiBinding = {
    load(name: string): {
      func(signature: string): (...args: unknown[]) => unknown;
    };
  };
  const specifier: string = "koffi";
  let koffi: KoffiBinding;
  try {
    // R2 review POLISH-3: a missing `koffi` install surfaces raw
    // ERR_MODULE_NOT_FOUND with three layers of stack trace. Wrap
    // the dynamic import and re-throw with a clearer message that
    // points at the install command and the Phase 3 sidecar
    // alternative.
    const koffiMod = (await import(specifier)) as {
      default?: KoffiBinding;
      load?: KoffiBinding["load"];
    };
    const resolved: { load?: KoffiBinding["load"] } = koffiMod.default ?? koffiMod;
    if (typeof resolved.load !== "function") {
      throw new Error(
        "loadGenerateConsoleCtrlEvent: `koffi` module did not expose a " +
          "`load` function (checked both default-export and named-export " +
          "shapes). This usually means the installed `koffi` version's " +
          "ESM-bridge shape changed; pin the dep or update this loader.",
      );
    }
    koffi = resolved as KoffiBinding;
  } catch (cause) {
    // Distinguish "shape mismatch" (already a clear error) from the
    // ERR_MODULE_NOT_FOUND case. If the error is the one we just
    // threw above (a real Error with our message), re-throw it
    // unchanged; otherwise wrap as the missing-install hint.
    if (cause instanceof Error && cause.message.startsWith("loadGenerateConsoleCtrlEvent:")) {
      throw cause;
    }
    throw new Error(
      "NodePtyHost: `koffi` is required for Windows kill-translation but " +
        "is not installed. Install with `pnpm add koffi` (or restore the " +
        "optional dep via `pnpm install` without `--no-optional`), or use " +
        "the Rust sidecar backend (AIS_PTY_BACKEND=rust-sidecar) once " +
        "Phase 3 lands.",
      { cause },
    );
  }
  const kernel32 = koffi.load("kernel32.dll");
  const binding = kernel32.func(
    "int __stdcall GenerateConsoleCtrlEvent(uint32 dwCtrlEvent, uint32 dwProcessGroupId)",
  );
  return (event: ConsoleCtrlEvent, pid: number): void => {
    binding(event, pid);
  };
}

// `defaultSpawnTaskkill` lives at `./taskkill-windows.ts` so the
// rust-sidecar backend can share the same OS-level primitive (Plan-001
// §CP-001-1 + Plan-024 §I-024-2). Imported above; the lazy-import
// pattern for `node:child_process` is preserved inside that module.

// --------------------------------------------------------------------------
// `NodePtyHost` class
// --------------------------------------------------------------------------

/**
 * In-process `node-pty` implementation of `PtyHost`.
 *
 * On macOS / Linux this is the production backend (Plan-024 Phase 2
 * onward). On Windows this is the fallback backend when the Rust
 * sidecar is not resolvable, and the primary backend during Phase 2
 * before the selector default-flip at Phase 5.
 */
export class NodePtyHost implements PtyHost {
  /** Per-session table keyed by sidecar-minted session id. */
  private readonly sessions = new Map<string, SessionRecord>();

  /** Lazily-resolved `node-pty.spawn`. Cached after first call. */
  private cachedPtySpawn: NodePtySpawnFn | null = null;

  /** Lazily-resolved `GenerateConsoleCtrlEvent` binding. Cached after first call. */
  private cachedGCCE: ((event: ConsoleCtrlEvent, pid: number) => void) | null = null;

  /** Effective deps record after constructor wiring. */
  private readonly deps: ResolvedNodePtyHostDeps;

  /**
   * `onData` consumer callback. Defaults to a no-op until the daemon
   * wires in its session-event projector via `setOnData`. The PtyHost
   * contract specifies a public callback surface; this implementation
   * supports the surface by exposing `setOnData` / `setOnExit` setter
   * methods, matching the pattern used by other contracts implementers
   * in the daemon.
   */
  private dataListener: (sessionId: string, chunk: Uint8Array) => void = () => {};

  private exitListener: (sessionId: string, exitCode: number, signalCode?: number) => void =
    () => {};

  /**
   * Memoized `shutdown()` Promise. Mirrors `inflightSpawn` in
   * `RustSidecarPtyHost` — a second `shutdown()` call awaits the same
   * in-flight result rather than re-initiating a drain. Once resolved,
   * the field stays populated; the instance is terminal after shutdown
   * per the `PtyHost.shutdown` contract surface.
   */
  private shutdownPromise: Promise<DrainResult> | null = null;

  /**
   * `true` once `shutdown()` has been invoked — flips at entry so any
   * concurrent (or post-resolution) `spawn()` rejects with
   * `PtyBackendUnavailableError` rather than registering a session that
   * would escape the `activeSessionIds` snapshot taken by `runShutdown`.
   *
   * The host instance is single-use post-shutdown per the
   * `PtyHost.shutdown` contract surface — consumers MUST re-create a
   * fresh host if a new session is needed after shutdown. Mirrors the
   * equivalently-named flag in `RustSidecarPtyHost` (which gates
   * `ensureChild` for the same terminal-host obligation).
   */
  private shuttingDown: boolean = false;

  /**
   * Per-session drain-completion resolvers populated at `shutdown()`
   * entry. The `child.onExit` subscription set up in `spawn()` cannot
   * see these directly — instead `shutdown()` installs its own
   * one-shot `onExit` subscription per session that resolves the
   * matching waiter without disturbing the original subscription
   * (whose write-once cache discipline must hold). Cleared in a
   * `finally` per session so the map does not retain references to
   * resolved-or-timed-out sessions.
   *
   * The resolver carries the per-session drain outcome (`"drained"`
   * vs `"forced"`) so the Windows taskkill-escalation path can
   * distinguish a natural CTRL_BREAK-driven exit from a forced
   * taskkill exit — Codex P2 (PR #83 thread `PRRT_kwDOSCycWc6DZEKP`):
   * without this signal-channel, a SIGTERM escalation that fires the
   * 2s internal taskkill timer would resolve the drainWaiter via the
   * child.onExit subscription and be miscounted as `sessionsDrained`
   * even though the child was force-killed by taskkill. The closure
   * pass at L556 / L569 / L1155 in node-pty-host.ts is the
   * commitment-point pattern recommended by the advisor: read
   * `record.escalated` (the captured `SessionRecord` reference from
   * `spawn()`) rather than the live `this.sessions` Map, so the
   * resolver sees a consistent snapshot regardless of a concurrent
   * `close()` or session-deletion.
   */
  private readonly shutdownWaiters: Map<string, (result: "drained" | "forced") => void> = new Map();

  /**
   * @param deps Optional injected deps. Production callers pass nothing;
   *   tests inject the full record. Partial deps merge with defaults so
   *   a test that needs only `platform` + `generateConsoleCtrlEvent`
   *   doesn't have to spell out the unrelated fields.
   */
  public constructor(deps?: Partial<NodePtyHostDeps>) {
    this.deps = resolveDefaultDeps(deps ?? {});
  }

  // ---- PtyHost methods --------------------------------------------------

  public async spawn(spec: SpawnRequest): Promise<SpawnResponse> {
    if (this.shuttingDown) {
      // Plan-001 §CP-001-1 sidecar-lifecycle drain: once `shutdown()`
      // has flipped this flag, the host is terminal — refuse new spawn
      // paths so a concurrent `spawn()` cannot register a session that
      // escapes the `activeSessionIds` snapshot in `runShutdown` and
      // leaves an orphaned PTY child running past `shutdown()`
      // resolution. The `PtyHost.shutdown` contract surface declares
      // the host single-use post-shutdown; consumers MUST re-create a
      // fresh host if a new session is needed after shutdown.
      throw new PtyBackendUnavailableError(
        { attemptedBackend: "node-pty" },
        "NodePtyHost: shutdown() in progress or complete; " +
          "the host is terminal — re-create a fresh instance for new sessions.",
      );
    }
    const ptySpawn: NodePtySpawnFn = await this.resolvePtySpawn();
    if (this.shuttingDown) {
      // Post-await race guard (Plan-001 §CP-001-1).
      //
      // The top-of-method gate above closes the case where `shutdown()`
      // started BEFORE this `spawn()` call entered the method. This
      // re-check closes the mid-flight case: `shutdown()` may have
      // flipped `this.shuttingDown` while we were awaiting
      // `resolvePtySpawn()`, in which case the snapshot taken inside
      // `runShutdown()` did NOT include the session we are about to
      // register. Without this guard, `ptySpawn(...)` would create a
      // PTY child, `this.sessions.set(...)` would register it, and the
      // child would escape the drain — the orphan condition the
      // `PtyHost.shutdown` contract surface forbids.
      //
      // Reject BEFORE invoking `ptySpawn(...)` so no orphan child
      // process is created; the session was never registered, so no
      // cleanup is needed. The error shape mirrors the entry-time
      // rejection (byte-identical `PtyBackendUnavailableError` shape +
      // `attemptedBackend: "node-pty"`) so consumers that
      // `instanceof`-check + read `details.attemptedBackend` see
      // uniform behavior regardless of where in `spawn()` the race
      // landed. Mirrors `RustSidecarPtyHost`'s `resolveOutstanding`
      // spawn_response re-check (the sister-backend precedent), which
      // closes the structurally-equivalent in-flight race on the
      // out-of-process backend.
      throw new PtyBackendUnavailableError(
        { attemptedBackend: "node-pty" },
        "NodePtyHost: shutdown() in progress or complete; " +
          "the host is terminal — re-create a fresh instance for new sessions.",
      );
    }
    const env: Record<string, string> = envTuplesToRecord(spec.env);

    const child: NodePtyChild = ptySpawn(spec.command, spec.args, {
      name: "xterm-color",
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env,
      // ADR-019 Tripwire 3 — MUST remain `false` until
      // microsoft/node-pty#894 closes.
      useConptyDll: false,
    });

    const sessionId: string = randomUUID();
    // Single record reference shared by the listeners and the map —
    // mutations from inside `child.onExit` MUST be visible to the
    // `kill()` path that reads `record.exitCode` for idempotency.
    const record: SessionRecord = {
      child,
      subscriptions: [],
      exitCode: null,
      signalCode: undefined,
      pendingEscalation: null,
      escalated: false,
    };

    record.subscriptions.push(
      child.onData((chunk: string | Uint8Array) => {
        const bytes: Uint8Array =
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
        this.dataListener(sessionId, bytes);
      }),
    );
    record.subscriptions.push(
      child.onExit((event: { exitCode: number; signal?: number | undefined }) => {
        // Cancel any pending escalation timer — the child exited on
        // its own (or via `CTRL_BREAK_EVENT`) so we don't need taskkill.
        this.clearPendingEscalation(record);
        // De-dupe path: if `invokeTaskkill` already emitted a synthetic
        // exit (record.exitCode set to 1, signalCode undefined), do NOT
        // re-fire and do NOT mutate the cache. The cache must be
        // write-once after first emission so the idempotency contract
        // holds: a subsequent `kill()` MUST re-emit the same exitCode
        // the consumer originally observed (the synthetic 1), not a
        // later OS-supplied value that would silently change the
        // observable cache underneath the consumer. See ACTIONABLE-1
        // (R2 review): mutating the cache here breaks Test K1's
        // idempotency assertion and conflates the synthetic vs OS
        // exit channels.
        if (record.exitCode !== null) {
          // Resolve any active shutdown waiter even on the de-dupe
          // path so a `shutdown()` issued during an in-flight
          // synthetic-exit emission (Windows SIGKILL escalation) still
          // ticks the per-session drain budget. The de-dupe branch is
          // reached only AFTER `invokeTaskkill` already fired the
          // synthetic exit + flipped `record.escalated = true`, so we
          // know unconditionally the outcome is `"forced"` — see the
          // Codex P2 (PR #83 thread `PRRT_kwDOSCycWc6DZEKP`) +
          // `notifyShutdownWaiter` call-site discipline rustdoc.
          this.notifyShutdownWaiter(sessionId, "forced");
          return;
        }
        // Cache for idempotency: a subsequent `kill()` MUST re-emit
        // from this cached pair rather than throw.
        record.exitCode = event.exitCode;
        record.signalCode = event.signal;
        this.fireExit(sessionId, event.exitCode, event.signal);
        // Plan-001 §CP-001-1 sidecar-lifecycle drain: a `shutdown()`
        // call waiting on this session's exit picks up here, after the
        // record's exit-cache is populated. Ordering matches the
        // `fireExit` call so a listener-observed exit precedes the
        // drain-completion signal.
        //
        // Outcome is `record.escalated ? "forced" : "drained"` — Codex
        // P2 (PR #83 thread `PRRT_kwDOSCycWc6DZEKP`): on Windows, the
        // 2s SIGTERM-escalation timer in `killOnWindows` can fire
        // taskkill BEFORE `perSessionTimeoutMs` elapses (when
        // `perSessionTimeoutMs >= 2000` and the child ignores
        // CTRL_BREAK_EVENT). The taskkill cascade kills the child, the
        // OS reaps it, the child.onExit subscription fires here, and
        // the drainWaiter wins the Promise.race vs `timeoutPromise` in
        // `drainSingleSession`. Without the `escalated` signal-channel
        // the outcome would be miscounted as `sessionsDrained` despite
        // the child being force-killed. Read the closure-captured
        // `record` (advisor-pinned: NOT a `this.sessions.get(sessionId)`
        // lookup) so the resolver sees a consistent snapshot regardless
        // of a concurrent `close()` / session-deletion.
        this.notifyShutdownWaiter(sessionId, record.escalated ? "forced" : "drained");
      }),
    );

    this.sessions.set(sessionId, record);

    return await Promise.resolve({
      kind: "spawn_response",
      session_id: sessionId,
    });
  }

  public async resize(sessionId: string, rows: number, cols: number): Promise<void> {
    const record: SessionRecord | undefined = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new Error(`NodePtyHost.resize: unknown sessionId '${sessionId}'`);
    }
    record.child.resize(cols, rows);
    return await Promise.resolve();
  }

  public async write(sessionId: string, bytes: Uint8Array): Promise<void> {
    const record: SessionRecord | undefined = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new Error(`NodePtyHost.write: unknown sessionId '${sessionId}'`);
    }
    // `node-pty` accepts string or Uint8Array; we pass the Uint8Array
    // through directly. The wire-layer contract uses `Uint8Array`
    // (decoded from base64) per pty-host.ts.
    record.child.write(bytes);
    return await Promise.resolve();
  }

  /**
   * Send `signal` to the session's child.
   *
   * On Windows this is the load-bearing kill-translation path per
   * Plan-024 I-024-1 + I-024-2:
   *   - `SIGINT` → `GenerateConsoleCtrlEvent(CTRL_C_EVENT, child.pid)`
   *   - `SIGTERM` → `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, child.pid)`,
   *      escalate to `taskkill /T /F /PID <pid>` if the child has not
   *      exited within 2 s.
   *   - `SIGKILL` → `taskkill /T /F /PID <pid>` directly.
   *   - `SIGHUP` → same hard-stop cascade as `SIGTERM` (plan does not
   *     pin a specific Windows mapping; matching SIGTERM is the most
   *     conservative graceful-then-force shape that respects the
   *     descendant-tree obligation per I-024-2).
   *
   * On non-Windows platforms this delegates to `node-pty.kill(signal)`
   * unchanged (POSIX semantics).
   *
   * Ack contract: `kill()` MUST resolve once the kill cascade has BEGUN,
   * NOT when the child has actually exited — `KillResponse` is the ack
   * for the cascade dispatch, and the terminal status flows through
   * `onExit` (the daemon-layer analog of `ExitCodeNotification`). See
   * `packages/contracts/src/pty-host-protocol.ts` `KillResponse` comment:
   * "the sidecar acks once it has begun the kill cascade, NOT when the
   * child has actually exited — `ExitCodeNotification` carries the
   * terminal status." Consequently the Windows hard-stop branches MUST
   * fire-and-forget `invokeTaskkill` (`void`, not `await`) — awaiting
   * would block `kill()` for up to 5 s in the stuck-taskkill case and
   * stall upstream request handling, conflicting with the contract.
   *
   * Idempotency: if the child has already exited, re-emit `onExit` from
   * the cached exit-code and return; do not throw, do not call any FFI.
   */
  public async kill(sessionId: string, signal: PtySignal): Promise<void> {
    const record: SessionRecord | undefined = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new Error(`NodePtyHost.kill: unknown sessionId '${sessionId}'`);
    }

    // Idempotency clause (per the `Plan-024 §Implementation Steps` step-8 kill bullet) — already-exited children
    // get a re-emit of the cached exit, not a throw and not a re-kill.
    if (record.exitCode !== null) {
      this.fireExit(sessionId, record.exitCode, record.signalCode);
      return;
    }

    if (this.deps.platform === "win32") {
      await this.killOnWindows(sessionId, record, signal);
      return;
    }

    // Non-Windows: delegate to node-pty's POSIX signal-name path.
    record.child.kill(signal);
    return await Promise.resolve();
  }

  public async close(sessionId: string): Promise<void> {
    const record: SessionRecord | undefined = this.sessions.get(sessionId);
    if (record === undefined) {
      // Idempotent close — closing an unknown / already-closed session
      // is not an error.
      return await Promise.resolve();
    }
    // Cancel any in-flight escalation timer before disposing. This MUST
    // run regardless of platform: a pending SIGTERM-armed escalation
    // timer cancelled here prevents a stale `taskkill` from firing 2 s
    // later (close-during-SIGTERM race, see edge-case analysis on the
    // Codex P1 report).
    this.clearPendingEscalation(record);
    // Subscriptions disposed BEFORE the kill dispatch so any node-pty
    // child-side exit event that lands during the kill cascade has no
    // listener to call into; the synthetic-onExit emission inside
    // `invokeTaskkill` is suppressed by the existing `sessions.has`
    // gate (R3 ACTIONABLE-1) since we delete from the table below.
    for (const sub of record.subscriptions) {
      sub.dispose();
    }
    // If still alive, terminate. The platform branch is load-bearing —
    // see the file-header note about node-pty.kill on Windows targeting
    // a single PID. Codex P1 (PR #51): a Windows `close()` that routes
    // through `record.child.kill()` orphans descendants because
    // node-pty's kill does not walk console-control-event /
    // process-tree semantics, exactly the failure mode I-024-1 / I-024-2
    // exist to prevent. Route through the same `taskkill /T /F /PID`
    // hard-stop path that `kill(SIGKILL)` uses to honor the descendant-
    // tree obligation. Fire-and-forget — `close()` MUST NOT block on the
    // OS reap (the 5 s wall-clock cap inside `invokeTaskkill` is for
    // the kill-cascade contract, not the teardown contract).
    if (record.exitCode === null) {
      if (this.deps.platform === "win32") {
        // The synthetic onExit that `invokeTaskkill` emits at the tail
        // is gated on `this.sessions.has(sessionId)` and will be
        // SUPPRESSED because we call `sessions.delete(sessionId)`
        // immediately below — intentional: `close()` is the consumer's
        // signal to stop emitting on this session.
        void this.invokeTaskkill(sessionId, record, record.child.pid);
      } else {
        // POSIX: `record.child.kill()` signals the session leader and
        // TTY foreground-process-group semantics propagate the
        // termination through the descendant tree. The Codex finding
        // is specifically scoped to Windows; preserve the existing
        // POSIX behavior unchanged.
        try {
          record.child.kill();
        } catch {
          // Swallow — best-effort close.
        }
      }
    }
    this.sessions.delete(sessionId);
    return await Promise.resolve();
  }

  /**
   * Drain every active session in preparation for daemon shutdown.
   *
   * Per the `PtyHost.shutdown` contract surface, this is the
   * polymorphic counterpart to `close(sessionId)` for the lifecycle
   * level above the per-session axis. The in-process backend has no
   * sidecar to wind down, so `hostTimeoutMs` is ignored and the host
   * fields of the returned `DrainResult` are vacuous
   * (`sidecarExitedCleanly: true`, `taskkillEscalated: false`).
   *
   * Per-session drain shape:
   *   1. Snapshot the active session ids (sessions that already
   *      exited do not contribute to either counter).
   *   2. Install a one-shot drain waiter per session — a Promise that
   *      resolves when the session's `child.onExit` subscription set
   *      up in `spawn()` fires (whose write-once cache the waiter
   *      observes after the fact).
   *   3. Issue a graceful kill (`SIGTERM`) via the production `kill()`
   *      path — on Windows this translates to `CTRL_BREAK_EVENT` with
   *      a 2 s escalation timer; on POSIX it delegates to
   *      `node-pty.kill('SIGTERM')`.
   *   4. Wait up to `perSessionTimeoutMs` for the waiter — if the
   *      timeout fires first, escalate to `SIGKILL` (which on Windows
   *      invokes `taskkill /T /F /PID <pid>` directly per
   *      `killOnWindows`) and count the session under
   *      `sessionsForcedKilled`. Otherwise count under
   *      `sessionsDrained`.
   *
   * Re-entrancy: a second `shutdown()` call returns the in-flight
   * Promise rather than initiating a second drain. Once resolved the
   * field stays populated — the instance is terminal post-shutdown.
   *
   * Terminal-host gate: once `shutdown()` has been invoked, `spawn()`
   * rejects with `PtyBackendUnavailableError` (`attemptedBackend:
   * "node-pty"`) per the `PtyHost.shutdown` contract surface, so a
   * concurrent or post-resolution `spawn()` cannot register a session
   * that escapes the `activeSessionIds` snapshot taken at the start of
   * the drain.
   */
  public shutdown(options: {
    readonly perSessionTimeoutMs: number;
    readonly hostTimeoutMs: number;
  }): Promise<DrainResult> {
    if (this.shutdownPromise !== null) {
      return this.shutdownPromise;
    }
    // Non-async wrapper so a second call returns the SAME Promise
    // identity (an `async` wrapper would wrap the memoized inner
    // Promise in a fresh outer Promise on each invocation — see
    // Plan-001 §CP-001-1 re-entrancy clause).
    this.shutdownPromise = this.runShutdown(options);
    return this.shutdownPromise;
  }

  private async runShutdown(options: {
    readonly perSessionTimeoutMs: number;
    readonly hostTimeoutMs: number;
  }): Promise<DrainResult> {
    // `hostTimeoutMs` is part of the contract surface for backend
    // polymorphism — `RustSidecarPtyHost` uses it to bound the sidecar
    // stdin-close + child-wait. The in-process backend has no sidecar,
    // so the budget is unused here.
    void options.hostTimeoutMs;

    // Flip the shutdown flag FIRST — synchronously, before the
    // `activeSessionIds` snapshot — so any `spawn()` racing the start
    // of shutdown observes the flag at its top-of-method gate and
    // rejects, rather than registering a session that would escape
    // the snapshot. This single-direction flag stays `true` for the
    // life of the instance per the terminal-host contract surface.
    this.shuttingDown = true;

    const activeSessionIds: string[] = Array.from(this.sessions.keys()).filter((sessionId) => {
      const record: SessionRecord | undefined = this.sessions.get(sessionId);
      return record !== undefined && record.exitCode === null;
    });

    const perSessionOutcomes: Array<"drained" | "forced"> = await Promise.all(
      activeSessionIds.map((sessionId) =>
        this.drainSingleSession(sessionId, options.perSessionTimeoutMs),
      ),
    );

    let sessionsDrained = 0;
    let sessionsForcedKilled = 0;
    for (const outcome of perSessionOutcomes) {
      if (outcome === "drained") {
        sessionsDrained++;
      } else {
        sessionsForcedKilled++;
      }
    }

    return {
      sessionsDrained,
      sessionsForcedKilled,
      // Vacuous: no sidecar process to drain in the in-process backend.
      sidecarExitedCleanly: true,
      taskkillEscalated: false,
    };
  }

  /**
   * Drain one session: install a waiter, issue `SIGTERM`, wait up to
   * `timeoutMs`, escalate to `SIGKILL` on timeout. Returns the outcome
   * label that the caller folds into `DrainResult` counters.
   *
   * The waiter is checked AFTER the kill is dispatched (race-safe):
   * the `child.onExit` subscription set up in `spawn()` fires via
   * `record.exitCode = ...` first; the shutdown waiter is invoked
   * downstream via `notifyShutdownWaiter`. If the session has already
   * exited at shutdown entry (`record.exitCode !== null` — caller
   * filtered these out via `activeSessionIds`), this path is not
   * reached.
   */
  private async drainSingleSession(
    sessionId: string,
    timeoutMs: number,
  ): Promise<"drained" | "forced"> {
    const drainWaiter: Promise<"drained" | "forced"> = new Promise<"drained" | "forced">(
      (resolve) => {
        this.shutdownWaiters.set(sessionId, resolve);
      },
    );

    try {
      // Issue graceful kill via the production `kill()` path so Windows
      // kill-translation (CTRL_BREAK_EVENT + escalation, I-024-1) and
      // POSIX behavior stay in one place. SIGTERM is the canonical
      // graceful signal per Plan-024 §Implementation Steps 8.
      try {
        await this.kill(sessionId, "SIGTERM");
      } catch {
        // Swallow — `kill()` may throw on an already-exited session
        // mid-flight (unknown sessionId path). The waiter still
        // resolves via the child.onExit subscription regardless.
      }

      // Race the per-session drain waiter against a timer budgeted at
      // `timeoutMs`. The injected `setTimer` / `clearTimer` honor
      // `vi.useFakeTimers()` so tests can advance simulated time
      // deterministically without wall-clock waits.
      let timeoutHandle: NodeJS.Timeout | null = null;
      const timeoutPromise: Promise<"timeout"> = new Promise<"timeout">((resolve) => {
        timeoutHandle = this.deps.setTimer(() => {
          resolve("timeout");
        }, timeoutMs);
      });

      // The drain waiter now carries its own outcome (Codex P2 fix on
      // PR #83 thread `PRRT_kwDOSCycWc6DZEKP`): the spawn-time
      // child.onExit subscription resolves with `record.escalated ?
      // "forced" : "drained"`, and `invokeTaskkill`'s synthetic-exit
      // path resolves with `"forced"`. The Promise.race therefore
      // observes the resolver's truth directly — no separate
      // post-await query against the SessionRecord is needed.
      const outcome: "drained" | "forced" | "timeout" = await Promise.race([
        drainWaiter,
        timeoutPromise,
      ]);

      if (timeoutHandle !== null) {
        this.deps.clearTimer(timeoutHandle);
      }

      if (outcome !== "timeout") {
        // `outcome` is the resolver's truth: `"drained"` (natural
        // CTRL_BREAK or POSIX SIGTERM exit) or `"forced"` (Windows
        // 2 s SIGTERM-escalation taskkill fired and won the race vs
        // `timeoutPromise`). Returning here preserves the per-session
        // DrainResult contract on a Windows taskkill-escalation race —
        // the prior shape unconditionally returned `"drained"` here,
        // miscounting taskkill-killed sessions as gracefully drained.
        return outcome;
      }

      // Timeout fired — escalate to SIGKILL. The kill-cascade contract
      // is fire-and-forget; the synthetic exit emission (Windows) or
      // child.onExit (POSIX) eventually resolves the drainWaiter, but
      // shutdown does NOT block on that — it has already counted this
      // session as "forced."
      try {
        await this.kill(sessionId, "SIGKILL");
      } catch {
        // Swallow — best-effort escalation.
      }
      return "forced";
    } finally {
      this.shutdownWaiters.delete(sessionId);
    }
  }

  /**
   * Resolve the per-session shutdown waiter (if any) when the
   * underlying `child.onExit` subscription set up in `spawn()` fires.
   * Called from the spawn-time exit subscription closure below; no-op
   * when no shutdown is in flight.
   *
   * The `result` argument carries the drain outcome (`"drained"` vs
   * `"forced"`). Call-site discipline (per the Codex P2 fix on PR #83
   * thread `PRRT_kwDOSCycWc6DZEKP`):
   *
   *   * Inside `invokeTaskkill` (L1155 area): always pass `"forced"` —
   *     we are inside the forced-kill commitment point.
   *   * Inside the spawn-time `child.onExit` de-dupe branch
   *     (L556 area): always pass `"forced"` — `invokeTaskkill` has
   *     already set `record.escalated = true` and fired the synthetic
   *     exit, so the consumer here is the de-dupe of that forced
   *     exit.
   *   * Inside the spawn-time `child.onExit` natural-exit branch
   *     (L569 area): pass `record.escalated ? "forced" : "drained"` —
   *     reads the closure-captured `SessionRecord` reference (NOT a
   *     Map lookup) so the resolver is stable against concurrent
   *     `close()` / session-deletion.
   */
  private notifyShutdownWaiter(sessionId: string, result: "drained" | "forced"): void {
    const resolver: ((result: "drained" | "forced") => void) | undefined =
      this.shutdownWaiters.get(sessionId);
    if (resolver !== undefined) {
      resolver(result);
    }
  }

  // ---- PtyHost callback surface (settable by the daemon) ----------------

  public onData(sessionId: string, chunk: Uint8Array): void {
    // The interface declaration on `PtyHost` documents this as a hook
    // the implementation calls into. We expose a no-op default and
    // provide `setOnData` for the daemon to wire its own consumer.
    this.dataListener(sessionId, chunk);
  }

  public onExit(sessionId: string, exitCode: number, signalCode?: number): void {
    this.exitListener(sessionId, exitCode, signalCode);
  }

  /** Register the daemon's data-chunk consumer. */
  public setOnData(listener: (sessionId: string, chunk: Uint8Array) => void): void {
    this.dataListener = listener;
  }

  /** Register the daemon's exit-event consumer. */
  public setOnExit(
    listener: (sessionId: string, exitCode: number, signalCode?: number) => void,
  ): void {
    this.exitListener = listener;
  }

  // ---- Internals --------------------------------------------------------

  private fireExit(sessionId: string, exitCode: number, signalCode: number | undefined): void {
    if (signalCode === undefined) {
      this.exitListener(sessionId, exitCode);
    } else {
      this.exitListener(sessionId, exitCode, signalCode);
    }
  }

  private async resolvePtySpawn(): Promise<NodePtySpawnFn> {
    if (this.cachedPtySpawn !== null) {
      return this.cachedPtySpawn;
    }
    if (this.deps.ptySpawn !== null) {
      this.cachedPtySpawn = this.deps.ptySpawn;
      return this.cachedPtySpawn;
    }
    // Production path: load `node-pty` lazily. Non-Windows installs
    // that opt out of `koffi` still reach this branch — but they MUST
    // have `node-pty` installed (it's a hard dep, not optional).
    this.cachedPtySpawn = await loadNodePtySpawn();
    return this.cachedPtySpawn;
  }

  private async killOnWindows(
    sessionId: string,
    record: SessionRecord,
    signal: PtySignal,
  ): Promise<void> {
    const pid: number = record.child.pid;

    // R2 review ACTIONABLE-3: every branch in `killOnWindows` MUST
    // clear any stale escalation timer at the top. Without this, a
    // SIGKILL (or repeat SIGTERM, or SIGINT) preempting a still-
    // pending SIGTERM-armed timer leaves the orphaned timer to fire
    // 2 s later — at which point it re-invokes `taskkill /T /F /PID`
    // on a potentially-reaped-and-recycled Windows PID. The single
    // call here covers all four branches (SIGINT, SIGKILL, SIGTERM,
    // SIGHUP); the SIGTERM/SIGHUP branch arms a fresh timer below.
    this.clearPendingEscalation(record);

    if (signal === "SIGINT") {
      // CTRL_C_EVENT = 0 per Win32 GenerateConsoleCtrlEvent docs.
      const gcce = await this.resolveGCCE();
      gcce(0, pid);
      return;
    }

    if (signal === "SIGKILL") {
      // Direct hard-stop — skip CTRL_BREAK_EVENT entirely. The /T flag
      // walks the descendant tree (I-024-2 load-bearing piece); /F
      // forces termination of processes that ignore graceful signals.
      //
      // Codex P2 (PR #51): fire-and-forget (`void`, not `await`) so
      // `kill()` returns once the cascade has BEGUN, per the
      // `KillResponse` ack contract in
      // `packages/contracts/src/pty-host-protocol.ts`:
      // "the sidecar acks once it has begun the kill cascade, NOT when
      // the child has actually exited — `ExitCodeNotification` carries
      // the terminal status." Awaiting here blocks `kill()` for up to
      // 5 s in the stuck-taskkill case (the wall-clock fallback inside
      // `invokeTaskkill`), conflicting with the contract and stalling
      // upstream request handling. The synthetic `onExit` fires async
      // when taskkill resolves (or the 5 s fallback wins). This aligns
      // SIGKILL with the SIGTERM-escalation timer branch below, which
      // is already `void this.invokeTaskkill(...)`.
      void this.invokeTaskkill(sessionId, record, pid);
      return;
    }

    // SIGTERM and SIGHUP: graceful CTRL_BREAK_EVENT, then escalate via
    // taskkill if the child has not exited within 2 s. SIGHUP is not
    // pinned by Plan-024; matching SIGTERM is the most conservative
    // graceful-then-force cascade and respects the descendant-tree
    // obligation per I-024-2.
    const gcce = await this.resolveGCCE();
    // CTRL_BREAK_EVENT = 1 per Win32 docs.
    gcce(1, pid);

    // Arm the 2 s escalation timer. If the child exits before the
    // timer fires (via the child.onExit subscription set up in
    // `spawn`), the exit handler clears this timer.
    record.pendingEscalation = this.deps.setTimer(() => {
      // Race-safe re-check: if exit happened between the timer scheduler
      // and this callback, the exit-cache is populated and we skip the
      // escalation. Otherwise we proceed to taskkill — the child
      // ignored CTRL_BREAK_EVENT (or is stuck) and we must reap the
      // descendant tree per I-024-2.
      if (record.exitCode !== null) {
        record.pendingEscalation = null;
        return;
      }
      // Fire-and-await the taskkill via an inner async IIFE so the
      // timer callback's sync signature is preserved.
      void this.invokeTaskkill(sessionId, record, pid);
    }, 2000);
  }

  /**
   * Clear any pending Windows-escalation timer on `record`. Idempotent
   * — safe to call when no timer is armed. Centralizing the
   * clear-and-null pattern (R2 review ACTIONABLE-3) so every kill
   * branch and the teardown path can call into a single point of
   * truth instead of duplicating the `if (record.pendingEscalation
   * !== null)` guard.
   */
  private clearPendingEscalation(record: SessionRecord): void {
    if (record.pendingEscalation !== null) {
      this.deps.clearTimer(record.pendingEscalation);
      record.pendingEscalation = null;
    }
  }

  private async resolveGCCE(): Promise<(event: ConsoleCtrlEvent, pid: number) => void> {
    if (this.cachedGCCE !== null) {
      return this.cachedGCCE;
    }
    if (this.deps.generateConsoleCtrlEvent !== undefined) {
      this.cachedGCCE = this.deps.generateConsoleCtrlEvent;
      return this.cachedGCCE;
    }
    this.cachedGCCE = await loadGenerateConsoleCtrlEvent();
    return this.cachedGCCE;
  }

  private async invokeTaskkill(
    sessionId: string,
    record: SessionRecord,
    pid: number,
  ): Promise<void> {
    record.pendingEscalation = null;
    // Commitment point for the Windows forced-kill escalation —
    // Codex P2 (PR #83 thread `PRRT_kwDOSCycWc6DZEKP`). Set BEFORE
    // the `spawnTaskkill` await so the closure-captured `record`
    // observed by the spawn-time child.onExit subscription
    // (notifyShutdownWaiter call at L569-area) reads `escalated ===
    // true` regardless of when the OS reaps the child relative to
    // this Promise settling.
    //
    // The two reachable callers — `killOnWindows`'s SIGKILL branch
    // (direct hard-stop) and the SIGTERM-armed escalation timer's
    // race-safe re-check at L1018-1021 area — have both gated past
    // the "child exited naturally before escalation" case. The
    // SIGKILL branch only enters here when the consumer chose
    // hard-stop; the SIGTERM-timer branch's L1018 re-check
    // (`if (record.exitCode !== null) { ...; return; }`) guarantees
    // we are not racing a natural exit. So the flag flip here is
    // unambiguous.
    record.escalated = true;
    const spawnTaskkill = this.deps.spawnTaskkill ?? ((p: number) => defaultSpawnTaskkill(p));

    // R2 review POLISH-4: wall-clock-bound `spawnTaskkill` so a stuck
    // OS-level operation cannot hang the daemon — the exact failure
    // mode I-024-2 forbids ("the daemon must not hang on a stuck
    // OS-level operation"). 5 s is comfortably longer than realistic
    // `taskkill` latency on a healthy Windows box (sub-second) and
    // far shorter than "indefinitely". The race uses `this.deps.setTimer`
    // / `clearTimer` so tests under `vi.useFakeTimers()` can advance
    // simulated time deterministically without waiting wall-clock
    // seconds. If the inner timer wins, we proceed to fire the
    // synthetic exit as normal — the OS-level reap is left to the
    // operating system to clean up (best-effort).
    await new Promise<void>((resolve) => {
      let settled = false;
      const fallbackHandle = this.deps.setTimer(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      }, 5000);
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.deps.clearTimer(fallbackHandle);
        resolve();
      };
      // Fire-and-forget the await chain — finish() resolves the outer
      // Promise when spawnTaskkill settles (resolved or rejected), or
      // when the fallback timer wins, whichever comes first.
      void (async (): Promise<void> => {
        try {
          await spawnTaskkill(pid);
        } catch (err: unknown) {
          // Swallow — per I-024-2 we MUST fire onExit even if reaping
          // is incomplete (OS-level taskkill failures must not hang
          // the daemon). The outer fallback timer is a defense-in-
          // depth backstop for the case where the promise itself
          // never settles (kernel deadlock, suspended process, OS
          // bug); a thrown rejection still reaches this catch and
          // resolves the outer Promise on time.
          //
          // R3 review POLISH-2: log the cause so a recurring failure
          // (misconfigured PATH, AV-blocked taskkill.exe, etc.) is
          // observable. Without this breadcrumb, persistent taskkill
          // failures look identical to a healthy synthetic exit in
          // operator logs.
          // TRIPWIRE: replace `console.warn` once a structured logger
          // surfaces in the runtime-daemon.
          console.warn(
            `NodePtyHost: invokeTaskkill: spawnTaskkill rejected for ` +
              `session=${sessionId} pid=${pid}; synthetic onExit will ` +
              `fire to honor I-024-2.`,
            { cause: err },
          );
        }
        finish();
      })();
    });

    // I-024-2: emit `ExitCodeNotification` even if reaping is incomplete.
    // We fabricate an exit-code of 1 (non-zero) with no signal-code to
    // communicate "we killed it on the daemon path; OS reap status
    // unknown." If the underlying child.onExit eventually fires with a
    // real exit-code, it short-circuits on the cached exitCode set
    // here (the cache is write-once after first emission so the
    // synthetic exit-code stays observable for any subsequent
    // idempotent re-emit per `kill()`).
    //
    // R3 review ACTIONABLE-1: gate the synthetic emit on
    // `this.sessions.has(sessionId)` so a `close()` that lands during
    // the `await new Promise<void>` above cannot trigger an onExit
    // fire after the session has been torn down. The IIFE captured
    // `record` + `sessionId` by closure, so deleting from
    // `this.sessions` does not interrupt the pending emission — the
    // gate is the only durable signal. `sessions.has` is the
    // canonical "is this session still live?" probe (close is the
    // sole site that deletes entries), which keeps this check
    // symmetric with the `kill()` "unknown sessionId" guard at line
    // 571 above. Covers all three close-mid-flight race shapes:
    // SIGTERM→2s→taskkill, SIGKILL→taskkill direct, and the 5s
    // fallback wall-clock race.
    if (record.exitCode === null && this.sessions.has(sessionId)) {
      record.exitCode = 1;
      record.signalCode = undefined;
      this.fireExit(sessionId, 1, undefined);
      // Plan-001 §CP-001-1: a Windows SIGKILL-escalation path may fire
      // the synthetic exit while a `shutdown()` drain waiter is
      // outstanding. Notify the waiter so the drain budget can resolve
      // without depending on the underlying `child.onExit` arriving
      // (which is best-effort per I-024-2).
      //
      // Outcome is unconditionally `"forced"` — we are inside
      // `invokeTaskkill`, the sole commitment point for the Windows
      // forced-kill cascade. See Codex P2 (PR #83 thread
      // `PRRT_kwDOSCycWc6DZEKP`) + `notifyShutdownWaiter` call-site
      // discipline rustdoc.
      this.notifyShutdownWaiter(sessionId, "forced");
    }
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Convert wire-format `Array<[string, string]>` env tuples to the
 * `Record<string, string>` shape `node-pty.spawn` accepts.
 *
 * `node-pty` accepts a record only, so duplicate keys deduplicate to
 * the LAST tuple (record semantics). This matches POSIX `execve`'s
 * "later entry shadows earlier" rule for the worktree-translator's
 * `cwd-env` strategy (Plan-001 P5 CP-001-2).
 */
function envTuplesToRecord(
  tuples: ReadonlyArray<readonly [string, string]>,
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of tuples) {
    record[key] = value;
  }
  return record;
}

/**
 * Merge user-supplied partial deps with production defaults. The
 * defaults are designed so a `NodePtyHost` constructed on macOS / Linux
 * never loads `koffi` (it's an optional dep and the kill path doesn't
 * touch it on POSIX), and a `NodePtyHost` constructed in a test never
 * loads `node-pty` (the test injects `ptySpawn` directly).
 *
 * `ptySpawn === null` is the production signal: `resolvePtySpawn()`
 * awaits `loadNodePtySpawn()` on first invocation and caches the result.
 */
function resolveDefaultDeps(partial: Partial<NodePtyHostDeps>): ResolvedNodePtyHostDeps {
  // R2 review POLISH-2: collapse the four-branch return into a
  // conditional-spread pattern. Each `... (cond ? { key: value } : {})`
  // contributes the key only when `partial.<key>` is defined,
  // satisfying `exactOptionalPropertyTypes: true` (which forbids
  // assigning `undefined` to an optional field). The ternary form is
  // preferred over `... (cond && obj)` because the latter spreads
  // `false` on the falsy branch — legal at runtime (treated as `{}`)
  // but trips TypeScript's spread-type inference under
  // `exactOptionalPropertyTypes`.
  const base: {
    readonly platform: NodeJS.Platform;
    readonly ptySpawn: NodePtySpawnFn | null;
    readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout;
    readonly clearTimer: (handle: NodeJS.Timeout) => void;
  } = {
    platform: partial.platform ?? process.platform,
    ptySpawn: partial.ptySpawn ?? null,
    setTimer: partial.setTimer ?? ((cb, ms) => setTimeout(cb, ms)),
    clearTimer: partial.clearTimer ?? ((handle) => clearTimeout(handle)),
  };
  return {
    ...base,
    ...(partial.generateConsoleCtrlEvent !== undefined
      ? { generateConsoleCtrlEvent: partial.generateConsoleCtrlEvent }
      : {}),
    ...(partial.spawnTaskkill !== undefined ? { spawnTaskkill: partial.spawnTaskkill } : {}),
  };
}
