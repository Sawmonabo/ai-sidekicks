// What the Electron preload exposes on `window.desktopBridge`.
//
// Every capability group and `app` member is `readonly`, so a compromised renderer cannot
// reassign `bridge.daemon`. No auth material (daemon session token, PASETO tokens, DPoP key)
// appears here: `preload-api.test-d.ts` fails the typecheck when any property name at any
// depth matches /token|dpop|secret/i. Paths reach the renderer only as opaque `FilePathRef`
// tokens, which main dereferences on a second round trip. Raw `ipcRenderer`, `require`,
// `process` and Node built-ins never appear.
//
// The daemon, control-plane and Electron dialog types are stubs, so this API can be reviewed
// before the daemon and control-plane clients behind it exist; the dialog shapes are local so
// this module takes no dependency on the `electron` package.

import type {
  DaemonEvent,
  DaemonEventPayload,
  DaemonMethod,
  DaemonParams,
  DaemonResult,
  SessionId,
} from "@ai-sidekicks/contracts";

/**
 * Control-plane tRPC procedure name brand (stub). Replaced by the typed-procedure union
 * derived from `AppRouter` once the full router shape is exposed.
 */
export type CpProcedure = string & { readonly __cp_procedure__: never };

/** Control-plane procedure input (stub; the real shape comes from tRPC inference). */
export type CpInput<P extends CpProcedure> = P extends CpProcedure ? unknown : never;

/** Control-plane procedure output (stub; the real shape comes from tRPC inference). */
export type CpOutput<P extends CpProcedure> = P extends CpProcedure ? unknown : never;

/** Relay subscription event handler (stub; the relay event shape replaces `unknown`). */
export type RelayEventHandler = (event: unknown) => void;

/** Handle returned by every subscription. Idempotent: a second call does nothing. */
export type Unsubscribe = () => void;

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
 * `not-determined` is the state before the person has been asked, the one a fresh install is
 * in; folding it onto `denied` would tell the person the notification center is the only place
 * they will see a notification, on a machine that would show the first one it is sent.
 * `unsupported` is a platform main cannot read the permission on. Only `denied` says the
 * notification center is the only place.
 */
export interface NotificationPermission {
  readonly state: "granted" | "denied" | "not-determined" | "unsupported";
}

/**
 * Opaque reference to a file path. The renderer never sees the raw path: every operation
 * that returns or takes a path uses this token, and main dereferences it.
 */
export type FilePathRef = string & { readonly __brand: "FilePathRef" };

/**
 * Auto-update state surfaced to the renderer.
 *
 * The `idle` arm carries the instant of the last completed check, because the settings
 * read-out has to say when its answer was established; an `idle` with no time behind it reads
 * as "there is no update" when it means "we do not know". It is optional: a build that has
 * never completed a check has no instant to report.
 */
export type UpdateState =
  | { readonly status: "idle"; readonly lastCheckedAt?: string }
  | { readonly status: "checking" }
  | { readonly status: "downloading"; readonly percent: number }
  | { readonly status: "ready" }
  | { readonly status: "error"; readonly message: string };

/**
 * Thrown by a preload method whose IPC handler is not wired yet. Its `name` is stable, so a
 * caller can test `error.name === "NotImplementedError"` without importing the class.
 */
export class NotImplementedError extends Error {
  public constructor(method: string) {
    super(`PreloadApi.${method} is not implemented (stub).`);
    this.name = "NotImplementedError";
  }
}

/**
 * The one object the preload exposes on `window.desktopBridge`: the daemon's JSON-RPC over
 * IPC, the control plane's tRPC and relay, the OS calls main makes for the renderer, the
 * auto-updater's state, and read-only build meta.
 */
export interface PreloadApi {
  readonly daemon: {
    call<M extends DaemonMethod>(method: M, params: DaemonParams<M>): Promise<DaemonResult<M>>;
    subscribe<E extends DaemonEvent>(
      event: E,
      handler: (payload: DaemonEventPayload<E>) => void,
    ): Unsubscribe;
  };

  readonly controlPlane: {
    /**
     * Forwards a control-plane request/response procedure. Relay negotiation is never
     * reachable here: main negotiates the relay and consumes its token in-process, the
     * renderer reaches the relay only through `subscribeRelay`, and main's handler rejects
     * any relay-negotiation procedure.
     */
    call<P extends CpProcedure>(procedure: P, input: CpInput<P>): Promise<CpOutput<P>>;
    subscribeRelay(sessionId: SessionId, handler: RelayEventHandler): Unsubscribe;
  };

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

  readonly update: {
    getState(): Promise<UpdateState>;
    subscribe(handler: (state: UpdateState) => void): Unsubscribe;
    requestCheck(): Promise<void>;
    requestRestart(): Promise<void>;
  };

  readonly app: {
    readonly version: string;
    readonly platform: "darwin" | "linux" | "win32";
    readonly arch: "arm64" | "x64";
    readonly locale: string;
  };
}

function stubThrow(method: string): never {
  throw new NotImplementedError(method);
}

/**
 * The preload API with every round-trip method throwing `NotImplementedError` until its IPC
 * handler is wired. The caller supplies the build meta, because only the preload can read
 * the platform and this module is also compiled into the renderer.
 */
export function createStubBridge(app: PreloadApi["app"]): PreloadApi {
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
    app,
  };
}
