// Spec-023 §Preload Bridge Contract — typed `window.sidekicks` surface.
//
// At Tier 1 this module ships:
//   • `SidekicksBridge` — verbatim shape + `readonly` hardening from Spec-023
//     §Preload Bridge Contract (lines 152-202). The structure matches the
//     spec exactly; this implementation adds `readonly` modifiers to every
//     capability group and `app` sub-property for defense-in-depth (prevents
//     a compromised renderer from reassigning `bridge.daemon = …`).
//   • Stub type imports for Plan-007 daemon / Plan-002+ control-plane / Electron
//     dialog / DOM WebAuthn types — every Tier-8-or-later type lands here as a
//     deliberate stub so the bridge shape is reviewable without those plans
//   • `NotImplementedAtTier1Error` — thrown by every bridge method until the
//     corresponding Tier 8 IPC handler ships
//   • `createTier1Bridge()` — factory the preload calls; every method throws
//
// Coverage:
//   Spec-023 §Acceptance Criteria line 592 ("No auth material on
//   `window.sidekicks`") is enforced by the conditional-type negative test
//   `desktop-bridge.test-d.ts` against the `SidekicksBridge` interface declared
//   below. Any future edit that introduces a property name matching
//   /token|dpop|prf|secret/i FAILS `pnpm --filter @ai-sidekicks/contracts typecheck`.
//
// Tier 1 carve-outs (per Plan-023 Phase 1 T-023p-1-4):
//   • Plan-007 daemon types do not exist yet — stubbed as `string` brands +
//     `unknown` parametrics. When Plan-007 lands the real discriminated unions
//     they replace the stubs without changing the bridge surface.
//   • Plan-002+ control-plane types same posture (tRPC procedure brands).
//   • Electron dialog types (`OpenDialogOptions`, etc.) stubbed locally as
//     empty interfaces — Tier 8 replaces them with imports from `electron`'s
//     types once `electron` becomes a `packages/contracts` devDep.
//   • DOM WebAuthn types (`PublicKeyCredentialCreationOptions`, …) stubbed
//     locally because `tsconfig.node22.json` does NOT include the `dom` lib.
//     Tier 8 either adds `dom` to the contracts lib list or imports the types
//     from `@types/webappapis`.
//
// Bridge non-exposure list (Spec-023 §Preload Bridge Contract lines 205-210):
//   • raw `ipcRenderer` / `ipcMain`
//   • `require`, `process`, `global`, any Node built-in
//   • auth material (PASETO tokens, DPoP key, WebAuthn PRF output, daemon
//     session token) — enforced typewise by the negative type-test
//   • raw file paths as strings — paths returned to the renderer are opaque
//     `FilePathRef` tokens; dereferencing is a second main-process round trip

import type { SessionId } from "./session.js";

// ---------------------------------------------------------------------------
// Plan-007 daemon protocol stubs (real types land at Plan-007 Phase 1).
//
// The `__plan007_*__` brand markers force every consumer to acknowledge "this
// is a Tier 1 stub" — when Plan-007's real discriminated unions land, the
// brand goes away and existing call sites continue to typecheck because the
// brand was only a structural marker. This is the canonical pattern for
// surviving "stub → real type" substitution as a non-breaking change.
// ---------------------------------------------------------------------------

/**
 * Plan-007 method name brand (Tier 1 stub).
 * Replaced by Plan-007's `DaemonMethod` string-literal union when that plan
 * lands. Until then, every `daemon.call(method, …)` call site picks up the
 * brand and the negative type-test still flattens an empty key set under it.
 */
export type DaemonMethod = string & { readonly __plan007_daemon_method__: never };

/**
 * Plan-007 method-request param shape (Tier 1 stub).
 * Replaced by `DaemonRequest[M]` from Plan-007 once method-to-params mapping
 * lands. `unknown` at Tier 1 forces callers to narrow before use.
 */
export type DaemonParams<M extends DaemonMethod> = M extends DaemonMethod ? unknown : never;

/**
 * Plan-007 method-response result shape (Tier 1 stub).
 * Replaced by `DaemonResponse[M]` from Plan-007.
 */
export type DaemonResult<M extends DaemonMethod> = M extends DaemonMethod ? unknown : never;

/**
 * Plan-007 event name brand (Tier 1 stub).
 * Replaced by Plan-007's `DaemonEvent` string-literal union.
 */
export type DaemonEvent = string & { readonly __plan007_daemon_event__: never };

/**
 * Plan-007 event payload shape (Tier 1 stub).
 * Replaced by `DaemonEventPayloads[E]` from Plan-007.
 */
export type DaemonEventPayload<E extends DaemonEvent> = E extends DaemonEvent ? unknown : never;

// ---------------------------------------------------------------------------
// Control-plane procedure stubs (real types land at Plan-002 / Plan-008 tRPC
// surface). Same brand posture as Plan-007 stubs above.
// ---------------------------------------------------------------------------

/**
 * Control-plane tRPC procedure name brand (Tier 1 stub).
 * Replaced by the typed-procedure union derived from `AppRouter` once
 * Plan-002+ exposes the full router shape through this package.
 */
export type CpProcedure = string & { readonly __cp_procedure__: never };

/** Control-plane procedure input (Tier 1 stub; real shape comes from tRPC inference). */
export type CpInput<P extends CpProcedure> = P extends CpProcedure ? unknown : never;

/** Control-plane procedure output (Tier 1 stub; real shape comes from tRPC inference). */
export type CpOutput<P extends CpProcedure> = P extends CpProcedure ? unknown : never;

/**
 * Relay subscription event handler (Tier 1 stub).
 * The relay event shape (Plan-008 §Relay Frame Schema or successor) replaces
 * the `unknown` payload once that plan exposes it through this package.
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
 * dereferencing internally. This is the structural enforcement of Spec-023
 * §Preload Bridge Contract line 210 ("arbitrary file paths as strings").
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
 * Input to `webAuthn.deriveKeyMaterial` (Tier 1 stub).
 * Spec-023 §WebAuthn Credential Flow + ADR-010 specify the PRF extension
 * derives main-process-owned key material from a per-session salt. The salt
 * is the only renderer-visible input — the derived material returns as an
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
 * Auto-update state surfaced to the renderer (Tier 1 stub).
 * Plan-023 Tier 8 remainder owns the real shape; at Tier 1 a coarse-grained
 * discriminated union is sufficient for the bridge type to compile. The
 * Tier-1-stub bridge throws on `update.getState()` so the runtime shape is
 * never observed by Tier 1 callers.
 */
export type UpdateState =
  | { readonly status: "idle" }
  | { readonly status: "checking" }
  | { readonly status: "downloading"; readonly percent: number }
  | { readonly status: "ready" }
  | { readonly status: "error"; readonly message: string };

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
    super(`SidekicksBridge.${method} is not implemented at Tier 1 (Plan-023 Phase 1 stub).`);
    this.name = "NotImplementedAtTier1Error";
  }
}

// ---------------------------------------------------------------------------
// The bridge interface — verbatim shape + `readonly` hardening from Spec-023
// §Preload Bridge Contract (lines 152-202 of
// docs/specs/023-desktop-shell-and-renderer.md). The structure matches the
// spec exactly; `readonly` modifiers on every capability group and `app`
// sub-property are local defense-in-depth (the spec block contains zero
// `readonly` modifiers in lines 152-202).
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
 * Six capability surfaces:
 *   • `daemon` — JSON-RPC over IPC to the local Plan-007 daemon
 *   • `controlPlane` — tRPC + relay WebSocket to the Plan-002/003/008 control plane
 *   • `native` — main-process-mediated OS dialogs and OS surfaces
 *   • `webAuthn` — main-process-orchestrated WebAuthn ceremony (ADR-010)
 *   • `update` — renderer observes the auto-updater state machine
 *   • `app` — read-only build/runtime meta
 *
 * Non-exposure (Spec-023 §Preload Bridge Contract lines 205-210):
 *   • `ipcRenderer` / `ipcMain` / `require` / `process` / `global` / Node built-ins
 *   • auth material (any token / DPoP / PRF output / secret) — enforced
 *     STRUCTURALLY by the negative type-test (`desktop-bridge.test-d.ts`)
 *   • raw file path strings — paths are opaque `FilePathRef` tokens
 */
export interface SidekicksBridge {
  // daemon RPC — request/response over Spec-007 JSON-RPC contract
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
     * (session CRUD, membership, invites, approvals, artifacts, health — Spec-008
     * §Control-Plane Transport Protocol).
     *
     * CONTRACT CONSTRAINT — relay negotiation is NOT reachable through this forwarder.
     * `negotiateRelay` returns a `RelayNegotiationResponse` carrying the short-lived relay
     * `connectionToken` (a PASETO `aud=relay-connect` bearer credential) which Spec-023
     * §Trust Stance confines to the main process and forbids on the preload bridge. Relay
     * negotiation runs main-process-owned and consumes the token in-process to open the
     * relay WSS; the renderer reaches the relay only via `subscribeRelay` (relay events,
     * never the token). The main-process `controlPlane.call` handler MUST reject any
     * relay-negotiation procedure. (A structural exclusion is not expressible against the
     * opaque `CpProcedure` brand; closing `CpProcedure` to a named allow-list that omits
     * relay negotiation is a Plan-023 bridge-contract concern.)
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
// unions; we cast through `as unknown as ...` to narrow without runtime
// validation. At Tier 1 this is acceptable because (a) the bridge stub is
// never reached in a production runtime — the Tier 8 replacement performs the
// narrow with a proper check — and (b) Plan-023 §Implementation Steps locks
// the V1 OS matrix to exactly this subset (ADR-016 §Success Criteria).
// ---------------------------------------------------------------------------

function tier1Throw(method: string): never {
  throw new NotImplementedAtTier1Error(method);
}

/**
 * Factory returning a `SidekicksBridge` whose every method throws
 * `NotImplementedAtTier1Error`. Called once by the preload script
 * (`apps/desktop/src/preload/index.ts`) to populate `window.sidekicks`.
 *
 * Tier 8 replaces this factory with a real implementation that wires each
 * method to the corresponding IPC channel on the main-process side.
 */
export function createTier1Bridge(): SidekicksBridge {
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
    update: {
      getState: () => tier1Throw("update.getState"),
      subscribe: () => tier1Throw("update.subscribe"),
      requestCheck: () => tier1Throw("update.requestCheck"),
      requestRestart: () => tier1Throw("update.requestRestart"),
    },
    app: {
      version: "0.0.0",
      // V1 supported OS matrix (ADR-016 §Success Criteria) is darwin / linux / win32.
      // `process.platform` may return values outside this set (aix, freebsd, sunos,
      // openbsd, cygwin, haiku, netbsd, android) which Tier 1 stub does not handle —
      // Tier 8 replacement validates and surfaces an explicit "unsupported platform"
      // error before reaching the renderer.
      platform: process.platform as unknown as "darwin" | "linux" | "win32",
      // V1 supported arch matrix is arm64 / x64. `process.arch` may return ia32,
      // mips, ppc, etc.; same narrowing posture as `platform`.
      arch: process.arch as unknown as "arm64" | "x64",
      // Tier 8 replacement reads `app.getLocale()` from the Electron `app` module.
      locale: "en-US",
    },
  };
}
