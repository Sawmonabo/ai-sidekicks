// The bridge gate, with the token sheet installed above it so the missing-bridge card is styled.

import { useLayoutEffect } from "react";
import { useBridgeResolution } from "@renderer/services/platform/hooks/useBridgeResolution.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { AppWindow } from "./AppWindow.js";
import { installMeridianTokens } from "./token-installation.js";
import { sessionReadThroughDaemon } from "@renderer/services/daemon/session-read.js";

/**
 * Install the token sheet, then render the window once the bridge resolves.
 *
 * The failure card is a component boundary rather than a later `if`: everything below holds a
 * resolved bridge, and the hooks that need it throw without one and cannot be called
 * conditionally. The resolution never changes after the first, so the window never remounts.
 */
export function AppBootstrap(): React.JSX.Element {
  useMeridianTokenSheet();
  const resolution = useBridgeResolution();
  if (resolution.status === "unavailable") {
    return (
      <div className="meridian-frame meridian-frame--bare">
        <Nothing
          kind="error"
          title="This window cannot reach the app."
          detail={resolution.unavailable.detail}
        />
      </div>
    );
  }
  return (
    <AppWindow
      bridge={resolution.bridge}
      readSession={sessionReadThroughDaemon(resolution.bridge)}
    />
  );
}

/**
 * Put the Meridian token sheet on the document before the first paint.
 *
 * It lives here, above the gate, so the missing-bridge card is styled too, and installing is
 * idempotent by element id, so a second window or a hot reload writes nothing. The color-scheme
 * attribute is not set here: it comes from a stored preference only a window with a bridge
 * can read, and a child's layout effect runs before this one, so a default written here
 * would overwrite the window's own value.
 */
function useMeridianTokenSheet(): void {
  useLayoutEffect(() => {
    installMeridianTokens(document);
  }, []);
}
