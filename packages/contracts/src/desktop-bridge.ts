// Preload bridge contract — the typed `window.sidekicks` surface.
//
// This module ships:
//   • `SidekicksBridge` — the bridge shape plus `readonly` hardening on every
//     capability group and `app` sub-property, so a compromised renderer
//     cannot reassign `bridge.daemon = …`.
//   • Stub type declarations for the daemon, control-plane, Electron dialog,
//     and DOM WebAuthn surfaces, so the bridge shape is reviewable before
//     those surfaces exist
//   • `NotImplementedError` — thrown by every bridge method until the
//     corresponding IPC handler ships
//   • `createStubBridge()` — factory the preload calls; every method throws
//
// Coverage:
//   Any future edit that introduces a property name matching /token|dpop|prf|secret/i
//   FAILS `pnpm --filter @ai-sidekicks/contracts typecheck`.
//
//   • Daemon types do not exist yet — stubbed as `string` brands + `unknown`
//     parametrics. When lands the real discriminated unions they replace the
//     stubs without changing the bridge surface.
//   • Control-plane types same posture (tRPC procedure brands).
//   • Electron dialog types (`OpenDialogOptions`, etc.) stubbed locally as
//     empty interfaces — replaced by imports from `electron`'s types once
//     `electron` becomes a `packages/contracts` devDep.
//   • DOM WebAuthn types (`PublicKeyCredentialCreationOptions`, …) stubbed
//     locally because `tsconfig.node22.json` does NOT include the `dom` lib.
//     Replacing them means either adding `dom` to the contracts lib list or
//     importing the types from `@types/webappapis`.
//
//   • raw `ipcRenderer` / `ipcMain`
//   • `require`, `process`, `global`, any Node built-in
//   • auth material (PASETO tokens, DPoP key, WebAuthn PRF output, daemon
//     session token) — enforced typewise by the negative type-test
//   • raw file paths as strings — paths returned to the renderer are opaque
//     `FilePathRef` tokens; dereferencing is a second main-process round trip

import type { AuxiliaryWindowControls } from "./desktop/auxiliary-window.js";
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
 * Opaque branded reference to a file path. The renderer never sees the raw
 * path string — every operation that returns a path returns this token, and
 * every operation that consumes a path takes this token, with the main process
 * dereferencing internally.
 */
export type FilePathRef = string & { readonly __brand: "FilePathRef" };

// ---------------------------------------------------------------------------
// WebAuthn DOM-type stubs.
//
// `tsconfig.node22.json` ships `lib: ["es2023"]` (no dom). The DOM WebAuthn
// types (`PublicKeyCredentialCreationOptions`, `PublicKeyCredentialRequestOptions`,
// `PublicKeyCredential`) are not in lib.es2023 and cannot be referenced from
// this package without a config change. Lifting that means either adding
// `dom` to the contracts lib list (allowed for type-only imports) or pulling
// in `@types/webappapis`. Until then, stub minimal shapes here.
//
// `ArrayBuffer` IS in lib.es2023 (it's an ECMAScript global, not a DOM type),
// so the `deriveKeyMaterial` return type stays as `Promise<ArrayBuffer>`.
// ---------------------------------------------------------------------------

/** DOM `PublicKeyCredentialCreationOptions` shape (stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PublicKeyCredentialCreationOptions {}
/** DOM `PublicKeyCredentialRequestOptions` shape (stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PublicKeyCredentialRequestOptions {}
/** DOM `PublicKeyCredential` shape (stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PublicKeyCredential {}

/**
 * Input to `webAuthn.deriveKeyMaterial` (stub). The salt is the
 * only renderer-visible input — the derived material returns as an
 * `ArrayBuffer` and never includes the raw PRF output in any other form.
 *
 * IMPORTANT: this type name `PrfInput` contains the substring `prf`. The
 * negative type-test (`desktop-bridge.test-d.ts`) flattens BRIDGE PROPERTY
 * NAMES, not exported TYPE NAMES — so `PrfInput` as a parameter TYPE does
 * not pollute the surface. The forbidden-substring check applies to keys
 * like `prfOutput` or `prfSalt`, neither of which appears on the bridge.
 */
export interface PrfInput {
  readonly salt: ArrayBuffer;
}

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
// Shell signals — the one namespace whose direction is main-to-renderer.
// ---------------------------------------------------------------------------

/**
 * What the desktop shell asks of the window it is speaking to.
 *
 * EVERY OTHER NAMESPACE ON THE BRIDGE RUNS THE OTHER WAY — the renderer calls and
 * main answers — so this one is declared apart rather than folded into `native`,
 * whose members are OS surfaces the renderer requests. A shell signal is not a
 * request the renderer made; it is the shell reaching a window that could not have
 * asked, because the keystroke that raised it landed somewhere else entirely.
 *
 * IT IS ALSO THE ONE NAMESPACE A STUB BRIDGE CAN SERVE FOR REAL, which is why the
 * factory below takes it rather than stubbing it: a shell signal needs no daemon, no
 * control plane, and no credential — only the channel the preload is already sitting
 * on. Every other namespace is a round trip to something that does not exist yet.
 */
export interface ShellSignals {
  /**
   * Told when the shell asks this window's composer to take the caret.
   *
   * NO PAYLOAD, in both directions. What focusing means belongs to the window that
   * draws a composer, so a handler that received a value would eventually be one
   * that branched on it — and nothing that crosses `contextBridge` has to be
   * cloneable when nothing crosses it.
   *
   * Returns the disposer the caller owes. A window binds this once and releases it
   * on unmount, exactly as it does every other subscription on this bridge.
   */
  subscribeToComposerFocusRequest(handler: () => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Error class — thrown by every stub bridge method.
// ---------------------------------------------------------------------------

/**
 * Thrown when renderer code calls a `SidekicksBridge` method that is not yet
 * implemented. Every stub method throws this; wiring a namespace swaps the
 * stub for a real IPC dispatch. The `name` field is stable so callers can
 * `if (err.name === "NotImplementedError")` without importing the
 * class (useful from the renderer where the error bubbles through `await`).
 */
export class NotImplementedError extends Error {
  public constructor(method: string) {
    super(`SidekicksBridge.${method} is not implemented (stub).`);
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
// /token|dpop|prf|secret/i by the conditional-type test in
// `desktop-bridge.test-d.ts`. Adding a property like `sessionToken: string`
// would fail `pnpm --filter @ai-sidekicks/contracts typecheck` with TS2344
// at the `AssertNever<Offenders>` line of the test.
// ---------------------------------------------------------------------------

/**
 * The single typed object exposed on `window.sidekicks` via
 * `contextBridge.exposeInMainWorld('sidekicks', bridge)`.
 *
 * Seven capability surfaces:
 *   • `daemon` — JSON-RPC over IPC to the local daemon
 *   • `controlPlane` — tRPC + relay WebSocket to the control plane
 *   • `native` — main-process-mediated OS dialogs and OS surfaces
 *   • `webAuthn` — main-process-orchestrated WebAuthn ceremony
 *   • `window` — the shell's auxiliary-window controls
 *   • `update` — renderer observes the auto-updater state machine
 *   • `shell` — the desktop shell asking THIS window to do something
 *   • `app` — read-only build/runtime meta
 *
 *   • `ipcRenderer` / `ipcMain` / `require` / `process` / `global` / Node built-ins
 *   • auth material (any token / DPoP / PRF output / secret) — enforced
 *     STRUCTURALLY by the negative type-test (`desktop-bridge.test-d.ts`)
 *   • raw file path strings — paths are opaque `FilePathRef` tokens
 */
export interface SidekicksBridge {
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
    openExternal(url: string): Promise<void>;
    copyToClipboard(text: string): Promise<void>;
    revealInFileExplorer(path: FilePathRef): Promise<void>;
  };

  // WebAuthn — main process orchestrates the WebAuthn ceremony via Electron's bindings
  readonly webAuthn: {
    createCredential(options: PublicKeyCredentialCreationOptions): Promise<PublicKeyCredential>;
    getAssertion(options: PublicKeyCredentialRequestOptions): Promise<PublicKeyCredential>;
    deriveKeyMaterial(input: PrfInput): Promise<ArrayBuffer>;
  };

  // the shell speaking to THIS window — main asks, the renderer decides what the
  // ask means. The one direction the other namespaces do not cover: everywhere else
  // the renderer asks and main answers.
  readonly shell: ShellSignals;

  // auxiliary windows — renderer asks the shell to move a pane into a window of
  // its own, addresses that window, and hears about the two ways it can end
  readonly window: AuxiliaryWindowControls;

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
 * The shell a bridge has when its builder supplied none.
 *
 * Not an empty subscription. A caller that holds no channel has not "no requests to
 * report" — it has no shell at all — and the two are only distinguishable if the
 * second one says so. This is the same reading every round-trip method above takes,
 * and it is what makes a forgotten binding a refusal rather than a silence.
 */
const SHELL_WITHOUT_A_HOST: ShellSignals = {
  subscribeToComposerFocusRequest: () => stubThrow("shell.subscribeToComposerFocusRequest"),
};

/**
 * Factory returning a `SidekicksBridge` whose every round-trip method throws
 * `NotImplementedError`. Called once by the preload script
 * (`apps/desktop/src/preload/index.ts`) to populate `window.sidekicks`.
 *
 * Wiring a namespace replaces its methods with real implementations bound to
 * the corresponding IPC channel on the main-process side.
 *
 * `shell` IS TAKEN RATHER THAN STUBBED, because it is the one namespace a caller can
 * actually serve without anything else being wired: it needs no daemon, no control
 * plane, and no credential, only the channel the preload is already sitting on.
 *
 * ITS DEFAULT REFUSES RATHER THAN REPORTING NOTHING, and the difference decides how a
 * preload that forgot to bind it fails. A never-firing default would compile, pass
 * the shape comparison, and answer no shell request ever — a chord that silently does
 * nothing, with no other observable anywhere. Refusing puts that bridge on exactly
 * the footing every other unwired namespace here is already on, so the window that
 * binds the signal raises `NotImplementedError` at its first subscription
 * instead of running for a session and losing every ask.
 */
export function createStubBridge(shell: ShellSignals = SHELL_WITHOUT_A_HOST): SidekicksBridge {
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
      openExternal: () => stubThrow("native.openExternal"),
      copyToClipboard: () => stubThrow("native.copyToClipboard"),
      revealInFileExplorer: () => stubThrow("native.revealInFileExplorer"),
    },
    webAuthn: {
      createCredential: () => stubThrow("webAuthn.createCredential"),
      getAssertion: () => stubThrow("webAuthn.getAssertion"),
      deriveKeyMaterial: () => stubThrow("webAuthn.deriveKeyMaterial"),
    },
    // Handed through rather than stubbed: the caller that builds this bridge is the
    // one holding the channel the shell speaks on, so there is nothing here to defer.
    shell,
    // The one namespace the PRELOAD replaces rather than takes from here. Its
    // main-process handlers already ship, so
    // `apps/desktop/src/preload/index.ts` spreads a real `ipcRenderer`
    // implementation over this block. The throwing stub stays because the
    // factory's contract is a TOTAL `SidekicksBridge` — every reader that builds
    // one from here (the shape probe, the live-bridge suites) needs the member
    // present, and a member present-and-throwing is what a window whose preload
    // did not finish installing actually has.
    window: {
      detachPane: () => stubThrow("window.detachPane"),
      focusAuxiliary: () => stubThrow("window.focusAuxiliary"),
      closeAuxiliary: () => stubThrow("window.closeAuxiliary"),
      subscribePaneErrors: () => stubThrow("window.subscribePaneErrors"),
      subscribePaneReturns: () => stubThrow("window.subscribePaneReturns"),
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
