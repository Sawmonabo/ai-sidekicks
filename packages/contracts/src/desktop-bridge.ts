// Preload bridge contract — the typed `window.desktopBridge` surface.
//
// This module ships:
//   • `DesktopBridge` — the bridge shape plus `readonly` hardening on every
//     capability group and `app` sub-property, so a compromised renderer
//     cannot reassign `bridge.daemon = …`.
//   • Stub type declarations for the daemon, control-plane and Electron dialog
//     surfaces, so the bridge shape is reviewable before those surfaces exist
//   • `NotImplementedError` — thrown by every bridge method until the
//     corresponding IPC handler ships
//   • `createStubBridge()` — factory the preload calls; every method throws
//
// Coverage:
//   Any future edit that introduces a property name matching /token|dpop|secret/i
//   FAILS `pnpm --filter @ai-sidekicks/contracts typecheck`.
//
//   • Daemon types do not exist yet — stubbed as `string` brands + `unknown`
//     parametrics. When lands the real discriminated unions they replace the
//     stubs without changing the bridge surface.
//   • Control-plane types same posture (tRPC procedure brands).
//   • Electron dialog types (`OpenDialogOptions`, etc.) stubbed locally as
//     empty interfaces — replaced by imports from `electron`'s types once
//     `electron` becomes a `packages/contracts` devDep.
//
//   • raw `ipcRenderer` / `ipcMain`
//   • `require`, `process`, `global`, any Node built-in
//   • auth material (PASETO tokens, DPoP key, daemon session token) — enforced typewise by the
//     negative type-test
//   • raw file paths as strings — paths returned to the renderer are opaque
//     `FilePathRef` tokens; dereferencing is a second main-process round trip

import type { SessionId } from "./session.js";

// ---------------------------------------------------------------------------
// Daemon protocol stubs (real types land).
//
// The `__daemon_*_stub__` brand markers force every consumer to acknowledge
// that it is holding a stub — when the real discriminated unions land, the
// brand goes away and existing call sites continue to typecheck because the
// brand was only a structural marker. This is the canonical pattern for
// surviving "stub → real type" substitution as a non-breaking change.
// ---------------------------------------------------------------------------

/**
 * Method name brand (stub). Replaced by the `DaemonMethod` string-literal
 * union once it exists. Until then, every `daemon.call(method, …)` call site
 * picks up the brand and the negative type-test still flattens an empty key
 * set under it.
 */
export type DaemonMethod = string & { readonly __daemon_method_stub__: never };

/**
 * Method-request param shape (stub). Replaced by `DaemonRequest[M]` once the
 * method-to-params mapping exists. `unknown` forces callers to narrow before
 * use.
 */
export type DaemonParams<M extends DaemonMethod> = M extends DaemonMethod ? unknown : never;

/**
 * Method-response result shape (stub).
 */
export type DaemonResult<M extends DaemonMethod> = M extends DaemonMethod ? unknown : never;

/**
 * Event name brand (stub). Replaced by the `DaemonEvent` string-literal union.
 */
export type DaemonEvent = string & { readonly __daemon_event_stub__: never };

/**
 * Event payload shape (stub).
 */
export type DaemonEventPayload<E extends DaemonEvent> = E extends DaemonEvent ? unknown : never;

// ---------------------------------------------------------------------------
// Control-plane procedure stubs (the real types come from the tRPC surface).
// Same brand posture as the stubs above.
// ---------------------------------------------------------------------------

/**
 * Control-plane tRPC procedure name brand (stub). Replaced by the
 * typed-procedure union derived from `AppRouter` once the full router shape
 * is exposed through this package.
 */
export type CpProcedure = string & { readonly __cp_procedure__: never };

/** Control-plane procedure input (stub; the real shape comes from tRPC inference). */
export type CpInput<P extends CpProcedure> = P extends CpProcedure ? unknown : never;

/** Control-plane procedure output (stub; the real shape comes from tRPC inference). */
export type CpOutput<P extends CpProcedure> = P extends CpProcedure ? unknown : never;

/**
 * Relay subscription event handler (stub). The relay event shape replaces the
 * `unknown` payload once it is exposed through this package.
 */
export type RelayEventHandler = (event: unknown) => void;

/**
 * Unsubscribe handle returned by `subscribe(...)` and `subscribeRelay(...)`.
 * Idempotent: calling twice has no additional effect.
 */
export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// Native-dialog type stubs (Electron's `dialog` module surface). Stubbed
// locally so `packages/contracts` does NOT take a hard dependency on the
// `electron` runtime package. They are swapped for imports from `electron`
// once that becomes a contracts devDep (or the type-only shape is extracted
// into a sibling `electron-types.ts` file).
// ---------------------------------------------------------------------------

/** Electron `OpenDialogOptions` shape (stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface OpenDialogOptions {}
/** Electron `OpenDialogReturnValue` shape (stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface OpenDialogResult {}
/** Electron `SaveDialogOptions` shape (stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SaveDialogOptions {}
/** Electron `SaveDialogReturnValue` shape (stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SaveDialogResult {}
/** Electron `MessageBoxOptions` shape (stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MessageBoxOptions {}
/** Electron `MessageBoxReturnValue` shape (stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MessageBoxResult {}
/** Electron `NotificationConstructorOptions` shape (stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface NotificationOptions {}

/**
 * Whether this machine will show an OS notification for this application.
 *
 * `not-determined` is the state before the person has been asked, the one a fresh
 * install is in; folding it onto `denied` would tell the person the notification
 * center is their only surface on a machine that would show the first notification
 * it is sent. `unsupported` is a platform main cannot read the permission on. Each
 * state is drawn differently, and only `denied` says the notification center is the
 * only surface.
 */
export interface NotificationPermission {
  readonly state: "granted" | "denied" | "not-determined" | "unsupported";
}

/**
 * Opaque branded reference to a file path. The renderer never sees the raw
 * path string — every operation that returns a path returns this token, and
 * every operation that consumes a path takes this token, with the main process
 * dereferencing internally.
 */
export type FilePathRef = string & { readonly __brand: "FilePathRef" };

/**
 * Auto-update state surfaced to the renderer (stub). A coarse-grained
 * discriminated union is sufficient for the bridge type to compile; the stub
 * bridge throws on `update.getState()` so the runtime shape is never observed
 * by a caller holding one.
 *
 * `update.getState` and `update.subscribe` name this type and fix no arm
 * shape, so the arms are settled here. The `idle` arm carries the instant of the
 * last completed check because the settings read-out has to say when the answer
 * it is showing was established — an `idle` with no time behind it reads as
 * "there is no update" when what it means is "we do not know". It is OPTIONAL and
 * absent is a real state rather than a gap: a build that has never completed a
 * check has no instant to report, and a fabricated one would be the renderer
 * inventing a reading.
 */
export type UpdateState =
  | { readonly status: "idle"; readonly lastCheckedAt?: string }
  | { readonly status: "checking" }
  | { readonly status: "downloading"; readonly percent: number }
  | { readonly status: "ready" }
  | { readonly status: "error"; readonly message: string };

// ---------------------------------------------------------------------------
// Error class — thrown by every stub bridge method.
// ---------------------------------------------------------------------------

/**
 * Thrown when renderer code calls a `DesktopBridge` method that is not yet
 * implemented. Every stub method throws this; wiring a namespace swaps the
 * stub for a real IPC dispatch. The `name` field is stable so callers can
 * `if (err.name === "NotImplementedError")` without importing the
 * class (useful from the renderer where the error bubbles through `await`).
 */
export class NotImplementedError extends Error {
  public constructor(method: string) {
    super(`DesktopBridge.${method} is not implemented (stub).`);
    this.name = "NotImplementedError";
  }
}

// ---------------------------------------------------------------------------
// The bridge interface — verbatim shape + `readonly` hardening. The structure
// matches the spec exactly; `readonly` modifiers on every capability group
// and `app` sub-property are local defense-in-depth (the spec's contract
// block contains zero `readonly` modifiers).
//
// Every property name on this interface is enforced not to match
// /token|dpop|secret/i by the conditional-type test in
// `desktop-bridge.test-d.ts`. Adding a property like `sessionToken: string`
// would fail `pnpm --filter @ai-sidekicks/contracts typecheck` with TS2344
// at the `AssertNever<Offenders>` line of the test.
// ---------------------------------------------------------------------------

/**
 * The single typed object exposed on `window.desktopBridge` via
 * `contextBridge.exposeInMainWorld('desktopBridge', bridge)`.
 *
 * Five capability surfaces:
 *   • `daemon` — JSON-RPC over IPC to the local daemon
 *   • `controlPlane` — tRPC + relay WebSocket to the control plane
 *   • `native` — main-process-mediated OS dialogs and OS surfaces
 *   • `update` — renderer observes the auto-updater state machine
 *   • `app` — read-only build/runtime meta
 *
 *   • `ipcRenderer` / `ipcMain` / `require` / `process` / `global` / Node built-ins
 *   • auth material (any token / DPoP / secret) — enforced
 *     STRUCTURALLY by the negative type-test (`desktop-bridge.test-d.ts`)
 *   • raw file path strings — paths are opaque `FilePathRef` tokens
 */
export interface DesktopBridge {
  // daemon RPC — request/response over JSON-RPC contract
  readonly daemon: {
    call<M extends DaemonMethod>(method: M, params: DaemonParams<M>): Promise<DaemonResult<M>>;
    subscribe<E extends DaemonEvent>(
      event: E,
      handler: (payload: DaemonEventPayload<E>) => void,
    ): Unsubscribe;
  };

  // control-plane RPC — request/response over tRPC, live updates over WebSocket JSON-RPC 2.0
  readonly controlPlane: {
    /**
     * Generic renderer-facing forwarder for control-plane request/response procedures
     * (session CRUD, approvals, artifacts, health).
     *
     * CONTRACT CONSTRAINT — relay negotiation is NOT reachable through this forwarder.
     * Relay negotiation runs main-process-owned and consumes the token in-process to open
     * the relay WSS; the renderer reaches the relay only via `subscribeRelay` (relay
     * events, never the token). The main-process `controlPlane.call` handler MUST reject
     * any relay-negotiation procedure. (A structural exclusion is not expressible against
     * the opaque `CpProcedure` brand; closing `CpProcedure` to a named allow-list that
     * omits relay negotiation is a bridge-contract concern.)
     */
    call<P extends CpProcedure>(procedure: P, input: CpInput<P>): Promise<CpOutput<P>>;
    subscribeRelay(sessionId: SessionId, handler: RelayEventHandler): Unsubscribe;
  };

  // native capabilities — renderer requests, main performs, sanitized result returned
  readonly native: {
    showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogResult>;
    showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogResult>;
    showMessageBox(options: MessageBoxOptions): Promise<MessageBoxResult>;
    showNotification(options: NotificationOptions): void;
    getNotificationPermission(): Promise<NotificationPermission>;
    openExternal(url: string): Promise<void>;
    copyToClipboard(text: string): Promise<void>;
    revealInFileExplorer(path: FilePathRef): Promise<void>;
  };

  // auto-update — renderer observes state; main process drives
  readonly update: {
    getState(): Promise<UpdateState>;
    subscribe(handler: (state: UpdateState) => void): Unsubscribe;
    requestCheck(): Promise<void>;
    requestRestart(): Promise<void>;
  };

  // app meta — read-only
  readonly app: {
    readonly version: string;
    readonly platform: "darwin" | "linux" | "win32";
    readonly arch: "arm64" | "x64";
    readonly locale: string;
  };
}

// ---------------------------------------------------------------------------
// Stub factory.
//
// Every callable method throws `NotImplementedError`, and the `app` block
// returns placeholder values. The real factory wires each method to its IPC
// counterpart in `apps/desktop/src/main/`.
//
// Decision: `app.platform` and `app.arch` are typed as the V1 supported-OS
// subset (darwin / linux / win32 + arm64 / x64). `process.platform` and
// `process.arch` return the broader NodeJS.Platform / NodeJS.Architecture
// unions; we cast through `as unknown as …` to narrow without runtime
// validation. That is acceptable in a stub because it is never reached in a
// production runtime — the real implementation performs the narrow with a
// proper check.
// ---------------------------------------------------------------------------

function stubThrow(method: string): never {
  throw new NotImplementedError(method);
}

/**
 * Factory returning a `DesktopBridge` whose every round-trip method throws
 * `NotImplementedError`. Called once by the preload script
 * (`apps/desktop/src/preload/index.ts`) to populate `window.desktopBridge`.
 *
 * Wiring a namespace replaces its methods with real implementations bound to
 * the corresponding IPC channel on the main-process side.
 */
export function createStubBridge(): DesktopBridge {
  return {
    daemon: {
      call: () => stubThrow("daemon.call"),
      subscribe: () => stubThrow("daemon.subscribe"),
    },
    controlPlane: {
      call: () => stubThrow("controlPlane.call"),
      subscribeRelay: () => stubThrow("controlPlane.subscribeRelay"),
    },
    native: {
      showOpenDialog: () => stubThrow("native.showOpenDialog"),
      showSaveDialog: () => stubThrow("native.showSaveDialog"),
      showMessageBox: () => stubThrow("native.showMessageBox"),
      showNotification: () => stubThrow("native.showNotification"),
      getNotificationPermission: () => stubThrow("native.getNotificationPermission"),
      openExternal: () => stubThrow("native.openExternal"),
      copyToClipboard: () => stubThrow("native.copyToClipboard"),
      revealInFileExplorer: () => stubThrow("native.revealInFileExplorer"),
    },
    update: {
      getState: () => stubThrow("update.getState"),
      subscribe: () => stubThrow("update.subscribe"),
      requestCheck: () => stubThrow("update.requestCheck"),
      requestRestart: () => stubThrow("update.requestRestart"),
    },
    app: {
      version: "0.0.0",
      // V1 supported OS matrix is darwin / linux / win32. `process.platform` may
      // return values outside this set (aix, freebsd, sunos, openbsd, cygwin, haiku,
      // netbsd, android) which this stub does not handle — the real
      // implementation validates and surfaces an explicit "unsupported platform"
      // error before reaching the renderer.
      platform: process.platform as unknown as "darwin" | "linux" | "win32",
      // V1 supported arch matrix is arm64 / x64. `process.arch` may return ia32,
      // mips, ppc, etc.; same narrowing posture as `platform`.
      arch: process.arch as unknown as "arm64" | "x64",
      // The real implementation reads `app.getLocale()` from the Electron `app` module.
      locale: "en-US",
    },
  };
}
