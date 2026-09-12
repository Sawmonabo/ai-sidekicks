// Preload bridge contract — the typed `window.sidekicks` surface.
//
// At Tier 1 this module ships:
//   • `SidekicksBridge` — verbatim shape + `readonly` hardening. The
//     structure matches the spec exactly; this implementation adds
//     `readonly` modifiers to every capability group and `app` sub-property
//     for defense-in-depth (prevents a compromised renderer from reassigning
//     `bridge.daemon = …`).
//   • Stub type imports for daemon / control-plane / Electron dialog / DOM
//     WebAuthn types — every Tier-8-or-later type lands here as a deliberate
//     stub so the bridge shape is reviewable without those plans
//   • `NotImplementedAtTier1Error` — thrown by every bridge method until the
//     corresponding Tier 8 IPC handler ships
//   • `createTier1Bridge()` — factory the preload calls; every method throws
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
//     empty interfaces — Tier 8 replaces them with imports from `electron`'s
//     types once `electron` becomes a `packages/contracts` devDep.
//   • DOM WebAuthn types (`PublicKeyCredentialCreationOptions`, …) stubbed
//     locally because `tsconfig.node22.json` does NOT include the `dom` lib.
//     Tier 8 either adds `dom` to the contracts lib list or imports the types
//     from `@types/webappapis`.
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
// The `__plan007_*__` brand markers force every consumer to acknowledge "this
// is a Tier 1 stub" — when the real discriminated unions land, the brand goes
// away and existing call sites continue to typecheck because the brand was
// only a structural marker. This is the canonical pattern for surviving "stub
// → real type" substitution as a non-breaking change.
// ---------------------------------------------------------------------------

/**
 * Method name brand (Tier 1 stub). Replaced by the `DaemonMethod`
 * string-literal union when that plan lands. Until then, every
 * `daemon.call(method, …)` call site picks up the brand and the negative
 * type-test still flattens an empty key set under it.
 */
export type DaemonMethod = string & { readonly __plan007_daemon_method__: never };

/**
 * Method-request param shape (Tier 1 stub). Replaced by `DaemonRequest[M]`
 * once method-to-params mapping lands. `unknown` at Tier 1 forces callers to
 * narrow before use.
 */
export type DaemonParams<M extends DaemonMethod> = M extends DaemonMethod ? unknown : never;

/**
 * Method-response result shape (Tier 1 stub).
 */
export type DaemonResult<M extends DaemonMethod> = M extends DaemonMethod ? unknown : never;

/**
 * Event name brand (Tier 1 stub). Replaced by the
 * `DaemonEvent` string-literal union.
 */
export type DaemonEvent = string & { readonly __plan007_daemon_event__: never };

/**
 * Event payload shape (Tier 1 stub).
 */
export type DaemonEventPayload<E extends DaemonEvent> = E extends DaemonEvent ? unknown : never;

// ---------------------------------------------------------------------------
// Control-plane procedure stubs (real types land tRPC surface). Same brand
// posture as stubs above.
// ---------------------------------------------------------------------------

/**
 * Control-plane tRPC procedure name brand (Tier 1 stub). Replaced by
 * the typed-procedure union derived from `AppRouter` once exposes the
 * full router shape through this package.
 */
export type CpProcedure = string & { readonly __cp_procedure__: never };

/** Control-plane procedure input (Tier 1 stub; real shape comes from tRPC inference). */
export type CpInput<P extends CpProcedure> = P extends CpProcedure ? unknown : never;

/** Control-plane procedure output (Tier 1 stub; real shape comes from tRPC inference). */
export type CpOutput<P extends CpProcedure> = P extends CpProcedure ? unknown : never;

/**
 * Relay subscription event handler (Tier 1 stub). The relay event shape
 * replaces the `unknown` payload once that plan exposes it through this
 * package.
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
// `electron` runtime package — Tier 8 swaps these for imports from `electron`
// once that becomes a contracts devDep (or extracts the type-only shape into
// a sibling `electron-types.ts` file).
// ---------------------------------------------------------------------------

/** Electron `OpenDialogOptions` shape (Tier 1 stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface OpenDialogOptions {}
/** Electron `OpenDialogReturnValue` shape (Tier 1 stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface OpenDialogResult {}
/** Electron `SaveDialogOptions` shape (Tier 1 stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SaveDialogOptions {}
/** Electron `SaveDialogReturnValue` shape (Tier 1 stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SaveDialogResult {}
/** Electron `MessageBoxOptions` shape (Tier 1 stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MessageBoxOptions {}
/** Electron `MessageBoxReturnValue` shape (Tier 1 stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MessageBoxResult {}
/** Electron `NotificationConstructorOptions` shape (Tier 1 stub). */
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
// this package without a config change. Tier 8 either adds `dom` to the
// contracts lib list (allowed for type-only imports) or pulls in
// `@types/webappapis`. Until then, stub minimal shapes here.
//
// `ArrayBuffer` IS in lib.es2023 (it's an ECMAScript global, not a DOM type),
// so the `deriveKeyMaterial` return type stays as `Promise<ArrayBuffer>`.
// ---------------------------------------------------------------------------

/** DOM `PublicKeyCredentialCreationOptions` shape (Tier 1 stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PublicKeyCredentialCreationOptions {}
/** DOM `PublicKeyCredentialRequestOptions` shape (Tier 1 stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PublicKeyCredentialRequestOptions {}
/** DOM `PublicKeyCredential` shape (Tier 1 stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PublicKeyCredential {}

/**
 * Input to `webAuthn.deriveKeyMaterial` (Tier 1 stub).. The salt is the
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
 * Auto-update state surfaced to the renderer (Tier 1 stub). Tier 8
 * remainder owns the real shape; at Tier 1 a coarse-grained discriminated
 * union is sufficient for the bridge type to compile. The Tier-1-stub
 * bridge throws on `update.getState()` so the runtime shape is never
 * observed by Tier 1 callers.
 *
 * names this type on `update.getState` and `update.subscribe` and fixes no arm
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
 * IT IS ALSO THE ONE NAMESPACE A TIER-1 BRIDGE CAN SERVE FOR REAL, which is why the
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
// Error class — thrown by every Tier-1-stub bridge method.
// ---------------------------------------------------------------------------

/**
 * Thrown when renderer code calls a `SidekicksBridge` method that is not yet
 * implemented at Tier 1. Every stub method throws this; Tier 8 swaps the
 * stub for a real IPC dispatch. The `name` field is stable so callers can
 * `if (err.name === "NotImplementedAtTier1Error")` without importing the
 * class (useful from the renderer where the error bubbles through `await`).
 */
export class NotImplementedAtTier1Error extends Error {
  public constructor(method: string) {
    super(`SidekicksBridge.${method} is not implemented at Tier 1 (stub).`);
    this.name = "NotImplementedAtTier1Error";
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
 *   • `controlPlane` — tRPC + relay WebSocket to 003/008 control plane
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
     * (session CRUD, membership, invites, approvals, artifacts, health).
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
// Tier-1-stub factory.
//
// Every callable method throws `NotImplementedAtTier1Error`. The `app` block
// returns Tier-1-stub values. Tier 8 replaces this factory with a real
// implementation that wires each method to its IPC counterpart in
// `apps/desktop/src/main/`.
//
// Decision: `app.platform` and `app.arch` are typed as the V1 supported-OS
// subset (darwin / linux / win32 + arm64 / x64). `process.platform` and
// `process.arch` return the broader NodeJS.Platform / NodeJS.Architecture
// unions; we cast through `as unknown as...` to narrow without runtime
// validation. At Tier 1 this is acceptable because (a) the bridge stub is
// never reached in a production runtime — the Tier 8 replacement performs the
// narrow with a proper check — and (b).
// ---------------------------------------------------------------------------

function tier1Throw(method: string): never {
  throw new NotImplementedAtTier1Error(method);
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
  subscribeToComposerFocusRequest: () => tier1Throw("shell.subscribeToComposerFocusRequest"),
};

/**
 * Factory returning a `SidekicksBridge` whose every round-trip method throws
 * `NotImplementedAtTier1Error`. Called once by the preload script
 * (`apps/desktop/src/preload/index.ts`) to populate `window.sidekicks`.
 *
 * Tier 8 replaces those methods with real implementations that wire each one to
 * the corresponding IPC channel on the main-process side.
 *
 * `shell` IS TAKEN RATHER THAN STUBBED, because it is the one namespace a caller can
 * actually serve at this tier: it needs no daemon, no control plane, and no
 * credential, only the channel the preload is already sitting on.
 *
 * ITS DEFAULT REFUSES RATHER THAN REPORTING NOTHING, and the difference decides how a
 * preload that forgot to bind it fails. A never-firing default would compile, pass
 * the shape comparison, and answer no shell request ever — a chord that silently does
 * nothing, with no other observable anywhere. Refusing puts that bridge on exactly
 * the footing every other unwired namespace here is already on, so the window that
 * binds the signal raises `NotImplementedAtTier1Error` at its first subscription
 * instead of running for a session and losing every ask.
 */
export function createTier1Bridge(shell: ShellSignals = SHELL_WITHOUT_A_HOST): SidekicksBridge {
  return {
    daemon: {
      call: () => tier1Throw("daemon.call"),
      subscribe: () => tier1Throw("daemon.subscribe"),
    },
    controlPlane: {
      call: () => tier1Throw("controlPlane.call"),
      subscribeRelay: () => tier1Throw("controlPlane.subscribeRelay"),
    },
    native: {
      showOpenDialog: () => tier1Throw("native.showOpenDialog"),
      showSaveDialog: () => tier1Throw("native.showSaveDialog"),
      showMessageBox: () => tier1Throw("native.showMessageBox"),
      showNotification: () => tier1Throw("native.showNotification"),
      openExternal: () => tier1Throw("native.openExternal"),
      copyToClipboard: () => tier1Throw("native.copyToClipboard"),
      revealInFileExplorer: () => tier1Throw("native.revealInFileExplorer"),
    },
    webAuthn: {
      createCredential: () => tier1Throw("webAuthn.createCredential"),
      getAssertion: () => tier1Throw("webAuthn.getAssertion"),
      deriveKeyMaterial: () => tier1Throw("webAuthn.deriveKeyMaterial"),
    },
    // Handed through rather than stubbed: the caller that builds this bridge is the
    // one holding the channel the shell speaks on, so there is nothing here to defer.
    shell,
    // The one namespace the PRELOAD replaces rather than takes from here. Its
    // main-process handlers ship at Tier 1, so
    // `apps/desktop/src/preload/index.ts` spreads a real `ipcRenderer`
    // implementation over this block. The throwing stub stays because the
    // factory's contract is a TOTAL `SidekicksBridge` — every reader that builds
    // one from here (the shape probe, the live-bridge suites) needs the member
    // present, and a member present-and-throwing is what a window whose preload
    // did not finish installing actually has.
    window: {
      detachPane: () => tier1Throw("window.detachPane"),
      focusAuxiliary: () => tier1Throw("window.focusAuxiliary"),
      closeAuxiliary: () => tier1Throw("window.closeAuxiliary"),
      subscribePaneErrors: () => tier1Throw("window.subscribePaneErrors"),
      subscribePaneReturns: () => tier1Throw("window.subscribePaneReturns"),
    },
    update: {
      getState: () => tier1Throw("update.getState"),
      subscribe: () => tier1Throw("update.subscribe"),
      requestCheck: () => tier1Throw("update.requestCheck"),
      requestRestart: () => tier1Throw("update.requestRestart"),
    },
    app: {
      version: "0.0.0",
      // V1 supported OS matrix is darwin / linux / win32. `process.platform` may
      // return values outside this set (aix, freebsd, sunos, openbsd, cygwin, haiku,
      // netbsd, android) which Tier 1 stub does not handle — Tier 8 replacement
      // validates and surfaces an explicit "unsupported platform" error before
      // reaching the renderer.
      platform: process.platform as unknown as "darwin" | "linux" | "win32",
      // V1 supported arch matrix is arm64 / x64. `process.arch` may return ia32,
      // mips, ppc, etc.; same narrowing posture as `platform`.
      arch: process.arch as unknown as "arm64" | "x64",
      // Tier 8 replacement reads `app.getLocale()` from the Electron `app` module.
      locale: "en-US",
    },
  };
}
