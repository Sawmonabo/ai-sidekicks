// The front end's bridge: what every host provides, whichever process or device it runs in.
//
// The host capabilities are the preload's own contract, `PreloadApi`, taken whole: the
// desktop's implementation reads the Electron preload (`live-bridge.ts`) and the fixture's is
// built by `platform-bridge.fixture.ts`, both typed by this interface, so a namespace added to
// the preload breaks the fixture at compile time rather than at review time. What this adds is
// what only the renderer has: the transport-reconnect signal and which bridge the window runs
// against.
//
// Which names are registered daemon streams, and which event kinds each carries, lives in
// `services/daemon/session-event-streams.ts` and the kind tables beside it: both sides of
// the subscribe seam read them.

import type { PreloadApi } from "@shared/preload-api.js";
import type { TransportReconnectSignal } from "@renderer/services/transport/transport-reconnect.js";

/** Which bridge the window is running against. Rendered, never inferred. */
export type PlatformBridgeSource = "live" | "fixture";

/** The bridge a window holds: the host's capabilities and the signals every host answers. */
export interface PlatformBridge extends PreloadApi {
  /**
   * The window's one transport-reconnect signal. Not a host capability: the preload
   * exposes no connection state. Both halves are published, because the observers that
   * report into it sit above and below this seam; readings take the subscribe-only
   * `TransportReconnectObservable` view.
   */
  readonly transportReconnect: TransportReconnectSignal;
  readonly source: PlatformBridgeSource;
}
