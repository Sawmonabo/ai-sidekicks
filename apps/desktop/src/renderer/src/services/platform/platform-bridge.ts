// The front end's bridge: what every host provides. The host capabilities are the preload's
// `PreloadApi` taken whole, implemented by `live-bridge.ts` and `platform-bridge.fixture.ts`, so a
// namespace added to the preload breaks the fixture at compile time. This adds what only the
// renderer has: the transport-reconnect signal and which bridge the window runs against. The
// registered daemon streams and their kinds live in
// `services/daemon/session/event/session-event-streams.ts`.

import type { PreloadApi } from "#shared/preload-api.js";
import type { TransportReconnectSignal } from "#renderer/services/transport/reconnect.js";

/** Which bridge the window is running against. Rendered, never inferred. */
export type PlatformBridgeSource = "live" | "fixture";

/** The bridge a window holds: the host's capabilities and the signals every host answers. */
export interface PlatformBridge extends PreloadApi {
  /**
   * The app's one transport-reconnect signal, which every window shares. Not a host capability:
   * the renderer derives it from main's `daemon.status` topic and its own opens. Both halves are published because
   * observers report into it from above and below this seam; readings take the subscribe-only
   * `TransportReconnectObservable` view.
   */
  readonly transportReconnect: TransportReconnectSignal;
  readonly source: PlatformBridgeSource;
}
