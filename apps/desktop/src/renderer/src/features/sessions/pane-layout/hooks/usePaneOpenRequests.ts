import { useCallback, useEffect, useRef } from "react";

import type { PaneOpenRequests } from "@renderer/store/window/pane-open-requests.js";
import type { PaneLayoutStore } from "../pane-layout-store.js";

/** What the hook binds: this screen's layout, the window's held request, and the session shown. */
export interface PaneOpenRequestsOptions {
  readonly layout: PaneLayoutStore;
  readonly requests: PaneOpenRequests;
  readonly sessionId: string | undefined;
}

/**
 * Open the pane another screen asked this session's layout for, never before the saved
 * arrangement has landed, so the restore cannot treat it as the person's edit or drop it. Returns
 * the call the persistence hook makes when its restore lands; a request arriving after that is
 * opened at once.
 */
export function usePaneOpenRequests(
  options: PaneOpenRequestsOptions,
): (restoredSessionId: string) => void {
  const { layout, requests, sessionId } = options;
  // The session whose arrangement this layout last restored; a session switch re-reads the
  // record, so arrivals wait again until that read lands.
  const restoredSessionIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    restoredSessionIdRef.current = undefined;
  }, [layout, sessionId]);

  useEffect(
    () =>
      requests.onArrival((request) => {
        if (request.sessionId === sessionId && restoredSessionIdRef.current === sessionId) {
          openHeldPane(layout, requests, request.sessionId);
        }
      }),
    [layout, requests, sessionId],
  );

  return useCallback(
    (restoredSessionId: string) => {
      restoredSessionIdRef.current = restoredSessionId;
      openHeldPane(layout, requests, restoredSessionId);
    },
    [layout, requests],
  );
}

function openHeldPane(
  layout: PaneLayoutStore,
  requests: PaneOpenRequests,
  sessionId: string,
): void {
  const address = requests.take(sessionId);
  if (address !== undefined) {
    layout.open(address);
  }
}
