// The places an ignored settings file is named from, read once while a banner names a file by
// path: the session's folders, through its workspaces, and the home folder, which
// `machine.folder.list` opens on when it names no folder. That listing is narrowed to the
// service's own data folder, so its reply carries the home folder's path and one entry, never the
// whole home folder.

import { useEffect, useState } from "react";

import { DAEMON_DATA_FOLDER_NAME } from "@ai-sidekicks/contracts/daemon/data";

import { callDaemon } from "#renderer/services/daemon/reply.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";

import { readSessionFolders } from "../../services/session-workspace.js";
import type { SettingsFilePlaces } from "../notices.js";

/**
 * The session's folders and the home folder once both reads have settled while `isWanted`, or
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
      readSessionFolders(bridge, sessionId, abort.signal),
      callDaemon(
        bridge,
        "machine.folder.list",
        { filter: DAEMON_DATA_FOLDER_NAME, showHidden: true },
        { signal: abort.signal },
      ),
    ]).then(([session, home]) => {
      if (abort.signal.aborted) {
        return;
      }
      const sessionFolders = session.status === "served" ? session.value : [];
      const homeFolder =
        home.status === "served" && home.value.top === undefined ? home.value.path : undefined;
      setRead({
        sessionId,
        places: {
          sessionFolders,
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
