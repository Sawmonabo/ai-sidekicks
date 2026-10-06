// The window's one subscription to main's `daemon.status` topic. Main is the supervisor, so its
// reading of the link is the authority on whether the background service can be reached: each
// delivery is handed on for the window to keep, and the link's state is reported into the
// transport-reconnect signal, whose returning edge re-opens the streams that ended while the
// service was gone. The topic opens with no service answering, so it never goes through
// `openObservedSubscription`, whose open is evidence about the daemon's wire.

import type { DaemonConnection, MainProcessState } from "#shared/daemon/status-topic.js";
import { DAEMON_STATUS_TOPIC } from "#shared/daemon/status-topic.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import type { PlatformBridge } from "../platform/bridge.js";
import type { TransportReachability } from "../transport/reconnect.js";

/**
 * Hear each state main reports, the current one first, for as long as the window holds it. The
 * transport signal is told before `onReport` runs, so a reader of the report never sees a link
 * the signal has not.
 */
export function subscribeDaemonStatus(
  bridge: PlatformBridge,
  onReport: (state: MainProcessState) => void,
): Unsubscribe {
  return bridge.daemon.subscribe(DAEMON_STATUS_TOPIC, {}, (state) => {
    const reachability = reachabilityOf(state.connection);
    if (reachability !== undefined) {
      bridge.transportReconnect.observe(reachability);
    }
    onReport(state);
  });
}

/**
 * What a link state says about the service. A handshake answered, refused or not, is the service
 * there; a loss, a stop and a state this window does not know are the service gone, never a guess
 * that it is up. While main is still looking for the service at boot nothing is said, so the
 * first answer is the link coming up, not coming back.
 */
function reachabilityOf(
  connection: DaemonConnection,
): Exclude<TransportReachability, "unknown"> | undefined {
  switch (connection.kind) {
    case "connected":
    case "version-incompatible":
      return "reachable";
    case "unreported":
    case "connecting":
    case "starting":
      return undefined;
    case "transient_disconnect":
    case "unknown":
    case "degraded":
    case "stopped":
      return "unreachable";
  }
}
