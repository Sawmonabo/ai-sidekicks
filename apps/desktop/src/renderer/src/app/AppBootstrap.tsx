// The bridge gate. With a bridge the app opens its windows; without one, it opens one window to say
// so, since the console document it runs in is never shown.

import { createPortal } from "react-dom";

import { useBridgeResolution } from "#renderer/services/platform/hooks/useBridgeResolution.js";
import type { BridgeUnavailable } from "#renderer/services/platform/bridge-context.js";
import type { OpenWindows } from "#renderer/services/window/open-windows.js";
import { sessionReadThroughDaemon } from "#renderer/services/daemon/session/read.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { useBridgeUnavailableWindow } from "./hooks/useBridgeUnavailableWindow.js";
import { AppWindows } from "./AppWindows.js";
import { windowMountPoint } from "./window-document.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";

/** What the provider stack hands the gate. */
export interface AppBootstrapProps {
  /** The windows the console document opens. */
  readonly openWindows: OpenWindows;
}

/**
 * Open the app's windows once the bridge resolves, or one window saying it cannot.
 *
 * The failure card is a component boundary rather than a later `if`: everything below holds a
 * resolved bridge, and the hooks that need it throw without one and cannot be called
 * conditionally. The resolution never changes after the first, so the windows never remount.
 */
export function AppBootstrap(props: AppBootstrapProps): React.JSX.Element {
  const resolution = useBridgeResolution();
  if (resolution.status === "unavailable") {
    return (
      <BridgeUnavailableWindow
        openWindows={props.openWindows}
        unavailable={resolution.unavailable}
      />
    );
  }
  return (
    <AppWindows
      bridge={resolution.bridge}
      readSession={sessionReadThroughDaemon(resolution.bridge)}
      openWindows={props.openWindows}
    />
  );
}

/** The one window saying no bridge resolved, holding the card. */
function BridgeUnavailableWindow(props: {
  readonly openWindows: OpenWindows;
  readonly unavailable: BridgeUnavailable;
}): React.JSX.Element | null {
  const opened = useBridgeUnavailableWindow(props.openWindows);
  if (opened === undefined) {
    return null;
  }
  return createPortal(
    // This window has no frame to mount the announcer, so it mounts its own for the card.
    <LiveAnnouncerProvider>
      <div className="meridian-frame meridian-frame--bare">
        <Nothing
          kind="error"
          title="This window cannot reach the app."
          detail={props.unavailable.detail}
        />
      </div>
    </LiveAnnouncerProvider>,
    windowMountPoint(opened.window.document),
  );
}
