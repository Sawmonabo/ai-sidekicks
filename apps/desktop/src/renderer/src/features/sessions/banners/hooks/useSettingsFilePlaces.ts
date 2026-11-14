// The places an ignored settings file is named from, read once while a banner names a file by
// path: the session's folder, through its workspace, and the home folder, which
// `machine.folder.list` opens on when it names no folder.

import { useEffect, useState } from "react";

import { callDaemon } from "#renderer/services/daemon/reply.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";

import { readSessionFolder } from "../../services/session-workspace.js";
import type { SettingsFilePlaces } from "../notices.js";

/**
 * The session's folder and the home folder once both reads have settled while `isWanted`, or
 * `undefined` until then; a refused read leaves its place out, so a file there reads whole.
 */
export function useSettingsFilePlaces(
  bridge: PlatformBridge,
  sessionId: string,
  isWanted: boolean,
): SettingsFilePlaces | undefined {
  // Held with the session they were read for, so another session's places are never shown.
  const [read, setRead] = useState<
    { readonly sessionId: string; readonly places: SettingsFilePlaces } | undefined
  >(undefined);
  const places = read?.sessionId === sessionId ? read.places : undefined;
  const isRead = places !== undefined;

  useEffect(() => {
    if (!isWanted || isRead) {
      return undefined;
    }
    const abort = new AbortController();
    void Promise.all([
      readSessionFolder(bridge, sessionId),
      callDaemon(bridge, "machine.folder.list", {}, { signal: abort.signal }),
    ]).then(([session, home]) => {
      if (abort.signal.aborted) {
        return;
      }
      const sessionFolder = session.status === "served" ? session.value : undefined;
      const homeFolder =
        home.status === "served" && home.value.top === undefined ? home.value.path : undefined;
      setRead({
        sessionId,
        places: {
          ...(sessionFolder === undefined ? {} : { sessionFolder }),
          ...(homeFolder === undefined ? {} : { homeFolder }),
        },
      });
    });
    return () => {
      abort.abort();
    };
  }, [bridge, sessionId, isWanted, isRead]);

  return places;
}
