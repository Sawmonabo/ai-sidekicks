// Out-of-process Rust PTY sidecar implementation of the `PtyHost` contract.
//
// Why this exists
// ---------------
//
// Plan-024 ships two backends behind the `PtyHost` interface published
// from `@ai-sidekicks/contracts`: an in-process `node-pty` wrapper
// (Phase 2, primary on macOS/Linux, fallback on Windows) and this
// out-of-process Rust sidecar binary marshalled over Content-Length
// framing on the binary's stdio (Phase 3, primary on Windows once the
// Phase 5 selector default-flip lands). ADR-019 §Decision item 1
// names the sidecar as the structural fix for the `node-pty` ConPTY
// bug cluster (`microsoft/node-pty#904`, `microsoft/node-pty#887`,
// `microsoft/node-pty#894`, `openai/codex#13973`); the daemon-side
// surface here is the supervision + framing layer that translates
// between the `PtyHost` runtime API and the sidecar's wire envelope.
//
// What this file does
// -------------------
//
// Three load-bearing concerns:
//
//   1. `Content-Length` framing. The sidecar speaks LSP-style
//      `Content-Length: N\r\n\r\n<body>` on stdin/stdout per ADR-009.
//      We build a minimal local framer here rather than reaching for
//      the contracts package's `jsonrpc-streaming.ts` (which contains
//      only subscription/notification types — confirmed via grep) OR
//      the runtime-daemon's `local-ipc-gateway.ts::parseFrame` (which
//      DOES implement the LSP grammar but is hardened for the
//      network-peer trust posture: 1024-byte header-section cap,
//      structured `FramingError.code` taxonomy, oversized-body skip-
//      and-resync). Reaching for the gateway framer here would import
//      a network-peer-grade framer onto a local-trusted-child boundary
//      — overweight surface and a bidirectional dependency we do not
//      need. The Rust side has `framing.rs`; this is its TS sibling.
//      Schema parity is hand-maintained on each side (no code-gen in
//      V1 — Plan-024 §Implementation Step 3). A future hardening pass
//      may add a header-section cap symmetric to the body cap; tracked
//      as a follow-up.
//
//   2. Crash-respawn supervision with a sliding-window budget. ADR-019
//      §Failure Mode Analysis row "Sidecar binary missing on user
//      machine" + Plan-024 §F-024-3-05 specify a "5 failures per 60s"
//      budget after which `PtyBackendUnavailable` is surfaced to the
//      consumer rather than spinning up an indefinite respawn loop.
//      The budget is implemented as a sliding window (per-crash
//      timestamp recorded; entries older than 60s evicted; window
//      contains 5+ crashes ⇒ fail). Sliding correctness avoids the
//      thrash-at-window-boundary failure mode of a fixed window.
//
//   3. The `PtyHost` contract surface. Mirrors `NodePtyHost`'s method
//      shape and lifecycle behavior so callers can swap implementations
//      via `PtyHostSelector` without behavioral drift. Spawn returns
//      a `SpawnResponse` carrying the sidecar-minted session id; subsequent
//      `resize`/`write`/`kill`/`close` route to the wire equivalents
//      and resolve once the sidecar acks.
//
// Architectural seams — `RustSidecarPtyHostDeps`
// ----------------------------------------------
//
// Every effectful primitive — the sidecar binary path resolver, the
// `child_process.spawn` invocation, the timer used by the crash-budget
// window, the clock used to stamp crash entries — is reachable through
// an injectable `Deps` record. Production callers pass nothing
// (defaults wire to `child_process.spawn`, `process.hrtime.bigint`,
// real `setTimeout`); tests inject `vi.fn()` doubles so the supervisor
// can be exercised without a real binary, real OS-level processes, or
// wall-clock waits. Mirrors the `NodePtyHostDeps` pattern from
// T-024-2-2.
//
// Refs: Plan-024 §Implementation Step 7 + §F-024-3-02 + §F-024-3-05;
// ADR-019 §Decision item 1 + §Failure Mode Analysis;
// ADR-009 §Decision (Content-Length framing).

import { Buffer } from "node:buffer";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { existsSync as fsExistsSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute as pathIsAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PTY_BACKEND_UNAVAILABLE_CODE,
  type Envelope,
  type ExitCodeNotification,
  type PtyBackendUnavailableDetails,
  type PtyHost,
  type PtySignal,
  type SpawnRequest,
  type SpawnResponse,
} from "@ai-sidekicks/contracts";

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

/**
 * Daemon-thrown error carrying a `PtyBackendUnavailable` payload.
 *
 * The `PtyBackendUnavailable` interface in `@ai-sidekicks/contracts`
 * is the wire-payload shape (a typed object, not an Error subclass);
 * this class wraps it so daemon-internal code can `throw` and
 * `instanceof`-test in TypeScript-idiomatic ways. Consumers (the
 * `PtyHostSelector`, future `runtime-bindings` callers) should
 * `instanceof PtyBackendUnavailableError` to recover the structured
 * `details` payload.
 *
 * `code` is fixed to `PTY_BACKEND_UNAVAILABLE_CODE` per Plan-024
 * §F-024-3-02; the literal value is asserted by the contracts-side
 * Zod schema so wire-side parity is enforced when this error is
 * serialized for IPC propagation (e.g., across the daemon ↔ control-
 * plane boundary in later plans).
 */
export class PtyBackendUnavailableError extends Error {
  public readonly code: typeof PTY_BACKEND_UNAVAILABLE_CODE = PTY_BACKEND_UNAVAILABLE_CODE;

  public readonly details: PtyBackendUnavailableDetails;

  public constructor(details: PtyBackendUnavailableDetails, message: string) {
    super(message);
    this.name = "PtyBackendUnavailableError";
    this.details = details;
  }
}

/**
 * Typed error surfaced when the sidecar emits a frame whose body the
 * daemon cannot decode as a well-formed JSON envelope. Three cause-shapes
 * land here, distinguished by `decodeCause`:
 *
 *   - `"json-parse"`: `JSON.parse` threw — the bytes are not valid JSON
 *     (e.g., truncated payload, non-UTF-8 garbage). This is the
 *     framing-equivalent failure at the payload layer: the framer
 *     handed us a body it considered well-formed at the wire level,
 *     but the body's JSON-decoding contract is broken.
 *
 *   - `"non-object-envelope"`: `JSON.parse` succeeded but returned a
 *     value that is not a plain non-array object (e.g., `null`, a
 *     primitive like `42`, an array — anything that does not satisfy
 *     the discriminated-union shape of `Envelope`). Without these
 *     guards a `null` body would slip past the try/catch and hit a
 *     `TypeError` on the downstream `envelope.kind` access, and an
 *     array body would silently fall through the switch (arrays have
 *     no `.kind`, and `typeof [] === "object"` so the typeof check
 *     alone is insufficient); we intercept all three shapes here so
 *     the teardown shape is symmetric with the parse-throw case.
 *
 *   - `"unknown-kind"`: `JSON.parse` succeeded and yielded a non-array
 *     object whose `kind` discriminator does NOT match any compile-time
 *     `Envelope` variant (version-skew between daemon and sidecar, or a
 *     sidecar bug emitting a kind the daemon's contract does not know).
 *     Structurally similar to `"non-object-envelope"` (payload-contract
 *     violation at the JSON-decoded layer) but the JSON is well-formed
 *     at the object level — the failure is purely in the discriminator.
 *     Silent fall-through here would leave any queued outstanding-Promise
 *     hanging indefinitely (the response that would have arrived in this
 *     frame is gone, and no case-arm resolver can route it); treat as a
 *     fatal supervisor event symmetric with the other two paths.
 *
 * Mirrors `PtyBackendUnavailableError`'s pattern (typed-class wrapper
 * around a structured failure). Daemon-internal callers `instanceof`
 * this to surface the JSON-decode-specific rejection cause to consumers
 * awaiting a request that would have arrived in the corrupted frame.
 *
 * Field name `decodeCause` (not `cause`) avoids overriding the built-in
 * `Error.cause` slot from ES2022 — different semantic (the standard
 * `cause` chains errors with another `Error`/`unknown`; our field is a
 * compile-time string discriminator).
 *
 * Refs: Plan-024 §T-024-3-1 (RustSidecarPtyHost crash-respawn
 * supervision per F-024-3-05); ADR-019 §Failure Mode Analysis
 * (sidecar-originated Sev-1 / binary-missing → fallback chain).
 * Payload-decode corruption is treated as a fatal supervisor event
 * symmetric in shape with framing-error teardown (see
 * drainParserUntilIncomplete).
 */
export class SidecarFrameDecodeError extends Error {
  public readonly decodeCause:
    | "json-parse"
    | "non-object-envelope"
    | "unknown-kind"
    | "invalid-base64";

  public constructor(
    decodeCause: "json-parse" | "non-object-envelope" | "unknown-kind" | "invalid-base64",
    message: string,
  ) {
    super(message);
    this.name = "SidecarFrameDecodeError";
    this.decodeCause = decodeCause;
  }
}

/**
 * Subset of `node:child_process.ChildProcess` we actually consume.
 *
 * Declared locally rather than typed-imported so tests can construct a
 * fake without pulling in the full ChildProcess shape. The cross-shape
 * we care about: stdin (writable), stdout (readable), stderr
 * (readable), `pid`, `kill`, `on('exit')`, `on('error')`. Mirrors the
 * `NodePtyChild` pattern in `node-pty-host.ts` — local minimal type
 * over real upstream type to document the consumed surface.
 */
export interface SidecarChildProcess {
  /**
   * OS-level pid; `undefined` if spawn failed before pid assignment.
   *
   * Declared as an optional property (rather than `readonly pid:
   * number | undefined`) so it lines up structurally with
   * `node:child_process.ChildProcess.pid` — Node's type marks pid as
   * `pid?: number` (optional), and TypeScript distinguishes optional
   * properties from required-but-undefinable properties under
   * `exactOptionalPropertyTypes: true`. The supervisor itself never
   * reads `pid` (correlation is per-FIFO at the wire layer); the
   * field exists solely so a fake child can mirror the real shape
   * for tests and so the diagnostic logs can include it eventually.
   */
  readonly pid?: number | undefined;
  /** Writable stdin — frames are written here. */
  readonly stdin: NodeJS.WritableStream;
  /** Readable stdout — framed responses + async events arrive here. */
  readonly stdout: NodeJS.ReadableStream;
  /** Readable stderr — sidecar diagnostic logs (eprintln from main.rs). */
  readonly stderr: NodeJS.ReadableStream;
  /** Subscribe to lifecycle events. */
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  /** Best-effort termination. */
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * `child_process.spawn` shape we consume — matches Node's overload
 * `spawn(command, args, options) → ChildProcessWithoutNullStreams`.
 *
 * Node's real `spawn` returns the broader `ChildProcess` when stdio
 * isn't pinned to pipe; we always pass `stdio: ['pipe', 'pipe',
 * 'pipe']` so we get the without-nulls variant. Tests inject a stub
 * returning a `SidecarChildProcess`-compatible fake.
 */
export type SidecarSpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

/**
 * Effectful primitives that `RustSidecarPtyHost` reaches through.
 * Every field is injectable so tests can drive the supervisor against
 * `vi.fn()` doubles without spawning real processes or waiting on
 * wall-clock timers.
 */
export interface RustSidecarPtyHostDeps {
  /**
   * Resolves the sidecar binary path. Defaults to
   * `resolveSidecarBinaryPath`, the four-tier resolver per Plan-024
   * §F-024-3-03 (env-var override → published platform package →
   * workspace release-build → workspace debug-build).
   *
   * Tests inject a fixed-string returner (e.g. `() => "/fake/sidecar"`)
   * to keep the supervisor exercise hermetic. The factory's
   * `binaryPath` opt is the production-side equivalent — it constructs
   * a host whose resolver returns the supplied path verbatim.
   */
  readonly resolveBinaryPath: () => string;
  /**
   * Process-spawn factory. Defaults to `node:child_process.spawn`.
   * Tests inject a stub returning a fake `ChildProcess`.
   */
  readonly spawn: SidecarSpawnFn;
  /**
   * Monotonic clock for crash-budget timestamps. Returns milliseconds
   * since process start. Defaults to `Number(process.hrtime.bigint() / 1_000_000n)`.
   * Tests inject a controllable mock-clock so the sliding-window
   * eviction can be exercised deterministically.
   */
  readonly nowMs: () => number;
}

/**
 * Sliding-window crash budget (per Plan-024 §F-024-3-05 + Pin 5).
 *
 * Fixed: 5 crashes within a rolling 60-second window. Implemented via
 * a `number[]` of crash timestamps (ms); each new crash records its
 * timestamp, then evicts entries older than the window before counting.
 * If the post-eviction count is `>=` the cap, the budget is exhausted.
 *
 * Sliding (vs fixed) avoids the thrash-at-window-boundaries failure
 * mode: a fixed 60-s window resets at minute boundaries, allowing a
 * pathological 4-crashes-per-minute attacker to never trip the budget.
 * Sliding always counts the most-recent N crashes regardless of
 * wall-clock alignment.
 *
 * Constants:
 *
 *   - `CRASH_BUDGET_WINDOW_MS = 60_000` (60 seconds per Plan-024)
 *   - `CRASH_BUDGET_LIMIT     = 5`      (5 crashes per Plan-024)
 *
 * These are deliberately not configurable at construction — the values
 * are policy from the plan, and exposing knobs would invite
 * per-deployment tuning that drifts from the documented contract.
 */
export const CRASH_BUDGET_WINDOW_MS = 60_000;
export const CRASH_BUDGET_LIMIT = 5;

/**
 * Pre-spawn event buffer caps (Plan-024 §I-024-6).
 *
 * `RustSidecarPtyHost` buffers inbound `DataFrame` / `ExitCodeNotification`
 * envelopes that arrive on the wire BEFORE the matching `SpawnResponse`
 * (the race surfaces when `merge_to_writer`'s unbiased `tokio::select!`
 * picks the sidecar's `outbound_tx` ahead of `dispatch_tx` for sub-ms
 * exits or pre-response data). Buffers drain on the subsequent
 * `SpawnResponse` arrival; under normal operation the race window is
 * microseconds and per-session retention is brief.
 *
 * The caps below bound the worst-case memory footprint for a sidecar
 * bug that emits events on a `session_id` no `SpawnResponse` ever
 * resolves (the buffer entry would otherwise leak until supervisor
 * teardown, which already clears it). They are deliberately not
 * runtime-configurable: the values are policy from the plan, and
 * exposing knobs would invite per-deployment tuning that drifts from
 * the contract.
 *
 * Per-session data-chunk cap × per-chunk wire-size (≤ 8 KiB, the
 * sidecar's stdout/stderr reader pump chunk size per Plan-024
 * §T-024-1-4) × stale-session cap = worst-case ~32 MiB pre-spawn
 * buffer footprint per supervisor lifetime.
 */
export const MAX_PRE_SPAWN_DATA_CHUNKS_PER_SESSION = 64;
export const MAX_PRE_SPAWN_BUFFERED_SESSIONS = 64;

/**
 * Closed-session-id retention cap with FIFO eviction (Plan-024 §I-024-6).
 *
 * Tracks `session_id`s removed from `sessions` by `close()` (or by the
 * fan-out paths' lifecycle equivalents) so a late `ExitCodeNotification`
 * / `DataFrame` arriving after `close()` resolves is suppressed (per
 * the `PtyHost.onExit` "MUST NOT fire after `close()` resolves"
 * contract clause) rather than routed into the pre-spawn buffer.
 *
 * Bounded at 10 000 entries with insertion-order FIFO eviction (the
 * supervisor's `Map`-iteration order is insertion order in JS, so
 * `closedSessionIds.values().next().value` returns the oldest entry).
 * Realistic upper bound: ~100 K sessions per long-running supervisor
 * lifetime (worktree-heavy day of use); the 10 K cap absorbs typical
 * bursts and bounds memory at ~80 KiB (entry size ≈ 8 bytes for a
 * `s-{n}` string literal in V8).
 */
export const MAX_CLOSED_SESSION_IDS = 10_000;

// --------------------------------------------------------------------------
// Default deps resolution
// --------------------------------------------------------------------------

/**
 * Four-tier sidecar binary resolver per Plan-024 §F-024-3-03.
 *
 * Resolution order — first hit wins; later tiers are NOT consulted:
 *
 *   1. Env-var `AIS_PTY_SIDECAR_BIN` (absolute path; trumps everything;
 *      lets developers point at a hand-built binary; CI custom-path
 *      overrides). Relative paths are REJECTED — a relative path would
 *      couple resolution to `process.cwd()` which is caller-dependent
 *      (a daemon spawned with cwd=/ vs cwd=/Users/x sees different
 *      binaries; that surface is a footgun, not a feature).
 *
 *   2. `require.resolve('@ai-sidekicks/pty-sidecar-${platform}-${arch}/
 *      bin/sidecar')` — the published platform package shipped to end
 *      users via `npm install`. This is the production V1 path; the
 *      umbrella `@ai-sidekicks/pty-sidecar` meta-package's
 *      `optionalDependencies` selects the right platform sub-package
 *      via `os` + `cpu` constraints.
 *
 *   3. `packages/sidecar-rust-pty/target/release/sidecar` — workspace
 *      dev-build, release profile. Used when a contributor has run
 *      `cargo build --release` locally but has NOT installed the
 *      published packages (the typical inner-loop dev workflow once a
 *      release-quality binary is desired).
 *
 *   4. `packages/sidecar-rust-pty/target/debug/sidecar` — workspace
 *      dev-build, debug profile, last resort. Used during initial
 *      iteration when a contributor has only run `cargo build` (the
 *      default debug profile is faster to compile but slower to run).
 *
 * On all four exhausted, throws `PtyBackendUnavailableError` per Plan-
 * 024 §F-024-3-02 + ADR-019 §Failure Mode "Sidecar binary missing on
 * user machine"; the daemon-layer caller (`PtyHostSelector`) converts
 * the throw to a `PtyBackendUnavailable` wire payload that downstream
 * UIs render as the "no PTY backend available" diagnostic banner.
 *
 * **Path-resolution anchor.** Tier 3/4 paths are resolved relative to
 * THIS file's location via `import.meta.url`, NOT `process.cwd()`. The
 * file lives at `packages/runtime-daemon/src/pty/rust-sidecar-pty-host.ts`
 * during dev (`vitest`-loaded `src/`) and at
 * `packages/runtime-daemon/dist/pty/rust-sidecar-pty-host.js` post-build
 * (`tsc`-emitted `dist/`); both layouts are exactly four directory levels
 * below `packages/`, so `../../../sidecar-rust-pty/target/...` is correct
 * from either. `process.cwd()` would be caller-dependent (the daemon
 * could be spawned from any directory) — same footgun as the relative-
 * env-var case.
 *
 * **Windows `.exe` suffix.** F-024-3-03's spec text reads `target/
 * release/sidecar` literally, but ADR-019 §Decision item 1 names
 * Windows as the primary target — the actual built binary is
 * `sidecar.exe` on Windows. We probe `${name}.exe` on `process.platform
 * === "win32"` and `${name}` elsewhere. Without the suffix the
 * resolver would deterministically miss tiers 2/3/4 on Windows even
 * when the binary exists on disk — defeats the entire failure-mode
 * mitigation on the platform that needs it most.
 *
 * **Effectful primitives are injectable.** `env`, `nodeRequire`, and
 * `existsSync` are constructor-injected with production defaults
 * (`process.env`, `module.createRequire(import.meta.url)`,
 * `node:fs.existsSync`). Tests pass `vi.fn()` doubles and assert tier
 * ordering by counting calls — when tier 1 hits, the `nodeRequire`
 * mock has zero invocations.
 *
 * Bracket notation on `process.env` is required by this repo's tsconfig
 * (`noPropertyAccessFromIndexSignature: true`).
 */

/**
 * Optional dependency-injection slots for `resolveSidecarBinaryPath`.
 *
 * Production callers pass nothing and the resolver wires to real
 * primitives (`process.env`, `module.createRequire(import.meta.url)`,
 * `node:fs.existsSync`). Tests pass mock doubles to drive the
 * four-tier ordering deterministically.
 */
export interface ResolveSidecarBinaryPathOptions {
  /**
   * Environment-variable provider. Defaults to `process.env`. Tests
   * pass an empty object (or one carrying a stubbed
   * `AIS_PTY_SIDECAR_BIN`) to drive the tier-1 branch in isolation.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Node `require` for `require.resolve` lookups. Defaults to a
   * `createRequire(import.meta.url)`-derived require. Tests inject a
   * `vi.fn()` returning a fake path or throwing to drive the tier-2
   * branch in isolation.
   *
   * Typed as a callable rather than the full `NodeRequire` interface
   * because we only consume `require.resolve` — mirroring the
   * `SidecarChildProcess` minimal-surface pattern.
   */
  readonly nodeRequire?: { resolve: (id: string) => string };
  /**
   * Filesystem-existence probe. Defaults to `node:fs.existsSync`.
   * Tests pass a `vi.fn()` returning true/false per path to drive the
   * tier-3 / tier-4 branches in isolation.
   */
  readonly existsSync?: (path: string) => boolean;
  /**
   * Override for the workspace release-build path probed by tier 3.
   * Tests use this to inject deterministic paths instead of relying
   * on the `import.meta.url` arithmetic. Production callers pass
   * nothing and the resolver computes the path via the four-up ascent
   * documented above.
   */
  readonly releasePath?: string;
  /**
   * Override for the workspace debug-build path probed by tier 4.
   * Same rationale as `releasePath`.
   */
  readonly debugPath?: string;
  /**
   * Platform string used to switch the Windows `.exe` suffix. Defaults
   * to `process.platform`. Tests pass `"win32"` / `"darwin"` / `"linux"`
   * verbatim to exercise the per-platform binary-name branch without
   * stubbing the global `process` object.
   */
  readonly platform?: NodeJS.Platform;
}

/**
 * Per-tier diagnostic record — captured during resolution and folded
 * into the four-exhausted error message so operators see WHICH tiers
 * were tried and HOW each one failed (not just "binary not found").
 */
interface TierAttempt {
  readonly tier: 1 | 2 | 3 | 4;
  readonly description: string;
  readonly outcome: string;
}

/**
 * Compute the published-platform-package id for tier 2.
 *
 * Format per F-024-3-03: `@ai-sidekicks/pty-sidecar-${platform}-${arch}/
 * bin/${binaryName}`. The spec text reads `/bin/sidecar` literally, but
 * the actual binary file shipped in the platform package on Windows is
 * `sidecar.exe` — `binaryName` carries the platform-correct suffix
 * (computed by `platformBinaryName`).
 *
 * Exposed as a separate function so the test surface can pin the id
 * format without reaching into the resolver internals.
 */
function publishedPackageIdFor(
  platform: NodeJS.Platform,
  arch: string,
  binaryName: string,
): string {
  return `@ai-sidekicks/pty-sidecar-${platform}-${arch}/bin/${binaryName}`;
}

/**
 * Append `.exe` on Windows; return as-is elsewhere. Centralized here
 * so the four-tier resolver and any future probe sites use the same
 * platform suffix logic.
 */
function platformBinaryName(base: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `${base}.exe` : base;
}

/**
 * Resolve the workspace dev-build path (tier 3 / tier 4) relative to
 * THIS file's location via `import.meta.url`. See the rustdoc on
 * `resolveSidecarBinaryPath` for the four-up ascent rationale.
 *
 * `profile` is `"release"` or `"debug"`. `binaryName` already includes
 * the `.exe` suffix on Windows.
 */
function workspaceTargetPath(profile: "release" | "debug", binaryName: string): string {
  // From `packages/runtime-daemon/{src,dist}/pty/rust-sidecar-pty-host.{ts,js}`,
  // `../../../` ascends three levels to land at `packages/`. The
  // `sidecar-rust-pty/target/${profile}/${binaryName}` suffix completes
  // the path. `fileURLToPath` converts the `file://` URL to a platform
  // path string (Windows backslashes vs POSIX slashes).
  const url: URL = new URL(
    `../../../sidecar-rust-pty/target/${profile}/${binaryName}`,
    import.meta.url,
  );
  return fileURLToPath(url);
}

export function resolveSidecarBinaryPath(opts?: ResolveSidecarBinaryPathOptions): string {
  // Resolve injection-point defaults. The `?? defaults` cascade is
  // duplicated here (rather than via a `resolveDefaults` helper) so
  // the function remains a single concrete unit for the
  // `isolatedDeclarations: true` guarantee — every path through the
  // body has explicit local types.
  const env: NodeJS.ProcessEnv = opts?.env ?? process.env;
  const nodeRequire: { resolve: (id: string) => string } =
    opts?.nodeRequire ?? createRequire(import.meta.url);
  const existsSync: (path: string) => boolean = opts?.existsSync ?? fsExistsSync;
  const platform: NodeJS.Platform = opts?.platform ?? process.platform;
  const binaryName: string = platformBinaryName("sidecar", platform);

  const attempts: TierAttempt[] = [];

  // ---- Tier 1: env-var override -----------------------------------------
  const fromEnv: string | undefined = env["AIS_PTY_SIDECAR_BIN"];
  if (fromEnv === undefined || fromEnv.length === 0) {
    attempts.push({
      tier: 1,
      description: "env-var AIS_PTY_SIDECAR_BIN",
      outcome: "unset",
    });
  } else if (!pathIsAbsolute(fromEnv)) {
    // Relative paths rejected — see resolver rustdoc. We log the
    // attempt as a hard failure (not just "miss") because the operator
    // explicitly tried to use this slot and got it wrong; the
    // diagnostic naming the rejected value is more useful than a
    // silent fall-through to tier 2.
    attempts.push({
      tier: 1,
      description: "env-var AIS_PTY_SIDECAR_BIN",
      outcome: `rejected (relative path; absolute required): ${JSON.stringify(fromEnv)}`,
    });
  } else if (!existsSync(fromEnv)) {
    // Stale/typo'd absolute path — reject deterministically rather
    // than handing the bad path to `ensureChild()` and letting the
    // doomed `spawn(...)` count against the sliding crash budget.
    // Five such typo'd attempts would otherwise flip the host to
    // permanently unavailable for the process lifetime. Same
    // diagnostic shape as the relative-path branch above so the
    // operator sees the exact value they typed wrong.
    attempts.push({
      tier: 1,
      description: "env-var AIS_PTY_SIDECAR_BIN",
      outcome: `rejected (path does not exist): ${JSON.stringify(fromEnv)}`,
    });
  } else {
    return fromEnv;
  }

  // ---- Tier 2: published platform package -------------------------------
  const arch: string = process.arch;
  const publishedId: string = publishedPackageIdFor(platform, arch, binaryName);
  // `tier2Cause` is captured for inclusion in `details.cause` on the
  // four-exhausted throw path (closest production-path miss). It stays
  // `unknown` rather than `Error | undefined` because Node's
  // `require.resolve` is documented to throw `Error`-shaped values but
  // the type system surface returns `unknown` from the catch block; we
  // preserve that shape for downstream consumers.
  let tier2Cause: unknown;
  try {
    const resolved: string = nodeRequire.resolve(publishedId);
    return resolved;
  } catch (err: unknown) {
    tier2Cause = err;
    attempts.push({
      tier: 2,
      description: `require.resolve(${JSON.stringify(publishedId)})`,
      outcome: `threw: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // ---- Tier 3: workspace release-build ----------------------------------
  const releasePath: string = opts?.releasePath ?? workspaceTargetPath("release", binaryName);
  if (existsSync(releasePath)) {
    return releasePath;
  }
  attempts.push({
    tier: 3,
    description: `packages/sidecar-rust-pty/target/release/${binaryName}`,
    outcome: `not found at ${releasePath}`,
  });

  // ---- Tier 4: workspace debug-build ------------------------------------
  const debugPath: string = opts?.debugPath ?? workspaceTargetPath("debug", binaryName);
  if (existsSync(debugPath)) {
    return debugPath;
  }
  attempts.push({
    tier: 4,
    description: `packages/sidecar-rust-pty/target/debug/${binaryName}`,
    outcome: `not found at ${debugPath}`,
  });

  // ---- Four-exhausted: surface PtyBackendUnavailableError ---------------
  //
  // Enumerate every tier failure in `details.message`; carry the tier-2
  // `require.resolve` error in `details.cause` because that is the
  // closest production-path miss (tier 1 is a developer-explicit
  // override; tiers 3/4 are workspace dev paths). The `PtyBackend
  // UnavailableDetails.cause` field is `unknown` per the contract,
  // so consumers MUST render it opaquely.
  const enumerated: string = attempts
    .map((a) => `  tier ${a.tier} (${a.description}): ${a.outcome}`)
    .join("\n");
  const details: PtyBackendUnavailableDetails =
    tier2Cause !== undefined
      ? { attemptedBackend: "rust-sidecar", cause: tier2Cause }
      : { attemptedBackend: "rust-sidecar" };
  throw new PtyBackendUnavailableError(
    details,
    `RustSidecarPtyHost: sidecar binary not found on any of the four resolution tiers ` +
      `(per Plan-024 §F-024-3-03). Attempts:\n${enumerated}\n` +
      `Set AIS_PTY_SIDECAR_BIN=<absolute path> to override, or install the ` +
      `published @ai-sidekicks/pty-sidecar package, or run \`cargo build --release\` ` +
      `inside packages/sidecar-rust-pty/.`,
  );
}

/**
 * Default `nowMs` — monotonic clock derived from `process.hrtime.bigint()`.
 *
 * `Date.now()` is wall-clock and can jump backward on NTP skew. The
 * crash-budget window MUST be monotonic so a wall-clock adjustment
 * never accidentally trips (or releases) the budget.
 *
 * Conversion: `process.hrtime.bigint()` returns nanoseconds since some
 * arbitrary epoch (process start in practice). Divide by 1_000_000 for
 * milliseconds; cast to `Number` because the budget arithmetic is plain
 * JS numbers (we only ever subtract nearby millisecond values, well
 * below the 2^53 safe-integer range — a 60-s window holds 60_000 ms
 * differences, so even at 100ns precision we have many lifetimes of
 * headroom).
 */
function defaultNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * Default `spawn` — `node:child_process.spawn` via dynamic import.
 *
 * Lazy load to keep this file's module-load-time cost zero on test
 * processes that inject a stub `spawn`. Same pattern as
 * `node-pty-host.ts`'s lazy `node-pty` loader.
 */
async function loadDefaultSpawn(): Promise<SidecarSpawnFn> {
  const cp: typeof import("node:child_process") = await import("node:child_process");
  return cp.spawn as SidecarSpawnFn;
}

/**
 * Resolve dep defaults. Tests pass overrides; production callers pass
 * nothing and the defaults wire to real primitives.
 *
 * `spawn` is async-loaded (the production path awaits the dynamic
 * import on first spawn); returning a `Partial` here would force the
 * class constructor to handle two shapes. Instead we return a record
 * with `spawn: null` as the "load lazily" sentinel — the class checks
 * for null and resolves at first use. Same pattern as
 * `NodePtyHost.resolvePtySpawn`.
 */
interface ResolvedDeps {
  readonly resolveBinaryPath: () => string;
  readonly spawn: SidecarSpawnFn | null;
  readonly nowMs: () => number;
}

function resolveDefaultDeps(partial: Partial<RustSidecarPtyHostDeps>): ResolvedDeps {
  return {
    resolveBinaryPath: partial.resolveBinaryPath ?? resolveSidecarBinaryPath,
    spawn: partial.spawn ?? null,
    nowMs: partial.nowMs ?? defaultNowMs,
  };
}

// --------------------------------------------------------------------------
// Content-Length framer (LSP-style — ADR-009 parity)
// --------------------------------------------------------------------------
//
// Build a minimal local framer here per Pin 4 — the contracts package's
// `jsonrpc-streaming.ts` contains only subscription/notification types
// (verified via grep), and there is no shared TS-side framer to reach
// for. The Rust side has `framing.rs` (Phase 1); this is its TS sibling.
// The two are independently maintained — each side enforces its own
// header parse + body length cap.

/**
 * Maximum frame body length. Mirrors `framing::MAX_FRAME_BODY_BYTES`
 * (8 MiB) on the Rust side for symmetric defense.
 */
export const MAX_FRAME_BODY_BYTES: number = 8 * 1024 * 1024;

/**
 * Maximum bytes accumulated for the header section (before the
 * `\r\n\r\n` delimiter) of a single Content-Length frame.
 *
 * Mirrors the per-section cap in the TS IPC sibling framer at
 * `packages/runtime-daemon/src/ipc/local-ipc-gateway.ts` lines 274-288
 * (`if (buffer.byteLength > 1024) throw FramingError("header_too_long"…)`).
 * The Rust framer at `packages/sidecar-rust-pty/src/framing.rs:34`
 * enforces a 1 KiB PER-LINE cap, deliberately different from this
 * per-section strategy (see the load-bearing comment at framing.rs:25-33).
 * The TS sibling parsers each maintain their own constant — the two
 * parsers are independently maintained per the comment at lines 700-706.
 *
 * Without this cap, a peer (or a desync condition) that never delivers
 * `\r\n\r\n` would pin the accumulator buffer indefinitely as `feed()`
 * concatenates unboundedly — an in-flight OOM surface symmetric to the
 * body-length cap above. Refs: Plan-024 §T-024-3-1 (framer hardening
 * symmetric with body-length defense); ADR-009 (Content-Length framing).
 */
export const MAX_HEADER_BYTES: number = 1024;

/**
 * Strict base64 alphabet matcher. `Buffer.from(s, "base64")` is permissive —
 * it silently drops characters outside the canonical alphabet and tolerates
 * misaligned padding, which would let a malformed `DataFrame.bytes`
 * payload corrupt the byte stream delivered to consumer `onData` callbacks
 * without any decode-error signal. Validate the input strictly BEFORE
 * decoding so any divergence from canonical base64 reroutes through the
 * fatal decode-error teardown path (`failFatallyOnDecodeError`).
 *
 * Accepts canonical RFC 4648 §4 base64 ONLY:
 *   - Alphabet: A-Z a-z 0-9 + /
 *   - Padding: zero, one, or two trailing `=` characters
 *   - Length: must be a multiple of 4
 *
 * Does NOT accept URL-safe base64 (`-`/`_` substitutions), embedded
 * whitespace, or lone `=` characters — the Rust sidecar always emits
 * canonical RFC 4648 §4 base64 via `base64::engine::general_purpose::STANDARD`
 * (verified via grep of the Rust sidecar), so any deviation is a decode
 * error. Refs: Plan-024 §T-024-3-1; ADR-009 (data-frame payload contract).
 */
const BASE64_PATTERN: RegExp = /^[A-Za-z0-9+/]*={0,2}$/;

function isStrictBase64(s: string): boolean {
  return s.length % 4 === 0 && BASE64_PATTERN.test(s);
}

/**
 * Stateful Content-Length frame parser. Feed buffered chunks via
 * `feed`; pull complete frame bodies via the iteration. Frames that
 * span chunk boundaries are correctly reassembled.
 *
 * Mirrors the parsing contract in `packages/runtime-daemon/src/ipc/
 * local-ipc-gateway.ts` (the in-process IPC framer) — header lines
 * MUST be `\r\n`-terminated; missing Content-Length rejects the frame;
 * body length over MAX_FRAME_BODY_BYTES rejects the frame.
 *
 * The parser does NOT throw on a single malformed header — it returns
 * a sentinel error value via the consumer-facing iterator so the
 * caller can choose to log + continue rather than tear the supervisor
 * down. Stream desync IS unrecoverable (we cannot tell where the next
 * frame starts), but the framer reports the desync rather than
 * panicking.
 *
 * Exported so the test surface can drive the parser directly without
 * going through the supervisor — needed for the framer-depth tests
 * that exercise the four `nextFrame()` rejection paths and the
 * partial-read / multi-frame-coalescing reassembly paths.
 */
export class ContentLengthParser {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Append `chunk` to the internal buffer. Frame parsing is driven on
   * demand by `nextFrame` — the parser is not callback-based.
   */
  public feed(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  /**
   * Attempt to parse one complete frame from the buffer. Returns:
   *
   *   - `{ kind: "frame", body }` — a complete body was extracted; the
   *     internal buffer is advanced past it.
   *   - `{ kind: "incomplete" }` — the buffer holds a partial header
   *     or a partial body; caller should `feed` more bytes.
   *   - `{ kind: "error", message }` — the framing was unrecoverably
   *     malformed (e.g., declared body length > cap, missing
   *     Content-Length); caller should treat as a fatal supervisor
   *     event.
   */
  public nextFrame():
    | { kind: "frame"; body: Buffer }
    | { kind: "incomplete" }
    | { kind: "error"; message: string } {
    // Locate the header terminator (CRLF CRLF). If absent, we either
    // have a partial header or no header yet — return incomplete UNLESS
    // the accumulator has exceeded the MAX_HEADER_BYTES cap. Without
    // this cap, a peer (or framing desync) that never delivers
    // `\r\n\r\n` would pin the accumulator buffer indefinitely as
    // `feed()` concatenates unboundedly — an in-flight OOM surface
    // symmetric with the MAX_FRAME_BODY_BYTES rejection below. The
    // sentinel `{ kind: "error" }` reroutes through the existing fatal
    // teardown path the supervisor uses for body-length errors.
    const headerEnd: number = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      if (this.buffer.length > MAX_HEADER_BYTES) {
        return {
          kind: "error",
          message:
            `header section exceeded ${MAX_HEADER_BYTES} bytes without ` +
            `"\\r\\n\\r\\n" terminator (likely framing desync)`,
        };
      }
      return { kind: "incomplete" };
    }
    if (headerEnd > MAX_HEADER_BYTES) {
      // The delimiter IS present but the header section before it is
      // larger than the cap — reject with a distinct diagnostic so the
      // distinction between "never-terminated header" (above) and
      // "oversized terminated header" (here) is visible in logs.
      return {
        kind: "error",
        message:
          `header section is ${headerEnd} bytes (with delimiter present); ` +
          `exceeds ${MAX_HEADER_BYTES} byte cap`,
      };
    }

    const headerBytes: Buffer = this.buffer.subarray(0, headerEnd);
    const bodyStart: number = headerEnd + 4;

    // Parse Content-Length header. We accept any case (LSP allows
    // case variation on header names); the value is required to be a
    // base-10 non-negative integer.
    const headerText: string = headerBytes.toString("utf8");
    const lines: string[] = headerText.split("\r\n");
    let contentLength: number | null = null;
    for (const line of lines) {
      const colonIdx: number = line.indexOf(":");
      if (colonIdx === -1) {
        // A header line without `:` is malformed per ADR-009. Reject.
        return {
          kind: "error",
          message: `header line missing ':' separator: ${JSON.stringify(line)}`,
        };
      }
      const name: string = line.slice(0, colonIdx).trim().toLowerCase();
      const value: string = line.slice(colonIdx + 1).trim();
      if (name === "content-length") {
        if (contentLength !== null) {
          // Duplicate Content-Length header — request-smuggling shape;
          // rejected per the strict-grammar contract that the Rust
          // side enforces (`framing::read_frame`). Symmetric defense.
          return {
            kind: "error",
            message: "duplicate Content-Length header (request-smuggling shape)",
          };
        }
        // Strict digit-only grammar — DELIBERATELY STRICTER than the
        // Rust framer at packages/sidecar-rust-pty/src/framing.rs,
        // which calls `value.trim().parse::<usize>()`. Rust's
        // `<usize as FromStr>::from_str` delegates to
        // `from_str_radix(s, 10)`, whose grammar is `^\+?[0-9]+$` —
        // a leading `+` sign IS accepted for unsigned types (only
        // `-` is rejected). See
        // https://doc.rust-lang.org/std/primitive.usize.html#method.from_str_radix.
        //
        // The daemon-side regex rejects `+N` to align with HTTP/1.1
        // RFC 7230 §3.3.2 (`Content-Length = 1*DIGIT` — no sign
        // permitted; https://datatracker.ietf.org/doc/html/rfc7230#section-3.3.2)
        // and as defense-in-depth against a hypothetical future
        // relay attacker that funnels untrusted bytes through the
        // Content-Length header before they reach the daemon. The
        // current Rust sidecar never emits `+N` Content-Length
        // headers (`framing.rs` formats via `Display` on `usize`,
        // which never produces a leading `+`), so the
        // daemon-rejects-while-Rust-would-accept asymmetry is safe:
        // a `+N` frame dies at the daemon's boundary, the sidecar
        // never sees it, and no smuggling vector exists under the
        // current trust architecture (the sidecar is trusted to
        // emit conforming Content-Length values; a compromised
        // sidecar already has worse vectors — emit invalid JSON to
        // trip the fatal-supervisor self-kill at
        // `drainParserUntilIncomplete`).
        //
        // The original bug `Number.parseInt(value, 10)` accepted
        // `"12junk"` as `12` and `"12.5"` as `12` — those ARE
        // shapes Rust rejects, and lax parsing there would let a
        // peer cause the daemon to slice a different body length
        // than the sidecar parsed. The strict digit-only regex
        // below forecloses that smuggling-shape vector while also
        // tightening the `+N` boundary beyond Rust.
        //
        // Both sides trim outer whitespace before the strict check;
        // both sides accept leading zeros (`"00000"` → `0`).
        if (!/^\d+$/.test(value)) {
          return {
            kind: "error",
            message: `Content-Length value is not a strict non-negative integer: ${JSON.stringify(value)}`,
          };
        }
        // `Number(value)` is safe here because the regex has already
        // validated digit-only content. No `parseInt` semantics
        // needed; `Number("0123")` → `123`, `Number("0")` → `0`.
        contentLength = Number(value);
      }
      // Other headers (e.g., Content-Type) are accepted and ignored.
    }

    if (contentLength === null) {
      return { kind: "error", message: "missing Content-Length header" };
    }
    if (contentLength > MAX_FRAME_BODY_BYTES) {
      return {
        kind: "error",
        message: `frame body ${contentLength} bytes exceeds MAX_FRAME_BODY_BYTES (${MAX_FRAME_BODY_BYTES})`,
      };
    }

    // Need bodyStart + contentLength bytes available before we can
    // extract the body. If short, return incomplete and wait for more
    // bytes via `feed`.
    if (this.buffer.length < bodyStart + contentLength) {
      return { kind: "incomplete" };
    }

    const body: Buffer = this.buffer.subarray(bodyStart, bodyStart + contentLength);
    // Advance the buffer past the consumed frame. We allocate a fresh
    // copy rather than slicing because Buffer.subarray returns a view
    // into the same memory as the parent — long-running parsers would
    // otherwise hold onto the original allocation indefinitely.
    this.buffer = Buffer.from(this.buffer.subarray(bodyStart + contentLength));
    return { kind: "frame", body };
  }
}

/**
 * Encode an `Envelope` as a Content-Length-framed Buffer ready to
 * write to stdin. `Content-Length: <bytes>\r\n\r\n<json-payload>`.
 *
 * `serialize` does not enforce the `MAX_FRAME_BODY_BYTES` cap on the
 * write side because the daemon is the trust boundary's friendly side
 * — we control what we serialize. The Rust framer DOES cap on read
 * for the same reason in reverse (it does not trust us either; the
 * cap is symmetric defense in depth).
 */
function serializeFrame(envelope: Envelope): Buffer {
  const payload: Buffer = Buffer.from(JSON.stringify(envelope), "utf8");
  const header: Buffer = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, payload]);
}

// --------------------------------------------------------------------------
// `RustSidecarPtyHost` class
// --------------------------------------------------------------------------

/**
 * Per-session state held by the supervisor.
 *
 * The supervisor maintains a session table keyed by sidecar-minted
 * `session_id` (the Rust side mints `s-{n}` per `pty_session.rs`).
 * Each entry tracks the listener subscriptions for `onData`/`onExit`
 * fan-out so a `close` can dispose them.
 */
interface SessionRecord {
  /**
   * Cached exit code once the sidecar's `ExitCodeNotification` has
   * arrived. `null` while the child is still alive. Idempotency
   * surface — a subsequent `close` after exit re-emits onExit from
   * the cache.
   */
  exitCode: number | null;
  /** Cached signal code (POSIX numeric) — `undefined` for normal exit. */
  signalCode: number | undefined;
}

/**
 * Outstanding-request entry — a Promise resolver waiting for a typed
 * response envelope from the sidecar.
 *
 * The dispatcher loop ahead of T-024-3-1 (the Rust side) does NOT
 * carry a request-id at the wire level; correlation is sequential per
 * kind. This supervisor matches incoming responses against the
 * head-of-FIFO outstanding entry of the matching response kind, which
 * is sufficient because requests of a given kind are issued
 * sequentially from the daemon (the `PtyHost` contract is per-method
 * Promise-returning; callers `await` before issuing the next request).
 *
 * Enforcing per-method serialization at the daemon side keeps the
 * wire-level correlation simple and avoids adding a request-id field
 * to the Rust protocol (which would be a contract bump).
 */
interface OutstandingRequest {
  readonly resolve: (envelope: Envelope) => void;
  readonly reject: (err: Error) => void;
  readonly responseKind: Envelope["kind"];
}

/**
 * Crash-respawn policy state — sliding-window timestamps of recorded
 * sidecar crashes.
 *
 * Per Plan-024 §F-024-3-05 + Pin 5: 5 failures per 60s sliding window;
 * exhausting the budget surfaces `PtyBackendUnavailable` to the next
 * caller.
 */
class CrashBudget {
  private readonly timestamps: number[] = [];

  public constructor(
    private readonly nowMs: () => number,
    private readonly windowMs: number = CRASH_BUDGET_WINDOW_MS,
    private readonly limit: number = CRASH_BUDGET_LIMIT,
  ) {}

  /**
   * Record a crash and return whether the budget is exhausted.
   *
   * Eviction strategy: filter out timestamps older than `windowMs`
   * BEFORE the count check. `Array.prototype.filter` is O(n) per
   * call; n is bounded by `limit + 1` (we'd never accumulate more
   * than that since exhaustion fires immediately), so the cost is
   * O(limit) per recorded crash. Acceptable for a cold path.
   */
  public recordAndIsExhausted(): boolean {
    const now: number = this.nowMs();
    const cutoff: number = now - this.windowMs;
    // Evict in-place via splice on the leading prefix of stale
    // entries. The array is naturally sorted ascending because we
    // only ever push monotonic timestamps; we can splice from the
    // start until we hit a fresh entry.
    let staleCount = 0;
    for (const ts of this.timestamps) {
      if (ts <= cutoff) {
        staleCount += 1;
      } else {
        break;
      }
    }
    if (staleCount > 0) {
      this.timestamps.splice(0, staleCount);
    }
    this.timestamps.push(now);
    return this.timestamps.length >= this.limit;
  }

  /** Inspector — number of crashes in the current sliding window. */
  public currentWindowSize(): number {
    return this.timestamps.length;
  }
}

/**
 * Out-of-process Rust PTY sidecar implementation of `PtyHost`.
 *
 * Spawns the sidecar binary as a child process with `stdio: ['pipe',
 * 'pipe', 'pipe']`, wires Content-Length framing on stdin/stdout, and
 * exposes the `PtyHost` runtime API. Crash supervision: child exit
 * triggers a respawn via `ensureChild`; budget exhaustion surfaces
 * `PtyBackendUnavailableError`.
 *
 * **Lifecycle stub note.** This class supplies the daemon-side
 * primitives (`spawn`/`resize`/`write`/`kill`/`close`) that I-024-4
 * (sidecar-cleanup-handler-before-Electron-will-quit) consumes. The
 * will-quit registration itself is owned by Plan-001 CP-001-1; this
 * class does NOT hook into Electron — it just exposes the methods
 * Plan-001's cleanup handler calls into.
 */
export class RustSidecarPtyHost implements PtyHost {
  private readonly deps: ResolvedDeps;

  /** Lazily-resolved spawn fn (lazy-load deferred until first spawn). */
  private cachedSpawn: SidecarSpawnFn | null = null;

  /** The currently-running sidecar child, or `null` if not yet spawned. */
  private child: SidecarChildProcess | null = null;

  /**
   * Frame parser — fed by the child's stdout `data` listener.
   *
   * NOT `readonly`: the supervisor MUST replace the parser instance
   * with a fresh one on every child-exit / child-error path. Without
   * the reset, partial-frame buffer state from a corrupted sidecar
   * (the framing-error self-kill cascade) carries over to the next
   * sidecar and produces a guaranteed desync — the stale bytes plus
   * the next chunk would either spuriously match a CRLFCRLF mid-old-
   * body or trip the framer's error sentinel, exhausting the
   * crash-respawn budget in ~5 cycles for a transient single-frame
   * upset on the first sidecar.
   */
  private parser: ContentLengthParser = new ContentLengthParser();

  /**
   * Reference to the `data` listener attached to the CURRENT child's
   * stdout, retained so `handleChildExit` / `handleChildError` can
   * detach it via `child.stdout.off("data", ...)` before swapping in
   * the fresh parser.
   *
   * Why this matters: the listener is a closure that captures `this`
   * and feeds bytes into `this.parser`. After a child exits and the
   * supervisor swaps in a fresh parser, late-buffered stdout bytes
   * from the old child's stream would otherwise still arrive at the
   * (now-stale) listener and be fed into the NEW parser — corrupting
   * its framing state and potentially forcing unnecessary kill/respawn
   * cycles via `drainParserUntilIncomplete`'s error sentinel.
   *
   * Set in `attachChildListeners`; cleared in `handleChildExit` /
   * `handleChildError` immediately before the parser swap.
   *
   * Stdout is the only stream whose late delivery contaminates
   * supervisor-visible state. `stderr` writes a `console.warn` —
   * harmless if late. `exit` / `error` listeners capture `child` by
   * reference and route through `recordCrashOncePerChild`, which
   * dedupes on the child handle via `crashCountedChildren` — also
   * harmless if a stale event arrives after respawn.
   */
  private childStdoutListener: ((chunk: Buffer) => void) | null = null;

  /** Per-session state table keyed by sidecar-minted `s-{n}` ids. */
  private readonly sessions: Map<string, SessionRecord> = new Map();

  /** Crash-respawn budget — sliding window per Plan-024 §F-024-3-05. */
  private readonly crashBudget: CrashBudget;

  /**
   * Whether the supervisor has been permanently disabled by an
   * exhausted crash budget. Once `true`, every subsequent method call
   * rejects with `PtyBackendUnavailableError` instead of spawning.
   */
  private permanentlyUnavailable = false;

  /**
   * Promise-memoized in-flight cold-start spawn attempt.
   *
   * `ensureChild` awaits `resolveSpawn()` before assigning `this.child`,
   * so two near-simultaneous callers (e.g., concurrent `write` + `kill`
   * while the host is cold) can both pass the `this.child === null`
   * check, both yield, and both reach the synchronous spawn. The
   * second assignment would overwrite `this.child`, orphaning the
   * first child with listeners wired against the dead reference
   * (misrouted frames, double crash-budget consumption).
   *
   * Promise-memoization rather than a mutex: the second caller does
   * not need to spawn — it just needs the same promise the first
   * caller is already awaiting. Cleared in a `.finally()` so the next
   * call after success (short-circuits on `this.child !== null`) or
   * failure (retries via the crash-budget semantics) re-enters
   * cleanly. (Plan-024, T-024-3-1.)
   */
  private inflightSpawn: Promise<void> | null = null;

  /**
   * FIFO queue of outstanding requests indexed by response kind.
   *
   * Per the supervisor's correlation contract (see `OutstandingRequest`
   * rustdoc), responses are matched against the head-of-FIFO entry of
   * the matching kind. The daemon serializes requests of a given kind
   * via the `await` discipline, so there is at most one outstanding
   * per kind in normal operation; the FIFO is robustness against a
   * future caller that violates that discipline.
   */
  private readonly outstanding: Map<Envelope["kind"], OutstandingRequest[]> = new Map();

  /**
   * Per-child guard — `WeakSet` of children that have already had their
   * crash counted against the budget.
   *
   * Node's `child_process` can in rare edge cases emit BOTH `error` and
   * `exit` for the same failed child (spawn synchronously OK, then
   * crash mid-init); each handler would naively call
   * `crashBudget.recordAndIsExhausted()` and double-consume the budget.
   * The guard ensures the second event no-ops budget consumption while
   * still running the cleanup (clearing `this.child`, rejecting
   * outstanding, resetting the parser).
   *
   * `WeakSet` rather than a `Set` so the entries do not pin the
   * `SidecarChildProcess` (Node's `ChildProcess` carries listener
   * registrations and stream buffers; we let the GC reclaim the prior
   * child once the next one is wired up).
   */
  private readonly crashCountedChildren: WeakSet<SidecarChildProcess> = new WeakSet();

  /**
   * Pending fatal-teardown cause stashed by `handleInbound` (and any
   * future fatal-supervisor site) before issuing `child.kill("SIGKILL")`,
   * consumed by `handleChildExit` / `handleChildError` to drive
   * `rejectAllOutstanding(cause)` with the JSON-decode-specific error
   * rather than the generic "sidecar exited" message.
   *
   * The stash is consumed at most once per teardown via
   * `consumePendingTeardownCause`. Node's `child_process` can fire
   * BOTH `error` and `exit` for the same dying child (the same race the
   * `crashCountedChildren` WeakSet defends against — see
   * `recordCrashOncePerChild`); the first responder takes the cause,
   * the second falls back to the generic message. The stash is null
   * outside an active fatal-supervisor teardown.
   *
   * Why a stashed cause and not a synchronous reject-then-kill: the
   * exit-driven teardown is the single canonical site for parser
   * reset + outstanding rejection + crash-budget accounting; running
   * `rejectAllOutstanding` synchronously inside `handleInbound` and
   * again from the exit handler would double-reject (NoOp because
   * `outstanding` would already be empty, but a code-shape risk
   * future contributors could trip over). The stash threads the
   * cause through the existing single-source teardown chain.
   *
   * Refs: This is a LOCAL class invariant — the outstanding-Promise
   * FIFO + single-source teardown chain are guarded only on the
   * active-child exit/error path. See SidecarFrameDecodeError class
   * rustdoc and handleChildExit rustdoc for the broader supervisor
   * semantics; Plan-024 §T-024-3-1 governs the crash-respawn
   * supervision; ADR-019 §Failure Mode Analysis governs the
   * sidecar-originated failure → fallback chain.
   */
  private pendingTeardownCause: Error | null = null;

  /** `onData` consumer callback. Set via `setOnData`. */
  private dataListener: (sessionId: string, chunk: Uint8Array) => void = () => undefined;

  /** `onExit` consumer callback. Set via `setOnExit`. */
  private exitListener: (sessionId: string, exitCode: number, signalCode?: number) => void = () =>
    undefined;

  /**
   * Pre-spawn `DataFrame` buffer (Plan-024 §I-024-6).
   *
   * Holds decoded `Uint8Array` chunks for a `session_id` whose
   * `SpawnResponse` has not yet been received. Drains on the matching
   * `SpawnResponse` arrival via `replayPreSpawnEvents`. Per-session
   * entries are bounded by `MAX_PRE_SPAWN_DATA_CHUNKS_PER_SESSION`;
   * the total number of buffered session_ids is bounded by
   * `MAX_PRE_SPAWN_BUFFERED_SESSIONS`. Cleared on supervisor teardown
   * (`handleChildExit` / `handleChildError`) — the sidecar's monotonic
   * `session_id` counter resets on respawn, so stale-id retention
   * would replay pre-respawn data against a fresh post-respawn session.
   */
  private readonly pendingDataFrames: Map<string, Uint8Array[]> = new Map();

  /**
   * Pre-spawn `ExitCodeNotification` buffer (Plan-024 §I-024-6).
   *
   * Holds at most one notification per `session_id` (the sidecar's
   * exactly-once-per-session exit contract). Drains on the matching
   * `SpawnResponse` arrival; cleared on supervisor teardown for the
   * same reason as `pendingDataFrames`.
   */
  private readonly pendingExits: Map<string, ExitCodeNotification> = new Map();

  /**
   * Closed-session-id tracker (Plan-024 §I-024-6).
   *
   * `close(sessionId)` removes the session record from `sessions` AND
   * adds the id here so a late inbound `ExitCodeNotification` /
   * `DataFrame` for that id is suppressed (per the
   * `PtyHost.onExit` "MUST NOT fire after `close()` resolves" contract)
   * rather than routed into `pendingExits` / `pendingDataFrames` as a
   * pre-spawn buffer entry that would leak until supervisor teardown.
   *
   * Bounded at `MAX_CLOSED_SESSION_IDS` with FIFO eviction (the Map's
   * insertion order); evicted entries fall back to the pre-spawn-
   * buffer branch, which is the same observable behavior as the
   * pre-suppression state — a no-op when no matching `SpawnResponse`
   * arrives, since the sidecar's `session_id` counter does not reuse
   * ids within a supervisor lifetime. Cleared on supervisor teardown:
   * the sidecar's `session_id` counter resets on respawn, so retention
   * across supervisor lifetimes would suppress a fresh post-respawn
   * session that happens to mint an id matching a pre-respawn closed
   * one (the typical `s-0` reuse case after a crash + immediate
   * respawn + first-session-id).
   */
  private readonly closedSessionIds: Set<string> = new Set();

  public constructor(deps?: Partial<RustSidecarPtyHostDeps>) {
    this.deps = resolveDefaultDeps(deps ?? {});
    this.crashBudget = new CrashBudget(this.deps.nowMs);
  }

  // ---- PtyHost methods --------------------------------------------------

  public async spawn(spec: SpawnRequest): Promise<SpawnResponse> {
    await this.ensureChild();
    // `sendRequest` rejects the Promise when the sidecar's
    // `SpawnResponse` carries `error: Some(msg)` (the symmetric wire-
    // side error path that converts an otherwise-indefinite hang into
    // a prompt rejection — see `resolveOutstanding` rustdoc and
    // `protocol::SpawnResponse` in `sidecar-rust-pty/src/protocol.rs`).
    // On the rejection path no session was minted; the supervisor
    // never registers tracking — registration happens synchronously in
    // `resolveOutstanding` on the spawn_response success branch, which
    // the error branch returns before reaching.
    //
    // Why registration is NOT here (post-await): the drain loop in
    // `drainParserUntilIncomplete` dispatches frames synchronously
    // without yielding to microtasks, so any DataFrame /
    // ExitCodeNotification trailing this SpawnResponse in the same
    // stdout chunk (the sidecar's spawn_reader_task and
    // spawn_waiter_task are spawned BEFORE the dispatcher queues
    // SpawnResponse on dispatch_tx, and merge_to_writer's unbiased
    // select! can pick outbound_tx first) would observe
    // sessions.has(id) === false and be silently dropped if
    // registration waited for this post-await body to resume.
    // See `resolveOutstanding` for the in-band registration site.
    // (Plan-024 §T-024-3-1.)
    //
    // The symmetric case where DataFrame / ExitCodeNotification
    // arrives on the wire BEFORE the SpawnResponse (same race source,
    // earlier wire offset) is covered by the pre-spawn buffer at
    // `pendingDataFrames` + `pendingExits` — frames for an unknown
    // session_id route into the buffer and drain after registration
    // via `replayPreSpawnEvents`. (Plan-024 §I-024-6.)
    const response = await this.sendRequest(spec, "spawn_response");
    if (response.kind !== "spawn_response") {
      throw new Error(`RustSidecarPtyHost.spawn: unexpected response kind ${response.kind}`);
    }
    return response;
  }

  public async resize(sessionId: string, rows: number, cols: number): Promise<void> {
    // Sync throw on truly-unknown sessionId — mirrors `NodePtyHost.kill`
    // (which throws synchronously on the same condition). The contract
    // matters: PtyHostSelector substitutes the two backends behind the
    // same `PtyHost` interface; the substitution is honest only if the
    // observable failure shape matches. The wire-side error response
    // path covers the daemon-still-has-it-but-sidecar-removed-it race
    // (where the daemon's `sessions.has(sessionId)` returns true, the
    // request goes to the wire, and the sidecar replies with a typed
    // `error: "..."` response that routes through the Promise rejection).
    if (!this.sessions.has(sessionId)) {
      throw new Error(`RustSidecarPtyHost.resize: unknown sessionId '${sessionId}'`);
    }
    await this.ensureChild();
    await this.sendRequest(
      { kind: "resize_request", session_id: sessionId, rows, cols },
      "resize_response",
    );
  }

  public async write(sessionId: string, bytes: Uint8Array): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`RustSidecarPtyHost.write: unknown sessionId '${sessionId}'`);
    }
    await this.ensureChild();
    // Encode bytes as base64 per F-024-1-01 (sidecar protocol).
    const base64: string = Buffer.from(bytes).toString("base64");
    await this.sendRequest(
      { kind: "write_request", session_id: sessionId, bytes: base64 },
      "write_response",
    );
  }

  public async kill(sessionId: string, signal: PtySignal): Promise<void> {
    const record: SessionRecord | undefined = this.sessions.get(sessionId);
    if (record === undefined) {
      // Sync throw on truly-unknown sessionId — mirrors `NodePtyHost.
      // kill`, see `resize` rustdoc for the parity rationale.
      throw new Error(`RustSidecarPtyHost.kill: unknown sessionId '${sessionId}'`);
    }
    // Idempotency clause (mirrors `node-pty-host.ts`): a kill on an
    // already-exited session re-emits onExit from the cached values
    // rather than dispatching a wire request.
    if (record.exitCode !== null) {
      this.fireExit(sessionId, record.exitCode, record.signalCode);
      return;
    }
    await this.ensureChild();
    await this.sendRequest(
      { kind: "kill_request", session_id: sessionId, signal },
      "kill_response",
    );
  }

  public async close(sessionId: string): Promise<void> {
    // `close()` removes the session record SYNCHRONOUSLY before
    // dispatching the wire-side `kill_request{SIGTERM}` AND records
    // the id in `closedSessionIds` so that any `ExitCodeNotification`
    // / `DataFrame` arriving during the await falls into the
    // closed-session suppression branch of `handleExitNotification` /
    // `handleEnvelope` rather than the pre-spawn buffer branch (per
    // Plan-024 §I-024-6). This matches the post-`close()`
    // onExit-suppression contract — `NodePtyHost` achieves the same
    // suppression by disposing its `child.onExit` subscription BEFORE
    // the kill dispatch (see `node-pty-host.ts:619-626` + `640-644`).
    // The kind-keyed `outstanding` queue still correlates the
    // `kill_response` independent of the session record, so the wire
    // reply still resolves `close()` cleanly.
    const record: SessionRecord | undefined = this.sessions.get(sessionId);
    if (record === undefined) {
      // Idempotent close on an unknown session — not an error per the
      // PtyHost contract.
      return;
    }
    this.sessions.delete(sessionId);
    this.recordClosedSessionId(sessionId);
    if (record.exitCode === null) {
      // Best-effort kill via SIGTERM. We catch and swallow a wire-side
      // failure here because `close` must not throw on a child that
      // has already exited mid-request (race window between the
      // ExitCodeNotification arrival and the close call).
      try {
        await this.sendRequest(
          { kind: "kill_request", session_id: sessionId, signal: "SIGTERM" },
          "kill_response",
        );
      } catch {
        // Swallow — best-effort close.
      }
    }
  }

  // ---- PtyHost callback surface -----------------------------------------

  public onData(sessionId: string, chunk: Uint8Array): void {
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

  /**
   * Ensure a sidecar child process is alive. Spawns on first call and
   * after a crash; throws `PtyBackendUnavailableError` if the budget
   * has been exhausted.
   *
   * Spawn failure (binary missing, exec permission denied, etc) is
   * caught and converted to `PtyBackendUnavailableError` — the wire
   * shape matches what `PtyHostSelector` will surface to the consumer.
   * The crash budget is consumed on these failures too: a binary
   * that refuses to spawn 5 times in 60s exhausts the budget the
   * same way a binary that crashes 5 times does.
   */
  private async ensureChild(): Promise<void> {
    if (this.permanentlyUnavailable) {
      throw new PtyBackendUnavailableError(
        { attemptedBackend: "rust-sidecar" },
        "RustSidecarPtyHost: crash-respawn budget exhausted " +
          `(${CRASH_BUDGET_LIMIT} crashes within ${CRASH_BUDGET_WINDOW_MS}ms); ` +
          "refusing to respawn.",
      );
    }
    if (this.child !== null) {
      return;
    }
    // Concurrent cold-start callers share the same in-flight spawn
    // attempt — see the `inflightSpawn` field rustdoc for the race
    // shape this closes (Plan-024, T-024-3-1).
    if (this.inflightSpawn !== null) {
      return this.inflightSpawn;
    }

    this.inflightSpawn = (async (): Promise<void> => {
      try {
        const spawnFn: SidecarSpawnFn = await this.resolveSpawn();

        // Defensive re-check of `permanentlyUnavailable` after the
        // `await this.resolveSpawn()` yield. Under the current
        // architecture this is structurally unreachable: the early
        // check at the top of `ensureChild` already observes any
        // budget mutation from a prior child's `handleChildExit` (a
        // synchronous event handler), and Promise-memoization
        // guarantees at most one in-flight IIFE per cold-start cycle.
        // Kept as belt-and-suspenders against a future code path
        // that adds another async write site to
        // `permanentlyUnavailable` during the yield.
        if (this.permanentlyUnavailable) {
          throw new PtyBackendUnavailableError(
            { attemptedBackend: "rust-sidecar" },
            "RustSidecarPtyHost: crash-respawn budget exhausted " +
              `(${CRASH_BUDGET_LIMIT} crashes within ${CRASH_BUDGET_WINDOW_MS}ms); ` +
              "refusing to respawn.",
          );
        }

        let binaryPath: string;
        try {
          binaryPath = this.deps.resolveBinaryPath();
        } catch (err: unknown) {
          // Binary path resolution failure is the "binary missing"
          // condition; surface as PtyBackendUnavailable. We do NOT
          // consume the crash budget for path-resolution failures
          // because they will deterministically fail on every retry —
          // there is no pathological respawn loop to defend against.
          //
          // **Preserve the inner error if it's already a
          // `PtyBackendUnavailableError`.** The default resolver
          // (`resolveSidecarBinaryPath`) emits a tier-enumerated message
          // and a tier-2 `details.cause` on the four-exhausted path —
          // wrapping that in a NEW outer error with the generic
          // "failed to resolve sidecar binary path" message would bury
          // the operator-grade diagnostic two levels deep in
          // `details.cause.message` + `details.cause.details.cause`.
          // Mirror the `pty-host-selector.ts:251` re-throw guard so the
          // original tier enumeration surfaces unchanged. Tests +
          // ad-hoc resolvers that throw plain `Error` still take the
          // wrap branch (preserving the prior behavior for them).
          if (err instanceof PtyBackendUnavailableError) {
            throw err;
          }
          throw new PtyBackendUnavailableError(
            { attemptedBackend: "rust-sidecar", cause: err },
            "RustSidecarPtyHost: failed to resolve sidecar binary path",
          );
        }

        let child: ChildProcessWithoutNullStreams;
        try {
          child = spawnFn(binaryPath, [], {
            // Pipe all three streams. stdin/stdout for framing; stderr
            // for sidecar diagnostics (forwarded to the daemon's logs).
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (err: unknown) {
          // Synchronous spawn failure (immediate ENOENT, EACCES, etc).
          // Consume the crash budget — repeated failures here look the
          // same as repeated crashes from the supervisor's perspective.
          if (this.crashBudget.recordAndIsExhausted()) {
            this.permanentlyUnavailable = true;
          }
          throw new PtyBackendUnavailableError(
            { attemptedBackend: "rust-sidecar", cause: err },
            `RustSidecarPtyHost: spawn(${binaryPath}) failed`,
          );
        }
        this.child = child;
        this.attachChildListeners(child);
      } finally {
        // Clear unconditionally so the next call after success OR
        // failure re-enters cleanly: success short-circuits on
        // `this.child !== null`; failure retries via the existing
        // crash-budget semantics (the budget consumption above is
        // the load-bearing failure-rate gate, not this latch).
        this.inflightSpawn = null;
      }
    })();

    return this.inflightSpawn;
  }

  /**
   * Wire stdout/stderr/exit/error listeners on a freshly-spawned child.
   *
   * Stdout drives the parser; each complete frame is dispatched to
   * `handleInbound`. Stderr is forwarded to the daemon's logger via
   * `console.warn` (matching the `node-pty-host.ts` interim-logger
   * convention). Exit triggers crash-respawn accounting.
   *
   * `error` events are spawn-time failures asynchronously surfaced
   * (the synchronous spawn returned a child handle but the OS-level
   * spawn failed). Treated identically to a crash.
   */
  private attachChildListeners(child: SidecarChildProcess): void {
    // Stdin/stdout/stderr async errors (ERR_STREAM_DESTROYED / EPIPE /
    // EIO) bypass any synchronous try/catch on the call site — Node's
    // `Writable.write` throws synchronously only for misuse (encoding
    // errors, write-after-end). The common broken-pipe failure modes
    // fire as async `'error'` events on the stream objects. Without
    // per-pipe listeners these escalate to `uncaughtException` and
    // crash the daemon. Logging + SIGTERM triggers the existing
    // `handleChildExit` path which already runs `rejectAllOutstanding`
    // — that's the load-bearing cleanup; the listener's jobs are just
    // (a) consume the error event, (b) ensure the child exits so the
    // existing cleanup runs. The `child.on('error', ...)` listener
    // attached at the bottom of this function catches errors on the
    // child PROCESS (spawn failures), NOT pipe-level errors on the
    // three stream objects. SIGTERM (not SIGKILL) matches the
    // `close()` flow's escalation discipline — `drainParserUntilIncomplete`'s
    // SIGKILL is intentional asymmetry for unrecoverable protocol
    // corruption, which does not apply here. (Plan-024, T-024-3-1.)
    const pipeErrorHandler =
      (which: "stdin" | "stdout" | "stderr") =>
      (err: Error): void => {
        console.warn(
          `RustSidecarPtyHost (${which}): ${err.message}; terminating child for respawn.`,
        );
        try {
          child.kill("SIGTERM");
        } catch {
          // Best-effort — child may have already exited (ESRCH).
        }
      };
    child.stdin.on("error", pipeErrorHandler("stdin"));
    child.stdout.on("error", pipeErrorHandler("stdout"));
    child.stderr.on("error", pipeErrorHandler("stderr"));

    // Stdout: parse Content-Length frames and dispatch.
    //
    // Retain a named listener reference (rather than an anonymous
    // arrow) so `handleChildExit` / `handleChildError` can detach it
    // before swapping in a fresh parser — see `childStdoutListener`
    // rustdoc for the contamination scenario this prevents.
    const stdoutListener = (chunk: Buffer): void => {
      this.parser.feed(chunk);
      this.drainParserUntilIncomplete();
    };
    child.stdout.on("data", stdoutListener);
    this.childStdoutListener = stdoutListener;

    // Stderr: forward to the daemon's logs. Sidecar `eprintln!` goes
    // here; routing it through `console.warn` keeps the diagnostic
    // visible without choosing a structured-logger seam yet (matches
    // `node-pty-host.ts` interim convention).
    //
    // TRIPWIRE: replace `console.warn` once a structured logger
    // surfaces in the runtime-daemon.
    child.stderr.on("data", (chunk: Buffer) => {
      console.warn(`RustSidecarPtyHost (stderr): ${chunk.toString("utf8").trimEnd()}`);
    });

    // Exit: clear the child reference so the next request triggers a
    // respawn; consume the crash budget. Pass the child reference so
    // the handler can dedupe budget consumption when both `error` and
    // `exit` fire for the same failed child — Node's `child_process`
    // can emit both in rare spawn-then-crash-mid-init edge cases.
    child.on("exit", (code: number | null, signal: string | null) => {
      this.handleChildExit(child, code, signal);
    });

    // Error: async spawn failure (the OS surfaced the failure after
    // the synchronous spawn returned). Same accounting as a crash.
    child.on("error", (err: Error) => {
      this.handleChildError(child, err);
    });
  }

  /**
   * Pull complete frames from the parser until it returns `incomplete`.
   *
   * Called after every `feed` so a single TCP-coalesced chunk that
   * happens to carry multiple frames is fully consumed in one pass
   * rather than waiting for the next stdout `data` event.
   */
  private drainParserUntilIncomplete(): void {
    for (;;) {
      const result = this.parser.nextFrame();
      if (result.kind === "incomplete") {
        return;
      }
      if (result.kind === "error") {
        // Framing-level desync — the sidecar's stdout is corrupted.
        // We cannot recover; treat as a fatal supervisor event.
        //
        // Framing-error consumers intentionally receive the generic
        // "sidecar exited" message via `handleChildExit`'s fallback
        // arm; see `failFatallyOnDecodeError` for the typed-cause
        // stash pattern reserved for payload-layer JSON-decode
        // failures. A future hardening pass could symmetrically stash
        // a typed framing-cause here so awaiting callers see a
        // framing-specific rejection, but that's intentionally out of
        // scope for the JSON-decode hardening pass.
        console.warn(
          `RustSidecarPtyHost: framing error on sidecar stdout (${result.message}); ` +
            "tearing down child for respawn.",
        );
        // Force a respawn by killing the child; the exit handler
        // will record the crash and respawn (or surface
        // PtyBackendUnavailable if the budget is exhausted).
        if (this.child !== null) {
          try {
            this.child.kill("SIGKILL");
          } catch {
            // Best-effort — child may have already exited.
          }
        }
        return;
      }
      this.handleInbound(result.body);
    }
  }

  /**
   * Decode a frame body as JSON `Envelope` and route to the matching
   * outstanding-request resolver, or to the data/exit fan-out.
   */
  private handleInbound(body: Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch (err: unknown) {
      // JSON.parse threw — the bytes are not valid JSON. Symmetric
      // with the framing-error fatal-supervisor path: the wire layer
      // gave us a well-formed-by-frame body whose payload contract
      // is broken, which we cannot recover from. A silent skip leaves
      // every queued outstanding-Promise hanging indefinitely (the
      // response that would have arrived in this frame is gone) and
      // risks downstream frame-stream desync if the failure came
      // from a length-mismatch artifact. Treat as fatal and
      // respawn through the existing teardown chain.
      const cause: SidecarFrameDecodeError = new SidecarFrameDecodeError(
        "json-parse",
        `RustSidecarPtyHost: failed to parse inbound JSON envelope ` +
          `(${(err as Error).message}); tearing down child for respawn.`,
      );
      this.failFatallyOnDecodeError(cause);
      return;
    }

    // JSON.parse succeeded but the decoded value is not a non-array
    // object envelope. Three shapes converge here, all structurally
    // unable to satisfy the discriminated-union `Envelope` contract:
    //
    //   - `JSON.parse("null")` returns `null` (the typeof check alone
    //     misses it because `typeof null === "object"`).
    //   - `JSON.parse("[1,2,3]")` returns an array (arrays are objects
    //     in JS — `typeof [] === "object"` and `[] !== null` — so both
    //     prior checks pass; without the `Array.isArray` guard the
    //     downstream `envelope.kind` read returns `undefined`, no
    //     `case` arm matches, the switch falls through silently, and
    //     every queued outstanding-Promise hangs indefinitely).
    //   - `JSON.parse("42")` and other primitives — caught by the
    //     `typeof !== "object"` arm.
    //
    // Without these guards the downstream `envelope.kind` access
    // either TypeErrors out of this method (null) or silently no-ops
    // (array) — both are the silent-drop failure mode this fatal-
    // supervisor path exists to close. Intercept here so the teardown
    // shape matches the parse-throw path above.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      const observedKind: string =
        parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
      const cause: SidecarFrameDecodeError = new SidecarFrameDecodeError(
        "non-object-envelope",
        `RustSidecarPtyHost: decoded payload is not an object envelope ` +
          `(observedKind=${observedKind}); tearing down child for respawn.`,
      );
      this.failFatallyOnDecodeError(cause);
      return;
    }

    const envelope: Envelope = parsed as Envelope;

    switch (envelope.kind) {
      case "data_frame": {
        // Three branches per Plan-024 §I-024-6:
        //
        //   1. Known + alive (`sessions.has(id)`): decode + fire onData.
        //      Mirrors `node-pty-host.ts`'s active-subscription dispatch.
        //
        //   2. Known + closed (`closedSessionIds.has(id)`): suppress.
        //      The consumer's `close()` removed the session record
        //      synchronously before dispatching the kill request; a
        //      late `DataFrame` arriving during the await is
        //      consumer-meaningless. Mirrors `node-pty-host.ts`'s
        //      close-time subscription disposal (see
        //      `node-pty-host.ts:619-626` + `640-644`).
        //
        //   3. Unknown (neither alive nor closed): buffer as a
        //      pre-spawn event. The sidecar's `spawn_reader_task` is
        //      spawned BEFORE the dispatcher queues `SpawnResponse` on
        //      `dispatch_tx` (per `packages/sidecar-rust-pty/src/
        //      pty_session.rs::spawn()`), and `merge_to_writer`'s
        //      unbiased `tokio::select!` can pick `outbound_tx` first,
        //      so a `DataFrame` for a freshly-spawned session can
        //      legitimately arrive on the wire before the matching
        //      `SpawnResponse`. The buffer drains on the subsequent
        //      `SpawnResponse` via `replayPreSpawnEvents`.
        //
        // Strict-base64 validation runs BEFORE all three branches:
        // corruption is a wire-level violation regardless of whether
        // the session is alive, closed, or unknown. `Buffer.from(s,
        // "base64")` is permissive — invalid characters are silently
        // dropped — so the malformed payload would otherwise be
        // delivered as a corrupted byte stream with no decode-error
        // signal. Route any divergence from canonical RFC 4648 §4
        // base64 through the same fatal teardown path used for JSON-
        // decode failures above (symmetric in shape with json-parse,
        // non-object-envelope, and unknown-kind teardowns).
        if (!isStrictBase64(envelope.bytes)) {
          const cause: SidecarFrameDecodeError = new SidecarFrameDecodeError(
            "invalid-base64",
            `RustSidecarPtyHost: data_frame.bytes is not strict base64 ` +
              `(session=${envelope.session_id}, length=${envelope.bytes.length}); ` +
              `tearing down child for respawn.`,
          );
          this.failFatallyOnDecodeError(cause);
          break;
        }
        const bytes: Uint8Array = Buffer.from(envelope.bytes, "base64");
        if (this.sessions.has(envelope.session_id)) {
          this.dataListener(envelope.session_id, bytes);
          break;
        }
        if (this.closedSessionIds.has(envelope.session_id)) {
          // Post-close() suppression — see branch (2) above.
          break;
        }
        this.bufferPreSpawnData(envelope.session_id, bytes);
        break;
      }
      case "exit_code_notification": {
        this.handleExitNotification(envelope);
        break;
      }
      case "spawn_response":
      case "resize_response":
      case "write_response":
      case "kill_response":
      case "ping_response": {
        this.resolveOutstanding(envelope);
        break;
      }
      // Variants that should never be inbound from the sidecar (we
      // are the request-issuing side; the sidecar does not echo
      // requests). Log + skip.
      case "spawn_request":
      case "resize_request":
      case "write_request":
      case "kill_request":
      case "ping_request": {
        console.warn(
          `RustSidecarPtyHost: unexpected inbound request kind ${envelope.kind} from sidecar; skipping.`,
        );
        break;
      }
      default: {
        // Unknown envelope kind — version skew between daemon and
        // sidecar, or a sidecar bug emitting a kind the daemon's
        // compile-time `Envelope` discriminated union does not know.
        // Symmetric with the JSON-parse and non-object-envelope fatal-
        // supervisor paths above: the wire layer delivered a body that
        // is well-formed JSON AND a non-array object, but the payload-
        // contract `kind` discriminator is broken in a way we cannot
        // recover from. A silent fall-through here would leave every
        // queued outstanding-Promise hanging indefinitely (the response
        // that would have arrived in this frame is gone, and no case-arm
        // resolver can route it). Treat as fatal and respawn through
        // the existing teardown chain.
        //
        // We BOTH preserve the compile-time exhaustiveness check (via
        // the `_exhaustive: never` assignment at the tail) AND install
        // a runtime arm here, because wire reality is broader than the
        // compile-time union: a future sidecar version that emits
        // tomorrow's-new-kind frames against today's daemon binary
        // satisfies neither compile-time nor switch-time exhaustion,
        // and we MUST close that gap defensively. The `_exhaustive`
        // assignment narrows `envelope` to `never` after the named
        // cases above; if a new variant is added to `Envelope` without
        // a corresponding `case` arm, tsc will fail this assignment at
        // compile time even though the runtime arm exists.
        //
        // The `kind` diagnostic is read through a non-narrowing cast
        // to obtain a usable `unknown` value for the runtime error
        // message — after the named cases, `envelope`'s type is
        // `never`, and reading `.kind` directly would type-check as
        // `never` rather than producing a diagnostic-friendly value.
        // The cast is a runtime-value pattern; compile-time
        // exhaustiveness is enforced by `const _exhaustive: never =
        // envelope` at the tail of this arm.
        //
        // The string-branch diagnostic is run through `JSON.stringify`
        // (mirroring lines ~517 / ~540 / ~736 / ~791) so embedded
        // CRLF or control bytes from a sidecar bug / version-skew
        // artifact cannot inject forged log lines into operator-grade
        // logs; the non-string branch is fixed-enum `typeof` output
        // and is safe to interpolate verbatim.
        //
        // Refs: Plan-024 §T-024-3-1 (RustSidecarPtyHost crash-respawn
        // supervision per F-024-3-05); ADR-019 §Failure Mode Analysis
        // (sidecar-originated failure → fallback chain).
        const rawKind: unknown = (envelope as { kind?: unknown }).kind;
        const unknownKind: string =
          typeof rawKind === "string" ? JSON.stringify(rawKind) : `<non-string:${typeof rawKind}>`;
        const cause: SidecarFrameDecodeError = new SidecarFrameDecodeError(
          "unknown-kind",
          `RustSidecarPtyHost: unknown inbound envelope kind ${unknownKind} ` +
            `(version skew or sidecar bug); tearing down child for respawn.`,
        );
        this.failFatallyOnDecodeError(cause);
        // Compile-time exhaustiveness gate: after every named case
        // narrows `envelope`, this assignment compiles only while the
        // switch covers every `Envelope` variant. Unreachable at
        // runtime when a new variant has been added (the new case
        // arm would intercept first); when a new variant is added
        // WITHOUT a corresponding case arm, tsc fails here.
        const _exhaustive: never = envelope;
        return _exhaustive;
      }
    }
  }

  /**
   * Handle an inbound `ExitCodeNotification`.
   *
   * Four branches per Plan-024 §I-024-6:
   *
   * - **Known session, no cached exitCode:** cache the exit code on
   *   the session record and fire the exit listener. The record is
   *   removed when `close()` runs (synchronous delete-before-await)
   *   or when a subsequent `close()` arrives.
   * - **Known session, exitCode already cached:** drop as a duplicate
   *   (the sidecar's contract is exactly-once per session, but
   *   defensively dedupe).
   * - **Known + closed (`closedSessionIds.has(id)`):** the consumer
   *   has already called `close()`, which removed the session record
   *   AND recorded the id in `closedSessionIds` before dispatching
   *   the kill request. Suppress the fan-out and log diagnostically —
   *   emitting onExit after `close()` resolves breaks the
   *   post-`close()` onExit-suppression contract that consumers rely
   *   on for substitutability with NodePtyHost (see
   *   node-pty-host.ts:619-626 + 640-644 — its `child.onExit`
   *   subscription is disposed BEFORE the kill dispatch precisely so
   *   the same suppression holds there).
   * - **Unknown (neither alive nor closed):** buffer as a pre-spawn
   *   event. The sidecar's `spawn_waiter_task` is spawned BEFORE the
   *   dispatcher queues `SpawnResponse` on `dispatch_tx` (per
   *   `packages/sidecar-rust-pty/src/pty_session.rs::spawn()`), and
   *   `merge_to_writer`'s unbiased `tokio::select!` can pick
   *   `outbound_tx` first — so for a sub-millisecond-lived child
   *   the `ExitCodeNotification` can legitimately arrive on the
   *   wire before the matching `SpawnResponse`. The buffer drains
   *   on the subsequent `SpawnResponse` via `replayPreSpawnEvents`.
   */
  private handleExitNotification(notification: ExitCodeNotification): void {
    const record: SessionRecord | undefined = this.sessions.get(notification.session_id);
    if (record !== undefined) {
      if (record.exitCode !== null) {
        // Duplicate exit notification — the sidecar's contract is
        // exactly-once per session, but defensively dedupe.
        return;
      }
      record.exitCode = notification.exit_code;
      record.signalCode = notification.signal_code ?? undefined;
      this.fireExit(notification.session_id, notification.exit_code, record.signalCode);
      return;
    }
    if (this.closedSessionIds.has(notification.session_id)) {
      // Post-close() suppression — see branch (3) above.
      //
      // TRIPWIRE: replace `console.warn` once a structured logger
      // surfaces in the runtime-daemon. The routine close() lifecycle
      // (close → SIGTERM → child exits → late ExitCodeNotification →
      // this branch) makes this the warn most likely to fire under
      // normal teardown; the structured-logger pass should demote it
      // to debug/info.
      console.warn(
        `RustSidecarPtyHost: late ExitCodeNotification for closed ` +
          `session_id ${notification.session_id} (exit_code=` +
          `${notification.exit_code}); suppressed.`,
      );
      return;
    }
    // Pre-spawn buffer — see branch (4) above.
    this.bufferPreSpawnExit(notification);
  }

  /**
   * Match an inbound response envelope against the head-of-FIFO
   * outstanding entry of the matching kind and either resolve or
   * reject its promise.
   *
   * **Error-response branch.** `SpawnResponse` / `ResizeResponse` /
   * `WriteResponse` / `KillResponse` all carry an optional
   * `error?: string` per the Plan-024 contract. When `error` is
   * present the sidecar's handler failed (most often `UnknownSession`
   * for a request that lost a race against natural exit — see
   * `KillResponse` rustdoc in `pty-host-protocol.ts` — or a
   * `portable-pty` failure for a `spawn_request` against a
   * nonexistent / non-executable command); we reject the awaiting
   * Promise so the caller sees a prompt failure instead of an
   * indefinite hang. The `close()` happy-path's existing try/catch
   * swallows this rejection cleanly because the close-races-natural-
   * exit shape is a normal lifecycle event from its perspective.
   * Other callers (e.g., a direct `kill()` on an active session, or a
   * `spawn()` against a nonexistent command) propagate the rejection
   * up. For `spawn_response` rejections this method's error branch
   * returns BEFORE reaching the in-band `sessions.set(...)` call below
   * (and `spawn()`'s `await` throws on the caller side), so no
   * tracking is registered on the failure path — neither on the empty
   * `session_id` the sidecar emits per contract, nor on a non-empty
   * `session_id` if a sidecar bug pairs one with an `error` field.
   */
  private resolveOutstanding(envelope: Envelope): void {
    const queue: OutstandingRequest[] | undefined = this.outstanding.get(envelope.kind);
    if (queue === undefined || queue.length === 0) {
      // Stray response — no outstanding request of this kind. Log
      // and drop; we cannot do anything useful with an uncorrelated
      // response.
      console.warn(
        `RustSidecarPtyHost: received uncorrelated response kind ${envelope.kind}; dropping.`,
      );
      return;
    }
    const head: OutstandingRequest | undefined = queue.shift();
    if (head === undefined) {
      return;
    }
    // Inspect error-bearing variants — spawn/resize/write/kill responses
    // all carry the optional `error` field per the contract bump.
    if (
      (envelope.kind === "spawn_response" ||
        envelope.kind === "resize_response" ||
        envelope.kind === "write_response" ||
        envelope.kind === "kill_response") &&
      envelope.error !== undefined
    ) {
      head.reject(
        new Error(
          `RustSidecarPtyHost: sidecar ${envelope.kind} returned error for session_id='${envelope.session_id}': ${envelope.error}`,
        ),
      );
      return;
    }
    // Register the session synchronously here — NOT in spawn()'s
    // post-await body — so that any DataFrame / ExitCodeNotification
    // frames trailing this SpawnResponse in the same stdout chunk
    // observe sessions.has(id) === true when the drain loop dispatches
    // them. spawn()'s `await sendRequest` resumes on a microtask
    // scheduled by Promise.resolve, but the drain loop processes frames
    // synchronously without yielding; without this in-band registration,
    // same-chunk frames for a freshly-minted session_id race past
    // sessions.set and are silently dropped. Mirrors the sidecar's
    // outbound-channel pre-emission of DataFrame / ExitCodeNotification
    // by spawn_reader_task / spawn_waiter_task — both background tasks
    // are spawned BEFORE the dispatcher queues SpawnResponse on
    // dispatch_tx, and merge_to_writer's unbiased select! can pick
    // outbound_tx first. (Plan-024 §T-024-3-1.)
    //
    // Pre-spawn-buffer replay (Plan-024 §I-024-6): for the symmetric
    // ordering where DataFrame / ExitCodeNotification arrives on the
    // wire BEFORE the matching SpawnResponse (same race source, just
    // an earlier wire offset), `handleEnvelope` + `handleExitNotification`
    // buffer the events keyed by session_id. After registering the
    // session here we drain those buffers via `replayPreSpawnEvents`,
    // which `setImmediate`-defers the listener fan-out so the consumer's
    // `await spawn()` continuation runs first and records the session_id
    // in consumer-side state BEFORE `onData` / `onExit` fires.
    if (envelope.kind === "spawn_response") {
      this.sessions.set(envelope.session_id, {
        exitCode: null,
        signalCode: undefined,
      });
      this.replayPreSpawnEvents(envelope.session_id);
    }
    head.resolve(envelope);
  }

  /**
   * Fan-out helper for the exit listener that respects the
   * `signalCode === undefined` contract (the listener type omits the
   * third parameter when undefined).
   */
  private fireExit(sessionId: string, exitCode: number, signalCode: number | undefined): void {
    if (signalCode === undefined) {
      this.exitListener(sessionId, exitCode);
    } else {
      this.exitListener(sessionId, exitCode, signalCode);
    }
  }

  /**
   * Append a pre-spawn `DataFrame` payload to the per-session buffer
   * (Plan-024 §I-024-6).
   *
   * Bounded by `MAX_PRE_SPAWN_BUFFERED_SESSIONS` (total stale sessions)
   * AND `MAX_PRE_SPAWN_DATA_CHUNKS_PER_SESSION` (chunks per session).
   * Over-cap entries are logged + dropped — the caller's terminal
   * effect is the same as if the sidecar had emitted the bytes after a
   * session-id mismatch (which is the pathological case the cap
   * defends against). Buffers drain on the matching `SpawnResponse`
   * via `replayPreSpawnEvents`, or are cleared on supervisor teardown.
   */
  private bufferPreSpawnData(sessionId: string, bytes: Uint8Array): void {
    const existing: Uint8Array[] | undefined = this.pendingDataFrames.get(sessionId);
    if (existing === undefined) {
      if (this.pendingDataFrames.size >= MAX_PRE_SPAWN_BUFFERED_SESSIONS) {
        // Total-stale-session cap exhausted — a fresh session_id would
        // expand the map past the cap. Drop with a warn; a future
        // SpawnResponse for this id would arrive (if it ever does)
        // and replay an empty buffer, matching the no-buffer-event
        // baseline.
        console.warn(
          `RustSidecarPtyHost: pre-spawn buffer at capacity ` +
            `(${MAX_PRE_SPAWN_BUFFERED_SESSIONS} stale sessions); ` +
            `dropping DataFrame for session_id ${sessionId}.`,
        );
        return;
      }
      this.pendingDataFrames.set(sessionId, [bytes]);
      return;
    }
    if (existing.length >= MAX_PRE_SPAWN_DATA_CHUNKS_PER_SESSION) {
      console.warn(
        `RustSidecarPtyHost: pre-spawn DataFrame buffer for session_id ` +
          `${sessionId} at capacity ` +
          `(${MAX_PRE_SPAWN_DATA_CHUNKS_PER_SESSION} chunks); ` +
          `dropping further chunks until SpawnResponse arrives.`,
      );
      return;
    }
    existing.push(bytes);
  }

  /**
   * Store the single pre-spawn `ExitCodeNotification` for a session
   * (Plan-024 §I-024-6).
   *
   * The sidecar's exactly-once-per-session exit contract means at
   * most one entry per session_id; a defensive duplicate drops with a
   * warn rather than overwriting (overwrite would change observable
   * behavior on a sidecar bug). Bounded by
   * `MAX_PRE_SPAWN_BUFFERED_SESSIONS` for the same reason as
   * `bufferPreSpawnData`.
   */
  private bufferPreSpawnExit(notification: ExitCodeNotification): void {
    if (this.pendingExits.has(notification.session_id)) {
      console.warn(
        `RustSidecarPtyHost: duplicate pre-spawn ExitCodeNotification ` +
          `for session_id ${notification.session_id} (exit_code=` +
          `${notification.exit_code}); dropping (sidecar contract is ` +
          `exactly-once-per-session).`,
      );
      return;
    }
    if (
      !this.pendingDataFrames.has(notification.session_id) &&
      this.pendingExits.size >= MAX_PRE_SPAWN_BUFFERED_SESSIONS
    ) {
      // Fresh session_id would expand the per-kind buffer past the cap.
      // Drop with a warn; semantics match the over-cap data-buffer
      // path.
      console.warn(
        `RustSidecarPtyHost: pre-spawn exit buffer at capacity ` +
          `(${MAX_PRE_SPAWN_BUFFERED_SESSIONS} stale sessions); ` +
          `dropping ExitCodeNotification for session_id ` +
          `${notification.session_id}.`,
      );
      return;
    }
    this.pendingExits.set(notification.session_id, notification);
  }

  /**
   * Drain any pre-spawn `DataFrame` / `ExitCodeNotification` buffers
   * for `sessionId` after the supervisor's `resolveOutstanding`
   * registers the session via `SpawnResponse` (Plan-024 §I-024-6).
   *
   * **Defer rationale.** The drain loop in `drainParserUntilIncomplete`
   * dispatches frames synchronously without yielding to microtasks,
   * so `resolveOutstanding`'s `head.resolve(envelope)` schedules the
   * `spawn()`-caller's await continuation on the microtask queue —
   * but the continuation does not actually run until the current
   * synchronous block (the drain loop + its caller) completes. If
   * `replayPreSpawnEvents` fired listeners synchronously inside the
   * spawn-response branch of `resolveOutstanding`, the listener fan-
   * out would happen BEFORE `spawn()`'s caller resumes — i.e., before
   * the consumer records `sessionId` in its own state. Consumers that
   * key off `await spawn()`'s returned `session_id` (the typical
   * `await spawn(); sessions.set(id, ...);` pattern) would observe
   * `onData(id, ...)` / `onExit(id, ...)` against a not-yet-recorded
   * id.
   *
   * `setImmediate` schedules the replay on the I/O loop's Check phase,
   * AFTER the current Poll phase's microtask queue drains — by which
   * time `spawn()`'s caller continuation has resumed, the
   * `SpawnResponse` has been returned to its caller, and the caller
   * has run its post-await body. `.unref()` keeps the timer from
   * pinning the daemon process alive during teardown (a corner case;
   * the typical replay path runs within microseconds of scheduling).
   *
   * **Ordering inside the replay.** DataFrame chunks fire in arrival
   * order (the buffer is an array, FIFO); ExitCodeNotification fires
   * last per the sidecar's exit-is-terminal contract. A late
   * `close()` arriving between the SpawnResponse and the
   * `setImmediate` fire is honored — the replay re-checks
   * `sessions.has(sessionId)` and `closedSessionIds.has(sessionId)`
   * before firing each event so a same-tick close suppresses the
   * fan-out per the post-`close()` onExit-suppression contract.
   */
  private replayPreSpawnEvents(sessionId: string): void {
    const dataFrames: Uint8Array[] | undefined = this.pendingDataFrames.get(sessionId);
    const exit: ExitCodeNotification | undefined = this.pendingExits.get(sessionId);
    this.pendingDataFrames.delete(sessionId);
    this.pendingExits.delete(sessionId);
    if (dataFrames === undefined && exit === undefined) {
      return;
    }
    const handle: NodeJS.Immediate = setImmediate(() => {
      // Re-check at fire time — a `close(sessionId)` running between
      // the SpawnResponse-handling and the setImmediate fire would
      // have removed the session record AND added the id to
      // closedSessionIds. Honor that by suppressing the fan-out, per
      // the PtyHost contract's "MUST NOT fire after close() resolves"
      // clause.
      if (this.closedSessionIds.has(sessionId)) {
        return;
      }
      if (dataFrames !== undefined && this.sessions.has(sessionId)) {
        for (const bytes of dataFrames) {
          this.dataListener(sessionId, bytes);
        }
      }
      if (exit !== undefined) {
        const record: SessionRecord | undefined = this.sessions.get(sessionId);
        if (record === undefined || record.exitCode !== null) {
          // Either close() ran between schedule and fire (record
          // undefined; closedSessionIds branch above already covers
          // most of that, but a same-tick handleChildExit-driven
          // sessions.clear() would land here), or another
          // ExitCodeNotification path already cached the exit (e.g.,
          // a real-time post-spawn exit fired before this replay
          // scheduled). Either way, suppress per the existing
          // exactly-once-per-session + post-close contracts.
          return;
        }
        record.exitCode = exit.exit_code;
        record.signalCode = exit.signal_code ?? undefined;
        this.fireExit(sessionId, exit.exit_code, record.signalCode);
      }
    });
    handle.unref();
  }

  /**
   * Append `sessionId` to `closedSessionIds` with FIFO eviction
   * beyond `MAX_CLOSED_SESSION_IDS` (Plan-024 §I-024-6).
   *
   * The Map's insertion order is JS's natural FIFO; the oldest entry
   * is the first value yielded by `values().next()`. Eviction is
   * cheap (one map delete per recorded close beyond the cap) and the
   * cap is reached only on long-running supervisors with extreme
   * session churn (~10 K closes within a single supervisor lifetime).
   * Evicted entries fall back to the pre-spawn-buffer branch — a
   * no-op when no matching `SpawnResponse` arrives, since the
   * sidecar does not reuse session_ids within a supervisor lifetime.
   */
  private recordClosedSessionId(sessionId: string): void {
    if (this.closedSessionIds.has(sessionId)) {
      // Defensive — close() is idempotent at the public surface and
      // duplicates should not reach here, but re-adding would not
      // refresh insertion order on a Set; explicit no-op clarifies.
      return;
    }
    if (this.closedSessionIds.size >= MAX_CLOSED_SESSION_IDS) {
      const oldest: string | undefined = this.closedSessionIds.values().next().value;
      if (oldest !== undefined) {
        this.closedSessionIds.delete(oldest);
      }
    }
    this.closedSessionIds.add(sessionId);
  }

  /**
   * Clear all pre-spawn buffers + closed-session-id retention on
   * supervisor teardown (Plan-024 §I-024-6).
   *
   * Invoked from `handleChildExit` / `handleChildError` after the
   * parser reset + outstanding rejection. The sidecar's monotonic
   * `session_id` counter resets on respawn (per `packages/sidecar-
   * rust-pty/src/pty_session.rs`), so retention of pre-respawn ids in
   * either the pre-spawn buffer OR the closed-session-id set across a
   * supervisor lifetime would (a) replay stale pre-respawn data
   * against a fresh post-respawn session, OR (b) suppress legitimate
   * events for a fresh post-respawn session whose id matches a
   * pre-respawn closed one (the typical `s-0`-after-crash case).
   *
   * The `sessions` map is intentionally left untouched: existing
   * pre-respawn entries are harmless cruft (their consumers received
   * rejections via `rejectAllOutstanding`); a fresh post-respawn
   * `SpawnResponse` for the same id overwrites the stale entry in
   * `resolveOutstanding`'s `sessions.set(...)` call.
   */
  private clearPreSpawnState(): void {
    this.pendingDataFrames.clear();
    this.pendingExits.clear();
    this.closedSessionIds.clear();
  }

  /**
   * Send a request envelope and return a promise that resolves with
   * the matching response envelope of `expectedResponseKind`.
   *
   * The send is fire-and-forget on the wire — the response correlates
   * via the kind-keyed FIFO. Promise rejection paths:
   *   - stdin write fails synchronously: rejects immediately.
   *   - sidecar exits before response arrives: every queued request
   *     is rejected by `rejectAllOutstanding` from the exit handler.
   */
  private sendRequest(
    request: Envelope,
    expectedResponseKind: Envelope["kind"],
  ): Promise<Envelope> {
    return new Promise<Envelope>((resolve, reject) => {
      const child: SidecarChildProcess | null = this.child;
      if (child === null) {
        // Defensive: the caller MUST `await ensureChild()` first.
        reject(new Error("RustSidecarPtyHost.sendRequest: no child process"));
        return;
      }
      // Enqueue BEFORE writing — if the write triggers a synchronous
      // exit (rare, but possible if stdin is closed), the exit
      // handler MUST find the entry to reject.
      const queue: OutstandingRequest[] = this.outstanding.get(expectedResponseKind) ?? [];
      queue.push({ resolve, reject, responseKind: expectedResponseKind });
      this.outstanding.set(expectedResponseKind, queue);

      const frame: Buffer = serializeFrame(request);
      // Node's `WritableStream.write` is sync-call but may return
      // false to signal backpressure. We do not wait on backpressure
      // here — the supervisor accepts at most one outstanding request
      // per kind in normal operation, and the sidecar drains stdin
      // promptly (the dispatcher loop is the consumer). If a future
      // workload needs backpressure, this is the seam to revisit.
      try {
        child.stdin.write(frame);
      } catch (err: unknown) {
        // Synchronous write failure. Remove the just-pushed
        // outstanding entry and reject — the response will never
        // arrive.
        const removed: OutstandingRequest | undefined = queue.pop();
        if (removed !== undefined && removed.resolve === resolve) {
          // Confirmed it's our entry — safe to reject.
          reject(
            err instanceof Error
              ? err
              : new Error(`RustSidecarPtyHost.sendRequest: stdin.write threw: ${String(err)}`),
          );
        }
      }
    });
  }

  /**
   * Lazily resolve the spawn fn (production: `node:child_process.spawn`
   * via dynamic import; tests: injected stub).
   */
  private async resolveSpawn(): Promise<SidecarSpawnFn> {
    if (this.cachedSpawn !== null) {
      return this.cachedSpawn;
    }
    if (this.deps.spawn !== null) {
      this.cachedSpawn = this.deps.spawn;
      return this.cachedSpawn;
    }
    this.cachedSpawn = await loadDefaultSpawn();
    return this.cachedSpawn;
  }

  /**
   * Handle a child-exit event — reset the framer, clear the child
   * reference, reject any still-outstanding requests, consume the
   * crash budget once per failed child, mark permanently unavailable
   * if exhausted.
   *
   * **Parser-reset ordering.** Reset the framer FIRST, before the
   * outstanding-rejection loop. If anything in the rejection path
   * throws (defensive — listeners SHOULD NOT, but might), the parser
   * is already known-clean and the next sidecar will not inherit
   * partial-frame buffer state. Reset is idempotent so re-running it
   * costs nothing.
   *
   * **Crash-budget dedupe.** Node's `child_process` can emit BOTH
   * `error` and `exit` for the same failed child in rare edge cases
   * (spawn synchronously OK, then crash mid-init). We track which
   * children have already had their crash counted via
   * `crashCountedChildren` and no-op the budget consumption on the
   * second event — the cleanup steps still run, but the budget is not
   * double-charged.
   */
  private handleChildExit(
    child: SidecarChildProcess,
    code: number | null,
    signal: string | null,
  ): void {
    if (this.child !== child) {
      // Stale-event guard. The `exit` and `error` listeners are attached
      // per-child in `attachChildListeners` and closed over the child
      // reference at attach time. Node's `child_process` can emit BOTH
      // `exit` and `error` for a single spawn-then-crash-mid-init
      // failure; if `ensureChild()` has spawned a replacement child
      // between the first event's teardown (`this.child = null`) and a
      // late second event for the SAME old child, `this.child` now
      // holds the replacement. Letting the second event run the
      // canonical teardown chain would (a) wipe the new child reference
      // (`this.child = null`), (b) detach the new child's stdout
      // listener via `detachChildStdoutListener(child)` (no-op against
      // the wrong stream, but still incorrect), and (c) reject every
      // pending outstanding request that was queued for the NEW child
      // with an error attributing the failure to the OLD child's exit.
      //
      // The guard covers both reachable interleavings:
      //
      //   (a) Same-child second event after the first event already
      //       cleared `this.child` and no replacement has spawned yet:
      //       `this.child === null !== child` → early-return ✓
      //
      //   (b) Same-child second event after `ensureChild()` already
      //       spawned a replacement: `this.child === replacement !==
      //       child` → early-return ✓
      //
      // The pre-existing `crashCountedChildren` WeakSet remains as
      // belt-and-suspenders defense for the dual-event budget-dedupe
      // contract — under the guard, the second event no longer reaches
      // `recordCrashOncePerChild`, but the WeakSet still pins the
      // single-source-teardown invariant in any future code path that
      // might reach the recorder without passing through this guard.
      //
      // Refs: This is a LOCAL class invariant — the kind-keyed
      // outstanding FIFO + crashCountedChildren budget are guarded
      // only on the active-child path. See SidecarFrameDecodeError
      // class rustdoc + Plan-024 §T-024-3-1 (crash-respawn
      // supervision) for the broader supervisor semantics.
      return;
    }
    this.detachChildStdoutListener(child);
    this.parser = new ContentLengthParser();
    this.child = null;
    this.clearPreSpawnState();
    const stashed: Error | null = this.consumePendingTeardownCause();
    this.rejectAllOutstanding(
      stashed ??
        new Error(
          `RustSidecarPtyHost: sidecar exited (code=${code ?? "null"}, signal=${signal ?? "null"}) ` +
            "before response was received",
        ),
    );
    this.recordCrashOncePerChild(child);
  }

  /**
   * Same as `handleChildExit` for async error events. Same parser-
   * reset and dedupe contract; see `handleChildExit` rustdoc.
   */
  private handleChildError(child: SidecarChildProcess, err: Error): void {
    if (this.child !== child) {
      // Stale-event guard — see `handleChildExit` for the full rationale.
      // Symmetric: a late `error` for child A arriving after A's prior
      // `exit` teardown (or after `ensureChild()` spawned a replacement)
      // MUST NOT mutate the active child reference, the active parser,
      // or the new child's outstanding queue.
      return;
    }
    this.detachChildStdoutListener(child);
    this.parser = new ContentLengthParser();
    this.child = null;
    this.clearPreSpawnState();
    const stashed: Error | null = this.consumePendingTeardownCause();
    this.rejectAllOutstanding(
      stashed ??
        new Error(
          `RustSidecarPtyHost: sidecar emitted 'error' event (${err.message}); ` +
            "rejecting outstanding requests",
        ),
    );
    this.recordCrashOncePerChild(child);
  }

  /**
   * Drive the fatal-supervisor teardown for a JSON-decode error.
   *
   * Mirrors the framing-error path at the call site in
   * `drainParserUntilIncomplete`: stash a JSON-specific cause so the
   * downstream exit/error handler rejects outstanding promises with
   * the typed error, then SIGKILL the child to trigger the async
   * exit handler that runs the canonical single-source teardown
   * (parser reset → outstanding rejection → crash-budget accounting).
   *
   * Idempotency: if `pendingTeardownCause` is already non-null a
   * previous fatal site in the same drain pass already scheduled
   * teardown; we skip the second kill (best-effort `child.kill`
   * tolerates double-fire too, but skipping is the explicit signal
   * that we already cleaned up this drain pass).
   *
   * Stash + kill atomicity: the cause assignment is INSIDE the
   * `this.child !== null` branch, so a future caller running with
   * `this.child === null` is a no-op rather than a stash-leak. A
   * leaked stash (set without a kill) would survive into the next
   * child's lifecycle and reject the new child's outstanding
   * requests with a JSON-decode error from a prior frame — defends
   * the same single-source-teardown invariant as `crashCounted-
   * Children`.
   */
  private failFatallyOnDecodeError(cause: SidecarFrameDecodeError): void {
    console.warn(cause.message);
    if (this.pendingTeardownCause !== null) {
      // A prior fatal site in the same drain pass already stashed
      // a cause + killed the child; do not double-kill.
      return;
    }
    if (this.child !== null) {
      // Stash + kill are issued atomically — if `this.child` were
      // null at entry, stashing without killing would leak the
      // cause into the next child's exit handler.
      this.pendingTeardownCause = cause;
      try {
        this.child.kill("SIGKILL");
      } catch {
        // Best-effort — child may have already exited.
      }
    }
  }

  /**
   * Take + clear the stashed teardown cause, returning it (or null if
   * nothing is stashed). Used by `handleChildExit` / `handleChildError`
   * to thread a JSON-decode-specific rejection through the canonical
   * teardown chain. Clears so the next child's lifecycle does not
   * inherit the stash from a prior teardown — see the `crashCounted-
   * Children` WeakSet for the analogous dedupe pattern.
   */
  private consumePendingTeardownCause(): Error | null {
    const cause: Error | null = this.pendingTeardownCause;
    this.pendingTeardownCause = null;
    return cause;
  }

  /**
   * Detach the stored stdout listener from `child.stdout` before
   * swapping `this.parser`. Must run BEFORE the parser swap so late-
   * buffered stdout chunks from the dying child do not leak into the
   * fresh parser via the still-attached closure. No-op if no listener
   * is currently tracked (defensive against double-firing of
   * `exit`/`error` for the same child; the second invocation finds
   * `childStdoutListener` already null and exits cleanly).
   */
  private detachChildStdoutListener(child: SidecarChildProcess): void {
    if (this.childStdoutListener !== null) {
      // `off("data", listener)` removes only the exact callback we
      // attached — other consumers of the stream (if any future ones
      // attach) are not affected. The stream itself is not destroyed;
      // Node will GC it after the child reference is cleared.
      child.stdout.off("data", this.childStdoutListener);
      this.childStdoutListener = null;
    }
  }

  /**
   * Consume one crash budget slot for `child` if not already counted.
   *
   * Reads + writes `crashCountedChildren` so a same-child second event
   * (Node's rare `error`-then-`exit` or `exit`-then-`error` pair) is
   * a no-op for budget purposes. Marks `permanentlyUnavailable` when
   * the budget is exhausted; downstream `ensureChild` then throws
   * `PtyBackendUnavailableError` on the next request.
   */
  private recordCrashOncePerChild(child: SidecarChildProcess): void {
    if (this.crashCountedChildren.has(child)) {
      return;
    }
    this.crashCountedChildren.add(child);
    if (this.crashBudget.recordAndIsExhausted()) {
      this.permanentlyUnavailable = true;
    }
  }

  /** Reject every outstanding request with `err`. */
  private rejectAllOutstanding(err: Error): void {
    for (const [, queue] of this.outstanding) {
      while (queue.length > 0) {
        const entry: OutstandingRequest | undefined = queue.shift();
        if (entry !== undefined) {
          entry.reject(err);
        }
      }
    }
  }
}

// --------------------------------------------------------------------------
// Factory
// --------------------------------------------------------------------------

/**
 * Construct a `RustSidecarPtyHost` for the production selector.
 *
 * Accepts an optional `binaryPath` for callers that already know the
 * sidecar location (CI custom paths, hand-built binaries, integration
 * tests). When omitted, the default `resolveBinaryPath` deps entry —
 * `resolveSidecarBinaryPath` — runs the four-tier resolution per
 * Plan-024 §F-024-3-03 (env-var → published package → workspace
 * release → workspace debug).
 *
 * This factory is the surface `pty-host-selector.ts` calls into.
 * Tests construct `RustSidecarPtyHost` directly (with a full deps
 * record) and DO NOT route through the factory.
 */
export function createRustSidecarPtyHost(opts?: {
  readonly binaryPath?: string;
}): RustSidecarPtyHost {
  const binaryPath: string | undefined = opts?.binaryPath;
  if (binaryPath !== undefined) {
    return new RustSidecarPtyHost({
      resolveBinaryPath: (): string => binaryPath,
    });
  }
  return new RustSidecarPtyHost();
}
