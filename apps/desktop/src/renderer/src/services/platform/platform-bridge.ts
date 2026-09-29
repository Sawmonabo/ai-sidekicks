// The front end's bridge: what every host provides, whichever process or device it runs in.
//
// The desktop's implementation reads the Electron preload (`live-bridge.ts`) and the fixture's
// is built by `platform-bridge.fixture.ts`; both are typed by these interfaces, so a
// namespace added here breaks the fixture at compile time rather than at review time.
//
// Which names are registered daemon streams, and which event kinds each carries, lives in
// `services/daemon/session-event-streams.ts` and the kind tables beside it: both sides of
// the subscribe seam read them.

import type {
  DaemonEvent,
  DaemonEventPayload,
  DaemonMethod,
  DaemonParams,
  DaemonResult,
  SessionId,
} from "@ai-sidekicks/contracts";
import type {
  CpInput,
  CpOutput,
  CpProcedure,
  FilePathRef,
  MessageBoxOptions,
  MessageBoxResult,
  NotificationOptions,
  NotificationPermission,
  OpenDialogOptions,
  OpenDialogResult,
  RelayEventHandler,
  SaveDialogOptions,
  SaveDialogResult,
  Unsubscribe,
  UpdateState,
} from "@shared/preload-api.js";
import type { TransportReconnectSignal } from "@renderer/services/transport/transport-reconnect.js";

/** Which bridge the window is running against. Rendered, never inferred. */
export type PlatformBridgeSource = "live" | "fixture";

/**
 * The bridge a window holds. The host capabilities — the daemon's JSON-RPC, the control
 * plane's tRPC and relay, the OS calls the host makes for the renderer, the auto-updater's
 * state and read-only build meta, each group `readonly` and shape-identical across both
 * sources — and the signals every host answers.
 */
export interface PlatformBridge {
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
     * reachable here: the host negotiates the relay and consumes its token itself.
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

  /**
   * The window's one transport-reconnect signal. Not a host capability: the preload
   * exposes no connection state. Both halves are published, because the observers that
   * report into it sit above and below this seam; readings take the subscribe-only
   * `TransportReconnectObservable` view.
   */
  readonly transportReconnect: TransportReconnectSignal;
  readonly source: PlatformBridgeSource;
}
