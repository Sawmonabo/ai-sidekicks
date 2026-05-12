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
   * Resolves the sidecar binary path. Defaults to a stub that throws
   * — T-024-3-3 lands the real resolver (env-var override + bundled-
   * asset fallback).
   *
   * Pin 1 contract from the dispatch: the factory accepts an optional
   * `binaryPath` so T-024-3-3 can swap in the real resolver without
   * touching the factory signature. Until then, callers MUST pass
   * `binaryPath` explicitly OR set `AIS_PTY_SIDECAR_PATH` (the stub
   * reads this as a courtesy for ad-hoc dev iteration).
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

// --------------------------------------------------------------------------
// Default deps resolution
// --------------------------------------------------------------------------

/**
 * Default `resolveBinaryPath` — Pin 1 stub.
 *
 * T-024-3-3 will land the real resolution helper (env-var override
 * `AIS_PTY_SIDECAR_PATH` + bundled-asset fallback per Plan-024 line 92).
 * Until then the stub honors `AIS_PTY_SIDECAR_PATH` as a courtesy for
 * dev iteration (a single env-var keeps ad-hoc local testing viable
 * without a code change) and throws a clear error otherwise that names
 * T-024-3-3 as the upstream task.
 *
 * The throw is intentional — Plan-024 §Implementation Step 7 requires
 * the resolver to fail loudly when the binary is unavailable rather
 * than silently fall back, so the daemon-layer caller (the selector)
 * can convert the failure to `PtyBackendUnavailable`.
 *
 * Bracket notation on `process.env` is required by this repo's tsconfig
 * (`noPropertyAccessFromIndexSignature: true`).
 */
function defaultResolveBinaryPath(): string {
  const fromEnv: string | undefined = process.env["AIS_PTY_SIDECAR_PATH"];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  throw new Error(
    "RustSidecarPtyHost: sidecar binary path resolution lands in T-024-3-3 " +
      "(`@ai-sidekicks/pty-sidecar-${platform}-${arch}` package + dev " +
      "fallback to `packages/sidecar-rust-pty/target/{release,debug}/sidecar`). " +
      "Until T-024-3-3 lands, set `AIS_PTY_SIDECAR_PATH=<absolute path>` " +
      "or pass `binaryPath` to `createRustSidecarPtyHost({ binaryPath })`.",
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
    resolveBinaryPath: partial.resolveBinaryPath ?? defaultResolveBinaryPath,
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
    // have a partial header or no header yet — return incomplete.
    const headerEnd: number = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return { kind: "incomplete" };
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
        const parsed: number = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          return {
            kind: "error",
            message: `Content-Length value is not a valid non-negative integer: ${JSON.stringify(value)}`,
          };
        }
        contentLength = parsed;
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

  /** `onData` consumer callback. Set via `setOnData`. */
  private dataListener: (sessionId: string, chunk: Uint8Array) => void = () => undefined;

  /** `onExit` consumer callback. Set via `setOnExit`. */
  private exitListener: (sessionId: string, exitCode: number, signalCode?: number) => void = () =>
    undefined;

  public constructor(deps?: Partial<RustSidecarPtyHostDeps>) {
    this.deps = resolveDefaultDeps(deps ?? {});
    this.crashBudget = new CrashBudget(this.deps.nowMs);
  }

  // ---- PtyHost methods --------------------------------------------------

  public async spawn(spec: SpawnRequest): Promise<SpawnResponse> {
    await this.ensureChild();
    const response = await this.sendRequest(spec, "spawn_response");
    if (response.kind !== "spawn_response") {
      throw new Error(`RustSidecarPtyHost.spawn: unexpected response kind ${response.kind}`);
    }
    // Initialize session record so subsequent close/kill on this id
    // see a tracked entry. The Rust side mints the id; we treat it
    // as opaque.
    this.sessions.set(response.session_id, {
      exitCode: null,
      signalCode: undefined,
    });
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
    // `close` removes the session record so subsequent re-emits cannot
    // fire on a closed id. Wire dispatch: a `KillRequest(SIGTERM)` is
    // the closest cascade the protocol exposes; we send it without
    // awaiting the ExitCodeNotification because the contract says
    // close MUST NOT block on the OS reap (matches `node-pty-host.ts`
    // Phase 2).
    const record: SessionRecord | undefined = this.sessions.get(sessionId);
    if (record === undefined) {
      // Idempotent close on an unknown session — not an error per the
      // PtyHost contract.
      return;
    }
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
    this.sessions.delete(sessionId);
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
    const spawnFn: SidecarSpawnFn = await this.resolveSpawn();
    let binaryPath: string;
    try {
      binaryPath = this.deps.resolveBinaryPath();
    } catch (err: unknown) {
      // Binary path resolution failure is the "binary missing"
      // condition; surface as PtyBackendUnavailable. We do NOT
      // consume the crash budget for path-resolution failures
      // because they will deterministically fail on every retry —
      // there is no pathological respawn loop to defend against.
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
    // Stdout: parse Content-Length frames and dispatch.
    child.stdout.on("data", (chunk: Buffer) => {
      this.parser.feed(chunk);
      this.drainParserUntilIncomplete();
    });

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
    // `exit` fire for the same failed child (POLISH 7 — Node's
    // `child_process` can emit both in rare spawn-then-crash-mid-init
    // edge cases).
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
    let envelope: Envelope;
    try {
      envelope = JSON.parse(body.toString("utf8")) as Envelope;
    } catch (err: unknown) {
      console.warn(
        `RustSidecarPtyHost: failed to parse inbound JSON envelope ` +
          `(${(err as Error).message}); skipping frame.`,
      );
      return;
    }

    switch (envelope.kind) {
      case "data_frame": {
        // Gate fan-out on `sessions.has(envelope.session_id)` —
        // mirrors `node-pty-host.ts`'s close-time subscription
        // disposal (which prevents post-close data emission).
        // A `DataFrame` arriving for a session the daemon has already
        // closed is consumer-meaningless; the listener may be a stale
        // closure from the prior session-id reuse cycle (Phase 5
        // Plan-001 P5 may surface this when sidecar session-id reuse
        // crosses daemon close boundaries). Drop silently.
        //
        // Asymmetry with `handleExitNotification`: the exit notification
        // IS fanned out for unknown sessions because exit is a terminal
        // event the consumer may need to observe even after a `close()`
        // (lifecycle telemetry); a data chunk is just queued bytes that
        // a closed session has no use for.
        if (!this.sessions.has(envelope.session_id)) {
          return;
        }
        // Decode base64 to bytes and dispatch. The protocol guarantees
        // monotonic per-session seq; the listener is responsible for
        // reordering if it cares about ordering across multiple
        // sessions (this layer only fans out per-session).
        const bytes: Uint8Array = Buffer.from(envelope.bytes, "base64");
        this.dataListener(envelope.session_id, bytes);
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
      // No default: TypeScript exhaustiveness over the discriminated
      // union ensures we cover every variant.
    }
  }

  /**
   * Handle an inbound `ExitCodeNotification` — cache the exit code in
   * the session record, fire the exit listener, and remove the session
   * from tracking.
   */
  private handleExitNotification(notification: ExitCodeNotification): void {
    const record: SessionRecord | undefined = this.sessions.get(notification.session_id);
    if (record === undefined) {
      // ExitCodeNotification for a session we don't know about —
      // could be a race (close already removed it) or a sidecar bug.
      // Fan out the exit event regardless so the consumer sees it.
      const sigCode: number | undefined = notification.signal_code ?? undefined;
      this.fireExit(notification.session_id, notification.exit_code, sigCode);
      return;
    }
    if (record.exitCode !== null) {
      // Duplicate exit notification — the sidecar's contract is
      // exactly-once per session, but defensively dedupe.
      return;
    }
    record.exitCode = notification.exit_code;
    record.signalCode = notification.signal_code ?? undefined;
    this.fireExit(notification.session_id, notification.exit_code, record.signalCode);
  }

  /**
   * Match an inbound response envelope against the head-of-FIFO
   * outstanding entry of the matching kind and either resolve or
   * reject its promise.
   *
   * **Error-response branch.** `ResizeResponse` / `WriteResponse` /
   * `KillResponse` all carry an optional `error?: string` per the
   * Plan-024 contract. When `error` is present the sidecar's handler
   * failed (most often `UnknownSession` for a request that lost a
   * race against natural exit — see `KillResponse` rustdoc in
   * `pty-host-protocol.ts`); we reject the awaiting Promise so the
   * caller sees a prompt failure instead of an indefinite hang. The
   * `close()` happy-path's existing try/catch swallows this rejection
   * cleanly because the close-races-natural-exit shape is a normal
   * lifecycle event from its perspective. Other callers (e.g., a
   * direct `kill()` on an active session) propagate the rejection up.
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
    // Inspect error-bearing variants — only resize/write/kill responses
    // carry the optional `error` field per the contract bump.
    if (
      (envelope.kind === "resize_response" ||
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
    this.parser = new ContentLengthParser();
    this.child = null;
    this.rejectAllOutstanding(
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
    this.parser = new ContentLengthParser();
    this.child = null;
    this.rejectAllOutstanding(
      new Error(
        `RustSidecarPtyHost: sidecar emitted 'error' event (${err.message}); ` +
          "rejecting outstanding requests",
      ),
    );
    this.recordCrashOncePerChild(child);
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
 * Pin 1 contract: accept an optional `binaryPath` so T-024-3-3 can swap
 * in the real binary-resolution helper without touching this signature.
 * When `binaryPath` is provided, it overrides the default
 * `resolveBinaryPath` deps entry; T-024-3-3 will switch the selector
 * over to constructing a real resolver.
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
